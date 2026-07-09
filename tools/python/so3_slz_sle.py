#!/usr/bin/env python3
"""
Star Ocean: Till the End of Time (PS2, PAL, SLES_820.28)
SLZ / SLE reference decompressor.

Recovered from executable SLES_820.28 (ELF LOAD: vaddr 0x100000 -> file 0x680).

Function map (virtual addresses):
  0x102540  slz_sle_decode_block  : header check, SLE decrypt, type dispatch
  0x13A3E8  memcmp                : magic comparison ("SLZ"/"SLE", len 3)
  0x13A480  memcpy                : SLZ type 0 (stored)
  0x101ED0  slz_decomp_type1     : byte LZSS, end marker dist==0
  0x1019C0  slz_decomp_type2     : byte LZSS + RLE escape, terminates on outsize
  0x101520  slz_decomp_type3     : halfword (16-bit unit) LZSS, end marker dist==0
  0x1022E0  sle_decrypt_block    : standalone SLE payload decrypt
  0x10D880  get_global_ctx       : returns 0x1B6A80; SLE key = 16 bytes at +0x15CB0
                                   (0x1CC730, BSS; no writer found in executable ->
                                   effective key is all zeros)

Header (16 bytes):
  +0x00 char[3] "SLZ" or "SLE"
  +0x03 u8      type (0..3; executable dispatch: 0, 1, 2, default->type-3 code)
  +0x04 u32le   compressed payload size
  +0x08 u32le   decompressed size (used by type 0 memcpy and type 2 end pointer)
  +0x0C u32le   offset to next chained block (used to skip `index` blocks;
                0 terminates the chain lookup with failure)

SLE: payload is decrypted in place before SLZ decompression:
  plain[i] = ((cipher[i] - ctr) & 0xFF) ^ key[i & 15]; ctr starts at 3, +=3 per byte
  then header[2] is overwritten with 'Z' and normal SLZ dispatch follows.

No ring buffer is used: all backreferences read directly from previously
written output. Overlapping copies are performed unit-by-unit
(byte for types 1/2, halfword for type 3), so dist < len repeats output.
"""

import sys
import struct

SLE_KEY = bytes(16)  # BSS at 0x1CC730; no writer found in SLES_820.28


def sle_decrypt(payload: bytearray, key: bytes = SLE_KEY) -> None:
    """In-place SLE payload decrypt. Mirrors 0x102630-0x1027F8 / 0x1022E0."""
    ctr = 3
    for i in range(len(payload)):
        payload[i] = ((payload[i] - ctr) & 0xFF) ^ key[i & 15]
        ctr = (ctr + 3) & 0xFF


def decomp_type1(src: bytes, expected: int):
    """SLZ type 1 core @0x101ED0.

    8-bit control, LSB first. bit==1: literal byte. bit==0: 16-bit token:
      dist = b0 | ((b1 & 0x0F) << 8)   (bytes; 0 => end of stream)
      len  = (b1 >> 4) + 3             (3..18 bytes)
    Copy len bytes from out-dist, byte by byte (overlap repeats).
    """
    out = bytearray()
    pos = 0
    ctrl = 0
    bits = 1
    while True:
        bits -= 1
        if bits == 0:
            if pos >= len(src):
                raise EOFError("control byte read past end of stream")
            ctrl = src[pos]
            pos += 1
            bits = 8
        else:
            ctrl >>= 1
        if ctrl & 1:
            if pos >= len(src):
                raise EOFError("literal read past end of stream")
            out.append(src[pos])
            pos += 1
            continue
        if pos + 2 > len(src):
            raise EOFError("token read past end of stream")
        b0, b1 = src[pos], src[pos + 1]
        dist = b0 | ((b1 & 0x0F) << 8)
        if dist == 0:
            return bytes(out), pos + 2  # end marker consumed (lbu read both bytes)
        length = (b1 >> 4) + 3
        if dist > len(out):
            raise ValueError(f"invalid backreference dist={dist} at out={len(out)}")
        for _ in range(length):
            out.append(out[-dist])
        pos += 2


def decomp_type2(src: bytes, outsize: int):
    """SLZ type 2 core @0x1019C0.

    8-bit control, LSB first. bit==1: literal byte. bit==0: token b0,b1:
      nib = b1 >> 4, dist = b0 | ((b1 & 0x0F) << 8)
      nib < 15 : match, len = nib + 3 (3..17), from out-dist
      nib == 15: RLE escape
        dist >= 0x100: fill byte = dist & 0xFF, count = (dist >> 8) + 3 (4..18), 2-byte token
        dist <  0x100: fill byte = src[pos+2], count = dist + 0x13 (19..274), 3-byte token
    No end marker: loop runs while out < out_end (decompressed size from header +0x08).
    """
    out = bytearray()
    pos = 0
    ctrl = 0
    bits = 1
    while len(out) < outsize:
        bits -= 1
        if bits == 0:
            if pos >= len(src):
                raise EOFError("control byte read past end of stream")
            ctrl = src[pos]
            pos += 1
            bits = 8
        else:
            ctrl >>= 1
        if ctrl & 1:
            if pos >= len(src):
                raise EOFError("literal read past end of stream")
            out.append(src[pos])
            pos += 1
            continue
        if pos + 2 > len(src):
            raise EOFError("token read past end of stream")
        b0, b1 = src[pos], src[pos + 1]
        nib = b1 >> 4
        dist = b0 | ((b1 & 0x0F) << 8)
        if nib < 15:
            length = nib + 3
            if dist == 0 or dist > len(out):
                raise ValueError(f"invalid backreference dist={dist} at out={len(out)}")
            for _ in range(length):
                out.append(out[-dist])
            pos += 2
        else:
            if dist < 0x100:
                if pos + 3 > len(src):
                    raise EOFError("RLE fill byte read past end of stream")
                fill = src[pos + 2]
                count = dist + 0x13
                pos += 3
            else:
                fill = dist & 0xFF
                count = (dist >> 8) + 3
                pos += 2
            out.extend(bytes([fill]) * count)
    return bytes(out), pos


