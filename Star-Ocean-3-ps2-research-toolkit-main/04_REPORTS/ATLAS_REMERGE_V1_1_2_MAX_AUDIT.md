# SO3 Atlas V1.1.2 Re-merge — Max Audit and Pass 6.4 Integration

## Outcome

Claude's explicit-adapter merger is accepted as a reviewed base, but the
returned ZIP is **not accepted unchanged** as the canonical master. The merger
has been hardened and extended through V5.12.8 Passes 6.3 and 6.4. The resulting
V1.1.2 registry, graph, and update ledger pass 393 dedicated checks with zero
failures and reproduce byte-for-byte across two fresh runs.

The browser release remains
`01_RELEASE/so3_resource_explorer_v5_12_8_pass6_2.html`. This is a canonical
evidence merge, not a browser or visual-repair pass.

## Returned attachment verification

- `SO3 CLAUDE ATLAS REMERGE OUTPUT V1.zip`: 2,599,523 bytes, SHA-256
  `ce94c4eb8c5411a18ca19af206570902b6bae4aa44f4ebff492417e330c30ebf`.
- `ATLAS REMERGE V1 1 2.md`: 8,483 bytes, SHA-256
  `829a3b36f539d3afdba9bb0e7a715f526324fe6cbb39723b480db40b8c3ac1ae`.
- ZIP CRC, uniqueness, path traversal, absolute-path, and symlink checks pass
  for all 75 members.
- All 73 non-metadata members match `MANIFEST.json` by path, size, and SHA-256.
- The standalone report is byte-identical to
  `04_REPORTS/ATLAS_REMERGE_V1_1_2.md` inside the ZIP.

One returned-package integrity defect is confirmed: `SHA256SUMS.txt` has 73
valid entries but omits `MANIFEST.json`; 74 entries were required to cover every
member except the checksum file itself. The fresh master package repairs this.

## Independent semantic audit

The returned merger's core design is sound within its older 21-update subset:
it uses one explicit adapter per update, asserts prior canonical values, avoids
generic dictionary merging, retains conflicts and withheld evidence, preserves
the V1.1.1 graph body, and emits deterministic JSON. Claude's original suite
reproduced its three packaged outputs with 296/296 checks passing.

Four issues prevented a verbatim merge:

1. The subset predates Pass 6.3 packet binding and Pass 6.4 RTA/FSS execution,
   leaving `matrix_to_packet_binding`, the RTA-translation hypothesis, bounded
   pose, and browser-withhold reasons stale.
2. `Package.verify()` accepted consumed files absent from `SHA256SUMS.txt`, in
   conflict with the stated fail-closed provenance contract.
3. Six semantic validations used Python `assert` and could disappear under
   `python -O`.
4. The returned ledger embedded anomalies from Claude's curated input subset;
   those are not properties of the current complete Pass 6.4 package.

The hardened merger requires every consumed input to be listed and
checksum-matched, rejects malformed/duplicate/unsafe checksum entries, uses
explicit `MergeError` validation under optimized Python, and records no current
package anomalies.

## Current canonical merge

All 23 update files are ledgered. The merge applies nine chronological field
supersessions, one structure addition, eleven registry annotations, twenty graph
node annotations, and forty-five distinct engine gates. Twenty supersessions
retain earlier gate/claim history. All 156 historical identity claims remain
`applied:false`.

The Pass 6.3/6.4 integration makes only evidence-backed changes:

- RTA node record `+0x10` is corrected from `translate` to an auxiliary vector
  whose semantic role remains unresolved; original binder `0x0045B080` does not
  load it as a transform.
- The packaged one-matrix XBDC FIXED address-to-IDOM-palette and original VU1
  transform path is promoted over all 4,712 real vertices. Blended and
  unsupported renderer profiles remain withheld.
- Field `0x002510E0`, the original RTA binder, all 94 serialized type-9 FSS
  transform loads, and both bounded actor packet-pose witnesses are attached to
  exact canonical targets.
- Historical packet/RTA/final-pose gates remain in the graph with explicit
  `superseded_by` records rather than being deleted.
- Browser deformation remains `WITHHELD_NOT_INTEGRATED`; on-device validation
  remains `WITHHELD_NOT_RUN`.

Both original conflicts remain unresolved and fail closed:

- `CONFLICT-LEGACY-D2-1160-33`: “Nel Hi-poly” versus “Woltar”.
- `CONFLICT-RTA-OFF1-READING`: baseline off1 text versus the V5.8 fixed-record
  reading.

Five scope/provenance ambiguities also remain recorded, including FIS corpus
equivalence, Lib hash duality, FISP tag identity, absent U-code definitions, and
the unavailable cutscene source-Atlas citation.

## Canonical outputs

| File | SHA-256 |
|---|---|
| `05_ATLAS/SO3_FORMAT_REGISTRY_V1_1_2.json` | `a7f94fd61ee308db49c96e649674e488dbd93b931e410b0567a180ac16d6bf5b` |
| `05_ATLAS/SO3_RESOURCE_GRAPH_V1_1_2.json` | `efe3a4a59199d053c1da514b698270aa43731b890b72c06e84322459a4a01d1d` |
| `05_ATLAS/ATLAS_UPDATE_LEDGER_V1.json` | `2985cf1c59f151be85d2b691a1ddb3cde2a53e7c872e98b04f1b32200d2c3a86` |

The dedicated suite verifies schema, baseline preservation outside nine exact
field changes, chronological prior values, provenance closure, payload/grade
anchoring, exact gates, conflict retention, ledger completeness, rejection of
unlisted inputs, validation under `python -O`, and two-run byte determinism.
It passes all 393 checks, and the complete packaged project regression suite
also passes with zero failures.

## Gate split

- Claude merger as a reviewed implementation base: **PASS**.
- Returned ZIP as a verbatim canonical package: **REJECTED**, checksum omission
  and pre-Pass-6.3/6.4 scope.
- Canonical V1.1.2 registry/graph/ledger after audit corrections: **PASS**.
- Conflict and ambiguity retention: **PASS**.
- Silent promotion/fabrication checks: **PASS**.
- Browser mesh deformation: **WITHHELD**, not integrated.
- On-device visual validation: **WITHHELD**, not run.

## Next tasks and reasoning

- Integrate browser deformation while preserving a separately switchable
  static path: **High**.
- Independently audit browser integration against the Pass 6.4 execution and
  canonical V1.1.2 gate ledger: **Max**.
- Run on-device visual regressions for actors `0x08FF` and `0x0BC0`: **Medium**.
- Reinspect documentation or package checksums without semantic changes:
  **Light**.
