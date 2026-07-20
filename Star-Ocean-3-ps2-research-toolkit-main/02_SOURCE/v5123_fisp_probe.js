/* SO3 V5.12.4 corrected generic FISP context scanner.
 * Pure byte parser shared by browser extraction and Node regression tests.
 * FISP is not promoted as a facial resource. Header +0x04 is the stored
 * payload size; +0x0C is a chain/alignment stride and must not be used as the
 * content length.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SO3V5124FispProbe = api; root.SO3V5123FispProbe = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function asBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return Uint8Array.from(input || []);
  }

  function u32(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
  }

  function headHex(bytes, offset, size) {
    return Array.from(bytes.subarray(offset, offset + size), (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  function scanSections(input, options) {
    const bytes = asBytes(input), opts = Object.assign({ alignment: 4, maxBytes: bytes.length, maxSectionBytes: 4 << 20, maxMatches: 128 }, options || {});
    if (![1, 2, 4, 8, 16].includes(opts.alignment)) throw new Error('alignment must be 1, 2, 4, 8, or 16');
    const limit = Math.min(bytes.length, Math.max(0, Number(opts.maxBytes))), sections = [];
    for (let off = 0; off + 0x18 <= limit && sections.length < opts.maxMatches; off += opts.alignment) {
      if (bytes[off] !== 0x46 || bytes[off + 1] !== 0x49 || bytes[off + 2] !== 0x53 || bytes[off + 3] !== 0x50) continue;
      const storedAfterPrefix = u32(bytes, off + 4), contentSize = storedAfterPrefix + 0x10,
        chainStride = u32(bytes, off + 0x0c), count = u32(bytes, off + 0x10), tableEnd = 0x14 + count * 4;
      if (count < 1 || count > 256 || contentSize < tableEnd || contentSize > opts.maxSectionBytes || off + contentSize > limit) continue;
      if (chainStride && chainStride < contentSize) continue;
      const profiles = []; let valid = true, last = -1;
      for (let index = 0; index < count; index++) {
        const offsetFromPayload = u32(bytes, off + 0x14 + index * 4), offsetFromSection = 0x10 + offsetFromPayload;
        if (offsetFromPayload < tableEnd - 0x10 || offsetFromSection < 0x14 || offsetFromSection + 3 > contentSize || offsetFromSection < last) { valid = false; break; }
        const nextPayload = index + 1 < count ? u32(bytes, off + 0x18 + index * 4) : contentSize - 0x10;
        const recordSize = nextPayload >= offsetFromPayload ? nextPayload - offsetFromPayload : 0;
        if (nextPayload > contentSize - 0x10 || recordSize < 3) { valid = false; break; }
        last = offsetFromSection;
        const recordByte2 = bytes[off + offsetFromSection + 2];
        profiles.push({ index, offset_from_section: offsetFromSection, offset_from_payload: offsetFromPayload, record_size: recordSize, record_byte_2: recordByte2, csa_byte_2: recordByte2, tex0_csa_low5: recordByte2 & 0x1f, tex0_cld_high3: recordByte2 >>> 5, head_16_hex: headHex(bytes, off + offsetFromSection, Math.min(16, recordSize)) });
      }
      if (!valid) continue;
      sections.push({
        offset: off,
        section_size: contentSize,
        content_size: contentSize,
        stored_after_prefix: storedAfterPrefix,
        chain_stride: chainStride,
        bytes_after_content_in_stride: chainStride >= contentSize ? chainStride - contentSize : null,
        profile_count: count,
        profiles,
      });
    }
    return {
      format: 'SO3_FISP_SECTION_SCAN',
      scanned_range: [0, limit],
      source_size: bytes.length,
      scan_complete: limit === bytes.length,
      sections,
      boundaries: limit === bytes.length ? [] : [`source coverage is [0, ${limit}) of ${bytes.length} bytes`]
    };
  }

  return Object.freeze({ VERSION: '5.12.4', scanSections });
});
