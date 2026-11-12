# Star Ocean Utility Tool v1.39

**Developer: Starocean 101**
Title ID **CUSA99901**, Content ID `UP0001-CUSA99901_00-STAROCEANUTILITY`

A homebrew file utility for a jailbroken PS4 running GoldHEN. It uses your nebula artwork as the background and plays soft ambient music.

## Features

* **File explorer** for internal storage (`/data`), USB drives (`/mnt/usb0-7`), extended storage and the user partition
* **Extract** ZIP, RAR4/RAR5 and 7z, including multi-part sets and files over 4 GB, **to any folder you choose**
* **Create ZIP** from the files and folders you select. Folders are added recursively and ZIP64 is used automatically, so large files are supported (tested with a 4.5 GB file). Compression can be Deflate (smaller) or Store (fastest).
* **Copy, move and delete** files and folders, with a progress bar and cancel. Moving between drives (internal ↔ USB) copies, verifies, then removes the original.
* **Progress bar** showing overall %, the current file, sizes, elapsed time and time remaining
* **Cancel button:** hold ○ for 1.5 seconds while a job is running. Partial output is removed.
* **Logger:** every action is written to a log file. You choose the folder with the file explorer, and the Tools tab shows the most recent log lines on screen.
* **Background music:** soft ambient pads, toggled on or off in the Tools tab
* **Settings are remembered** between launches (`/data/StarOceanUtility/settings.ini`): log location, default extraction folder, compression, overwrite and music
* **CPK archive tools** (CRI game data, e.g. Star Ocean 4 `0000.bin` / `0001.bin`): view the header, save the file list, extract one file or everything, dump a byte range. See *CPK archive tools* below.
* **Credits tab**

## Controls

| Button | FILES tab | TOOLS tab |
|---|---|---|
| ✕ | Open folder / extract archive / select file | Run or toggle the highlighted option |
| □ | Select or deselect the item (for ZIP) | |
| ○ | Up one folder | |
| △ | Toggle "all files" / "folders + archives only" | |
| OPTIONS | Actions menu: Create ZIP, Select all, Clear, **Set this folder as log folder** | |
| L2 / R2 | Page up / down | |
| L1 / R1 | Switch tabs (FILES / TOOLS / CREDITS) | Switch tabs |
| Hold ○ | Cancel a running job | |

**Choosing the log location:** open a folder in FILES, then press OPTIONS and pick *Set this folder as log folder*. You can also go to TOOLS, pick *Change log folder*, browse to a folder and press OPTIONS. The default is `/data/StarOceanUtility/log.txt`.

**Choosing where archives extract:** press ✕ on an archive and pick one of four options:
1. *Extract here*: into a new subfolder next to the archive
2. *Extract to default folder*: `<default>/<archive name>/`. The default is `/data/Extracted`; change it under TOOLS → *Default extraction folder*
3. *Extract into this folder*: no subfolder
4. *Choose a folder...*: browse to any folder (internal or USB) and press OPTIONS. A subfolder named after the archive is created there.

While you're picking a folder, only folders are listed. Pressing ○ at the device list cancels.

**Copy / Move:** press □ on the items, open the folder you want them in, press OPTIONS and pick *Copy selected here* or *Move selected here*. If a name already exists, the copy gets `_1`, `_2`... and nothing is overwritten.

**New folder:** open the folder where you want it, press OPTIONS and pick *New folder here...*, then type a name on the PS4 keyboard. Characters a USB drive can't store (`/ \ : * ? " < > |`) are replaced with `_`. If the keyboard can't open, a folder called `New folder` is created instead.

