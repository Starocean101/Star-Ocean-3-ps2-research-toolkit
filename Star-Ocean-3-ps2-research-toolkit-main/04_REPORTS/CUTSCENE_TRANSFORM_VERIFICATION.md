# SO3 movie-carrier transform verification

## Verdict

**PASS — the carrier payload transform is solved and produces valid MPEG-2
program streams.** This supersedes the earlier detector-only/non-playable
status.

## Executable evidence

- Runtime callback object: host context `0x001B6A80` plus `0x15E77C`.
- Callback vtable: `0x00172538`.
- Transform callback slot `+0x08`: Lib VA `0x0041A2F0`.
- Content-key load: host context plus `0x15CB0`, absolute EE VA `0x001CC730`.
- Validated PAL content key: `66665442b379f0c7e7d51e4b7ba41c7d`.
- Lib ELF SHA-256:
  `6848afefbf9af51166b5b38fc9ac4e544ad8d3681e533233e6e1ffaf4114776b`.
- Matching SLES SHA-256:
  `9860bb4487e954cdb93806091acd067d9d154bbe4a03129e16149db5039a41ec`.

The callback receives the newly read ring-buffer address and byte count,
transforms the bytes in place, then flushes the data cache before the ordinary
MPEG parser consumes them.

## Literal inverse

For every 64-byte row, split the carrier into eight little-endian 64-bit lanes.
For lane `i`:

```text
lane_key[i] = embedded_constant[i] XOR content_key_half[i & 1]
plain64     = ((carrier64 XOR lane_key[i]) - 57 - row) mod 2^64
row         = (absolute_offset / 0x40) & 0x1F
```

This is 64-bit arithmetic, not a byte-local subtraction. Borrow propagation is
why the earlier near-MPEG reconstruction preserved outer grammar but damaged
compressed macroblock data.

Derived lane-key byte strings:

```text
4e5223ddf0efdf84
b323271fba593a0a
ab1aabdd204e04f2
bf266094b7db2e19
742512703a1ec293
a1f45d79b65ec2b1
257f661ac5e6d984
b3e7e9067a59250a
```

## Supplied-carrier validation

| Carrier | Size | Decoded SHA-256 | MPEG-2 video | FFmpeg full decode |
| --- | ---: | --- | --- | --- |
| Entry 21 (`CDD2800`) | 3,180,544 | `b9436a2caf88707e3dc4af0996ce8d63feb624420f5bf8a9beb5b2a56f6fcbd7` | 640×448, 25 fps, 136 frames, 5.44 s | 0 reported errors |
| Entry 15 (`8973800`) | 5,556,224 | `6a7604bab6fe0762dee767f7e9a5b1f13415d303f794b3cdafc9337300edcc6c` | 640×448, 25 fps, 234 frames | 0 reported errors |

Both allocations have a final `0x800`-byte tail after their complete
`0x4000` carrier frames. Every complete decoded frame starts with MPEG pack
code `00 00 01 BA` (entry 21: 194/194; entry 15: 339/339).

Start-code census:

| Stream | Pack `BA` | System `BB` | Video PES `E0` | Private `BD` | Sequence `B3` | End `B7` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Entry 21 | 194 | 1 | 751 | 24 | 10 | 1 |
| Entry 15 | 339 | 1 | 1,293 | 61 | 16 | 2 |

Python and browser JavaScript decoders produced the same decoded SHA-256 for
both files. Decode→encode also reproduces the original carrier bytes exactly.

## Remaining boundary

- Browser-native playback is codec-dependent. The Explorer always provides
  the exact `.mpg` download and only attempts inline playback.
- `private_stream_1` packets carry tri-Ace SAC rather than standard MPEG audio.
  V5.4/V5.5 now decode SAC to PCM and mux it as standard DVD LPCM while
  preserving the MPEG-2 video elementary stream.
- No claim is made that every disc carrier has been field-decoded on-device;
  V5.3 keeps the full per-entry carrier gates before enabling decode.
