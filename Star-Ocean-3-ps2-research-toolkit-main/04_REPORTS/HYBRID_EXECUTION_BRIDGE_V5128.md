# Hybrid Sandbox/Browser Execution Bridge — V5.12.8

The browser owns read-only access to the user's ISO; the sandbox owns analysis,
recompilation, and headless execution. Communication uses explicit bounded
artifacts rather than direct browser control or full-disc transfer.

Requests may ask for capped ISO byte ranges, complete indexed actor resources,
visible SLES/SLUS/ELF files, and decoded blocks from named hidden entries. Each
response contains the original request, ISO identity metadata, per-member
source context, SHA-256 values, an error list, and `SHA256SUMS.txt`. Current
limits are 16 MiB per member, 96 MiB total, 64 ranges, and eight actors.

The packaged bootstrap request asks for the visible executable set, decoded
hidden entry 2, and complete indexed resources for actors `0x08FF` and
`0x0BC0`. This supplies the initial sparse execution corpus. A sandbox runner
can then emit smaller requests when an unmapped disc read or missing module is
encountered. Unknown data is requested, never guessed.

This bridge is not a full PCSX2 replacement. It supplies hash-bound engine and
actor bytes to bounded EE/VU0 interpreters, which stop on unmapped memory or an
unsupported opcode. VU1 rendering, final skinning, and full game boot remain
outside its present scope.

## Bootstrap response result

The first response passed manifest/checksum validation and supplied the exact
PAL SLES, Lib MWo3, and actor CHAR bytes. No additional ISO request was needed
to locate the matrix resources: actor `0x08FF` contains IDOM sections with
counts 32 and 19, and actor `0x0BC0` contains two IDOM sections with count 22.

The sandbox subsequently executed the original loader, resource-record binder,
VU0 matrix-composition microprogram, and DMA/VIF packet slice. Exact raw-name
matching through the CHAR FSS directory closes every `0x08FF` IDOM-to-RTA row
and 40/44 `0x0BC0` rows without inventing ordinals. See
`HYBRID_IDOM_MATRIX_EXECUTION_V5128.md` and its four machine reports. The FAS
rotation/interpolation evaluator and final skinned pose remain unresolved.