**Delete:** select items with □ (or just highlight one), press OPTIONS → *Delete...*, then press **□** to confirm (✕ or ○ cancels; □ is used on purpose so a double-tap of ✕ can't delete anything).

**Safety guards:** move and delete only work inside `/data`, USB drives (`/mnt/usb0-7`) and extended storage (`/mnt/ext0`). The PS4 system partitions are never touched. You can't copy or move a folder into itself. A cancelled or failed move never deletes the original. If anything inside a folder can't be copied during a cross-drive move, the original is kept.

**Making a ZIP:** in FILES, press □ on each file or folder you want to include. A yellow mark appears and *Selected: N* counts up. Then press OPTIONS and pick *Create ZIP from selected*. The zip is saved next to the selected items. It takes the item's name if you selected one, or the name of their folder if you selected several. The selection clears after a successful zip.

## Install

> **Updating from an earlier version?** Delete Star Ocean Utility Tool from the home screen first, then install the new pkg. If you install over an existing copy, the PS4 can keep showing the old version number and icon. Your settings and log live in `/data/StarOceanUtility` and are kept.


**The ready-made package is included:** `UP0001-CUSA99901_00-STAROCEANUTILITY.pkg`. It was built with PkgTool.Core (LibOrbisPkg) and passes all 28 hash and signature checks in `pkg_validate`.

1. Copy the `.pkg` to a USB drive (exFAT or FAT32).
2. Install it with GoldHEN: *Settings → Debug Settings → Game → Package Installer*.

If you ever rebuild the app, `build_pkg.bat` can still repackage it on Windows with your PS4-Fake-PKG-Tools-3.87.

## About CUSA99901

You asked for a CUSA ID. Retail PS4 IDs haven't come anywhere near the 99000 range, so CUSA99901 should not clash with any real game you install. If you ever want to rule a clash out completely, change `TITLE_ID` and `CONTENT_ID` in `source/Makefile` to a homebrew-style ID such as `SOUT00001`, then rebuild.

## Image viewer (new in v1.13)

Textures and images can be viewed right on the PS4:

* **FILES:** press ✕ on a DDS, PNG, TGA or BMP file. The file is recognised by its content too, so a `.bin` that is really a DDS also opens. Image files are shown in orange, and the △ filter keeps them visible.
* **Archive tools → View file list → □:** views an image entry straight from the archive. Textures inside KCAP packs: unpack with △ first, then open the PNGs in FILES.

| Button | In the viewer |
|---|---|
| ✕ | fit to screen ↔ 100 % |
| L2 / R2 | zoom out / in (down to 1/8 of fit, up to 3200 %) |
| D-pad | pan |
| △ | background behind transparent pixels: checkerboard / black / white |
| □ | save a PNG copy to the Default extraction folder |
| L1 / R1 | previous / next image in the same folder (FILES only) |
| ○ | back |

Formats: DDS (8-bit RGBA/BGRA/RGB/luminance, BC1, BC2, BC3, BC4, BC5), PNG (every colour type, 1-16 bit, interlaced), TGA (true colour, grey or palette, RLE or not), BMP (8, 24 and 32-bit). Up to 64 megapixels and files up to 256 MB. Tested against images written by an independent library (pixel-exact) and 2,700 corrupted images under AddressSanitizer.

## Unpack / convert (new in v1.12)

The tool recognises a file from its first bytes, not its name, then unpacks or converts it. Files are only read; the source is never changed.

| Format | What you get |
|---|---|
| tri-Ace KCAP pack (Star Ocean 4) | every member, SLZ-decompressed, named by number + tri-Ace tag (`000.tre`, `001.aaf` ...) |
| tri-Ace SLZ (modes 0-3) | the decompressed file |
| tri-Ace AIF texture set | PNG per image (BC1/BC2/BC3/BC5/BC7/RGBA8/R8) |
| tri-Ace ASF model | a glTF 2.0 binary (`.glb`) with meshes, normals, UVs and embedded base-colour textures |
| tri-Ace AAC sound bank | one `.at9` (RIFF ATRAC9) per sound - plays in foobar2000 + vgmstream, ffmpeg, VLC |
| tri-Ace EXD table | `.txt` (UTF-8) with every text string and its offset; data-only tables are skipped |
| PSARC (zlib or LZMA) | all files with their real paths |
| Wwise package `.pck` | `banks/*.bnk`, `sounds/*.wem`, `externals/*.wem` (per language) |
| Wwise sound bank `.bnk` | the embedded `.wem` sounds |
| CRI AFS | all files (real names when the archive has a name table) |
| CRI AWB (AFS2) | each sound as `.hca` / `.adx` / `.bin` |
| LZ4 frame / legacy | the decompressed file |
| DDS texture | `.png` (RGBA/BGRA/RGB/luminance 8-bit, BC1, BC2, BC3, BC4, BC5) |

Containers found inside other containers are unpacked one more level automatically (a `.bnk` inside a `.pck`, a DDS inside a KCAP pack becomes a PNG as well). Every run writes `_unpack_log.txt` in its output folder.

**Where it is**
* **FILES → OPTIONS → Unpack / convert this file**: the output goes to `<Default extraction folder>/<file>_unpacked/`. On a CPK or Star Ocean 4 archive this opens Archive tools instead.
* **Archive tools → View file list → △**: unpacks the highlighted entry straight out of 0000.bin/0001.bin, with no raw extract first. The output goes to `<output>/0001_unpacked/00656/`.
* **Archive tools → Unpack / convert every recognised file**: every known-format entry of the archive on screen. Resumable, since finished entries are skipped. Hold ○ to stop.

Tested against your real 0001.bin dump (KCAP/SLZ: output identical to the reference decoder), generated samples of every other format (every output byte-exact), and 1,000 deliberately corrupted files under AddressSanitizer (no crashes). The real game files for formats other than KCAP haven't been tested yet.

**Roadmap**, in order:
1. BC7 / BC6H textures, then PS4 **GNF** textures (they need un-tiling)
2. Audio to `.wav`: CRI **ADX** and **HCA**, PCM in Wwise/RIFF
3. Unity asset bundles (LZ4/LZMA), CRI ACB cue names
4. Models: these are game-specific (there is no common PS4 model format). The plan is to export decoded formats to glTF/OBJ for a PC viewer, starting with tri-Ace's once Star Ocean 4's are understood.

Not possible / not planned: ATRAC9 (`.at9`) audio decoding (no open decoder exists); Oodle-compressed data (proprietary); anything that unlocks retail encryption (PKG, encrypted saves, AES-locked archives).

## Star Ocean 4 archives (new in v1.09)

Star Ocean 4 4K's `0000.bin` / `0001.bin` are **not** CRI CPK archives. They use tri-Ace's own layout:

* **The file index is in 0000.bin.** It takes the first 786,432 bytes: a 0x6C-byte header, then 65,527 entries of 12 bytes (sectors, bytes, start), XOR-scrambled with a key that repeats every 192 bytes. The tool works the key out from the file itself, because unused entries are all zero. It then checks the header values (0x1E998 / 0x0F4CC000 / 0x1EB98) and every entry's sector count against its byte count. If any check fails, the file is rejected rather than guessed at.
* **Each entry number is the file ID.** If bit 28 of `start` is set, the file is in 0001.bin; the offset is `(start & 0x0FFFFFFF) * 2048`. There are 2,450 used IDs: 1,887 in 0000.bin and 563 in 0001.bin, about 42.4 GB in total.

The Archive tools screen opens both files automatically (Star Ocean 4 shortcut, or OPTIONS → *Open as CPK archive* on either file). Use ← / → to switch between them.
* *Save file lists* writes `listing_0000.txt` **and** `listing_0001.txt` in one go, whichever archive is on screen. Columns: ID, archive, offset (hex), size in bytes, readable size, and format.
* *View file list on screen*: a scrollable table of ID, offset, size, bytes and format. Up/Down, L2/R2 page, ← / → switch archive, ✕ extracts the highlighted file. Format is read from each file's first bytes (KCAP pack + file count, SLZ, RIFF/WAVE, DDS, GNF, PNG, tri-Ace tags, or the 4 bytes in hex when unknown).
* *Extract by ID or name*: type one ID (`656`, or `00656`; IDs are decimal) or several IDs and ranges at once, such as `0-3 10 100 656 657`. Each one is found in whichever archive holds it and saved as `<output>/0000/00000.bin`, `<output>/0001/00656.bin` and so on. A summary lists what was saved, what failed and which IDs are unused.
* *Extract ALL*: `<output>/0000/00000.bin ...` and `<output>/0001/00656.bin ...`, saved as raw bytes. It checks free space first, skips files already complete, shows progress and can be cancelled. It writes `extract_log.txt`.

Files are saved exactly as stored; nothing is unpacked yet. Many files in 0001.bin are "KCAP" packs whose members use tri-Ace's SLZ compression. A verified SLZ decoder for those is in `source/tools/so4/slz.py` and is planned for the tool once more samples have been checked.

## CPK archive tools (new in v1.07)

These tools read CRI `CPK` archives, such as Star Ocean 4 (CUSA09485) `app0/0000.bin` and `0001.bin`. **The archives are only ever read and are never changed.** Output goes only to `/data`, a USB drive or extended storage, never back into the game's folder.

**Opening an archive**
* *TOOLS → Star Ocean 4 data archives (CUSA09485)* looks in this order:
  1. The game's own folder: `/mnt/sandbox/CUSA09485_000/app0` and `/mnt/sandbox/pfsmnt/CUSA09485-app0`. The PS4 usually mounts these **only while the game is running**.
  2. Every USB drive (`/mnt/usb0-7`) and extended storage, up to 4 folders deep, for a folder containing a CPK `0000.bin`. A folder with `CUSA09485` in its path is preferred, so a game dump such as `/mnt/usb0/CUSA09485-app0/` is found automatically. `0001.bin` from the same folder opens with it. Recycle-bin and system folders are skipped, and the search stops after 6,000 entries per drive so a huge drive can't stall the app.

  Everything it checked is written to the log. If nothing is found, it tells you so.
* Or highlight any CPK file (for example a copy of `0000.bin` on USB), press OPTIONS and choose *Open as CPK archive (game data)...*. Other CPK files with the same extension in that folder open alongside it. Switch between them with ← / →.

**What the screen shows** (also written to the log): the path, the exact size, the first 64 bytes as hex, and whether the file is a CPK (number of files, named or ID-only, and how many are CRILAYLA-compressed). Encrypted (XOR) tables, TOC (named) and ITOC (ID-only) archives, and alignment are handled automatically. Offsets are 64-bit, so 30+ GB archives are fine.

**Actions**
* *Save header dump*: the first 1 MiB as `<output>/0000_head.bin`
* *Save file list*: `listing_0000.txt` with ID, path, offset (hex), FileSize, ExtractSize and whether each entry is compressed
* *Extract one file*: type a name (`items.tbl`), a `Dir/File` path or an ID number. CRILAYLA data is unpacked.
* *Extract ALL from this archive* / *from all archives*: into `<output>/0000/<folder>/<file>`. Entries without names go to `_id/<ID>.bin`. Before starting, the app shows how much still has to be written and the free space, and refuses to start if it won't fit. Copying uses 8 MiB chunks, with a progress bar (files and bytes). Hold ○ to stop.
  * **Resumable:** files that already exist at the right size are skipped, so running it again continues where it stopped. Each file is written as `.part` and only renamed when complete.
  * `<output>/extract_log.txt` gets one line per file (OK / ERROR + reason / SKIPPED / CANCELLED) and a summary. `listing_0000.txt` / `listing_0001.txt` are written as well.
  * Extract all is disabled for files that aren't CPK archives. The header dump still works on them.
* *Dump a byte range*: type `offset length` in decimal or `0x` hex (e.g. `0x1000 0x100000`). Saved as `<output>/0000_<offset>_<length>.bin`.
* *Output folder*: default `/data/so4_extract`. Pick another with the file explorer (OPTIONS = use this folder).
* *Also keep compressed copies*: also saves the raw `.crilayla` data next to each unpacked file.

Single compressed files are unpacked in memory, up to 320 MB each. Larger compressed entries are reported as errors in the log instead of risking a crash. Uncompressed files of any size are streamed.

## New in v1.39

- GNM probe Tier C fixed. v1.38's submit-and-flip was rejected with `0x80D11080`
  (SUBMISSION_AND_FLIP_FAILED_INVALID_COMMAND_BUFFER): the driver requires the last 64 dwords
  of the command buffer to be a "prepareFlip" packet (type-3 NOP `0xC03E1000`, marker
  `0x68750777`), which it patches into the flip request. Now appended.
- v1.38's pink screen was a false positive: the CPU painted the buffer already on screen. Tier C
  now paints the OFF-screen buffer green and only counts the flip if the flip counter moves
  during the probe and the green buffer becomes the one on screen. Green is held 3 seconds.
- TOOLS menu: long item names no longer run into the value column.

## New in v1.38

- New **GNM GPU probe** (TOOLS tab). This is the first step onto the graphics path games
  actually use (GNM / libSceGnmDriver), instead of Piglet. It runs in safe tiers and writes a
  step-by-step `gnm_probe.txt`, each line flushed to disk before the step runs:
  - Tier A - allocate GPU command-buffer memory, ask `sceGnmAreSubmitsAllowed`.
  - Tier B - submit an init-only command buffer and confirm the GPU drains it. If this passes,
    a fake-pkg process CAN submit to the GPU: the wall we hit with Piglet is gone.
  - Tier C - fill a display buffer magenta on the CPU and flip it THROUGH GNM
    (`sceGnmSubmitAndFlipCommandBuffers`). A magenta screen = the GPU submit+flip path is open.
- Deliberately not included yet: the render-target PM4 for an actual shaded GPU draw. Untested
  register writes can hang the GPU, so that waits until this probe confirms the submit path and
  reports the GPU generation. The embedded-shader fullscreen quad is the next step after that.

## New in v1.37

- Reverted both GPU signing experiments. v1.36 would not launch: a system PAID / system_exec
  self is rejected by GoldHEN's loader, which expects a fake self with the fake PAID. Signing is
  back to `0x3800000000000011` / `fake` and the package category is back to `gd` - the same
  known-good combination as v1.30, so this launches. All the real fixes (file sizes, free space,
  audio job flags, close-from-app with logged shutdown) are kept.
- Conclusion on Piglet: the eglCreateContext wall is a system-app privilege gate, not a config
  problem. The next GPU work, if any, should use GNM (what games use), not Piglet. See notes.

## New in v1.36

- GPU experiment #2 (system identity): the eboot is now fake-signed as a **system executable**
  instead of a normal fake self. The program authentication id (PAID) is `0x3100000000000002`
  (a system id) instead of `0x3800000000000011`, and the program type is `system_exec`. This is
  what flatz reported got a homebrew process past `eglGetDisplay` on a locked-down firmware.
  Build knobs (Makefile): `PAID` and `PTYPE`. Revert with
  `make PAID=0x3800000000000011 PTYPE=fake`.
- Note on GoldHEN: the HEN fake-self handler copies the PAID from the eboot but fills the rest
  of the auth_info from its own fixed template, so PAID + program type are the only parts of the
  identity that actually reach the kernel. A full custom `--authinfo` blob would be ignored.
- Keeps the `gde` category from v1.35. If the app will not install or launch as a system self,
  that combination is the likely cause - tell me and I will split the two experiments apart.

## New in v1.35

- Close from inside the app: OPTIONS on the TOOLS or CREDITS tab, or "Close application..." in
  the FILES tab's OPTIONS menu. Every shutdown step is written to the log and forced to disk
  before it runs (lines start with `shutdown:`), so a console crash during shutdown leaves the
  failing step as the last line.
- GPU experiment: param.sfo CATEGORY is now `gde` (was `gd`), as in flatz's working GL test.

## New in v1.34

- Fixed wrong file sizes (v1.32 and v1.33 only). Those two builds were compiled with the
  OpenOrbis 0.5.4 release headers, where `mode_t` is 32 bits; the PS4 kernel uses 16. That
  shifted `struct stat`, so every size read came back as the block count (the boot log showed
  `size check MISMATCH (stat=3840, ...)`). Anything that depends on a file's size - the text
  viewer, sound loading, extraction checks - was affected. **Before compiling, change line 51
  of the toolchain's `include/bits/alltypes.h` to `typedef unsigned short mode_t;`.**
- Free space is now read straight from the kernel (`_fstatfs`).

## New in v1.33

- GPU: the tool now looks for the homebrew Piglet pair first - the 4.74 dev-kit
  `libScePigletv2VSH.sprx` (744208 bytes) and the shader compiler `libSceShaccVSH.sprx`
  (10394272 bytes) - in `/data/self/system/common/lib/`, then `/app0/sce_module/`. Only when
  they are missing does it fall back to the console's own Piglet (which on 6.72 has no shader
  compiler and refused to make a GL context). Load order follows the SM64 PS4 port.
  These two files are Sony's and are NOT part of this package: copy them to the console yourself.
