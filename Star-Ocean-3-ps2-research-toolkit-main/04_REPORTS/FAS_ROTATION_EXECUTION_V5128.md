# FAS Type-0x0135 Rotation Execution — V5.12.8 Pass 6

## Outcome

The complete original SO3 type-`0x0135` quantized-rotation path now executes
over the supplied two-actor FAS corpus. This includes Lib's key search,
positive-root quaternion decompression, between-key interpolation, angle and
sine helpers, original coefficient-table initializer, VU0 macro instructions,
and the three reached embedded VU0 microprogram entries. No host interpolation
or trigonometric function is substituted in the execution path.

Across 13 real FAS clips, the bounded target executed **183,640 original
R5900/VU0-macro instructions** and **6,854 original VU0 microinstruction
pairs** over **255 type-0x0135 tracks and 4,519 raw keys**. All 765 invocations
are fully original: 255 terminal-key samples and 510 between-key samples.
Terminal outputs are byte-identical to an independent float32 decompression
oracle. Interpolated outputs match a sign-invariant shortest-path slerp oracle
within two float32-ULP-sized steps; the observed maximum component error is
`1.1920928955078125e-7`.

This is still a scoped promotion, not full animation playback. The target-node
virtual setter and node-local matrix writer are not yet executed. The matrix
bridge therefore continues to model quaternion-plus-RTA-translation to a
row-major affine node matrix before passing that matrix into the already
verified original VU0 IDOM compositor.

## Original engine path

| item | value |
|---|---:|
| module | `Lib.bin` at `0x003E6880` |
| module SHA-256 | `0ee2c4a76fd7c932ecc6e34ff43812c1b4561bca31bfaa916da04e1242df071d` |
| module file / declared zero fill | `1,184,000 / 21,504` bytes |
| evaluator | `0x004AD7D0..0x004ADBCB` |
| evaluator SHA-256 | `b60fa21c082430fdc022ce438fb8729d5fc09eb50635df49c1dfd1d14322cdd4` |
| interpolator | `0x004CD310` |
| angle helper | `0x004CCF80` |
| sine helper | `0x004CD230` |
| math-table initializer | `0x00507610` |
| initialized table | `0x0050CBC0`, 120 bytes |
| initialized table SHA-256 | `7a6c18f853e14ff02e503fb5c55b5ad59550172e7a2923b9928468b97c176ade` |
| embedded VU0 entries | `0x13D` (6 pairs), `0x143` (12), `0x14F` (5) |

The VU0 program was not missing. Lib contains two MPG uploads covering 453
instruction slots. Reconstructing those uploads exposes each `VCALLMS` target
used by the sine helper. The bounded runner executes the original upper FMAC
instructions, LOI immediates with the correct commit order, and E-bit delay
termination. An unexpected lower instruction fails closed.

The runtime track layout is:

| offset | field |
|---:|---|
| `+0x04` | pointer to raw 8-byte key array |
| `+0x10` | terminal/cache state flag |
| `+0x18` | signed 16-bit key count |
| `+0x1C` | current bracket index |
| `+0x1E` | cached bracket index |
| `+0x24` | cached current-key pointer |
| `+0x28` | cached next-key pointer |

Each raw key is `{s16 x, s16 y, s16 z, u16 time}` at stride 8.

## Real-corpus execution

| actor | clips | tracks | raw keys |
|---|---:|---:|---:|
| `0x08FF` | 6 | 119 | 1,971 |
| `0x0BC0` | 7 | 136 | 2,548 |
| **total** | **13** | **255** | **4,519** |

| execution measure | result |
|---|---:|
| evaluator invocations | 765 |
| fully original terminal samples | 255 |
| fully original between-key samples | 510 |
| interpolator / angle-helper calls | 510 / 510 |
| sine-helper calls | 298 |
| embedded VU0 microprogram calls | 894 |
| embedded VU0 microinstruction pairs | 6,854 |
| original R5900/VU0-macro instructions | 183,640 |
| host interpolation or math calls | 0 |

The original `0x00507610` initializer executes 111 guest instructions for
each isolated fixture and materializes the helper coefficients in Lib's
declared zero-fill region before evaluation.

## Fail-closed controls

- Changing the final `Bip01 L Calf` x component by one quantization unit
  changes the original-only output while remaining byte-exact to the oracle.
- A duplicate/non-increasing key time is rejected before execution.
- Replacing the evaluator entry with unsupported opcode `0x1D` raises a hard
  failure at `0x004AD7D0`.
- Replacing VU0 lower word `0x13E` with `0xDEADBEEF` raises a hard failure.
- A null key pointer executes the original 18-instruction zero-output path.

## Matrix bridge

Two real sine-path witnesses were selected: `Bip01 R Foot` for actor `0x08FF`
and `Bip01 L Hand` for actor `0x0BC0`, each evaluated at terminal and
between-key times across both IDOM palettes.

- 8 combined actor/IDOM paths;
- 4 terminal and 4 between-key paths;
- 1,696 original rotation-path guest instructions;
- 12 rotation-helper VU0 microprogram calls / 92 microinstruction pairs;
- 288 original IDOM-compositor VU0 microinstruction pairs;
- zero host model calls inside the rotation evaluator;
- every compositor result byte-identical to the independent float32 expression
  `transpose(root * node * IDOM)`.

The quaternion-plus-RTA-translation node matrix remains deliberately modeled.
This proves compatibility between the original rotation result and original
IDOM compositor, but it does not promote the runtime node setter or matrix
writer.

## Gates

- `fas_type_0x0135_record_layout`: **PASS — REAL BYTES**.
- `fas_key_selection_clock`: **PASS — ORIGINAL R5900 EXECUTION**.
- `fas_quantized_rotation_decompression`: **PASS — ORIGINAL R5900/VU0 MACRO EXECUTION**.
- `fas_positive_w_reconstruction`: **PASS — ORIGINAL EXECUTION**.
- `lib_math_table_initialization`: **PASS — ORIGINAL R5900 EXECUTION**.
- `fas_interpolation`: **PASS — ORIGINAL R5900/VU0 MACRO/MICRO EXECUTION**.
- `fas_to_runtime_node_setter`: **STATIC CALLSITE ONLY**.
- `runtime_node_matrix_write`: **WITHHELD — UNRESOLVED**.
- `final_skinning`: **WITHHELD — UNRESOLVED**.

The next exact target is the type-`0x0135` target-node virtual setter and the
node-local matrix write feeding `node+0x90`. That continuation requires
**Max** reasoning.

Machine reports:

- `SO3_FAS_ROTATION_R5900_EXECUTION_REPORT.json`
- `SO3_FAS_ROTATION_TO_VU0_MATRIX_BRIDGE_REPORT.json`
