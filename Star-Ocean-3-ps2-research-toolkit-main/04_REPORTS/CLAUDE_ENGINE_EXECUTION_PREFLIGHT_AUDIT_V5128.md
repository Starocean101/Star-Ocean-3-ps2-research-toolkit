# Claude Engine-Execution Preflight — Independent V5.12.8 Audit

## Verdict

The supplied Claude package is a clean and useful **static/regression
preflight**, but it is not an original-engine execution result. Its own status
summary states that zero guest instructions were executed and nothing carries
`VERIFIED_EXECUTION`. No engine-execution claim from this package is promoted.

Its independently supplied real-byte regression suite is valid and passed all
9 tests against this repository's hash-matching V5.12.7 HTML and decoded CHAR
fixtures. The two new byte-mutation negative controls were merged into the
canonical V5.12.8 regression suite.

## Archive and identity checks

- Outer ZIP SHA-256:
  `0b55760b0c436dca920a4f6c10ce1179477c2dd9757783715dea24572da83d07`.
- The ZIP contains four bounded regular files. Its central directory has no
  absolute paths, parent traversal, links, or duplicate names, and the CRC test
  passes.
- The report and test inside the ZIP are byte-identical to the two separately
  supplied attachments.
- Separately supplied report SHA-256:
  `25557e7a40402621ea09e01a69a1680daebdc550e850ca57639a1ee47a31464a`.
- Separately supplied test SHA-256:
  `2c86f9f70f9ff092ed9b5ccec4c6861d5a16bf574aa9d07b9e5f2194a0eb43df`.
- The included `SHA256SUMS.txt` verifies its three packaged artifacts, but also
  names five external inputs that the ZIP intentionally does not contain. It
  is therefore an input-session checksum ledger, not a self-contained archive
  checksum list.

## Reproduction

The Claude test was run with these exact inputs:

| Input | SHA-256 |
| --- | --- |
| V5.12.7 HTML | `d14d428c7088064930f974d6a3becef5a5b992a5f13f2bb5f0b52ba5cf6837d4` |
| Actor `0x08FF` decoded CHAR | `fb79b9daeb06f094e549c7ebb3f301f1b9c199d3230f59e4666fe7f14937d569` |
| Actor `0x0BC0` decoded CHAR | `f4aa0e83f1df38f1a70fc915687b642d87d2d794550e693a6815ec80f5c4945e` |

Result: **9 passed, 0 failed, 0 skipped**.

The accepted controls are:

1. `NC1`: mutate the first `0x0BC0` FPS dynamic-record texture id from
   1294 to 1293. Authoritative bindings fall from three to one; the inference
   fallback does not fill the missing links.
2. `NC2`: mutate `0x08FF` material slot 2's stored TEX0 PSM from PSMT4 to
   PSMT8. The fallback rejects all assignments with `AMBIGUOUS_PSM_CLASS`, and
   both no-UV diagnostic layers become visible again.

These tests demonstrate input sensitivity and fail-closed preview behavior.
They do not execute game code or promote the `0x08FF` material mapping above
`STRONG_INFERENCE`.

## Claim disposition

| Finding | Disposition | Reason |
| --- | --- | --- |
| PF1 | Session-specific | The Claude thread's two actor export ZIPs lacked package metadata. The current master package has deterministic `MANIFEST.json` and `SHA256SUMS.txt`. |
| PF2 and PS2Recomp blocker | Superseded | That thread lacked Lib.bin and a PS2Recomp checkout. This package already contains the exact Lib-derived execution evidence and the bounded R5900/VU0 runners. |
| PF3–PF5 | Accepted | Counts, authoritative `0x0BC0` links, inferred `0x08FF` links, and both real-byte negative controls reproduce. |
| PF6 | Rejected as a real-data conflict | The eight-member list `[2413,2414,2415,2416,3359,3360,3361,3362]` occurs in the earlier JavaScript function `buildActor0BC0()`, which creates a synthetic 4096-byte stress fixture. The real 133,600-byte actor has two facial families of three and four members: `[1294,1295,1296]` and `[2413,2414,2415,3362]`. |
| PF7 | Accepted with scope | Qword-2 and qword-3 TEX0 values are identical in both supplied real actors. The negative test correctly changes the qword-2 value consumed by the current decoder. |
| PF8–PF10 | Accepted | The hardening guards, auxiliary-layer gate, and command-registry parity reproduce. The auxiliary mesh's runtime role remains unresolved. |

## Why the proposed first execution slice is not the next task

Claude proposed the FIS resolver at `0x00454E00` because its isolated thread
could not inspect Lib.bin. The master package has already gone beyond that
preflight:

- Original facial FISA leaf code at `0x004D7BB0..0x004D7CB0` has been executed
  over the real fixture groups and selects the expected member pointers.
- Original IDOM loader/binder code executed 11,704 guest instructions across
  four real sections and produced byte-exact matrices and pointer bindings.
- The original VU0 program at entry index `0x113` executed 190 invocations and
  6,840 microinstruction pairs across all 95 real IDOM matrices, with every
  output byte-exact against the independent composition.

Repeating a smaller FIS preflight slice would not close the remaining model
failure. The smallest high-value next target is the **FAS rotation/interpolation
evaluator that writes each runtime node matrix at object `+0x90`**. Its output
can feed directly into the already verified IDOM/VU0 matrix-composition chain.
Final vertex skinning follows after that witness.

## Model-level requirements

| Task | Required level |
| --- | --- |
| This preflight audit and evidence merge | **Max** |
| FAS evaluator discovery, execution, and differential witness | **Max** |
| On-device actor regression after an implementation change | **High** |
| Reading or summarizing this audit only | **Medium** |

No HTML renderer behavior was changed in this audit pass. V5.12.8 remains the
current browser build.
