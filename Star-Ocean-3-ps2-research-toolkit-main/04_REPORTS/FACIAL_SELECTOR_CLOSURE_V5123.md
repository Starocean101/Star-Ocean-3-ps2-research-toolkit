# Facial Selector Closure — V5.12.3 Pass V3 (SUPERSEDED)

> Superseded by V5.12.4. The controlled FISP-to-TEX0-high-byte execution below
> is a generic renderer-path result and does not establish a FISP-to-facial
> association. Actor `0x0BC0` has one logical CSM1 IDTEX4 CLUT per facial FIS;
> see `FACIAL_CLUT_REPAIR_V5124.md`.

Actor `0x0BC0`. Gate: `facial_frame_palette_selector`. Model level: **Max**.

## Outcome

The runtime mechanism is now closed at instruction level:

- **VERIFIED:** FAS type `0x0021` `naka` events bind to the matching facial selector object.
- **VERIFIED:** the event evaluator writes the rounded frame counter to selector `+0x48`.
- **VERIFIED:** the real Lib routine at `0x004D7BB0` selects the exact FISA member and writes its FIS pointer to runtime node `+0x28`.
- **VERIFIED:** that selected FIS pointer feeds both texture and palette lookup/upload.
- **VERIFIED:** for PSMT4, the selected FISP profile record's byte `+2` is shifted into GS TEX0 bits `56..63`; its low five bits supply `CSA`, while its upper three bits overlap `CLD`.
- **VERIFIED under controlled FISP input:** two executions differing only at FISP record byte `+2` produce `CSA=0` and `CSA=1` while preserving the same `TBP0`, `CBP`, PSM, and dimensions.

The actor-specific gate remains **UNRESOLVED — not promoted** because the supplied ISO extraction contains no FISP resource bytes and therefore does not establish which FISP profile actor `0x0BC0` uses live. V5.12.3 adds a native, browser-only extraction action for precisely that final record. Automatic face/palette selection remains disabled.

## 1. FAS event to selector counter

The Lib binder at `0x004BF390..0x004BF7B8` handles event types `0x21..0x24`. For type `0x21`, it:

1. reads the event payload as `u32 tag + u32 id`;
2. enumerates selector objects whose class byte at `+0x40` is `1`;
3. calls `0x004D5D80` with selector `+0x38` (material-slot ordinal);
4. compares the returned tag/base id with the event's `naka`/id pair; and
5. stores the matched selector pointer in command record `+0x0C`.

The type-`0x21` evaluator at `0x004B5500` calls its controller, rounds the returned float with the sign-correct `±0.5` path, converts it to an integer, and stores that integer at bound selector `+0x48` at `0x004B5570`.

This closes the data path for the fixture events carrying base ids `1294` and `2413`. The earlier `cmc.bin` family-id immediates are menu/portrait draw-call arguments and are not part of this selector path.

## 2. FISA member selection — actual R5900 execution

Routine `0x004D7BB0..0x004D7CAF` reads:

- selector counter at `+0x48`;
- runtime node at `+0x4C`;
- resolved FISA member-pointer array at `+0x50`; and
- FISA payload at `+0x54`.

It applies the FISA mode and duration pairs, chooses one resolved member, and writes the selected FIS pointer to runtime node `+0x28` at `0x004D7CA0`.

The supplied Lib bytes were mapped at `0x003E6880`; the actual routine was executed with the actor fixture and no external stubs. Full mode-1 cycles produced:

- family `1294`: `1294, 1295, 1296, 1296, 1295, 1294, 1294`;
- family `2413`: `2413, 2414, 2415, 3362, 3362, 2415, 2414, 2413, 2413`.

Each selected pointer resolves to the exact expected fixture FIS offset. The executed 256-byte routine has SHA-256 `7dabf8190c0080ccaa0d630fbaddc950e9f0200949a8ec6acd177125fb604cff`.

## 3. Selected FIS to texture and palette upload

At `0x004685B0`, Lib loads runtime node `+0x28`. The executed slice presents that exact selected FIS pointer as argument `$a1` to `0x004A6C90`.

For fixture FIS `2413`:

