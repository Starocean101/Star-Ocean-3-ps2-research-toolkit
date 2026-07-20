#!/usr/bin/env python3
"""Build the deterministic, evidence-separated legacy SO3 identity index."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path


SOURCE_SHA256 = "a8ffe9ef3ffecc27ebe87dd452271ffed6d1d9b4d8ee42903054a961325c1cab"
FORMAT = "SO3_LEGACY_IDENTITY_CLAIMS_V1"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse(source: Path) -> dict:
    if sha256(source) != SOURCE_SHA256:
        raise SystemExit(f"legacy list hash mismatch: {sha256(source)}")
    text = source.read_text(encoding="utf-8-sig")
    claims: list[dict] = []
    ranges: list[dict] = []
    disc: int | None = None
    group = "unsectioned"

    for line_number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        disc_match = re.fullmatch(r"Disc\s+([12]):", stripped)
        if disc_match:
            disc = int(disc_match.group(1))
            group = "party" if disc == 1 else "unsectioned"
            continue
        if stripped in {"NPCs:", "Misc:", "Unknown:", "PCs:", "Main NPCs:", "Lesser NPCs", "Airyglyph Streets:"}:
            group = stripped.rstrip(":").lower().replace(" ", "_")
            continue
        match = re.fullmatch(r"\s*(\d+)(?:_(\d+))?\s+(.+?)\s*", line)
        if match:
            entry = int(match.group(1))
            child = int(match.group(2)) if match.group(2) else None
            claims.append({
                "disc": disc,
                "entry": entry,
                "child": child,
                "label": match.group(3),
                "group": group,
                "source_line": line_number,
                "claim_scope": "hidden_entry" if child is None else "legacy_extracted_child",
                "confidence": "HISTORICAL_USER_CLAIM",
            })
            continue
        range_match = re.fullmatch(r"\s*(\d+)-(\d+)\s+(.+?)\s*", line)
        if range_match:
            ranges.append({
                "disc": disc,
                "entry_start": int(range_match.group(1)),
                "entry_end": int(range_match.group(2)),
                "label": range_match.group(3),
                "group": group,
                "source_line": line_number,
                "claim_scope": "hidden_entry_range",
                "confidence": "HISTORICAL_USER_CLAIM",
            })

    by_key: dict[tuple[int | None, int, int | None], list[dict]] = defaultdict(list)
    for claim in claims:
        by_key[(claim["disc"], claim["entry"], claim["child"])].append(claim)
    conflicts = []
    duplicate_lines = []
    for (key, rows) in sorted(by_key.items(), key=lambda item: tuple(-1 if v is None else v for v in item[0])):
        labels = sorted(set(row["label"] for row in rows))
        record = {"disc": key[0], "entry": key[1], "child": key[2], "labels": labels, "source_lines": [row["source_line"] for row in rows]}
        if len(labels) > 1:
            conflicts.append(record)
        elif len(rows) > 1:
            duplicate_lines.append(record)

    return {
        "format": FORMAT,
        "version": 1,
        "source": {
            "title_claim": "The Dude presents — A Satoh Production: the STAR OCEAN: TILL THE END OF TIME file list",
            "archive_member": "extract and view models by TheDude/SO3_fileList.txt",
            "sha256": SOURCE_SHA256,
            "line_count": len(text.splitlines()),
            "provenance_status": "BUNDLED_HISTORICAL_ARTIFACT; ORIGINAL_POST_LOCATION_UNRESOLVED",
        },
        "interpretation": {
            "primary_number": "triAce-PS2 output index; direct hidden-entry matching is supported when disc identity is selected",
            "secondary_number": "legacy extractor child ordinal; shown as a historical claim until matched to a reproduced child inventory",
            "labels_are_classification": False,
            "labels_are_verified": False,
            "automatic_override_allowed": False,
        },
        "summary": {
            "claims": len(claims),
            "disc_counts": dict(sorted(Counter(str(row["disc"]) for row in claims).items())),
            "top_level_claims": sum(row["child"] is None for row in claims),
            "child_claims": sum(row["child"] is not None for row in claims),
            "range_claims": len(ranges),
            "conflicting_keys": len(conflicts),
            "duplicate_same_label_keys": len(duplicate_lines),
        },
        "claims": claims,
        "range_claims": ranges,
        "conflicts": conflicts,
        "duplicate_lines": duplicate_lines,
    }


def js_module(data: dict) -> str:
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f'''/* Generated legacy identity claims. Do not hand edit; run build_legacy_labels.py. */
(function(root,factory){{const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SO3LegacyClaims=api;}})(typeof globalThis!=='undefined'?globalThis:this,function(){{
  'use strict';
  const DATA={payload};
  const key=(disc,entry,child)=>`${{Number(disc)||0}}:${{Number(entry)}}:${{child==null?'*':Number(child)}}`;
  const exact=new Map(),byEntry=new Map();
  for(const claim of DATA.claims){{
    const k=key(claim.disc,claim.entry,claim.child);if(!exact.has(k))exact.set(k,[]);exact.get(k).push(claim);
    const e=key(claim.disc,claim.entry,null);if(!byEntry.has(e))byEntry.set(e,[]);byEntry.get(e).push(claim);
  }}
  function claimsFor(disc,entry,child){{return (child===undefined?byEntry.get(key(disc,entry,null)):exact.get(key(disc,entry,child)))?.slice()||[];}}
  function search(text,disc){{const q=String(text||'').trim().toLowerCase();return DATA.claims.filter(x=>(!disc||x.disc===Number(disc))&&(!q||`${{x.entry}}_${{x.child??''}} ${{x.label}} ${{x.group}}`.toLowerCase().includes(q)));}}
  function conflictsFor(disc,entry,child){{return DATA.conflicts.filter(x=>x.disc===Number(disc)&&x.entry===Number(entry)&&(child===undefined||x.child===child));}}
  return Object.freeze({{VERSION:'5.8.1',FORMAT:DATA.format,DATA,claimsFor,search,conflictsFor}});
}});
'''


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("json_output", type=Path)
    parser.add_argument("js_output", type=Path)
    args = parser.parse_args()
    data = parse(args.source)
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.js_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.js_output.write_text(js_module(data), encoding="utf-8")
    print(json.dumps(data["summary"], sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
