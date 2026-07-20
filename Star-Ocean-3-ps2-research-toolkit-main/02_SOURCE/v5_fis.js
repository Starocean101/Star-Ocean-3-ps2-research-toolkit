/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Browser port of the verified SO3 FIS V2 converter algorithms and GS address
 * tables supplied in SO3_FIS_FORMAT_PASS_V2/parser/so3_fis_tool_v2.py.
 * See 01_SOURCE/THIRD_PARTY_NOTICES.md.
 */
(function (root, factory) {
  const core = typeof module === 'object' && module.exports ? require('./v5_core.js') : root.SO3V5Core;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SO3V5Fis = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';
  if (!Core) throw new Error('SO3V5Core is required');

  const PSMCT32 = 0x00,
    PSMCT24 = 0x01,
    PSMT8 = 0x13,
    PSMT4 = 0x14;
  const PSM_NAMES = Object.freeze({ [PSMCT32]: 'PSMCT32', [PSMCT24]: 'PSMCT24', [PSMT8]: 'PSMT8', [PSMT4]: 'PSMT4' });

  const BLOCK32 = [
    [0, 1, 4, 5, 16, 17, 20, 21],
    [2, 3, 6, 7, 18, 19, 22, 23],
    [8, 9, 12, 13, 24, 25, 28, 29],
    [10, 11, 14, 15, 26, 27, 30, 31],
  ];
  const COL32 = [
    [0, 1, 4, 5, 8, 9, 12, 13],
    [2, 3, 6, 7, 10, 11, 14, 15],
    [16, 17, 20, 21, 24, 25, 28, 29],
    [18, 19, 22, 23, 26, 27, 30, 31],
    [32, 33, 36, 37, 40, 41, 44, 45],
    [34, 35, 38, 39, 42, 43, 46, 47],
    [48, 49, 52, 53, 56, 57, 60, 61],
    [50, 51, 54, 55, 58, 59, 62, 63],
  ];
  const BLOCK8 = BLOCK32;
  const COL8 = [
    [0, 4, 16, 20, 32, 36, 48, 52, 2, 6, 18, 22, 34, 38, 50, 54],
    [8, 12, 24, 28, 40, 44, 56, 60, 10, 14, 26, 30, 42, 46, 58, 62],
    [33, 37, 49, 53, 1, 5, 17, 21, 35, 39, 51, 55, 3, 7, 19, 23],
    [41, 45, 57, 61, 9, 13, 25, 29, 43, 47, 59, 63, 11, 15, 27, 31],
    [96, 100, 112, 116, 64, 68, 80, 84, 98, 102, 114, 118, 66, 70, 82, 86],
    [104, 108, 120, 124, 72, 76, 88, 92, 106, 110, 122, 126, 74, 78, 90, 94],
    [65, 69, 81, 85, 97, 101, 113, 117, 67, 71, 83, 87, 99, 103, 115, 119],
    [73, 77, 89, 93, 105, 109, 121, 125, 75, 79, 91, 95, 107, 111, 123, 127],
    [128, 132, 144, 148, 160, 164, 176, 180, 130, 134, 146, 150, 162, 166, 178, 182],
    [136, 140, 152, 156, 168, 172, 184, 188, 138, 142, 154, 158, 170, 174, 186, 190],
    [161, 165, 177, 181, 129, 133, 145, 149, 163, 167, 179, 183, 131, 135, 147, 151],
    [169, 173, 185, 189, 137, 141, 153, 157, 171, 175, 187, 191, 139, 143, 155, 159],
    [224, 228, 240, 244, 192, 196, 208, 212, 226, 230, 242, 246, 194, 198, 210, 214],
    [232, 236, 248, 252, 200, 204, 216, 220, 234, 238, 250, 254, 202, 206, 218, 222],
    [193, 197, 209, 213, 225, 229, 241, 245, 195, 199, 211, 215, 227, 231, 243, 247],
    [201, 205, 217, 221, 233, 237, 249, 253, 203, 207, 219, 223, 235, 239, 251, 255],
  ];
  const BLOCK4 = [
    [0, 2, 8, 10],
    [1, 3, 9, 11],
    [4, 6, 12, 14],
    [5, 7, 13, 15],
    [16, 18, 24, 26],
    [17, 19, 25, 27],
    [20, 22, 28, 30],
    [21, 23, 29, 31],
  ];
  const COL4 = [
    [
      0, 8, 32, 40, 64, 72, 96, 104, 2, 10, 34, 42, 66, 74, 98, 106, 4, 12, 36, 44, 68, 76, 100, 108, 6, 14, 38, 46, 70,
      78, 102, 110,
    ],
    [
      16, 24, 48, 56, 80, 88, 112, 120, 18, 26, 50, 58, 82, 90, 114, 122, 20, 28, 52, 60, 84, 92, 116, 124, 22, 30, 54,
      62, 86, 94, 118, 126,
    ],
    [
      65, 73, 97, 105, 1, 9, 33, 41, 67, 75, 99, 107, 3, 11, 35, 43, 69, 77, 101, 109, 5, 13, 37, 45, 71, 79, 103, 111,
      7, 15, 39, 47,
    ],
    [
      81, 89, 113, 121, 17, 25, 49, 57, 83, 91, 115, 123, 19, 27, 51, 59, 85, 93, 117, 125, 21, 29, 53, 61, 87, 95, 119,
      127, 23, 31, 55, 63,
    ],
    [
      192, 200, 224, 232, 128, 136, 160, 168, 194, 202, 226, 234, 130, 138, 162, 170, 196, 204, 228, 236, 132, 140, 164,
      172, 198, 206, 230, 238, 134, 142, 166, 174,
    ],
    [
      208, 216, 240, 248, 144, 152, 176, 184, 210, 218, 242, 250, 146, 154, 178, 186, 212, 220, 244, 252, 148, 156, 180,
      188, 214, 222, 246, 254, 150, 158, 182, 190,
    ],
    [
      129, 137, 161, 169, 193, 201, 225, 233, 131, 139, 163, 171, 195, 203, 227, 235, 133, 141, 165, 173, 197, 205, 229,
      237, 135, 143, 167, 175, 199, 207, 231, 239,
    ],
    [
      145, 153, 177, 185, 209, 217, 241, 249, 147, 155, 179, 187, 211, 219, 243, 251, 149, 157, 181, 189, 213, 221, 245,
      253, 151, 159, 183, 191, 215, 223, 247, 255,
    ],
    [
      256, 264, 288, 296, 320, 328, 352, 360, 258, 266, 290, 298, 322, 330, 354, 362, 260, 268, 292, 300, 324, 332, 356,
      364, 262, 270, 294, 302, 326, 334, 358, 366,
    ],
    [
      272, 280, 304, 312, 336, 344, 368, 376, 274, 282, 306, 314, 338, 346, 370, 378, 276, 284, 308, 316, 340, 348, 372,
      380, 278, 286, 310, 318, 342, 350, 374, 382,
    ],
    [
      321, 329, 353, 361, 257, 265, 289, 297, 323, 331, 355, 363, 259, 267, 291, 299, 325, 333, 357, 365, 261, 269, 293,
      301, 327, 335, 359, 367, 263, 271, 295, 303,
    ],
    [
      337, 345, 369, 377, 273, 281, 305, 313, 339, 347, 371, 379, 275, 283, 307, 315, 341, 349, 373, 381, 277, 285, 309,
      317, 343, 351, 375, 383, 279, 287, 311, 319,
    ],
    [
      448, 456, 480, 488, 384, 392, 416, 424, 450, 458, 482, 490, 386, 394, 418, 426, 452, 460, 484, 492, 388, 396, 420,
      428, 454, 462, 486, 494, 390, 398, 422, 430,
    ],
    [
      464, 472, 496, 504, 400, 408, 432, 440, 466, 474, 498, 506, 402, 410, 434, 442, 468, 476, 500, 508, 404, 412, 436,
      444, 470, 478, 502, 510, 406, 414, 438, 446,
    ],
    [
      385, 393, 417, 425, 449, 457, 481, 489, 387, 395, 419, 427, 451, 459, 483, 491, 389, 397, 421, 429, 453, 461, 485,
      493, 391, 399, 423, 431, 455, 463, 487, 495,
    ],
    [
      401, 409, 433, 441, 465, 473, 497, 505, 403, 411, 435, 443, 467, 475, 499, 507, 405, 413, 437, 445, 469, 477, 501,
      509, 407, 415, 439, 447, 471, 479, 503, 511,
    ],
  ];

  function alphaPs2(a) {
    return Math.min(255, a * 2);
  }
  function layout(psm) {
    if (psm === PSMCT32 || psm === PSMCT24) return [64, 32, 8, 8, BLOCK32, COL32];
    if (psm === PSMT8) return [128, 64, 16, 16, BLOCK8, COL8];
    if (psm === PSMT4) return [128, 128, 32, 16, BLOCK4, COL4];
    throw new Error(`Unsupported PSM ${Core.hex(psm, 2)}`);
  }

  function gsAddressUnits(x, y, bufferWidth, psm) {
    const [pageW, pageH, blockW, blockH, blockTable, columnTable] = layout(psm);
    const pagesPerRow = Math.max(1, Math.ceil(bufferWidth / pageW));
    const page = Math.floor(y / pageH) * pagesPerRow + Math.floor(x / pageW);
    const sx = x % pageW,
      sy = y % pageH;
    const block = blockTable[Math.floor(sy / blockH)][Math.floor(sx / blockW)];
    const sub = columnTable[sy % blockH][sx % blockW];
    return page * pageW * pageH + block * blockW * blockH + sub;
  }

  function writeVram(vram, psm, bw, x, y, value) {
    const a = gsAddressUnits(x, y, bw, psm);
    if (psm === PSMCT32) vram.set(value, a * 4);
    else if (psm === PSMCT24) vram.set(value, a * 4);
    else if (psm === PSMT8) vram[a] = value;
    else if (psm === PSMT4) {
      const bi = a >>> 1,
        shift = (a & 1) * 4;
      vram[bi] = (vram[bi] & ~(0xf << shift)) | ((value & 0xf) << shift);
    } else throw new Error(`Unsupported write PSM ${psm}`);
  }

  function readVram(vram, psm, bw, x, y) {
    const a = gsAddressUnits(x, y, bw, psm);
    if (psm === PSMCT32) return [vram[a * 4], vram[a * 4 + 1], vram[a * 4 + 2], vram[a * 4 + 3]];
    if (psm === PSMCT24) return [vram[a * 4], vram[a * 4 + 1], vram[a * 4 + 2]];
    if (psm === PSMT8) return vram[a];
    if (psm === PSMT4) return (vram[a >>> 1] >>> ((a & 1) * 4)) & 0xf;
    throw new Error(`Unsupported read PSM ${psm}`);
  }

  function parseFis(input, options) {
    const data = Core.asBytes(input),
      opts = Object.assign({ allowTrailing: true }, options || {});
    if (data.length < 0x100 || Core.ascii(data, 0, 4) !== 'FIS\0') throw new Error('Not FIS');
    const storedAfterPrefix = Core.u32(data, 4),
      nominalSize = storedAfterPrefix + 0x10;
    if (nominalSize > data.length) throw new Error('Truncated FIS');
    if (!opts.allowTrailing && nominalSize !== data.length) throw new Error('Trailing bytes after FIS');
    const core = data.subarray(0, nominalSize),
      flags = Core.u32(core, 0x10),
      paletteEntries = flags >>> 16,
      low = flags & 0xffff;
    const assetLabel = Core.cstring(core, 0x14, 4),
      textureId = Core.u32(core, 0x18),
      descriptor = Core.u32(core, 0x1c) + 0x10;
    if (descriptor + 0x20 > core.length) throw new Error('Texture descriptor outside FIS');
    const uploadWidth = Core.u16(core, descriptor),
      uploadHeight = Core.u16(core, descriptor + 2),
      payloadSize = Core.u32(core, descriptor + 4);
    const control = Core.u32(core, descriptor + 8),
      actualPsm = Core.u8(core, descriptor + 0x0c),
      reserved0d = Core.u8(core, descriptor + 0x0d);
    const allocationWidth = 1 << Core.u8(core, descriptor + 0x0e),
      allocationHeight = 1 << Core.u8(core, descriptor + 0x0f),
      descriptorTail = Core.u32(core, descriptor + 0x10);
    if (control + 0x90 > core.length) throw new Error('Transfer control outside FIS');
    const bitblt = Core.u64(core, control + 0x30),
      trxpos = Core.u64(core, control + 0x40),
      trxreg = Core.u64(core, control + 0x50),
      trxdir = Core.u64(core, control + 0x60);
    const dbp = Number((bitblt >> 32n) & 0x3fffn),
      dbw = Number((bitblt >> 48n) & 0x3fn) * 64,
      transferPsm = Number((bitblt >> 56n) & 0x3fn);
    const dsax = Number((trxpos >> 32n) & 0x7ffn),
      dsay = Number((trxpos >> 48n) & 0x7ffn);
    const trxWidth = Number(trxreg & 0xfffn),
      trxHeight = Number((trxreg >> 32n) & 0xfffn),
      payloadOffset = control + 0x90;
    if (payloadOffset + payloadSize > core.length) throw new Error('Pixel payload outside FIS');
    const palettePayloadSize = Core.u32(core, 0x20),
      paletteControl = palettePayloadSize ? Core.u32(core, 0x24) : 0,
      paletteOffset = palettePayloadSize ? paletteControl + 0x90 : 0;
    if (palettePayloadSize && paletteOffset + palettePayloadSize > core.length)
      throw new Error('Palette payload outside FIS');
    const paletteBitblt = palettePayloadSize ? Core.u64(core, paletteControl + 0x30) : 0n,
      paletteTrxpos = palettePayloadSize ? Core.u64(core, paletteControl + 0x40) : 0n,
      paletteTrxreg = palettePayloadSize ? Core.u64(core, paletteControl + 0x50) : 0n,
      paletteTrxdir = palettePayloadSize ? Core.u64(core, paletteControl + 0x60) : 0n,
      paletteTransferPsm = Number((paletteBitblt >> 56n) & 0x3fn),
      paletteUploadWidth = Number(paletteTrxreg & 0xfffn),
      paletteUploadHeight = Number((paletteTrxreg >> 32n) & 0xfffn),
      paletteDestinationX = Number((paletteTrxpos >> 32n) & 0x7ffn),
      paletteDestinationY = Number((paletteTrxpos >> 48n) & 0x7ffn);
    const psmT4Csm1Layout = actualPsm === PSMT4 && palettePayloadSize && paletteTransferPsm === PSMCT32 &&
      paletteUploadWidth >= 8 && paletteUploadHeight >= 2 && paletteDestinationX === 0 && paletteDestinationY === 0;
    return {
      file_size: data.length,
      nominal_fis_size: nominalSize,
      trailing_size: data.length - nominalSize,
      stored_after_prefix: storedAfterPrefix,
      aux_size_or_zero: Core.u32(core, 0x0c),
      flags_raw: flags,
      flags_low16: low,
      format_code: low & 3,
      indexed_flag: !!(low & 0x8000),
      repacked_upload_flag: !!(low & 0x2000),
      base_flag_0x1000: !!(low & 0x1000),
      palette_entries: paletteEntries,
      logical_palette_entries: actualPsm === PSMT4 && psmT4Csm1Layout ? 16 : paletteEntries,
      palette_bank_count: actualPsm === PSMT4 && psmT4Csm1Layout ? 1 : paletteEntries ? 1 : 0,
      palette_storage_layout: psmT4Csm1Layout ? 'CSM1_IDTEX4_8X2_FROM_PSMCT32_UPLOAD' : null,
      asset_label: assetLabel,
      texture_id: textureId,
      texture_descriptor_offset: descriptor,
      upload_width: uploadWidth,
      upload_height: uploadHeight,
      payload_size: payloadSize,
      transfer_control_offset: control,
      actual_psm: actualPsm,
      actual_psm_name: PSM_NAMES[actualPsm] || `UNKNOWN_${Core.hex(actualPsm, 2)}`,
      descriptor_reserved_0D: reserved0d,
      allocation_width: allocationWidth,
      allocation_height: allocationHeight,
      descriptor_tail: descriptorTail,
      transfer_psm: transferPsm,
      transfer_psm_name: PSM_NAMES[transferPsm] || `UNKNOWN_${Core.hex(transferPsm, 2)}`,
      destination_base_pointer: dbp,
      destination_buffer_width: dbw,
      destination_x: dsax,
      destination_y: dsay,
      trx_width: trxWidth,
      trx_height: trxHeight,
      trx_direction: Number(trxdir & 3n),
      palette_payload_size: palettePayloadSize,
      palette_control_offset: paletteControl,
      palette_offset: paletteOffset,
      palette_transfer_psm: paletteTransferPsm,
      palette_transfer_psm_name: PSM_NAMES[paletteTransferPsm] || `UNKNOWN_${Core.hex(paletteTransferPsm, 2)}`,
      palette_upload_width: paletteUploadWidth,
      palette_upload_height: paletteUploadHeight,
      palette_destination_x: paletteDestinationX,
      palette_destination_y: paletteDestinationY,
      palette_trx_direction: Number(paletteTrxdir & 3n),
      payload_offset: payloadOffset,
      core,
      palette: core.subarray(paletteOffset, paletteOffset + palettePayloadSize),
      payload: core.subarray(payloadOffset, payloadOffset + payloadSize),
    };
  }

  function hostPixels(payload, psm, count) {
    const out = new Array(count);
    if (psm === PSMCT32) for (let i = 0; i < count; i++) out[i] = payload.subarray(i * 4, i * 4 + 4);
    else if (psm === PSMCT24) for (let i = 0; i < count; i++) out[i] = payload.subarray(i * 3, i * 3 + 3);
    else if (psm === PSMT8) for (let i = 0; i < count; i++) out[i] = payload[i];
    else if (psm === PSMT4) for (let i = 0; i < count; i++) out[i] = (payload[i >>> 1] >>> ((i & 1) * 4)) & 0xf;
    else throw new Error(`Unsupported transfer PSM ${Core.hex(psm, 2)}`);
    return out;
  }

  function logicalPalette(info, bank) {
    bank = bank || 0;
    const raw = info.palette,
      colors = [];
    for (let i = 0; i + 3 < raw.length; i += 4) colors.push([raw[i], raw[i + 1], raw[i + 2], alphaPs2(raw[i + 3])]);
    if (info.actual_psm === PSMT4) {
      if (bank !== 0) throw new Error(`Palette bank ${bank} missing; observed PSMT4 FIS stores one CSM1 8x2 CLUT`);
      if (info.palette_storage_layout !== 'CSM1_IDTEX4_8X2_FROM_PSMCT32_UPLOAD')
        throw new Error('Unsupported PSMT4 CLUT storage layout');
      const width = info.palette_upload_width, palette = [];
      for (let index = 0; index < 16; index++) {
        const sourceIndex = (index & 7) + (index >>> 3) * width;
        if (!colors[sourceIndex]) throw new Error(`PSMT4 CSM1 palette entry ${index} missing at upload index ${sourceIndex}`);
        palette.push(colors[sourceIndex]);
      }
      return palette;
    }
    if (info.actual_psm === PSMT8) {
      if (colors.length < 256) throw new Error('Short PSMT8 palette');
      const out = [];
      for (let i = 0; i < 256; i++) {
        const m = i & 0x18,
          j = m === 0x08 ? i + 8 : m === 0x10 ? i - 8 : i;
        out.push(colors[j]);
      }
      return out;
    }
    return [];
  }

  function decodeFis(input, options) {
    const opts = Object.assign({ paletteBank: 0 }, options || {}),
      info = input && input.payload ? input : parseFis(input),
      apsm = info.actual_psm,
      tpsm = info.transfer_psm;
    const uw = info.upload_width,
      uh = info.upload_height,
      dbw = info.destination_buffer_width || uw,
      dx = info.destination_x,
      dy = info.destination_y,
      count = uw * uh;
    const expected =
      tpsm === PSMCT32
        ? count * 4
        : tpsm === PSMCT24
          ? count * 3
          : tpsm === PSMT8
            ? count
            : tpsm === PSMT4
              ? Math.ceil(count / 2)
              : null;
    if (expected == null) throw new Error(`Unsupported transfer PSM ${Core.hex(tpsm, 2)}`);
    if (info.payload.length < expected) throw new Error(`Short payload: need ${expected}, have ${info.payload.length}`);
    const vram = new Uint8Array(4 * 1024 * 1024),
      source = hostPixels(info.payload, tpsm, count);
    for (let n = 0; n < count; n++) writeVram(vram, tpsm, dbw, dx + (n % uw), dy + Math.floor(n / uw), source[n]);
    const width = tpsm !== apsm ? info.allocation_width : uw,
      height = tpsm !== apsm ? info.allocation_height : uh,
      rgba = new Uint8ClampedArray(width * height * 4),
      indices = apsm === PSMT8 || apsm === PSMT4 ? new Uint8Array(width * height) : null;
    if (apsm === PSMCT32 || apsm === PSMCT24) {
      for (let y = 0, n = 0; y < height; y++)
        for (let x = 0; x < width; x++, n++) {
          const c = readVram(vram, apsm, info.allocation_width, x, y),
            p = n * 4;
          rgba[p] = c[0];
          rgba[p + 1] = c[1];
          rgba[p + 2] = c[2];
          rgba[p + 3] = apsm === PSMCT24 ? 255 : alphaPs2(c[3]);
        }
    } else {
      const palette = logicalPalette(info, opts.paletteBank);
      for (let y = 0, n = 0; y < height; y++)
        for (let x = 0; x < width; x++, n++) {
          const index = readVram(vram, apsm, info.allocation_width, x, y),
            c = palette[index] || [255, 0, 255, 255],
            p = n * 4;
          indices[n] = index;
          rgba[p] = c[0];
          rgba[p + 1] = c[1];
          rgba[p + 2] = c[2];
          rgba[p + 3] = c[3];
        }
    }
    return { width, height, rgba, indices, info, palette_bank: opts.paletteBank };
  }

  function channelView(decoded, channel) {
    if (!channel || channel === 'rgba') return decoded.rgba;
    const map = { r: 0, g: 1, b: 2, a: 3 },
      c = map[channel],
      out = new Uint8ClampedArray(decoded.rgba.length);
    if (c == null) throw new Error(`Unknown channel ${channel}`);
    for (let i = 0; i < decoded.rgba.length; i += 4) {
      const v = decoded.rgba[i + c];
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = 255;
    }
    return out;
  }

  return Object.freeze({
    PSMCT32,
    PSMCT24,
    PSMT8,
    PSMT4,
    PSM_NAMES,
    alphaPs2,
    gsAddressUnits,
    parseFis,
    logicalPalette,
    decodeFis,
    channelView,
  });
});
