# Facial Selector Audit and Native Evidence Hunt — V5.12.2 Pass V2 (HISTORICAL)

> The static facts remain provenance, but V5.12.4 supersedes the two-palette
> premise and closes the actor `0x0BC0` static face-preview gate with the GS
> CSM1 IDTEX4 logical-CLUT mapping.

Actor `0x0BC0`. Gate: `facial_frame_palette_selector`. Status after this pass: **UNRESOLVED — not promoted.**

This pass performed an independent byte-level audit of the packaged fixtures (no prior report was trusted), found one new structural correlation the earlier passes did not record, established that the supplied static evidence cannot verify the runtime selector, and shipped a browser-only, read-only evidence probe that collects the smallest missing evidence from the user's own ISO. Every V5.12.1 feature is preserved; nothing repaints textures; no automatic face selection was enabled.

## 1. Independent audit — verified facts (byte-exact against fixtures)

Fixture `03_TESTS/fixtures/model/03_CHAR_00000BC0.bin` (133,600 bytes, XBDC container, segment 0 at `0x20`):

- Material reference table at `0xDD24` (`seg0+0x50` declared slots = 3, `seg0+0x58` relative = `0xDD04`). Packet-start qwords `0xA / 0xC87 / 0xD56` → file offsets `0xA0 / 0xC870 / 0xD560` (packets 0, 82, 87). **CONFIRMED.**
- Dynamic records at `0xDD38` and `0xDD48`, 16-byte layout `{label[4], base_texture_id u32, slot_ordinal u32, frame_last_index u32}`:
  `{'naka', 1294, 1, 2}` and `{'naka', 2413, 2, 3}`. **CONFIRMED.**
- Eight FIS sections (body 1289 plus the seven facial members). Two FISA groups: `0x14400` (count 3 → 1294, 1295, 1296) and `0x16E80` (count 4 → 2413, 2414, 2415, 3362), stride `0xA80`, keys arithmetic (`0x10 + i×stride`), every key resolving to the exact preceding FIS section. **CONFIRMED.**
- **FISA pair values are uniformly 1** across all seven members of both groups. A constant carries no frame-discriminating signal, so the pair value *cannot itself be the frame selector* on this fixture. **NEW, VERIFIED.**
- TEX0 material state: each segment-0 material carries `ALPHA_1`, a TEX0 template (PSM preset — `0x13` PSMT8 body, `0x14` PSMT4 face — TCC=1, **TBP0=TBW=TW=TH=CBP=CSA all zero**), a TEX0 duplicate whose register high bits carry a 16-bit value, then zeroed placeholder TEX0 qwords. The runtime must patch texture addresses **and the CLUT bank** at draw time. **NEW, VERIFIED.**
- The 16-bit high-register value is **2869 (0xB35) on all three segment-0 slots** (`0x110`, `0xC8E0`, `0xD5D0`); the segment-1 material carries 2621 (0xA3D) at `0x1AC00`. A value shared by body and both facial slots **refutes** the per-slot texture-selector reading of the V5.8 "runtime patch id candidate". Working hypothesis (not promoted): an actor/upload-group handle. **NEW, VERIFIED (sharing), UNRESOLVED (meaning).**

Fixture `03_TESTS/fixtures/model/FAS_00200BC0.fas` (6,800 bytes):

- Four `type_0x0021` event sub-blocks (16-byte header, mark raw bytes `01 0C`, count 1, size `0x30`, aux `0x0201`; payload = four ASCII bytes + u16 id + zero padding):

  | header off | tag | u16 id | channel (h1) |
  |---|---|---|---|
  | `0x1890` | `naka` | 1291 (`0x50B`) | `Nnpu_soncyou` #1296 |
  | `0x18C0` | `naka` | 1290 (`0x50A`) | `Nnpu_soncyou` #1296 |
  | `0x1980` | `naka` | **1294** (`0x50E`) | `SHADOW` #454 |
  | `0x19B0` | `naka` | **2413** (`0x96D`) | `SHADOW` #454 |

- Two of the four ids are exactly the two facial-family **base** texture ids declared by the FPS `naka` dynamic records. The same four-byte tag string binds producer (FPS records) and animation event stream (FAS). **Presence: STRUCTURAL. Semantics: UNRESOLVED** — the executable consumer has not been located, so per the acceptance criterion this stays a candidate, not a selector map.

## 2. Registry hygiene candidates (additive; packaged registry untouched)

