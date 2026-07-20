#!/usr/bin/env python3
"""Create hybrid requests and validate browser response ZIPs."""
from __future__ import annotations
import argparse, hashlib, json, pathlib, sys, zipfile

REQUEST = "SO3_HYBRID_DATA_REQUEST_V1"
RESPONSE = "SO3_HYBRID_DATA_RESPONSE_V1"

def sha(data: bytes) -> str: return hashlib.sha256(data).hexdigest()

def initial_request(path: pathlib.Path) -> None:
    obj = {"format": REQUEST, "request_id": "so3_engine_bootstrap_v1", "visible_executables": True, "hidden_entries": [2], "actors": ["0x08FF", "0x0BC0"], "iso_ranges": [], "notes": "Bootstrap original-engine execution: exact PAL executable, entry-2 modules, and both actor controls."}
    path.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")

def validate(path: pathlib.Path, out: pathlib.Path | None) -> dict:
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if len(names) != len(set(names)) or any(name.startswith("/") or ".." in pathlib.PurePosixPath(name).parts for name in names): raise ValueError("unsafe or duplicate ZIP member")
        report = json.loads(z.read("SO3_HYBRID_DATA_RESPONSE.json"))
        if report.get("format") != RESPONSE: raise ValueError("wrong response format")
        expected = {row["path"]: row for row in report.get("members", [])}
        for name, row in expected.items():
            data = z.read(name)
            if len(data) != row["size"] or sha(data) != row["sha256"]: raise ValueError(f"member mismatch: {name}")
        sum_rows = {}
        for line in z.read("SHA256SUMS.txt").decode().splitlines():
            digest, name = line.split("  ", 1); sum_rows[name] = digest
        for name, row in expected.items():
            if sum_rows.get(name) != row["sha256"]: raise ValueError(f"checksum list mismatch: {name}")
        if out:
            out.mkdir(parents=True, exist_ok=True)
            for name in names:
                target = out / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(z.read(name))
        return {"status": "PASS", "request_id": report["request"]["request_id"], "members": len(expected), "payload_bytes": report["total_payload_bytes"], "errors": report.get("errors", []), "complete": report.get("complete", False)}

def main() -> int:
    p = argparse.ArgumentParser(); sub = p.add_subparsers(dest="cmd", required=True)
    make = sub.add_parser("make-initial-request"); make.add_argument("output", type=pathlib.Path)
    check = sub.add_parser("validate"); check.add_argument("response", type=pathlib.Path); check.add_argument("--extract", type=pathlib.Path)
    a = p.parse_args()
    if a.cmd == "make-initial-request": initial_request(a.output); print(a.output); return 0
    print(json.dumps(validate(a.response, a.extract), indent=2)); return 0

if __name__ == "__main__":
    try: raise SystemExit(main())
    except Exception as exc: print(f"ERROR: {exc}", file=sys.stderr); raise SystemExit(1)
