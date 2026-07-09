# Star Ocean 3 PS2 Research Toolkit

A browser-based disc investigator, format documentation, extraction tools, and
reverse-engineering notes for **Star Ocean: Till the End of Time** on PlayStation 2.

The currently verified target is the **PAL Disc 1 executable `SLES_820.28`**.
The project documents the hidden tri-Ace resource table, SLZ/SLE decoding,
IOP RPC key recovery, and the EE/VU0 transformation that produces the final
16-byte SLE key.

## Current verified result

```text
Final PAL SLE key:
66665442b379f0c7e7d51e4b7ba41c7d
```

This key was not guessed or found by broad brute force. It was recovered from:

```text
Hidden resource table
→ chained SLZ bundle
→ Csi_ IOP module
→ SIF RPC server 0x1234
→ function 0x0E / OnCsGetSecretKeyCode
→ bitwise-complemented 16-byte IOP response
→ EE VU0 microprogram transform
→ strict validation against SLE entry 1068
```

The validated entry-1068 output is exactly 9,008 bytes, consumes the complete
4,227-byte compressed stream, has no invalid references, and begins with `PACK`.

## Browser extractor

Open:

```text
browser/so3_browser_disc_investigator.html
```

The browser app can:

- read large ISO files without loading the entire image into memory;
- traverse ISO9660/Joliet directories;
- decode the Star Ocean 3 hidden allocation table;
- enumerate and extract thousands of hidden resources;
- scan visible files, hidden resources, or the raw disc for signatures;
- parse IOPRP ROMDIR entries;
- inspect ELF/IRX imports, exports, and RPC registrations;
- decode SLZ0, SLZ1, SLZ2, SLZ3, and SLE streams;
- use the verified PAL key to decode all top-level SLE entries;
- export decoded files, reports, hashes, TSV data, and ZIP archives.

The app is a forensic/extraction tool. It does not modify an ISO.

## Documentation

Start here:

1. [Technical Guide](docs/TECHNICAL_GUIDE.md)
2. [Browser Extractor Guide](docs/browser/BROWSER_EXTRACTOR_GUIDE.md)
3. [Hidden Resource Table](docs/disc-layout/HIDDEN_RESOURCE_TABLE.md)
4. [SLZ and SLE Formats](docs/compression/SLZ_AND_SLE.md)
5. [SLE Key Recovery](docs/key-recovery/SLE_KEY_RECOVERY.md)
6. [Validation Method](docs/testing/VALIDATION_METHOD.md)
7. [Format Index](FORMAT_INDEX.md)
8. [Project Status](PROJECT_STATUS.md)

## Repository policy

This repository contains original tools, documentation, hashes, addresses,
pseudocode, and research results.

It intentionally does **not** include:

- disc images;
- game executables;
- original IRX modules;
- extracted artwork, models, audio, movies, or archives;
- other copyrighted game data.

Use legally obtained copies of the game for personal research.

## Platform

The browser tool was designed to remain practical on iPhone and iPad Safari.
It also works in modern desktop browsers. Large operations still depend on the
device keeping the tab alive, because mobile browsers enjoy suspending useful
work at the least dignified moment.

## Verified scope and compatibility

| Target | Status |
|---|---|
| Star Ocean 3 PAL Disc 1 | Verified |
| Star Ocean 3 PAL Disc 2 | Expected to share major formats; not yet validated |
| NTSC-U / NTSC-J releases | General tools should work; table profile and SLE key require validation |
| Other tri-Ace PS2 titles | Partial research utility; title-specific profiles may be required |
| Other PS2 titles | ISO, sector, ELF, IRX, and signature tools remain useful; SO3 formats are title-specific |

## Research threads

Use [the container research prompt template](prompts/FILE_CONTAINER_THREAD_TEMPLATE.md)
to create one focused thread per newly identified file/container type. Record each
task as a GitHub Issue using the included issue template.
