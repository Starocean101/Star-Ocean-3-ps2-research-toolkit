#!/usr/bin/env python3
"""Validate and assemble the declared SO3 EE executable memory corpus.

This tool deliberately maps only addresses declared by the PAL ELF and MWo3
headers.  Actor resources remain catalogued, but unmapped, until the original
loader's object layout has been reconstructed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import struct
from dataclasses import dataclass


FORMAT = "SO3_SPARSE_ENGINE_CORPUS_V1"
RESPONSE_FORMAT = "SO3_HYBRID_DATA_RESPONSE_V1"
PAGE_SIZE = 0x1000
EE_RAM_END = 0x02000000


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hx(value: int, width: int = 8) -> str:
    return f"0x{value:0{width}X}"


def u32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def merged(intervals: list[tuple[int, int]]) -> list[tuple[int, int]]:
    result: list[list[int]] = []
    for start, end in sorted(intervals):
        if start >= end:
            continue
        if not result or start > result[-1][1]:
            result.append([start, end])
        else:
            result[-1][1] = max(result[-1][1], end)
    return [(start, end) for start, end in result]


def range_covered(start: int, end: int, intervals: list[tuple[int, int]]) -> bool:
    cursor = start
    for left, right in merged(intervals):
        if right <= cursor:
            continue
        if left > cursor:
            return False
        cursor = max(cursor, right)
        if cursor >= end:
            return True
    return cursor >= end


@dataclass(frozen=True)
class LoadSegment:
    index: int
    offset: int
    va: int
    file_size: int
    memory_size: int
    flags: int
    alignment: int

    @property
    def end(self) -> int:
        return self.va + self.memory_size

    def report(self) -> dict:
        return {
            "index": self.index,
            "file_offset": hx(self.offset),
            "va": hx(self.va),
            "end_exclusive": hx(self.end),
            "file_size": self.file_size,
            "memory_size": self.memory_size,
            "flags": self.flags,
            "alignment": self.alignment,
            "kind": "FILE_BACKED_LOAD" if self.file_size else "OVERLAY_RESERVATION",
        }


class SparseMemory:
    def __init__(self) -> None:
        self.pages: dict[int, bytearray] = {}
        self.file_backed: list[tuple[int, int, str]] = []
        self.writes: list[dict] = []

    def _page(self, address: int, create: bool) -> bytearray | None:
        number = address // PAGE_SIZE
        page = self.pages.get(number)
        if page is None and create:
            page = bytearray(PAGE_SIZE)
            self.pages[number] = page
        return page

    def read_byte(self, address: int) -> int:
        page = self._page(address, False)
        return 0 if page is None else page[address & (PAGE_SIZE - 1)]

    def write(self, address: int, data: bytes, source: str, file_backed: bool) -> dict:
        if address < 0 or address + len(data) > EE_RAM_END:
            raise ValueError(f"mapping {source} lies outside 32 MiB EE RAM")
        conflicts = 0
        conflict_samples: list[dict] = []
        for index, value in enumerate(data):
            va = address + index
            previous = self.read_byte(va)
            if previous and previous != value:
                conflicts += 1
                if len(conflict_samples) < 16:
                    conflict_samples.append({"va": hx(va), "old": previous, "new": value})
            self._page(va, True)[va & (PAGE_SIZE - 1)] = value
        if file_backed:
            self.file_backed.append((address, address + len(data), source))
        row = {
            "source": source,
            "start": hx(address),
            "end_exclusive": hx(address + len(data)),
            "file_bytes": len(data),
            "nonzero_conflicts": conflicts,
            "conflict_samples": conflict_samples,
        }
        self.writes.append(row)
        return row

    def read(self, address: int, size: int) -> bytes:
        return bytes(self.read_byte(address + index) for index in range(size))


def parse_elf32(data: bytes) -> tuple[dict, list[LoadSegment]]:
    if len(data) < 52 or data[:6] != b"\x7fELF\x01\x01":
        raise ValueError("expected ELF32 little-endian image")
    machine = struct.unpack_from("<H", data, 18)[0]
    entry, phoff = struct.unpack_from("<II", data, 24)
    phentsize, phnum = struct.unpack_from("<HH", data, 42)
    segments: list[LoadSegment] = []
    for index in range(phnum):
        offset = phoff + index * phentsize
        if offset + 32 > len(data):
            raise ValueError(f"truncated ELF program header {index}")
        p_type, file_offset, va, _pa, file_size, memory_size, flags, alignment = struct.unpack_from(
            "<IIIIIIII", data, offset
        )
        if p_type != 1 or memory_size == 0:
            continue
        if file_offset + file_size > len(data):
            raise ValueError(f"truncated ELF PT_LOAD {index}")
        if va + memory_size > EE_RAM_END:
            raise ValueError(f"ELF PT_LOAD {index} exceeds EE RAM")
        segments.append(LoadSegment(index, file_offset, va, file_size, memory_size, flags, alignment))
    return {
        "class": "ELF32",
        "endianness": "LITTLE",
        "machine": machine,
        "entry": hx(entry),
        "program_header_count": phnum,
    }, segments


def parse_mwo3(data: bytes) -> dict:
    if len(data) < 0x40 or data[:4] != b"MWo3":
        raise ValueError("expected decoded MWo3 image")
    name = data[0x20:0x40].split(b"\0", 1)[0].decode("ascii", "replace")
    load = u32(data, 0x08)
    region0 = u32(data, 0x0C)
    region1 = u32(data, 0x10)
    zero_fill = u32(data, 0x14)
    file_formula = 0x40 + region0 + region1
    return {
        "magic": "MWo3",
        "class_value": u32(data, 0x04),
        "load_address": load,
        "load_address_hex": hx(load),
        "region0_size": region0,
        "region1_size": region1,
        "zero_fill_size": zero_fill,
        "init_array_start": hx(u32(data, 0x18)),
        "init_array_end": hx(u32(data, 0x1C)),
        "embedded_name": name,
        "file_size": len(data),
        "file_size_formula": "0x40 + region0_size + region1_size",
        "file_size_formula_value": file_formula,
        "file_size_formula_matches": file_formula == len(data),
        "allocation_size": len(data) + zero_fill,
        "allocation_end": hx(load + len(data) + zero_fill),
    }


def load_response(root: pathlib.Path) -> tuple[dict, dict[str, bytes]]:
    report_path = root / "SO3_HYBRID_DATA_RESPONSE.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("format") != RESPONSE_FORMAT:
        raise ValueError("wrong hybrid response format")
    sums: dict[str, str] = {}
    for line in (root / "SHA256SUMS.txt").read_text(encoding="utf-8").splitlines():
        digest, name = line.split("  ", 1)
        sums[name] = digest
    payloads: dict[str, bytes] = {}
    for row in report.get("members", []):
        name = row["path"]
        data = (root / name).read_bytes()
        digest = sha256(data)
        if len(data) != row["size"] or digest != row["sha256"] or sums.get(name) != digest:
            raise ValueError(f"hybrid member verification failed: {name}")
        payloads[name] = data
    return report, payloads


def build(root: pathlib.Path) -> dict:
    response, payloads = load_response(root)
    elf_name = next(name for name in payloads if name.startswith("executables/") and payloads[name][:4] == b"\x7fELF")
    elf_bytes = payloads[elf_name]
    elf, segments = parse_elf32(elf_bytes)
    reservations = [(segment.va, segment.end) for segment in segments]
    zero_reservations = [segment for segment in segments if segment.file_size == 0]
    memory = SparseMemory()

    for segment in segments:
        if not segment.file_size:
            continue
        source = f"{elf_name}:PT_LOAD:{segment.index}"
        memory.write(segment.va, elf_bytes[segment.offset:segment.offset + segment.file_size], source, True)

    modules: list[dict] = []
    for name in sorted(path for path in payloads if path.startswith("hidden_entry_2/") and payloads[path][:4] == b"MWo3"):
        data = payloads[name]
        header = parse_mwo3(data)
        load = header["load_address"]
        allocation_end = load + header["allocation_size"]
        enclosing = [segment for segment in zero_reservations if segment.va <= load and allocation_end <= segment.end]
        if not range_covered(load, allocation_end, reservations):
            raise ValueError(f"{name} allocation is not covered by ELF PT_LOAD reservations")
        write = memory.write(load, data, name, True)
        if write["nonzero_conflicts"]:
            raise ValueError(f"{name} overwrites nonzero executable bytes")
        zero_tail_start = load + len(data)
        row = {
            "path": name,
            "sha256": sha256(data),
            **header,
            "zero_tail": {"start": hx(zero_tail_start), "end_exclusive": hx(allocation_end), "size": header["zero_fill_size"]},
            "covered_by_elf_reservations": True,
            "enclosing_zero_file_reservations": [segment.index for segment in enclosing],
            "exact_reservation_matches": [segment.index for segment in enclosing if segment.va == load and segment.end == allocation_end],
            "write": write,
        }
        modules.append(row)

    known_slices = []
    for label, start, size in [
        ("Lib_facial_selector_controlled_slice", 0x004D7BB0, 0x100),
        ("Lib_FAS_rotation_candidate_head", 0x004B5500, 0x100),
        ("Lib_FIS_resolver_candidate_head", 0x00454E00, 0x100),
    ]:
        data = memory.read(start, size)
        known_slices.append({"label": label, "start": hx(start), "size": size, "sha256": sha256(data), "all_zero": not any(data)})

    actors = []
    for name, data in sorted(payloads.items()):
        if not name.startswith("actors/"):
            continue
        parts = name.split("/")
        actors.append({"actor": parts[1], "path": name, "size": len(data), "sha256": sha256(data), "guest_mapping": None})

    exact_matches = {module["embedded_name"]: module["exact_reservation_matches"] for module in modules}
    if exact_matches.get("boot.bin") != [3] or exact_matches.get("Lib.bin") != [4]:
        raise ValueError(f"unexpected MWo3 reservation relationship: {exact_matches}")

    return {
        "format": FORMAT,
        "status": "PASS",
        "source": {
            "request_id": response["request"]["request_id"],
            "response_complete": response.get("complete", False),
            "response_member_count": len(response.get("members", [])),
            "response_payload_bytes": response.get("total_payload_bytes"),
        },
        "elf": {
            "path": elf_name,
            "size": len(elf_bytes),
            "sha256": sha256(elf_bytes),
            **elf,
            "load_segments": [segment.report() for segment in segments],
        },
        "mwo3_modules": modules,
        "known_code_slices": known_slices,
        "actor_resources": actors,
        "memory": {
            "model": "32_MIB_EE_SPARSE",
            "mapped_page_count": len(memory.pages),
            "write_provenance": memory.writes,
            "nonzero_conflict_count": sum(row["nonzero_conflicts"] for row in memory.writes),
        },
        "boundaries": [
            "Only ELF PT_LOAD file bytes and decoded MWo3 bytes are assigned guest addresses.",
            "MWo3 zero-fill tails are declared and reservation-checked; they are represented as zero memory without an output RAM dump.",
            "Actor CHAR/RTA/FAS resources are hash-verified but intentionally unmapped until the original loader state is reconstructed.",
            "This corpus proves address layout and byte provenance, not that boot initialization or an actor render path has executed.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("response_root", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()
    report = build(args.response_root)
    encoded = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.write_text(encoded, encoding="utf-8")
        print(json.dumps({"status": report["status"], "output": str(args.output), "modules": len(report["mwo3_modules"]), "actors": len(report["actor_resources"])}))
    else:
        print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
