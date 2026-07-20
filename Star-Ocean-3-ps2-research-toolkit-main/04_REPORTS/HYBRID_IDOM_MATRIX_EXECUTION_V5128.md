# Hybrid IDOM, FSS, and VU0 Matrix Execution — V5.12.8 Pass 3

## Outcome

The returned browser corpus is sufficient for this stage. No additional ISO
extraction is required: the two CHAR files contain the FSS runtime-resource
directories and all four IDOM palettes, while Lib contains both the original
EE evaluator and its complete VU0 microprogram.

The verified chain is now:

1. Lib `0x004ABF60` loads a real IDOM section, expands each stored 3x4 matrix
   into a 64-byte affine matrix, and allocates its double buffer.
2. Lib `0x00478860..0x00478A1C` treats every IDOM value as a runtime-resource
   descriptor index and resolves the descriptor's node-object pointer.
3. The CHAR FSS directory gives that descriptor a fixed CP932 name. Matching
   the exact raw 16-byte name field against the RTA name table provides the
   actor-scoped matrix-to-RTA identity bridge.
4. The evaluator at `0x004ABA30` loads the node, IDOM, and root matrices into
   VU0 registers and executes `VCALLMS 0x113`.
5. Lib `0x004A53F8..0x004A5474` emits the IDOM-sized DMA/VIF upload to VU1
   qword `0x290`.

The loader and binder execute 11,704 R5900 guest instructions over the four
real IDOM sections. The new VU0 witness performs 190 invocations—identity and
nontrivial affine controls for every one of 95 real IDOM matrices—and executes
6,840 original microinstruction pairs. Every output is byte-identical to the
independent Float32 expression `transpose(root * node * IDOM)`.

## FSS and matrix identity

The FSS descriptor stream starts at `FSS+0x4C`. Each descriptor advances by
its own u16 byte length; the name field offset is stored at descriptor `+2`
and is `0x8C` in these actors. IDOM indices point directly to these descriptor
ordinals.

| actor | FSS offset | descriptors | RTA names with unique exact FSS match | IDOM rows with exact RTA identity |
|---|---:|---:|---:|---:|
| `0x08FF` | `0x1EE90` | 61 | 33/33 | 51/51 |
| `0x0BC0` | `0x1ED40` | 45 | 22/22 | 40/44 |

For `0x08FF`, every IDOM slot in both palettes has a unique, byte-exact RTA
name identity, so `matrix_to_rta` is promoted for that actor. For `0x0BC0`,
each 22-slot IDOM palette selects 20 RTA-named descriptors plus FSS nodes
`Bip01 L Thigh` and `Bip01 R Thigh`; RTA names `Root` and `Bip01` are not in
those palettes. Those two rows remain named FSS nodes and are not assigned
fabricated RTA ordinals. The aggregate gate therefore remains partial.

## Real IDOM inventory

| actor | CHAR offset | count | exact RTA rows | runtime 4x4 SHA-256 |
|---|---:|---:|---:|---|
| `0x08FF` | `0x185D0` | 32 | 32/32 | `85826b16d28644c0c57a9d2e410e4e2ed812d950514d189476781bc7a1ab8ce2` |
| `0x08FF` | `0x1E110` | 19 | 19/19 | `6c7819698c054b116a6aee01f048dfd1ce06fb2d21be4cddd64f677e1986db22` |
| `0x0BC0` | `0x16ED0` | 22 | 20/22 | `24c811deea0a21cfc8cc548a32ea895da20279ba6deb7751628c757d2e46cfe7` |
| `0x0BC0` | `0x1D9A0` | 22 | 20/22 | `22213dc653d2e2218df620f390b099440bf1c114a1653282d5113e78cedb7b5a` |

All four low IDOM flag bytes are `1`, so the original loader allocates the
double-buffered output consumed by the evaluator and uploader.

## Original VU0 execution

Lib stores the relevant microprogram in two VIF MPG uploads:

| command VA | word | destination | instruction count |
|---:|---:|---:|---:|
| `0x004E9FA4` | `0x4A000000` | `0x000` | 256 |
| `0x004EA7AC` | `0x4AC50100` | `0x100` | 197 |

The 453 occupied instructions hash to
`4d29c8b2820d8631ee4f091bbbe69f4d69c0f99625b23b71a92e5c2c08c4f92f`.
The call word at `0x004ABBB0` is `0x4A0044F8`, which targets instruction
`0x113` (byte address `0x0898`). One invocation executes 36 instruction pairs:
`0x113..0x12A`, then the branch target `0x03E..0x049`. The E bit is at `0x048`
and `0x049` is its required delay slot.

The executed arithmetic first composes the node matrix with the IDOM matrix,
then composes the affine root matrix, and finally transposes the four rows for
the downstream matrix buffer. The interpreter fails closed on any opcode not
present on this exact path.

## Corrected upload evidence

The active manager count comes from `IDOM+0x14`, not the ATRC/RTA header.

| IDOM count | VIF word | UNPACK qwords | DMA QWC | buffer-1 source delta |
|---:|---:|---:|---:|---:|
| 32 | `0x6C800290` | 128 | 128 | `0x800` |
| 19 | `0x6C4C0290` | 76 | 76 | `0x4C0` |
| 22 | `0x6C580290` | 88 | 88 | `0x580` |

## Gates and remaining boundary

- `idom_resource_layout`: **PASS — EXECUTION VERIFIED**.
- `idom_to_named_fss_node`: **PASS — BYTE-EXACT**.
- `matrix_to_rta / 0x08FF`: **PASS — ACTOR-SCOPED**.
- `matrix_to_rta / 0x0BC0`: **PARTIAL — 40/44 rows**.
- `vu0_matrix_composition`: **PASS — EXECUTION VERIFIED**.
- `matrix_palette_dma_vif_shape`: **PASS — EXECUTION VERIFIED**.
- `animation_rotation_evaluator`: **WITHHELD — UNRESOLVED**.
- `final_skinning`: **WITHHELD — UNRESOLVED**.

The controlled VU0 witness proves the original composition routine, but it
does not claim that the still-unresolved FAS rotation/interpolation evaluator
produced the controlled node matrices. The next target is therefore the
original routine that updates each node object's matrix at `object+0x90` from
FAS data, followed by one end-to-end animated-pose execution. That task
requires **Max** reasoning.

Machine reports:

- `SO3_IDOM_LOADER_R5900_EXECUTION_REPORT.json`
- `SO3_FSS_IDOM_RTA_NAME_BRIDGE_REPORT.json`
- `SO3_VU0_IDOM_MATRIX_MICRO_EXECUTION_REPORT.json`
- `SO3_MATRIX_PALETTE_R5900_EXECUTION_REPORT.json`