- GPU probe: new test 1 uses every configuration value the SM64 port uses. The probe file
  says which Piglet was loaded ("PIGLET IN USE") and whether the compiler loaded.
- The renderer start-up tries the same values first.

## New in v1.32

- ATRAC9 playback: the AJM job flags no longer carry a stray `0x8`. The codec type had been
  written into bits 3-10 of the job word, which are codec-specific FLAGS; the decoder answered
  `0x80000080` (UNSUPPORTED_FLAG | FATAL) on the initialize job. Control job is now
  `version | 0x6000`, run job `version | 0x800000001000`.
- If the console still refuses, two more job shapes are tried and every answer is shown in the
  codes line: `initA` = version+reset+init, `initB` = version+init, `initC` = reset+init with
  no version bits.
- Full compile (OpenOrbis toolchain-llvm-18 with the repository's current headers). `lstat` and
  `utimes` are taken from libkernel, as in v1.30: remove `lstat.lo` and `utimes.lo` from the
  toolchain's `libc.a` before linking (`llvm-ar d libc.a lstat.lo utimes.lo`).

## New in v1.29

**GPU probe, round 2.** The v1.28 results on firmware 6.72 showed:

* Piglet loads from `/system/common/lib` and accepts every configuration.
* Every filled-in configuration gives *no display*.
* An **empty** configuration gives a display, `eglInitialize` works (EGL 1.4, 16 configurations) and a window surface is created, but `eglCreateContext` returns nothing.
* A test with no display leaves nothing behind. Once a display exists, Piglet keeps it for the rest of the run.
* The app died in EGL clean-up every time a display existed.

The probe now has nine tests. Each starts from the empty configuration and adds **one** field:

1. System memory
2. Video memory
3. Flexible memory
4. Draw buffer
5. LCUE buffer
6. Screen size
7. Field 0x5C
8. Flags and order
9. Empty (control)

Tests with no display keep going. The first test that gets a display tries three ways of making a context and then stops the run. EGL clean-up is skipped.

**Restarting.** After a test gets a display, restart the app and run the probe again. It continues at the next test by itself. The position is stored in `gpu_probe_next.txt`. A run that continues adds to `gpu_probe.txt` instead of replacing it. Running from test 1 starts a new file.

**Memory check.** Before the tests, the probe checks how much memory the app can get by itself:

* the largest free direct-memory block
* direct-memory allocations of 2, 36 and 128 MB
* 170 MB of flexible memory
* 2 MB of system flexible memory

Piglet's results can then be compared with these.

## New in v1.28

**GPU probe (TOOLS tab, last entry).** The GPU renderer still fails on firmware 6.72 at `eglGetDisplay`. The probe tries seven different Piglet set-ups one after another, stops at the first that gives a working GL context, and writes everything to `/data/StarOceanUtility/gpu_probe.txt` (also shown on screen when it finishes; press R1 for the end, where a summary lists each test).

* Each step is saved to disk *before* it runs, so if the app crashes, the last line in the file names the call that did it.
* It records: firmware, PS4 Pro or not, free flexible memory, every library loaded in the process, the result of loading Piglet from several paths (including what `module_start` returned), the result of hiding the splash screen as the OpenOrbis sample does, whether `scePigletSetConfigurationVSH` accepts each configuration and what `scePigletGetConfigurationVSH` reads back, every EGL error code, the list of EGL configurations, and (if a context works) the GL version, GLSL version, limits and a test shader compile. A working set-up flashes the screen green for a second.
* Tests: 1 RetroArch values; 2 OpenOrbis sample values; 3 small flexible memory; 4 without the flexible-memory flag; 5 flags 0; 6 empty configuration; 7 as 1 but without handing the screen over (display and initialize only).
* *Left/right* on the entry picks which test to start at. If every test fails identically, restart the app and run again from test 1: Piglet may keep the first configuration it was given in a process.
* The loader now also logs `module_start` for Piglet in the normal GPU log.

## New in v1.27

**FILES list: type column, picture sizes, sorting.**

* *Type column* next to the size: Audio, Texture, Image, Model, Animation, Text, Pack, Archive and so on. It comes from the file extension; files whose extension says nothing (`.bin`) are identified from their first bytes when they scroll into view. Formats the tool does not know stay blank.
* *Picture size* (for example `2048x512`) next to textures and images: `.aif`, `.dds`, `.png`, `.bmp`, `.tga`. For an `.aif` with several images it is the first one.
* *R3 changes the sort order:* name, size (largest first), format (type, then extension, then name). Folders always stay on top. The current order is shown at the top right. Files not yet identified sort last under "format".

## New in v1.26

**Sound player: retry for the error seen on firmware 6.72.** The PS4 reported `AJM batch start failed (0x8093000e)`: the audio library loaded, the ATRAC9 codec registered and the decoder instance was created, but the first job was refused when it was submitted. That code is believed to mean "bad priority" (the tool passed priority 0). The tool now retries the submit with other priority values, keeps the first one that is accepted, and writes it to the log and the error line as `prio=N` (`prio=-999` = none accepted). Not confirmed on a PS4 yet.

## New in v1.25

From the v1.22/v1.23 log sent from a PS4 on firmware 6.72:

* **Sound player.** The log had no `Sound:` line at all, so the player was never opened: pressing ✕ on an exported `.at9` did nothing, because only the game's own `.aac` containers were recognised. Now ✕ on a `.at9` opens the player too, and every open is logged (`Sound: opened ...`), including files with no sounds. Whether the PS4's decoder then accepts the data is still unknown - the next log will say.
* **GPU renderer.** The log showed `GPU start failed at: eglGetDisplay (EGL 0x3000)`: the libraries loaded and the shader table was found, but Piglet gave no display. v1.22 asked Piglet for very large memory pools (512 MB video). It now first tries the small pools other PS4 homebrew uses (36 MB video), then the large ones, and logs each attempt. This is a likely cause, not a confirmed one.

## New in v1.24

**Model viewer (CPU renderer): sharper, smoother picture.** v1.23 picked one texture pixel per screen pixel with no filtering, lit each triangle as a flat facet, and drew at 1280x720 stretched to the screen. That gave blocky, speckled surfaces.

* *Smaller copies of every texture* (mip levels) are made when a model opens, and each triangle uses the copy that matches its size on screen. This removes the speckle on far or small surfaces.
* *Smooth lighting* from the model's own vertex normals instead of one brightness per triangle.
* *Two speeds.* While you rotate, pan, zoom or spin, the picture is drawn fast at 1280x720. A moment after you let go it is redrawn once at 1920x1080 with bilinear texture filtering.
* Checked on a PC on packs 00686, 01554 and 01664. Not yet run on a PS4.
* A model whose own textures are small (distant ships, for example) will still look soft up close: that detail is not in the file.

## New in v1.23

**Model viewer: models are now assembled and textured properly.** Checked against the uploaded packs 00686, 01554, 01591 and 01664.

* *Parts are put where they belong.* Each object's position, rotation and scale is read from the model's scene tree (parents included), so walls, lamps and props no longer pile up at the centre. An object used by several nodes is drawn once per node.
* *No more skipped meshes* on the test packs (was 16 to 36 per model). Two causes: vertex layouts with a second colour set, and meshes that were matched to the wrong body when an object stores several bodies before its mesh records.
* *Textures on almost every mesh* (01554: 355 of 366, was 173). The texture is now chosen per material from its colour maps (normal maps and masks are passed over), and shared textures are decoded once.
* *Surfaces no longer vanish or turn grey.* Most textures use their alpha channel for gloss, not opacity. Alpha is now only treated as a cut-out when it really is a mask.
* *Hidden in the viewer only:* shadow/collision hulls (meshes without texture coordinates) and a sky dome that wraps a whole scene. The `.glb` export still contains everything.
* *Framing* ignores far-away outliers (a marker two million units away used to shrink the scene to a dot). Helper objects the game hides by scaling them to nothing are shown at full size.
* Not done yet: vertex colours, normal/specular maps, textures stored in separate `.aif` files, skeleton poses.

**Sound player:** when a sound cannot be decoded, the screen now also shows the return codes from the PS4 audio library (the same text as the `Sound:` line in the log), so a photo of the screen is enough to report it.

**Where the log is:** `/data/StarOceanUtility/log.txt` unless you moved it. TOOLS tab > *Log file location* shows the path; to move it, open the folder you want in FILES (for example on the USB drive) and choose that entry. The LOG tab shows the same lines on screen.

## New in v1.22

**Experimental GPU renderer for the model viewer.** In the 3D viewer press **L3** to switch from the CPU renderer to the console's graphics chip (OpenGL ES 2 through the PS4's own Piglet library). L3 again switches back. It is never started automatically, and it is not remembered between launches.

