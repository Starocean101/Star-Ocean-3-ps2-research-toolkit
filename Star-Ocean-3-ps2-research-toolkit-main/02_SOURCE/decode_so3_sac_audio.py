#!/usr/bin/env python3
"""Decode Star Ocean 3 movie SAC audio to stereo PCM WAV.

SO3 stores MPEG-2 video normally, but places tri-Ace SAC audio in MPEG-PS
private_stream_1 (stream id 0xBD).  Each PES payload starts with the four-byte
transport subheader FF 90 00 01.  Removing that subheader and concatenating the
payloads yields the byte stream consumed by Csd_.irx.

The entropy decoder is a literal portable translation of these Csd_.irx
functions, while the dequantizer and 32-band synthesis stage are a high-level
translation of the SAC VU1 microprogram embedded in SLES_820.28:
  RangeDecodeInit  0x00003080
  StMakeHuffRange  0x000022C8
  StMakeFinalOut   0x00003358

The adjacent ``so3_sac_vu_tables.bin`` contains the 16 KiB VU data-memory
image reconstructed from the game's three static VIF initialization streams.
It supplies the original 512-entry MPEG synthesis window.  The dequantization
curve is reproduced algebraically from that same table.

The two supplied PAL movie streams use mode 0 (independent L/R).  Mode != 0 is
also implemented as Csd_'s saturating mid/side reconstruction.
"""

from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import math
import struct
import wave
from dataclasses import dataclass
from pathlib import Path

PES_MAGIC = b"\x00\x00\x01"
SAC_PES_SUBHEADER = b"\xff\x90\x00\x01"
U32_MASK = 0xFFFFFFFF


def _u16(data: bytes, offset: int) -> int:
    return struct.unpack_from("<H", data, offset)[0]


def _u32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def _s16(value: int) -> int:
    value &= 0xFFFF
    return value - 0x10000 if value & 0x8000 else value


def _clamp16(value: int) -> int:
    return max(-32768, min(32767, value))


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _pts5(data: bytes) -> int:
    return (
        (((data[0] >> 1) & 7) << 30)
        | (data[1] << 22)
        | (((data[2] >> 1) & 0x7F) << 15)
        | (data[3] << 7)
        | ((data[4] >> 1) & 0x7F)
    )


@dataclass(frozen=True)
class PesAudioPacket:
    offset: int
    pts: int | None
    payload: bytes


def demux_private_stream_1(program_stream: bytes) -> list[PesAudioPacket]:
    """Walk bounded MPEG-PS records and return valid 0xBD payloads."""
    packets: list[PesAudioPacket] = []
    pos = 0
    end = len(program_stream)
    while pos + 6 <= end:
        marker = program_stream.find(PES_MAGIC, pos)
        if marker < 0 or marker + 6 > end:
            break
        sid = program_stream[marker + 3]
        if sid == 0xBA:
            if marker + 14 > end:
                break
            pos = marker + 14 + (program_stream[marker + 13] & 7)
            continue
        if sid in (0xBB, 0xBE) or 0xBD <= sid <= 0xEF:
            length = int.from_bytes(program_stream[marker + 4 : marker + 6], "big")
            record_end = marker + 6 + length
            if record_end > end:
                raise ValueError(f"truncated PES record at {marker:#x}")
            if sid == 0xBD:
                if marker + 9 > record_end:
                    raise ValueError(f"short private_stream_1 header at {marker:#x}")
                flags2 = program_stream[marker + 7]
                header_length = program_stream[marker + 8]
                payload_start = marker + 9 + header_length
                if payload_start > record_end:
                    raise ValueError(f"invalid private_stream_1 header length at {marker:#x}")
                pts = None
                if flags2 & 0x80:
                    if marker + 14 > record_end:
                        raise ValueError(f"short PTS at {marker:#x}")
                    pts = _pts5(program_stream[marker + 9 : marker + 14])
                packets.append(PesAudioPacket(marker, pts, program_stream[payload_start:record_end]))
            pos = record_end
            continue
        pos = marker + 4
    return packets


