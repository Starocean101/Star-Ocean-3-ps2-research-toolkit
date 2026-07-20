# PS2 Texture-Coordinate Repair — V5.12.5

## Field failure

The V5.12.4 iPhone screenshots show two reproducible assembled-preview defects
on actor `0x0BC0`: the eye/mouth layers are visibly inverted and bordered, and
the lower garment samples a flesh-colored area with a large gray mark.
Therefore the earlier statement that the assembled face was fixed was too
broad. The standalone CSM1 CLUT correction remains byte-correct, but the
renderer that consumed those corrected images was still wrong.

## Root cause

`v5_fis.js` decodes the GS image into an RGBA array with source row `y=0`
first. The decoded VIF V2-16 ST values are normalized by `4096` and actor
`0x0BC0`'s three textured material slots stay inside `[0,1]`. The old fragment
shader nevertheless sampled `vec2(vUv.x, 1.0-vUv.y)`. WebGL samples the first
uploaded row at `t=0`; the extra inversion therefore selected the vertically
opposite atlas region.

This can be checked directly against texture 1289: lower-body UVs concentrated
near the lower part of the sheet were redirected into the top-left skin/gray
area visible in the field screenshot. The same inversion affected the 64×64
eye and mouth sheets.

The old renderer also forced `REPEAT` addressing. Facial UV extrema reach
within half a texel of one or more 64×64 boundaries, so linear sampling could
blend the opposite edge into a border. All observed reference-actor UVs are in
range; repeating is unnecessary for this preview.

## Repair

- sample `texture2D(uTex, vUv)` with no host-side vertical inversion;
- use `CLAMP_TO_EDGE` for S and T;
- preserve decoded pixels, CSM1 CLUT mapping, UV records, packet/material
  assignments, FISA selection, filtering toggle, and the read-only ISO path.

## Geometry boundary

The side-view screenshots also show unusual protruding geometry. Actor
`0x0BC0` has coherent model-space bind coordinates spanning head to feet, but
the 22 matrix addresses are still not applied to animation and the no-UV
auxiliary segment remains withheld. V5.12.5 does not invent a skinning or
auxiliary-role solution. Device validation must distinguish any remaining
geometry/pose issue from the now-corrected texture-coordinate issue.

## Status

Implementation and static/fixture regressions: **PASS**.

Final iPhone visual confirmation: **PENDING USER FIELD TEST**. The package must
not be described as visually confirmed until actor `0x0BC0` is reloaded from
the ISO in V5.12.5 and compared with the supplied failure views.
