# SO3 Runtime Capture Importer V5.9.0

## Outcome

V5.9.0 adds the portion of runtime reconstruction that can safely run inside a
tiiny.host browser. It does not claim that browser JavaScript can attach to an
emulator process.

## Browser-side capabilities

- accepts raw historical `output.file` dumps or the new payload-plus-TSV pair;
- reads files locally without HTTP upload;
- processes the payload in 4 MiB chunks;
- uses a Blob Worker where supported, with cooperative chunking as fallback;
- computes incremental SHA-256 without loading the complete capture into one
  JavaScript `ArrayBuffer`;
- validates transfer sequence, payload continuity, requested/captured sizes,
  final logged length, and the selected historical destination window;
- recognizes a PK3 candidate at byte zero and tests its little-endian declared
  size at offset `0x14`;
- scans MPEG, PK3, PACK, wrapper, model, animation, texture, overlay, and ELF
  signatures while preserving counts and bounded sample offsets;
- exports a trimmed local reconstruction, `SO3_RUNTIME_CAPTURE_REPORT.json`,
  and `SO3_ATLAS_RUNTIME_UPDATE.json`.

## Companion capture profile

`02_SOURCE/so3_pcsx2_legacy_runtime_capture.lua` targets only the historical
32-bit PCSX2 commit `c16db05e0c3a5806fad1fd571141284facc7b421`. It intercepts
`VCRUNTIME140.memcpy`, filters destination writes to
`0x2410BD00–0x241A7D00`, clips the final transfer to the PK3 target size, and
logs every recorded transfer.

The mapping to IOP `0x0010BD00–0x001A7D00` is historical evidence tied to that
build. The browser report records the profile rather than promoting it into a
universal PCSX2 memory map.

## Evidence boundary

- A signature occurrence is not a format classification by itself.
- A PK3 prefix and plausible declared size are structural evidence, not proof
  of decoded audio semantics.
- A raw dump without a transfer log cannot prove sequence continuity.
- A modern PCSX2 build requires a separately reproduced capture profile.
- Atlas exports remain `CANDIDATE_EVIDENCE_ONLY` and cannot automatically
  override canonical format classifications.

## Verification

Automated tests cover SHA-256 vectors, TSV parsing, contiguous and broken
transfer logs, the historical address window, a signature split across a chunk
boundary, PK3 size selection, report construction, Atlas gating, Worker source
syntax, deterministic release construction, and preservation of all older
decoder/model suites. The supplied 5,556,224-byte entry-15 carrier was also
processed end-to-end without being misclassified as PK3; incidental signature
hits remained unpromoted, as required.

Final interaction testing on the target iPhone/tiiny.host environment remains
a field-validation step.
