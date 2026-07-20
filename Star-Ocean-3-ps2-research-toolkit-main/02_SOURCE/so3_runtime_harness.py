#!/usr/bin/env python3
"""Targeted R5900 execution harness for verified SO3 runtime routines.

This is not a PlayStation 2 emulator. It loads ELF32 PT_LOAD segments, provides
a sparse EE memory map, executes the exact instruction subset used by the SO3
movie transform at Lib VA 0x0041A2F0, and requires explicit stubs for external
host services. Unsupported instructions stop execution with evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
from dataclasses import dataclass
from pathlib import Path

MASK32 = (1 << 32) - 1
MASK64 = (1 << 64) - 1
MASK128 = (1 << 128) - 1
REG = ["zero", "at", "v0", "v1", "a0", "a1", "a2", "a3", "t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "t8", "t9", "k0", "k1", "gp", "sp", "fp", "ra"]
DEFAULT_CONTENT_KEY = bytes.fromhex("66665442b379f0c7e7d51e4b7ba41c7d")
LANE_CONSTANTS = (
    0x432F96439F773428, 0x7726FDC15439F654, 0x35F437939FFF7CCD, 0x64327FCCDF7EF358,
    0x5432678932464312, 0xCCDEFACD32432146, 0x43299F7658321943, 0x7739FD014DF73254,
)


def sx(value: int, bits: int) -> int:
    value &= (1 << bits) - 1
    return value - (1 << bits) if value & (1 << (bits - 1)) else value


def sx_to_128(value: int, bits: int) -> int:
    return sx(value, bits) & MASK128


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class SparseMemory:
    PAGE = 0x1000

    def __init__(self):
        self.pages: dict[int, bytearray] = {}
        self.regions: list[dict] = []

    def _page(self, address: int, create: bool = False) -> bytearray | None:
        number = address // self.PAGE
        if number not in self.pages and create:
            self.pages[number] = bytearray(self.PAGE)
        return self.pages.get(number)

    def map(self, address: int, data: bytes, name: str, mem_size: int | None = None) -> None:
        mem_size = max(len(data), int(mem_size if mem_size is not None else len(data)))
        self.write(address, data)
        if mem_size > len(data):
            end = address + mem_size
            for page_address in range((address + len(data)) & ~(self.PAGE - 1), end, self.PAGE):
                self._page(page_address, True)
        self.regions.append({"name": name, "start": address, "end_exclusive": address + mem_size, "file_bytes": len(data), "memory_bytes": mem_size})

    def read(self, address: int, size: int) -> bytes:
        out = bytearray(size)
        for i in range(size):
            page = self._page(address + i)
            if page is None:
                raise MemoryError(f"unmapped read at 0x{address + i:08X}")
            out[i] = page[(address + i) & (self.PAGE - 1)]
        return bytes(out)

    def write(self, address: int, data: bytes) -> None:
        for i, value in enumerate(data):
            page = self._page(address + i, True)
            page[(address + i) & (self.PAGE - 1)] = value

    def load(self, address: int, size: int) -> int:
        return int.from_bytes(self.read(address, size), "little")

    def store(self, address: int, value: int, size: int) -> None:
        self.write(address, int(value & ((1 << (size * 8)) - 1)).to_bytes(size, "little"))


def load_elf32(path: Path, memory: SparseMemory, name: str) -> dict:
    data = path.read_bytes()
    if data[:6] != b"\x7fELF\x01\x01":
        raise ValueError(f"{path} is not ELF32 little-endian")
    fields = struct.unpack_from("<HHIIIIIHHHHHH", data, 16)
    machine, entry, phoff, phentsize, phnum = fields[1], fields[3], fields[4], fields[8], fields[9]
    segments = []
    for index in range(phnum):
        off = phoff + index * phentsize
        p_type, p_off, p_va, _p_pa, p_file, p_mem, flags, align = struct.unpack_from("<IIIIIIII", data, off)
        if p_type != 1 or p_mem == 0:
            continue
        payload = data[p_off:p_off + p_file]
        if len(payload) != p_file:
            raise ValueError(f"truncated PT_LOAD {index}")
        memory.map(p_va, payload, f"{name}:PT_LOAD:{index}", p_mem)
        segments.append({"index": index, "va": p_va, "file_size": p_file, "memory_size": p_mem, "flags": flags, "alignment": align})
    return {"name": name, "path": str(path), "sha256": sha256(data), "machine": machine, "entry": entry, "segments": segments}


@dataclass
class StopExecution(Exception):
    reason: str


class R5900Target:
    def __init__(self, memory: SparseMemory, trace_limit: int = 1000):
        self.memory = memory
        self.gpr = [0] * 32
        self.pc = 0
        self.steps = 0
        self.trace_limit = trace_limit
        self.trace: list[dict] = []
        self.calls: list[dict] = []
        self.write_summary: dict[str, int] = {}
        self.stubs = {}
        self.stop_pc = None

    def r(self, index: int) -> int:
        return 0 if index == 0 else self.gpr[index]

    def set(self, index: int, value: int) -> None:
        if index:
            self.gpr[index] = value & MASK128

    def u64(self, index: int) -> int:
        return self.r(index) & MASK64

    def s64(self, index: int) -> int:
        return sx(self.u64(index), 64)

    def record(self, pc: int, word: int, text: str, delay: bool = False) -> None:
        if len(self.trace) < self.trace_limit:
            self.trace.append({"step": self.steps, "pc": f"0x{pc:08X}", "word": f"0x{word:08X}", "instruction": text, "delay_slot": delay})

    def mem_address(self, rs: int, imm: int) -> int:
        return (self.u64(rs) + sx(imm, 16)) & MASK32

    def store(self, address: int, value: int, size: int) -> None:
        self.memory.store(address, value, size)
        key = f"{size}_byte"
        self.write_summary[key] = self.write_summary.get(key, 0) + 1

    def noncontrol(self, pc: int, word: int, delay: bool = False) -> None:
        op, rs, rt, rd, sa, fn, imm = word >> 26, (word >> 21) & 31, (word >> 16) & 31, (word >> 11) & 31, (word >> 6) & 31, word & 63, word & 0xFFFF
        text = ""
        if word == 0:
            text = "nop"
        elif op == 0:
            if fn == 0x00:
                self.set(rd, sx_to_128((self.u64(rt) & MASK32) << sa, 32)); text = f"sll {REG[rd]},{REG[rt]},{sa}"
            elif fn == 0x38:
                self.set(rd, (self.u64(rt) << sa) & MASK64); text = f"dsll {REG[rd]},{REG[rt]},{sa}"
            elif fn == 0x3C:
                self.set(rd, (self.u64(rt) << (sa + 32)) & MASK64); text = f"dsll32 {REG[rd]},{REG[rt]},{sa}"
            elif fn == 0x21:
                self.set(rd, sx_to_128((self.u64(rs) + self.u64(rt)) & MASK32, 32)); text = f"addu {REG[rd]},{REG[rs]},{REG[rt]}"
            elif fn == 0x23:
                self.set(rd, sx_to_128((self.u64(rs) - self.u64(rt)) & MASK32, 32)); text = f"subu {REG[rd]},{REG[rs]},{REG[rt]}"
            elif fn == 0x25:
                self.set(rd, self.u64(rs) | self.u64(rt)); text = f"or {REG[rd]},{REG[rs]},{REG[rt]}"
            elif fn == 0x26:
                self.set(rd, self.u64(rs) ^ self.u64(rt)); text = f"xor {REG[rd]},{REG[rs]},{REG[rt]}"
            elif fn == 0x2B:
                self.set(rd, int(self.u64(rs) < self.u64(rt))); text = f"sltu {REG[rd]},{REG[rs]},{REG[rt]}"
            elif fn == 0x2D:
                self.set(rd, (self.u64(rs) + self.u64(rt)) & MASK64); text = f"daddu {REG[rd]},{REG[rs]},{REG[rt]}"
            elif fn == 0x2F:
                self.set(rd, (self.u64(rs) - self.u64(rt)) & MASK64); text = f"dsubu {REG[rd]},{REG[rs]},{REG[rt]}"
            else:
                raise StopExecution(f"unsupported SPECIAL fn 0x{fn:02X} at 0x{pc:08X}")
        elif op == 0x09:
            self.set(rt, sx_to_128((self.u64(rs) + sx(imm, 16)) & MASK32, 32)); text = f"addiu {REG[rt]},{REG[rs]},{sx(imm,16)}"
        elif op == 0x19:
            self.set(rt, (self.u64(rs) + sx(imm, 16)) & MASK64); text = f"daddiu {REG[rt]},{REG[rs]},{sx(imm,16)}"
        elif op == 0x0C:
            self.set(rt, self.u64(rs) & imm); text = f"andi {REG[rt]},{REG[rs]},0x{imm:04X}"
        elif op == 0x0D:
            self.set(rt, self.u64(rs) | imm); text = f"ori {REG[rt]},{REG[rs]},0x{imm:04X}"
        elif op == 0x0F:
            self.set(rt, sx_to_128(imm << 16, 32)); text = f"lui {REG[rt]},0x{imm:04X}"
        elif op == 0x1C and fn == 0x09 and sa == 0x0E:
            self.set(rd, (self.u64(rs) << 64) | self.u64(rt)); text = f"pcpyld {REG[rd]},{REG[rs]},{REG[rt]}"
        elif op in (0x1E, 0x1F, 0x37, 0x3F):
            address = self.mem_address(rs, imm)
            if op == 0x1E:
                self.set(rt, self.memory.load(address, 16)); text = f"lq {REG[rt]},{sx(imm,16)}({REG[rs]})"
            elif op == 0x1F:
                self.store(address, self.r(rt), 16); text = f"sq {REG[rt]},{sx(imm,16)}({REG[rs]})"
            elif op == 0x37:
                self.set(rt, sx_to_128(self.memory.load(address, 8), 64)); text = f"ld {REG[rt]},{sx(imm,16)}({REG[rs]})"
            else:
                self.store(address, self.u64(rt), 8); text = f"sd {REG[rt]},{sx(imm,16)}({REG[rs]})"
        else:
            raise StopExecution(f"unsupported opcode 0x{op:02X} at 0x{pc:08X} (word 0x{word:08X})")
        self.record(pc, word, text, delay)
        self.steps += 1

    def delay(self, pc: int) -> None:
        word = self.memory.load(pc, 4)
        op, fn = word >> 26, word & 63
        if op in (2, 3, 4, 5, 6, 7) or (op == 0 and fn in (8, 9)):
            raise StopExecution(f"control transfer in delay slot at 0x{pc:08X}")
        self.noncontrol(pc, word, True)

    def run(self, start: int, max_steps: int = 2_000_000) -> str:
        self.pc = start
        try:
            while self.steps < max_steps:
                pc, word = self.pc, self.memory.load(self.pc, 4)
                op, rs, rt, fn, imm = word >> 26, (word >> 21) & 31, (word >> 16) & 31, word & 63, word & 0xFFFF
                if op == 3:  # jal
                    target = ((pc + 4) & 0xF0000000) | ((word & 0x03FFFFFF) << 2)
                    self.set(31, pc + 8); self.record(pc, word, f"jal 0x{target:08X}"); self.steps += 1; self.delay(pc + 4)
                    if target in self.stubs:
                        self.calls.append({"pc": f"0x{pc:08X}", "target": f"0x{target:08X}", "stub": self.stubs[target].__name__})
                        self.stubs[target](self); self.pc = pc + 8
                    else:
                        self.pc = target
                elif op == 0 and fn == 8:  # jr
                    target = self.u64(rs) & MASK32; self.record(pc, word, f"jr {REG[rs]}"); self.steps += 1; self.delay(pc + 4)
                    if self.stop_pc is not None and target == self.stop_pc:
                        return "RETURN_SENTINEL"
                    self.pc = target
                elif op in (4, 5, 6, 7):
                    target = (pc + 4 + (sx(imm, 16) << 2)) & MASK32
                    if op == 4: taken, name = self.u64(rs) == self.u64(rt), "beq"
                    elif op == 5: taken, name = self.u64(rs) != self.u64(rt), "bne"
                    elif op == 6: taken, name = self.s64(rs) <= 0, "blez"
                    else: taken, name = self.s64(rs) > 0, "bgtz"
                    self.record(pc, word, f"{name} -> 0x{target:08X} ({'taken' if taken else 'not taken'})"); self.steps += 1; self.delay(pc + 4); self.pc = target if taken else pc + 8
                else:
                    self.noncontrol(pc, word); self.pc = pc + 4
            raise StopExecution(f"instruction limit {max_steps} reached")
        except StopExecution:
            raise


def reference_movie_transform(source: bytes, content_key: bytes = DEFAULT_CONTENT_KEY) -> bytes:
    halves = (int.from_bytes(content_key[:8], "little"), int.from_bytes(content_key[8:], "little"))
    keys = tuple(value ^ halves[index & 1] for index, value in enumerate(LANE_CONSTANTS))
    output = bytearray(len(source))
    for offset in range(0, len(source), 8):
        lane, row = (offset % 0x40) // 8, (offset // 0x40) & 0x1F
        value = int.from_bytes(source[offset:offset + 8].ljust(8, b"\0"), "little")
        plain = ((value ^ keys[lane]) - 57 - row) & MASK64
        output[offset:offset + min(8, len(source) - offset)] = plain.to_bytes(8, "little")[:min(8, len(source) - offset)]
    return bytes(output)


def run_movie_transform(lib: Path, carrier: bytes, length: int, trace_limit: int) -> tuple[bytes, dict]:
    if length <= 0 or length > len(carrier) or length % 0x40:
        raise ValueError("length must be a positive 0x40-byte multiple within the carrier")
    memory = SparseMemory(); elf = load_elf32(lib, memory, "Lib")
    buffer_address, stack_pointer, stop_pc = 0x01000000, 0x01F00000, 0x0BADF00D
    memory.map(buffer_address, carrier[:length], "movie_carrier")
    memory.map(0x001CC730, DEFAULT_CONTENT_KEY, "PAL_content_key")
    memory.map(stack_pointer - 0x1000, bytes(0x2000), "target_stack")
    cpu = R5900Target(memory, trace_limit)

    def host_context(target: R5900Target) -> None:
        target.set(2, 0x001B6A80)

    def flush_cache(_target: R5900Target) -> None:
        return None

    cpu.stubs = {0x0010D880: host_context, 0x00121FA0: flush_cache}
    cpu.set(4, 0); cpu.set(5, buffer_address); cpu.set(6, length); cpu.set(7, buffer_address); cpu.set(8, length); cpu.set(29, stack_pointer); cpu.set(31, stop_pc); cpu.stop_pc = stop_pc
    stop_reason = cpu.run(0x0041A2F0)
    output = memory.read(buffer_address, length); reference = reference_movie_transform(carrier[:length])
    report = {
        "format": "SO3_TARGETED_RUNTIME_EXECUTION_REPORT", "version": 1,
        "routine": {"module": "Lib", "entry_va": "0x0041A2F0", "kind": "R5900_INSTRUCTION_EXECUTION", "external_stubs": ["0x0010D880 host context getter", "0x00121FA0 FlushCache"]},
        "elf": elf, "input": {"bytes": length, "sha256": sha256(carrier[:length])},
        "output": {"bytes": len(output), "sha256": sha256(output), "reference_sha256": sha256(reference), "byte_exact_reference_match": output == reference, "mpeg_pack_at_zero": output[:4] == b"\x00\x00\x01\xBA"},
        "execution": {"stop_reason": stop_reason, "instruction_count": cpu.steps, "calls": cpu.calls, "memory_writes": cpu.write_summary, "trace_records_retained": len(cpu.trace)},
        "memory_regions": memory.regions, "trace": cpu.trace,
        "reasoning_boundary": ["Only the instruction subset reached by this routine is implemented.", "External services are explicit stubs, not emulated BIOS behavior.", "A byte-exact match validates this routine and fixture, not the complete game runtime."],
    }
    return output, report


def inventory(paths: list[Path]) -> dict:
    modules = []
    for path in paths:
        memory = SparseMemory()
        try:
            modules.append(load_elf32(path, memory, path.name))
        except Exception as error:
            modules.append({"name": path.name, "path": str(path), "sha256": sha256(path.read_bytes()), "error": str(error)})
    return {"format": "SO3_TARGETED_RUNTIME_MODULE_INVENTORY", "version": 1, "modules": modules}


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    movie = sub.add_parser("movie-transform")
    movie.add_argument("--lib", type=Path, required=True); movie.add_argument("--carrier", type=Path, required=True); movie.add_argument("--length", type=lambda x: int(x, 0), default=0x4000); movie.add_argument("--trace-limit", type=int, default=1200); movie.add_argument("--output", type=Path, required=True); movie.add_argument("--report", type=Path, required=True)
    inv = sub.add_parser("inventory"); inv.add_argument("paths", type=Path, nargs="+"); inv.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "inventory":
        result = inventory(args.paths); args.report.parent.mkdir(parents=True, exist_ok=True); args.report.write_text(json.dumps(result, indent=2) + "\n")
    else:
        output, result = run_movie_transform(args.lib, args.carrier.read_bytes(), args.length, args.trace_limit); args.output.parent.mkdir(parents=True, exist_ok=True); args.output.write_bytes(output); args.report.write_text(json.dumps(result, indent=2) + "\n")
        if not result["output"]["byte_exact_reference_match"]:
            raise SystemExit("runtime execution differs from reference transform")
    print(json.dumps(result if args.command == "inventory" else {"output": result["output"], "execution": result["execution"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
