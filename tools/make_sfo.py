#!/usr/bin/env python3
"""Write a PS4 application param.sfo (no external tools needed)."""
import argparse
import struct
import time

FMT_UTF8 = 0x0204
FMT_INT = 0x0404


def build(entries):
    entries = sorted(entries, key=lambda e: e[0])
    keys = b""
    key_offsets = []
    for k, _, _, _ in entries:
        key_offsets.append(len(keys))
        keys += k.encode() + b"\0"
    keys += b"\0" * ((4 - len(keys) % 4) % 4)

    index = b""
    data = b""
    for (k, fmt, val, maxlen), koff in zip(entries, key_offsets):
        if fmt == FMT_INT:
            raw = struct.pack("<I", val)
            length = maxlen = 4
        else:
            raw = val.encode("utf-8") + b"\0"
            length = len(raw)
            if length > maxlen:
                raise SystemExit(f"{k} too long ({length} > {maxlen})")
            raw = raw.ljust(maxlen, b"\0")
        index += struct.pack("<HHIII", koff, fmt, length, maxlen, len(data))
        data += raw

    key_table = 20 + len(index)
    data_table = key_table + len(keys)
    header = struct.pack("<4sIIII", b"\0PSF", 0x101, key_table, data_table, len(entries))
    return header + index + keys + data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--title", required=True)
    ap.add_argument("--title-id", required=True)
    ap.add_argument("--content-id", required=True)
    ap.add_argument("--version", default="01.00")
    a = ap.parse_args()

    if a.content_id[7:16] != a.title_id:
        raise SystemExit("CONTENT_ID must contain TITLE_ID (chars 8-16)")

    today = time.strftime("%Y%m%d")
    entries = [
        ("APP_TYPE", FMT_INT, 1, 4),
        ("APP_VER", FMT_UTF8, a.version, 8),
        ("ATTRIBUTE", FMT_INT, 0, 4),
        ("CATEGORY", FMT_UTF8, "gd", 4),
        ("CONTENT_ID", FMT_UTF8, a.content_id, 48),
        ("DOWNLOAD_DATA_SIZE", FMT_INT, 0, 4),
        ("FORMAT", FMT_UTF8, "obs", 4),
        ("PARENTAL_LEVEL", FMT_INT, 1, 4),
        ("PUBTOOLINFO", FMT_UTF8, f"c_date={today},sdk_ver=05050000,st_type=digital50,img0_l0_size=0,img0_l1_size=0,img0_sc_ksize=0,img0_pc_ksize=0", 512),
        ("SYSTEM_VER", FMT_INT, 0, 4),
        ("TITLE", FMT_UTF8, a.title, 128),
        ("TITLE_ID", FMT_UTF8, a.title_id, 12),
        ("VERSION", FMT_UTF8, a.version, 8),
    ]
    with open(a.out, "wb") as f:
        f.write(build(entries))


if __name__ == "__main__":
    main()
