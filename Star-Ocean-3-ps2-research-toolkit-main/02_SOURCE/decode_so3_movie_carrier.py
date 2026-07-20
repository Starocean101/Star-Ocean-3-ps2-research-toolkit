#!/usr/bin/env python3
"""Decode or encode Star Ocean 3's movie-carrier transform.

This is a literal, portable implementation of the in-place R5900 routine at
Lib overlay VA 0x0041A2F0.  The routine operates on each little-endian 64-bit
lane in a 64-byte row:

    plain = ((carrier XOR lane_key) - 57 - row_index) mod 2**64

``row_index`` cycles from 0 through 31, so its period is 0x800 bytes.  The
eight lane keys are derived from the 16-byte PAL SLE/content key and the eight
constants embedded in the routine.
"""

from __future__ import annotations

import argparse
from pathlib import Path


DEFAULT_CONTENT_KEY = bytes.fromhex("66665442b379f0c7e7d51e4b7ba41c7d")

# 64-bit immediates constructed at 0x0041A320--0x0041A424.  Even lanes XOR
# the low content-key dword; odd lanes XOR the high content-key dword.
LANE_CONSTANTS = (
    0x432F96439F773428,
    0x7726FDC15439F654,
    0x35F437939FFF7CCD,
    0x64327FCCDF7EF358,
    0x5432678932464312,
    0xCCDEFACD32432146,
    0x43299F7658321943,
    0x7739FD014DF73254,
)

UINT64_MASK = (1 << 64) - 1
ROW_BYTES = 0x40
ROW_PERIOD = 0x20


def parse_content_key(value: str) -> bytes:
    try:
        key = bytes.fromhex(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("content key must be hexadecimal") from exc
    if len(key) != 16:
        raise argparse.ArgumentTypeError("content key must contain exactly 16 bytes")
    return key


def derive_lane_keys(content_key: bytes = DEFAULT_CONTENT_KEY) -> tuple[int, ...]:
    """Return the eight little-endian 64-bit lane keys used by the routine."""

    if len(content_key) != 16:
        raise ValueError("content key must contain exactly 16 bytes")
    halves = (
        int.from_bytes(content_key[:8], "little"),
        int.from_bytes(content_key[8:], "little"),
    )
    return tuple(
        constant ^ halves[lane & 1]
        for lane, constant in enumerate(LANE_CONSTANTS)
    )


# Retain the byte-string form for callers that used the earlier experimental
# module.  These values now come from the executable rather than inference.
LANE_KEYS = tuple(value.to_bytes(8, "little") for value in derive_lane_keys())


def transform(
    data: bytes,
    content_key: bytes = DEFAULT_CONTENT_KEY,
    *,
    encode: bool = False,
) -> bytes:
    """Apply the verified carrier transform.

    The game's ordinary reads are aligned, but decoding a final short lane is
    still well-defined for its available low-order bytes.  It is zero-padded
    for the arithmetic and then truncated back to the original length.
    """

    lane_keys = derive_lane_keys(content_key)
    output = bytearray(len(data))

    for offset in range(0, len(data), 8):
        block = data[offset : offset + 8]
        lane = (offset % ROW_BYTES) // 8
        row_index = (offset // ROW_BYTES) & (ROW_PERIOD - 1)
        adjustment = 57 + row_index

        value = int.from_bytes(block.ljust(8, b"\0"), "little")
        if encode:
            value = ((value + adjustment) & UINT64_MASK) ^ lane_keys[lane]
        else:
            value = ((value ^ lane_keys[lane]) - adjustment) & UINT64_MASK
        output[offset : offset + len(block)] = value.to_bytes(8, "little")[: len(block)]

    return bytes(output)


def decode(data: bytes, content_key: bytes = DEFAULT_CONTENT_KEY) -> bytes:
    """Decode carrier bytes to their original MPEG program stream."""

    return transform(data, content_key)


def encode(data: bytes, content_key: bytes = DEFAULT_CONTENT_KEY) -> bytes:
    """Encode MPEG program-stream bytes with the inverse transform."""

    return transform(data, content_key, encode=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--content-key",
        type=parse_content_key,
        default=DEFAULT_CONTENT_KEY,
        help="16-byte hexadecimal content key (default: validated PAL key)",
    )
    parser.add_argument(
        "--encode",
        action="store_true",
        help="apply the inverse transform (MPEG program stream to carrier)",
    )
    args = parser.parse_args()

    args.output.write_bytes(
        transform(args.input.read_bytes(), args.content_key, encode=args.encode)
    )


if __name__ == "__main__":
    main()
