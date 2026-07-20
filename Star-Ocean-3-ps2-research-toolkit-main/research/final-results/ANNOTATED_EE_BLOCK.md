# Annotated EE/VU0 Key-Transform Block

## Executable mapping and byte verification

The first loadable ELF segment maps executable virtual address `0x00100000` to file offset `0x680`. Therefore:

```text
file_offset = EE_virtual_address - 0x00100000 + 0x680
```

The supplied target range `0x001008E0–0x0010097F` maps to file offsets `0xF60–0xFFF`. Every raw word below was checked against both `04_TARGET_BLOCK/EE_TARGET_BLOCK_WORDS.md` and `01_EXECUTABLE/SLES_820.28`; all bytes matched.

## EE address-by-address dataflow

| EE VA | File offset | Raw word | Correct decode | Register effects | Memory/control effects and transform relevance |
|---:|---:|---:|---|---|---|
| `0x001008E0` | `0xF60` | `0x00000000` | `NOP` | None | None. |
| `0x001008E4` | `0xF64` | `0x1040FFFA` | `BEQ v0,zero,0x001008D0` | None | Conditional branch; delay slot is `0x1008E8`. This precedes the transform path. |
| `0x001008E8` | `0xF68` | `0x00000000` | `NOP` | None | Branch delay slot. |
| `0x001008EC` | `0xF6C` | `0x3C04001B` | `LUI a0,0x001B` | `a0 = 0x001B0000` | Setup for preceding control logic. |
| `0x001008F0` | `0xF70` | `0x24020001` | `ADDIU v0,zero,1` | `v0 = 1` | None. |
| `0x001008F4` | `0xF74` | `0x3C011001` | `LUI at,0x1001` | `at = 0x10010000` | None. |
| `0x001008F8` | `0xF78` | `0x24846A80` | `ADDIU a0,a0,0x6A80` | `a0 = 0x001B6A80` | None. |
| `0x001008FC` | `0xF7C` | `0xAC22E010` | `SW v0,-0x1FF0(at)` | None | Stores `1` to `0x1000E010`. |
| `0x00100900` | `0xF80` | `0x0C040484` | `JAL 0x00101210` | `ra = 0x00100908` | Calls setup routine; `0x100904` is its delay slot. |
| `0x00100904` | `0xF84` | `0x27B00090` | `ADDIU s0,sp,0x90` | `s0 = sp + 0x90` | Defines the 16-byte response/key scratch address. Executes in the `JAL` delay slot. |
| `0x00100908` | `0xF88` | `0x8C440000` | `LW a0,0(v0)` | `a0 = *(u32*)v0` | Supplies the key-provider selector/context. |
| `0x0010090C` | `0xF8C` | `0x0200282D` | `DADDU a1,s0,zero` (`MOVE a1,s0`) | `a1 = sp + 0x90` | First 32-bit response output address. |
| `0x00100910` | `0xF90` | `0x26060004` | `ADDIU a2,s0,4` | `a2 = sp + 0x94` | Second response output address. |
| `0x00100914` | `0xF94` | `0x26070008` | `ADDIU a3,s0,8` | `a3 = sp + 0x98` | Third response output address. |
| `0x00100918` | `0xF98` | `0x0C041618` | `JAL 0x00105860` | `ra = 0x00100920` | Calls the established EE key provider. |
| `0x0010091C` | `0xF9C` | `0x2608000C` | `ADDIU t0,s0,0x0C` | `t0 = sp + 0x9C` | Fourth response output address; executes in the key-provider call delay slot. The four returned words form the direct IOP response at `sp+0x90`. |
| `0x00100920` | `0xFA0` | `0x0200102D` | `DADDU v0,s0,zero` (`MOVE v0,s0`) | `v0 = sp + 0x90` | Selects the 16-byte direct-response vector as the COP2 load/store address. |
| `0x00100924` | `0xFA4` | `0xD8410000` | `LQC2 vf1,0(v0)` | `vf1.xyzw = *(u128*)(sp+0x90)` | Loads bytes in little-endian word order: `x=[+0..3]`, `y=[+4..7]`, `z=[+8..11]`, `w=[+12..15]`. No permutation occurs. |
| `0x00100928` | `0xFA8` | `0x00000000` | `NOP` | None | Scheduling gap before VU call. |
| `0x0010092C` | `0xFAC` | `0x00000000` | `NOP` | None | Scheduling gap before VU call. |
| `0x00100930` | `0xFB0` | `0x4A000038` | `VCALLMS 0` | Starts VU0 at micro address `0` | Invokes the 11-instruction VU0 program decoded below. Input is `vf1`; result is written to `vf3`. |
| `0x00100934` | `0xFB4` | `0x00000000` | `NOP` | None | EE scheduling gap while VU0 executes. |
| `0x00100938` | `0xFB8` | `0x00000000` | `NOP` | None | EE scheduling gap while VU0 executes. |
| `0x0010093C` | `0xFBC` | `0x48490001` | `CFC2.I t1,vi0` | `t1 = vi0` | The interlocked `.I` form waits for the preceding `VCALLMS` to complete. The copied `vi0` value is not used; synchronization is the purpose. |
| `0x00100940` | `0xFC0` | `0xF8430000` | `SQC2 vf3,0(v0)` | None | Stores transformed `vf3.xyzw` to the same scratch vector at `sp+0x90`; lane and byte order remain unchanged. |
| `0x00100944` | `0xFC4` | `0x3C01001D` | `LUI at,0x001D` | `at = 0x001D0000` | Forms base for the persistent key-state store. |
| `0x00100948` | `0xFC8` | `0x02A0202D` | `DADDU a0,s5,zero` (`MOVE a0,s5`) | `a0 = s5` | Argument for the following routine, not part of the arithmetic transform. |
| `0x0010094C` | `0xFCC` | `0x27A50110` | `ADDIU a1,sp,0x110` | `a1 = sp + 0x110` | Argument for the following routine. |
| `0x00100950` | `0xFD0` | `0x7BA20090` | `LQ v0,0x90(sp)` | `v0` receives the full transformed 128-bit value | Reloads the transformed key from the scratch vector. |
| `0x00100954` | `0xFD4` | `0x0C04765C` | `JAL 0x0011D970` | `ra = 0x0010095C` | Calls the next routine. Its delay slot performs the decisive key-state write. |
| `0x00100958` | `0xFD8` | `0x7C22C730` | `SQ v0,-0x38D0(at)` | None | `at=0x001D0000`, so the transformed 16 bytes are stored to `0x001CC730`. Executes before the called routine because it is the `JAL` delay slot. |
| `0x0010095C` | `0xFDC` | `0x93A40111` | `LBU a0,0x111(sp)` | `a0 = stack byte` | Post-transform logic. |
| `0x00100960` | `0xFE0` | `0x0000802D` | `DADDU s0,zero,zero` (`MOVE s0,zero`) | `s0 = 0` | Post-transform logic. |
| `0x00100964` | `0xFE4` | `0x93A30112` | `LBU v1,0x112(sp)` | `v1 = stack byte` | Post-transform logic. |
| `0x00100968` | `0xFE8` | `0x93A20113` | `LBU v0,0x113(sp)` | `v0 = stack byte` | Post-transform logic. |
| `0x0010096C` | `0xFEC` | `0x00831821` | `ADDU v1,a0,v1` | `v1 = a0 + v1` | Post-transform checksum/selection logic. |
| `0x00100970` | `0xFF0` | `0x00431021` | `ADDU v0,v0,v1` | `v0 = v0 + v1` | Post-transform checksum/selection logic. |
| `0x00100974` | `0xFF4` | `0x10000006` | `BEQ zero,zero,0x00100990` (`B 0x00100990`) | None | Unconditional branch. |
| `0x00100978` | `0xFF8` | `0x305100FF` | `ANDI s1,v0,0xFF` | `s1 = v0 & 0xFF` | Branch delay slot. |
| `0x0010097C` | `0xFFC` | `0x00000000` | `NOP` | None | Not executed on the unconditional branch path. |

