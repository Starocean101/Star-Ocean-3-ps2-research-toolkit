# Contributing

## Evidence first

Create one Issue and one focused research task for each format, engine branch,
or browser feature. Every completed contribution should include:

- a specification or report;
- parser/extractor source;
- bounds and malformed-input handling;
- tests and negative controls;
- sample hashes instead of copyrighted sample files;
- deterministic generated outputs where applicable;
- explicit unresolved fields and withheld claims.

Do not silently convert guesses into field names. Use names such as
`unknown_0x14` until evidence supports a meaning.

Keep these evidence classes separate:

- verified byte structure;
- verified executed/static code behavior;
- strong inference;
- historical/unapplied claim;
- unresolved/withheld.

## Public-data rule

Follow `PUBLICATION_BOUNDARY.md`. Never commit game executables, decoded assets,
private engine-response bytes, or proprietary fixtures. Tests requiring such
data may document expected hashes and user-supplied paths but must not bundle
the data.

## Verification

Run:

```sh
03_TESTS/run_public_tests.sh
```

The release build must be deterministic and the compatibility browser copy
must match the canonical release byte-for-byte.

## Commit examples

```text
Document PACK reference records
Add bounded SLZ2 regression test
Implement guarded model-family classification
Publish SO3 Resource Explorer V5.12.8 Pass 6.2
```
