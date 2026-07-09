# Contributing

## One format per research task

Create one Issue and one focused research thread for each container/file type.

Each completed format contribution should include:

- `README.md` or specification;
- parser/extractor source;
- documented assumptions;
- malformed-input handling;
- sample hashes rather than copyrighted sample files;
- validation results;
- unresolved fields clearly labeled.

Do not silently convert guesses into field names. Use names such as
`unknown_0x14` until evidence supports a meaning.

## Commit messages

Examples:

```text
Document PACK header candidates
Add bounded SLZ2 regression test
Implement ZLS inner-stream extraction
Record NTSC-U table profile
```
