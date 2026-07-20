# Public publication boundary

This file records the Max-level publication audit for the V5.12.8 Pass 6.2
repository update.

## Included

- original browser and command-line source written for this project;
- the deterministic single-file browser release;
- format specifications, addresses, hashes, pseudocode, and derived metadata;
- canonical Atlas registry/graph/ledger outputs;
- public-safe summary reports;
- synthetic and generated test vectors;
- the 16 KiB SAC decoder coefficient image reconstructed from static VIF
  initialization streams, required by the portable decoder;
- the GPL-3.0-or-later FIS port with its license and third-party notice.

The SAC coefficient image is a derived numerical decoder table. It is not an
executable, module, disc allocation, audio stream, or extracted asset.

## Excluded

- ISO/ROM/disc images;
- `SLES_820.28`, Lib, Field, Csi_, IRX, ELF, or MWo3 executable images;
- decoded hidden allocations and archive contents;
- actor CHAR, RTA, FAS, FIS, texture, model, map, movie, or audio fixtures;
- screenshots and rendered game artwork;
- Field/hybrid response binary blocks;
- full instruction-trace JSON and proprietary-memory snapshots;
- private master packages and analyst return archives.

## Reproducibility boundary

The public synthetic suite reproduces the release build and decoder behavior
without proprietary inputs. Engine-execution claims are documented through
hash-bound public summaries, but reproducing them requires the user to supply
their own legally obtained game bytes.

No excluded input is silently replaced with invented data. Tests that require
private game fixtures are not presented as runnable public tests.
