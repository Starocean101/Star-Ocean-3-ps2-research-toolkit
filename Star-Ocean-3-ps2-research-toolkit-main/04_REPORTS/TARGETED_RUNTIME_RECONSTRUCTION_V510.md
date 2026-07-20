# V5.10 targeted runtime reconstruction

## Verified result

The supplied PAL `Lib.elf` was loaded into a sparse EE address map and execution
entered the actual R5900 routine at `0x0041A2F0`. For the first `0x4000` bytes
of entry 15, the harness executed 12,382 guest instructions and returned
through the supplied sentinel.

The only external calls reached were:

- `0x0010D880`: host-context getter, explicitly stubbed to return
  `0x001B6A80` so the routine loads the content key from `0x001CC730`;
- `0x00121FA0`: `FlushCache`, explicitly modeled as a no-op because the sparse
  memory model is coherent.

The instruction-executed output SHA-256 is
`ff947bf64a02dcd63e7f0cb353930957835dfdb5c9bc0971c468ea0de7423726`.
It is byte-identical to the independent translated decoder and begins with
MPEG pack code `00 00 01 BA`.

## Browser implementation

V5.10 includes the same execution core in the single HTML release:

- ELF32 little-endian PT_LOAD parsing;
- raw decoded MWo3 load-image parsing;
- sparse page-backed EE memory;
- 128-bit GPR storage with implemented 32/64-bit semantics;
- `lq`, `sq`, `ld`, `sd`, arithmetic, logic, `pcpyld`, jumps, calls, branches,
  and mandatory delay slots reached by the target routine;
- explicit call stubs, instruction limit, unmapped-memory failure, and unknown
  opcode failure;
- bounded instruction trace and memory-write report.

The direct-ISO button performs every preparation step locally. It strictly
decodes hidden entry 2, selects Lib by the MWo3 load address `0x003E6880`, and
reads a marked entry-15/21 carrier frame. The ISO never leaves the browser.

## Boundary

This validates one concrete runtime routine and its reached instruction set. It
does not emulate the complete EE, IOP, VU, GS, SPU2, DMA scheduler, BIOS, or the
whole game loop. New target routines must add their required instructions and
service stubs under new fixture-based tests. Engine-wide generalization is not
automatic.

Machine-readable details are in `ENTRY15_FRAME0_RUNTIME_EXECUTION.json` and
`TARGET_RUNTIME_MODULE_INVENTORY.json`.
