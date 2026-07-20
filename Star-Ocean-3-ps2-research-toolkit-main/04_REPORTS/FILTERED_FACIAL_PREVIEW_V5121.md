# V5.12.1 filtered facial-preview pass (SUPERSEDED DIAGNOSIS)

> V5.12.4 disproves this report's two-bank/dark-source diagnosis. The former
> dark perforations came from slicing a 16×2 PSMCT32 transfer image into two
> false banks instead of applying the CSM1 IDTEX4 8×2 CLUT layout.

## Diagnosis

Actor `0x0BC0` uses two facial mesh ranges: material slot 1 covers the upper
face and binds FISA family `1294–1296`; slot 2 covers the lower face and binds
family `2413, 2414, 2415, 3362`. Their ranges, packet starts, UVs, and family
cardinalities are structurally consistent.

The conspicuous dark facial marks are not an alpha failure. All seven facial
textures decode with only alpha 0 and 255, and the marks are opaque palette
entries in every frame and both palette banks. The JavaScript PSMT4 path also
matches the original FIS V2 converter's GS-address, nibble, CLUT-order, and
PS2-alpha rules.

V5.12.0 nevertheless exaggerated those low-resolution 16-color texels by using
nearest-neighbor sampling on a high-density phone display. V5.12.1 enables
linear minification and magnification by default, matching the presentation
expected from a filtered console texture more closely. Raw nearest-neighbor
sampling remains available as an explicit evidence view.

## Runtime boundary

FISA family membership and the per-packet material ranges are known. The
runtime state that selects a particular face-animation member and palette bank
is not yet mapped. V5.12.1 therefore keeps frame 0 / palette 0 as a visible
preview default and adds a `facial_frame_palette_selector` unresolved gate.
Changing frames or banks remains a manual preview operation and is not reported
as the actor's canonical in-game expression.

## Viewer changes

- PS2-style linear texture filtering enabled by default.
- Explicit raw-nearest toggle for inspection.
- FIXED/XBDC actors initially face forward.
- Facial selector uncertainty shown as a separate evidence gate.
- No source pixels are repainted, erased, or heuristically cleaned.
