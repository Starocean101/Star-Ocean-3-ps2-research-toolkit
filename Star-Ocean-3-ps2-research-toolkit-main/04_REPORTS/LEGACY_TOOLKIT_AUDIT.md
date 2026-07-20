# Legacy SO3 toolkit audit and V5.8.1 integration

## Verdict

The supplied 7z is a **community-toolkit compilation**, not game data and not a
single original release. Its useful contents come from at least three eras:

- CUE's tri-Ace disc unpacker and SLZ decoder (2011–2012);
- TheDude/Satoh extraction scripts, model importer, and hand-written identity
  list (late 2012–2013); and
- Nisto's `pk3dec` v1.0-era audio decoder (2020).

The outer archive therefore cannot predate September 2020. Its directory
timestamps are from July 2026, so they describe this recent compilation, not
the original publication dates. The exact webpage or forum post that assembled
this particular 7z was not located.

No Windows executable was run. Binary review was static: hashes, PE metadata,
imports, printable strings, symbols where retained, and comparison with public
source. The archive is unencrypted and has no damaged members.

## Package integrity

- Uploaded archive: `Star Ocean Till the End of Time.7z`
- Size: 40,710 bytes
- SHA-256: `f35e2e8dbfce6a5f7058f1613e9bf0f8bf36ea43579a022357049b09eafe1815`
- 7z method: solid LZMA2/LZMA/BCJ2, two blocks
- Members: nine files, all extracted successfully

| Member | Bytes | SHA-256 | Audit result |
|---|---:|---|---|
| `extract.bat` | 39 | `5435b1e51336f60aaaa584ab9e8aab311e69a4e21331987f32545b9ae3bb8a6d` | One local unpacker invocation; no deletion/network action |
| `triAce-PS2.exe` | 23,553 | `76d6bf78d329e3b2f3be9f49e077fe4c8ff8bcaa40a286fc93e132f9791738d1` | CUE disc-table unpacker; strong public-source match |
| `SO3_fileList.txt` | 4,637 | `a8ffe9ef3ffecc27ebe87dd452271ffed6d1d9b4d8ee42903054a961325c1cab` | 156 historical identity claims; integrated with gates |
| `Tri-Ace_PS2__21Dec12.ms` | 27,351 | `3bea81a83639ec32c369f9cc2b79005eb259bcd67e63efd046baeaceb706f204` | Geometry-only 3ds Max importer; superseded by verified VIF parser |
| `kod.bms` | 496 | `cda29c7998b0e99ea00ad28350e97b42b2647f4dc7fc75db5045ba35a543c7ef` | Generic SLZ byte scanner; not a new format |
| `pac_new.bms` | 1,721 | `fb2c6f25b2b6acd680d620bc9f064956206cf8b13d35fc2ad4d1b352ab4ac543` | Early view of the same PACK descriptor table already parsed |
| `pk1.bms` | 413 | `d629e56da676b88ef732a2e834dbd57850684aa44fd2f9ad94d885643a6a5b73` | Sequential SLZ recovery extractor; not a new format |
| `slz.exe` | 6,144 | `810dda19229cf8cbcadc0efc5bf6df16a6b15bca393069ce1e865e4a19cd088c` | CUE SLZ modes 0–3 decoder; behavior already preserved |
| `pk3dec.exe` | 123,904 | `472019897aba702013d6d1094b81fe3655a0a33d91380d9bec1a6eb39ce35dac` | Nisto tri-Ace SAC/PK3 decoder; current Explorer is more complete for the validated SO3 carrier path |

## Provenance findings

### CUE: `triAce-PS2.exe`

The PE timestamp is 20 June 2012. The binary retains the source filename
`triAce-PS2.c`, identifies itself as “tri-Ace PS2 UnPacker — (c) CUE 2011,”
and names Star Ocean 3, Radiata Stories, and Valkyrie Profile 2. Public source
with the same title, table decoder, `decoded.idx` output, extension mapping,
and `%04d` indexed filenames is available at
<https://www.bwass.org/bucket/triAce-PS2.c>.

This establishes the meaning of the first number in the historical file list:
it is the unpacker's allocation-table/output index. It does **not** by itself
prove that every secondary `_N` number is identical to the modern Explorer's
bundle or PACK child index.

### CUE: `slz.exe`

The PE timestamp is 25 October 2011. Its identity, usage strings, modes 0–3,
and decode loop match the CUE source reproduced in this ROM-hacking discussion:
<https://romhack.org/viewtopic.php?t=3728>. One prose comment in that source
describes the two size fields in the opposite order from the decoder's actual
accesses. The executable behavior and our verified fixtures agree with the
Explorer: stored/compressed length is at `+0x04`, decoded length at `+0x08`,
and next-member offset at `+0x0C`. No decoder change was made from the faulty
comment.

### Nisto: `pk3dec.exe`

The file timestamp is 24 September 2020 and its strings identify the same
frame layout, CRC diagnostics, 48 kHz stereo WAV output, and command line as
Nisto's public `pk3dec` project: <https://github.com/Nisto/pk3dec>. GitHub lists
the v1.0 release on 24 September and the repository describes the codec as an
unnamed tri-Ace PS2 audio format informally called `.PK3`/`.020`, with related
game symbols containing `Sac`.

