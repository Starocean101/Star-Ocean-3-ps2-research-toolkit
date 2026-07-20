#!/usr/bin/env python3
"""Build the compact V5.8 model/actor index from Atlas V1.1.1 graph data."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("graph", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    graph = json.loads(args.graph.read_text(encoding="utf-8"))
    nodes = {node["id"]: node for node in graph["nodes"]}
    outgoing: dict[str, list[dict]] = defaultdict(list)
    for edge in graph["edges"]:
        outgoing[edge["src"]].append(edge)

    actors = []
    for actor in sorted((node for node in graph["nodes"] if node.get("kind") == "actor"), key=lambda row: row["actor_id"]):
        members = []
        for edge in graph["edges"]:
            if edge.get("kind") != "member_of_actor" or edge.get("dst") != actor["id"]:
                continue
            child = nodes[edge["src"]]
            parsed = []
            for linked in outgoing[child["id"]]:
                if linked.get("kind") in {"parsed_as", "geometry_validated_as"} and linked.get("dst") in nodes:
                    target = nodes[linked["dst"]]
                    parsed.append({
                        "kind": linked["kind"],
                        "node": target["id"],
                        "format_kind": target.get("kind"),
                        "metrics": {key: target[key] for key in (
                            "decoded_size", "segments", "packets", "verts", "tris", "skinned_verts",
                            "node_count", "target_skeleton", "empty",
                        ) if key in target},
                    })
            members.append({
                "node": child["id"],
                "entry": child.get("entry"),
                "index": child.get("index"),
                "tag": child.get("tag"),
                "res_id": child.get("res_id"),
                "stored_size": child.get("stored_size"),
                "offset": child.get("offset"),
                "animation_slot": child.get("anim_slot"),
                "parsed": parsed,
            })
        members.sort(key=lambda row: (row["entry"] or -1, row["index"] or -1, row["tag"] or ""))
        tags = [row["tag"] for row in members]
        actors.append({
            "actor_id": actor["actor_id"],
            "node": actor["id"],
            "resources": members,
            "component_counts": {
                "geometry": tags.count("CHAR"),
                "skeleton": tags.count("ATRC"),
                "animation": tags.count("ANIM"),
                "other": sum(tag not in {"CHAR", "ATRC", "ANIM"} for tag in tags),
            },
            "assembly_state": (
                "COMPONENT_COMPLETE_WITH_ANIMATION" if "CHAR" in tags and "ATRC" in tags and "ANIM" in tags
                else "COMPONENT_COMPLETE_STATIC" if "CHAR" in tags and "ATRC" in tags
                else "PARTIAL"
            ),
        })

    payload = {
        "format": "SO3_MODEL_ASSET_INDEX_V1",
        "version": 1,
        "atlas_version": graph.get("version"),
        "source_graph_sha256": sha256(args.graph),
        "association_confidence": {
            "resource_id_low16_grouping": "STRONG_INFERENCE",
            "fas_channel_to_rta_node_by_name": "VERIFIED_ON_PAIRED_SAMPLES",
            "xbdc_matrix_address_to_rta_node": "UNRESOLVED_ORDINAL_CANDIDATE_ONLY",
            "embedded_fis_membership": "VERIFIED_BY_CHAIN_BOUNDARY",
            "material_to_texture_assignment": "UNRESOLVED",
        },
        "actors": actors,
        "counts": {
            "actors": len(actors),
            "resources": sum(len(actor["resources"]) for actor in actors),
            "component_complete": sum(actor["assembly_state"].startswith("COMPONENT_COMPLETE") for actor in actors),
            "component_complete_with_animation": sum(actor["assembly_state"] == "COMPONENT_COMPLETE_WITH_ANIMATION" for actor in actors),
        },
    }
    body = json.dumps(payload, indent=2, sort_keys=True)
    output = """/* Generated from SO3_RESOURCE_GRAPH.json. Do not edit by hand. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SO3V58ModelIndex = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return Object.freeze(""" + body + ");\n});\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(output, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
