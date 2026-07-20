# V5.11.1 direct-ISO model hotfix

## Defect reproduced

The V5.11.0 Model Lab displayed canonical actor cards but could only assemble
bytes already exposed as readable Workspace providers or manually uploaded
files. Searching `Char` in the Workspace could therefore return zero rows even
though the Atlas actor index contained exact `CHAR`, `ATRC`, and `ANIM` child
ranges. Later legacy/runtime UI modules could also overwrite the visible title
with V5.8.1.

## Repair

V5.11.1 makes the Atlas actor index executable against the already-open ISO.
For the selected actor it:

1. resolves the indexed hidden-table entry, child offset, and stored size;
2. bounds every child range inside its hidden allocation;
3. reads only that range from the browser `File` object;
4. strictly decodes `SLZ`/`SLE` through the preserved V4.4 decoder;
5. requires `CHAR` to decode as geometry, `ATRC` as `RTA`, and `ANIM` as
   `FAS`/`HFAS`;
6. enforces the Atlas decoded-size value when one is declared; and
7. sends the validated components to the evidence-gated V5.11 assembler.

The primary control is **Load and assemble selected actor from open ISO**.
Workspace expansion is no longer a prerequisite. Manual upload and loaded-node
assembly remain fallback paths.

The current-brand callback is honored by all later legacy and runtime modules,
preventing them from reverting the header after V5.11.1 loads.

## Regression proof

`03_TESTS/test_v511_direct_iso_model.js` simulates the browser ISO bridge for
actor `0x0BC0` and verifies all nine exact reads: one geometry child, one RTA
child, and seven FAS children. The decoded fixture assembly reproduces:

- 2 segments and 113 packets;
- 2,524 vertices and 1,476 triangles;
- 8 FIS textures and 15 palette variants;
- 2 exact FISA groups containing 7 textures;
- 22 RTA records; and
- 7 animation clips.

The existing unresolved matrix-to-RTA, material-to-FIS, and animation-evaluator
gates remain withheld. This regression proves the indexed browser read and
assembly logic; interaction with the user's ISO remains a target-iPhone field
test.
