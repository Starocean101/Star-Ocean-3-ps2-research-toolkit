# SO3 SAC movie-audio recovery

## Result

SO3 movie audio is decoded to 48 kHz stereo PCM WAV. MPEG-PS is only its
transport: audio packets use stream id `0xBD`, and each payload begins with
`FF 90 00 01`. Removing that subheader and concatenating payloads recreates the
stream consumed by `Csd_.irx`.

## Recovered stages

- Fixed 32-byte SAC header and 256-symbol frequency table.
- CRC16-CCITT (`0x1021`, initial `0xFFFF`, complemented result).
- 32-bit arithmetic range decoder from `RangeDecodeInit` and
  `StMakeHuffRange` in `Csd_.irx`.
- Predictive 28-control block headers and variable 32-value coefficient groups.
- VU1 dequantization: one global scale, 27 band quantizers, and the executable's
  `2*(n/512)^(4/3)` interpolation curve.
- 32-band polyphase synthesis with the original 512-float MPEG window recovered
  from the SLES VIF/VU tables.
- Final stereo matrix, initial trim, and final sample index.

Each compressed block yields 1,024 samples per channel. That independently
fixes the sample rate at 48 kHz from movie timing.

## Validation

| Check | Entry 21 | Entry 15 |
|---|---:|---:|
| SAC bytes | 94,885 | 241,457 |
| SAC blocks | 255 | 438 |
| CRCs passed | 255/255 | 438/438 |
| Samples/channel | 260,783 | 447,982 |
| Duration | 5.432979 s | 9.332958 s |
| WAV SHA-256 | `bf40fbdc42dc4f44cdf0273753fac5acdfbe78c2a0f96227377545eadf01f133` | `496d7961ebe6d252da1da8008f31f6ff136099d167514ab93a3fc6baf3566257` |

Python and JavaScript implementations produce those same WAV hashes. Their
spectra are coherent and time-varying rather than entropy noise. A human
listening check on the target device remains the final perceptual validation.

## Relationship to ordinary game audio

Known SEQW/MMD-family sounds use 16-byte PS2 ADPCM frames. SAC shares neither
that framing nor its predictor. The paths converge only at PCM/mixing output;
reusing the ADPCM decoder for movie packets would be incorrect.
