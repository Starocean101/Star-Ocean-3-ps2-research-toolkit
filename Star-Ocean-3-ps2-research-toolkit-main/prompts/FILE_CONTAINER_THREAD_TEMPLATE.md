# Star Ocean 3 Container Research Thread Template

## Target

Investigate exactly one file/container type:

`<FORMAT NAME>`

Do not restart solved ISO, hidden-table, SLZ, SLE-key, IOP-RPC, or VU0 research
unless direct evidence shows the target depends on it.

## Inputs

Provide:

- several exact extracted samples of the same suspected format;
- table entry numbers and ISO offsets;
- compressed and decoded sizes;
- SHA-256 hashes;
- any parent-container metadata;
- the current repository documentation.

## Objectives

1. Determine the header and record layout.
2. Identify endianness, offsets, counts, alignment, and termination rules.
3. Separate verified fields from hypotheses.
4. Build a bounds-checked parser and extractor.
5. Test multiple samples.
6. Produce synthetic regression fixtures.
7. Document unknown fields without inventing meanings.

## Required deliverables

- `FORMAT_SPEC.md`
- parser/extractor source
- `VALIDATION_REPORT.md`
- machine-readable sample manifest
- `SHA256SUMS.txt`
- one ZIP containing the deliverables

Do not include original proprietary samples in the deliverable ZIP intended for
a public repository.