def rebuild_sac_stream(packets: list[PesAudioPacket]) -> bytes:
    if not packets:
        raise ValueError("no MPEG private_stream_1 packets found")
    chunks: list[bytes] = []
    for index, packet in enumerate(packets):
        if not packet.payload.startswith(SAC_PES_SUBHEADER):
            raise ValueError(f"packet {index} does not start with FF900001")
        if packet.payload.count(SAC_PES_SUBHEADER) != 1:
            raise ValueError(f"packet {index} has an unexpected FF900001 recurrence count")
        chunks.append(packet.payload[4:])
    return b"".join(chunks)


def crc16_complement(data: bytes) -> int:
    """Csd_ CheckCRC16: CCITT 0x1021, init FFFF, final complement."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return (~crc) & 0xFFFF


class RangeDecoder:
    def __init__(self, data: bytes, offset: int, frequencies: list[int]):
        if offset + 4 > len(data):
            raise ValueError("truncated SAC range-code seed")
        self.data = data
        self.pos = offset + 4
        self.code = int.from_bytes(data[offset : offset + 4], "big")
        self.low = 0
        self.width = U32_MASK
        self.frequencies = frequencies
        self.cumulative = [0]
        for frequency in frequencies:
            self.cumulative.append(self.cumulative[-1] + frequency)

    def _byte(self) -> int:
        if self.pos >= len(self.data):
            raise ValueError("SAC range decoder overread")
        value = self.data[self.pos]
        self.pos += 1
        return value

    def _renormalize(self) -> None:
        while (self.low ^ ((self.low + self.width) & U32_MASK)) <= 0x00FFFFFF:
            self.code = ((self.code << 8) & U32_MASK) | self._byte()
            self.width = (self.width << 8) & U32_MASK
            self.low = (self.low << 8) & U32_MASK
        while self.width <= 0xFFFF:
            self.code = ((self.code << 8) & U32_MASK) | self._byte()
            self.width = ((-self.low) & 0xFFFF) << 8
            self.low = (self.low << 8) & U32_MASK

    def _uniform(self, bits: int) -> int:
        unit = self.width >> bits
        if not unit:
            raise ValueError("zero SAC uniform range")
        value = ((self.code - self.low) & U32_MASK) // unit
        self.low = (self.low + value * unit) & U32_MASK
        self.width = unit
        self._renormalize()
        return value

    def sample(self) -> int:
        unit = self.width >> 14
        if not unit:
            raise ValueError("zero SAC symbol range")
        quotient = ((self.code - self.low) & U32_MASK) // unit
        if quotient >= 16383:
            raise ValueError(f"SAC symbol quotient out of range: {quotient}")
        symbol = bisect.bisect_right(self.cumulative, quotient) - 1
        while symbol < 256 and self.frequencies[symbol] == 0:
            symbol += 1
        if symbol >= 256 or not (self.cumulative[symbol] <= quotient < self.cumulative[symbol + 1]):
            raise ValueError("SAC probability-table lookup failed")
        self.low = (self.low + self.cumulative[symbol] * unit) & U32_MASK
        self.width = self.frequencies[symbol] * unit
        self._renormalize()

        if symbol < 254:
            folded = symbol
        elif symbol == 254:
            folded = self._uniform(8) + 254
        else:
            folded = self._uniform(13)
        return -((_s16(folded) + 1) // 2) if folded & 1 else folded >> 1


@dataclass(frozen=True)
class SacHeader:
    header_size: int
    field_04: int
    first_trim_a: int
    first_trim_b: int
    block_count: int
    final_sample_index: int
    stream_window_a: int
    stream_window_b: int
    stereo_matrix: int


@dataclass
class SacDecodeResult:
    header: SacHeader
    sample_rate: int
    left: list[int]
    right: list[int]
    block_lengths: list[tuple[int, int]]
    crc_passed: int
    bytes_consumed: int
    terminator: bytes


@dataclass(frozen=True)
class SacChannelBlock:
    """One channel's entropy-decoded SAC control and coefficient payload."""

    global_scale: int
    band_controls: tuple[int, ...]
    quantized_bands: tuple[tuple[int, ...] | None, ...]
    compact_length: int


