# Validation Method

A candidate key is accepted only when it passes structural decompression checks.

For entry 1068, the verified requirements are:

| Check | Required |
|---|---|
| Input magic | `SLE` |
| Type | 2 |
| Compressed size | 4227 |
| Expected output | 9008 |
| Actual output | 9008 |
| Consumed input | 4227 |
| Remaining input | 0 |
| Invalid back-reference | None |
| Exception | None |
| Output signature | `PACK` |

Verified output SHA-256:

```text
1217cee95a95efe32285fd9916f336aefeea0726e4972f23571fbfd568c72105
```

This validation is stronger than checking that decompression merely completes.
A permissive decoder can hide wrong keys by truncating, wrapping, or tolerating
bad references. The repository decoder treats those conditions as failures.
