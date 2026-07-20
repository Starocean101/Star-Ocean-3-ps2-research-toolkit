# SLE Key Recovery

## Final result

```text
PAL final key:
66665442b379f0c7e7d51e4b7ba41c7d
```

## Recovery chain

### IOP module source

Hidden entry 1 decodes into twelve IOP ELF/IRX modules. Module `Csi_` registers
SIF RPC server `0x1234`.

Its dispatch table routes function `0x0E` to `OnCsGetSecretKeyCode`.

### Stored secret

Symbol:

```text
gunSecretKeyCode
```

Stored bytes:

```text
a4489c4f7d31fe78773703b9ca3ac386
```

The function complements four 32-bit words, producing the direct IOP response:

```text
5bb763b082ce018788c8fc4635c53c79
```

### EE/VU transform

The EE loads the response into `vf1`, executes `VCALLMS 0`, stores `vf3`, and
then writes the transformed vector to `0x001CC730`.

The per-lane transformation uses PS2 VU multiply/add semantics:

```text
x = VU_ADD(VU_MUL(x, 0x42FECCCD), 0x42546666)
y = VU_ADD(VU_MUL(y, 0x43D80D3E), 0xC7F079B3)
z = VU_ADD(VU_MUL(z, 0x43A0DA10), 0x43A02666)
w = VU_ADD(VU_MUL(w, 0x43546E14), 0x42F23333)
```

Result:

```text
66665442b379f0c7e7d51e4b7ba41c7d
```

As little-endian 32-bit words:

```text
0x42546666
0xC7F079B3
0x4B1ED5E7
0x7D1CA47B
```

See `research/final-results/FINAL_SLE_KEY_REPORT.md` and
`tools/python/ee_key_transform.py` for the detailed bit-exact implementation.

## Why strict validation matters

Several plausible arithmetic interpretations differ by one bit. Only the PS2 VU
model yields a stream that:

- consumes all 4227 compressed bytes;
- produces exactly 9008 output bytes;
- contains no invalid back-reference;
- begins with `PACK`;
- hashes to the known validated output.
