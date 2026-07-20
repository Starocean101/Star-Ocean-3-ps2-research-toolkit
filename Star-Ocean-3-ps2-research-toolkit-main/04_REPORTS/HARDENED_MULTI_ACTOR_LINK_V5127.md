# Hardened Multi-Actor Material Linking — V5.12.7

This pass independently incorporated the useful findings from the external
V5.12.5 PSM-fallback audit. It preserves the authoritative FPS material-table
path and permits the PSM/cardinality fallback only when that path yields no
bindings.

The fallback is all-or-nothing. It rejects stored TBP0 values, unknown slot
PSMs, non-exact or mixed-PSM FISA groups, unresolved members, texture
multi-membership, cross-segment matching, ambiguous PSM classes, and incomplete
UV-slot coverage. Successful results remain `STRONG_INFERENCE`; ordered
slot-to-family pairing is not labeled runtime verification.

Actor `0x08FF` resolves four UV slots: slots 0 and 1 share static PSMT8 texture
2816, slot 2 uses the six-member 2821 family, and slot 3 uses the eight-member
2817 family. Its segment-1 no-UV PSM0/ALPHA44 layers remain auxiliary
candidates hidden by default, with a diagnostic toggle. Their runtime role is
not promoted.

The shared-texture UI now updates every binding associated with a selected
texture, preventing a tap on texture 2816 from updating only the first body
slot. Assembly exports also include the exact decoded CHAR bytes.

The real actor `0x0BC0` fixture exercises the authoritative FPS path. Its three
bindings remain unchanged and its material result contains no
`binding_inference` field. Matrix-to-RTA mapping, skinning, auxiliary-mesh role,
and animation rotation evaluation remain unresolved.
