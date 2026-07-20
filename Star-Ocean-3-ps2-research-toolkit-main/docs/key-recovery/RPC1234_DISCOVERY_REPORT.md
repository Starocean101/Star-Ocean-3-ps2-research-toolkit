# SO3 Hidden Entry 1 / RPC Server 0x1234 Discovery

## Executive result

The browser hidden-table extraction was successful.

Hidden table entry 1 (`001_SLZ2_212000.bin`) is a chained SLZ bundle containing
12 valid PlayStation 2 IOP ELF modules.

The eighth decoded module is `Csi_`. Static ELF symbols and machine code establish:

- `Csi_` registers SIF RPC server ID `0x1234`.
- Registration call: module VA `0x00C4`.
- Registered handler: `CsiIopServerWakeup` at module VA `0x0744`.
- The handler uses the RPC function number as a 0..0x26 jump-table index.
- Jump-table index `0x0E` goes to module VA `0x0878`.
- VA `0x0878` calls `OnCsGetSecretKeyCode` at module VA `0x037C`.
- `OnCsGetSecretKeyCode` reads the 16-byte global `gunSecretKeyCode`
  at module VA `0x0D28`.
- It bitwise-complements four 32-bit words and writes them to output-buffer
  offsets `+0x04`, `+0x08`, `+0x0C`, and `+0x10`.
- It returns status 1, matching the EE-side rule that response word 0 must be nonzero.

This is the exact previously missing server and function implementation.

## Constants

Stored `gunSecretKeyCode` bytes:

`a4489c4f7d31fe78773703b9ca3ac386`

Direct IOP RPC response bytes produced by `OnCsGetSecretKeyCode`:

`5bb763b082ce018788c8fc4635c53c79`

## Important remaining correction

The direct IOP response does not yet validate the SLE sample as the final decoder
key. Inspection of `SLES_820.28` shows the EE does not simply store the four words
unchanged:

- `0x100924`: loads the 16-byte response into COP2/VU state.
- `0x100930`: executes EE/VU opcode `0x4A000038`.
- `0x10093C`: executes COP2 opcode `0x48490001`.
- `0x100940`: stores a COP2 vector back over the response.
- `0x100950–0x100958`: loads that transformed 16-byte value and stores it to
  key buffer `0x1CC730`.

Therefore the earlier claim that the reply is installed “verbatim” is disproved.
The remaining task is now very small and precise: decode the two COP2/VU
instructions and apply that 128-bit transform to the known IOP response.

## Decoded module inventory

| Block | Module | Size | SHA-256 |
|---:|---|---:|---|
| 0 | `sio2man` | 6641 | `0facd5a832d3114c3477ded714f8766d443705a1440deeb84c59927cf0b6968e` |
| 1 | `sio2d` | 10985 | `ad6aa19834d0dc9eaaaddd08c51f75ba4f6eaec3df30795720aafb31c60372e9` |
| 2 | `dbcman` | 15477 | `c8407c955467fa612fd9f1b4074eb2d19bd80149ecc5752988f8a904cbcd4fcb` |
| 3 | `ds2o_d` | 11781 | `431de132ccf8378914d167e2d572569a70ecb65f390e0d40289482379da1d2f4` |
| 4 | `libsd` | 28605 | `57cbd80b7c2f966985e14ca18c03e849e3b3eb1216f06a6f4c1e6ca85084ea37` |
| 5 | `Csm_` | 53749 | `bcf47d7a30546b04f2c0054a17e8825090adea28d75fec510d361d2f11fa8058` |
| 6 | `Csd_` | 47388 | `ba59c24307013f3e660c80978eb1f1664e406af5111fb661bf6f8b8523fd6fe8` |
| 7 | `Csi_` | 15337 | `cfe37e6c3c1aea94edaf8fb424252965593e0041c831590f661314d1dce78959` |
| 8 | `module08` | 30117 | `6b4fea4633ce22f361a9043780e2d70adead8e55101984468b977e05d0003fbf` |
| 9 | `module09` | 49417 | `5f6a009a0a8c4cb11e1dc8835f5f3fd600d6f7c6143b7068da6c6e7ac8243379` |
| 10 | `mcman` | 95877 | `cdb1dfd12cb71f60d4834eb888dbbffeb6f6382e3bdffc1a50122034f7969b6b` |
| 11 | `mcserv` | 7417 | `42790c4999c9deb17bb0fe2ceb155d3b141adf059c3055e11039070be2a8a7a6` |

## Other uploaded resources

All four additional resources decoded strictly to their advertised output sizes.
See `decoded_resources.json` and `decoded_other/`.
