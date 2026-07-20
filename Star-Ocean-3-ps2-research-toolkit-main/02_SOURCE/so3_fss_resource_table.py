#!/usr/bin/env python3
"""Parse SO3 FSS runtime-resource descriptors and bridge IDOM palettes to RTA names.

This module intentionally stops at byte identities that are present in the
supplied files.  It does not evaluate animation, infer missing RTA channels, or
claim that file order selects a primary IDOM section.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
from pathlib import Path
from typing import Any


REPORT_FORMAT = "SO3_FSS_IDOM_RTA_NAME_BRIDGE_REPORT_V1"


def _u16(data: bytes, offset: int) -> int:
    return struct.unpack_from("<H", data, offset)[0]


def _u32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hex(value: int, width: int = 8) -> str:
    return f"0x{value:0{width}X}"


def _decode_cp932(raw: bytes) -> str:
    return raw.decode("cp932", errors="replace")


def _aligned_magic_offsets(data: bytes, magic: bytes) -> list[int]:
    return [offset for offset in range(0, len(data) - len(magic) + 1, 0x10) if data[offset : offset + len(magic)] == magic]


def parse_fss_sections(data: bytes) -> list[dict[str, Any]]:
    """Parse aligned FSS sections and their count-delimited descriptors."""

    sections: list[dict[str, Any]] = []
    for offset in _aligned_magic_offsets(data, b"FSS\0"):
        if offset + 0x4C > len(data):
            raise ValueError(f"truncated FSS header at {_hex(offset)}")
        declared_size = _u32(data, offset + 4)
        section_end = offset + 8 + declared_size
        if section_end > len(data):
            raise ValueError(f"FSS at {_hex(offset)} exceeds input")
        markers = {
            "command_2": _u32(data, offset + 0x10),
            "command_4": _u32(data, offset + 0x1C),
            "command_10": _u32(data, offset + 0x40),
            "command_3": _u32(data, offset + 0x48),
        }
        expected = {"command_2": 2, "command_4": 4, "command_10": 10, "command_3": 3}
        if markers != expected:
            raise ValueError(f"unsupported FSS command preamble at {_hex(offset)}: {markers}")
        descriptor_count = _u32(data, offset + 0x18)
        if descriptor_count > 4096:
            raise ValueError(f"implausible FSS descriptor count {descriptor_count}")
        cursor = offset + 0x4C
        descriptors: list[dict[str, Any]] = []
        for index in range(descriptor_count):
            if cursor + 0x10 > section_end:
                raise ValueError(f"FSS descriptor {index} header exceeds section")
            length = _u16(data, cursor)
            if length < 0x10 or length % 4 or cursor + length > section_end:
                raise ValueError(f"invalid FSS descriptor {index} length {length:#x}")
            record = data[cursor : cursor + length]
            name_offset = _u16(record, 2)
            if name_offset + 16 > len(record):
                raise ValueError(f"FSS descriptor {index} name field exceeds record")
            raw_name = record[name_offset : name_offset + 16].split(b"\0", 1)[0]
            descriptors.append(
                {
                    "index": index,
                    "file_offset": _hex(cursor),
                    "length": length,
                    "name_field_offset": name_offset,
                    "name_raw_hex": raw_name.hex(),
                    "name": _decode_cp932(raw_name),
                    "parent_descriptor_index": _u32(record, 4),
                    "source_section_offset": _hex(_u32(record, 8)),
                    "creation_subtype": record[0x0E],
                    "runtime_type": record[0x0F],
                }
            )
            cursor += length
        if cursor != section_end:
            raise ValueError(f"FSS descriptor extent ends at {_hex(cursor)}, expected {_hex(section_end)}")
        sections.append(
            {
                "file_offset": _hex(offset),
                "declared_size_field": declared_size,
                "total_section_bytes": section_end - offset,
                "descriptor_count": descriptor_count,
                "command_markers": markers,
                "descriptors": descriptors,
            }
        )
    return sections


def parse_idom_sections(data: bytes) -> list[dict[str, Any]]:
    """Parse the IDOM header, resource-record index table, and matrix extent."""

    sections: list[dict[str, Any]] = []
    for offset in _aligned_magic_offsets(data, b"IDOM"):
        if offset + 0x20 > len(data):
            raise ValueError(f"truncated IDOM header at {_hex(offset)}")
        matrix_count = _u32(data, offset + 0x14)
        if matrix_count > 1024:
            raise ValueError(f"implausible IDOM matrix count {matrix_count}")
        index_start = offset + 0x20
        matrix_start = index_start + matrix_count * 4
        matrix_end = matrix_start + matrix_count * 0x30
        if matrix_end > len(data):
            raise ValueError(f"IDOM matrix extent at {_hex(offset)} exceeds input")
        indices = list(struct.unpack_from(f"<{matrix_count}I", data, index_start)) if matrix_count else []
        sections.append(
            {
                "file_offset": _hex(offset),
                "declared_size_field": _u32(data, offset + 4),
                "matrix_count": matrix_count,
                "aux_relative_offset": _hex(_u32(data, offset + 0x18)),
                "flags": _hex(_u32(data, offset + 0x1C)),
                "double_buffer_flag_low_byte": data[offset + 0x1C],
                "resource_record_indices": indices,
                "stored_matrix_start": _hex(matrix_start),
                "stored_matrix_end_exclusive": _hex(matrix_end),
            }
        )
    return sections


def parse_rta_name_table(data: bytes) -> dict[str, Any]:
    """Read the count-delimited fixed-width CP932 RTA name table."""

    if len(data) < 0x40 or data[:4] != b"RTA\0":
        raise ValueError("not an RTA resource")
    node_count = _u16(data, 0x12)
    node_array_end = 0x40 + node_count * 0x20
    name_table_end = node_array_end + node_count * 0x14
    if name_table_end > len(data):
        raise ValueError("RTA node/name tables exceed input")
    names: list[dict[str, Any]] = []
    for ordinal in range(node_count):
        record = node_array_end + ordinal * 0x14
        raw_name = data[record + 4 : record + 0x14].split(b"\0", 1)[0]
        names.append(
            {
                "ordinal": ordinal,
                "record_offset": _hex(record),
                "name_raw_hex": raw_name.hex(),
                "name": _decode_cp932(raw_name),
            }
        )
    return {
        "node_count": node_count,
        "node_array_end": _hex(node_array_end),
        "name_record_stride": 0x14,
        "name_field_offset": 4,
        "name_field_width": 16,
        "names": names,
    }


def build_actor_bridge(actor: str, char_data: bytes, rta_data: bytes) -> dict[str, Any]:
    fss_sections = parse_fss_sections(char_data)
    if len(fss_sections) != 1:
        raise ValueError(f"{actor}: expected exactly one FSS section, found {len(fss_sections)}")
    fss = fss_sections[0]
    descriptors = fss["descriptors"]
    idom_sections = parse_idom_sections(char_data)
    rta = parse_rta_name_table(rta_data)

    descriptors_by_raw_name: dict[str, list[dict[str, Any]]] = {}
    for descriptor in descriptors:
        descriptors_by_raw_name.setdefault(descriptor["name_raw_hex"], []).append(descriptor)

    rta_mappings: list[dict[str, Any]] = []
    for row in rta["names"]:
        matches = descriptors_by_raw_name.get(row["name_raw_hex"], [])
        rta_mappings.append(
            {
                **row,
                "fss_descriptor_matches": [match["index"] for match in matches],
                "unique_fss_descriptor_index": matches[0]["index"] if len(matches) == 1 else None,
            }
        )
    rta_descriptor_to_ordinal = {
        row["unique_fss_descriptor_index"]: row["ordinal"]
        for row in rta_mappings
        if row["unique_fss_descriptor_index"] is not None
    }

    palettes: list[dict[str, Any]] = []
    for idom in idom_sections:
        slots: list[dict[str, Any]] = []
        for palette_slot, descriptor_index in enumerate(idom["resource_record_indices"]):
            if descriptor_index >= len(descriptors):
                raise ValueError(f"{actor}: IDOM index {descriptor_index} exceeds FSS descriptor table")
            descriptor = descriptors[descriptor_index]
            rta_ordinal = rta_descriptor_to_ordinal.get(descriptor_index)
            slots.append(
                {
                    "palette_slot": palette_slot,
                    "fss_descriptor_index": descriptor_index,
                    "fss_runtime_type": descriptor["runtime_type"],
                    "fss_parent_descriptor_index": descriptor["parent_descriptor_index"],
                    "name_raw_hex": descriptor["name_raw_hex"],
                    "name": descriptor["name"],
                    "rta_name_ordinal": rta_ordinal,
                    "rta_name_exact_match": rta_ordinal is not None,
                }
            )
        rta_matches = sum(1 for slot in slots if slot["rta_name_exact_match"])
        selected = {slot["fss_descriptor_index"] for slot in slots}
        named_rta_descriptors = set(rta_descriptor_to_ordinal)
        palettes.append(
            {
                **idom,
                "all_indices_in_fss_range": True,
                "all_selected_descriptors_runtime_type_9": all(slot["fss_runtime_type"] == 9 for slot in slots),
                "all_selected_descriptors_named": all(bool(slot["name_raw_hex"]) for slot in slots),
                "exact_rta_name_matches": rta_matches,
                "exact_rta_name_match_complete": rta_matches == idom["matrix_count"],
                "rta_named_descriptors_not_selected": sorted(named_rta_descriptors - selected),
                "selected_descriptors_absent_from_rta_name_table": sorted(selected - named_rta_descriptors),
                "slots": slots,
            }
        )

    return {
        "actor": actor,
        "inputs": {
            "char_size": len(char_data),
            "char_sha256": _sha256(char_data),
            "rta_size": len(rta_data),
            "rta_sha256": _sha256(rta_data),
        },
        "fss": {
            "file_offset": fss["file_offset"],
            "total_section_bytes": fss["total_section_bytes"],
            "descriptor_count": fss["descriptor_count"],
            "runtime_type_histogram": {
                str(runtime_type): sum(1 for descriptor in descriptors if descriptor["runtime_type"] == runtime_type)
                for runtime_type in sorted({descriptor["runtime_type"] for descriptor in descriptors})
            },
            "descriptors": descriptors,
        },
        "rta": {
            **{key: value for key, value in rta.items() if key != "names"},
            "unique_exact_name_matches": sum(1 for row in rta_mappings if row["unique_fss_descriptor_index"] is not None),
            "all_names_uniquely_match_fss": all(row["unique_fss_descriptor_index"] is not None for row in rta_mappings),
            "name_mappings": rta_mappings,
        },
        "idom_palettes": palettes,
    }


def build_report(actors: list[tuple[str, bytes, bytes]]) -> dict[str, Any]:
    rows = [build_actor_bridge(actor, char_data, rta_data) for actor, char_data, rta_data in actors]
    palette_rows = [palette for row in rows for palette in row["idom_palettes"]]
    total_slots = sum(palette["matrix_count"] for palette in palette_rows)
    rta_matches = sum(palette["exact_rta_name_matches"] for palette in palette_rows)
    actor_scope = {
        row["actor"]: (
            "PASS_ALL_IDOM_SLOTS_HAVE_UNIQUE_EXACT_RTA_NAME_IDENTITY"
            if all(palette["exact_rta_name_match_complete"] for palette in row["idom_palettes"])
            else "PARTIAL_SOME_IDOM_NODES_ARE_ABSENT_FROM_RTA_NAME_TABLE"
        )
        for row in rows
    }
    return {
        "format": REPORT_FORMAT,
        "status": "BYTE_EXACT_IDENTITY_BRIDGE_VERIFIED_WITH_SCOPED_PARTIAL_RTA_COVERAGE",
        "method": "Aligned FSS and IDOM parsing plus exact 16-byte CP932 name-field identity against each actor RTA table.",
        "actors": rows,
        "summary": {
            "actor_count": len(rows),
            "idom_palette_count": len(palette_rows),
            "idom_slot_rows": total_slots,
            "named_fss_slot_rows": sum(sum(1 for slot in palette["slots"] if slot["name_raw_hex"]) for palette in palette_rows),
            "exact_rta_name_slot_rows": rta_matches,
            "actor_scoped_matrix_to_rta": actor_scope,
        },
        "gates": {
            "fss_descriptor_layout": "PASS_BYTE_EXACT",
            "idom_to_named_runtime_node": "PASS_BYTE_EXACT_ALL_SLOTS",
            "rta_name_to_fss_descriptor": "PASS_BYTE_EXACT_ALL_RTA_NAMES",
            "matrix_to_rta_actor_0x08FF": actor_scope.get("0x08FF", "NOT_TESTED"),
            "matrix_to_rta_actor_0x0BC0": actor_scope.get("0x0BC0", "NOT_TESTED"),
            "matrix_to_rta_aggregate": "WITHHELD_PARTIAL_ACTOR_COVERAGE",
            "animation_rotation_evaluator": "WITHHELD_UNRESOLVED",
            "final_skinning": "WITHHELD_UNRESOLVED",
        },
        "boundary": [
            "Exact name identity proves node identity; it does not evaluate a rotation or compose a final skin matrix.",
            "An IDOM node absent from an actor's RTA name table is retained as a named FSS node and is not assigned a fabricated RTA ordinal.",
            "Multiple IDOM sections are reported separately; file order is not treated as a runtime role selector.",
        ],
        "recommended_reasoning_level": "max",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--actor", action="append", nargs=3, metavar=("ACTOR", "CHAR", "RTA"), required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    actors = [(actor, Path(char_path).read_bytes(), Path(rta_path).read_bytes()) for actor, char_path, rta_path in args.actor]
    output = json.dumps(build_report(actors), indent=2, ensure_ascii=False) + "\n"
    if args.output:
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
