# Facial CLUT Repair — V5.12.4

The packaged `FACIAL_CLUT_V5124_CORRECTED_MONTAGE.png` is a visual audit of
all seven corrected 64×64 facial sheets. It is generated from the same fixture
bytes and decoder path pinned by the hashes below; it is evidence, not a
repainted texture asset.

Actor `0x0BC0`. This pass fixes the visible facial corruption in the Model Lab without repainting, blurring, or heuristically changing any texture.

## Verdict

- **VERIFIED:** the seven 64×64 facial FIS members each contain one logical 16-color PSMT4 CLUT, not two palette variants.
- **VERIFIED:** their palette transfer is a 16×2 PSMCT32 host-to-local upload (`TRXREG = 0x0000000200000010`, 128 payload bytes) at destination `(0,0)`.
- **VERIFIED:** CSM1 IDTEX4 consumes an 8×2 CLUT. Therefore logical entries `0–7` come from stored entries `0–7`, and logical entries `8–15` come from stored entries `16–23`. Stored entries `8–15` and `24–31` are transfer-row padding for this use, not separate banks.
- **VERIFIED:** every texel index used by every facial member maps to an opaque logical CLUT entry. The former decoder mapped 17.48%–36.30% of the face texels to padding/transparent entries, producing the dark perforated face seen in V5.12.0/V5.12.1.
- **VERIFIED:** the runtime FISA member selector remains valid. The static Model Lab preview intentionally holds each facial family at its base member until animation-clock playback is implemented.
- **SUPERSEDED:** the prior claim that a missing actor-specific FISP record selected facial palette bank 0/1. FISP is reached through a generic render-descriptor path, and the returned ISO evidence contains no association with actor `0x0BC0`, `naka`, or the facial FISA selector.

## Byte-level derivation

All seven facial members declare:

- actual texture PSM `0x14` (`PSMT4`);
- stored palette-entry count `32`;
- palette payload size `0x80` bytes;
- palette upload PSM `0x00` (`PSMCT32`);
- palette upload width `16`, height `2`;
- palette destination X/Y `0/0`.

The GS CSM1 IDTEX4 source rectangle is 8×2. With a 16-entry upload row, logical index `i` reads stored upload entry:

```text
(i & 7) + ((i >> 3) * 16)
```

That produces the exact source order:

```text
0,1,2,3,4,5,6,7,16,17,18,19,20,21,22,23
```

The old decoder used contiguous slices `0–15` and `16–31`. Both slices mixed one meaningful eight-color row with one padding row and were therefore not valid logical palettes.

## Corrected facial outputs

| FIS id | Texels formerly mapped to padding | Corrected RGBA SHA-256 |
|---:|---:|---|
| 1294 | 738 / 4096 | `67fb7c3f7a0a93dc5deafea5c3ac7e5a676ea1adfa773937aac0c531a4c946d3` |
| 1295 | 716 / 4096 | `cce97e45d489dea33a6cbad5f1f1d5ed24291e3cead03866b2fdc2c219d27eae` |
| 1296 | 880 / 4096 | `e3e033f93f876e0358390cc66292f7f47b538c7e60bccfb00b17b7c9b80ea2d3` |
| 2413 | 1478 / 4096 | `66a9ba0befd0e58372f25028b697848c323570dac5b86ca1878e33e0539f92e1` |
| 2414 | 1487 / 4096 | `6e67833b4c748eb5478ba316175dceef4702038023149e811f51515d7e1da556` |
| 2415 | 1445 / 4096 | `477651cc4e7b73eceea4fc7bf575ec7c45202ce2cc8df540a995781a936c872d` |
| 3362 | 1411 / 4096 | `0c1095e734d504d5ec2e7753856c5c0882f0c2d99e2a521c2e07bd3f35ec9dbf` |

No source pixels or palette colors were edited.

## Returned FISP evidence correction

The five V5.12.3 captures are 64 KiB stride windows, not five 64 KiB FISP sections. In every capture:

- header `+0x04 = 0x750`, so FISP content size is `0x750 + 0x10 = 0x760`;
- header `+0x0C = 0x10000`, the chain/alignment stride;
- record starts are section `+0x20`, `+0x180`, `+0x650`;
- record sizes are `0x160`, `0x4D0`, `0x110`;
- record byte `+2` values are `0x00`, `0x50`, `0xF3`;
- the first `0x760` bytes are identical, SHA-256 `e63c2043bdc03e5158a35e90e12d7a7bdbc3b0e484d9ba06b32c23f755cbf231`.

V5.12.4 fixes the FISP parser and deduplicates content rather than the surrounding stride window. The scanner remains available only as a generic renderer-context diagnostic.

## Gate state

For the scoped actor/model preview, `facial_frame_palette_selector` is now recorded as:

- frame member selector: `VERIFIED_R5900_EXECUTION`;
- embedded palette-variant selector: `NOT_APPLICABLE_ONE_LOGICAL_CSM1_CLUT_PER_FIS`;
- static preview state: base family member, no animation clock.

This does not promote skinning, bind transforms, the auxiliary mesh role, or general animation evaluation.
