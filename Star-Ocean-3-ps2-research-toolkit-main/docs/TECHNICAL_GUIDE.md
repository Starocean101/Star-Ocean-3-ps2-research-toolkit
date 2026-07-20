# Technical Guide: How the Disc Was Mapped and the SLE Key Was Recovered

## 1. Starting point

A normal ISO9660 directory scan exposed only a few visible files on the PAL disc:

- `SLES_820.28`
- `SYSTEM.CNF`
- `IOPRP271.IMG`

That visible tree did not account for most of the disc. The missing data was not
absent. It was referenced by a proprietary allocation table outside the ordinary
filesystem directory.

## 2. Locating the hidden tri-Ace table

At ISO offset `0x200000`, the disc contains a tri-Ace table identified by:

```text
signature: 0x27D51556
seed:      0x13578642
slots:     0x1800 (6144)
```

The table contains three parallel arrays:

1. logical block addresses;
2. sector lengths;
3. runtime offsets.

For a nonempty slot:

```text
physical byte offset = LBA × 0x800
allocated byte size  = sector length × 0x800
```

The PAL Disc 1 table contains 5,883 nonempty entries. Their physical extents
cover essentially the full post-filesystem region of the disc.

Important implementation detail: JavaScript bitwise operators are signed 32-bit.
Offsets near the end of a DVD exceed that range. The browser therefore uses
ordinary `Number` arithmetic for `LBA * 0x800` and avoids truncating offsets
through bitwise operations.

## 3. Identifying resource types

The extractor reads a small header from each hidden extent and classifies common
signatures, including:

```text
ELF
SLZ0
SLZ1
SLZ2
SLZ3
SLE2
SLE3
PACK
ZLS
PNG
TIM2
```

This classification is based on bytes, not filename extensions. Hidden resources
do not have conventional filenames, and extensions are merely output conveniences.

## 4. Recovering the compression pipeline

The EE executable contains a dispatcher around VA `0x00102540`.

It recognizes `SLZ` and `SLE` block signatures. The block header field at `+0x0C`
is the byte offset to the next chained block; zero terminates the chain.

The type byte selects one of four payload paths:

| Type | Operation |
|---:|---|
| 0 | Stored/uncompressed copy |
| 1 | SLZ type-1 decoder |
| 2 | SLZ type-2 decoder |
| 3/default | SLZ type-3 decoder |

The browser implementation performs bounded reads and exact output-size checks.
It also supports chained resources rather than assuming one resource equals one
compressed block.

## 5. Recovering SLE preprocessing

Before ordinary SLZ decoding, SLE applies a byte transform:

```text
plain[i] = ((cipher[i] - 3 × (i + 1)) & 0xFF) XOR key[i & 15]
```

This established that a repeating 16-byte key was required, but the key itself
was initialized at runtime and was not present as a raw contiguous constant in
the disc image.

Broad scans for the final 16-byte value were rejected after grounded tests found
no matching raw, reversed, word-swapped, rotated, transposed, or simple
LUI/ORI-constructed constant.

## 6. Finding the runtime key provider

The EE key state is stored at:

```text
EE address: 0x001CC730
```

The key request travels through a SIF RPC client associated with custom server:

```text
server ID: 0x1234
function:  0x0E
```

The initial stock modules in `IOPRP271.IMG` did not register this server. The
server was later found in hidden resource entry 1.

## 7. Decoding hidden entry 1

Hidden entry 1 is a chained SLZ resource containing twelve IOP ELF/IRX modules.

One decoded module is named `Csi_`. Static analysis established:

```text
server registration: 0x1234
server handler:      CsiIopServerWakeup
RPC function 0x0E:   OnCsGetSecretKeyCode
secret symbol:       gunSecretKeyCode
```

The stored constant is:

```text
a4489c4f7d31fe78773703b9ca3ac386
```

The IOP function bitwise-complements four 32-bit words and writes the result to
RPC response words 1 through 4:

```text
direct IOP response:
5bb763b082ce018788c8fc4635c53c79
```

## 8. Recovering the EE/VU0 post-transform

The response is not copied directly into the final key state.

Relevant EE instructions:

```text
0x00100924  LQC2 vf1,0(v0)
0x00100930  VCALLMS 0
0x0010093C  CFC2.I t1,vi0
0x00100940  SQC2 vf3,0(v0)
0x00100950  LQ v0,0x90(sp)
0x00100958  SQ v0,-0x38D0(at)  ; final destination 0x001CC730
```

A VIF `MPG` packet uploads an eleven-microinstruction VU0 program to micro
address zero. The program independently transforms four 32-bit VU lanes:

```text
x = VU_ADD(VU_MUL(x, 0x42FECCCD), 0x42546666)
y = VU_ADD(VU_MUL(y, 0x43D80D3E), 0xC7F079B3)
z = VU_ADD(VU_MUL(z, 0x43A0DA10), 0x43A02666)
w = VU_ADD(VU_MUL(w, 0x43546E14), 0x42F23333)
```

The operation must reproduce PS2 VU floating-point behavior. Ordinary host
IEEE-754 arithmetic differs by one bit in the z lane and fails decompression.

Applying the bit-exact transform to the IOP response produces:

```text
66665442b379f0c7e7d51e4b7ba41c7d
```

## 9. Strict validation

The key was tested against exact hidden entry 1068:

```text
input signature:       SLE
type:                  2
compressed size:       4227
compressed consumed:   4227
remaining input:       0
expected output:       9008
actual output:         9008
invalid references:    none
output signature:      PACK
```

Output SHA-256:

```text
1217cee95a95efe32285fd9916f336aefeea0726e4972f23571fbfd568c72105
```

A wrong candidate fails quickly through an invalid back-reference or wrong output
length. Exact consumption, exact output size, no invalid references, and a valid
`PACK` signature provide strong validation.

## 10. Browser architecture

The browser app is a single HTML file using the browser `File` and `Blob` APIs.

It deliberately:

- slices only required ranges from the selected ISO;
- does not load the whole multi-gigabyte ISO into memory;
- paginates large resource tables;
- caps displayed hex ranges;
- yields during scans to keep the UI responsive;
- uses streaming/chunked signature scans;
- exports files directly from source Blob slices where possible;
- performs decompression only for selected resources;
- creates reports and ZIP output in memory only when requested.

## 11. What remains

The disc allocation layer and SLZ/SLE pipeline are solved. The next research
targets are the decoded resource containers, especially `PACK`, `ZLS`, and any
unknown signatures found inside their outputs.

Each container should receive:

1. a focused research thread;
2. a GitHub Issue;
3. a specification document;
4. a parser/extractor;
5. synthetic tests;
6. strict validation against multiple real samples without committing those
   proprietary samples to this repository.
