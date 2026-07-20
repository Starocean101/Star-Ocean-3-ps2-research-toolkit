# V5.12.0 material-aware model pass

## Outcome

The incorrect face was a renderer/material defect, not missing facial data.
V5.11.2 selected FIS 1289 and painted it across every triangle. Actor `0x0BC0`
already contains two facial FISA families, but their FPS material-reference
table was not parsed.

V5.12.0 renders material batches independently. The default preview uses:

| Material slot | Packet range | Default texture | Family | Evidence |
|---:|---:|---:|---|---|
| 0 | 0–81 | 1289 | static body atlas | sole remaining ungrouped FIS and sole remaining UV slot |
| 1 | 82–86 | 1294 | 1294, 1295, 1296 | explicit FPS table record |
| 2 | 87–89 | 2413 | 2413, 2414, 2415, 3362 | explicit FPS table record |
| 3 | 90–112 | none | unresolved no-UV auxiliary | hidden by default; user-toggleable |

FIXED/XBDC actor coordinates are Z-up. The viewer now converts that source
basis to its Y-up camera basis before applying touch rotation, so actors open
upright and horizontal drags continue to rotate around the visible vertical
axis.

## Reproduced FPS table

The first FPS block begins at file offset `0x20`.

- FPS `+0x50` declares three material starts.
- FPS `+0x58` contains relative pointer `0xDD04`, resolving to table offset
  `0xDD24`.
- The table repeats material count 3 and lists qword starts `0x000A`, `0x0C87`,
  and `0x0D56`.
- Multiplying those values by 16 lands exactly at the VIF command start for
  packets 0, 82, and 87 respectively.
- The following two 16-byte records are
  `{naka,1294,slot=1,last_frame=2}` and
  `{naka,2413,slot=2,last_frame=3}`.
- `last_frame + 1` equals the mechanically verified FISA group cardinality in
  both cases: three and four members.

The explicit records are classified `STRUCTURAL`. Static texture 1289 is
classified `STRONG_INFERENCE` because it is the only ungrouped FIS texture and
slot 0 is the only UV-bearing material left after the two explicit bindings.

## Auxiliary layer boundary

Slot 3 has 492 vertices and 298 triangles, has UV `(0,0)` for every vertex, and
319 of its positions exactly duplicate positions in the linked mesh. Applying
the body atlas at `(0,0)` made this layer cover parts of the real surface and
contributed to the malformed appearance. Its runtime purpose and external
material are not proven, so V5.12.0 hides it by default and provides an explicit
diagnostic toggle. It is not deleted and is still exported in the diagnostic
OBJ.

## Mobile selection tray

The sticky Batch Export tray now collapses when the selection summary is zero
and automatically reappears when at least one resource is selected. On narrow
screens its nonempty controls use compact spacing.

## Remaining gates

- Matrix-address to RTA-node mapping is not applied.
- The RTA spatial bind-pose composition remains withheld.
- The no-UV auxiliary layer's runtime role remains unresolved.
- FAS rotation evaluation/interpolation remains withheld.
- The material links are scoped to evidence-aware preview; this is not a final
  skinned-model claim.