- `formats[1] … type_0x0021` lists tags `('naka','nakam')`. The event at `0x19B0` shows `'nakam'` is a **candidate misparse**: bytes `6E 61 6B 61 6D 09` are `'naka'` + u16 `0x096D` (2413) whose low byte `0x6D` renders as a fifth letter. The 2413 family would read as `nakam/nakan/nakao` in naive ASCII dumps.
- Sub-block marks: raw bytes are `00 01` (data) and `01 0C` (event); the registry text mixes endian readings.

## 3. Why the selector cannot be verified from this handoff

The handoff contains **zero game-executable bytes** (the only ELF is a 700-byte synthetic test vector). The audited TEX0 templates have zero texture-address and CLUT fields, and no explicit palette-bank field was identified in the audited FPS dynamic records, FISA pairs, or four observed `naka` events. A later runtime or material-preparation stage must supply complete TEX0 state before GS consumption, but the responsible routine and patch timing remain **UNRESOLVED**.

**Smallest missing evidence (two items):**
1. One decoded executable image — the main `SLES/SLUS` ELF or the overlay module holding the model/texture manager — exhibiting a code cluster that materializes the `FISA`/`FIS\0`/`naka` constants or the family ids and indexes the FISA pair table.
2. A targeted R5900 execution of that routine (the existing V5.10 harness) over the fixture FPS bytes, showing the selected member offset and the patched TEX0 `CBP/CSA` for both palette banks.

## 4. What V5.12.2 ships to close that gap (browser-only, read-only, mobile-safe)

The probe card inside the **Runtime Reconstruction** tab now includes a one-tap **Run complete evidence hunt** action. The Explorer's Command Runner accepts declarative JSON rather than arbitrary JavaScript, so the same hunt is also registered as the native `facial_selector_evidence_hunt` command action.

- **FAS naka-event scanner** — mechanical 16-byte-aligned sub-block enumeration with best-effort channel attribution, over selected files or decoded project FAS nodes. Real-fixture regression pins the four events above.
- **Independent CHAR facial-state audit** — re-derives table/records/FISA/TEX0 facts from raw bytes (shared implementation between browser and Node tests).
- **Executable constant scanner** — bounded R5900 scan of ELF32/MWo3/RAW images (project `SL*` nodes, hidden-entry-2 MWo3 blocks decoded locally, or selected files) for `lui/ori|addiu` pairs materializing `0x41534946`/`0x00534946`/`0x616B616E`, family-id immediates (1294–1296, 2413–2415, 3362, 2869, 2621), and small-frame compares; emits capped clusters and hex windows (`±0x40`, ≤48 windows, ≤512 hits, ≤8 MiB per module).
- **Direct ISO executable discovery** — reads the visible `SLES/SLUS` file from the ISO filesystem and all decoded hidden-entry-2 MWo3 blocks without requiring V5 workspace expansion.
- **Direct indexed FAS sweep** — decodes up to 64 unique animation resources from the packaged actor index, then adds any already-loaded FAS nodes and re-derives actor `0x0BC0` CHAR state directly from its indexed ISO extent.
- **Exports** — `SO3_FACIAL_SELECTOR_PROBE_REPORT.json`, `SO3_ATLAS_FACIAL_SELECTOR_CANDIDATE_UPDATE.json`, and a clean store-ZIP with SHA-256 sums. Every record is labeled candidate evidence; `promotion: false` is structural.

Failure boundaries are explicit in every export: original source size, scanned byte range, scanned-prefix SHA-256, whole-source SHA-256 only when complete, scan byte caps, hit/window caps, small-frame-compare cap (8192), alignment assumptions of the FAS scan, and channel attribution as best-effort. A negative result applies only to its recorded scan range.

## 5. Verification path after this pass

Run the probe against the open ISO. If a cluster couples a `FISA`/`naka` constant with family-id immediates, feed that module and VA into the V5.10 targeted runtime with the fixture FPS mapped; a run that outputs a member offset and patched `CBP/CSA` for both banks is the promotion evidence. Until then the Model Lab keeps manual frame/palette inspection and the gate banner.

## 6. Regression coverage added

`03_TESTS/test_v5122_facial_probe.js`: real-fixture FAS events (exact offsets/ids/channels, no phantom `nakam` tag), real-fixture CHAR re-derivation (table `0xDD24`, uniform pair value 1, shared 0xB35, zero template addresses), synthetic FAS misparse regression (id low byte `0x6D`), synthetic RAW/MWo3/ELF32 constant clusters with bounded windows and VA mapping, scrambled negative control, and report invariants (`gate_status UNRESOLVED`, `promotion false`, two smallest-missing-evidence items). Release checks pin the probe modules, load order, branding, and the new Atlas update schema.