## VU0 microprogram loaded at micro address 0

The executable contains a VIF packet at EE VA `0x00143B10`:

| EE VA | File offset | Raw word | Meaning |
|---:|---:|---:|---|
| `0x00143B10` | `0x44190` | `0x00000000` | VIF `NOP`. |
| `0x00143B14` | `0x44194` | `0x4A0B0000` | VIF `MPG`, `NUM=11`, destination micro address `0`. The next 11 64-bit pairs are VU microinstructions. |

VU microinstructions are shown as lower word plus upper word. An upper instruction carrying the `I` bit causes its paired lower word to be loaded into scalar register `I`; that new value is consumed by the following microinstruction. The component mask selects exactly one destination lane.

| Micro PC | EE VA / file offset | Lower word | Upper word | Decoded pair | Register effect |
|---:|---|---:|---:|---|---|
| `0` | `0x143B18 / 0x44198` | `0x42FECCCD` | `0x800002FF` | `LOI 0x42FECCCD` \| `VNOP` (`I` bit) | Loads multiplier for the next x-lane instruction. |
| `1` | `0x143B20 / 0x441A0` | `0x42546666` | `0x8100089E` | `LOI 0x42546666` \| `MULi.x vf2,vf1,I` | `vf2.x = VU_MUL(vf1.x,0x42FECCCD)`; loads x addend for the next instruction. |
| `2` | `0x143B28 / 0x441A8` | `0x43D80D3E` | `0x810010E2` | `LOI 0x43D80D3E` \| `ADDi.x vf3,vf2,I` | `vf3.x = VU_ADD(vf2.x,0x42546666)`; loads y multiplier. |
| `3` | `0x143B30 / 0x441B0` | `0xC7F079B3` | `0x8080089E` | `LOI 0xC7F079B3` \| `MULi.y vf2,vf1,I` | `vf2.y = VU_MUL(vf1.y,0x43D80D3E)`; loads y addend. |
| `4` | `0x143B38 / 0x441B8` | `0x43A0DA10` | `0x808010E2` | `LOI 0x43A0DA10` \| `ADDi.y vf3,vf2,I` | `vf3.y = VU_ADD(vf2.y,0xC7F079B3)`; loads z multiplier. |
| `5` | `0x143B40 / 0x441C0` | `0x43A02666` | `0x8040089E` | `LOI 0x43A02666` \| `MULi.z vf2,vf1,I` | `vf2.z = VU_MUL(vf1.z,0x43A0DA10)`; loads z addend. |
| `6` | `0x143B48 / 0x441C8` | `0x43546E14` | `0x804010E2` | `LOI 0x43546E14` \| `ADDi.z vf3,vf2,I` | `vf3.z = VU_ADD(vf2.z,0x43A02666)`; loads w multiplier. |
| `7` | `0x143B50 / 0x441D0` | `0x42F23333` | `0x8020089E` | `LOI 0x42F23333` \| `MULi.w vf2,vf1,I` | `vf2.w = VU_MUL(vf1.w,0x43546E14)`; loads w addend. |
| `8` | `0x143B58 / 0x441D8` | `0x3DD3DD98` | `0x802010E2` | `LOI 0x3DD3DD98` \| `ADDi.w vf3,vf2,I` | `vf3.w = VU_ADD(vf2.w,0x42F23333)`. The newly loaded `0x3DD3DD98` is dead because no later instruction consumes `I`. |
| `9` | `0x143B60 / 0x441E0` | `0x8000033C` | `0x400002FF` | `MOVE vf0,vf0` (lower NOP idiom) \| `VNOP` (`E` bit) | Marks program end. One microinstruction delay slot follows. |
| `10` | `0x143B68 / 0x441E8` | `0x8000033C` | `0x000002FF` | `MOVE vf0,vf0` (lower NOP idiom) \| `VNOP` | End delay slot; no state change. |

## Reconstructed transformation

There is no cross-lane shuffle, byte permutation, integer conversion, or packing operation. Each input lane remains in place and receives one PS2 VU multiply followed by one PS2 VU add:

```text
vf1 = load_u128_le(sp + 0x90)

vf3.x = VU_ADD(VU_MUL(vf1.x, bits32(0x42FECCCD)), bits32(0x42546666))
vf3.y = VU_ADD(VU_MUL(vf1.y, bits32(0x43D80D3E)), bits32(0xC7F079B3))
vf3.z = VU_ADD(VU_MUL(vf1.z, bits32(0x43A0DA10)), bits32(0x43A02666))
vf3.w = VU_ADD(VU_MUL(vf1.w, bits32(0x43546E14)), bits32(0x42F23333))

store_u128_le(sp + 0x90, vf3)
store_u128_le(0x001CC730, load_u128_le(sp + 0x90))
```

`VU_MUL` and `VU_ADD` must use PS2 VU floating-point behavior rather than ordinary host IEEE-754 arithmetic. The standalone implementation in `EE_KEY_TRANSFORM.py` includes the VU mantissa multiplier correction and adder alignment/truncation needed to reproduce the hardware result.
