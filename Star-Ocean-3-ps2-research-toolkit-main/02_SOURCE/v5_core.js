/*
 * SO3 Resource Explorer V5 core
 * Pure, dependency-free parsers and research data models.
 * Evidence sources are listed in 03_DOCS/FORMAT_ADAPTERS.md.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SO3V5Core = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '5.0.0-pass1';
  const PROJECT_FORMAT = 'SO3_RESOURCE_EXPLORER_PROJECT';
  const PROJECT_SCHEMA_VERSION = 1;
  const ATLAS_FORMAT = 'SO3_CANONICAL_ATLAS';
  const ATLAS_SCHEMA_VERSION = 1;
  const SECTOR_SIZE = 0x800;

  const TAG_U32 = Object.freeze({
    0x43484152: 'CHAR',
    0x41545243: 'ATRC',
    0x414e494d: 'ANIM',
    0x004d4150: 'MAP',
    0x4154524d: 'ATRM',
    0x4d415041: 'MAPA',
    0x4d4d4150: 'MMAP',
    0x004d5345: 'MSE',
    0x00534345: 'SCE',
    0x534d4344: 'SMCD',
    0x4954454d: 'ITEM',
    0x00505247: 'PRG',
    0x00535953: 'SYS',
    0x50534946: 'FISP?',
    0x004d4141: 'MAA?',
  });

  const TAG_INNER_FORMATS = Object.freeze({
    CHAR: ['FPS', 'XBDC'],
    ATRC: ['RTA'],
    ANIM: ['FAS'],
    MAP: ['FPS', 'RMAC'],
    ATRM: ['RTA'],
    MAPA: ['FAS'],
    MMAP: ['DMM'],
    MSE: ['SEQW'],
    SCE: ['script'],
    SMCD: ['so3mclib_data'],
    ITEM: ['record_table'],
    PRG: [],
    SYS: [],
    'FISP?': [],
    'MAA?': [],
  });

  const ENGINE_XREFS = Object.freeze({
    bundle: [
      {
        name: 'ReadPackingData constructor',
        address: '0x00204300',
        tier: 'VERIFIED',
        provenance: 'PACK_MODEL_PASS/CONTAINER_DISPATCH_MAP.md',
      },
      {
        name: 'Semantic-child factory',
        address: '0x00204870',
        tier: 'VERIFIED',
        provenance: 'PACK_MODEL_PASS/CONTAINER_DISPATCH_MAP.md',
      },
      {
        name: 'Semantic-tag dispatcher',
        address: '0x00250680',
        tier: 'VERIFIED',
        provenance: 'PACK_MODEL_PASS/CONTAINER_DISPATCH_MAP.md',
      },
    ],
    tags: {
      CHAR: { handler: '0x002510E0', tier: 'VERIFIED' },
      ATRC: { handler: '0x002510E0', tier: 'VERIFIED' },
      ANIM: { handler: '0x00251000', tier: 'VERIFIED' },
      MAP: { handler: '0x00250D48', tier: 'VERIFIED' },
      ATRM: { handler: '0x00250DE8', tier: 'VERIFIED' },
      MAPA: { handler: '0x00250E88', tier: 'VERIFIED' },
      MMAP: { handler: '0x00250FB8', tier: 'VERIFIED' },
      MSE: { handler: '0x00251238', tier: 'VERIFIED' },
      SCE: { handler: '0x00251288', tier: 'VERIFIED' },
      PRG: { handler: '0x00251328', tier: 'VERIFIED_HANDLER_NO_SAMPLE' },
      ITEM: { handler: '0x002513A8', tier: 'VERIFIED' },
      SYS: { handler: '0x002513A8', tier: 'VERIFIED_HANDLER_NO_SAMPLE' },
      'FISP?': { handler: '0x002511B8', tier: 'UNKNOWN_EXACT_TAG' },
      'MAA?': { handler: '0x00250F28', tier: 'UNKNOWN_EXACT_TAG' },
      SMCD: { handler: 'factory 0x00204870', tier: 'VERIFIED_FACTORY_PATH' },
    },
    formats: {
      FPS: [
        { name: 'Battle BasePolygon', address: '0x00278AC0', tier: 'VERIFIED_LINK' },
        { name: 'VIF1 normal DMA leaf A', address: '0x0041ADE0', tier: 'VERIFIED_LOW_LEVEL' },
        { name: 'VIF1 normal DMA leaf B', address: '0x0041D1C0', tier: 'VERIFIED_LOW_LEVEL' },
        { name: 'VIF1 normal DMA leaf C', address: '0x0041F2B0', tier: 'VERIFIED_LOW_LEVEL' },
      ],
      XBDC: [{ name: 'Battle ChrElement', address: '0x002A3440', tier: 'STRONG_INFERENCE' }],
      RMAC: [{ name: 'Field map renderer / BasePolygon path', address: null, tier: 'STRONG_INFERENCE' }],
      RTA: [
        { name: 'AnimationKernel', address: '0x002B48E0', tier: 'VERIFIED' },
        { name: 'MapAtrManager', address: '0x00218310', tier: 'VERIFIED' },
      ],
      FAS: [{ name: 'AnimationKernel', address: '0x002B48E0', tier: 'VERIFIED_ROTATION_EXECUTION_PARTIAL_INTEGRATION' }],
      FIS: [{ name: 'Lib image consumer', address: '0x00454E00', tier: 'VERIFIED' }],
      DMM: [{ name: 'MMAP handler', address: '0x00250FB8', tier: 'VERIFIED' }],
      SEQW: [{ name: 'MSE handler', address: '0x00251238', tier: 'VERIFIED' }],
    },
    packetTrace: {
      staticSampleFact:
        'The supplied static FPS streams contain zero MPG, MSCAL/MSCALF/MSCNT, DIRECT/DIRECTHL, and GIF packets.',
      tier: 'VERIFIED_ABSENT_FROM_SUPPLIED_VIF_STREAMS',
      provenance: 'VIF_GIF_PASS_V1/VALIDATION_REPORT.md',
    },
  });

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (Array.isArray(value)) return Uint8Array.from(value);
    throw new TypeError('Expected Uint8Array, ArrayBuffer, typed array, or byte array');
  }

  function bounds(bytes, offset, width, label) {
    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(width) ||
      offset < 0 ||
      width < 0 ||
      offset + width > bytes.length
    ) {
      throw new RangeError(`${label || 'read'} outside data: offset=${offset}, width=${width}, length=${bytes.length}`);
    }
  }

  function dv(bytes) {
    bytes = asBytes(bytes);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  function u8(bytes, o) {
    bounds(bytes, o, 1, 'u8');
    return bytes[o];
  }
  function i8(bytes, o) {
    const v = u8(bytes, o);
    return v > 127 ? v - 256 : v;
  }
  function u16(bytes, o) {
    bounds(bytes, o, 2, 'u16');
    return dv(bytes).getUint16(o, true);
  }
  function i16(bytes, o) {
    bounds(bytes, o, 2, 'i16');
    return dv(bytes).getInt16(o, true);
  }
  function u32(bytes, o) {
    bounds(bytes, o, 4, 'u32');
    return dv(bytes).getUint32(o, true);
  }
  function i32(bytes, o) {
    bounds(bytes, o, 4, 'i32');
    return dv(bytes).getInt32(o, true);
  }
  function f32(bytes, o) {
    bounds(bytes, o, 4, 'f32');
    return dv(bytes).getFloat32(o, true);
  }
  function u64(bytes, o) {
    bounds(bytes, o, 8, 'u64');
    const v = dv(bytes);
    return v.getBigUint64
      ? v.getBigUint64(o, true)
      : BigInt(v.getUint32(o, true)) | (BigInt(v.getUint32(o + 4, true)) << 32n);
  }

  function hex(value, width) {
    const numberValue = Math.trunc(Number(value));
    let v = typeof value === 'bigint' ? value : BigInt(Number.isFinite(numberValue) ? numberValue : 0);
    let s = v.toString(16).toUpperCase();
    if (width) s = s.padStart(width, '0');
    return `0x${s}`;
  }

  function ascii(bytes, start, length) {
    bytes = asBytes(bytes);
    bounds(bytes, start, length, 'ASCII');
    let out = '';
    for (let i = start; i < start + length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  function cstring(bytes, start, maxLength) {
    bytes = asBytes(bytes);
    const end = Math.min(bytes.length, start + maxLength);
    let out = '';
    for (let i = start; i < end && bytes[i]; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  function splitResourceId(value) {
    value = Number(value) >>> 0;
    return { raw: value, actor_id: value & 0xffff, animation_slot: value >>> 16 };
  }

  function logicalTag(value) {
    value = Number(value) >>> 0;
    return TAG_U32[value] || `UNKNOWN_${hex(value, 8)}`;
  }

  function classifyBytes(input) {
    const b = asBytes(input);
    if (b.length >= 4) {
      const s4 = ascii(b, 0, 4);
      if (s4 === 'PACK') return 'PACK';
      if (s4 === 'MWo3') return 'MWo3';
      if (s4 === 'XBDC') return 'XBDC';
      if (s4 === 'RMAC') return 'RMAC';
      if (s4 === 'SEQW') return 'SEQW';
      if (s4 === 'FIS\0' || s4.startsWith('FIS')) return 'FIS';
      if (s4 === 'FPS\0' || s4.startsWith('FPS')) return 'FPS';
      if (s4 === 'RTA\0' || s4.startsWith('RTA')) return 'RTA';
      if (s4 === 'FAS\0' || s4.startsWith('FAS')) return 'FAS';
      if (s4 === 'DMM\0' || s4.startsWith('DMM')) return 'DMM';
      if (s4.slice(0, 3) === 'SLZ') return `SLZ${b[3]}`;
      if (s4.slice(0, 3) === 'SLE') return `SLE${b[3]}`;
      if (s4.slice(0, 3) === 'ZLS') return 'ZLS';
      if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return 'ELF';
    }
    if (isSemanticBundle(b, 0)) return 'SEMANTIC_BUNDLE';
    return 'UNKNOWN';
  }

  function identifyContainer(input) {
    const b = asBytes(input);
    if (b.length >= 4 && ascii(b, 0, 4) === 'PACK') return 'PACK';
    if (isSemanticBundle(b, 0)) return 'SEMANTIC_BUNDLE';
    return 'UNKNOWN';
  }

  function parsePack(input, base = 0, limit) {
    const b = asBytes(input);
    limit = limit == null ? b.length : Math.min(Number(limit), b.length);
    bounds(b, base, 8, 'PACK header');
    if (ascii(b, base, 4) !== 'PACK') throw new Error('Not a PACK archive');
    const version = u16(b, base + 4),
      count = u16(b, base + 6);
    if (count > 4096) throw new Error(`PACK descriptor count ${count} exceeds 4096`);
    const headerSize = 8 + count * 8;
    if (base + headerSize > limit) throw new Error('PACK descriptor table is truncated');
    const descriptors = [];
    for (let i = 0; i < count; i++) {
      const p = base + 8 + i * 8;
      descriptors.push({ index: i, child_offset: u32(b, p), tag_or_id: u32(b, p + 4), descriptor_offset: p - base });
    }
    const offsets = descriptors.map((x) => x.child_offset);
    const local = offsets.every(
      (off, i) => off >= headerSize && base + off < limit && (i === 0 || off >= offsets[i - 1]),
    );
    const children = [];
    if (local) {
      for (let i = 0; i < descriptors.length; i++) {
        const d = descriptors[i];
        const end = i + 1 < descriptors.length ? descriptors[i + 1].child_offset : limit - base;
        if (end < d.child_offset) throw new Error(`PACK child ${i} has a negative extent`);
        const size = end - d.child_offset,
          absoluteOffset = base + d.child_offset;
        children.push({
          index: i,
          offset: d.child_offset,
          absolute_offset: absoluteOffset,
          stored_size: size,
          tag_or_id: d.tag_or_id,
          signature: classifyBytes(b.subarray(absoluteOffset, Math.min(limit, absoluteOffset + 32))),
        });
      }
    }
    return { kind: 'PACK', version, count, header_size: headerSize, local, descriptors, children };
  }

  function isSemanticBundle(input, base = 0) {
    const b = asBytes(input);
    if (base < 0 || base + 16 > b.length) return false;
    const reserved0 = u32(b, base),
      count = u32(b, base + 4),
      headerSize = u32(b, base + 8),
      reserved3 = u32(b, base + 12);
    if (
      reserved0 !== 0 ||
      reserved3 !== 0 ||
      count < 1 ||
      count > 4096 ||
      headerSize !== 0x10 * (count + 1) ||
      base + headerSize > b.length
    )
      return false;
    let previous = -1;
    for (let i = 0; i < count; i++) {
      const p = base + 0x10 + i * 0x10;
      const size = u32(b, p + 8),
        offset = u32(b, p + 12);
      if (offset < headerSize || offset < previous || base + offset + size > b.length) return false;
      previous = offset;
    }
    return true;
  }

  function parseSemanticBundle(input, base = 0) {
    const b = asBytes(input);
    if (!isSemanticBundle(b, base)) throw new Error(`Not a valid semantic bundle at ${hex(base)}`);
    const count = u32(b, base + 4),
      headerSize = u32(b, base + 8),
      children = [];
    for (let i = 0; i < count; i++) {
      const p = base + 0x10 + i * 0x10;
      const tagU32 = u32(b, p),
        resId = u32(b, p + 4),
        size = u32(b, p + 8),
        offset = u32(b, p + 12);
      const ids = splitResourceId(resId),
        absoluteOffset = base + offset;
      children.push({
        index: i,
        descriptor_offset: p - base,
        tag_u32: tagU32,
        tag: logicalTag(tagU32),
        res_id: resId,
        actor_id: ids.actor_id,
        animation_slot: ids.animation_slot,
        stored_size: size,
        offset,
        absolute_offset: absoluteOffset,
        signature: classifyBytes(b.subarray(absoluteOffset, Math.min(b.length, absoluteOffset + 32))),
      });
    }
    const end = children.reduce((m, x) => Math.max(m, x.offset + x.stored_size), headerSize);
    return { kind: 'SEMANTIC_BUNDLE', base, count, header_size: headerSize, reserved: [0, 0], end, children };
  }

  function scanSemanticBundles(input, sectorSize = SECTOR_SIZE) {
    const b = asBytes(input),
      found = [],
      seen = new Set();
    const tryAt = (base) => {
      if (!seen.has(base) && isSemanticBundle(b, base)) {
        found.push(parseSemanticBundle(b, base));
        seen.add(base);
      }
    };
    tryAt(0);
    for (let base = sectorSize; base + 16 <= b.length; base += sectorSize) tryAt(base);
    return found.sort((a, z) => a.base - z.base);
  }

  function parseMwo3(input) {
    const b = asBytes(input);
    bounds(b, 0, 0x20, 'MWo3 header');
    if (ascii(b, 0, 4) !== 'MWo3') throw new Error('Not MWo3');
    const loadBase = u32(b, 0x08),
      region0 = u32(b, 0x0c),
      region1 = u32(b, 0x10),
      zeroFill = u32(b, 0x14);
    return {
      magic: 'MWo3',
      class_value: u32(b, 0x04),
      load_base: loadBase,
      region0_size: region0,
      region1_size: region1,
      zero_fill_size: zeroFill,
      init_array_start: u32(b, 0x18),
      init_array_end: u32(b, 0x1c),
      mapped_file_end: (loadBase + b.length) >>> 0,
      allocation_end: (loadBase + b.length + zeroFill) >>> 0,
      file_size_formula: 0x40 + region0 + region1,
      file_size_formula_matches: b.length === 0x40 + region0 + region1,
      embedded_name: b.length > 0x20 ? cstring(b, 0x20, Math.min(0x60, b.length - 0x20)) : '',
      file_size: b.length,
    };
  }

  function parseFps(input, base = 0) {
    const b = asBytes(input);
    bounds(b, base, 0x60, 'FPS header');
    if (ascii(b, base, 4) !== 'FPS\0') throw new Error('Not FPS');
    const a = [];
    for (let i = 0; i < 9; i++) a.push(f32(b, base + 0x20 + i * 4));
    return {
      magic: 'FPS',
      base,
      off_a: u32(b, base + 0x04),
      off_c: u32(b, base + 0x0c),
      header_size: u32(b, base + 0x10),
      sec14: u32(b, base + 0x14),
      sec18: u32(b, base + 0x18),
      bound_radius: f32(b, base + 0x1c),
      aabb: { a: a.slice(0, 3), min: a.slice(3, 6), max: a.slice(6, 9) },
      payload_start: base + 0x60,
      payload_is: 'PS2 VIF/GIF DMA packet input; vertex semantics unresolved',
    };
  }

  function parseXbdc(input) {
    const b = asBytes(input);
    bounds(b, 0, 0x20, 'XBDC header');
    if (ascii(b, 0, 4) !== 'XBDC') throw new Error('Not XBDC');
    const innerAt = b.length >= 0x24 && ascii(b, 0x20, 4) === 'FPS\0' ? 0x20 : null;
    return {
      magic: 'XBDC',
      header_word: u32(b, 4),
      data_off: u32(b, 0x0c),
      bounds: [f32(b, 0x10), f32(b, 0x14), f32(b, 0x18)],
      inner_fps_at: innerAt,
      inner: innerAt == null ? null : parseFps(b, innerAt),
    };
  }

  function parseRmac(input) {
    const b = asBytes(input);
    bounds(b, 0, 0x30, 'RMAC header');
    if (ascii(b, 0, 4) !== 'RMAC') throw new Error('Not RMAC');
    const innerAt = b.length >= 0x34 && ascii(b, 0x30, 4) === 'FPS\0' ? 0x30 : null;
    return {
      magic: 'RMAC',
      header_word: u32(b, 4),
      data_off: u32(b, 0x0c),
      inner_fps_at: innerAt,
      inner: innerAt == null ? null : parseFps(b, innerAt),
    };
  }

  function parseRta(input) {
    const b = asBytes(input);
    bounds(b, 0, 0x40, 'RTA header');
    if (ascii(b, 0, 4) !== 'RTA\0') throw new Error('Not RTA');
    const size = u32(b, 4),
      version = u16(b, 0x10),
      nodeCount = u16(b, 0x12),
      auxCount = u16(b, 0x14),
      off1 = u32(b, 0x18),
      off2 = u32(b, 0x1c);
    if (0x40 + nodeCount * 0x20 > b.length) throw new Error(`RTA node array exceeds data (${nodeCount} nodes)`);
    const boundsVectors = [];
    for (let i = 0; i < 8; i++) boundsVectors.push(f32(b, 0x20 + i * 4));
    const nodes = [];
    for (let i = 0, p = 0x40; i < nodeCount; i++, p += 0x20) {
      nodes.push({
        rec: p,
        f0: u32(b, p),
        reserved_04: u32(b, p + 4),
        flag_bytes: Array.from(b.subarray(p + 8, p + 12), (x) => x.toString(16).padStart(2, '0')).join(''),
        flags: u16(b, p + 0x0a),
        index: i16(b, p + 0x0c),
        parent: i16(b, p + 0x0e),
        translate: [f32(b, p + 0x10), f32(b, p + 0x14), f32(b, p + 0x18), f32(b, p + 0x1c)],
      });
    }
    const nodeArrayEnd = 0x40 + nodeCount * 0x20;
    const tailText = ascii(b, nodeArrayEnd, b.length - nodeArrayEnd);
    const names = [];
    const re = /[A-Za-z_][A-Za-z0-9_ .]{1,30}/g;
    let match;
    while ((match = re.exec(tailText)) && names.length < nodeCount) names.push([nodeArrayEnd + match.index, match[0]]);
    nodes.forEach((n, i) => {
      n.name = names[i] ? names[i][1] : `node_${n.index}`;
    });
    const byIndex = new Map(nodes.map((n) => [n.index, n]));
    const errors = [],
      roots = nodes.filter((n) => n.parent === -1).map((n) => n.index),
      visiting = new Set(),
      done = new Set();
    function validateNode(n) {
      if (done.has(n.index)) return;
      if (visiting.has(n.index)) {
        errors.push({ node: n.index, error: 'parent cycle' });
        return;
      }
      visiting.add(n.index);
      if (n.parent !== -1) {
        const parent = byIndex.get(n.parent);
        if (!parent) errors.push({ node: n.index, parent: n.parent, error: 'parent out of range' });
        else validateNode(parent);
      }
      visiting.delete(n.index);
      done.add(n.index);
    }
    nodes.forEach(validateNode);
    const worldCache = new Map();
    function world(n, stack = new Set()) {
      if (worldCache.has(n.index)) return worldCache.get(n.index);
      if (stack.has(n.index)) return null;
      stack.add(n.index);
      let result = n.translate.slice(0, 3);
      if (n.parent !== -1) {
        const p = byIndex.get(n.parent),
          pw = p && world(p, stack);
        if (!pw) return null;
        result = [pw[0] + result[0], pw[1] + result[1], pw[2] + result[2]];
      }
      stack.delete(n.index);
      worldCache.set(n.index, result);
      return result;
    }
    nodes.forEach((n) => {
      n.translation_chain_position = world(n);
    });
    return {
      magic: 'RTA',
      size,
      actual_size: b.length,
      size_matches: size === b.length,
      version,
      node_count: nodeCount,
      aux_count: auxCount,
      off1,
      off2,
      bounds: boundsVectors,
      node_array_end: nodeArrayEnd,
      nodes,
      names,
      roots,
      root_count: roots.length,
      hierarchy_valid: errors.length === 0,
      hierarchy_errors: errors,
      position_note:
        'translation_chain_position is parent-wise addition of verified local translation fields; off1 rotation/matrix semantics remain unresolved',
    };
  }

  function parseFas(input) {
    const b = asBytes(input);
    bounds(b, 0, Math.min(0x30, b.length), 'FAS header');
    if (b.length < 0x20 || ascii(b, 0, 4) !== 'FAS\0') throw new Error('Not FAS');
    const empty = ascii(b, 0x10, 4) === 'HFAS';
    return {
      magic: 'FAS',
      off04: u32(b, 4),
      off0c: u32(b, 0x0c),
      empty,
      target_skeleton: empty ? null : cstring(b, 0x10, 16),
      track_word_0x20: !empty && b.length >= 0x24 ? u32(b, 0x20) : 0,
      body_status: 'STRUCTURE_ONLY_CHANNEL_TYPES_UNRESOLVED',
    };
  }

  function parseFisHeader(input) {
    const b = asBytes(input);
    bounds(b, 0, 0x30, 'FIS header');
    if (ascii(b, 0, 4) !== 'FIS\0') throw new Error('Not FIS');
    const nominal = u32(b, 4) + 0x10,
      flags = u32(b, 0x10),
      low = flags & 0xffff,
      paletteEntries = flags >>> 16;
    const descriptor = u32(b, 0x1c) + 0x10;
    if (descriptor + 0x20 > b.length) throw new Error('FIS texture descriptor outside data');
    const actualPsm = u8(b, descriptor + 0x0c),
      allocW = 1 << u8(b, descriptor + 0x0e),
      allocH = 1 << u8(b, descriptor + 0x0f);
    const psmNames = { 0: 'PSMCT32', 1: 'PSMCT24', 0x13: 'PSMT8', 0x14: 'PSMT4' };
    return {
      magic: 'FIS',
      file_size: b.length,
      nominal_fis_size: nominal,
      trailing_size: b.length - nominal,
      flags_raw: flags,
      flags_low16: low,
      format_code: low & 3,
      indexed_flag: !!(low & 0x8000),
      repacked_upload_flag: !!(low & 0x2000),
      base_flag_0x1000: !!(low & 0x1000),
      palette_entries: paletteEntries,
      asset_label: cstring(b, 0x14, 4),
      texture_id: u32(b, 0x18),
      texture_descriptor_offset: descriptor,
      upload_width: u16(b, descriptor),
      upload_height: u16(b, descriptor + 2),
      payload_size: u32(b, descriptor + 4),
      transfer_control_offset: u32(b, descriptor + 8),
      actual_psm: actualPsm,
      actual_psm_name: psmNames[actualPsm] || `UNKNOWN_${hex(actualPsm, 2)}`,
      allocation_width: allocW,
      allocation_height: allocH,
      palette_payload_size: u32(b, 0x20),
      palette_control_offset: u32(b, 0x24),
    };
  }

  function parseDmm(input) {
    const b = asBytes(input);
    if (b.length < 0x4000) throw new Error('DMM data is shorter than the verified 128x128 index plane');
    const magic = b.length >= 4 ? ascii(b, 0, 4) : '';
    const planeOffset = b.length - 0x4000;
    return {
      magic: magic.startsWith('DMM') ? 'DMM' : 'UNCONFIRMED_DMM',
      file_size: b.length,
      width: 128,
      height: 128,
      index_plane_offset: planeOffset,
      index_plane_size: 0x4000,
      palette_status: 'OPTIONAL_EXTERNAL_OR_UNRESOLVED',
      evidence: '128x128 index plane verified by supplied PACK model pass; unlabelled header bytes remain unknown',
    };
  }

  function parseSeqwOuter(input) {
    const b = asBytes(input);
    bounds(b, 0, 0x20, 'SEQW header');
    if (ascii(b, 0, 4) !== 'SEQW') throw new Error('Not SEQW');
    const wavOffset = u32(b, 4);
    bounds(b, wavOffset, 0x20, 'SEQW WAV chunk');
    if (ascii(b, wavOffset, 4) !== 'WAV ') throw new Error('SEQW WAV chunk missing');
    const wavSize = u32(b, wavOffset + 4),
      audioRelative = u32(b, wavOffset + 8),
      descriptorBytes = u32(b, wavOffset + 0x0c),
      audioAllocation = u32(b, wavOffset + 0x10),
      audioUsed = u32(b, wavOffset + 0x14);
    const audioStart = wavOffset + audioRelative,
      descriptorStart = wavOffset + 0x20;
    if (descriptorStart + descriptorBytes > b.length || audioStart + audioUsed > b.length)
      throw new Error('SEQW section exceeds data');
    return {
      magic: 'SEQW',
      file_size: b.length,
      wav_offset: wavOffset,
      sequence_used_bytes: u32(b, 8),
      descriptor_bytes_mirror: u32(b, 0x0c),
      reserved_10: u32(b, 0x10),
      audio_used_mirror: u32(b, 0x14),
      field_18: u32(b, 0x18),
      reserved_1c: u32(b, 0x1c),
      wav: {
        offset: wavOffset,
        size_to_lip: wavSize,
        audio_relative_offset: audioRelative,
        descriptor_used_bytes: descriptorBytes,
        audio_allocation_bytes: audioAllocation,
        audio_used_bytes: audioUsed,
        field_18: u32(b, wavOffset + 0x18),
        reserved_1c: u32(b, wavOffset + 0x1c),
        descriptor_start: descriptorStart,
        audio_start: audioStart,
        lip_offset: wavOffset + wavSize,
      },
    };
  }

  function field(name, offset, width, type, value, evidence, description, extra) {
    return Object.assign(
      {
        name,
        offset,
        width,
        end: offset + width,
        type,
        endian: 'little',
        value,
        evidence: evidence || 'VERIFIED',
        description: description || '',
      },
      extra || {},
    );
  }

  function schemaPack(b) {
    const p = parsePack(b),
      fields = [
        field('magic', 0, 4, 'char[4]', 'PACK', 'VERIFIED', 'PACK-magic archive, distinct from semantic bundle'),
        field('version', 4, 2, 'u16', p.version, 'VERIFIED'),
        field('descriptor_count', 6, 2, 'u16', p.count, 'VERIFIED'),
      ];
    p.descriptors.forEach((d) => {
      fields.push(field(`descriptors[${d.index}].child_offset`, 8 + d.index * 8, 4, 'u32', d.child_offset, 'VERIFIED'));
      fields.push(
        field(
          `descriptors[${d.index}].tag_or_id`,
          12 + d.index * 8,
          4,
          'u32',
          hex(d.tag_or_id, 8),
          'VERIFIED',
          'Class/resource ID; not a child size',
        ),
      );
    });
    return { format: 'PACK', parsed: p, fields };
  }

  function schemaBundle(b) {
    const p = parseSemanticBundle(b),
      fields = [
        field('reserved_00', 0, 4, 'u32', 0, 'VERIFIED'),
        field('child_count', 4, 4, 'u32', p.count, 'VERIFIED'),
        field('header_size', 8, 4, 'u32', p.header_size, 'VERIFIED', 'Must equal 0x10*(count+1)'),
        field('reserved_0C', 12, 4, 'u32', 0, 'VERIFIED'),
      ];
    p.children.forEach((c) => {
      const o = 0x10 + c.index * 0x10;
      fields.push(field(`children[${c.index}].tag`, o, 4, 'u32/reversed-4CC', c.tag, 'VERIFIED'));
      fields.push(field(`children[${c.index}].res_id`, o + 4, 4, 'u32', hex(c.res_id, 8), 'VERIFIED'));
      fields.push(
        field(
          `children[${c.index}].actor_id`,
          o + 4,
          2,
          'derived low16',
          hex(c.actor_id, 4),
          'VERIFIED',
          'Low 16 bits of res_id',
        ),
      );
      fields.push(
        field(
          `children[${c.index}].animation_slot`,
          o + 6,
          2,
          'derived high16',
          hex(c.animation_slot, 4),
          'VERIFIED',
          'High 16 bits of res_id; do not assign motion names without a verified table',
        ),
      );
      fields.push(field(`children[${c.index}].stored_size`, o + 8, 4, 'u32', c.stored_size, 'VERIFIED'));
      fields.push(field(`children[${c.index}].child_offset`, o + 12, 4, 'u32', c.offset, 'VERIFIED'));
    });
    return { format: 'SEMANTIC_BUNDLE', parsed: p, fields };
  }

  function schemaMwo3(b) {
    const p = parseMwo3(b);
    return {
      format: 'MWo3',
      parsed: p,
      fields: [
        field('magic', 0, 4, 'char[4]', 'MWo3'),
        field('class_value', 4, 4, 'u32', p.class_value),
        field('load_base', 8, 4, 'u32', hex(p.load_base, 8)),
        field('region0_size', 0x0c, 4, 'u32', p.region0_size),
        field('region1_size', 0x10, 4, 'u32', p.region1_size),
        field('zero_fill_size', 0x14, 4, 'u32', p.zero_fill_size),
        field('init_array_start', 0x18, 4, 'u32', hex(p.init_array_start, 8)),
        field('init_array_end', 0x1c, 4, 'u32', hex(p.init_array_end, 8)),
      ],
    };
  }

  function schemaFps(b, base = 0, label = 'FPS') {
    const p = parseFps(b, base),
      f = [
        field(`${label}.magic`, base, 4, 'char[4]', 'FPS\0'),
        field(`${label}.off_a`, base + 4, 4, 'u32', p.off_a),
        field(`${label}.off_c`, base + 0x0c, 4, 'u32', p.off_c),
        field(`${label}.header_size`, base + 0x10, 4, 'u32', p.header_size),
        field(`${label}.sec14`, base + 0x14, 4, 'u32', p.sec14),
        field(`${label}.sec18`, base + 0x18, 4, 'u32', p.sec18),
        field(`${label}.bound_radius`, base + 0x1c, 4, 'f32', p.bound_radius, 'VERIFIED'),
      ];
    ['a.x', 'a.y', 'a.z', 'min.x', 'min.y', 'min.z', 'max.x', 'max.y', 'max.z'].forEach((n, i) =>
      f.push(field(`${label}.aabb.${n}`, base + 0x20 + i * 4, 4, 'f32', f32(b, base + 0x20 + i * 4), 'VERIFIED')),
    );
    f.push(
      field(
        `${label}.vif_input_start`,
        base + 0x60,
        0,
        'section',
        base + 0x60,
        'VERIFIED_PACKET_TYPE_SEMANTICS_UNRESOLVED',
        'PS2 VIF/GIF DMA packet input; not decoded model vertices',
      ),
    );
    return { format: label === 'FPS' ? 'FPS' : label.split('.')[0], parsed: p, fields: f };
  }

  function schemaRta(b) {
    const p = parseRta(b),
      f = [
        field('magic', 0, 4, 'char[4]', 'RTA\0'),
        field('total_size', 4, 4, 'u32', p.size),
        field('version', 0x10, 2, 'u16', p.version),
        field('node_count', 0x12, 2, 'u16', p.node_count),
        field('aux_count', 0x14, 2, 'u16', p.aux_count),
        field('off1', 0x18, 4, 'u32', p.off1, 'VERIFIED_POINTER_EXACT_CONTENT_PARTIAL'),
        field('off2', 0x1c, 4, 'u32', p.off2, 'VERIFIED_POINTER_EXACT_CONTENT_PARTIAL'),
      ];
    p.bounds.forEach((v, i) => f.push(field(`bounds[${Math.floor(i / 4)}][${i % 4}]`, 0x20 + i * 4, 4, 'f32', v)));
    p.nodes.forEach((n, i) => {
      const o = 0x40 + i * 0x20;
      f.push(field(`nodes[${i}].f0`, o, 4, 'u32', n.f0, 'VERIFIED_FIELD_ROLE_PARTIAL'));
      f.push(field(`nodes[${i}].flag2`, o + 0x0a, 2, 'u16', n.flags, 'VERIFIED_VALUE_ROLE_UNKNOWN'));
      f.push(field(`nodes[${i}].index`, o + 0x0c, 2, 'i16', n.index));
      f.push(field(`nodes[${i}].parent`, o + 0x0e, 2, 'i16', n.parent));
      n.translate.forEach((v, k) =>
        f.push(field(`nodes[${i}].translate[${k}]`, o + 0x10 + k * 4, 4, 'f32', v, 'VERIFIED')),
      );
    });
    return { format: 'RTA', parsed: p, fields: f };
  }

  function schemaFas(b) {
    const p = parseFas(b),
      f = [
        field('magic', 0, 4, 'char[4]', 'FAS\0'),
        field('off04', 4, 4, 'u32', p.off04),
        field('off0c', 0x0c, 4, 'u32', p.off0c),
      ];
    f.push(
      field(
        p.empty ? 'empty_submagic' : 'target_skeleton',
        0x10,
        16,
        'char[16]',
        p.empty ? 'HFAS' : p.target_skeleton,
        'VERIFIED',
      ),
    );
    if (!p.empty)
      f.push(
        field('track_word_0x20', 0x20, 4, 'u32', p.track_word_0x20, 'VERIFIED_VALUE_CHANNEL_SEMANTICS_UNRESOLVED'),
      );
    return { format: 'FAS', parsed: p, fields: f };
  }

  function schemaFis(b) {
    const p = parseFisHeader(b),
      o = p.texture_descriptor_offset;
    return {
      format: 'FIS',
      parsed: p,
      fields: [
        field('magic', 0, 4, 'char[4]', 'FIS\0'),
        field('stored_after_prefix', 4, 4, 'u32', p.nominal_fis_size - 0x10),
        field('aux_size_or_zero', 0x0c, 4, 'u32', u32(b, 0x0c), 'VERIFIED_VALUE_EXACT_ROLE_PARTIAL'),
        field('flags_and_palette_count', 0x10, 4, 'bitfield', hex(p.flags_raw, 8)),
        field('asset_label', 0x14, 4, 'char[4]', p.asset_label),
        field('texture_id', 0x18, 4, 'u32', p.texture_id),
        field('texture_descriptor_offset_minus_0x10', 0x1c, 4, 'u32', o - 0x10),
        field('palette_payload_size', 0x20, 4, 'u32', p.palette_payload_size),
        field('palette_control_offset', 0x24, 4, 'u32', p.palette_control_offset),
        field('texture.upload_width', o, 2, 'u16', p.upload_width),
        field('texture.upload_height', o + 2, 2, 'u16', p.upload_height),
        field('texture.payload_size', o + 4, 4, 'u32', p.payload_size),
        field('texture.transfer_control_offset', o + 8, 4, 'u32', p.transfer_control_offset),
        field('texture.actual_psm', o + 0x0c, 1, 'u8', p.actual_psm_name),
        field('texture.log2_allocation_width', o + 0x0e, 1, 'u8', Math.log2(p.allocation_width)),
        field('texture.log2_allocation_height', o + 0x0f, 1, 'u8', Math.log2(p.allocation_height)),
      ],
    };
  }

  function schemaDmm(b) {
    const p = parseDmm(b),
      fields = [];
    if (p.magic === 'DMM') fields.push(field('magic', 0, 4, 'char[4]', ascii(b, 0, 4), 'VERIFIED'));
    fields.push(
      field(
        'index_plane',
        p.index_plane_offset,
        p.index_plane_size,
        'u8[128][128]',
        '128x128 indices',
        'VERIFIED',
        'Header bytes before this plane remain unlabelled/unknown',
      ),
    );
    return { format: 'DMM', parsed: p, fields };
  }

  function schemaSeqw(b) {
    const p = parseSeqwOuter(b),
      w = p.wav.offset;
    return {
      format: 'SEQW',
      parsed: p,
      fields: [
        field('magic', 0, 4, 'char[4]', 'SEQW'),
        field('wav_offset', 4, 4, 'u32', p.wav_offset),
        field('sequence_used_bytes', 8, 4, 'u32', p.sequence_used_bytes),
        field('descriptor_bytes_mirror', 0x0c, 4, 'u32', p.descriptor_bytes_mirror),
        field('reserved_10', 0x10, 4, 'u32', p.reserved_10),
        field('audio_used_mirror', 0x14, 4, 'u32', p.audio_used_mirror),
        field('field_18', 0x18, 4, 'u32', p.field_18, 'VERIFIED_VALUE_EXACT_ROLE_PARTIAL'),
        field('reserved_1C', 0x1c, 4, 'u32', p.reserved_1c),
        field('wav.magic', w, 4, 'char[4]', 'WAV '),
        field('wav.size_to_lip', w + 4, 4, 'u32', p.wav.size_to_lip),
        field('wav.audio_relative_offset', w + 8, 4, 'u32', p.wav.audio_relative_offset),
        field('wav.descriptor_used_bytes', w + 0x0c, 4, 'u32', p.wav.descriptor_used_bytes),
        field('wav.audio_allocation_bytes', w + 0x10, 4, 'u32', p.wav.audio_allocation_bytes),
        field('wav.audio_used_bytes', w + 0x14, 4, 'u32', p.wav.audio_used_bytes),
      ],
    };
  }

  function schemaXbdc(b) {
    const p = parseXbdc(b),
      f = [
        field('magic', 0, 4, 'char[4]', 'XBDC'),
        field('header_word', 4, 4, 'u32', p.header_word),
        field('data_off', 0x0c, 4, 'u32', p.data_off),
        field('bounds.x', 0x10, 4, 'f32', p.bounds[0]),
        field('bounds.y', 0x14, 4, 'f32', p.bounds[1]),
        field('bounds.z', 0x18, 4, 'f32', p.bounds[2]),
      ];
    if (p.inner_fps_at != null) f.push(...schemaFps(b, p.inner_fps_at, 'XBDC.inner_FPS').fields);
    return { format: 'XBDC', parsed: p, fields: f };
  }

  function schemaRmac(b) {
    const p = parseRmac(b),
      f = [
        field('magic', 0, 4, 'char[4]', 'RMAC'),
        field('header_word', 4, 4, 'u32', p.header_word),
        field('data_off', 0x0c, 4, 'u32', p.data_off),
      ];
    for (let o = 0x10; o < 0x30; o += 4)
      f.push(
        field(
          `header_unknown_${hex(o, 2)}`,
          o,
          4,
          'u32/f32',
          `${hex(u32(b, o), 8)} / ${f32(b, o)}`,
          'OBSERVED_SINGLE_SAMPLE_ROLE_UNKNOWN',
        ),
      );
    if (p.inner_fps_at != null) f.push(...schemaFps(b, p.inner_fps_at, 'RMAC.inner_FPS').fields);
    return { format: 'RMAC', parsed: p, fields: f };
  }

  function schemaFor(input, formatHint) {
    const b = asBytes(input),
      detected = formatHint || classifyBytes(b);
    try {
      if (detected === 'PACK') return schemaPack(b);
      if (detected === 'SEMANTIC_BUNDLE') return schemaBundle(b);
      if (detected === 'MWo3') return schemaMwo3(b);
      if (detected === 'FPS') return schemaFps(b);
      if (detected === 'XBDC') return schemaXbdc(b);
      if (detected === 'RMAC') return schemaRmac(b);
      if (detected === 'RTA') return schemaRta(b);
      if (detected === 'FAS') return schemaFas(b);
      if (detected === 'FIS') return schemaFis(b);
      if (detected === 'DMM') return schemaDmm(b);
      if (detected === 'SEQW') return schemaSeqw(b);
      return {
        format: detected || 'UNKNOWN',
        parsed: null,
        fields: [],
        unresolved: 'No verified schema adapter for this byte range',
      };
    } catch (error) {
      return { format: detected || 'UNKNOWN', parsed: null, fields: [], error: error.message };
    }
  }

  function atlasRecord(input) {
    const r = Object.assign(
      {
        id: null,
        project_id: null,
        disc_identity: null,
        hidden_entry: null,
        allocation_offset: null,
        wrapper_chain: [],
        block_number: null,
        container_ancestry: [],
        semantic_tag: null,
        inner_format: null,
        res_id: null,
        actor_id: null,
        animation_slot: null,
        stored_size: null,
        decoded_size: null,
        hashes: {},
        duplicate_of: null,
        parser: { name: 'none', version: VERSION, status: 'unparsed' },
        evidence: { tier: 'UNKNOWN', sources: [] },
        engine_consumers: [],
        notes: '',
        unresolved_fields: [],
        provenance: {},
      },
      input || {},
    );
    if (r.res_id != null) {
      const ids = splitResourceId(r.res_id);
      if (r.actor_id == null) r.actor_id = ids.actor_id;
      if (r.animation_slot == null) r.animation_slot = ids.animation_slot;
    }
    if (!r.id) {
      const parts = [
        r.project_id || 'project',
        r.hidden_entry ?? 'none',
        r.block_number ?? 'none',
        r.container_ancestry.join('/'),
        r.semantic_tag || '',
        r.res_id ?? '',
        r.provenance.decoded_offset ?? r.provenance.iso_offset ?? '',
      ];
      r.id = parts.map((x) => String(x).replace(/[^A-Za-z0-9_.:-]+/g, '_')).join('|');
    }
    return r;
  }

  function mergeAtlas(existing, incoming) {
    const map = new Map();
    for (const raw of [...(existing || []), ...(incoming || [])]) {
      const r = atlasRecord(raw),
        old = map.get(r.id);
      if (!old) {
        map.set(r.id, r);
        continue;
      }
      const merged = Object.assign({}, old, r, {
        wrapper_chain: Array.from(new Set([...(old.wrapper_chain || []), ...(r.wrapper_chain || [])])),
        container_ancestry:
          r.container_ancestry && r.container_ancestry.length ? r.container_ancestry : old.container_ancestry,
        hashes: Object.assign({}, old.hashes || {}, r.hashes || {}),
        parser: Object.assign({}, old.parser || {}, r.parser || {}),
        evidence: {
          tier: r.evidence?.tier && r.evidence.tier !== 'UNKNOWN' ? r.evidence.tier : old.evidence?.tier || 'UNKNOWN',
          sources: Array.from(new Set([...(old.evidence?.sources || []), ...(r.evidence?.sources || [])])),
        },
        engine_consumers: [...(old.engine_consumers || []), ...(r.engine_consumers || [])].filter(
          (x, i, a) => a.findIndex((y) => JSON.stringify(y) === JSON.stringify(x)) === i,
        ),
        unresolved_fields: Array.from(new Set([...(old.unresolved_fields || []), ...(r.unresolved_fields || [])])),
        provenance: Object.assign({}, old.provenance || {}, r.provenance || {}),
      });
      map.set(r.id, merged);
    }
    const hashOwner = new Map();
    for (const r of map.values()) {
      const h = r.hashes?.sha256;
      if (!h) continue;
      if (hashOwner.has(h) && hashOwner.get(h) !== r.id) r.duplicate_of = hashOwner.get(h);
      else hashOwner.set(h, r.id);
    }
    return Array.from(map.values()).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  function groupActors(records) {
    const groups = new Map();
    for (const r of records || []) {
      if (r.actor_id == null || !r.semantic_tag) continue;
      const key = Number(r.actor_id) & 0xffff;
      if (!groups.has(key))
        groups.set(key, {
          actor_id: key,
          geometry: [],
          skeletons: [],
          animations: [],
          map_resources: [],
          other: [],
          conflicts: [],
          missing: [],
        });
      const g = groups.get(key),
        tag = r.semantic_tag;
      if (tag === 'CHAR') g.geometry.push(r);
      else if (tag === 'ATRC') g.skeletons.push(r);
      else if (tag === 'ANIM') g.animations.push(r);
      else if (['MAP', 'ATRM', 'MAPA', 'MMAP', 'MSE', 'SCE'].includes(tag)) g.map_resources.push(r);
      else g.other.push(r);
    }
    for (const g of groups.values()) {
      g.animations.sort((a, b) => (a.animation_slot ?? 0) - (b.animation_slot ?? 0));
      if (g.geometry.length && !g.skeletons.length) g.missing.push('ATRC/RTA skeleton not indexed');
      if (g.skeletons.length && !g.geometry.length) g.missing.push('CHAR geometry not indexed');
      if (g.geometry.length > 1) g.conflicts.push('multiple CHAR geometry records');
      if (g.skeletons.length > 1) g.conflicts.push('multiple ATRC skeleton records');
    }
    return Array.from(groups.values()).sort((a, b) => a.actor_id - b.actor_id);
  }

  function extractStrings(input, minLength = 4, cap = 1000) {
    const b = asBytes(input),
      out = [];
    let start = -1,
      text = '';
    for (let i = 0; i <= b.length; i++) {
      const c = i < b.length ? b[i] : 0;
      if (c >= 0x20 && c < 0x7f) {
        if (start < 0) start = i;
        text += String.fromCharCode(c);
      } else {
        if (text.length >= minLength) out.push({ offset: start, text });
        start = -1;
        text = '';
        if (out.length >= cap) break;
      }
    }
    return out;
  }

  function byteHistogram(input) {
    const b = asBytes(input),
      counts = new Array(256).fill(0);
    for (const x of b) counts[x]++;
    return counts;
  }

  function numberStats(input) {
    const b = asBytes(input),
      ints = [],
      floats = [];
    for (let o = 0; o + 4 <= b.length; o += 4) {
      ints.push(u32(b, o));
      const v = f32(b, o);
      if (Number.isFinite(v)) floats.push(v);
    }
    function stats(a) {
      if (!a.length) return { count: 0, min: null, max: null, mean: null };
      let min = a[0],
        max = a[0],
        sum = 0;
      for (const x of a) {
        if (x < min) min = x;
        if (x > max) max = x;
        sum += x;
      }
      return { count: a.length, min, max, mean: sum / a.length };
    }
    return { u32: stats(ints), finite_f32: stats(floats) };
  }

  function fnv1a(input) {
    const b = asBytes(input);
    let h = 0x811c9dc5;
    for (const x of b) {
      h ^= x;
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function repeatedBlocks(input, blockSize = 16, cap = 100) {
    const b = asBytes(input),
      map = new Map();
    for (let o = 0; o + blockSize <= b.length; o += blockSize) {
      const h = fnv1a(b.subarray(o, o + blockSize));
      if (!map.has(h)) map.set(h, []);
      const a = map.get(h);
      if (a.length < 64) a.push(o);
    }
    return Array.from(map.entries())
      .filter(([, offsets]) => offsets.length > 1)
      .map(([hash, offsets]) => ({ hash: hex(hash, 8), occurrences: offsets.length, offsets }))
      .sort((a, b2) => b2.occurrences - a.occurrences)
      .slice(0, cap);
  }

  function compareResources(aInput, bInput, options) {
    const a = asBytes(aInput),
      b = asBytes(bInput),
      opts = Object.assign({ maxDifferences: 1000, blockSize: 16 }, options || {}),
      min = Math.min(a.length, b.length);
    let different = Math.abs(a.length - b.length),
      first = null,
      prefix = 0,
      suffix = 0;
    const samples = [];
    for (let i = 0; i < min; i++) {
      if (a[i] === b[i]) {
        if (first == null) prefix++;
        continue;
      }
      different++;
      if (first == null) first = i;
      if (samples.length < opts.maxDifferences) samples.push({ offset: i, a: a[i], b: b[i] });
    }
    while (suffix < min - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
    const sa = schemaFor(a, opts.formatA),
      sb = schemaFor(b, opts.formatB),
      ma = new Map(sa.fields.map((x) => [x.name, x])),
      mb = new Map(sb.fields.map((x) => [x.name, x])),
      fieldDiffs = [];
    for (const name of new Set([...ma.keys(), ...mb.keys()])) {
      const x = ma.get(name),
        y = mb.get(name);
      if (
        !x ||
        !y ||
        JSON.stringify(x.value) !== JSON.stringify(y.value) ||
        x.offset !== y.offset ||
        x.width !== y.width
      )
        fieldDiffs.push({
          name,
          a: x || null,
          b: y || null,
          classification: !x || !y ? 'observation' : 'parsed-field difference',
        });
    }
    return {
      format: 'SO3_STRUCTURAL_COMPARISON',
      version: 1,
      observations: {
        sizes: { a: a.length, b: b.length },
        raw_equal: a.length === b.length && different === 0,
        different_byte_count: different,
        first_difference: first,
        common_prefix_bytes: prefix,
        common_suffix_bytes: suffix,
        difference_samples: samples,
        schema_formats: { a: sa.format, b: sb.format },
        parsed_field_differences: fieldDiffs,
        numeric: { a: numberStats(a), b: numberStats(b) },
        strings: { a: extractStrings(a, 4, 200), b: extractStrings(b, 4, 200) },
        repeated_blocks: {
          block_size: opts.blockSize,
          a: repeatedBlocks(a, opts.blockSize),
          b: repeatedBlocks(b, opts.blockSize),
        },
      },
      correlations: [],
      verified_conclusions: [],
      caution: 'Correlations are not promoted to verified conclusions automatically.',
    };
  }

  function parseJsonl(text, options) {
    const opts = Object.assign({ maxRecords: 1000000 }, options || {}),
      records = [],
      errors = [];
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (records.length >= opts.maxRecords) {
        errors.push({ line: i + 1, error: 'record limit exceeded' });
        break;
      }
      try {
        records.push(JSON.parse(line));
      } catch (error) {
        errors.push({ line: i + 1, error: error.message });
      }
    }
    return { records, errors, line_count: lines.length };
  }

  function validateTraceSummary(summary) {
    const errors = [],
      warnings = [];
    if (!summary || typeof summary !== 'object')
      return { valid: false, errors: ['summary is not an object'], warnings };
    if (!Array.isArray(summary.fps_records)) errors.push('fps_records must be an array');
    if (!Number.isInteger(summary.event_count) || summary.event_count < 0)
      errors.push('event_count must be a nonnegative integer');
    for (const key of ['mpg_upload_count', 'microprogram_call_count', 'direct_command_count', 'gif_packet_count'])
      if (summary[key] != null && (!Number.isInteger(summary[key]) || summary[key] < 0))
        errors.push(`${key} must be a nonnegative integer`);
    if (summary.tops_resolution && !String(summary.tops_resolution).toLowerCase().includes('unknown'))
      warnings.push(
        'TOPS resolution is not marked unknown; inspect runtime provenance before treating VU addresses as absolute',
      );
    return { valid: errors.length === 0, errors, warnings };
  }

  function summarizeTrace(summary, events, vectors, warnings) {
    const validation = validateTraceSummary(summary),
      commandCounts = {},
      stateChanges = [],
      unpackRanges = [];
    for (const e of events || []) {
      const c = e.command || `CMD_${e.command_id ?? 'UNKNOWN'}`;
      commandCounts[c] = (commandCounts[c] || 0) + 1;
      if (e.command === 'UNPACK' && e.details)
        unpackRanges.push({
          record: e.fps_record_index,
          file_offset: e.file_offset,
          format: e.details.format,
          destination: e.details.destination_expression,
          tops_relative: e.details.tops_relative,
          source_span: e.details.source_span || e.payload_span,
          writes: e.details.writes?.length ?? null,
        });
      if (e.state_before && e.state_after) {
        const changed = {};
        for (const k of Object.keys(e.state_after))
          if (JSON.stringify(e.state_before[k]) !== JSON.stringify(e.state_after[k]))
            changed[k] = { before: e.state_before[k], after: e.state_after[k] };
        if (Object.keys(changed).length) stateChanges.push({ file_offset: e.file_offset, command: e.command, changed });
      }
    }
    return {
      validation,
      summary,
      imported_event_count: (events || []).length,
      command_counts_from_events: commandCounts,
      unpack_ranges: unpackRanges,
      state_changes: stateChanges,
      vectors: vectors || [],
      warnings: warnings || [],
      geometry_semantics_status: 'NOT_AUTHORIZED_BY_EVIDENCE',
    };
  }

  function migrateProjectPackage(input) {
    const p = JSON.parse(JSON.stringify(input));
    if (!p || p.format !== PROJECT_FORMAT) throw new Error(`Project package format must be ${PROJECT_FORMAT}`);
    const version = Number(p.schema_version || 0);
    if (version > PROJECT_SCHEMA_VERSION)
      throw new Error(`Project schema ${version} is newer than supported schema ${PROJECT_SCHEMA_VERSION}`);
    if (version < 1) throw new Error(`Unsupported project schema ${version}`);
    p.schema_version = PROJECT_SCHEMA_VERSION;
    p.project = p.project || {};
    p.atlas = Array.isArray(p.atlas) ? p.atlas.map(atlasRecord) : [];
    p.notes = Array.isArray(p.notes) ? p.notes : [];
    p.staged_changes = Array.isArray(p.staged_changes) ? p.staged_changes : [];
    p.trace_summaries = Array.isArray(p.trace_summaries) ? p.trace_summaries : [];
    p.parser_cache = Array.isArray(p.parser_cache) ? p.parser_cache : [];
    return p;
  }

  function validateProjectPackage(input) {
    const errors = [];
    try {
      const p = migrateProjectPackage(input);
      if (!p.project.id) errors.push('project.id is required');
      if (!p.project.disc_identity || !p.project.disc_identity.iso_size || !p.project.disc_identity.table_fingerprint)
        errors.push('project.disc_identity requires iso_size and table_fingerprint');
      return { valid: errors.length === 0, errors, migrated: p };
    } catch (error) {
      return { valid: false, errors: [error.message], migrated: null };
    }
  }

  function makeProjectPackage(project, content) {
    const c = content || {};
    return migrateProjectPackage({
      format: PROJECT_FORMAT,
      schema_version: PROJECT_SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      tool_version: VERSION,
      project,
      atlas: c.atlas || [],
      notes: c.notes || [],
      staged_changes: (c.staged_changes || []).map((x) => {
        const y = Object.assign({}, x);
        delete y.blob;
        delete y.original_blob;
        return y;
      }),
      trace_summaries: c.trace_summaries || [],
      parser_cache: c.parser_cache || [],
      payload_policy: 'No ISO bytes. Replacement blobs are excluded; only their metadata and hashes are exported.',
    });
  }

  const PROJECT_SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://openai.local/so3/project-schema-v1.json',
    title: 'SO3 Resource Explorer V5 project package',
    type: 'object',
    additionalProperties: true,
    required: ['format', 'schema_version', 'project', 'atlas', 'notes', 'staged_changes'],
    properties: {
      format: { const: PROJECT_FORMAT },
      schema_version: { const: 1 },
      project: {
        type: 'object',
        required: ['id', 'disc_identity'],
        properties: { id: { type: 'string' }, name: { type: 'string' }, disc_identity: { type: 'object' } },
      },
      atlas: { type: 'array' },
      notes: { type: 'array' },
      staged_changes: { type: 'array' },
      trace_summaries: { type: 'array' },
      parser_cache: { type: 'array' },
    },
  });

  const ATLAS_SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://openai.local/so3/atlas-schema-v1.json',
    title: 'SO3 canonical atlas',
    type: 'object',
    additionalProperties: false,
    required: ['format', 'schema_version', 'records'],
    properties: {
      format: { const: ATLAS_FORMAT },
      schema_version: { const: 1 },
      records: { type: 'array', items: { type: 'object', required: ['id', 'parser', 'evidence', 'provenance'] } },
      sources: { type: 'array' },
      exported_at: { type: 'string' },
    },
  });

  return Object.freeze({
    VERSION,
    PROJECT_FORMAT,
    PROJECT_SCHEMA_VERSION,
    ATLAS_FORMAT,
    ATLAS_SCHEMA_VERSION,
    SECTOR_SIZE,
    TAG_U32,
    TAG_INNER_FORMATS,
    ENGINE_XREFS,
    PROJECT_SCHEMA,
    ATLAS_SCHEMA,
    asBytes,
    u8,
    i8,
    u16,
    i16,
    u32,
    i32,
    f32,
    u64,
    hex,
    ascii,
    cstring,
    splitResourceId,
    logicalTag,
    classifyBytes,
    identifyContainer,
    parsePack,
    isSemanticBundle,
    parseSemanticBundle,
    scanSemanticBundles,
    parseMwo3,
    parseFps,
    parseXbdc,
    parseRmac,
    parseRta,
    parseFas,
    parseFisHeader,
    parseDmm,
    parseSeqwOuter,
    schemaFor,
    atlasRecord,
    mergeAtlas,
    groupActors,
    extractStrings,
    byteHistogram,
    numberStats,
    repeatedBlocks,
    compareResources,
    parseJsonl,
    validateTraceSummary,
    summarizeTrace,
    migrateProjectPackage,
    validateProjectPackage,
    makeProjectPackage,
  });
});