def _load_synthesis_window(table_path: Path | None = None) -> tuple[float, ...]:
    """Load the game's 512-float MPEG polyphase window from VU data memory."""
    path = table_path or Path(__file__).with_name("so3_sac_vu_tables.bin")
    data = path.read_bytes()
    if len(data) != 0x4000:
        raise ValueError(f"SAC VU table image is {len(data):#x} bytes, expected 0x4000")
    window = struct.unpack_from("<512f", data, 0x1000)
    if not math.isclose(max(window), 1.144989013671875, rel_tol=0.0, abs_tol=1e-9):
        raise ValueError("SAC VU table image does not contain the verified synthesis window")
    return window


def _dequantize_band(values: tuple[int, ...], global_scale: int, quantizer: int) -> list[float]:
    """High-level equivalent of VU1 addresses 0x191..0x281."""
    if not (0 <= global_scale <= 127):
        raise ValueError(f"SAC global scale {global_scale} is outside the VU table")
    if not (1 <= quantizer <= 15):
        raise ValueError(f"SAC band quantizer {quantizer} is outside the verified range")
    # VU table 0x200+n, lane Y is 2^(-n/4).  Entry zero is deliberately
    # 511/512 in the original table.  Table 0x280+q, lane Y is 2^-q.
    block_scale = 511.0 / 512.0 if global_scale == 0 else 2.0 ** (-global_scale / 4.0)
    scale = block_scale * (2.0 ** -quantizer)
    output: list[float] = []
    for value in values:
        if value == 0:
            output.append(0.0)
            continue
        u = abs(value) * scale * 512.0
        index = math.trunc(u)
        if index >= 511:
            raise ValueError(f"SAC dequantizer index {index} exceeds the verified curve")
        fraction = u - index
        # VU table 0x200+n, lane X is exactly 2*(n/512)^(4/3).
        low = 2.0 * ((index / 512.0) ** (4.0 / 3.0))
        high = 2.0 * (((index + 1) / 512.0) ** (4.0 / 3.0))
        sample = low + (high - low) * fraction
        output.append(-sample if value < 0 else sample)
    return output


class PolyphaseSynth:
    """ISO/MPEG 32-subband synthesis using SO3's original 512-float window."""

    def __init__(self, window: tuple[float, ...]):
        self.window = window
        self.v = [0.0] * 1024
        self.matrix = [
            [math.cos((16 + i) * (2 * k + 1) * math.pi / 64.0) for k in range(32)]
            for i in range(64)
        ]

    def slot(self, subbands: list[float]) -> list[float]:
        if len(subbands) != 32:
            raise ValueError("SAC synthesis requires 32 subbands")
        new_v = [sum(subbands[k] * row[k] for k in range(32)) for row in self.matrix]
        self.v[64:] = self.v[:-64]
        self.v[:64] = new_v
        u = [0.0] * 512
        for i in range(8):
            source = i * 128
            target = i * 64
            u[target : target + 32] = self.v[source : source + 32]
            u[target + 32 : target + 64] = self.v[source + 96 : source + 128]
        return [sum(u[j + 32 * i] * self.window[j + 32 * i] for i in range(16)) for j in range(32)]


def _synthesize_channel(block: SacChannelBlock, synth: PolyphaseSynth) -> list[int]:
    bands: list[list[float]] = []
    for control, values in zip(block.band_controls, block.quantized_bands):
        bands.append([0.0] * 32 if control == 0 else _dequantize_band(values or (), block.global_scale, control))
    bands.extend([[0.0] * 32 for _ in range(32 - len(bands))])
    pcm: list[int] = []
    for slot in range(32):
        normalized = synth.slot([bands[band][slot] for band in range(32)])
        pcm.extend(_clamp16(round(value * 32768.0)) for value in normalized)
    return pcm


