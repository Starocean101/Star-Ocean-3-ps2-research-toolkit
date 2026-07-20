#!/usr/bin/env python3
"""Apply Star Ocean 3 PAL's EE/VU0 SLE-key transformation.

The EE loads 16 bytes into vf1, calls VU0 microprogram address 0, and stores vf3.
Each little-endian 32-bit lane is treated as a PS2 VU floating-point bit pattern.
The arithmetic below models the VU's non-IEEE multiply/add behavior bit-for-bit.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from dataclasses import dataclass

U32_MASK = 0xFFFFFFFF
SIGN_BIT = 0x80000000
ABS_MASK = 0x7FFFFFFF

# Number of extra normalization shifts selected by the VU-style adder.
_NORM_SHIFT = (
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    8, 8, 8, 8, 8, 8, 8, 8,
    16, 16, 16, 16, 16, 16, 16, 16,
    24, 24, 24, 24, 24, 24, 24,
)

# VU microprogram constants, paired with the instruction that consumes them.
# Lane x: 0x143B24 MULi.x, 0x143B2C ADDi.x
# Lane y: 0x143B34 MULi.y, 0x143B3C ADDi.y
# Lane z: 0x143B44 MULi.z, 0x143B4C ADDi.z
# Lane w: 0x143B54 MULi.w, 0x143B5C ADDi.w
MUL_CONSTANTS = (0x42FECCCD, 0x43D80D3E, 0x43A0DA10, 0x43546E14)
ADD_CONSTANTS = (0x42546666, 0xC7F079B3, 0x43A02666, 0x42F23333)

KNOWN_IOP_RESPONSE = bytes.fromhex("5bb763b082ce018788c8fc4635c53c79")
KNOWN_FINAL_KEY = bytes.fromhex("66665442b379f0c7e7d51e4b7ba41c7d")


def _u32(value: int) -> int:
    return value & U32_MASK


def _s32(value: int) -> int:
    value &= U32_MASK
    return value - (1 << 32) if value & SIGN_BIT else value


def _exponent(value: int) -> int:
    return (value >> 23) & 0xFF


def _mantissa(value: int) -> int:
    return value & 0x7FFFFF


def _is_denormal(value: int) -> bool:
    return _exponent(value) == 0


def _is_negative(value: int) -> bool:
    return bool(value & SIGN_BIT)


def _absolute_raw(value: int) -> int:
    return value & ABS_MASK


def _compare_magnitudes(a: int, b: int) -> int:
    return (_absolute_raw(a) > _absolute_raw(b)) - (_absolute_raw(a) < _absolute_raw(b))


def _addition_sign(a: int, b: int) -> bool:
    return _is_negative(a) if _compare_magnitudes(a, b) >= 0 else _is_negative(b)


def _count_leading_sign_bits(value: int) -> int:
    """Equivalent to R5900 CLRSB for a signed 32-bit integer."""
    value = _s32(value)
    if value >= 0:
        return 31 - value.bit_length() if value else 31
    inverted = _u32(~value)
    return 31 - inverted.bit_length() if inverted else 31


def _highest_set_bit(value: int) -> int:
    return value.bit_length() - 1 if value else -1


def _booth_term(a: int, b: int, bit: int) -> tuple[int, int]:
    """One radix-4 Booth term used by the VU multiplier's low-bit correction."""
    test = ((b >> (bit * 2 - 1)) if bit else (b << 1)) & 7
    partial = _u32(a << (bit * 2))
    if test in (3, 4):
        partial = _u32(partial + partial)

    negative_mask = U32_MASK if 4 <= test <= 6 else 0
    position_mask = _u32(1 << (bit * 2))
    partial = _u32(partial ^ (negative_mask & _u32(-position_mask)))
    partial &= U32_MASK if 1 <= test <= 6 else 0
    return partial, negative_mask & position_mask


def _add_three(a: int, b: int, c: int) -> tuple[int, int]:
    xor_ab = _u32(a ^ b)
    sum_bits = _u32(xor_ab ^ c)
    carry_bits = _u32(((xor_ab & c) | (a & b)) << 1)
    return sum_bits, carry_bits


