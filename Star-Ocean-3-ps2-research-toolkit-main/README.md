# Star Ocean 3 PS2 Research Toolkit

Offline, browser-first research and extraction tools for *Star Ocean: Till the
End of Time* on PlayStation 2. The verified target is PAL Disc 1 and executable
`SLES_820.28`.

## Current public release

**SO3 Resource Explorer V5.12.8 Pass 6.2**

Open:

`01_RELEASE/so3_resource_explorer_v5_12_8_pass6_2.html`

The release is one self-contained HTML file. It does not use a server, CDN,
font service, or network API. The ISO is opened locally through the browser and
is never modified.

The compatibility path `browser/so3_browser_disc_investigator.html` contains
the same current release bytes.

## What the Explorer currently does

### Disc and resource investigation

- reads large ISO files without loading the entire image into memory;
- traverses ISO9660/Joliet directories;
- decodes the tri-Ace hidden allocation table;
- enumerates and extracts hidden resources;
- decodes SLZ0/1/2/3 and validated SLE streams;
- recognizes PACK, semantic bundles, MWo3 modules, SEQW, FIS/FISA, FPS,
  XBDC, RMAC, RTA, FAS, map, model, audio, and movie families;
- exports reports, hashes, TSV data, decoded files, and ZIP archives.

### Media Explorer

- detects the verified SO3 obfuscated MPEG program-stream carrier;
- applies the exact executable-derived movie transformation;
- decodes tri-Ace SAC audio to stereo PCM;
- builds a standard MPEG-PS/LPCM download containing video and audio;
- skips valid PACK reference/index records instead of reporting them as
  corrupt local archives.

Safari does not natively decode the recovered MPEG-2/LPCM combination. The
downloaded MPG is intended for a compatible player such as VLC. This is a
browser codec boundary, not disc corruption.

### Model Lab

- assembles indexed character resources directly from the opened ISO;
- decodes verified FPS/XBDC/RMAC geometry and embedded FIS/FISA textures;
- supports corrected PSMT4/PSMT8 CSM1 CLUT mapping, direct PS2 ST coordinates,
  texture filtering, and edge clamping;
- preserves per-material texture selection and guarded material fallbacks;
- parses RTA records and FAS channels and reports exact evidence gates;
- exports evidence-safe diagnostic geometry, textures, and assembly metadata.

The current browser model preview is static and unposed. Original FAS
evaluation, runtime-node matrix writing, IDOM composition, packet construction,
and the one-matrix FIXED VU1 consumer have been verified for packaged reference
actors, but browser mesh deformation and general animation playback remain
separate unimplemented gates.

### Runtime and evidence tools

- browser-local runtime-capture workflows;
- bounded ELF32/MWo3 sparse loading and targeted R5900 execution;
- read-only evidence requests for exact missing allocations;
- deterministic Atlas and legacy-evidence presentation with unresolved claims
  kept separate from verified data.

## Verified key result retained from Version 1

The PAL SLE key is:

`66665442b379f0c7e7d51e4b7ba41c7d`

It was recovered through the hidden resource table, chained SLZ bundle, Csi_
IOP RPC server, function `0x0E`, the complemented 16-byte response, and the
EE/VU0 transform, then strictly validated against entry 1068.

## Build from source

Requirements: Python 3 and Node.js for the complete public test suite.

```sh
python3 02_SOURCE/build_release.py
03_TESTS/run_public_tests.sh
```

The build must reproduce the committed release HTML byte-for-byte.

## Research data and documentation

- `05_ATLAS/` contains the canonical public V1.1.2 format registry, resource
  graph, and update ledger.
- `04_REPORTS/` contains public-safe summary reports. Full execution traces and
  proprietary inputs are intentionally absent.
- `FORMAT_INDEX.md` is the compact format-status index.
- `PROJECT_STATUS.md` separates completed engine evidence from browser and
  device-validation gates.
- `PUBLICATION_BOUNDARY.md` records exactly what is and is not included.

## Repository policy

This repository contains original tools, derived format documentation, hashes,
addresses, pseudocode, test vectors created for this project, and research
results.

It intentionally does not contain:

- disc images;
- game executables or original IRX/MWo3 modules;
- decoded game archives;
- extracted artwork, models, animations, textures, audio, or movies;
- private Field/engine responses or full instruction-trace payloads.

Users must supply their own legally obtained game media. See
`COPYRIGHT_NOTICE.md` and `PUBLICATION_BOUNDARY.md`.

## Platform

The browser tool is designed for iPhone and iPad Safari as well as modern
desktop browsers. Mobile browsers may suspend long-running tabs; operations are
therefore bounded, resumable where practical, and explicit about progress.

## Compatibility

| Target | Status |
|---|---|
| Star Ocean 3 PAL Disc 1 | Verified primary target |
| Star Ocean 3 PAL Disc 2 | Major formats expected; full validation pending |
| NTSC-U / NTSC-J | General parsers may apply; table profile and keys require independent validation |
| Other tri-Ace PS2 titles | Research utility only; title-specific profiles likely required |

## Current continuation levels

- **High:** expand disc-wide static model discovery and browser classification.
- **High:** integrate the verified one-matrix FIXED browser-deformation path.
- **Max:** audit new engine semantics, actor/map placement, blended weighting,
  or contradictory Atlas evidence.
- **Medium:** perform iPhone visual validation.
- **Light:** documentation and checksum-only maintenance.