def _parse_frequency_table(data: bytes, offset: int) -> tuple[list[int], int]:
    values: list[int] = []
    pos = offset
    for _ in range(256):
        if pos >= len(data):
            raise ValueError("truncated SAC probability table")
        value = data[pos]
        pos += 1
        if value & 0x80:
            if pos >= len(data):
                raise ValueError("truncated SAC probability-table varint")
            value = (value & 0x7F) | (data[pos] << 7)
            pos += 1
        values.append(value)
    if sum(values) != 16383:
        raise ValueError(f"SAC probability total is {sum(values)}, expected 16383")
    return values, pos


def decode_sac(data: bytes, sample_rate: int = 48000, table_path: Path | None = None) -> SacDecodeResult:
    if len(data) < 0x20:
        raise ValueError("SAC stream is shorter than its fixed header")
    header = SacHeader(
        header_size=_u32(data, 0x00),
        field_04=_u32(data, 0x04),
        first_trim_a=_u16(data, 0x08),
        first_trim_b=_u16(data, 0x0A),
        block_count=_u16(data, 0x0C),
        final_sample_index=_u16(data, 0x0E),
        stream_window_a=_u32(data, 0x10),
        stream_window_b=_u32(data, 0x14),
        stereo_matrix=data[0x18],
    )
    if header.header_size != 0x20:
        raise ValueError(f"unexpected SAC header size {header.header_size:#x}")
    if not header.block_count:
        raise ValueError("SAC stream declares zero blocks")

    frequencies, pos = _parse_frequency_table(data, header.header_size)
    previous = [[0] * 32 for _ in range(2)]
    decoded_blocks: list[tuple[SacChannelBlock, SacChannelBlock]] = []
    block_lengths: list[tuple[int, int]] = []
    crc_passed = 0

    for expected_sequence in range(1, header.block_count + 1):
        if pos + 8 > len(data):
            raise ValueError(f"truncated SAC block {expected_sequence}")
        stored_crc = _u16(data, pos)
        length_flags = _u16(data, pos + 2)
        coded_length = length_flags & 0x7FFF
        predictive = bool(length_flags & 0x8000)
        sequence = _u16(data, pos + 4)
        end = pos + 8 + coded_length
        if end > len(data):
            raise ValueError(f"SAC block {expected_sequence} exceeds the stream")
        if sequence != expected_sequence:
            raise ValueError(f"SAC sequence is {sequence}, expected {expected_sequence}")
        calculated_crc = crc16_complement(data[pos + 4 : end])
        if calculated_crc != stored_crc:
            raise ValueError(
                f"SAC CRC mismatch in block {sequence}: stored {stored_crc:04x}, calculated {calculated_crc:04x}"
            )
        crc_passed += 1

        decoder = RangeDecoder(data, pos + 8, frequencies)
        channel_blocks: list[SacChannelBlock] = []
        lengths: list[int] = []
        for channel in range(2):
            target = 28
            compact: list[int] = []
            index = 0
            while index < target:
                value = decoder.sample()
                if index < 28:
                    if predictive:
                        value += previous[channel][index]
                    value = _s16(value)
                    previous[channel][index] = value
                    if index and value != 0:
                        target += 32
                else:
                    value = _s16(value)
                compact.append(value)
                index += 1
                if target > 1024:
                    raise ValueError(f"SAC block {sequence} expands beyond its channel buffer")
            controls = compact[:28]
            coefficient_pos = 28
            quantized_bands: list[tuple[int, ...] | None] = []
            for quantizer in controls[1:]:
                if quantizer:
                    values = tuple(compact[coefficient_pos : coefficient_pos + 32])
                    if len(values) != 32:
                        raise ValueError(f"short SAC coefficient group in block {sequence}")
                    coefficient_pos += 32
                    quantized_bands.append(values)
                else:
                    quantized_bands.append(None)
            if coefficient_pos != len(compact):
                raise ValueError(f"SAC compact layout mismatch in block {sequence}")
            channel_blocks.append(
                SacChannelBlock(
                    global_scale=controls[0],
                    band_controls=tuple(controls[1:]),
                    quantized_bands=tuple(quantized_bands),
                    compact_length=target,
                )
            )
            lengths.append(target)

        if decoder.pos != end:
            raise ValueError(
                f"SAC block {sequence} consumed {decoder.pos - pos - 8} coded bytes, declared {coded_length}"
            )
        decoded_blocks.append((channel_blocks[0], channel_blocks[1]))
        block_lengths.append((lengths[0], lengths[1]))
        pos = end

    terminator = data[pos : pos + 4]
    if terminator != b"\xff\xff\xff\xff":
        raise ValueError(f"missing SAC FFFFFFFF terminator at {pos:#x}")
    if pos + 4 != len(data):
        raise ValueError(f"{len(data) - pos - 4} trailing bytes after SAC terminator")

    window = _load_synthesis_window(table_path)
    synth_a = PolyphaseSynth(window)
    synth_b = PolyphaseSynth(window)
    left: list[int] = []
    right: list[int] = []
    for index, (a_block, b_block) in enumerate(decoded_blocks):
        a = _synthesize_channel(a_block, synth_a)
        b = _synthesize_channel(b_block, synth_b)
        start = header.first_trim_b if index == 0 else 0
        count = header.final_sample_index + 1 if index == len(decoded_blocks) - 1 else 1024
        if start > 1024 or count > 1024 or start + count > 1024:
            raise ValueError(f"invalid SAC output trim in block {index + 1}: start={start}, count={count}")
        a = a[start : start + count]
        b = b[start : start + count]
        if header.stereo_matrix:
            left.extend(_clamp16(x + y) for x, y in zip(a, b))
            right.extend(_clamp16(x - y) for x, y in zip(a, b))
        else:
            left.extend(a)
            right.extend(b)

    return SacDecodeResult(
        header=header,
        sample_rate=sample_rate,
        left=left,
        right=right,
        block_lengths=block_lengths,
        crc_passed=crc_passed,
        bytes_consumed=pos + 4,
        terminator=terminator,
    )


