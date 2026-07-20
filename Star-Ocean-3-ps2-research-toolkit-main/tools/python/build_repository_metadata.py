#!/usr/bin/env python3
"""Regenerate deterministic REPOSITORY_MANIFEST.json and SHA256SUMS.txt."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "REPOSITORY_MANIFEST.json"
SUMS = ROOT / "SHA256SUMS.txt"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def included(path: Path) -> bool:
    rel = path.relative_to(ROOT)
    return (
        path.is_file()
        and path not in {MANIFEST, SUMS}
        and ".git" not in rel.parts
        and "__pycache__" not in rel.parts
    )


def main() -> int:
    rows = []
    for path in sorted(path for path in ROOT.rglob("*") if included(path)):
        data = path.read_bytes()
        rows.append({
            "path": path.relative_to(ROOT).as_posix(),
            "size": len(data),
            "sha256": sha256(data),
        })

    manifest_data = (json.dumps(rows, indent=2) + "\n").encode("utf-8")
    MANIFEST.write_bytes(manifest_data)
    checksum_rows = rows + [{
        "path": "REPOSITORY_MANIFEST.json",
        "sha256": sha256(manifest_data),
    }]
    SUMS.write_text(
        "".join(f"{row['sha256']}  {row['path']}\n" for row in checksum_rows),
        encoding="utf-8",
    )
    print(json.dumps({
        "status": "PASS",
        "manifest_members": len(rows),
        "checksum_entries": len(checksum_rows),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
