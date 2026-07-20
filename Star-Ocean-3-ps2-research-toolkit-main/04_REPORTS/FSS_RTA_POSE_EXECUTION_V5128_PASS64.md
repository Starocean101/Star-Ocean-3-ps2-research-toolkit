# SO3 V5.12.8 Pass 6.4 — Original RTA Binding, FSS Transforms, and Bounded Packet Pose

## Outcome

The documented Max engine task passes for the packaged `0x08FF` and `0x0BC0`
actors. Original R5900 code now relocates and exact-name-binds every supplied
RTA record, loads every serialized type-9 FSS transform into a runtime node,
and carries one real animated channel per actor through the already verified
node, IDOM, palette-packet, and VU1 FIXED-vertex paths.

This pass corrects the previous working hypothesis. RTA record vectors are not
skeleton-local translations. RTA is a relocation and exact-name runtime-object
binding resource. Bind quaternion, translation, and scale come from the FSS
descriptor at `+0x24`, `+0x34`, and `+0x44` respectively.

The browser release remains
`01_RELEASE/so3_resource_explorer_v5_12_8_pass6_2.html`. No browser deformation
is claimed in this pass. No visual repair is claimed.

## Returned Field evidence

The returned `SO3_HYBRID_DATA_RESPONSE_so3_field_engine_v1.zip` was audited
before execution. Its ZIP SHA-256 is
`742ba1b13883f270e86b72d17545403059901576c36ef5daa6492f24e75acefa`.
It contains three unique, traversal-safe members; its ZIP integrity test and
both declared member checksums pass. The response is complete, has no errors,
retains request ID `so3_field_engine_v1`, and supplies decoded hidden
allocation 1070 at MWo3 load address `0x001E2B00`.

The exact `1,449,344`-byte Field payload SHA-256 is
`70d4fa07abf8c7cead5f6cef829ac86dc0d894d12a6cb5214c79b900b1a6a671`.
Handler window `0x002510E0..0x002512D0` has SHA-256
`879abbe9d7ee74b81be3c1592dbb2100a8766106b8f4d3f3dc729bab95839230`.
Its five direct calls target `0x00137D88`, `0x00102880`, `0x00102880`,
`0x00137D88`, and `0x002097F0`; there is no direct call to translation vector
setter `0x003EEE70`. The routine is a resource installation/copy handler, not a
transform loader.

## Corrected original-code paths

- Lib `0x0045B080` relocates the RTA header and record links, iterates `0x20`-
  byte records from raw `+0x40`, looks up each indexed name through exact-name
  search `0x004731C0` and compare routine `0x004D8880`, and writes the existing
  runtime-object pointer to record `+4`. It does not load transform values.
- Serialized FSS runtime type 9 dispatches at `0x004745B8` to branch
  `0x00475A10`, requests runtime factory type 0, and calls descriptor loader
  `0x0046C360` at `0x00475A6C`.
- Loader `0x0046C360` uses base transform vtable `0x00178E20`. Its scalar
  translation, quaternion, and scale slots resolve to `0x003EEEB0`,
  `0x003EEED0`, and `0x003EF010`. The familiar vector overloads
  `0x003EEE70` and `0x003EEF10` occupy different slots.
- The full transform-node constructor installs vtable `0x00178E20`. The
  separate transient factory type-9 vtable is `0x00178940`; it is not the node
  instantiated for serialized FSS type 9.

## Execution totals

| Evidence | `0x08FF` | `0x0BC0` | Total |
|---|---:|---:|---:|
| RTA records bound | 33 | 22 | 55 |
| Serialized type-9 FSS descriptors | 56 | 38 | 94 |
| RTA binder guest instructions | 13,157 | 8,332 | 21,489 |
| Node-constructor guest instructions | — | — | 20,352 |
| FSS-loader guest instructions | — | — | 31,020 |

All 94 FSS loader executions reproduce descriptor translation, quaternion,
and scale at their runtime-node fields. The FSS path uses zero host transform
or matrix substitutions. Mutating only one descriptor translation word reaches
only node translation `+0x20`; exact-name mutations produce an unbound RTA
record; replacing the scalar translation vtable slot with the vector overload
is rejected fail closed.

## Bounded actor-scoped pose witnesses

| Actor | Real FAS channel | FSS translation | IDOM slot / VU1 address | Bind position SHA-256 | Animated position SHA-256 |
|---|---|---|---|---|---|
| `0x08FF` | `ANIM_0x002008FF.fas` / `Bip01 Spine1` | `[18.4631996155, 0.0000033325, -0.0220604502]` | `2` / `0x298` | `63557f406d1b5ebad24a8d37ce76520e65d897fb7d52c573a23dfa19cad888cc` | `b3c73d444faa7b927d9b1d77c4cb667803377a1b2c64e40c99f79fa825baf1bb` |
| `0x0BC0` | `ANIM_0x00200BC0.fas` / `Bip01 L Thigh` | `[-9.2960910797, -8.3155155182, 0.5961539149]` | `20` / `0x2E0` | `db0902260055ef1ea45c8a1a5268f146f5fdb91377a38d1f9f7ec56db0a64f15` | `486e25b092ddbb4978d8a49f20eb324126bfcb7df2fa4600ab042a2143603285` |

Each witness executes original type-`0x0135` FAS evaluation, the concrete
quaternion setter, local/world matrix writer, original VU0 IDOM composition,
the original palette packet constructor, and the original VU1 terminal FIXED
consumer. Bind and animated matrices differ, every VU0 result matches the
independent float32 oracle byte-for-byte, the real vertex selects the exact
IDOM slot, and changing only the original animation result changes the final
position and normal.

The palette constructor and post-UNPACK VU1 consumer both execute original
code. DMA/VIF transfer is joined at the previously verified byte-exact memory
boundary; this is not a claim of cycle-level DMA/VIF emulation.

## Gate split

- Field response integrity and provenance: **PASS**.
- Field `0x002510E0` classification: **PASS**, resource install/copy rather
  than transform loading.
- RTA relocation and exact-name binding: **PASS**, original R5900 over all 55
  records.
- RTA translation interpretation: **REJECTED**; RTA does not load transforms.
- FSS translation, quaternion, and scale loading: **PASS**, original R5900
  scalar setters over all 94 serialized type-9 descriptors.
- Bounded rotation-to-packet-vertex pose: **PASS**, two actor-scoped witnesses.
- DMA/VIF join: **PASS** at a byte-exact verified memory boundary, not
  cycle-level emulation.
- Browser mesh deformation: **WITHHELD**, not integrated.
- On-device visual validation: **WITHHELD**, not run.

The machine-readable trace, per-descriptor executions, hashes, controls, and
full witness outputs are in
`04_REPORTS/SO3_FSS_RTA_POSE_R5900_EXECUTION_REPORT.json`.

## Next tasks and reasoning

- Integrate browser deformation while preserving a separately switchable
  static path: **High**.
- Independently audit that integration against this original-execution report:
  **Max**.
- Run on-device visual regressions for actors `0x08FF` and `0x0BC0`: **Medium**.
- Reinspect documentation or package checksums without changing semantics:
  **Light**.
