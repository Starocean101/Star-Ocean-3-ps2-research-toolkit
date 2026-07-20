/* Star Ocean 3 SAC movie-audio decoder.
 * Portable translation of Csd_.irx range coding plus the SLES VU1
 * dequantizer and MPEG 32-subband synthesis stage.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SO3V54Sac = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '5.4.0';
  const SAMPLE_RATE = 48000;
  const WINDOW_B64 = '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';

  function bytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return Uint8Array.from(input || []);
  }
  function concat(parts) {
    const list = parts.map(bytes), size = list.reduce((n, x) => n + x.length, 0), out = new Uint8Array(size);
    let p = 0; for (const part of list) { out.set(part, p); p += part.length; } return out;
  }
  function u16(b, p) { return b[p] | (b[p + 1] << 8); }
  function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }
  function s16(v) { v &= 0xffff; return v & 0x8000 ? v - 0x10000 : v; }
  function clamp16(v) { return Math.max(-32768, Math.min(32767, Math.round(v))); }
  function findStart(b, p) { for (let i = p; i + 3 < b.length; i++) if (!b[i] && !b[i + 1] && b[i + 2] === 1) return i; return -1; }

  function demuxSac(program) {
    const b = bytes(program), chunks = []; let p = 0;
    while (p + 6 <= b.length) {
      const m = findStart(b, p); if (m < 0 || m + 6 > b.length) break;
      const sid = b[m + 3];
      if (sid === 0xba) { if (m + 14 > b.length) break; p = m + 14 + (b[m + 13] & 7); continue; }
      if (sid === 0xbb || sid === 0xbe || (sid >= 0xbd && sid <= 0xef)) {
        const end = m + 6 + ((b[m + 4] << 8) | b[m + 5]);
        if (end > b.length) throw Error(`truncated PES at 0x${m.toString(16)}`);
        if (sid === 0xbd) {
          const start = m + 9 + b[m + 8];
          if (start + 4 > end || b[start] !== 0xff || b[start + 1] !== 0x90 || b[start + 2] || b[start + 3] !== 1)
            throw Error('private_stream_1 does not contain the SO3 SAC transport subheader');
          chunks.push(b.slice(start + 4, end));
        }
        p = end; continue;
      }
      p = m + 4;
    }
    if (!chunks.length) throw Error('no SO3 SAC private_stream_1 packets found');
    return concat(chunks);
  }

  function crc16(b, start, end) {
    let crc = 0xffff;
    for (let p = start; p < end; p++) {
      crc ^= b[p] << 8;
      for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return (~crc) & 0xffff;
  }

  class RangeDecoder {
    constructor(data, offset, frequencies, cumulative) {
      this.data = data; this.pos = offset + 4;
      this.code = (((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0);
      this.low = 0; this.width = 0xffffffff; this.frequencies = frequencies; this.cumulative = cumulative;
    }
    nextByte() { if (this.pos >= this.data.length) throw Error('SAC range decoder overread'); return this.data[this.pos++]; }
    normalize() {
      while (((this.low ^ ((this.low + this.width) >>> 0)) >>> 0) <= 0x00ffffff) {
        this.code = ((this.code << 8) | this.nextByte()) >>> 0; this.width = (this.width << 8) >>> 0; this.low = (this.low << 8) >>> 0;
      }
      while (this.width <= 0xffff) {
        this.code = ((this.code << 8) | this.nextByte()) >>> 0; this.width = (((-this.low) & 0xffff) << 8) >>> 0; this.low = (this.low << 8) >>> 0;
      }
    }
    uniform(bits) {
      const unit = Math.floor(this.width / (2 ** bits)); if (!unit) throw Error('zero SAC uniform range');
      const value = Math.floor(((this.code - this.low) >>> 0) / unit);
      this.low = (this.low + value * unit) >>> 0; this.width = unit >>> 0; this.normalize(); return value;
    }
    sample() {
      const unit = Math.floor(this.width / 16384); if (!unit) throw Error('zero SAC symbol range');
      const quotient = Math.floor(((this.code - this.low) >>> 0) / unit); if (quotient >= 16383) throw Error('SAC symbol quotient out of range');
      let lo = 0, hi = 256;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.cumulative[mid + 1] <= quotient) lo = mid + 1; else hi = mid; }
      const symbol = lo, frequency = this.frequencies[symbol]; if (!frequency) throw Error('SAC probability lookup failed');
      this.low = (this.low + this.cumulative[symbol] * unit) >>> 0; this.width = (frequency * unit) >>> 0; this.normalize();
      const folded = symbol < 254 ? symbol : symbol === 254 ? this.uniform(8) + 254 : this.uniform(13);
      return folded & 1 ? -Math.floor((s16(folded) + 1) / 2) : folded >>> 1;
    }
  }

  function synthesisWindow() {
    const raw = typeof atob === 'function' ? atob(WINDOW_B64) : Buffer.from(WINDOW_B64, 'base64').toString('binary');
    const ab = new ArrayBuffer(raw.length), u = new Uint8Array(ab); for (let i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i);
    const view = new DataView(ab), out = []; for (let i = 0; i < 512; i++) out.push(view.getFloat32(i * 4, true)); return out;
  }
  const WINDOW = synthesisWindow();
  const MATRIX = Array.from({ length: 64 }, (_, i) => Array.from({ length: 32 }, (_, k) => Math.cos((16 + i) * (2 * k + 1) * Math.PI / 64)));

  class Synth {
    constructor() { this.v = new Float64Array(1024); }
    slot(s) {
      this.v.copyWithin(64, 0, 960);
      for (let i = 0; i < 64; i++) { let x = 0; for (let k = 0; k < 32; k++) x += s[k] * MATRIX[i][k]; this.v[i] = x; }
      const out = new Array(32).fill(0);
      for (let j = 0; j < 32; j++) for (let i = 0; i < 8; i++) {
        out[j] += this.v[i * 128 + j] * WINDOW[i * 64 + j];
        out[j] += this.v[i * 128 + 96 + j] * WINDOW[i * 64 + 32 + j];
      }
      return out;
    }
  }

  function dequant(values, globalScale, q) {
    const blockScale = globalScale === 0 ? 511 / 512 : 2 ** (-globalScale / 4), scale = blockScale * 2 ** -q;
    return values.map((value) => {
      if (!value) return 0; const u = Math.abs(value) * scale * 512, n = Math.trunc(u), f = u - n;
      if (n >= 511) throw Error(`SAC dequantizer index ${n} exceeds verified range`);
      const low = 2 * ((n / 512) ** (4 / 3)), high = 2 * (((n + 1) / 512) ** (4 / 3));
      const result = low + (high - low) * f; return value < 0 ? -result : result;
    });
  }
  function synthBlock(block, synth) {
    const bands = block.controls.map((q, i) => q ? dequant(block.bands[i], block.globalScale, q) : new Array(32).fill(0));
    while (bands.length < 32) bands.push(new Array(32).fill(0));
    const pcm = [];
    for (let t = 0; t < 32; t++) pcm.push(...synth.slot(bands.map((band) => band[t])).map((x) => clamp16(x * 32768)));
    return pcm;
  }

  function decodeSac(input) {
    const b = bytes(input); if (b.length < 32 || u32(b, 0) !== 32) throw Error('invalid SAC fixed header');
    const header = { header_size: 32, field_04: u32(b, 4), first_trim_a: u16(b, 8), first_trim_b: u16(b, 10), block_count: u16(b, 12), final_sample_index: u16(b, 14), stream_window_a: u32(b, 16), stream_window_b: u32(b, 20), stereo_matrix: b[24] };
    const frequencies = [], cumulative = [0]; let p = 32;
    for (let i = 0; i < 256; i++) { let v = b[p++]; if (v & 0x80) v = (v & 0x7f) | (b[p++] << 7); frequencies.push(v); cumulative.push(cumulative.at(-1) + v); }
    if (cumulative[256] !== 16383) throw Error('invalid SAC probability total');
    const previous = [new Int16Array(32), new Int16Array(32)], blocks = []; let crcPassed = 0;
    for (let sequence = 1; sequence <= header.block_count; sequence++) {
      const stored = u16(b, p), flags = u16(b, p + 2), length = flags & 0x7fff, end = p + 8 + length;
      if (u16(b, p + 4) !== sequence || end > b.length) throw Error(`invalid SAC block ${sequence}`);
      if (crc16(b, p + 4, end) !== stored) throw Error(`SAC CRC mismatch in block ${sequence}`); crcPassed++;
      const decoder = new RangeDecoder(b, p + 8, frequencies, cumulative), channels = [];
      for (let ch = 0; ch < 2; ch++) {
        let target = 28, index = 0; const compact = [];
        while (index < target) {
          let value = decoder.sample();
          if (index < 28) { if (flags & 0x8000) value += previous[ch][index]; value = s16(value); previous[ch][index] = value; if (index && value) target += 32; }
          else value = s16(value);
          compact.push(value); index++;
        }
        const controls = compact.slice(1, 28), bands = []; let cp = 28;
        for (const q of controls) { bands.push(q ? compact.slice(cp, cp += 32) : null); }
        if (cp !== compact.length) throw Error(`SAC compact layout mismatch in block ${sequence}`);
        channels.push({ globalScale: compact[0], controls, bands });
      }
      if (decoder.pos !== end) throw Error(`SAC coded-length mismatch in block ${sequence}`); blocks.push(channels); p = end;
    }
    if (u32(b, p) !== 0xffffffff || p + 4 !== b.length) throw Error('invalid SAC terminator');
    const synth = [new Synth(), new Synth()], left = [], right = [];
    for (let i = 0; i < blocks.length; i++) {
      let a = synthBlock(blocks[i][0], synth[0]), c = synthBlock(blocks[i][1], synth[1]);
      const start = i === 0 ? header.first_trim_b : 0, count = i === blocks.length - 1 ? header.final_sample_index + 1 : 1024;
      a = a.slice(start, start + count); c = c.slice(start, start + count);
      for (let n = 0; n < a.length; n++) { if (header.stereo_matrix) { left.push(clamp16(a[n] + c[n])); right.push(clamp16(a[n] - c[n])); } else { left.push(a[n]); right.push(c[n]); } }
    }
    return { header, sample_rate: SAMPLE_RATE, left, right, crc_passed: crcPassed, sac_size: b.length };
  }

  function wav(result) {
    const samples = result.left.length, out = new Uint8Array(44 + samples * 4), v = new DataView(out.buffer);
    const text = (p, s) => { for (let i = 0; i < s.length; i++) out[p + i] = s.charCodeAt(i); };
    text(0, 'RIFF'); v.setUint32(4, out.length - 8, true); text(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, result.sample_rate, true); v.setUint32(28, result.sample_rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); text(36, 'data'); v.setUint32(40, samples * 4, true);
    for (let i = 0; i < samples; i++) { v.setInt16(44 + i * 4, result.left[i], true); v.setInt16(46 + i * 4, result.right[i], true); }
    return out;
  }

  function decodeProgramStream(program) { const sac = demuxSac(program), result = decodeSac(sac); return { sac, result, wav: wav(result) }; }
  function decodeParts(parts) { return decodeProgramStream(concat(parts)); }
  return Object.freeze({ VERSION, SAMPLE_RATE, WINDOW, bytes, concat, demuxSac, crc16, RangeDecoder, decodeSac, wav, decodeProgramStream, decodeParts });
});