* Two sets of shaders, tried in this order (the top line of the viewer says which one is in use):
  1. *GLSL shaders* written for this tool (in `source/src/gpu.c`): per-vertex texture coordinates and normals, smooth lighting from the camera, alpha cut-out, one draw call per mesh. They are compiled on the console. Retail Piglet only compiles GLSL when its shader compiler is enabled, so this step may be refused.
  2. *System shader*: the precompiled "texmap" shader that ships with the firmware (the web browser's layer shader). It cannot take per-vertex UVs, so every triangle is drawn on its own with matrices that map a unit triangle onto its corners and UVs; lighting is per triangle. Slower, but needs no compiler.
* If neither works, or any start-up step fails, a notice names the step and the CPU renderer stays in use. Every step is written to the log on lines starting with `GPU:`.
* Once the GPU renderer has started, the rest of the UI is shown through it too (the finished frame is drawn as one textured rectangle), because the screen cannot be shared.
* Checked on a PC with a real OpenGL ES implementation (Mesa): both shader sets draw the same picture as the CPU renderer (outline difference under 2 % on the test models), with and without a depth buffer, and the failure path falls back cleanly. **Not yet run on a PS4.** Nothing is linked into the app for this - the libraries are loaded only when L3 is pressed - so the rest of the tool is unaffected if they are missing.
* The viewer uses each material's main colour texture when it is stored inside the same `.asf`. Textures in separate `.aif` files and normal/specular maps are not used yet.

## New in v1.21

**Viewers.** In FILES, ✕ on a file now opens the viewer that fits its contents (ZIP/RAR/7z still extract, images still open in the image viewer; □ still selects):

* *3D model viewer* (`.asf`): the model is drawn by the console's CPU, textured, with lighting. Left stick or D-pad rotate, right stick pans, L2/R2 zoom, ✕ spins it, △ textures on/off, R3 wireframe, □ resets the view, L1/R1 go to the previous/next model in the folder, ○ back.
* *Sound player* (`.aac`): decodes the game's ATRAC9 audio with the PS4's own audio hardware (libSceAjm) and plays it; the background music is muted meanwhile. ✕ play/pause, □ restart, Left/Right switch sounds inside a bank, L1/R1 previous/next file, △ save as `.at9`, OPTIONS save as `.wav` (decoded PCM). If the hardware decoder is not available on your firmware, the screen says so (the return codes are in the log) and △ still exports the `.at9` for a PC.
* *Text viewer* for game text tables (`EXD`, shown as `.bin`), plain text files (logs, `names.txt`), and a *hex viewer* for everything else. The console font has no Japanese glyphs, so Japanese lines are marked as such; Unpack writes them to a `.txt` you can read on a PC.

**Unpacking** now also writes `.at9` next to every `.aac` (checked: 659 of 660 sound banks here decode cleanly with ffmpeg's ATRAC9 decoder; the music is 4-channel ATRAC9) and a `.txt` next to every EXD table that contains text.

**Names**
* Shown on every row now, not just the highlighted one. Rows the index has no name for are read from the data and filled in a few at a time while you look, so scrolling stays smooth.
* Works for the `0001_unpacked/01664/` layout that batch scripts make, not only `01664_unpacked/`.
* `0000.bin` / `0001.bin` are no longer mistaken for packs 0 and 1.
* Junk "names" that are really bytes of pixel data (`VVUUU0`, `nqecvkqp`, `tEXtSoftware`) are filtered out, including from an existing `pack_names.txt` - no need to re-run the Name finder.
* *Search names* uses a built-in letter keyboard, so ○ can no longer close it by accident (the PS4 keyboard is still one key away).

**What is in the archives** (from your inner header list, IDs below 10000): 33,671 AAC sound banks, 22,830 AAF animations, 6,756 ASF models, 3,339 ACF collision files, 2,760 AIF texture sets, 4,029 EXD tables (game text and data, e.g. pack 00000), 305 SNC scene scripts, 330 ERT trees, and two kinds not identified yet (7,657 `pDCM`, 634 `MMD 10.1`).

## New in v1.20

Three new items in **Archive tools** (open `0000.bin` / `0001.bin`). Nothing is extracted; the archives are only read.

* *Inner header list* writes `inner_headers.txt` (and `inner_headers.zip`) to the output folder: one line per entry of every KCAP pack. Columns: pack ID, entry number, entry type (hex, the u16 at +0 of the KCAP entry), flags (u16 at +2), size, SLZ mode (0 = raw), full unpacked size, the first 32 bytes as hex and as text, and up to 3 readable text runs found in the first 64 KiB (`u:` marks UTF-16 text). Only the first 64 KiB chunk of each SLZ entry is decompressed, so it is quick. IDs that are not KCAP packs get one line marked `(not a KCAP pack)`.
* *Name finder* decompresses every entry in memory and collects names: runs of 6+ of `A-Z a-z 0-9 _ - .` that start with a letter and contain a lowercase letter, digit or `_`. To keep pixel and vertex data out, a name must also be a C string (control byte before, NUL after) and not look like noise (no 4 equal characters in a row, at least half the characters distinct, and an `_`, three lowercase letters in a row, or CAPS+digits). It writes:
  - `names.txt` - pack, entry, type, name; each name once per pack
  - `names_by_prefix.txt` - names grouped by the prefix before the first `_` or digit (`EF`, `pc`, `co`, `em`, `e` ...), with the number of names, the number of packs and every pack ID, largest groups first
  - `pack_names.txt` - a display name for every pack and entry (the most common asset code, e.g. `cp005  cp005_top`, `em016  em016_b01a`)
  - `names.zip` with all three. `names.txt` and `pack_names.txt` are also copied to `/data/StarOceanUtility/` so the names keep working if you change the output folder.
* *Search names*: type a word (`Fire`, `pc01`, `cp005`) and every matching pack + entry is listed on screen. Case, `_`, `-` and `.` are ignored, so `pc01` finds `pc_01_eye1`. ✕ on a result jumps to that pack in the file list; △ searches again. All matches are also saved as `search_<word>.txt`.
* *Skip IDs 10000 and up* (on by default, remembered): the remastered copies are left out of both lists. Turn it off to include them.
* *Names while you scroll*: after the Name finder has run once, the file list (View file list on screen) has a Name column, and FILES shows the name next to `NNNNN_unpacked` folders, the files inside them (`001.aaf` -> its entry's name) and `NNNNN.bin` packs. Without the index, the highlighted row's name is worked out on the fly from its data.
* Batch scripts: `innerheaders [all] [archive|folder...]` and `names [all] [archive|folder...]`. A folder of extracted `NNNNN.bin` packs works too.

## New in v1.19

* *tri-Ace ASF models -> glTF.* Star Ocean 4's `.asf` files (from KCAP packs) are the game's 3D models. They are now converted to standard glTF 2.0 binaries (`.glb`): automatically when a pack is unpacked (`429.asf` -> `429.glb`), or on their own with Unpack/convert. A `.glb` opens directly in Blender, Windows 3D Viewer, Godot, Unity, and web viewers such as gltf-viewer.donmccurdy.com.
  - Each mesh becomes a primitive with positions, normals and texture coordinates; the material's first texture is decoded and embedded as PNG when it lives in the same file. Triangle winding is converted to glTF's counter-clockwise convention.
  - The index buffers in the PS4 version are stored with tri-Ace's own compression. The decoder is a port of the routine in the game's executable and reproduces the exact triangle count on all 2,406 meshes in the test set (691,558 triangles), with every index in range. Vertex layouts were verified against the strides of all meshes (skin weights sum to 65535, normals are unit length).
  - Not yet exported: skeletons/skinning (weights and bone indices are read but a glTF skin needs the bone tree, planned), animations (`.aaf`), and the second UV set.
* *AIF textures:* BC1, BC2, BC3 (the common colour format) and BC5 (normal maps, shown as tangent-space colour) are now decoded in addition to BC7 and RGBA8, so most character and world textures convert.
* The Unpack/convert help text lists AIF and ASF.

## New in v1.18

* *tri-Ace AIF textures -> PNG.* Star Ocean 4's `.aif` files (found inside KCAP packs) are texture sets, not audio. They are now converted automatically when a pack is unpacked (`000.aif` -> `000.png`, `000_1.png`, ...), can be unpacked/converted on their own, and open in the image viewer (first image; the title shows "image 1 of N").
  - Formats: BC7 (format 0x2E) and 32-bit RGBA (format 0x08), both stored in the PS4's 8x8-tile layout, which is undone.
  - Checked on 31 AIF files (49 images) from the game: every PNG matched an independent reference decoder pixel-for-pixel. For the RGBA kind the channel order is assumed R,G,B,A.
* *BC7 decoder* (all 8 modes) - also used for DDS files with BC7 (DXGI 97-99), which the tool could not open before. Verified bit-exact against a reference decoder on 131,072 random blocks.
* Other AIF pixel formats are reported in the log with their format number instead of being guessed.

## New in v1.17

* *Extract by ID* and *Dump a byte range* now use a built-in number pad instead of the PS4 system keyboard (on some consoles one ✕ press closed the system keyboard straight away). D-Pad to move, ✕ to press a key, □ delete, △ space, R2 or *Done* to run, ○ to cancel. Keys: 0-9, A-F, `x`, `-`, Space, Delete, Clear.
* The pad remembers your last entry, so running the same list again is one press.
* *PS4 keyboard* on the pad still opens the system keyboard (for typing file names), pre-filled with what you entered.

## New in v1.16

* On-screen keyboard: on the PS4 keyboard, R2 (Done) confirms and ○ closes it without a value. Every prompt title now says "R2 = Done".
* If the keyboard is closed with ○ after you typed something (e.g. a list of IDs), the app shows what you typed and offers ✕ Use this text / ○ Discard, so the typing is not lost.
* The log now records how the keyboard closed (end status and how long it was open), to make keyboard problems easy to diagnose.

## New in v1.15

* Fixed: in TOOLS, the last two rows (Homebrew service ports, Run a batch script) were drawn underneath the Recent log panel. The log panel now always starts below the last row.

## New in v1.14

* *Magic survey* (ARCHIVE TOOLS, and the `magic` script command): reads the first 32 bytes of every file in both Star Ocean 4 archives and writes a tiny `magic_summary.txt` (format counts, and a PLAIN / SCRAMBLED verdict) plus `magic.txt`. Run it before Extract ALL. It writes nothing but those two text files.
* *Batch script runner*: highlight a `.txt` in FILES, OPTIONS, *Run this batch script*. It only automates this app's own file operations (never console code): `cd`, `dest`, `list`, `magic`, `extract`, `extractall`, `unpack`, `unpackid`, `convert`, `dump`, `copy`, `zip`, `mkdir`, `echo`, `stop-on-error on|off`. `*` wildcards work, trailing `# comments` are allowed, output only goes to `/data`, USB or extended storage, and a `script_log.txt` summary is written next to the results. TOOLS shows a sample (`sample_script.txt`).
* *Verify file* (OPTIONS): shows size and SHA-256 of the highlighted file so you can compare it with an official release hash. It only reads the file and never runs it.
* *Homebrew service ports* (TOOLS): view and edit the loader (9020), debugger RPC (744), FTP (2121) and kernel log (3232) port numbers, with a one-line explanation of each. Saved in settings; this version stores the numbers only and does not open any network listener.
* Fixed: the progress overlay title list was too short for the Unpack and Script jobs.

## New in v1.13

* On-screen image viewer for DDS / PNG / TGA / BMP: zoom, pan, background choice, previous/next image, save as PNG
* View image entries straight from game archives (□ in the file list viewer)
* Images are highlighted in the file explorer and kept visible by the △ filter

## New in v1.12

* Unpack / convert engine: KCAP/SLZ, PSARC, Wwise .pck/.bnk, CRI AFS/AWB, LZ4, DDS → PNG (see above)
* FILES → OPTIONS → Unpack / convert; Archive viewer △ unpacks an entry in place; "Unpack every recognised file"
* The format column knows PSARC, AFS/AWB, LZ4, HCA, ADX

## New in v1.11

* *Extract by ID* takes several IDs and ranges at once (`0-3 10 100 656 657`)
* IDs are read as decimal, so leading zeros work (`00010` = 10; previously `010` was read as octal)
* If the keyboard closes without a value, the app now says so (and logs why) instead of doing nothing
* Leaving Archive tools refreshes the file explorer, so new `0000` / `0001` output folders appear immediately

## New in v1.10

* *Save file lists* writes the lists of both Star Ocean 4 archives at once, with a readable size and format column
* New on-screen file list viewer with size and format; ✕ extracts the highlighted file

## New in v1.09

* Reads Star Ocean 4's real archive format: the scrambled ID index in 0000.bin, extraction by ID, and Extract ALL for both archives

## New in v1.08

* The Star Ocean 4 shortcut also searches USB drives and extended storage for 0000.bin / 0001.bin, for example a game dump on USB

## New in v1.07

* CPK archive tools (above), with a Star Ocean 4 shortcut in TOOLS and *Open as CPK archive* in the OPTIONS menu

## New in v1.06

* **New folder**, using the PS4 on-screen keyboard
* **Sizes now use decimal units** (1 GB = 1,000,000,000 bytes), the same as FTP apps, phones and drive labels. Before, a 39.07 GB file showed as "36.39 GB". The file itself was always fine; only the unit differed.
* **Log lines are no longer cut off.** Long paths were truncated at 160 characters, so the end of a "moved ... -> destination" line was lost. The log file now keeps the full line.
* The sandbox-escape (GoldHEN) step uses a padded buffer and logs how long it took.

## Fixed in v1.05 (found on real hardware)

* **Delete did nothing but reported success.** On PS4, the C library's `lstat()` always failed with "not implemented", so every item looked "already gone". It now uses the kernel's real `lstat`. Each delete is also verified afterward, and anything that couldn't be deleted is reported with the reason.
* The same `lstat` bug broke Copy, made ZIP skip files in subfolders, and could let a copy or move overwrite an existing file. All fixed. Copies now refuse to overwrite at all, and moves check that the target name is free.
* **No background or music on the console.** After the jailbreak, `/app0` no longer points at the app, so `bg.bin` and `music.pcm` were never found. Assets are now loaded before the jailbreak, with the real sandbox paths as a fallback.
* The nebula now shows through the panels.
* Your PlayStation button icons are used throughout. The checkerboard backgrounds were cut away.
* Empty USB slots (`/mnt/usb1-7` with nothing plugged in) are no longer listed.
* The list refreshes as soon as an operation finishes.

## Fixed in v1.04 (black screen on first boot)

* The display wait could block **forever** if the PS4 rejected or never completed a frame flip. That would freeze the app on a black screen. It now gives up after about 0.3 s per frame and logs the problem.
* If the audio port kept returning errors, the music thread retried instantly in a 100% CPU loop that could starve the UI. It now pauses between retries and turns music off after about 2 s of errors.
* A "Starting..." frame is drawn before anything is loaded, and the log records `boot: first frame shown`.
* Display and audio trouble is written to the log every 5 seconds while it continues.

If the app ever freezes on a black screen, wait about 10 seconds before closing it. Then copy `/data/StarOceanUtility/log.txt` off the console (GoldHEN FTP, or the app's Copy on the next launch). The last `boot:` line shows how far startup got.

## Fixed in v1.03 (found on real hardware)

* **Wrong file sizes.** The PS4 C library's `struct stat` had a 4-byte mode field where the PS4 kernel uses 2 bytes, which shifted every later field. File sizes actually showed the disk-block count, about 1/512 of the real size. Copy, cross-drive move and ZIP creation would have failed, and extraction was slow. The struct now matches Sony's `OrbisKernelStat` field for field.
* **Free space was garbage.** `statvfs()` on PS4 never filled in its result, and `statfs()` returned the file descriptor instead of a status. Both are fixed.
* **Laggy interface.** Panels were blended by reading pixels back out of video memory, which is very slow for the CPU on PS4. Frames are now built in normal RAM and copied to the screen once. The blend math is division-free, and the screen is only redrawn when something changes.
* **Startup checkpoints in the log**, so a failed boot shows exactly how far it got. This includes a file-size self-check.

## New in v1.02

* Copy, Move and Delete in the OPTIONS menu, with the safety guards above
* Long messages in dialogs now wrap instead of being cut off
* The log folder and settings folder are recreated automatically if you delete them

## Fixed in v1.01

* Audio now opens as the system user, the same way the OpenOrbis audio sample and Apollo do. Before, the music might not have played.
* The file list no longer queries free space 60 times a second.
* Pick mode can now be cancelled from the device list.
* Fixed a stale-pointer bug when the list refreshes after a job.
* TOOLS and the actions menu no longer share one cursor.
* ZIP: never includes the zip file itself, even when it's created inside a selected folder.
* ZIP: unreadable files are skipped with a warning instead of leaving a corrupt entry.
* ZIP: read errors fail the job cleanly instead of writing a truncated entry.
* ZIP: symlink loops can't cause endless recursion.
* ZIP: folders like `/data/Files` vs `/data/FilesX` no longer mix up names.
* ZIP: selecting a folder and a file inside it no longer adds the file twice.
* ZIP: writes in 1 MB blocks, so it's faster.
* Extraction: files that aren't archives are reported as "Not a recognized archive" instead of being copied as-is.
* Log timestamps use the PS4's local time and include the date.

## Not included

* Save-data decryption and export was deliberately left out.
* Password-protected archives are not supported, and neither are classic split ZIPs (`.z01` + `.zip`).

## Testing status

* The PS4 build compiles and links cleanly. All imports resolve to libkernel, ScePad, SceUserService, SceVideoOut, SceSystemService, SceAudioOut and SceSysmodule.
* The full UI ran on Linux with the PS4 system calls faked. I scripted the controller and captured screenshots of every tab and dialog.
* ZIP creation was verified with CRC checks, plus a 4.5 GB ZIP64 file read back correctly. Extraction uses the same engine as PS4 Archive Extractor, which was tested against RAR4/RAR5/7z multi-part sets and ZIP64.
* CPK tools: checked against archives made by an independent CPK builder (PyCriCodecs), covering named TOC, ID-only ITOC, XOR-encrypted tables, alignment and CRILAYLA compression. Every extracted file matched its source byte for byte, as did resume, keep-raw, header dump and range dump. Damaged and truncated archives are reported as errors. 300 randomly corrupted archives ran under AddressSanitizer with no memory errors. These were test archives, not the real Star Ocean 4 files, which I don't have.
* v1.01 to v1.06 were tested on your PS4. **v1.07/v1.08's CPK screen has not run on hardware yet.** If anything goes wrong, check the log file first.

## Rebuilding from source

On Linux or WSL, run `source/build_deps.sh`. It builds the OpenOrbis toolchain, zlib, liblzma and libarchive, then the app. `source/tools/make_assets.py` regenerates the background, music and icon from your image.