def _vu_mantissa_product(a: int, b: int) -> int:
    """Return the VU-specific mantissa product, including its documented low-bit quirk."""
    full_product = a * b
    booth = [_booth_term(a, b, index) for index in range(8)]

    t0 = _add_three(booth[1][0], booth[2][0], booth[3][0])
    t1 = list(_add_three(
        booth[4][0] & _u32(~0x7FF),
        booth[5][0] & _u32(~0xFFF),
        booth[6][0],
    ))
    t1[1] = _u32(t1[1] | booth[6][1] | (booth[5][0] & 0x800))

    booth7_partial = _u32(booth[7][0] | _u32((booth[5][0] & 0x400) + booth[5][1]))
    t2 = _add_three(booth[0][0], t0[0], t0[1])
    t3 = _add_three(booth7_partial, t1[0], t1[1])
    t4 = _add_three(t2[1], t3[0], t3[1])
    t5 = list(_add_three(t2[0], t4[0], t4[1]))
    t5[1] = _u32(t5[1] + booth[7][1])
    t5[0] &= _u32(~0x7FFF)
    t5[1] &= _u32(~0x7FFF)

    ps2_low = _u32(t5[0] + t5[1])
    return full_product - ((ps2_low ^ full_product) & 0x8000)


def vu_multiply(a: int, b: int) -> int:
    """Bit-exact PS2 VU single-precision multiply for finite values used here."""
    a = _u32(a)
    b = _u32(b)

    if _is_denormal(a) or _is_denormal(b) or _absolute_raw(a) == 0 or _absolute_raw(b) == 0:
        return SIGN_BIT if _is_negative(a) ^ _is_negative(b) else 0

    result_exponent = _exponent(a) + _exponent(b) - 127
    result_mantissa = _vu_mantissa_product(
        _mantissa(a) | 0x800000,
        _mantissa(b) | 0x800000,
    ) >> 23

    if result_mantissa > 0xFFFFFF:
        result_mantissa >>= 1
        result_exponent += 1

    sign = SIGN_BIT if _is_negative(a) ^ _is_negative(b) else 0
    if result_exponent > 255:
        return sign | ABS_MASK
    if result_exponent < 1:
        return sign
    return sign | (result_exponent << 23) | (result_mantissa & 0x7FFFFF)


def _vu_add_inner(a: int, b: int) -> int:
    source_exponent = _exponent(a)
    exponent_difference = source_exponent - _exponent(b)
    if exponent_difference < 0:
        return _vu_add_inner(b, a)
    if exponent_difference >= 25:
        return a

    source_sign_mask = U32_MASK if _is_negative(a) else 0
    source_mantissa = _s32(_u32(((_mantissa(a) | 0x800000) ^ source_sign_mask) - source_sign_mask))
    other_sign_mask = U32_MASK if _is_negative(b) else 0
    other_mantissa = _s32(_u32(((_mantissa(b) | 0x800000) ^ other_sign_mask) - other_sign_mask))

    combined = _s32(_u32((source_mantissa << 6) + (_s32(other_mantissa << 6) >> exponent_difference)))
    absolute_mantissa = abs(combined)
    if absolute_mantissa == 0:
        return 0

    raw_exponent = source_exponent - 6
    shift_amount = _NORM_SHIFT[_count_leading_sign_bits(absolute_mantissa)]
    raw_exponent -= shift_amount
    absolute_mantissa = _u32(absolute_mantissa << shift_amount)

    most_significant = _highest_set_bit(absolute_mantissa >> 23)
    raw_exponent += most_significant
    absolute_mantissa >>= most_significant

    if raw_exponent > 255:
        return U32_MASK if combined < 0 else ABS_MASK
    if raw_exponent < 1:
        return SIGN_BIT if combined < 0 else 0
    return (_u32(combined) & SIGN_BIT) | (raw_exponent << 23) | (absolute_mantissa & 0x7FFFFF)


