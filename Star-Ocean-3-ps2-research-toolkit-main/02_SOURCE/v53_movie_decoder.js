/* SO3 Resource Explorer V5.3 exact movie-carrier transform.
 * No DOM dependencies. Works in browsers and CommonJS test runners.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SO3V53Movie = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '5.4.0';
  const ROW_BYTES = 0x40;
  const ROW_PERIOD = 0x20;
  const FRAME_BYTES = 0x4000;
  const UINT64_MASK = (1n << 64n) - 1n;
  const DEFAULT_CONTENT_KEY_HEX = '66665442b379f0c7e7d51e4b7ba41c7d';
  const LANE_CONSTANTS = Object.freeze([
    0x432F96439F773428n,
    0x7726FDC15439F654n,
    0x35F437939FFF7CCDn,
    0x64327FCCDF7EF358n,
    0x5432678932464312n,
    0xCCDEFACD32432146n,
    0x43299F7658321943n,
    0x7739FD014DF73254n,
  ]);
  const PROVENANCE = Object.freeze({
    executable: 'Lib MWo3 overlay from PAL SLES_820.28 runtime',
    function_va: '0x0041A2F0',
    content_key_va: '0x001CC730',
    host_context_va: '0x001B6A80',
    operation: 'plain64 = ((carrier64 XOR lane_key64) - 57 - row_index) modulo 2^64',
    row_index: '0..31, one step per 0x40-byte row; resets every 0x800 bytes',
  });

  function asBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return Uint8Array.from(input || []);
  }

  function fromHex(value) {
    const text = String(value || '').replace(/\s+/g, '');
    if (!/^[0-9a-f]*$/i.test(text) || text.length % 2) throw new Error('invalid hexadecimal byte string');
    const out = new Uint8Array(text.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function hex(input) {
    let out = '';
    for (const value of asBytes(input)) out += value.toString(16).padStart(2, '0');
    return out;
  }

  const DEFAULT_CONTENT_KEY = fromHex(DEFAULT_CONTENT_KEY_HEX);

  function readU64LE(input, offset = 0) {
    const b = asBytes(input);
    let value = 0n;
    for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(b[offset + i] || 0);
    return value;
  }

  function writeU64LE(output, offset, value, length = 8) {
    value &= UINT64_MASK;
    for (let i = 0; i < length; i++) {
      output[offset + i] = Number(value & 0xffn);
      value >>= 8n;
    }
  }

  function deriveLaneKeys(contentKey = DEFAULT_CONTENT_KEY) {
    const key = asBytes(contentKey);
    if (key.length !== 16) throw new Error('content key must contain exactly 16 bytes');
    const halves = [readU64LE(key, 0), readU64LE(key, 8)];
    return LANE_CONSTANTS.map((constant, lane) => constant ^ halves[lane & 1]);
  }

  const DEFAULT_LANE_KEYS = Object.freeze(deriveLaneKeys());

  function transformBytes(input, options) {
    const source = asBytes(input), opts = options || {};
    const baseOffset = Number(opts.baseOffset || 0);
    if (!Number.isSafeInteger(baseOffset) || baseOffset < 0 || baseOffset % 8) throw new Error('baseOffset must be a nonnegative 8-byte-aligned safe integer');
    const laneKeys = opts.laneKeys || deriveLaneKeys(opts.contentKey || DEFAULT_CONTENT_KEY);
    if (laneKeys.length !== 8) throw new Error('exactly eight lane keys are required');
    const output = new Uint8Array(source.length);

    for (let offset = 0; offset < source.length; offset += 8) {
      const absolute = baseOffset + offset;
      const length = Math.min(8, source.length - offset);
      const lane = Math.floor((absolute % ROW_BYTES) / 8);
      const row = Math.floor(absolute / ROW_BYTES) & (ROW_PERIOD - 1);
      const adjustment = 57n + BigInt(row);
      let value = readU64LE(source, offset);
      if (opts.encode) value = ((value + adjustment) & UINT64_MASK) ^ laneKeys[lane];
      else value = ((value ^ laneKeys[lane]) - adjustment) & UINT64_MASK;
      writeU64LE(output, offset, value, length);
    }
    return output;
  }

  function decodeBytes(input, options) {
    return transformBytes(input, Object.assign({}, options || {}, { encode: false }));
  }

  function encodeBytes(input, options) {
    return transformBytes(input, Object.assign({}, options || {}, { encode: true }));
  }

  function findStartCode(input, streamId, limit) {
    const b = asBytes(input), end = Math.min(b.length - 3, limit == null ? b.length - 3 : limit);
    for (let i = 0; i <= end; i++) if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && b[i + 3] === streamId) return i;
    return -1;
  }

  function validateProgramStreamHead(input) {
    const b = asBytes(input), pack = findStartCode(b, 0xba, 0) === 0;
    const systemOffset = findStartCode(b, 0xbb, 0x100);
    const videoOffset = findStartCode(b, 0xe0, 0x400);
    const sequenceOffset = findStartCode(b, 0xb3, Math.min(0x4000, b.length));
    return Object.freeze({
      valid: pack && systemOffset >= 0 && videoOffset >= 0,
      pack_at_zero: pack,
      system_header_offset: systemOffset,
      video_pes_offset: videoOffset,
      sequence_header_offset: sequenceOffset,
      decoded_header_hex: hex(b.subarray(0, Math.min(64, b.length))),
    });
  }

  async function decodeProvider(provider, options) {
    const opts = options || {}, size = Number(provider?.size);
    if (!Number.isSafeInteger(size) || size < 0 || typeof provider.read !== 'function') throw new Error('provider must expose a safe integer size and async read(offset,length)');
    let chunkBytes = Math.max(FRAME_BYTES, Number(opts.chunkBytes || 0x400000));
    chunkBytes -= chunkBytes % FRAME_BYTES;
    const parts = [], completeFrames = Math.floor(size / FRAME_BYTES);
    let checkedFrames = 0, validFramePrefixes = 0, firstValidation = null;

    for (let offset = 0; offset < size; offset += chunkBytes) {
      if (opts.cancelled?.()) {
        const error = new Error('cancelled');
        error.code = 'CANCELLED';
        throw error;
      }
      const length = Math.min(chunkBytes, size - offset);
      const encoded = asBytes(await provider.read(offset, length));
      if (encoded.length !== length) throw new Error(`provider returned ${encoded.length} bytes for a ${length}-byte request`);
      const decoded = decodeBytes(encoded, { baseOffset: offset, contentKey: opts.contentKey || DEFAULT_CONTENT_KEY });
      if (!firstValidation) firstValidation = validateProgramStreamHead(decoded);
      for (let local = 0; local + 4 <= decoded.length && offset + local < completeFrames * FRAME_BYTES; local += FRAME_BYTES) {
        checkedFrames++;
        if (decoded[local] === 0 && decoded[local + 1] === 0 && decoded[local + 2] === 1 && decoded[local + 3] === 0xba) validFramePrefixes++;
      }
      parts.push(decoded);
      if (opts.progress) await opts.progress({ bytes: offset + length, size, checked_frames: checkedFrames, valid_frame_prefixes: validFramePrefixes });
    }

    const blob = typeof Blob === 'function' ? new Blob(parts, { type: 'video/mpeg' }) : null;
    return Object.freeze({
      blob,
      parts,
      size,
      validation: firstValidation || validateProgramStreamHead(new Uint8Array()),
      complete_frames: completeFrames,
      checked_frames: checkedFrames,
      valid_frame_prefixes: validFramePrefixes,
      frame_prefix_ratio: checkedFrames ? validFramePrefixes / checkedFrames : 0,
      provenance: PROVENANCE,
    });
  }

  return Object.freeze({
    VERSION, ROW_BYTES, ROW_PERIOD, FRAME_BYTES, DEFAULT_CONTENT_KEY_HEX,
    DEFAULT_CONTENT_KEY, LANE_CONSTANTS, DEFAULT_LANE_KEYS, PROVENANCE,
    asBytes, fromHex, hex, readU64LE, writeU64LE, deriveLaneKeys, transformBytes,
    decodeBytes, encodeBytes, findStartCode, validateProgramStreamHead, decodeProvider,
  });
});
