# Multi-Actor Material-Link Repair — V5.12.6

## Field failure

Actor `0x08FF` is a complete humanoid bundle with one geometry resource, one
33-node RTA resource, and six FAS clips. V5.12.5 decoded 2,188 vertices, 1,292
triangles, 15 embedded FIS textures, and two exact FISA groups, but linked zero
of four UV-bearing material slots. The preview therefore used flat gray and
also displayed the segment-1 no-UV geometry.

The failure is not a FIS, CSM1, facial-selector, or texture-coordinate error.
`parseMaterialReferenceTables()` returned no table for this actor layout.

## Observed actor `0x08FF` evidence

- Material slots 0 and 1 carry TEX0 PSM `0x13` (`PSMT8`) and have UVs.
- Material slots 2 and 3 carry TEX0 PSM `0x14` (`PSMT4`) and have UVs.
- Slots 4 and 5 are in segment 1, have no UVs, and carry TEX0 PSM 0.
- FIS 2816 is the only ungrouped PSMT8 texture.
- FISA group 0 resolves exactly to 2821, 2822, 2823, 3937, 3938, 3939.
- FISA group 1 resolves exactly to 2817, 2818, 2819, 2820, 3933, 3934,
  3935, 3936.
- Both FISA groups are PSMT4; their pair keys resolve every member to the
  immediately preceding contiguous FIS group.

## Repair

The authoritative FPS material-reference-table path remains first and is
unchanged. A fallback runs only when that path returns zero bindings.

The fallback:

1. derives the PSM from each UV-bearing material's TEX0 template;
2. rejects unknown or unsupported PSM values;
3. requires every FISA group to be exact and complete;
4. shares one exclusive ungrouped static FIS across all compatible slots only
   when no compatible FISA group competes with it;
5. maps remaining PSM-compatible slots to FISA groups only when the two ordered
   sets have exactly equal cardinality;
6. rejects any ambiguity and refuses partial assignments; and
7. labels every fallback binding `STRONG_INFERENCE` for the evidence-scoped
   preview.

For actor `0x08FF`, this yields:

| Material slot | Preview texture family | Evidence source |
| --- | --- | --- |
| 0 | 2816 | exclusive PSMT8 static FIS |
| 1 | 2816 | exclusive PSMT8 static FIS |
| 2 | 2821–3939 | PSMT4 FISA group ordinal 0 |
| 3 | 2817–3936 | PSMT4 FISA group ordinal 1 |

Segment-1 no-UV PSM0 slots 4 and 5 are separately classified as strong
auxiliary/shadow candidates and hidden by default. The diagnostic toggle can
show them.

## Verification

The Node regression pins the returned V5.12.5 actor export, verifies all four
fallback links, verifies that both no-UV PSM0 layers are hidden, injects an
ambiguous second PSMT8 texture and confirms that zero partial bindings survive,
and re-runs the real actor `0x0BC0` fixture to prove that its authoritative FPS
table mappings are unchanged.

## Boundary

This repair does not establish the runtime's universal material-table format.
It does not apply matrix-to-RTA candidates, skin vertices, evaluate FAS
rotations, or promote the no-UV segment's exact runtime role. Actor `0x08FF`
still renders packet-local and unposed; only its evidence-safe preview material
links and default auxiliary visibility change.