def wav_bytes(result: SacDecodeResult) -> bytes:
    import io

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(result.sample_rate)
        frames = bytearray()
        for left, right in zip(result.left, result.right):
            frames += struct.pack("<hh", left, right)
        output.writeframes(frames)
    return buffer.getvalue()


def decode_program_stream(
    program_stream: bytes, sample_rate: int = 48000, table_path: Path | None = None
) -> tuple[SacDecodeResult, bytes, list[PesAudioPacket]]:
    packets = demux_private_stream_1(program_stream)
    sac = rebuild_sac_stream(packets)
    return decode_sac(sac, sample_rate, table_path), sac, packets


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="decoded MPEG-PS (.mpg) or rebuilt SAC stream")
    parser.add_argument("-o", "--output", type=Path, help="output WAV path")
    parser.add_argument("--sac", action="store_true", help="input is already a rebuilt SAC stream")
    parser.add_argument("--rate", type=int, default=48000, help="PCM sample rate (default: 48000)")
    parser.add_argument("--tables", type=Path, help="optional 16 KiB SAC VU data-memory table image")
    parser.add_argument("--manifest", type=Path, help="optional JSON validation manifest")
    args = parser.parse_args()

    source = args.input.read_bytes()
    if args.sac:
        packets: list[PesAudioPacket] = []
        sac = source
        result = decode_sac(sac, args.rate, args.tables)
    else:
        result, sac, packets = decode_program_stream(source, args.rate, args.tables)
    wav = wav_bytes(result)
    output = args.output or args.input.with_suffix(".sac.wav")
    output.write_bytes(wav)

    manifest = {
        "input": args.input.name,
        "input_sha256": _sha256(source),
        "pes_packets": len(packets),
        "sac_size": len(sac),
        "sac_sha256": _sha256(sac),
        "header": result.header.__dict__,
        "frequency_total": 16383,
        "blocks": len(result.block_lengths),
        "crc_passed": result.crc_passed,
        "bytes_consumed": result.bytes_consumed,
        "terminator": result.terminator.hex(),
        "samples_per_channel": len(result.left),
        "sample_rate": result.sample_rate,
        "duration_seconds": len(result.left) / result.sample_rate,
        "wav": {"path": output.name, "size": len(wav), "sha256": _sha256(wav)},
    }
    if args.manifest:
        args.manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
