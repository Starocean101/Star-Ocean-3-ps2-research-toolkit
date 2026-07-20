# SLZ and SLE Formats

## Chained block header

The decoder dispatch routine is located around EE VA `0x00102540`.

The three-byte magic is `SLZ` or `SLE`. Header field `+0x0C` is the byte offset
to the next chained block. A zero value ends the chain.

## Type dispatch

| Type | Meaning |
|---:|---|
| 0 | Stored copy |
| 1 | SLZ type 1 |
| 2 | SLZ type 2 |
| 3/default | SLZ type 3 |

A correct decoder must enforce:

- source bounds;
- destination bounds;
- valid back-reference distances;
- exact advertised output size;
- exact compressed-byte consumption where required;
- proper chain advancement.

## SLE preprocessing

SLE applies the following byte transform before the SLZ decoder receives the
payload:

```text
plain[i] = ((cipher[i] - 3 * (i + 1)) & 0xFF) ^ key[i & 15]
```

Verified PAL key:

```text
66665442b379f0c7e7d51e4b7ba41c7d
```

## Known top-level SLE entries

| Entry | Type | ISO offset | Compressed size | Output size |
|---:|---:|---:|---:|---:|
| 2 | SLE3 | `0x23F000` | 74280 | 166784 |
| 1067 | SLE2 | `0x3DD8E000` | 629325 | 1363840 |
| 1068 | SLE2 | `0x3DE28000` | 4227 | 9008 |

Entry 1068 strictly validates to a `PACK` output.
