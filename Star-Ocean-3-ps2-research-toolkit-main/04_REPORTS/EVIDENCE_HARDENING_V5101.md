# V5.10.1 Evidence Hardening

V5.10.1 addresses the three non-blocking findings from the independent V5.10
browser-return audit without changing the verified movie transform or widening
the runtime claim.

## Changes

- SHA-256 of the exact decoded/uploaded executable module is recorded in the
  execution report and Atlas update.
- Every executed instruction contributes a canonical row to a complete-trace
  SHA-256 commitment. The report states both the committed count and retained
  preview count, avoiding a large JSON trace while binding the full execution.
- The 0x4000 output is explicitly classified as
  `MPEG_PS_EXECUTION_FRAGMENT`; it is not represented as a complete movie.
- The browser builds a clean evidence ZIP from five named members. Platform
  metadata files cannot be introduced by folder compression on the phone.

## Canonical trace commitment

Each executed instruction contributes this UTF-8 row:

`step|uppercase_0x_PC|uppercase_0x_word|delay_slot_0_or_1\n`

The SHA-256 is calculated over the concatenation of all rows in execution
order. The synthetic 12,382-instruction regression vector has commitment:

`3d700be566192092f35f80180a6815ba04bda7e3108eb1c8087997adaa9bfa5e`

## Verification boundary

This hardening improves provenance and reproducibility. It does not promote
the bounded routine executor into a full PS2 emulator and does not generalize
the verified transform automatically to other routines or formats.
