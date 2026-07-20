/* SO3 Resource Explorer V5.5 MPEG-PS audio replacement.
 *
 * Replaces tri-Ace SAC private_stream_1 packets with standard DVD LPCM PES
 * packets. The original MPEG-2 video and all non-SAC program-stream bytes
 * remain byte-for-byte unchanged. Audio timestamps are taken from the SAC PES
 * records; PCM packet timestamps are interpolated at exactly 48 kHz.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SO3V55Mux = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '5.5.0';
  const CLOCK = 90000;
  const SAMPLE_RATE = 48000;
  const PCM_FRAMES_PER_PES = 500;
  const SAC_SUBHEADER = [0xff, 0x90, 0x00, 0x01];
  const LPCM_SUBHEADER = [0xa0, 0x07, 0x00, 0x04, 0x0c, 0x01, 0x80];

  function bytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return Uint8Array.from(input || []);
  }

  function concat(parts) {
    const list = parts.map(bytes), size = list.reduce((n, part) => n + part.length, 0), out = new Uint8Array(size);
    let p = 0;
    for (const part of list) { out.set(part, p); p += part.length; }
    return out;
  }

  function findStart(b, p) {
    for (let i = p; i + 3 < b.length; i++) if (!b[i] && !b[i + 1] && b[i + 2] === 1) return i;
    return -1;
  }

  function readPts(b, p) {
    if (p + 5 > b.length || !(b[p] & 1) || !(b[p + 2] & 1) || !(b[p + 4] & 1)) throw Error('invalid MPEG PTS marker bits');
    return ((b[p] >> 1) & 7) * (2 ** 30) + b[p + 1] * (2 ** 22) + ((b[p + 2] >> 1) & 0x7f) * (2 ** 15) + b[p + 3] * 128 + ((b[p + 4] >> 1) & 0x7f);
  }

  function writePts(out, p, value) {
    const pts = ((value % (2 ** 33)) + (2 ** 33)) % (2 ** 33);
    out[p] = 0x21 | (Math.floor(pts / (2 ** 29)) & 0x0e);
    out[p + 1] = Math.floor(pts / (2 ** 22)) & 0xff;
    out[p + 2] = 1 | (Math.floor(pts / (2 ** 14)) & 0xfe);
    out[p + 3] = Math.floor(pts / 128) & 0xff;
    out[p + 4] = 1 | ((pts & 0x7f) << 1);
  }

  function sacPackets(program) {
    const b = bytes(program), packets = []; let p = 0;
    while (p + 6 <= b.length) {
      const m = findStart(b, p);
      if (m < 0 || m + 6 > b.length) break;
      const sid = b[m + 3];
      if (sid === 0xba) {
        if (m + 14 > b.length) throw Error(`truncated pack header at 0x${m.toString(16)}`);
        p = m + 14 + (b[m + 13] & 7); continue;
      }
      if (sid === 0xbb || sid === 0xbe || (sid >= 0xbd && sid <= 0xef)) {
        const length = (b[m + 4] << 8) | b[m + 5], end = m + 6 + length;
        if (end > b.length) throw Error(`truncated PES at 0x${m.toString(16)}`);
        if (sid === 0xbd) {
          if (m + 9 > end || (b[m + 7] & 0xc0) !== 0x80 || b[m + 8] < 5) throw Error('SAC PES is missing its required PTS');
          const payload = m + 9 + b[m + 8];
          if (payload + 4 > end || !SAC_SUBHEADER.every((v, i) => b[payload + i] === v)) throw Error('private_stream_1 packet is not the verified SO3 SAC transport');
          packets.push({ start: m, end, pts: readPts(b, m + 9), payload });
        }
        p = end; continue;
      }
      p = m + 4;
    }
    if (!packets.length) throw Error('no timestamped SO3 SAC packets found');
    for (let i = 1; i < packets.length; i++) if (packets[i].pts < packets[i - 1].pts) throw Error('SAC PTS sequence is not monotonic');
    return packets;
  }

  function pcmBigEndian(result, start, count) {
    const out = new Uint8Array(count * 4), view = new DataView(out.buffer);
    for (let i = 0; i < count; i++) {
      view.setInt16(i * 4, result.left[start + i], false);
      view.setInt16(i * 4 + 2, result.right[start + i], false);
    }
    return out;
  }

  function lpcmPes(pcm, pts) {
    const data = bytes(pcm), pesLength = 3 + 5 + LPCM_SUBHEADER.length + data.length;
    if (data.length % 4) throw Error('LPCM payload is not aligned to stereo sample frames');
    if (pesLength > 0xffff) throw Error('LPCM PES exceeds the MPEG packet-length field');
    const out = new Uint8Array(6 + pesLength);
    out.set([0x00, 0x00, 0x01, 0xbd, pesLength >> 8, pesLength & 0xff, 0x80, 0x80, 0x05], 0);
    writePts(out, 9, pts);
    out.set(LPCM_SUBHEADER, 14);
    out.set(data, 14 + LPCM_SUBHEADER.length);
    return out;
  }

  function sampleBoundaries(packets, sampleCount, sampleRate) {
    const first = packets[0].pts, boundaries = packets.map((packet) => Math.round((packet.pts - first) * sampleRate / CLOCK));
    boundaries[0] = 0;
    for (let i = 1; i < boundaries.length; i++) boundaries[i] = Math.max(boundaries[i - 1], Math.min(sampleCount, boundaries[i]));
    boundaries.push(sampleCount);
    return boundaries;
  }

  function muxProgramStream(program, decodedAudio) {
    const b = bytes(program), result = decodedAudio && decodedAudio.result ? decodedAudio.result : decodedAudio;
    if (!result || !result.left || !result.right) throw Error('decoded stereo SAC result is required');
    if (result.sample_rate !== SAMPLE_RATE) throw Error(`LPCM mux requires ${SAMPLE_RATE} Hz audio`);
    if (result.left.length !== result.right.length) throw Error('SAC channel lengths differ');
    const packets = sacPackets(b), boundaries = sampleBoundaries(packets, result.left.length, result.sample_rate), parts = [];
    const firstPts = packets[0].pts; let cursor = 0, lpcmPackets = 0, pcmFrames = 0;
    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i], segmentStart = boundaries[i], segmentEnd = boundaries[i + 1];
      parts.push(b.slice(cursor, packet.start));
      for (let start = segmentStart; start < segmentEnd; start += PCM_FRAMES_PER_PES) {
        const count = Math.min(PCM_FRAMES_PER_PES, segmentEnd - start);
        const pts = firstPts + Math.round(start * CLOCK / result.sample_rate);
        parts.push(lpcmPes(pcmBigEndian(result, start, count), pts));
        lpcmPackets++; pcmFrames += count;
      }
      cursor = packet.end;
    }
    parts.push(b.slice(cursor));
    if (pcmFrames !== result.left.length) throw Error(`LPCM mux emitted ${pcmFrames} of ${result.left.length} frames`);
    const output = concat(parts);
    return {
      bytes: output,
      blob: typeof Blob === 'function' ? new Blob([output], { type: 'video/mpeg' }) : null,
      metrics: {
        input_bytes: b.length,
        output_bytes: output.length,
        replaced_sac_packets: packets.length,
        lpcm_packets: lpcmPackets,
        pcm_frames: pcmFrames,
        sample_rate: result.sample_rate,
        channels: 2,
        first_audio_pts: firstPts,
        duration_seconds: pcmFrames / result.sample_rate,
        video_and_non_sac_bytes_preserved: true,
      },
    };
  }

  return Object.freeze({ VERSION, CLOCK, SAMPLE_RATE, PCM_FRAMES_PER_PES, SAC_SUBHEADER, LPCM_SUBHEADER, bytes, concat, readPts, writePts, sacPackets, pcmBigEndian, lpcmPes, sampleBoundaries, muxProgramStream });
});
