# Project status — V5.12.8 Pass 6.2

Evidence gates are independent. Completing an engine-analysis stage does not
automatically promote browser integration or visual correctness.

## Verified and implemented

- ISO9660/Joliet traversal and PAL Disc 1 hidden allocation table.
- All 5,883 nonempty PAL Disc 1 hidden entries enumerable and extractable.
- SLZ0/1/2/3 and validated SLE decoding.
- PACK and semantic-bundle parsing with the Pass 6.2 reference/index repair.
- MWo3, FIS/FISA, SEQW, RTA, FAS, FPS, XBDC, RMAC, model, map, and media
  identification paths documented in Atlas V1.1.2.
- Exact SO3 movie-carrier transformation.
- SAC stereo audio decode and MPEG-PS/LPCM mux download.
- Static model assembly and evidence-scoped material preview.
- Corrected facial CSM1 CLUT, PS2 ST orientation, filtering, and edge clamping.
- Canonical Atlas V1.1.2 merger audit: 23 update inputs, two conflicts retained,
  five ambiguities retained, and 156 historical claims left unapplied.

## Engine evidence completed for packaged reference actors

- Original FAS rotation evaluation and interpolation.
- Concrete runtime-node setter and local/world matrix writing.
- Hierarchical parent composition.
- IDOM resource loading and VU0 matrix composition.
- Matrix-palette packet construction.
- FIXED vertex matrix-address to palette-slot binding.
- Original one-matrix VU1 packet consumer.
- RTA exact-name object binding and FSS descriptor transform loading.
- Two bounded end-to-end packet-pose witnesses.

The proprietary inputs and full instruction traces used for those validations
are not redistributed by this public repository. Public summary reports retain
the exact hashes, scopes, and withheld boundaries.

## Current browser limitations

- mesh deformation and animation playback are not yet integrated;
- the packaged actor index is not a full-disc model census;
- non-reference geometry/material profiles require actor-scoped regression;
- exact human/monster identities and actor-to-map placement remain unresolved;
- Safari lacks native MPEG-2/LPCM playback;
- on-device visual validation remains a separate gate.

## Current continuation

1. **High:** disc-wide static model discovery and evidence-based classification.
2. **High:** verified one-matrix FIXED browser animation integration.
3. **Max:** independent browser/engine audit and any new format branch.
4. **Medium:** iPhone visual regression.
5. **Light:** documentation, release metadata, and checksums.

## Compatibility still pending

- PAL Disc 2 full validation;
- NTSC-U and NTSC-J hidden-table profiles and keys;
- applicability to other tri-Ace PS2 titles.
