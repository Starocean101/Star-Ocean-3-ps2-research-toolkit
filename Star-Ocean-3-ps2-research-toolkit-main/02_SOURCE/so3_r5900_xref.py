#!/usr/bin/env python3
"""Conservative R5900 static xref and VIF-palette candidate scanner.

The decoder is intentionally descriptive rather than executable. Unknown
opcodes remain `.word`; no semantic claim depends on guessing an instruction.
PS2Recomp is pinned as an independent opcode-reference source in the report.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import struct


FORMAT = "SO3_R5900_MATRIX_XREF_SCAN_V1"
REG = ["zero", "at", "v0", "v1", "a0", "a1", "a2", "a3", "t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "t8", "t9", "k0", "k1", "gp", "sp", "fp", "ra"]
SPECIAL = {
    0x00: "sll", 0x02: "srl", 0x03: "sra", 0x04: "sllv", 0x06: "srlv", 0x07: "srav",
    0x08: "jr", 0x09: "jalr", 0x0A: "movz", 0x0B: "movn", 0x10: "mfhi", 0x11: "mthi",
    0x12: "mflo", 0x13: "mtlo", 0x14: "dsllv", 0x16: "dsrlv", 0x17: "dsrav",
    0x18: "mult", 0x19: "multu", 0x1A: "div", 0x1B: "divu", 0x20: "add", 0x21: "addu",
    0x22: "sub", 0x23: "subu", 0x24: "and", 0x25: "or", 0x26: "xor", 0x27: "nor",
    0x2A: "slt", 0x2B: "sltu", 0x2C: "dadd", 0x2D: "daddu", 0x2E: "dsub", 0x2F: "dsubu",
    0x38: "dsll", 0x3A: "dsrl", 0x3B: "dsra", 0x3C: "dsll32", 0x3E: "dsrl32", 0x3F: "dsra32",
}
OPS = {
    0x08: "addi", 0x09: "addiu", 0x0A: "slti", 0x0B: "sltiu", 0x0C: "andi", 0x0D: "ori", 0x0E: "xori", 0x0F: "lui",
    0x18: "daddi", 0x19: "daddiu", 0x1E: "lq", 0x1F: "sq",
    0x20: "lb", 0x21: "lh", 0x22: "lwl", 0x23: "lw", 0x24: "lbu", 0x25: "lhu", 0x26: "lwr", 0x27: "lwu",
    0x28: "sb", 0x29: "sh", 0x2A: "swl", 0x2B: "sw", 0x2C: "sdl", 0x2D: "sdr", 0x2E: "swr", 0x2F: "cache",
    0x31: "lwc1", 0x33: "pref", 0x36: "lqc2", 0x37: "ld", 0x39: "swc1", 0x3E: "sqc2", 0x3F: "sd",
}
BRANCH = {0x04: "beq", 0x05: "bne", 0x06: "blez", 0x07: "bgtz", 0x14: "beql", 0x15: "bnel", 0x16: "blezl", 0x17: "bgtzl"}
MAGICS = {0x00415452: "RTA_MAGIC", 0x00534146: "FAS_MAGIC", 0x00534946: "FIS_MAGIC", 0x41534946: "FISA_MAGIC"}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hx(value: int, width: int = 8) -> str:
    return f"0x{value & 0xFFFFFFFF:0{width}X}"


def sign16(value: int) -> int:
    return value - 0x10000 if value & 0x8000 else value


def u32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def jump_target(pc: int, word: int) -> int:
    return ((pc + 4) & 0xF0000000) | ((word & 0x03FFFFFF) << 2)


def decode(pc: int, word: int) -> str:
    if word == 0:
        return "nop"
    op, rs, rt, rd, sa, fn, imm = word >> 26, (word >> 21) & 31, (word >> 16) & 31, (word >> 11) & 31, (word >> 6) & 31, word & 63, word & 0xFFFF
    if op == 0:
        name = SPECIAL.get(fn)
        if name in {"sll", "srl", "sra", "dsll", "dsrl", "dsra", "dsll32", "dsrl32", "dsra32"}:
            return f"{name} ${REG[rd]},${REG[rt]},{sa}"
        if name in {"jr"}:
            return f"{name} ${REG[rs]}"
        if name in {"jalr"}:
            return f"{name} ${REG[rd]},${REG[rs]}"
        if name in {"mfhi", "mflo"}:
            return f"{name} ${REG[rd]}"
        if name in {"mthi", "mtlo"}:
            return f"{name} ${REG[rs]}"
        if name:
            return f"{name} ${REG[rd]},${REG[rs]},${REG[rt]}"
    if op == 1:
        names = {0: "bltz", 1: "bgez", 2: "bltzl", 3: "bgezl", 16: "bltzal", 17: "bgezal", 18: "bltzall", 19: "bgezall"}
        target = (pc + 4 + (sign16(imm) << 2)) & 0xFFFFFFFF
        return f"{names.get(rt, 'regimm')} ${REG[rs]},{hx(target)}"
    if op in (2, 3):
        return f"{'jal' if op == 3 else 'j'} {hx(jump_target(pc, word))}"
    if op in BRANCH:
        target = (pc + 4 + (sign16(imm) << 2)) & 0xFFFFFFFF
        if op in (4, 5, 0x14, 0x15):
            return f"{BRANCH[op]} ${REG[rs]},${REG[rt]},{hx(target)}"
        return f"{BRANCH[op]} ${REG[rs]},{hx(target)}"
    if op == 0x0F:
        return f"lui ${REG[rt]},0x{imm:04X}"
    if op in OPS:
        name = OPS[op]
        if op in {0x08, 0x09, 0x0A, 0x0B, 0x18, 0x19}:
            return f"{name} ${REG[rt]},${REG[rs]},{sign16(imm)}"
        if op in {0x0C, 0x0D, 0x0E}:
            return f"{name} ${REG[rt]},${REG[rs]},0x{imm:04X}"
        return f"{name} ${REG[rt]},{sign16(imm)}(${REG[rs]})"
    if op == 0x10:
        return f"cop0 rs={rs} rt=${REG[rt]} rd={rd} fn=0x{fn:02X}"
    if op == 0x11:
        return f"cop1 rs={rs} rt=${REG[rt]} fs={rd} fd={sa} fn=0x{fn:02X}"
    if op == 0x12:
        return f"cop2 rs={rs} rt=${REG[rt]} rd={rd} fn=0x{fn:02X}"
    if op == 0x1C:
        return f"mmi rs=${REG[rs]} rt=${REG[rt]} rd=${REG[rd]} sa={sa} fn=0x{fn:02X}"
    return f".word {hx(word)}"


def is_prologue(word: int) -> bool:
    op, rs, rt, imm = word >> 26, (word >> 21) & 31, (word >> 16) & 31, word & 0xFFFF
    return op in (0x09, 0x19) and rs == 29 and rt == 29 and sign16(imm) < 0


def function_start(data: bytes, load: int, off: int) -> int | None:
    lower = max(0x40, off - 0x300)
    for pos in range(off & ~3, lower - 1, -4):
        if is_prologue(u32(data, pos)):
            return load + pos
    return None


def window(data: bytes, load: int, center_va: int, before: int = 0x40, after: int = 0x80) -> list[dict]:
    center = center_va - load
    start, end = max(0x40, center - before) & ~3, min(len(data), center + after) & ~3
    rows = []
    for off in range(start, end, 4):
        pc, word = load + off, u32(data, off)
        rows.append({"va": hx(pc), "word": hx(word), "instruction": decode(pc, word), "focus": pc == center_va})
    return rows


def parse_module(path: pathlib.Path) -> dict:
    data = path.read_bytes()
    if len(data) < 0x40 or data[:4] != b"MWo3":
        raise ValueError(f"{path} is not MWo3")
    load, region0, region1, zero_fill = u32(data, 8), u32(data, 0x0C), u32(data, 0x10), u32(data, 0x14)
    if len(data) != 0x40 + region0 + region1:
        raise ValueError(f"{path.name}: header regions do not equal file size")
    name = data[0x20:0x40].split(b"\0", 1)[0].decode("ascii", "replace")
    code_start, code_end = 0x40, 0x40 + region0
    hits: list[dict] = []
    calls: list[dict] = []
    lui: dict[int, tuple[int, int]] = {}
    for off in range(code_start, code_end & ~3, 4):
        pc, word = load + off, u32(data, off)
        op, rs, rt, imm = word >> 26, (word >> 21) & 31, (word >> 16) & 31, word & 0xFFFF
        if op == 3:
            calls.append({"site": pc, "target": jump_target(pc, word), "function": function_start(data, load, off)})
        if word in MAGICS:
            hits.append({"kind": MAGICS[word], "va": pc, "word": word, "function": function_start(data, load, off)})
        if op == 0x0F and rt:
            lui[rt] = (imm, off)
        elif op in (0x09, 0x0D) and rs in lui and off - lui[rs][1] <= 0x30:
            hi, high_off = lui[rs]
            value = ((hi << 16) + (sign16(imm) if op == 0x09 else imm)) & 0xFFFFFFFF
            if value in MAGICS or value in (0x10003C00, 0x10009000, 0x10003C10):
                hits.append({"kind": MAGICS.get(value, "VIF1_MMIO_CONSTANT"), "va": load + high_off, "word": value, "pair_end_va": pc, "function": function_start(data, load, high_off)})
        if imm == 0x0290 and op in set(OPS) | set(BRANCH) | {1}:
            hits.append({"kind": "IMMEDIATE_VU1_MATRIX_BASE_0x290", "va": pc, "word": word, "function": function_start(data, load, off)})
        cmd = (word >> 24) & 0x7F
        if (cmd & 0x60) == 0x60 and (word & 0x3FF) == 0x290:
            hits.append({"kind": "VIF_UNPACK_WORD_ADDR_0x290", "va": pc, "word": word, "vif_cmd": cmd, "vif_num": (word >> 16) & 0xFF, "function": function_start(data, load, off)})
    interesting_targets = [0x002B48E0]
    xrefs = []
    for target in interesting_targets:
        target_calls = [call for call in calls if call["target"] == target]
        xrefs.append({
            "target": hx(target),
            "target_is_in_module": load <= target < load + len(data),
            "target_function_candidate": hx(function_start(data, load, target - load)) if load <= target < load + code_end and function_start(data, load, target - load) is not None else None,
            "callers": [{"site": hx(call["site"]), "function": hx(call["function"]) if call["function"] is not None else None} for call in target_calls],
            "target_window": window(data, load, target) if load <= target < load + code_end else [],
        })
    for hit in hits:
        hit["va"] = hx(hit["va"])
        hit["word"] = hx(hit["word"])
        if hit.get("pair_end_va") is not None:
            hit["pair_end_va"] = hx(hit["pair_end_va"])
        if hit.get("function") is not None:
            hit["function"] = hx(hit["function"])
        hit["window"] = window(data, load, int(hit["va"], 16), 0x20, 0x30)
    return {
        "path": str(path),
        "name": name,
        "sha256": sha256(data),
        "class_value": u32(data, 4),
        "load_address": hx(load),
        "file_size": len(data),
        "region0_code_candidate": {"start": hx(load + code_start), "end_exclusive": hx(load + code_end), "size": region0},
        "region1_size": region1,
        "zero_fill_size": zero_fill,
        "allocation_end": hx(load + len(data) + zero_fill),
        "direct_jal_count": len(calls),
        "interesting_hits": hits,
        "target_xrefs": xrefs,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("modules", type=pathlib.Path, nargs="+")
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--ps2recomp-commit", default="ee149581aac999ab22791b3900377c0b028a5840")
    args = parser.parse_args()
    modules = [parse_module(path) for path in args.modules]
    report = {
        "format": FORMAT,
        "status": "CANDIDATE_STATIC_ANALYSIS",
        "decoder_reference": {"project": "ran-j/PS2Recomp", "commit": args.ps2recomp_commit, "use": "opcode and runtime design reference; this scan does not claim PS2Recomp execution"},
        "targets": {"legacy_animation_kernel_candidate": "0x002B48E0", "vu1_matrix_palette_base_qword": "0x290"},
        "modules": modules,
        "boundaries": [
            "MWo3 region0 is treated as the code-candidate scan range; embedded data can still produce false positives.",
            "Function starts are nearest stack-frame prologue heuristics, not symbols.",
            "A VIF-shaped word or immediate is candidate evidence until its producer executes and writes a DMA/VIF stream.",
            "Overlapping gameplay modules are separate runtime profiles and must never be mapped together merely for analysis convenience.",
        ],
    }
    encoded = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.write_text(encoded, encoding="utf-8")
        print(json.dumps({"status": report["status"], "output": str(args.output), "modules": len(modules), "hits": sum(len(row["interesting_hits"]) for row in modules)}))
    else:
        print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