The exact release-asset SHA-256 was not independently available from the web
page, so the provenance rating is **strong match**, not byte-for-byte upstream
confirmation. Nisto also documented that the apparent file `1035` was not the
actual intro stream and that the real one was recovered from RAM; that post is
preserved at <https://hcs64.com/mboard/forum.php?showpage=412&showthread=26929>.

### TheDude and Satoh material

`SO3_fileList.txt` explicitly says “The Dude presents / A Satoh Production.”
`pac_new.bms` says “Satoh was here,” and the MaxScript is attributed only by its
directory and dated filename. No authoritative original post, repository, or
license page for these four text artifacts was found. Their exact upstream
location remains **unresolved**; archive filenames and internal signatures are
the only provenance claims retained.

## Functional comparison with the current Explorer

### Disc extraction

`triAce-PS2.exe` decodes the game's three hidden tables and writes numbered
files with guessed extensions. The Explorer already performs the corresponding
hidden-table discovery in-browser, preserves raw-header evidence, and exposes
selection, extraction, recursive child inventories, and deterministic reports.
The legacy executable adds no missing safe extraction capability.

### SLZ

`slz.exe` handles modes 0–3 and up to a second linked stream. The Explorer
already handles strict consumed/produced sizes, linked members, SLZ/SLE/ZLS,
SLE decryption, nested containers, and reports. The old decoder is useful as
independent historical corroboration, not replacement code.

### PACK and recovery scripts

`pac_new.bms` reads four magic bytes, two 16-bit values, then `count` records of
an offset plus four metadata bytes. This is the same 8-byte PACK descriptor
shape represented by the modern parser as `u32 offset + u32 tag`; the old
script merely inspected one byte of that tag as a type selector.

`pk1.bms` trusts a count at `+0x04`, searches for the first `SLZ`, and walks
sequential blocks. `kod.bms` scans arbitrary bytes for `SLZ`; it additionally
switches to big-endian reads, which is not a safe canonical SO3 size model.
Both are salvage techniques. Explorer's bounded signature scan and structural
container parsers cover the useful behavior without promoting scan hits to
verified formats.

### 3ds Max geometry importer

The MaxScript scans for `FPS\0`, recognizes many VIF UNPACK command-byte
variants, applies historical position and UV scales (`16` and `4096`), builds
triangle strips, UVs, and explicit normals, and creates diagnostic meshes.
However:

- it rejects compressed wrappers instead of decoding them;
- it records `weightArray` values but never builds bones or a Skin modifier;
- it does not assign materials or textures;
- it does not parse RTA skeletons or FAS animation semantics;
- it relies on many cursor heuristics and contains an always-true boolean test
  (`x != A or x != B or x != C`); and
- its own comments call the format variations a “rat's nest.”

The Explorer's VIF interpreter, FPS chain model, validated packet profiles,
FIS decoder, RTA hierarchy, FAS bindings, material diagnostics, and evidence
gates supersede it. No heuristic branch from the script was imported merely
because it once produced visible geometry.

### PK3/SAC audio

Nisto's decoder provided valuable independent provenance for the codec family.
The Explorer already contains the validated JavaScript/Python SAC decoder used
for the movie carriers, CRC validation, VU synthesis translation, WAV output,
and MPEG-PS/LPCM mux. The old executable does not add loop handling and its
repository still lists off-by-one parity, loop information, and final-buffer
operations as TODOs. It was therefore not bundled or invoked.

## Historical identity index

This was the material capability not present in V5.8.0.

- 156 source claims: 16 for Disc 1 and 140 for Disc 2
- 10 direct hidden-entry claims
- 146 legacy child-ordinal claims
- one range claim: entries 3101–3103 “seems to be Firewall”
- five repeated same-label keys
- one true conflict: Disc 2 `1160_33` is both “Nel Hi-poly” and “Woltar”

V5.8.1 embeds a deterministic normalized copy as
`SO3_LEGACY_IDENTITY_CLAIMS_V1`. Matching is disabled until the ISO's disc is
inferred or selected. Direct entries can be staged into the editable human
label, but never auto-saved. Secondary ordinals remain historical child claims
until a modern child inventory reproduces their mapping. Conflicts are shown,
not resolved by preference.

## Static safety observations

The three executables import ordinary local file, console, heap, and runtime
APIs. No network, registry, service, process-launch, or shell-execution import
was found. This is not a malware guarantee, but no suspicious external-I/O
capability appeared in the static import/strings review. The release HTML
contains none of the executables and remains offline/read-only.

## Remaining unresolved work

1. Reproduce the legacy `_N` child numbering against Disc 2 export inventories.
2. Locate an original TheDude/Satoh publication page or archive checksum.
3. If desired, compare the supplied `pk3dec.exe` hash with a separately
   downloaded v1.0 release asset.
4. Visually validate the new claim panel on the target iPhone and both discs.
