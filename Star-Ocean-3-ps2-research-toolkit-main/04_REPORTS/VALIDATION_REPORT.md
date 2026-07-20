# V5.12.4 validation report

## V5.12.4 facial-CLUT regression

- Palette-transfer audit: **PASS** — all seven facial FIS resources upload 32
  PSMCT32 entries as a 16×2 image while CSM1 IDTEX4 consumes one 8×2 logical
  CLUT.
- Logical CLUT mapping: **PASS** — colors 0–7 use stored entries 0–7 and colors
  8–15 use stored entries 16–23. Stored entries 8–15 and 24–31 are transfer-row
  padding for this use, not two palette banks.
- Opacity audit: **PASS** — every texel index used by all seven facial sheets
  resolves to an opaque logical CLUT entry. The former decoder mapped 17.48%
  to 36.30% of each sheet through transparent padding, producing the dark
  perforated face.
- Decoder comparison: **PASS** — swizzle and nibble decoding are preserved;
  only the GS CSM1 palette addressing step is corrected.
- Filtered preview: **PASS** — WebGL uses linear minification/magnification by
  default, retains an explicit raw-nearest toggle, and opens FIXED actors facing
  forward.
- Selector boundary: **PASS** — FISA member selection is verified by R5900
  execution. A palette-variant selector is not applicable because every
  observed facial FIS has one logical CLUT. The static preview holds the base
  member because animation-clock playback is not implemented.

## V5.12 material and mobile regressions

- FPS material table: **PASS** — table `0xDD24` resolves all three qword starts
  exactly to packets 0, 82, and 87.
- Facial family bindings: **PASS** — slot 1 resolves to 1294–1296 and slot 2
  resolves to 2413–3362; both frame cardinalities agree with FISA.
- Static body binding: **PASS (STRONG_INFERENCE)** — FIS 1289 and slot 0 are the
  sole remaining ungrouped texture / UV-bearing slot.
- Auxiliary layer guard: **PASS** — slot 3 has zero UV variation, 319/492 exact
  overlapping positions, and is hidden by default without being discarded.
- Per-material renderer: **PASS** — draw batches bind textures by material slot;
  a selected face frame no longer repaints the body.
- Empty mobile selection tray: **PASS** — zero selection collapses the sticky
  tray and mutation tracking restores it for nonzero selection.

## Automated suites

- JavaScript exact movie decoder: **15 checks, 0 failures**.
- JavaScript SAC audio decoder: **11 checks, 0 failures**.
- JavaScript MPEG/LPCM muxer: **19 checks, 0 failures**.
- V5.8 stable-ID, label-package, sorting, and filtering suite: **PASS**.
- V5.8 real-fixture model assembly suite: **PASS**.
- V5.11 aligned texture/FISA regression suite: **PASS** — actor `0x0BC0`
  exposes eight FIS images / eight logical CLUT outputs; both FISA groups
  resolve exactly.
- V5.12.4 external static-trace audit: **PASS** — every cited Lib word and
  direct `jal` xref is reproduced, while the fixture proves record `+8` is FPS
  slot ordinal `1/2`, not FAS/texture ID `1294/2413`.
- V5.11.1 direct-ISO actor-range regression suite: **PASS** — all nine indexed
  `0x0BC0` child extents are read, decoded, signature-gated, and assembled.
- V5.11.2 Safari shader regression: **PASS** — the fragment shader no longer
  declares the reserved identifier `flat`; the replacement is `flatColor`.
- V5.11 canonical texture census: **PASS** — 13 fixtures, 184 aligned sections,
  175/175 FIS parses and decodes, 9/9 FISA parses, and 34/34 group members.
- Python reference movie decoder: **5 checks, 0 failures**.
- Preserved V5.2 identification core: **27 checks, 0 failures**.
- Preserved V5.5 integration smoke/regression suite: **PASS**.
- V5.8 release/static/determinism suite: **PASS**.
- V5.8.1 historical-claim suite: **PASS** — 156 claims, one conflicting key,
  disc gate, catalogue search, and non-automatic application verified.
- Legacy index regeneration: **PASS** — packaged source text reproduces the
  JSON and embedded JavaScript byte-for-byte.
- Browser-DOM integration smoke: **PASS** — V5.8 page, catalogue controls, ten
  Atlas actor cards, branding, and initially disabled export gate all present.
- V5.9 runtime-capture core: **PASS** — SHA-256 vectors, TSV parsing, transfer
  continuity, historical-window validation, chunk-boundary signature scanning,
  PK3 size selection, report generation, Atlas candidate gate, and Worker
  source syntax.
- V5.9 release integration: **PASS** — runtime tab, local-only boundary,
  companion capture script, mobile clearance, deterministic build, and all
  preserved sources verified.
- Real entry-15 carrier scan: **PASS** — all 5,556,224 bytes processed; SHA-256
  `f15a1d9690b77894382556accfcb8fd6746d194c84d2b17d63b66268236a6066`;
  the obfuscated carrier was not falsely promoted to PK3.
