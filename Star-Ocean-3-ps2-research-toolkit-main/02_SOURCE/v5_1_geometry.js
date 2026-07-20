/* SO3 Resource Explorer V5.1 geometry/animation core.
 * Browser/Node port of the verified parsers in SO3_VIF_VU1_FAS_FORMAT_PASS_V1.
 * No matrix-address -> RTA-node mapping is inferred here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SO3V51Geometry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '5.11.0';
  const KNOWN = Object.freeze({
    'FPS\0': 'FPS', IDOM: 'MODI', DNAL: 'LAND', TGIL: 'LIGT', 'FSS\0': 'SSF',
    XBDC: 'XBDC', PCDC: 'PCDC', LPDC: 'LPDC', NDNC: 'NDNC', RMAC: 'RMAC',
    LCTP: 'LCTP', 'FIS\0': 'FIS', FISA: 'FISA'
  });
  const CORPUS_TOTALS = Object.freeze({
    resources: 13, segments: 219, packets: 3540, vertices: 110599, triangles: 65365,
    stripChecks: 3540, stripChecksTotal: 3540, aabbInside: 77554, aabbDecoded: 77592,
    unitNormals: 79689, decodedNormals: 79689, saneUvs: 102646, decodedUvs: 102646,
    matrixAddressVertices: 21104
  });
  const asU8 = x => x instanceof Uint8Array ? x : new Uint8Array(x);
  const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const bounds = (b, o, n, what) => { if (o < 0 || n < 0 || o + n > b.length) throw new Error(`${what || 'read'} outside data at 0x${o.toString(16)}`); };
  const u16 = (d, o) => d.getUint16(o, true), i16 = (d, o) => d.getInt16(o, true), u32 = (d, o) => d.getUint32(o, true), f32 = (d, o) => d.getFloat32(o, true);
  function ascii(b, o, n) { bounds(b, o, n, 'ASCII'); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]); return s; }
  const hx = n => `0x${Number(n).toString(16).toUpperCase()}`;

  function walkChain(input) {
    const b = asU8(input), d = view(b), blocks = [], seen = new Set(); let off = 0;
    while (off + 0x10 <= b.length) {
      if (seen.has(off)) { blocks.push({ off, type: 'UNKNOWN', error: 'chain cycle before terminator' }); break; }
      seen.add(off);
      const magic = ascii(b, off, 4), type = KNOWN[magic];
      if (!type) { blocks.push({ off, magic: Array.from(b.subarray(off, off + 4), x => x.toString(16).padStart(2, '0')).join(''), type: 'UNKNOWN', error: 'unknown magic' }); break; }
      const endRel = u32(d, off + 4), selfAbs = u32(d, off + 8), nextRel = u32(d, off + 12), end = off + endRel, next = off + nextRel;
      const block = { off, magic, type, end, next, size: endRel, selfAbs, selfOk: selfAbs === off, boundaryOk: end >= off + 0x10 && end <= b.length };
      blocks.push(block);
      if (type === 'SSF' || next === off) { block.terminator = true; break; }
      if (next <= off || next > b.length - 4) { block.error = 'next out of range'; break; }
      off = next;
    }
    const last = blocks[blocks.length - 1];
    return { blocks, count: blocks.length, fullCoverage: !!(last && last.terminator && last.end >= b.length - 16), fileSize: b.length, unresolvedBlocks: blocks.filter(x => x.type === 'UNKNOWN' || x.error).length };
  }

  const VN = ['S', 'V2', 'V3', 'V4'], VL = [32, 16, 8, 5];
  function unpackDataWords(num, vn, vl, cl, wl) {
    num = num || 256;
    const bitsPerVector = vl === 3 ? 16 : (32 >> vl) * (vn + 1);
    let vectors;
    if (wl <= cl || (cl === 0 && wl === 0)) vectors = num;
    else vectors = Math.floor(num / wl) * cl + Math.min(num % wl, cl);
    return { words: Math.ceil(vectors * bitsPerVector / 32), vectors };
  }
  function parseVifStream(input, start, end, tolerant) {
    const b = asU8(input), d = view(b); end = end == null ? b.length : end;
    let p = start || 0; const events = [], st = { cl: 0, wl: 0, mask: null, row: null, col: null, itop: null, base: null, ofst: null, mode: 0 };
    const need = (n, label) => { if (p + n > end) throw new Error(`${label} truncated at ${hx(p)}`); };
    while (p + 4 <= end) {
      const here = p, w = u32(d, p); p += 4;
      const cmd = (w >>> 24) & 0x7f, irq = w >>> 31, numRaw = (w >>> 16) & 0xff, imm = w & 0xffff;
      let e = { off: here, irq };
      try {
        if (cmd === 0x00) e.op = 'NOP';
        else if (cmd === 0x01) { st.cl = imm & 0xff; st.wl = (imm >>> 8) & 0xff; Object.assign(e, { op: 'STCYCL', cl: st.cl, wl: st.wl }); }
        else if (cmd === 0x02) { st.ofst = imm & 0x3ff; Object.assign(e, { op: 'OFFSET', offset: st.ofst }); }
        else if (cmd === 0x03) { st.base = imm & 0x3ff; Object.assign(e, { op: 'BASE', base: st.base }); }
        else if (cmd === 0x04) { st.itop = imm & 0x3ff; Object.assign(e, { op: 'ITOP', itops: st.itop }); }
        else if (cmd === 0x05) { st.mode = imm & 3; Object.assign(e, { op: 'STMOD', mode: st.mode }); }
        else if (cmd === 0x06) Object.assign(e, { op: 'MSKPATH3', mask: imm });
        else if (cmd === 0x07) Object.assign(e, { op: 'MARK', mark: imm });
        else if (cmd === 0x10) e.op = 'FLUSHE';
        else if (cmd === 0x11) e.op = 'FLUSH';
        else if (cmd === 0x13) e.op = 'FLUSHA';
        else if (cmd === 0x14) Object.assign(e, { op: 'MSCAL', execAddr: imm });
        else if (cmd === 0x15) Object.assign(e, { op: 'MSCALF', execAddr: imm });
        else if (cmd === 0x17) e.op = 'MSCNT';
        else if (cmd === 0x20) { need(4, 'STMASK'); st.mask = u32(d, p); Object.assign(e, { op: 'STMASK', mask: st.mask }); p += 4; }
        else if (cmd === 0x30 || cmd === 0x31) { need(16, cmd === 0x30 ? 'STROW' : 'STCOL'); const a = [0, 1, 2, 3].map(i => u32(d, p + 4 * i)); if (cmd === 0x30) st.row = a; else st.col = a; Object.assign(e, { op: cmd === 0x30 ? 'STROW' : 'STCOL', [cmd === 0x30 ? 'row' : 'col']: a }); p += 16; }
        else if (cmd === 0x4a) { const n = numRaw || 256; need(n * 8, 'MPG'); Object.assign(e, { op: 'MPG', loadAddr: imm, num: n, dataOff: p, dataLen: n * 8 }); p += n * 8; }
        else if (cmd === 0x50 || cmd === 0x51) { const qwc = imm || 65536; need(qwc * 16, 'DIRECT'); Object.assign(e, { op: cmd === 0x50 ? 'DIRECT' : 'DIRECTHL', qwc, dataOff: p, dataLen: qwc * 16 }); p += qwc * 16; }
        else if ((cmd & 0x60) === 0x60) {
          const vn = (cmd >>> 2) & 3, vl = cmd & 3, m = (cmd >>> 4) & 1, num = numRaw || 256, size = unpackDataWords(num, vn, vl, st.cl, st.wl);
          need(size.words * 4, 'UNPACK'); Object.assign(e, { op: 'UNPACK', fmt: `${VN[vn]}-${VL[vl]}`, vn, vl, m, num, flg: imm >>> 15, usn: (imm >>> 14) & 1, addr: imm & 0x3ff, cl: st.cl, wl: st.wl, dataOff: p, dataWords: size.words, vectorsFromStream: size.vectors }); p += size.words * 4;
        } else {
          const error = `desync cmd 0x${cmd.toString(16).padStart(2, '0')} word 0x${w.toString(16).padStart(8, '0')}`;
          if (tolerant) return { events, end: here, error };
          throw new Error(`${error} at ${hx(here)}`);
        }
        events.push(e);
      } catch (error) { if (tolerant) return { events, end: here, error: error.message }; throw error; }
    }
    return { events, end: p, error: null };
  }

  function scanTextureSections(b, start, end) {
    const d = view(b), sections = [];
    for (let p = (start + 15) & ~15; p + 8 <= end; p += 16) {
      const word = u32(d, p);
      if (word !== 0x00534946 && word !== 0x41534946) continue;
      const storedSize = u32(d, p + 4), magic = ascii(b, p, 4), size = storedSize + 0x10;
      const minimum = magic === 'FISA' ? 0x18 : 0x70;
      if (size < minimum || p + size > end) continue;
      sections.push({ off: p, magic, size, storedSize, boundaryOk: true, discovery: 'ALIGNED_SECTION_SCAN' });
      p = ((p + size + 15) & ~15) - 16;
    }
    return sections;
  }

  function parseSegment(b, off, end) {
    const d = view(b); bounds(b, off, 0x60, 'FPS segment header');
    const segment = { off, end, radius: f32(d, off + 0x1c), bbmin: [0, 1, 2].map(i => f32(d, off + 0x2c + i * 4)), bbmax: [0, 1, 2].map(i => f32(d, off + 0x38 + i * 4)), packets: [], fis: scanTextureSections(b, off + 0x60, end), notes: [] };
    let p = off + 0x60;
    while (p < end - 4) {
      const word = u32(d, p);
      if (word === 0x00534946 || word === 0x41534946) {
        if (p + 8 > end) break; const storedSize = u32(d, p + 4), magic = ascii(b, p, 4), size = storedSize + 0x10;
        if (!size) { segment.notes.push(`zero-size texture section at ${hx(p)}`); break; }
        p = (p + size + 15) & ~15; continue;
      }
      const parsed = parseVifStream(b, p, end, true); let current = null;
      for (const e of parsed.events) {
        if (e.op === 'UNPACK' && e.fmt === 'V4-16' && e.addr === 0 && e.num === 7) {
          if (current) segment.packets.push(current);
          current = { events: [], off: e.off };
        }
        if (current) current.events.push(e);
      }
      if (current) segment.packets.push(current);
      if (parsed.error) {
        let found = -1;
        for (let q = parsed.end; q < end - 4; q += 4) { const x = u32(d, q); if (x === 0x00534946 || x === 0x41534946) { found = q; break; } }
        if (found >= 0) { segment.notes.push(`gap ${hx(parsed.end)}..${hx(found)} (${parsed.error})`); p = found; continue; }
        segment.notes.push(`stop at ${hx(parsed.end)}: ${parsed.error}`); break;
      }
      p = parsed.end; if (p >= end - 4) break;
    }
    return segment;
  }
  function decodePacket(b, packet) {
    const d = view(b), out = { off: packet.off, events: packet.events }; let base = null;
    for (const e of packet.events) {
      if (e.op !== 'UNPACK') continue;
      if (e.fmt === 'V4-16' && e.addr === 0 && e.num === 7) {
        const h = []; for (let i = 0; i < 28; i++) h.push(u16(d, e.dataOff + i * 2));
        Object.assign(out, { header: h, vertbase: h[1], stripcnt: h[2], striptab: h[3], vertcount: h[9] }); base = h[1];
      } else if (e.fmt === 'V4-32' && e.addr === 7) out.materialOff = e.dataOff;
      else if (e.fmt === 'S-8' && base != null && e.addr === out.striptab) out.strips = Array.from(b.subarray(e.dataOff, e.dataOff + e.num));
      else if (base != null && e.addr != null && e.cl === 4 && e.wl === 1) { const slot = e.addr - base; if (slot >= 0 && slot < 4) (out.attr || (out.attr = {}))[slot] = e; }
    }
    return out;
  }
  function extractVertices(b, p) {
    const d = view(b), n = p.vertcount || 0, a = p.attr || {}, out = { pos: [], nrm: [], uv: [], rgba: [], mtxaddr: [], profile: 'UNKNOWN' };
    if (a[3]) {
      const e = a[3], m = Math.min(n, e.num);
      if (e.fmt === 'V3-32') { out.profile = 'FLOAT'; for (let i = 0; i < m; i++) out.pos.push([f32(d, e.dataOff + i * 12), f32(d, e.dataOff + i * 12 + 4), f32(d, e.dataOff + i * 12 + 8)]); }
      else if (e.fmt === 'V4-16') { out.profile = 'FIXED'; for (let i = 0; i < m; i++) { const o = e.dataOff + i * 8; out.pos.push([i16(d, o) / 16, i16(d, o + 2) / 16, i16(d, o + 4) / 16]); out.mtxaddr.push(i16(d, o + 6)); } }
    }
    if (a[0] && !a[0].m) {
      const e = a[0], m = Math.min(n, e.num);
      if (e.fmt === 'V3-32') for (let i = 0; i < m; i++) out.nrm.push([f32(d, e.dataOff + i * 12), f32(d, e.dataOff + i * 12 + 4), f32(d, e.dataOff + i * 12 + 8)]);
      else if (e.fmt === 'V3-16') for (let i = 0; i < m; i++) { const o = e.dataOff + i * 6; out.nrm.push([i16(d, o) / 4096, i16(d, o + 2) / 4096, i16(d, o + 4) / 4096]); }
    }
    if (a[1] && a[1].fmt === 'V2-16') for (let i = 0, m = Math.min(n, a[1].num); i < m; i++) { const o = a[1].dataOff + i * 4; out.uv.push([i16(d, o) / 4096, i16(d, o + 2) / 4096]); }
    if (a[2]) for (let i = 0, m = Math.min(n, a[2].num); i < m; i++) out.rgba.push(b[a[2].dataOff + i]);
    return out;
  }
  function stripsToTriangles(strips, base) {
    const triangles = []; let v = base || 0;
    for (const s of strips || []) { for (let i = 0; i < s - 2; i++) triangles.push(i & 1 ? [v + i, v + i + 2, v + i + 1] : [v + i, v + i + 1, v + i + 2]); v += s; }
    return triangles;
  }
  function parseGeometry(input) {
    const b = asU8(input), chain = walkChain(b), segments = [], packets = [], vertices = [], triangles = [], textures = []; let declaredVertices = 0, declaredTriangles = 0;
    for (const block of chain.blocks) if (block.type === 'FPS' && block.boundaryOk) {
      const segment = parseSegment(b, block.off, block.end), si = segments.length; segments.push(segment);
      for (const f of segment.fis) textures.push({ ...f, segment: si });
      for (const raw of segment.packets) {
        const p = decodePacket(b, raw), pi = packets.length, v = extractVertices(b, p), base = vertices.length;
        p.segment = si; p.packet = pi; p.profile = v.profile; p.vertexStart = base; p.vertexCountDecoded = v.pos.length;
        const localTriangles = stripsToTriangles(p.strips || [], 0); declaredVertices += p.vertcount || 0; declaredTriangles += localTriangles.length; p.triangleStart = triangles.length; p.triangleCountDeclared = localTriangles.length;
        for (let i = 0; i < v.pos.length; i++) vertices.push({ position: v.pos[i], normal: v.nrm[i] || [0, 0, 0], uv: v.uv[i] || [0, 0], rgba: v.rgba[i] == null ? 255 : v.rgba[i], matrixAddress: v.mtxaddr[i] == null ? null : v.mtxaddr[i], segment: si, packet: pi, profile: v.profile });
        for (const t of localTriangles) if (t.every(x => x < v.pos.length)) triangles.push(t.map(x => x + base));
        p.triangleCountRendered = triangles.length - p.triangleStart;
        p.stripSumOk = (p.strips || []).reduce((a, x) => a + x, 0) === (p.vertcount || 0); packets.push(p);
      }
    }
    const profiles = Array.from(new Set(packets.map(x => x.profile).filter(x => x !== 'UNKNOWN')));
    return { version: VERSION, bytes: b, chain, segments, packets, vertices, triangles, declaredVertices, declaredTriangles, textures, profiles, fixedProfile: profiles.includes('FIXED'), limitations: profiles.includes('FIXED') ? ['FIXED geometry is packet-local/unposed. Matrix addresses are not mapped to RTA nodes.'] : [] };
  }

  function meshSelection(model, segment, packet) {
    const vertices = [], triangles = [], map = new Map();
    const acceptV = v => (segment == null || segment < 0 || v.segment === segment) && (packet == null || packet < 0 || v.packet === packet);
    model.vertices.forEach((v, i) => { if (acceptV(v)) { map.set(i, vertices.length); vertices.push(v); } });
    for (const t of model.triangles) if (map.has(t[0]) && map.has(t[1]) && map.has(t[2])) triangles.push(t.map(i => map.get(i)));
    return { vertices, triangles };
  }
  function exportObj(model, options) {
    options = options || {}; const selected = meshSelection(model, options.segment, options.packet), lines = ['# SO3 Resource Explorer V5.1 validated rigid geometry', '# FIXED profiles are exported only when explicitly allowed'];
    if (selected.vertices.some(v => v.profile === 'FIXED') && !options.allowFixed) throw new Error('OBJ export is limited to validated rigid FLOAT geometry; FIXED geometry is unposed');
    for (const v of selected.vertices) lines.push(`v ${v.position.map(x => Number(x).toPrecision(9)).join(' ')}`);
    for (const v of selected.vertices) lines.push(`vt ${v.uv.map(x => Number(x).toPrecision(9)).join(' ')}`);
    for (const v of selected.vertices) lines.push(`vn ${v.normal.map(x => Number(x).toPrecision(9)).join(' ')}`);
    for (const t of selected.triangles) lines.push(`f ${t.map(i => { const n = i + 1; return `${n}/${n}/${n}`; }).join(' ')}`);
    return lines.join('\n') + '\n';
  }
  function reparseObj(text) {
    const counts = { vertices: 0, uvs: 0, normals: 0, faces: 0 }; const errors = [];
    for (const line of String(text).split(/\r?\n/)) {
      if (line.startsWith('v ')) counts.vertices++;
      else if (line.startsWith('vt ')) counts.uvs++;
      else if (line.startsWith('vn ')) counts.normals++;
      else if (line.startsWith('f ')) { counts.faces++; const parts = line.trim().split(/\s+/).slice(1); if (parts.length !== 3 || parts.some(x => !/^\d+\/\d+\/\d+$/.test(x))) errors.push(`invalid face ${line}`); }
    }
    return { ...counts, errors, valid: !errors.length && counts.vertices === counts.uvs && counts.vertices === counts.normals };
  }

  function decodeText(raw) {
    if (typeof TextDecoder !== 'undefined') { try { return new TextDecoder('shift-jis').decode(raw); } catch (_) { return new TextDecoder().decode(raw); } }
    return Array.from(raw, x => String.fromCharCode(x)).join('');
  }
  function parseRta(input) {
    const b = asU8(input), d = view(b); bounds(b, 0, 0x40, 'RTA header'); if (ascii(b, 0, 4) !== 'RTA\0') throw new Error('Not RTA');
    const size = u32(d, 4), nodeCount = u16(d, 0x12), off1 = u32(d, 0x18), off2 = u32(d, 0x1c); if (0x40 + nodeCount * 0x20 > b.length) throw new Error('RTA node array exceeds data');
    const nodes = [];
    for (let i = 0; i < nodeCount; i++) { const o = 0x40 + i * 0x20, parentRaw = u16(d, o + 0x0e); nodes.push({ record: i, index: i16(d, o + 0x0c), parent: parentRaw === 0xffff ? -1 : i16(d, o + 0x0e), translation: [f32(d, o + 0x10), f32(d, o + 0x14), f32(d, o + 0x18)], name: null }); }
    /* The verified off1 V2 name block starts at off1 + one lead qword. Each
       node then owns a fixed 0x14-byte record: one unresolved f32 scalar and
       one 16-byte CP932 name field. A 16-byte name is not NUL-terminated, so
       scanning for C strings incorrectly merges it with the next scalar. */
    const names = [], nameRecords = [], namesAt = off1 + 16;
    if (namesAt + nodeCount * 0x14 <= b.length) {
      for (let i = 0; i < nodeCount; i++) {
        const rec = namesAt + i * 0x14, field = b.subarray(rec + 4, rec + 0x14);
        let cut = field.indexOf(0); if (cut < 0) cut = field.length;
        const name = decodeText(field.subarray(0, cut)).trim();
        names.push(name || `node_${nodes[i].index}`);
        nameRecords.push({ off: rec, scalar: f32(d, rec), name: names[i] });
      }
    }
    nodes.forEach((n, i) => n.name = names[i] || `node_${n.index}`);
    nodes.forEach((n, i) => n.nameScalar = nameRecords[i] ? nameRecords[i].scalar : null);
    return { magic: 'RTA', size, nodeCount, off1, off2, nodes, names, nameRecords, confidence: { hierarchy: 'VERIFIED', names: names.length === nodeCount ? 'VERIFIED' : 'STRUCTURAL', nameScalar: 'UNRESOLVED', attachments: 'INFERENCE' } };
  }

  function parseFas(input) {
    const b = asU8(input), d = view(b); bounds(b, 0, 0x20, 'FAS header'); const magic = ascii(b, 0, 4); if (magic !== 'FAS\0' && magic !== 'HFAS') throw new Error('Not FAS/HFAS');
    const end = u32(d, 4), next = u32(d, 12), rootName = ascii(b, 0x10, 16).split('\0')[0], out = { magic: magic.replace('\0', ''), end, next, root: rootName, channels: [] }; if (magic === 'HFAS') return out;
    const clipC = u16(d, 0x26); out.clipC = clipC; let pos = 0x20;
    const isH1 = p => p + 8 <= Math.min(end, b.length) && u16(d, p + 2) === 0 && u16(d, p + 6) === clipC && (u16(d, p) === 3 || u16(d, p) === 0x103) && u16(d, p + 4) >= 1 && u16(d, p + 4) <= 8;
    while (pos + 0x20 <= Math.min(end, b.length) && isH1(pos)) {
      const cls = u16(d, pos), nsec = u16(d, pos + 4), id = u32(d, pos + 8), idx = u32(d, pos + 12), mode = u16(d, pos + 20), nkeys = u16(d, pos + 22), secsize = u32(d, pos + 24), flag = u32(d, pos + 28), keys = [];
      let kb = pos + 0x20; bounds(b, kb, nkeys * 48, 'FAS keys');
      for (let k = 0; k < nkeys; k++) { const o = kb + k * 48; keys.push({ T: [f32(d, o), f32(d, o + 4), f32(d, o + 8)], time: f32(d, o + 12), q1: [0, 1, 2, 3].map(i => f32(d, o + 16 + 4 * i)), q2: [0, 1, 2, 3].map(i => f32(d, o + 32 + 4 * i)) }); }
      let pp = pos + 0x10 + secsize; const subs = [];
      for (let s = 0; s < nsec - 1; s++) {
        bounds(b, pp, 16, 'FAS subsection'); const mark = u16(d, pp + 2), type = u16(d, pp + 4), count = u16(d, pp + 6), size = u32(d, pp + 8), aux = u32(d, pp + 12); if (size < 16 || pp + size > b.length) throw new Error('Invalid FAS subsection size');
        const sub = { mark, type, count, size, aux };
        if (type === 3 && size >= 48) { sub.vector = [0, 1, 2, 3].map(i => f32(d, pp + 16 + 4 * i)); sub.restQuaternion = [0, 1, 2, 3].map(i => f32(d, pp + 32 + 4 * i)); }
        else if (type === 0x135) { sub.quantized = []; for (let i = 0; i < count && pp + 16 + i * 8 + 8 <= pp + size; i++) { const o = pp + 16 + i * 8; sub.quantized.push({ xyz: [i16(d, o), i16(d, o + 2), i16(d, o + 4)], time: u16(d, o + 6) }); } }
        else if (type === 0x21) { let z = pp + 16; while (z < pp + size && b[z]) z++; sub.eventTag = decodeText(b.subarray(pp + 16, z)).replace(/[^\x20-\x7e]/g, ''); }
        subs.push(sub); pp += size;
      }
      let slot = 16; if (!(isH1(pp + 16) || pp + 16 >= end)) { if (isH1(pp + 32) || pp + 32 >= end) slot = 32; else { let nul = b.subarray(pp, Math.min(pp + 48, b.length)).indexOf(0); slot = nul >= 0 ? (Math.floor(nul / 16) + 1) * 16 : 16; } }
      const raw = b.subarray(pp, Math.min(pp + slot, b.length)); let cut = raw.indexOf(0); const name = decodeText(cut >= 0 ? raw.subarray(0, cut) : raw).trim();
      out.channels.push({ off: pos, cls, nsec, id, idx, mode, nkeys, flag, keys, subs, name, timestampsMonotonic: keys.every((k, i) => !i || k.time >= keys[i - 1].time) }); pos = pp + slot;
    }
    out.tailOff = pos; return out;
  }
  function bindFasToRta(fas, rta) {
    const byName = new Map(rta.nodes.map(n => [n.name, n]));
    const channels = fas.channels.map(c => ({ channel: c, node: byName.get(c.name) || null, binding: byName.has(c.name) ? 'VERIFIED_NAME' : 'UNMATCHED' }));
    return {
      root: fas.root, channels, matched: channels.filter(x => x.node).length, total: channels.length,
      verified_execution: ['type-0x0135 key selection clock', 'type-0x0135 signed xyz VITOF15 decompression', 'type-0x0135 positive-root quaternion w reconstruction', 'type-0x0135 between-key interpolation through original 0x004CD310/0x004CCF80/0x004CD230 helpers and embedded VU0 entries 0x13D/0x143/0x14F', 'concrete target-node quaternion setter 0x003EEF10', 'runtime local/world matrix writer 0x004DA820 and controlled parent composition through VU0 entry 0x15D'],
      partial_execution: ['browser preview does not yet apply execution-verified node matrices to FIXED/XBDC packet vertices'],
      unresolved: ['type-0x0003 q1/q2 exact role', 'original RTA translation loader into runtime node objects', 'matrix-to-packet binding and final skinning'],
    };
  }
  function matrixAddressStats(model) {
    const counts = new Map(); for (const v of model.vertices) if (v.matrixAddress != null) counts.set(v.matrixAddress, (counts.get(v.matrixAddress) || 0) + 1);
    return Array.from(counts, ([address, count]) => ({ address, count, paletteIndexCandidate: address >= 656 && !(address - 656 & 3) ? (address - 656) / 4 : null, mappingStatus: 'UNPROVEN' })).sort((a, b) => a.address - b.address);
  }
  function validateModel(model) {
    return { segments: model.segments.length, packets: model.packets.length, vertices: model.declaredVertices, decodedPositions: model.vertices.length, triangles: model.declaredTriangles, renderableTriangles: model.triangles.length, stripOk: model.packets.filter(x => x.stripSumOk).length, stripTotal: model.packets.length, fixedVertices: model.vertices.filter(x => x.matrixAddress != null).length, fullCoverage: model.chain.fullCoverage, unresolvedBlocks: model.chain.unresolvedBlocks };
  }
  return Object.freeze({ VERSION, CORPUS_TOTALS, walkChain, parseVifStream, scanTextureSections, parseGeometry, meshSelection, stripsToTriangles, exportObj, reparseObj, parseRta, parseFas, bindFasToRta, matrixAddressStats, validateModel });
});