def decomp_type3(src: bytes, expected: int):
    """SLZ type 3 core @0x101520. All units are 16-bit halfwords.

    16-bit LE control word, LSB first (16 flags). bit==1: literal halfword.
    bit==0: 16-bit LE token:
      dist_hw = tok & 0xFFF  (halfwords; 0 => end of stream)
      len_hw  = (tok >> 12) + 2  (2..17 halfwords)
    Copy len_hw halfwords from out - 2*dist_hw, halfword by halfword
    (overlap repeats already-written output).
    """
    out = bytearray()
    pos = 0
    ctrl = 0
    bits = 1
    while True:
        bits -= 1
        if bits == 0:
            if pos + 2 > len(src):
                raise EOFError("control word read past end of stream")
            ctrl = src[pos] | (src[pos + 1] << 8)
            pos += 2
            bits = 16
        else:
            ctrl >>= 1
        if ctrl & 1:
            if pos + 2 > len(src):
                raise EOFError("literal halfword read past end of stream")
            out += src[pos:pos + 2]
            pos += 2
            continue
        if pos + 2 > len(src):
            raise EOFError("token read past end of stream")
        tok = src[pos] | (src[pos + 1] << 8)
        dist_hw = tok & 0xFFF
        if dist_hw == 0:
            return bytes(out), pos + 2
        len_hw = (tok >> 12) + 2
        dist = 2 * dist_hw
        if dist > len(out):
            raise ValueError(f"invalid backreference dist_hw={dist_hw} at out={len(out)}")
        for _ in range(len_hw):
            base = len(out) - dist
            out += out[base:base + 2]
        pos += 2


def decode(data: bytes, sle_key: bytes = SLE_KEY):
    """Parse header + decompress one exact SLZ/SLE chunk.

    Returns (output_bytes, info_dict).
    """
    if len(data) < 16:
        raise ValueError("truncated input: shorter than 16-byte header")
    magic = data[0:3]
    if magic not in (b"SLZ", b"SLE"):
        raise ValueError(f"bad magic {magic!r}")
    typ = data[3]
    csize, dsize, aux = struct.unpack_from("<III", data, 4)
    if len(data) < 16 + csize:
        raise ValueError(f"truncated input: header says {csize} payload bytes, "
                         f"got {len(data) - 16}")
    payload = bytearray(data[16:16 + csize])
    is_sle = magic == b"SLE"
    if is_sle:
        sle_decrypt(payload, sle_key)
    src = bytes(payload)
    if typ == 0:
        out, used = src[:dsize], dsize
        if dsize > csize:
            raise ValueError("type 0: decompressed size exceeds payload")
    elif typ == 1:
        out, used = decomp_type1(src, dsize)
    elif typ == 2:
        out, used = decomp_type2(src, dsize)
    else:  # executable dispatch: default case -> type-3 core
        out, used = decomp_type3(src, dsize)
    info = {
        "magic": magic.decode(),
        "type": typ,
        "sle": is_sle,
        "compressed_size": csize,
        "expected_size": dsize,
        "aux_0x0C": aux,
        "actual_size": len(out),
        "consumed": used,
        "remaining": csize - used,
        "size_ok": len(out) == dsize,
    }
    return out, info


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    key = SLE_KEY
    for a in argv[1:]:
        if a.startswith("--key="):
            key = bytes.fromhex(a[len("--key="):])
            if len(key) != 16:
                print("--key must be 16 bytes (32 hex chars)", file=sys.stderr)
                return 2
    if len(args) != 2:
        print("usage: so3_slz_sle.py [--key=<32hex>] input.slz|input.sle output.bin",
              file=sys.stderr)
        return 2
    data = open(args[0], "rb").read()
    try:
        out, info = decode(data, sle_key=key)
    except (ValueError, EOFError) as e:
        if data[:3] == b"SLE" and key == SLE_KEY:
            print("ERROR: this is an SLE (encrypted) chunk and no --key was given.",
                  file=sys.stderr)
            print("The 16-byte SLE key is loaded at runtime (VA 0x1CC730) and is not "
                  "present in the executable; supply it with --key=<32hexchars>.",
                  file=sys.stderr)
            return 3
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    open(args[1], "wb").write(out)
    print(f"magic={info['magic']} type={info['type']} "
          f"compressed={info['compressed_size']} expected={info['expected_size']} "
          f"actual={info['actual_size']} consumed={info['consumed']} "
          f"remaining={info['remaining']} aux=0x{info['aux_0x0C']:X}")
    if not info["size_ok"]:
        print("WARNING: output size mismatch", file=sys.stderr)
        return 1
    if info["remaining"] != 0:
        print(f"NOTE: {info['remaining']} compressed byte(s) not consumed",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
