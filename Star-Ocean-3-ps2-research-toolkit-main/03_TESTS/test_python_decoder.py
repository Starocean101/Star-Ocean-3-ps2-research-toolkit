#!/usr/bin/env python3
"""Pinned behavior checks for the portable SO3 movie decoder."""

from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "02_SOURCE" / "decode_so3_movie_carrier.py"
SPEC = importlib.util.spec_from_file_location("so3_movie", SOURCE)
assert SPEC and SPEC.loader
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def check(name: str, condition: bool) -> None:
    if not condition:
        raise AssertionError(f"[FAIL] {name}")
    print(f"[PASS] {name}")


def main() -> int:
    expected_lanes = (
        "4e5223ddf0efdf84", "b323271fba593a0a", "ab1aabdd204e04f2", "bf266094b7db2e19",
        "742512703a1ec293", "a1f45d79b65ec2b1", "257f661ac5e6d984", "b3e7e9067a59250a",
    )
    check("validated PAL content key", M.DEFAULT_CONTENT_KEY.hex() == "66665442b379f0c7e7d51e4b7ba41c7d")
    check("executable-derived lane keys", tuple(x.hex() for x in M.LANE_KEYS) == expected_lanes)

    carrier = bytes.fromhex("77522267b4efdb848e22262b21a13a0a91a1abd4a0d449f2e5598073b1db2e186d35e8f3fb13f3939bce9c68b65fdc107218601ac5e76aac8927ca1435faa71a")
    expected = bytes.fromhex("000001ba44000400040101349bf8000001bb0009809a4d00217fe0e706000001e00ffa83c10d3100013ac11100011ea11e6706000001b32801c023124fa38210")
    decoded = M.decode(carrier)
    check("entry 21 pinned decode", decoded == expected)
    check("pinned decode round-trip", M.encode(decoded) == carrier)

    synthetic = bytes((i * 97 + (i // 64) * 13) & 255 for i in range(0x2018))
    check("synthetic full round-trip", M.decode(M.encode(synthetic)) == synthetic)
    print("=> 5 checks, 0 failures")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