- Python targeted R5900 execution: **PASS** — the real Lib routine at
  `0x0041A2F0` executed 12,382 guest instructions over entry-15 frame 0,
  reached exactly two declared service stubs, returned normally, produced an
  MPEG pack at byte zero, and matched the independent decoder byte-for-byte.
- JavaScript browser execution: **PASS** — deterministic synthetic full-frame
  vectors reproduce all 16,384 plaintext bytes through both ELF32 PT_LOAD and
  decoded MWo3 module-loading paths. Delay slots, write counts, call count, and
  instruction count are pinned.
- Direct-ISO browser path: **STATIC PASS / DEVICE TEST PENDING** — entry 2 is
  strictly decoded through existing browser APIs, Lib is selected by load
  address `0x003E6880`, and marked entries 15/21 provide the frame. Final
  interaction testing remains required on the target iPhone.
- Direct-ISO actor assembly: **RANGE/DECODE/ASSEMBLY REGRESSION PASS / DEVICE
  TEST PENDING** — actor `0x0BC0` resolves nine indexed `CHAR`/`ATRC`/`ANIM`
  child ranges inside hidden entry 1082, reads each exact stored extent through
  the browser ISO bridge, strictly decodes every wrapper, validates decoded
  signatures and the declared geometry size, and produces 2,524 vertices,
  eight textures, 22 RTA records, and seven animation clips. No Workspace tree
  population is required. Final interaction testing remains required on the
  target iPhone.

The single-file release builds byte-identically on two consecutive invocations.
Its SHA-256 is regenerated by `02_SOURCE/build_release.py` and recorded in the
final package manifest.

## Real actor `0x0BC0`

- Geometry: 2 segments, 113/113 valid strip packets, 2,524 decoded vertices,
  and 1,476 triangles.
- Corrected aligned discovery finds eight FIS images and two FISA tables. The
  old VIF-driven walk missed valid headers at `0xDE00` and `0x14480`.
- FIS texture IDs: 1289, 1294, 1295, 1296, 2413, 2414, 2415, and 3362.
- Texture 1289 is 128×128 PSMT8 with one logical palette; the other seven are
  64×64 PSMT4 with one logical CSM1 IDTEX4 CLUT each: eight PNG-exportable
  logical textures total.
- FISA groups resolve as `[1294,1295,1296]` and
  `[2413,2414,2415,3362]`; all pair offsets are exact.
- RTA: 22 records and 22 fixed-width CP932 names recovered without truncating
  exact-16-byte names. Spatial parent/vector composition is withheld because
  the literal interpretation is anatomically contradictory on this actor.
- FAS walk fixture: 20 exact channel-name bindings to RTA nodes. Helper/dummy
  channels remain unmatched rather than being assigned heuristically.
- FIXED vertex matrix addresses: 22 distinct values, base 656, stride 4, with
  exact cardinality against the RTA node count.
- The cardinality result does not prove ordering. The candidate ordinal table
  is exported but is not applied.
- Material diagnostics reproduce runtime patch-ID candidates `0x0B35` and
  `0x0A3D`. Neither directly equals an embedded FIS texture ID; material-family
  assignment instead uses the independent FPS material-reference table.
- PNG signature and diagnostic OBJ vertex/face counts are regression-tested.

## Preserved real-carrier checks

- Entry 21 decoded MPEG SHA-256:
  `b9436a2caf88707e3dc4af0996ce8d63feb624420f5bf8a9beb5b2a56f6fcbd7`.
- Entry 15 decoded MPEG SHA-256:
  `6a7604bab6fe0762dee767f7e9a5b1f13415d303f794b3cdafc9337300edcc6c`.
- All 255 entry-21 and 438 entry-15 SAC blocks pass CRC.
- Python and JavaScript audio outputs remain byte-identical.
- V5.5 output remains MPEG-2 video plus 48 kHz stereo `pcm_dvd`, with original
  video bytes and decoded PCM preserved through demux.

## Preserved boundaries

- Human labels are stored in a separate schema and cannot promote a machine
  classification.
- Historical labels are `HISTORICAL_USER_CLAIM`, require an explicit disc
  selection, and cannot overwrite either machine classifications or saved
  human labels. Child ordinals are not treated as modern child IDs without a
  reproduced inventory match.
- Marker-only movie allocations remain candidates and cannot invoke exact
  decode.
- Browser-native MPEG-2/LPCM preview is codec-dependent; download is primary.
- Browser code cannot attach to PCSX2 memory; the external capture script is a
  historical-only boundary. V5.10 hides that interface and instead executes a
  bounded routine directly from the open ISO.
- Runtime signature hits and Atlas exports remain candidate evidence and cannot
  override canonical classifications.
- The verified V5.10 result applies only to Lib `0x0041A2F0` and the reached
  instruction subset. It does not imply complete PS2 or game-runtime emulation.
- XBDC final skinning and exact FAS rotation/clock evaluation remain explicitly
  unresolved.
- Human visual inspection on the target iPhone remains the final usability and
  recognizability check.
