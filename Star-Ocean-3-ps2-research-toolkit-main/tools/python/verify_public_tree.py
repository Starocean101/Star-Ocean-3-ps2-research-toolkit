#!/usr/bin/env python3
"""Fail closed if the public repository contains excluded game data."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RELEASE = ROOT / "01_RELEASE" / "so3_resource_explorer_v5_12_8_pass6_2.html"
COMPAT = ROOT / "browser" / "so3_browser_disc_investigator.html"
EXPECTED_RELEASE_SHA256 = "b2f02bec40ca1ce844f16dd59c0647a5ed4e0e486fcdfaf52782902fbb9dec86"

FORBIDDEN_SUFFIXES = {
    ".iso", ".img", ".irx", ".elf", ".sle", ".slz", ".pack", ".zls",
    ".pss", ".rta", ".fas", ".tm2", ".tim2", ".adx", ".7z", ".rar",
    ".zip",
}
ALLOWED_BINARY = {"02_SOURCE/so3_sac_vu_tables.bin"}
FORBIDDEN_PARTS = {
    "07_EXTERNAL_EVIDENCE", "FIELD_ENGINE_RESPONSE", "HYBRID_BOOTSTRAP_RESPONSE",
    "fixtures", "private-samples", "disc-images", "game-files", "extracted",
}
FORBIDDEN_NAMES = {"SLES_820.28", "Lib.bin", "Field.bin"}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    failures: list[str] = []
    files = sorted(
        path for path in ROOT.rglob("*")
        if path.is_file()
        and ".git" not in path.relative_to(ROOT).parts
        and "__pycache__" not in path.relative_to(ROOT).parts
    )
    for path in files:
        rel = path.relative_to(ROOT).as_posix()
        if any(part in FORBIDDEN_PARTS for part in path.relative_to(ROOT).parts):
            failures.append(f"forbidden path: {rel}")
        if path.name in FORBIDDEN_NAMES or path.name.startswith(("SLES_", "SLUS_", "SCUS_", "SLPM_", "SLPS_")):
            failures.append(f"forbidden executable name: {rel}")
        if path.suffix.lower() == ".bin" and rel not in ALLOWED_BINARY:
            failures.append(f"unapproved binary: {rel}")
        if path.suffix.lower() in FORBIDDEN_SUFFIXES:
            failures.append(f"forbidden file type: {rel}")

    if not RELEASE.is_file() or not COMPAT.is_file():
        failures.append("canonical or compatibility release missing")
    else:
        if sha256(RELEASE) != EXPECTED_RELEASE_SHA256:
            failures.append(f"release hash mismatch: {sha256(RELEASE)}")
        if RELEASE.read_bytes() != COMPAT.read_bytes():
            failures.append("browser compatibility copy differs from canonical release")

    for rel in (
        "05_ATLAS/SO3_FORMAT_REGISTRY_V1_1_2.json",
        "05_ATLAS/SO3_RESOURCE_GRAPH_V1_1_2.json",
        "05_ATLAS/ATLAS_UPDATE_LEDGER_V1.json",
        "04_REPORTS/ATLAS_REMERGE_V1_1_2_MAX_AUDIT.json",
    ):
        path = ROOT / rel
        if not path.is_file():
            failures.append(f"required public metadata missing: {rel}")
            continue
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # fail closed with the exact parse error
            failures.append(f"invalid JSON {rel}: {exc}")

    if failures:
        raise SystemExit("PUBLICATION AUDIT FAILED\n" + "\n".join(failures))

    print(json.dumps({
        "status": "PASS",
        "files_scanned": len(files),
        "release_sha256": sha256(RELEASE),
        "excluded_game_data_detected": False,
        "allowed_derived_binary": sorted(ALLOWED_BINARY),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