def vu_add(a: int, b: int) -> int:
    """Bit-exact PS2 VU single-precision add for the transform's operands."""
    a = _u32(a)
    b = _u32(b)

    if _is_denormal(a) or _is_denormal(b):
        negative = _addition_sign(a, b)
        sign = SIGN_BIT if negative else 0
        if _is_denormal(a) and not _is_denormal(b):
            return (b & ABS_MASK) | sign
        if not _is_denormal(a) and _is_denormal(b):
            return (a & ABS_MASK) | sign
        if not _is_negative(a) or not _is_negative(b):
            return 0
        return SIGN_BIT

    exponent_difference = _exponent(a) - _exponent(b)
    if 0 < exponent_difference < 25:
        exponent_difference -= 1
        b = _u32((U32_MASK << exponent_difference) & b)
    elif -25 < exponent_difference < 0:
        exponent_difference = -exponent_difference - 1
        a = _u32(a & (U32_MASK << exponent_difference))

    return _vu_add_inner(a, b)


@dataclass(frozen=True)
class LaneResult:
    lane: str
    input_word: int
    multiplier: int
    product_word: int
    addend: int
    output_word: int


def transform_words(words: tuple[int, int, int, int]) -> tuple[tuple[int, int, int, int], list[LaneResult]]:
    """Apply the four VU lane operations to little-endian x/y/z/w words."""
    if len(words) != 4:
        raise ValueError("exactly four 32-bit words are required")

    results: list[LaneResult] = []
    output: list[int] = []
    for lane, source, multiplier, addend in zip("xyzw", words, MUL_CONSTANTS, ADD_CONSTANTS):
        product = vu_multiply(source, multiplier)
        transformed = vu_add(product, addend)
        output.append(transformed)
        results.append(LaneResult(lane, source, multiplier, product, addend, transformed))
    return tuple(output), results  # type: ignore[return-value]


def transform_bytes(data: bytes) -> tuple[bytes, list[LaneResult]]:
    """Transform one 16-byte EE/VU vector and return bytes plus lane diagnostics."""
    if len(data) != 16:
        raise ValueError("input must be exactly 16 bytes")
    input_words = struct.unpack("<4I", data)
    output_words, details = transform_words(input_words)
    return struct.pack("<4I", *output_words), details


def _parse_hex(value: str) -> bytes:
    compact = value.strip().replace(" ", "").replace("_", "")
    try:
        decoded = bytes.fromhex(compact)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("input is not valid hexadecimal") from exc
    if len(decoded) != 16:
        raise argparse.ArgumentTypeError("input must contain exactly 16 bytes / 32 hexadecimal characters")
    return decoded


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_hex", nargs="?", type=_parse_hex, help="16-byte input as 32 hexadecimal characters")
    parser.add_argument("--input", dest="input_option", type=_parse_hex, help="same as the positional input")
    parser.add_argument("--verbose", action="store_true", help="emit JSON with lane-level intermediates")
    parser.add_argument("--self-test", action="store_true", help="verify the known IOP response and final key")
    args = parser.parse_args()

    if args.input_hex is not None and args.input_option is not None:
        parser.error("provide the input either positionally or with --input, not both")

    source = args.input_option if args.input_option is not None else args.input_hex
    if args.self_test:
        transformed, _ = transform_bytes(KNOWN_IOP_RESPONSE)
        if transformed != KNOWN_FINAL_KEY:
            print(
                f"self-test failed: got {transformed.hex()}, expected {KNOWN_FINAL_KEY.hex()}",
                file=sys.stderr,
            )
            return 1
        if source is None:
            source = KNOWN_IOP_RESPONSE

    if source is None:
        parser.error("a 16-byte input is required unless --self-test is used")

    transformed, details = transform_bytes(source)
    if not args.verbose:
        print(transformed.hex())
        return 0

    report = {
        "input_hex": source.hex(),
        "input_words_le": [f"0x{value:08X}" for value in struct.unpack("<4I", source)],
        "output_hex": transformed.hex(),
        "output_words_le": [f"0x{value:08X}" for value in struct.unpack("<4I", transformed)],
        "lanes": [
            {
                "lane": item.lane,
                "input": f"0x{item.input_word:08X}",
                "multiplier": f"0x{item.multiplier:08X}",
                "product": f"0x{item.product_word:08X}",
                "addend": f"0x{item.addend:08X}",
                "output": f"0x{item.output_word:08X}",
            }
            for item in details
        ],
    }
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
