# V5.11.2 Safari WebGL hotfix

The direct-ISO assembly succeeded on the target iPhone: actor `0x0BC0`
produced 2,524 vertices and 1,476 triangles and reached the evidence-gate UI.
Rendering alone failed during fragment-shader compilation with:

`'flat' : Illegal use of reserved word`

`flat` is reserved by GLSL. The diagnostic fragment shader used it as a local
color variable. V5.11.2 renames that identifier to `flatColor` without changing
shader behavior, geometry, texture decoding, assembly evidence, or any
preserved subsystem. A static regression rejects any return of `vec4 flat=` or
`mix(flat,` in the Model Lab source.