- section offset: `0x14480`;
- PSM: `0x14` (`PSMT4`);
- dimensions: `64×64`;
- palette entries: `32` (two 16-color banks).

The actual branch at `0x004686A8` observes the nonzero palette count and reaches the palette lookup/upload call at `0x004686C8` (`jal 0x004A6E10`) with the same selected FIS pointer.

The qwords cached at model `+0x630` and `+0x638` are transfer `BITBLTBUF` templates whose 14-bit DBP fields are patched from upload-allocation results. They are not themselves final TEX0 registers. The final TEX0 packet merges the texture-manager entries at `+0x1010` and `+0x2220`.

## 4. FISP is the palette-bank selector

The FISP resolver at `0x0046AD90` walks sections by the u32 size at `+0x0C`. Its payload layout is:

```text
section+0x10  u32 profile_count
section+0x14  u32 profile_offset[profile_count]
record        payload_base + profile_offset[index]
```

The resolver stores the selected record pointer at model `+0x618` (`0x0046AE44`). Both PSMT4 packet-building paths (`0x00468430` and `0x00468798`) then perform the same operation. In the latter:

```text
0x0046879C  lw      t1, 0x618(s0)
0x004687BC  lbu     t1, 2(t1)
0x004687C8  dsll32  t0, t1, 0x18   # byte << 56
0x004687CC  or      a3, a3, t0
0x004687D4  sd      a0, 0x40(a1)
```

GS TEX0 `CSA` occupies bits `56..60` and `CLD` occupies bits `61..63`. Therefore the low five bits of `selected_FISP_record[2]` are the PSMT4 palette-bank/CLUT-entry selector; the byte's upper three bits would also set `CLD`. The controlled records below have zero upper bits. The FISP byte is separate from the FISA duration pairs, which remain uniformly `1` in this fixture.

## 5. Two-bank execution

The actual Lib FISP-selection and TEX0 packet-building instructions were executed twice with minimal controlled FISP sections. The records were identical except for byte `+2`:

| FISP record `+2` | Output TEX0 | TBP0 | CBP | CSA | CLD |
|---:|---:|---:|---:|---:|---:|
| `0` | `0x0000340599404120` | `0x120` | `0x1A0` | `0` | `0` |
| `1` | `0x0100340599404120` | `0x120` | `0x1A0` | `1` | `0` |

The outputs differ by exactly `1 << 56`. Runtime allocation addresses `TBP0=0x120` and `CBP=0x1A0` are controlled inputs because no live GS/VRAM allocator snapshot was supplied. This execution verifies the transformation and field preservation; it does not claim those controlled addresses were observed in-game.

## 6. Final missing evidence and V5.12.3 browser path

The smallest remaining evidence is one live FISP section/profile association for actor `0x0BC0`. V5.12.3 adds the declarative Command Runner action:

```json
{"action":"extract_fisp_palette_evidence","scope":"all","alignment":4,"max_allocation_mb":64,"max_section_mb":4,"max_matches":128}
```

It decodes bounded hidden-wrapper allocations locally, validates FISP count/offset tables, records every profile's raw byte `+2` plus decoded `CSA` low-five and `CLD` high-three fields, and exports `SO3_FISP_PALETTE_EVIDENCE.zip` with the raw sections, JSON, TSV, manifest, and SHA-256 sums. Both compressed allocation size and declared decoded-block size are capped before decompression. It is browser-only, read-only, mobile-safe, and compatible with static hosting.

## Evidence boundary

- Lib module SHA-256: `0ee2c4a76fd7c932ecc6e34ff43812c1b4561bca31bfaa916da04e1242df071d`.
- Actor fixture SHA-256: `f4aa0e83f1df38f1a70fc915687b642d87d2d794550e693a6815ec80f5c4945e`.
- Frame execution is fixture-specific and proves the tested two FISA groups.
- CSA execution uses controlled FISP records because no live FISP bytes were supplied.
- No texture was repainted, blurred, cleaned, or heuristically altered.
- No automatic face/palette selection was enabled.
- The promoted full Atlas V1.1.1 baseline is unchanged; the accompanying JSON is additive candidate evidence only.
