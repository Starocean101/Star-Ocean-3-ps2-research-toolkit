# SO3 V5.12.8 Pass 6.3 — Original VU1 Packet-Matrix Binding

> **Pass 6.4 correction:** The Field response is no longer missing. Field
> `0x002510E0` is a resource install/copy handler, RTA is a relocation/name
> binder, and FSS descriptors supply bind transforms. Original FSS loading and
> two bounded actor-scoped packet-pose witnesses now pass. The withheld gates
> and next tasks below describe only this historical Pass 6.3 checkpoint; see
> `FSS_RTA_POSE_EXECUTION_V5128_PASS64.md` for the current boundary.

## Outcome

The FIXED packet-local matrix-selection gate is resolved for the two packaged
actors. Original Lib MPG payloads reconstruct the VU1 program at instruction
indices `0x0DC..0x316`. The bounded target executes its one-vertex terminal
path and proves that the signed word stored in each FIXED position's `w`
component is the direct VU1 qword address of a four-qword matrix.

This is a scoped promotion, not a visual repair. The release HTML remains
unchanged because the original RTA translation loader is still unavailable and
the ordered end-to-end pose gate has not passed.

## Original-byte consumer

- Lib load address: `0x003E6880`.
- Program descriptor: `0x004EF8A0..0x004EF8D4`, SHA-256
  `a78e03db317eee50cd76cc9a448e62e9bcf0733179f5ea241ddfa3d49c85059f`.
- Three MPG commands load 256 pairs at `0x0DC`, 256 at `0x1DC`, and 59 at
  `0x2DC`. The continuous occupied-program SHA-256 is
  `5130acc4ff113c06ead13bcdb998bf9df6e16bd3594c650ab14f5a3bc996f381`.
- Consumer slice `0x298..0x2BB` SHA-256:
  `b8d05973803682bc517c5dd525d1bec27f87633bba57dca69bc8528959f55341`.
- `0x299` executes `ILW.w` from position qword `+3`.
- `0x2A1..0x2A4` execute four consecutive `LQ.xyzw` operations from the
  resulting integer address.
- `0x2A5..0x2AB` execute the original VU1 FMAC path: columns 0–2 transform
  the normal, and columns 0–3 transform the position.

The bounded target implements only opcodes reached on this terminal path and
throws on any unknown word. Its operation-field semantics are pinned to
PS2Recomp commit `ee149581aac999ab22791b3900377c0b028a5840`; no PS2Recomp game
bytes or outputs substitute for the packaged SO3 evidence.

## Corpus binding

Each FPS block is paired only with its forward chain-adjacent IDOM block. In
every segment, the set of real FIXED vertex addresses is exactly
`0x290 + 4 × palette_slot`, covering every slot once or more:

| Actor | FPS | Adjacent IDOM | Packets | Vertices | Slots | Address range |
|---|---:|---:|---:|---:|---:|---:|
| `0x08FF` | `0x00000000` | `0x000185D0` | 83 | 1,844 | 32 | `0x290..0x30C` |
| `0x08FF` | `0x0001BF30` | `0x0001E110` | 16 | 344 | 19 | `0x290..0x2D8` |
| `0x0BC0` | `0x00000020` | `0x00016ED0` | 90 | 2,032 | 22 | `0x290..0x2E4` |
| `0x0BC0` | `0x0001AB10` | `0x0001D9A0` | 23 | 492 | 22 | `0x290..0x2E4` |

Totals: 212 packets, 4,712 FIXED vertices, and 95 IDOM palette slots. The
already-executed original uploader writes each chain-sized palette to VU1
qword `0x290` at four qwords per IDOM slot. Therefore the direct address
consumer closes packet address → IDOM palette slot without guessing an
ordinal.

## Execution and mutations

One nondegenerate real vertex from each segment executes through 25 original
instruction pairs, including seven original FMAC pairs. For each segment:

1. The real vertex address selects diagnostic matrix A and matches an
   independent float32 affine oracle bit-for-bit.
2. Changing only the vertex `w` address selects diagnostic matrix B and changes
   the result to the matrix-B oracle.
3. Keeping the vertex address fixed while changing only an unselected palette
   matrix leaves both outputs bit-identical.

There are 12 controlled executions in total. All original-path, memory-load,
oracle, store, and mutation checks pass. Full traces and hashes are in
`SO3_VU1_PACKET_SKINNING_EXECUTION_REPORT.json`.

## Gate split

- FIXED address → IDOM palette slot: **PASS**, executed original VU1 plus
  byte-exact full-corpus coverage.
- Packet matrix selection: **PASS**, executed original VU1 microcode.
- Controlled packet vertex transform: **PASS**, executed original VU1 FMAC.
- Matrix → RTA for actor `0x08FF`: **PASS**, all 51 IDOM rows have exact RTA
  name identity.
- Matrix → RTA for actor `0x0BC0`: **PARTIAL**, 40/44 rows have exact RTA name
  identity; the remaining four retain exact named FSS identity with no
  fabricated RTA ordinal.
- Original RTA translation loader: **WITHHELD**, exact Field overlay absent.
- Bounded animated end-to-end pose: **WITHHELD** by translation-loader gate.
- Browser mesh deformation: **WITHHELD** by ordered end-to-end gate.

The execution begins after VIF UNPACK. It uses real decoded position, normal,
and address values with controlled diagnostic matrix values. It proves the
one-matrix FIXED consumer path, not blended weights, every renderer path, or a
finished animated preview.

## Next tasks and reasoning

- Export the bounded Field allocation 1070 response on iPhone: **Light**.
- Audit the returned response and execute ATRC handler `0x002510E0` through
  translation setter `0x003EEE70`: **Max**.
- Execute one rotation → translation → node/world matrix → IDOM palette → VU1
  packet-vertex witness after the translation gate passes: **Max**.
- Integrate browser deformation only after that witness: **High**.
- Run actor `0x08FF` and `0x0BC0` on-device visual regressions: **Medium**.
