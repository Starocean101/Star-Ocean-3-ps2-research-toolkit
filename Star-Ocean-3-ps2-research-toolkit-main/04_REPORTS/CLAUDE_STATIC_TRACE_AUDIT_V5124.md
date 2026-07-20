# Independent Audit of Claude Static Trace — V5.12.4

Model level: **Max**. Source module: `Lib.bin`, load `0x003E6880`, SHA-256
`0ee2c4a76fd7c932ecc6e34ff43812c1b4561bca31bfaa916da04e1242df071d`.

## Verdict

Claude found several real instructions and a useful initialization link, but
the central semantic conclusion is wrong. The table consumed by `0x004A39A0`
is the actor FPS `naka` dynamic-record table, not a FAS event table. The word
loaded from record `+8` is the material-slot ordinal (`1` or `2`), not texture
ID `1294` or `2413`. Consequently `0x004D7E00` binds/initializes a runtime FISA
node by slot ordinal; it is not the per-frame FISA member selector.

The two original Claude artifacts are preserved byte-for-byte under
`07_EXTERNAL_EVIDENCE/CLAUDE_STATIC_TRACE_V5122_PASS2/` and are not promoted
unchanged.

## What reproduces exactly

- `0x004A3A9C`: `lw $v0,8($s4)`.
- `0x004A3AA0`: `jal 0x004D7E00`.
- Delay slot `0x004A3AA4`: `sw $v0,56($s1)`.
- `0x004D7E70–0x004D7E78`: runtime-node u16 `+6` is compared with object u32
  `+56`.
- `0x004D7CB0` scans for `FISA`, resolves its pointer array, and is reached
  recursively from four internal call sites.
- `0x00454FB0–0x00455050` scans for `FIS\0`, fills at most eight sequential
  body-pointer slots at object `+164 + index*4`, and increments object `+124`.
- Direct `jal` xrefs are: `0x4A3AA0 → 0x4D7E00`; four internal calls to
  `0x4D7CB0`; and two callers of `0x4A39A0` at `0x474D8C` and `0x475284`.

## Decisive field-semantic correction

The caller computes the table exactly as follows on the actor fixture:

1. Segment 0 begins at file `0x20`; the aligned section body is `s2 = 0x30`.
2. `lw 72($s2)` reads file `0x78`, whose u32 value is relative offset
   `0xDD04`.
3. `s5 = s2 + 0xDD04 = 0xDD34`; its count is `2`.
4. `s4 = s5 + 4 = 0xDD38`; the loop advances `s4` by `0x10` per record at
   `0x4A3B08`.

The actual records are:

| file offset | `+0` tag | `+4` base texture ID | `+8` slot ordinal | `+12` frame last index |
|---|---:|---:|---:|---:|
| `0xDD38` | `naka` | 1294 | **1** | 2 |
| `0xDD48` | `naka` | 2413 | **2** | 3 |

Therefore the decisive `lw 8($s4)` writes **1/2** to object `+56`. It does not
write 1294/2413. The following `lw 12($s4)` writes the record's final-index
field to object `+60`. This is strong evidence for FPS material-slot/FISA-node
initialization, not for a FAS-event-ID-to-frame-member path.

## Parser initialization versus frame selection

`0x004D7E00` walks a linked runtime-node structure and compares each node's
u16 ID at `+6` with the requested slot ordinal at object `+56`. On a match it
invokes `0x004D7CB0` to parse/resolve the associated FISA section. That prepares
the selector object.

The actual per-frame member choice is the separate leaf at
`0x004D7BB0–0x004D7CAF`. V5.12.4 executes those exact Lib instructions over
both fixture FISA families. That leaf reads the animation counter from object
`+72`, indexes the FISA duration/pointer arrays, and writes the selected member
pointer to runtime node `+40`. Its 256-byte code hash is
`7dabf8190c0080ccaa0d630fbaddc950e9f0200949a8ec6acd177125fb604cff`.

Claude's trace therefore complements the execution proof by explaining how
the FPS records initialize selector objects, but it does not replace or extend
the executed frame-selection proof.

## FIS and palette corrections

- `0x00454E00` is not the FIS magic-scanner entry. It is another function that
  later reads cached pointers. The leaf FIS chain scanner/cache begins at
  `0x00454FB0`.
- The FIS cache is filled sequentially and is separate from the demonstrated
  `0x4D7E00` path; the submitted artifacts do not prove the asserted complete
  end-to-end arrow from one selected FISA node to a TEX0 write.
- There is no remaining embedded facial “palette bank” selector to find.
  V5.12.4 independently proves that each observed PSMT4 facial FIS uploads a
  16×2 PSMCT32 image for one CSM1 IDTEX4 8×2 logical CLUT. Stored entries
  `8–15` and `24–31` are padding for this use, not alternative palettes.
- Runtime `TBP0/CBP` address/cache patching remains interesting engine work,
  but it is not required to repair the Explorer's face and must not reopen the
  resolved static-preview gate.

## Classification

- **Accepted:** raw instruction words, call to `0x4D7E00`, object `+56` store,
  runtime-node `+6` comparison, FISA parser, and sequential FIS cache.
- **Corrected:** source is FPS dynamic records; record `+8` is slot ordinal;
  `0x4D7E00` is initialization/resolution, not frame-member selection.
- **Rejected:** “FAS event record+8 contains 1294/2413,” the claimed complete
  FAS-event-to-FIS-cache chain, and a still-missing embedded palette bank.
- **Still valid V5.12.4 boundary:** automatic FAS animation-clock playback is
  not implemented in the static Model Lab.
