# Star Ocean 3 PAL — Final EE SLE Key Transform

## Result

**Strictly validated final 16-byte SLE key:**

```text
66665442b379f0c7e7d51e4b7ba41c7d
```

As four little-endian 32-bit words, corresponding to VU lanes `x,y,z,w`:

```text
0x42546666
0xC7F079B3
0x4B1ED5E7
0x7D1CA47B
```

The EE stores these 16 bytes to key-state address `0x001CC730` in the `JAL 0x0011D970` delay slot at EE VA `0x00100958`.

## Input integrity

`MANIFEST.json` contains 30 entries. Every listed file was checked for existence, exact byte size, and SHA-256; all 30 entries passed. The supplied target block also matched the executable byte-for-byte at the stated mapping:

```text
EE VA 0x00100000 -> executable file offset 0x680
EE VA 0x001008E0–0x0010097F -> file offsets 0xF60–0xFFF
```

## Direct IOP response

Established response after the four IOP-side bitwise complements:

```text
5bb763b082ce018788c8fc4635c53c79
```

Loaded by `LQC2 vf1,0(v0)` as little-endian lanes:

| Lane | Source bytes | Input word |
|---|---|---:|
| `x` | `5b b7 63 b0` | `0xB063B75B` |
| `y` | `82 ce 01 87` | `0x8701CE82` |
| `z` | `88 c8 fc 46` | `0x46FCC888` |
| `w` | `35 c5 3c 79` | `0x793CC535` |

## EE-side control and dataflow

The generic disassembler's branch-bit interpretations at `0x100924` and `0x100940` are incorrect for the R5900. The relevant sequence is:

| EE VA | Raw word | Correct instruction | Effect |
|---:|---:|---|---|
| `0x00100920` | `0x0200102D` | `MOVE v0,s0` | `v0 = sp+0x90`, the 16-byte RPC-response scratch vector. |
| `0x00100924` | `0xD8410000` | `LQC2 vf1,0(v0)` | Loads direct response into `vf1.xyzw`. |
| `0x00100930` | `0x4A000038` | `VCALLMS 0` | Runs VU0 microprogram address `0`. |
| `0x0010093C` | `0x48490001` | `CFC2.I t1,vi0` | Interlocked control read; waits until the VU call completes. |
| `0x00100940` | `0xF8430000` | `SQC2 vf3,0(v0)` | Stores transformed `vf3` over the scratch response. |
| `0x00100950` | `0x7BA20090` | `LQ v0,0x90(sp)` | Reloads the transformed 128-bit value. |
| `0x00100954` | `0x0C04765C` | `JAL 0x0011D970` | Starts the next routine. |
| `0x00100958` | `0x7C22C730` | `SQ v0,-0x38D0(at)` | Delay slot; with `at=0x001D0000`, stores the final key to `0x001CC730`. |

The complete surrounding block is documented in `ANNOTATED_EE_BLOCK.md`.

## VU0 microprogram

A VIF `MPG` packet at EE VA `0x00143B14` has raw word `0x4A0B0000`: 11 microinstructions are uploaded to VU micro address `0`, which is the entry invoked by `VCALLMS 0`.

The program uses `vf1` as input, `vf2` as a multiply temporary, and `vf3` as output. The `LOI` value paired with an `I`-flagged upper instruction becomes scalar `I` for the following microinstruction.

```text
micro 0:  LOI 0x42FECCCD                    | VNOP
micro 1:  LOI 0x42546666                    | MULi.x vf2,vf1,I
micro 2:  LOI 0x43D80D3E                    | ADDi.x vf3,vf2,I
micro 3:  LOI 0xC7F079B3                    | MULi.y vf2,vf1,I
micro 4:  LOI 0x43A0DA10                    | ADDi.y vf3,vf2,I
micro 5:  LOI 0x43A02666                    | MULi.z vf2,vf1,I
micro 6:  LOI 0x43546E14                    | ADDi.z vf3,vf2,I
micro 7:  LOI 0x42F23333                    | MULi.w vf2,vf1,I
micro 8:  LOI 0x3DD3DD98                    | ADDi.w vf3,vf2,I
micro 9:  lower-pipeline NOP                 | VNOP.E
micro 10: lower-pipeline NOP (E delay slot)  | VNOP
```

