# SO3 V5.12.8 Pass 6.2 — Original FAS-to-Node Matrix Execution

> **Pass 6.4 correction:** This historical pass used RTA vectors only as
> controlled exact-name translation inputs while their semantics were unknown.
> Original RTA `0x0045B080` is now proven to relocate and bind runtime objects,
> not load transforms. Actual bind transforms come from FSS descriptors through
> `0x0046C360`. See `FSS_RTA_POSE_EXECUTION_V5128_PASS64.md`.

## Outcome

The original FAS evaluator is now connected through the original concrete target-node setter and the original local/world matrix writer. The parent branch is also executed with a controlled two-node hierarchy. The scoped node-matrix gate is promoted for actors `0x08FF` and `0x0BC0`; visible mesh skinning remains withheld.

## Executed data flow

1. Dispatcher `0x004BD768` recognizes FAS type `0x0135` and calls evaluator `0x004AD7D0`.
2. Dispatcher site `0x004BD7B8` reads virtual slot `+0x34`.
3. Constructor `0x004DAD00` installs vtable `0x00178E20`.
4. SLES vtable slot `+0x34` resolves to quaternion setter `0x003EEF10`, which copies the evaluator qword to node `+0x30` and marks node `+0x50` dirty.
5. Vtable slot `+0x60` resolves to writer `0x004DA820`. It consumes translation `+0x20`, quaternion `+0x30`, scale `+0x40`, and basis `+0x110`.
6. VU0 entry `0x0E5` constructs the SO3-convention transform. The no-parent path writes matrices at node `+0x90` and `+0xD0`.
7. With a parent present, call site `0x004DA850` dispatches indirectly through the parent's `+0x60` slot. VU0 entry `0x15D` composes `parent × child`.

## Real evidence totals

- Two actors, 13 FAS clips, 255 type-`0x0135` tracks.
- 189 exact FAS-name/RTA-name track matches; 66 unmatched tracks are withheld.
- 378 terminal/midpoint FAS-to-node executions.
- 74,681 original FAS evaluator guest instructions and 2,392 evaluator VU0 microinstruction pairs.
- 117,936 original node constructor/setter/writer guest instructions and 18,900 node VU0 pairs.
- Zero host matrix substitutions on the engine path.
- All 378 world matrices are raw byte-exact against an independent float32 oracle.
- Local matrices differ from that oracle in 93 samples only by IEEE-754 `+0.0` versus `-0.0`; raw hashes preserve those bits, and every nonzero bit remains exact.

## Controlled hierarchy witness

The two-node control executes 642 guest instructions and 115 VU0 pairs. It observes one bounded indirect parent-writer call and three writer microprogram calls: `0x0E5`, `0x0E5`, and `0x15D`. Parent local/world output and composed child output match independent float32 oracles modulo only the sign of zero.

## Gate split

- `fas_rotation_evaluator`: PASS.
- `fas_to_runtime_node_rotation_setter`: PASS.
- `runtime_node_local_matrix_write_no_parent`: PASS.
- `runtime_node_world_matrix_write_no_parent`: PASS.
- `hierarchical_parent_matrix_composition`: PASS for the controlled two-node input.
- `rta_translation_loader_to_runtime_node`: WITHHELD. RTA translations are controlled exact-name inputs in this pass.
- `final_mesh_skinning`: WITHHELD. The FIXED/XBDC matrix-to-packet binding remains unresolved.

The static browser preview therefore remains unposed. Turning the node-matrix gate green does not claim that packet vertices are already skinned.

## Reasoning levels

- Static/execution audit: **max**.
- Browser integration after matrix-to-packet verification: **high**.
- On-device regression: **medium**.
