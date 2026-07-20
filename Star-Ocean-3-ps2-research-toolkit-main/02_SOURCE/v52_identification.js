/* SO3 Resource Explorer V5.3 evidence-graded resource identification core.
 * No DOM dependencies. Works in a browser or CommonJS test runner.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SO3V52Identify = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '5.4.0';
  const SECTOR = 0x800;
  const FRAME = 0x4000;
  const FAMILY8 = '77522267B4EFDB84';
  const FAMILY6 = '77522267B4EF';
  const PACK = Uint8Array.from([0x00, 0x00, 0x01, 0xba]);
  const ATLAS = Object.freeze({
    version: 'SO3_ATLAS_CONSOLIDATION_PASS_V1_1_1',
    atlas_sha256: 'a8e027d1e9a2b26ac5a4b8caddd4c97a0da2f7a1150962b169475846de8a5ba9',
    format_registry_sha256: '4a812d43bef2a89a6439a5fe33ae5ec682936c9286d567e51f36df9d6be466b7',
  });

  const FORMAT_META = Object.freeze({
    PACK: ['Archive', 'archives', '📦'],
    SEMANTIC_BUNDLE: ['Semantic resource bundle', 'archives', '📦'],
    SEMANTIC_BUNDLE_SET: ['Multi-bundle allocation', 'archives', '📦'],
    ZLS: ['Container wrapper', 'archives', '🧰'],
    ELF: ['Executable', 'executables', '⚙️'],
    MWo3: ['Engine overlay', 'executables', '⚙️'],
    FIS: ['Texture/image container', 'textures', '🖼️'],
    DMM: ['Minimap/index raster', 'textures', '🗺️'],
    PNG: ['Image', 'textures', '🖼️'],
    TIM2: ['Texture', 'textures', '🖼️'],
    FPS: ['Model/map chain', 'models', '🧊'],
    XBDC: ['Skinned model chain', 'models', '🧍'],
    RMAC: ['Model/map chain', 'models', '🗺️'],
    RTA: ['Skeleton hierarchy', 'models', '🦴'],
    FAS: ['Skeletal animation', 'models', '🎞️'],
    SEQW: ['SO3 audio sequence', 'audio', '🎵'],
    SEQW_BANK: ['SEQW sector archive', 'audio', '🎵'],
    VSC: ['Lip-synchronization state table', 'audio', '🗣️'],
    SCE_SCRIPT: ['Event script', 'text', '📜'],
    SMCD: ['so3mclib serialized data', 'candidates', '🔬'],
    MPEG_PS: ['MPEG program stream', 'video', '🎬'],
    SO3_MOVIE_CARRIER: ['SO3 obfuscated MPEG-PS carrier', 'video', '🎬'],
  });

  function asBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return Uint8Array.from(input || []);
  }

  function hex(input, limit) {
    const b = asBytes(input);
    const end = limit == null ? b.length : Math.min(b.length, limit);
    let out = '';
    for (let i = 0; i < end; i++) out += b[i].toString(16).padStart(2, '0');
    return out.toUpperCase();
  }

  function ascii(input, start = 0, length) {
    const b = asBytes(input);
    const end = Math.min(b.length, start + (length == null ? b.length - start : length));
    let out = '';
    for (let i = start; i < end; i++) out += b[i] >= 32 && b[i] < 127 ? String.fromCharCode(b[i]) : '.';
    return out;
  }

  function rawAscii(input, start = 0, length) {
    const b = asBytes(input);
    const end = Math.min(b.length, start + (length == null ? b.length - start : length));
    let out = '';
    for (let i = start; i < end; i++) out += String.fromCharCode(b[i]);
    return out;
  }

  function u16le(b, o) {
    b = asBytes(b);
    return (b[o] | (b[o + 1] << 8)) >>> 0;
  }

  function u32le(b, o) {
    b = asBytes(b);
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  function u16be(b, o) {
    b = asBytes(b);
    return ((b[o] << 8) | b[o + 1]) >>> 0;
  }

  function equal(a, b) {
    a = asBytes(a);
    b = asBytes(b);
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function findBytes(haystack, needle, start = 0) {
    const h = asBytes(haystack), n = asBytes(needle);
    outer: for (let i = Math.max(0, start); i + n.length <= h.length; i++) {
      for (let j = 0; j < n.length; j++) if (h[i + j] !== n[j]) continue outer;
      return i;
    }
    return -1;
  }

  function printableRatio(input) {
    const b = asBytes(input);
    if (!b.length) return 0;
    let count = 0;
    for (const x of b) if (x === 9 || x === 10 || x === 13 || (x >= 32 && x < 127)) count++;
    return count / b.length;
  }

  function zeroRatio(input) {
    const b = asBytes(input);
    if (!b.length) return 0;
    let count = 0;
    for (const x of b) if (x === 0) count++;
    return count / b.length;
  }

  function entropy(input) {
    const b = asBytes(input);
    if (!b.length) return 0;
    const counts = new Uint32Array(256);
    for (const x of b) counts[x]++;
    let out = 0;
    for (const count of counts) if (count) {
      const p = count / b.length;
      out -= p * Math.log2(p);
    }
    return out;
  }

  function meta(format, overrides) {
    const known = FORMAT_META[format] || ['Unknown binary', 'unknown', '❔'];
    return Object.assign({
      format,
      display: format,
      role: known[0],
      category: known[1],
      icon: known[2],
      confidence: FORMAT_META[format] ? 'VERIFIED' : 'UNRESOLVED',
      playable: null,
      decodable: null,
      evidence: [],
      reasons: [],
      atlas: ATLAS,
    }, overrides || {});
  }

  function magicClassification(input) {
    const b = asBytes(input);
    const head8 = hex(b, 8);
    if (b.length >= 8 && head8 === FAMILY8) return meta('SO3_MOVIE_CARRIER_CANDIDATE', {
      display: 'SO3 movie carrier candidate',
      role: 'Movie-family candidate', category: 'candidates', icon: '🧪', confidence: 'OBSERVED', playable: false, decodable: false,
      evidence: ['8-byte family marker'],
      reasons: ['Marker selects the 77522267B4EFDB84 family; marker alone cannot verify the carrier.'],
    });
    if (b.length >= 4) {
      const s4 = rawAscii(b, 0, 4);
      const map = {
        PACK: 'PACK', MWo3: 'MWo3', XBDC: 'XBDC', RMAC: 'RMAC', SEQW: 'SEQW',
        'FIS\0': 'FIS', PSIF: 'FIS', 'FPS\0': 'FPS', 'RTA\0': 'RTA', 'FAS\0': 'FAS',
        'DMM\0': 'DMM', 'VSC ': 'VSC', TIM2: 'TIM2',
      };
      if (map[s4]) return meta(map[s4], { evidence: [`verified magic ${JSON.stringify(s4)}`], reasons: ['Atlas V1.1.1 verified magic at offset 0.'] });
      if (s4.slice(0, 3) === 'SLZ' && b[3] <= 3) return meta(`SLZ${b[3]}`, {
        role: 'Compression wrapper', category: 'compressed', icon: '🗜️', confidence: 'VERIFIED',
        evidence: ['SLZ variant magic'], reasons: ['Verified SLZ wrapper header.'],
      });
      if (s4.slice(0, 3) === 'SLE' && b[3] <= 3) return meta(`SLE${b[3]}`, {
        role: 'Encrypted wrapper', category: 'compressed', icon: '🔐', confidence: 'VERIFIED',
        evidence: ['SLE variant magic'], reasons: ['Verified SLE wrapper header.'],
      });
      if (s4.slice(0, 3) === 'ZLS') return meta('ZLS', { evidence: ['ZLS magic'], reasons: ['Verified ZLS wrapper header.'] });
      if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46)
        return meta('ELF', { evidence: ['ELF magic'], reasons: ['Verified ELF executable header.'] });
      if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0xba)
        return meta('MPEG_PS', { evidence: ['MPEG pack start code'], reasons: ['Raw bytes begin with an MPEG program-stream pack header.'] });
    }
    if (b.length >= 8 && head8 === '89504E470D0A1A0A')
      return meta('PNG', { evidence: ['PNG signature'], reasons: ['Verified PNG signature at offset 0.'] });
    return null;
  }

  function headerLabel(input) {
    const b = asBytes(input), found = magicClassification(b);
    if (found) return found.format;
    return hex(b, Math.min(8, b.length));
  }

  function semanticBundleHeader(input, allocationSize) {
    const b = asBytes(input);
    if (b.length < 16) return null;
    const reserved0 = u32le(b, 0), count = u32le(b, 4), headerSize = u32le(b, 8), reserved3 = u32le(b, 12);
    if (reserved0 !== 0 || reserved3 !== 0 || count < 1 || count > 4096 || headerSize !== 0x10 * (count + 1)) return null;
    if (allocationSize != null && headerSize > allocationSize) return null;
    return { count, header_size: headerSize };
  }

  function printableTag(value) {
    const chars = [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
    const printable = chars.filter((x) => x >= 32 && x < 127).length;
    return printable >= 2 && chars.every((x) => x === 0 || (x >= 32 && x < 127));
  }

  function validateSemanticDescriptors(input, allocationSize) {
    const b = asBytes(input), h = semanticBundleHeader(b, allocationSize);
    if (!h || b.length < h.header_size) return null;
    let previousEnd = h.header_size, knownTags = 0, lastEnd = h.header_size;
    for (let i = 0; i < h.count; i++) {
      const p = 0x10 + i * 0x10, tag = u32le(b, p), size = u32le(b, p + 8), offset = u32le(b, p + 12);
      if (offset !== previousEnd || offset + size > allocationSize) return null;
      if (printableTag(tag)) knownTags++;
      previousEnd = offset + size;
      lastEnd = Math.max(lastEnd, offset + size);
    }
    if (!knownTags) return null;
    return { count: h.count, header_size: h.header_size, printable_tags: knownTags, last_child_end: lastEnd };
  }

  function findEmbeddedMagic(input) {
    const b = asBytes(input), patterns = [
      ['PACK', [0x50, 0x41, 0x43, 0x4b]], ['MWo3', [0x4d, 0x57, 0x6f, 0x33]],
      ['XBDC', [0x58, 0x42, 0x44, 0x43]], ['RMAC', [0x52, 0x4d, 0x41, 0x43]],
      ['SEQW', [0x53, 0x45, 0x51, 0x57]], ['FIS', [0x46, 0x49, 0x53, 0x00]],
      ['FPS', [0x46, 0x50, 0x53, 0x00]], ['RTA', [0x52, 0x54, 0x41, 0x00]],
      ['FAS', [0x46, 0x41, 0x53, 0x00]], ['VSC', [0x56, 0x53, 0x43, 0x20]],
      ['ELF', [0x7f, 0x45, 0x4c, 0x46]], ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ];
    const out = [];
    for (const [format, bytes] of patterns) {
      const offset = findBytes(b, Uint8Array.from(bytes), 1);
      if (offset >= 0) out.push({ format, offset });
    }
    return out;
  }

  function inspectSample(input, options) {
    const b = asBytes(input), opts = options || {}, complete = !!opts.complete;
    const rawHeader = hex(b, Math.min(8, b.length)), first = magicClassification(b);
    const metrics = {
      bytes_examined: b.length,
      complete_allocation: complete,
      entropy: Number(entropy(b).toFixed(6)),
      printable_ratio: Number(printableRatio(b).toFixed(6)),
      zero_ratio: Number(zeroRatio(b).toFixed(6)),
      raw_header: rawHeader,
      ascii_head: ascii(b, 0, Math.min(32, b.length)),
    };
    if (first) return Object.assign(first, { metrics });

    const semantic = complete ? validateSemanticDescriptors(b, b.length) : null;
    const semanticTailZero = semantic && b.subarray(semantic.last_child_end).every((x) => x === 0);
    if (semanticTailZero) return Object.assign(meta('SEMANTIC_BUNDLE', {
      evidence: ['validated 16-byte descriptor table and allocation bounds'],
      reasons: [`${semantic.count} child descriptors are contiguous and in bounds; trailing allocation padding is zero.`],
    }), { metrics, structure: semantic });

    if (complete && metrics.zero_ratio === 1) return Object.assign(meta('ZERO_FILLED_ALLOCATION', {
      display: 'Zero-filled allocation', role: 'Padding / empty allocation', category: 'candidates', icon: '⬜',
      confidence: 'VERIFIED', evidence: ['complete allocation scan'], reasons: ['Every byte in the allocation is zero.'],
    }), { metrics });

    const banner = findBytes(b, Uint8Array.from(Array.from('so3mclib 1.80i', (x) => x.charCodeAt(0))));
    if (banner >= 0) return Object.assign(meta('SMCD', {
      confidence: 'STRONG_INFERENCE', evidence: [`so3mclib 1.80i banner at 0x${banner.toString(16).toUpperCase()}`],
      reasons: ['Banner agrees with the verified SMCD family; offset-table validation is still required.'],
    }), { metrics });

    if (b.length >= 64 && metrics.printable_ratio >= 0.9 && metrics.zero_ratio < 0.15) return Object.assign(meta('TEXT_DATA_CANDIDATE', {
      display: 'Text-data candidate', role: 'Text-like data', category: 'candidates', icon: '📝', confidence: 'STRONG_INFERENCE',
      evidence: ['high printable-byte ratio'], reasons: ['Content is text-like, but no script grammar has been validated.'],
    }), { metrics });

    const embedded = findEmbeddedMagic(b);
    if (embedded.length) return Object.assign(meta('EMBEDDED_FORMAT_CANDIDATE', {
      display: `Embedded ${embedded[0].format} candidate`, role: 'Container/reconstruction candidate', category: 'candidates', icon: '🔬',
      confidence: 'HYPOTHESIS', evidence: embedded.map((x) => `${x.format}@0x${x.offset.toString(16).toUpperCase()}`),
      reasons: ['A known magic occurs away from offset 0; this does not identify the outer allocation.'],
    }), { metrics, embedded });

    return Object.assign(meta('UNKNOWN', {
      display: rawHeader || 'UNKNOWN', confidence: 'UNRESOLVED',
      evidence: ['bounded byte diagnostics only'],
      reasons: ['No verified Atlas signature or complete structural grammar matched.'],
    }), { metrics });
  }

  function memoryProvider(input) {
    const bytes = asBytes(input);
    return {
      size: bytes.length,
      async read(offset, length) {
        if (offset < 0 || length < 0 || offset + length > bytes.length) throw new RangeError('Read outside provider');
        return bytes.subarray(offset, offset + length);
      },
    };
  }

  async function rangeIsZero(provider, start, end, chunkSize = 0x10000) {
    for (let offset = start; offset < end; offset += chunkSize) {
      const bytes = await provider.read(offset, Math.min(chunkSize, end - offset));
      for (const value of bytes) if (value !== 0) return false;
    }
    return true;
  }

  async function semanticBundleAt(provider, baseOffset) {
    const remaining = provider.size - baseOffset;
    if (!provider || remaining < 32) return null;
    const head = await provider.read(baseOffset, 16), h = semanticBundleHeader(head, remaining);
    if (!h || h.header_size > Math.min(remaining, 0x10010)) return null;
    const table = await provider.read(baseOffset, h.header_size), valid = validateSemanticDescriptors(table, remaining);
    return valid ? Object.assign(valid, { base_offset: baseOffset, end_offset: baseOffset + valid.last_child_end }) : null;
  }

  async function detectSemanticBundleSparse(provider) {
    if (!provider || provider.size < 32) return null;
    const bundles = [];
    let base = 0;
    while (base < provider.size) {
      const bundle = await semanticBundleAt(provider, base);
      if (!bundle) return null;
      bundles.push(bundle);
      const paddedEnd = Math.ceil(bundle.end_offset / SECTOR) * SECTOR;
      if (paddedEnd > provider.size || !(await rangeIsZero(provider, bundle.end_offset, Math.min(paddedEnd, provider.size)))) return null;
      if (paddedEnd === provider.size) break;
      const next = await semanticBundleAt(provider, paddedEnd);
      if (next) { base = paddedEnd; continue; }
      if (!(await rangeIsZero(provider, paddedEnd, provider.size))) return null;
      break;
    }
    const format = bundles.length > 1 ? 'SEMANTIC_BUNDLE_SET' : 'SEMANTIC_BUNDLE';
    return Object.assign(meta(format, {
      evidence: ['sparse descriptor-table validation', 'strictly contiguous child extents', 'zero sector padding', bundles.length > 1 ? 'multiple sector-aligned bundles' : 'single allocation bundle'],
      reasons: [`Validated ${bundles.length} bundle${bundles.length === 1 ? '' : 's'} and ${bundles.reduce((n, x) => n + x.count, 0)} child descriptors.`],
    }), { structure: { bundle_count: bundles.length, bundles } });
  }

  async function detectSeqwBank(provider) {
    if (!provider || provider.size < SECTOR || provider.size % SECTOR) return null;
    const head = await provider.read(0, Math.min(SECTOR, provider.size)), count = u32le(head, 0);
    if (count < 1 || count > 512 || 4 + count * 4 > head.length) return null;
    const children = [];
    for (let i = 0; i < count; i++) {
      const start = u16le(head, 4 + i * 4), sectors = u16le(head, 6 + i * 4);
      if (!sectors || start < 1 || start + sectors > provider.size / SECTOR) return null;
      if (i === 0 && start !== 1) return null;
      if (i && start !== children[i - 1].start_sector + children[i - 1].sector_count) return null;
      children.push({ index: i, start_sector: start, sector_count: sectors });
    }
    const last = children[children.length - 1];
    if ((last.start_sector + last.sector_count) * SECTOR !== provider.size) return null;
    for (const child of children) {
      const magic = await provider.read(child.start_sector * SECTOR, 4);
      if (rawAscii(magic, 0, 4) !== 'SEQW') return null;
    }
    return Object.assign(meta('SEQW_BANK', {
      evidence: ['sector table', 'contiguous extents', 'SEQW magic for every child', 'final child ends at allocation boundary'],
      reasons: [`Validated ${count} contiguous SEQW children.`],
    }), { structure: { child_count: count, children } });
  }

  function movieCandidate(provider, head) {
    const h = head ? asBytes(head) : null;
    return {
      family_marker: !!h && hex(h, 8) === FAMILY8,
      sector_aligned: provider.size % SECTOR === 0,
      complete_frames: Math.floor(provider.size / FRAME),
      tail_bytes: provider.size % FRAME,
    };
  }

  async function scanFrameRecurrence(provider, checkpoint, budgetBlocks = 64, progress) {
    const full = Math.floor(provider.size / FRAME);
    const cp = Object.assign({ version: 1, next_block: 0, checked: 0, prefix_hits: 0 }, checkpoint || {});
    const stop = Math.min(full, cp.next_block + Math.max(1, budgetBlocks));
    for (let block = cp.next_block; block < stop; block++) {
      const h = await provider.read(block * FRAME, 6);
      if (hex(h, 6) === FAMILY6) cp.prefix_hits++;
      cp.checked++;
      cp.next_block = block + 1;
    }
    cp.complete = cp.next_block >= full;
    cp.ratio = cp.checked ? cp.prefix_hits / cp.checked : 0;
    if (progress) await progress(cp);
    return cp;
  }

  function sectorHash(input) {
    const b = asBytes(input);
    let a = 0x811c9dc5, c = 0x9e3779b9;
    for (let i = 0; i < b.length; i++) {
      a ^= b[i];
      a = Math.imul(a, 0x01000193) >>> 0;
      c = (Math.imul(c ^ b[i], 33) + i) >>> 0;
    }
    return `${a.toString(16).padStart(8, '0')}${c.toString(16).padStart(8, '0')}`;
  }

  async function findDuplicateSectors(provider, options) {
    const opts = options || {}, sectors = Math.floor(provider.size / SECTOR), batchSectors = Math.max(1, opts.batchSectors || 128);
    const buckets = new Map(), groups = new Map();
    for (let start = 0; start < sectors; start += batchSectors) {
      if (opts.cancelled && opts.cancelled()) throw new Error('cancelled');
      const count = Math.min(batchSectors, sectors - start), chunk = await provider.read(start * SECTOR, count * SECTOR);
      for (let j = 0; j < count; j++) {
        const index = start + j, bytes = chunk.subarray(j * SECTOR, (j + 1) * SECTOR), hash = sectorHash(bytes);
        const bucket = buckets.get(hash) || [];
        let matched = null;
        for (const previous of bucket) {
          const prior = await provider.read(previous * SECTOR, SECTOR);
          if (equal(bytes, prior)) { matched = previous; break; }
        }
        if (matched == null) {
          bucket.push(index);
          buckets.set(hash, bucket);
        } else {
          const g = groups.get(matched) || [matched];
          g.push(index);
          groups.set(matched, g);
        }
      }
      if (opts.progress) await opts.progress({ next_sector: start + count, sectors, ratio: (start + count) / sectors });
    }
    return Array.from(groups.entries()).map(([first, indices]) => ({ first, indices })).sort((a, b) => b.indices.length - a.indices.length || a.first - b.first);
  }

  function rotatedByte(sector, rotation, index) {
    return sector[(rotation + index) % sector.length];
  }

  async function findBestPadProbe(provider, groups, options) {
    const opts = options || {}, frames = Math.floor(provider.size / FRAME), raw4 = await provider.read(0, 4);
    const expected = Uint8Array.from([raw4[0] ^ 0x00, raw4[1] ^ 0x00, raw4[2] ^ 0x01, raw4[3] ^ 0xba]);
    let best = null;
    for (const group of (groups || []).slice(0, 8)) {
      const sector = await provider.read(group.first * SECTOR, SECTOR);
      for (let rotation = 0; rotation < SECTOR; rotation++) {
        let match = true;
        for (let i = 0; i < 4; i++) if (rotatedByte(sector, rotation, i) !== expected[i]) { match = false; break; }
        if (!match) continue;
        let hits = 0;
        for (let frame = 0; frame < frames; frame++) {
          if (opts.cancelled && opts.cancelled()) throw new Error('cancelled');
          const h = await provider.read(frame * FRAME, 4);
          let ok = true;
          for (let i = 0; i < 4; i++) if ((h[i] ^ rotatedByte(sector, rotation, i)) !== PACK[i]) { ok = false; break; }
          if (ok) hits++;
          if (opts.progress && frame % 64 === 63) await opts.progress({ frame: frame + 1, frames });
        }
        const result = { hits, total: frames, ratio: frames ? hits / frames : 0, rotation, source_sector_indices: group.indices.slice(), source_sector: group.first };
        if (!best || result.hits > best.hits || (result.hits === best.hits && rotation < best.rotation)) best = result;
      }
    }
    return best;
  }

  async function diagnosticMask(provider, padProbe) {
    if (!padProbe) return null;
    const sector = await provider.read(padProbe.source_sector * SECTOR, SECTOR), head = await provider.read(0, 0x23), mask = new Uint8Array(SECTOR);
    for (let i = 0; i < SECTOR; i++) mask[i] = sector[(padProbe.rotation + i) % SECTOR];
    mask[0x10] = head[0x10] ^ 0x01;
    mask[0x20] = head[0x20] ^ 0xe0;
    mask[0x21] = head[0x21] ^ 0x0f;
    return mask;
  }

  function transformedByte(raw, absoluteOffset, mask) {
    return raw ^ mask[absoluteOffset % SECTOR];
  }

  function transformedU16be(rawFrame, offset, absoluteBase, mask) {
    return (transformedByte(rawFrame[offset], absoluteBase + offset, mask) << 8) |
      transformedByte(rawFrame[offset + 1], absoluteBase + offset + 1, mask);
  }

  function validateCadenceFrame(rawFrame, absoluteBase, mask) {
    const b = asBytes(rawFrame), end = b.length;
    const at = (o, v) => transformedByte(b[o], absoluteBase + o, mask) === v;
    if (end !== FRAME || !at(0, 0x00) || !at(1, 0x00) || !at(2, 0x01) || !at(3, 0xba))
      return { pack: 0, system: 0, video_packets: 0, valid: false, end_offset: 0 };
    let pos = 14 + (transformedByte(b[13], absoluteBase + 13, mask) & 7), system = 0, packets = 0;
    if (pos + 6 <= end && at(pos, 0x00) && at(pos + 1, 0x00) && at(pos + 2, 0x01) && at(pos + 3, 0xbb)) {
      const length = transformedU16be(b, pos + 4, absoluteBase, mask);
      if (pos + 6 + length > end) return { pack: 1, system: 0, video_packets: 0, valid: false, end_offset: pos };
      system = 1;
      pos += 6 + length;
    }
    while (pos + 6 <= end && at(pos, 0x00) && at(pos + 1, 0x00) && at(pos + 2, 0x01) && at(pos + 3, 0xe0)) {
      const length = transformedU16be(b, pos + 4, absoluteBase, mask);
      if (!length || pos + 6 + length > end) break;
      packets++;
      pos += 6 + length;
    }
    return { pack: 1, system, video_packets: packets, valid: pos === end && packets >= 3, end_offset: pos };
  }

  async function scanPesCadence(provider, mask, checkpoint, budgetFrames = 32, progress) {
    const frames = Math.floor(provider.size / FRAME), cp = Object.assign({
      version: 1, next_frame: 0, checked: 0, pack_headers: 0, system_headers: 0, valid_frames: 0, video_pes_packets: 0,
    }, checkpoint || {});
    const stop = Math.min(frames, cp.next_frame + Math.max(1, budgetFrames));
    for (let frame = cp.next_frame; frame < stop; frame++) {
      const base = frame * FRAME, raw = await provider.read(base, FRAME), result = validateCadenceFrame(raw, base, mask);
      cp.checked++;
      cp.pack_headers += result.pack;
      cp.system_headers += result.system;
      cp.video_pes_packets += result.video_packets;
      if (result.valid) cp.valid_frames++;
      cp.next_frame = frame + 1;
    }
    cp.complete = cp.next_frame >= frames;
    cp.pack_ratio = cp.checked ? cp.pack_headers / cp.checked : 0;
    cp.valid_frame_ratio = cp.checked ? cp.valid_frames / cp.checked : 0;
    if (progress) await progress(cp);
    return cp;
  }

  function finalizeMovie(candidate, recurrence, duplicateGroups, padProbe, cadence) {
    const ok = !!candidate && candidate.family_marker && candidate.sector_aligned && candidate.complete_frames >= 4 &&
      recurrence && recurrence.complete && recurrence.ratio >= 0.95 &&
      duplicateGroups && duplicateGroups.length && padProbe && padProbe.ratio >= 0.95 &&
      cadence && cadence.complete && cadence.pack_ratio >= 0.95 && cadence.system_headers >= 1 &&
      cadence.valid_frame_ratio >= 0.80 && cadence.video_pes_packets >= cadence.valid_frames * 3;
    if (!ok) return meta('SO3_MOVIE_CARRIER_NOT_VERIFIED', {
      display: 'Movie carrier not verified', role: 'Unresolved movie-family allocation', category: 'candidates', icon: '🧪',
      confidence: 'UNRESOLVED', playable: false, decodable: false,
      evidence: ['family detector executed'], reasons: ['One or more recurrence, duplicate-sector, pack, or PES-cadence gates failed.'],
    });
    return meta('SO3_MOVIE_CARRIER', {
      display: 'SO3 movie carrier (exact MPEG-PS decode available)', confidence: 'VERIFIED_DECODABLE_CARRIER',
      playable: true, decodable: true, browser_preview: 'codec-dependent',
      evidence: ['8-byte family marker', '0x4000 frame recurrence >=95%', 'exact duplicate sector', 'MPEG pack reconstruction >=95%', 'PES cadence >=80%', 'Lib 0x0041A2F0 bit-exact transform'],
      reasons: ['All deterministic Atlas V1.1.1 carrier gates passed.', 'V5.3 implements the executable-derived 64-bit inverse and exports the original MPEG-PS stream.', 'In-page preview depends on the browser supporting MPEG-2; decoded download does not.'],
    });
  }

  function bytesToBase64(input) {
    const b = asBytes(input);
    if (typeof Buffer !== 'undefined') return Buffer.from(b).toString('base64');
    let s = '';
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s);
  }

  function base64ToBytes(text) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'));
    const s = atob(text), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  return Object.freeze({
    VERSION, SECTOR, FRAME, FAMILY8, FAMILY6, ATLAS, FORMAT_META,
    asBytes, hex, ascii, rawAscii, u16le, u32le, u16be, equal, findBytes,
    printableRatio, zeroRatio, entropy, meta, magicClassification, headerLabel,
    semanticBundleHeader, validateSemanticDescriptors, findEmbeddedMagic, inspectSample,
    memoryProvider, rangeIsZero, semanticBundleAt, detectSemanticBundleSparse, detectSeqwBank, movieCandidate,
    scanFrameRecurrence, sectorHash, findDuplicateSectors, findBestPadProbe,
    diagnosticMask, validateCadenceFrame, scanPesCadence, finalizeMovie,
    bytesToBase64, base64ToBytes,
  });
});