`0x3DD3DD98` is loaded at micro 8 but is never consumed. The program ends after micro 10. There are no shuffles, conversions, or cross-lane operations.

## Portable transformation pseudocode

```text
input_words = unpack_little_endian_u32x4(direct_iop_response)

output.x = VU_ADD(VU_MUL(input.x, 0x42FECCCD), 0x42546666)
output.y = VU_ADD(VU_MUL(input.y, 0x43D80D3E), 0xC7F079B3)
output.z = VU_ADD(VU_MUL(input.z, 0x43A0DA10), 0x43A02666)
output.w = VU_ADD(VU_MUL(input.w, 0x43546E14), 0x42F23333)

final_key = pack_little_endian_u32x4(output)
```

`VU_MUL` and `VU_ADD` are bit-pattern operations implementing PS2 VU floating-point behavior. Ordinary host IEEE single precision is not bit-exact here. The multiplier's hardware low-bit behavior and the adder's alignment/truncation affect the z-lane result by one least-significant mantissa bit.

## Lane results

| Lane | Input | Multiplier | VU product | Addend | Final word |
|---|---:|---:|---:|---:|---:|
| `x` | `0xB063B75B` | `0x42FECCCD` | `0xB3E2A618` | `0x42546666` | `0x42546666` |
| `y` | `0x8701CE82` | `0x43D80D3E` | `0x8B5B19E9` | `0xC7F079B3` | `0xC7F079B3` |
| `z` | `0x46FCC888` | `0x43A0DA10` | `0x4B1ED4A7` | `0x43A02666` | `0x4B1ED5E7` |
| `w` | `0x793CC535` | `0x43546E14` | `0x7D1CA47B` | `0x42F23333` | `0x7D1CA47B` |

Packed in memory order:

```text
66 66 54 42  b3 79 f0 c7  e7 d5 1e 4b  7b a4 1c 7d
```

## Rejected arithmetic interpretations

Only candidates directly supported by the decoded four-lane arithmetic were tested.

| Interpretation | Candidate | Strict result |
|---|---|---|
| Ordinary IEEE-754 single-precision multiply/add | `66665442b379f0c7e8d51e4b7ba41c7d` | Failed: invalid back-reference, distance `3848`, output position `114`. |
| Naive round-toward-zero after each operation | `65665442b379f0c7e7d51e4b7ba41c7d` | Failed: invalid back-reference, distance `336`, output position `0`. |
| PS2 VU bit-exact multiply/add model | `66665442b379f0c7e7d51e4b7ba41c7d` | Passed all strict requirements. |

No random-key, whole-disc, or 128-bit brute-force search was performed.

## Strict validation proof

Command executed against the supplied validator and sample:

```text
python3 05_TOOLS/validate_candidate_key.py \
  --key 66665442b379f0c7e7d51e4b7ba41c7d
```

Result:

| Required field | Observed value | Pass |
|---|---:|:---:|
| Input magic | `SLE` | Yes |
| Type | `2` | Yes |
| Compressed size | `4227` | Yes |
| Output size | `9008` | Yes |
| Compressed bytes consumed | `4227` | Yes |
| Remaining bytes | `0` | Yes |
| Invalid back-reference | None | Yes |
| Exception | None | Yes |
| Decoder size check | `true` | Yes |

Decoded output begins with ASCII signature `PACK` (`50 41 43 4B`).

Decoded output SHA-256:

```text
1217cee95a95efe32285fd9916f336aefeea0726e4972f23571fbfd568c72105
```

Machine-readable details are in `VALIDATION_RESULT.json`.

## Standalone implementation

`EE_KEY_TRANSFORM.py` accepts one 16-byte hexadecimal input and emits the transformed key:

```text
python3 EE_KEY_TRANSFORM.py 5bb763b082ce018788c8fc4635c53c79
```

Expected output:

```text
66665442b379f0c7e7d51e4b7ba41c7d
```

Use `--verbose` for lane-level JSON and `--self-test` to check the known response/key pair.
