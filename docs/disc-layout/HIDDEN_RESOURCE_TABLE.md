# Star Ocean 3 Hidden Resource Table

## Verified PAL Disc 1 profile

| Field | Value |
|---|---:|
| Table offset | `0x200000` |
| Signature | `0x27D51556` |
| Seed | `0x13578642` |
| Slot count | `0x1800` / 6144 |
| Nonempty entries | 5883 |
| Sector size | `0x800` bytes |

The table consists of parallel arrays holding LBA, sector length, and runtime
offset information.

For each nonempty entry:

```text
byte_offset = LBA * 0x800
byte_size   = sector_length * 0x800
```

Use 64-bit-safe arithmetic. In JavaScript, ordinary numeric multiplication is
safe for PS2 DVD offsets; bitwise operators are not, because they force signed
32-bit values.

## Interpretation

The hidden table is effectively the game's primary resource allocation map.
Most entries have no human-readable filename. The browser labels them by table
index and detected signature.

Top-level signatures observed on PAL Disc 1 included:

| Signature | Count |
|---|---:|
| ELF | 1 |
| SLZ0 | 2 |
| SLZ1 | 9 |
| SLZ2 | 188 |
| SLZ3 | 1438 |
| SLE2 | 2 |
| SLE3 | 1 |
| PACK | 366 |
| ZLS | 1 |

Counts describe top-level headers only. Additional files may be embedded inside
compressed or archive containers.

## Verified notable entries

| Entry | Top-level type | Importance |
|---:|---|---|
| 1 | SLZ2 chain | Contains twelve IOP modules, including `Csi_` |
| 2 | SLE3 | Encrypted/compressed resource |
| 3 | ELF | Hidden copy/allocation of the EE executable region |
| 8 | ZLS | Wrapper containing an inner SLZ2 stream |
| 1067 | SLE2 | Large encrypted/compressed resource |
| 1068 | SLE2 | Validation sample that decodes to `PACK` |
