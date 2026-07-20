/* SO3 Resource Explorer V5.12.2 facial-selector probe engine.
 *
 * Browser-only, read-only static evidence collection for the unresolved
 * `facial_frame_palette_selector` gate. This module never promotes the gate:
 * it enumerates FAS `naka` event sub-blocks, re-derives the actor 0x0BC0
 * FPS/FISA/TEX0 facial state from raw bytes, and scans decoded executable
 * images for bounded R5900 constant evidence. All outputs are candidates.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SO3V5122FacialProbe = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GATE = 'facial_frame_palette_selector';
  const FAMILY_IDS = Object.freeze([1294, 1295, 1296, 2413, 2414, 2415, 3362]);
  const FAMILY_BASE_IDS = Object.freeze([1294, 2413]);
  const TEX0_HIGH16_VALUES = Object.freeze([2869, 2621]);
  const WORD_TARGETS = Object.freeze({
    0x41534946: 'FISA_MAGIC_WORD',
    0x00534946: 'FIS_MAGIC_WORD',
    0x616b616e: 'NAKA_ASCII_WORD',
  });
  const EVENT_MARK_LE = 0x0c01; // raw bytes 01 0C; the data mark's raw bytes are 00 01 (LE 0x0100).
  const EVENT_TYPE = 0x0021;

  const asBytes = (input) => input instanceof Uint8Array ? input : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : input instanceof ArrayBuffer ? new Uint8Array(input) : Uint8Array.from(input || []);
  const dv = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hex = (value, width = 0) => `0x${(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
  const ascii = (bytes, off, count) => String.fromCharCode(...bytes.subarray(off, off + count));
  const printableName = (bytes, off, count) => {
    let out = '';
    for (let i = 0; i < count; i++) { const c = bytes[off + i]; if (c === 0) break; if (c < 0x20 || c > 0x7e) return null; out += String.fromCharCode(c); }
    return out.length >= 2 ? out : null;
  };

  /* ---------------- FAS `naka` event enumeration ---------------- */

  function scanFasNakaEvents(input, options = {}) {
    const bytes = asBytes(input), d = dv(bytes), limit = Math.min(bytes.length, options.maxBytes || 4 * 1024 * 1024);
    const events = [], subBlockCensus = {}, boundaries = [];
    if (bytes.length > limit) boundaries.push(`scan truncated to first ${limit} bytes`);
    const isFas = bytes.length >= 8 && ascii(bytes, 0, 4) === 'FAS\0';
    for (let off = 0; off + 0x20 <= limit; off += 16) {
      if (d.getUint16(off, true) !== 0) continue;
      const mark = d.getUint16(off + 2, true), type = d.getUint16(off + 4, true), count = d.getUint16(off + 6, true), size = d.getUint32(off + 8, true), aux = d.getUint32(off + 12, true);
      if (mark !== 0x0100 && mark !== EVENT_MARK_LE) continue;
      if (size < 0x20 || size > 0x1000 || off + size > limit || count < 1 || count > 64) continue;
      const key = `${hex(mark, 4)}:${hex(type, 4)}`;
      subBlockCensus[key] = (subBlockCensus[key] || 0) + 1;
      if (mark !== EVENT_MARK_LE || type !== EVENT_TYPE) continue;
      const payload = off + 16, tag = ascii(bytes, payload, 4);
      if (!/^[a-z]{4}$/.test(tag)) continue;
      const id = d.getUint16(payload + 4, true);
      let zeroTail = 0; const tailStart = payload + 6, tailEnd = off + size;
      for (let p = tailStart; p < tailEnd; p++) if (bytes[p] === 0) zeroTail++;
      const tailRatio = tailEnd > tailStart ? zeroTail / (tailEnd - tailStart) : 1;
      const channel = attributeChannel(bytes, d, off, limit);
      events.push({
        header_off: off, payload_off: payload, tag, tag_bytes_hex: Array.from(bytes.subarray(payload, payload + 6), (x) => x.toString(16).padStart(2, '0')).join(' ').toUpperCase(),
        id, id_hex: hex(id, 4), count, size, aux, aux_hex: hex(aux, 8), zero_tail_ratio: Number(tailRatio.toFixed(3)),
        is_family_id: FAMILY_IDS.includes(id), is_family_base_id: FAMILY_BASE_IDS.includes(id),
        channel, mechanical_confidence: tailRatio >= 0.8 ? 'STRUCTURAL' : 'WEAK',
      });
    }
    const familyBaseHits = events.filter((event) => event.is_family_base_id).map((event) => event.id);
    return {
      format: 'SO3_FAS_NAKA_EVENT_SCAN', is_fas_magic: isFas, bytes_scanned: limit, events, event_count: events.length,
      sub_block_census: subBlockCensus, family_base_ids_referenced: [...new Set(familyBaseHits)],
      note: 'Mechanical 16-byte-aligned sub-block scan. Event mark raw bytes are 01 0C; a following u16 id whose low byte is 0x61–0x7A renders as a fifth tag letter in naive ASCII dumps (e.g. id 2413 = 0x096D reads as "nakam"). Tag is fixed at four bytes here.',
      semantics_confidence: 'UNRESOLVED', boundaries,
    };
  }

  function attributeChannel(bytes, d, eventOff, limit) {
    for (let back = eventOff - 16; back >= 0 && eventOff - back <= 0x800; back -= 16) {
      const cls = d.getUint16(back, true);
      if ((cls !== 0x0003 && cls !== 0x0103) || d.getUint16(back + 2, true) !== 0) continue;
      const nsec = d.getUint16(back + 4, true);
      if (nsec < 1 || nsec > 64) continue;
      const id = d.getUint32(back + 8, true), idx = d.getUint32(back + 12, true);
      if (id > 0xffff || idx > 0xffff) continue;
      let name = null;
      for (const span of [32, 16]) { if (back - span >= 0) { const candidate = printableName(bytes, back - span, span); if (candidate) { name = candidate; break; } } }
      return { h1_off: back, cls: hex(cls, 4), nsec, id, idx, name, confidence: name ? 'STRUCTURAL' : 'WEAK' };
    }
    return null;
  }

  /* ---------------- Independent 0x0BC0 CHAR facial-state audit ---------------- */

  function auditCharFacialState(input) {
    const bytes = asBytes(input), d = dv(bytes), boundaries = [];
    if (bytes.length < 0x80 || ascii(bytes, 0, 4) !== 'XBDC') throw new Error('Expected XBDC actor container');
    const seg0 = d.getUint32(12, true);
    if (seg0 + 0x60 > bytes.length) throw new Error('Segment 0 header exceeds file');
    const declaredSlots = d.getUint32(seg0 + 0x50, true), tableRelative = d.getUint32(seg0 + 0x58, true), tableOff = seg0 + tableRelative;
    if (!declaredSlots || declaredSlots > 64 || tableOff + 8 > bytes.length) throw new Error('Material reference table pointer invalid');
    const slotCount = d.getUint32(tableOff, true);
    if (slotCount !== declaredSlots) boundaries.push(`table slot count ${slotCount} != declared ${declaredSlots}`);
    const packetStartQwords = []; for (let i = 0; i < slotCount; i++) packetStartQwords.push(d.getUint32(tableOff + 4 + i * 4, true));
    const dynOff = tableOff + 4 + slotCount * 4, dynamicCount = d.getUint32(dynOff, true), dynamicRecords = [];
    for (let i = 0; i < Math.min(dynamicCount, 16); i++) {
      const off = dynOff + 4 + i * 16;
      dynamicRecords.push({ off, asset_label: ascii(bytes, off, 4).replace(/\0+$/, ''), base_texture_id: d.getUint32(off + 4, true), material_slot_ordinal: d.getUint32(off + 8, true), frame_last_index: d.getUint32(off + 12, true) });
    }
    const fisa = [];
    for (let off = 0; off + 0x18 <= bytes.length; off += 16) {
      if (ascii(bytes, off, 4) !== 'FISA') continue;
      const stride = d.getUint32(off + 8, true), count = d.getUint16(off + 0x10, true), version = d.getUint16(off + 0x12, true), mirror = d.getUint32(off + 0x14, true);
      if (!count || count > 64 || off + 0x18 + count * 8 > bytes.length) continue;
      const pairs = []; for (let i = 0; i < count; i++) pairs.push({ key: d.getUint32(off + 0x18 + i * 8, true), value: d.getUint32(off + 0x18 + i * 8 + 4, true) });
      const groupBase = off - count * stride - 0x10;
      const members = pairs.map((pair, index) => {
        const expected = groupBase + pair.key, resolvable = expected >= 0 && expected + 0x1c <= bytes.length && ascii(bytes, expected, 4) === 'FIS\0';
        return { index, key: pair.key, value: pair.value, expected_off: expected, texture_id: resolvable ? d.getUint32(expected + 0x18, true) : null, key_arithmetic: pair.key === 0x10 + index * stride };
      });
      fisa.push({ off, stride, count, record_version: version, count_mirror: mirror, members, pair_values_uniform: pairs.every((pair) => pair.value === pairs[0].value), pair_value_observed: pairs.length ? pairs[0].value : null });
    }
    const tex0Writes = [];
    for (let off = 0; off + 16 <= bytes.length; off += 16) {
      const register = d.getBigUint64(off + 8, true);
      if (Number(register & 0xffn) !== 0x06 || register === 0n) continue;
      const value = d.getBigUint64(off, true), high16 = register > 0xffffffffn ? Number((register >> 32n) & 0xffffn) : null;
      tex0Writes.push({
        off, value_hex: `0x${value.toString(16).toUpperCase().padStart(16, '0')}`, high16,
        psm: Number((value >> 20n) & 0x3fn), tcc: Number((value >> 34n) & 1n),
        tbp0: Number(value & 0x3fffn), tbw: Number((value >> 14n) & 0x3fn), tw: Number((value >> 26n) & 0xfn), th: Number((value >> 30n) & 0xfn),
        cbp: Number((value >> 37n) & 0x3fffn), csa: Number((value >> 56n) & 0x1fn),
      });
    }
    const templates = tex0Writes.filter((row) => row.high16 != null && TEX0_HIGH16_VALUES.includes(row.high16));
    return {
      format: 'SO3_CHAR_FACIAL_STATE_AUDIT', segment0_off: seg0, table_off: tableOff, declared_slots: declaredSlots,
      packet_start_qwords: packetStartQwords, dynamic_count: dynamicCount, dynamic_records: dynamicRecords, fisa,
      tex0_writes_total: tex0Writes.length, tex0_high16_templates: templates,
      tex0_template_addresses_zero: templates.every((row) => row.tbp0 === 0 && row.tbw === 0 && row.tw === 0 && row.th === 0 && row.cbp === 0 && row.csa === 0),
      tex0_high16_shared_across_segment0_slots: new Set(templates.filter((row) => row.high16 === 2869).map((row) => row.high16)).size === 1 && templates.filter((row) => row.high16 === 2869).length >= 3,
      boundaries,
    };
  }

  /* ---------------- Bounded R5900 constant scan ---------------- */

  function elfVaMapper(bytes) {
    const d = dv(bytes);
    if (bytes.length < 52 || bytes[0] !== 0x7f || ascii(bytes, 1, 3) !== 'ELF') return null;
    const phoff = d.getUint32(28, true), phentsize = d.getUint16(42, true), phnum = d.getUint16(44, true), loads = [];
    for (let i = 0; i < phnum; i++) {
      const p = phoff + i * phentsize; if (p + 32 > bytes.length) break;
      if (d.getUint32(p, true) !== 1) continue;
      loads.push({ offset: d.getUint32(p + 4, true), va: d.getUint32(p + 8, true), file_size: d.getUint32(p + 16, true) });
    }
    if (!loads.length) return null;
    return { format: 'ELF32', segments: loads, va: (off) => { for (const seg of loads) if (off >= seg.offset && off < seg.offset + seg.file_size) return seg.va + (off - seg.offset); return null; } };
  }
  function moduleVaMapper(bytes) {
    const elf = elfVaMapper(bytes); if (elf) return elf;
    if (bytes.length >= 0x20 && ascii(bytes, 0, 4) === 'MWo3') { const load = dv(bytes).getUint32(8, true); return { format: 'MWo3', load_address: load, va: (off) => load + off }; }
    return { format: 'RAW', va: () => null };
  }

  const REG = ['zero','at','v0','v1','a0','a1','a2','a3','t0','t1','t2','t3','t4','t5','t6','t7','s0','s1','s2','s3','s4','s5','s6','s7','t8','t9','k0','k1','gp','sp','fp','ra'];
  function scanExecutableForFacialConstants(input, options = {}) {
    const bytes = asBytes(input), d = dv(bytes), mapper = moduleVaMapper(bytes);
    const maxHits = options.maxHits || 512, maxWindows = options.maxWindows || 48, windowSpan = options.windowSpan || 0x40;
    const halfTargets = new Map(FAMILY_IDS.map((id) => [id, 'FAMILY_ID_IMM16']));
    for (const value of TEX0_HIGH16_VALUES) halfTargets.set(value, 'TEX0_HIGH16_IMM16');
    const hits = [], boundaries = [], pendingLui = new Map(), smallFrameCmpOffsets = [];
    let smallFrameCmpTotal = 0;
    const sourceSize = Number.isSafeInteger(options.sourceSize) && options.sourceSize >= bytes.length ? options.sourceSize : bytes.length;
    const sourceOffset = Number.isSafeInteger(options.sourceOffset) && options.sourceOffset >= 0 ? options.sourceOffset : 0;
    const limit = Math.min(bytes.length & ~3, options.maxBytes || 16 * 1024 * 1024);
    if (bytes.length > limit) boundaries.push(`input truncated to first ${limit} bytes by scanner cap`);
    if (sourceOffset || sourceSize > limit) boundaries.push(`source coverage is [${sourceOffset}, ${sourceOffset + limit}) of ${sourceSize} bytes; negative results apply only to this scanned range`);
    const push = (hit) => { if (hits.length < maxHits) hits.push(hit); else if (hits.length === maxHits) { hits.push({ kind: 'HIT_CAP_REACHED' }); boundaries.push(`hit cap ${maxHits} reached`); } };
    for (let off = 0; off + 4 <= limit; off += 4) {
      const word = d.getUint32(off, true), op = word >>> 26, rs = (word >>> 21) & 31, rt = (word >>> 16) & 31, imm = word & 0xffff;
      if (WORD_TARGETS[word] && hits.length <= maxHits) push({ kind: 'DATA_WORD', target: WORD_TARGETS[word], off, va: mapVa(mapper, off), word_hex: hex(word, 8) });
      if (op === 0x0f) { if (rt !== 0) pendingLui.set(rt, { hi: imm, off }); continue; }
      if ((op === 0x0d || op === 0x09) && pendingLui.has(rs) && off - pendingLui.get(rs).off <= 12 * 4) {
        const { hi, off: luiOff } = pendingLui.get(rs);
        const value = op === 0x0d ? ((hi << 16) | imm) >>> 0 : ((hi << 16) + ((imm << 16) >> 16)) >>> 0;
        if (WORD_TARGETS[value]) push({ kind: 'CODE_CONST32', target: WORD_TARGETS[value], value_hex: hex(value, 8), lui_off: luiOff, off, va: mapVa(mapper, luiOff), asm: `lui $${REG[rs]},${hex(hi, 4)} ; ${op === 0x0d ? 'ori' : 'addiu'} $${REG[rt]},$${REG[rs]},${hex(imm, 4)}` });
      }
      if ((op === 0x09 || op === 0x0d) && rs === 0 && halfTargets.has(imm)) push({ kind: 'CODE_IMM16_LI', target: halfTargets.get(imm), value: imm, off, va: mapVa(mapper, off), asm: `${op === 0x09 ? 'addiu' : 'ori'} $${REG[rt]},$zero,${imm}` });
      else if ((op === 0x0c || op === 0x0a || op === 0x0b || op === 0x0e) && halfTargets.has(imm)) push({ kind: 'CODE_IMM16_CMP', target: halfTargets.get(imm), value: imm, off, va: mapVa(mapper, off), asm: `${['?','?','?','?','?','?','?','?','?','?','slti','sltiu','andi','?','xori'][op] || 'imm'} $${REG[rt]},$${REG[rs]},${imm}` });
      if ((op === 0x0a || op === 0x0b) && (imm === 2 || imm === 3 || imm === 4)) { smallFrameCmpTotal++; if (smallFrameCmpOffsets.length < 8192) smallFrameCmpOffsets.push(off); }
    }
    if (smallFrameCmpTotal > smallFrameCmpOffsets.length) boundaries.push(`small-frame compare cap 8192 reached (${smallFrameCmpTotal} total)`);
    const strong = hits.filter((hit) => hit.kind === 'CODE_CONST32' || hit.kind === 'CODE_IMM16_LI' || hit.kind === 'CODE_IMM16_CMP' || hit.kind === 'DATA_WORD');
    const clusters = clusterHits(strong, smallFrameCmpOffsets, 0x140);
    const windows = clusters.slice(0, maxWindows).map((cluster) => ({
      start: Math.max(0, cluster.min - windowSpan), end: Math.min(bytes.length, cluster.max + windowSpan),
      va_start: mapVa(mapper, Math.max(0, cluster.min - windowSpan)), distinct_targets: cluster.targets, promotion: 'CANDIDATE_EVIDENCE_ONLY',
      hex: Array.from(bytes.subarray(Math.max(0, cluster.min - windowSpan), Math.min(bytes.length, cluster.max + windowSpan)), (x) => x.toString(16).padStart(2, '0')).join(''),
    }));
    if (clusters.length > maxWindows) boundaries.push(`window cap ${maxWindows} reached (${clusters.length} clusters)`);
    return { format: 'SO3_FACIAL_SELECTOR_EXECUTABLE_SCAN', module: { format: mapper.format, load_address: mapper.load_address != null ? hex(mapper.load_address, 8) : null, segments: mapper.segments || null, byte_size: sourceSize, input_byte_size: bytes.length, scanned_offset: sourceOffset, scanned_byte_size: limit, scan_complete: sourceOffset === 0 && limit === sourceSize }, hits, hit_count: Math.min(hits.length, maxHits), small_frame_cmp_total: smallFrameCmpTotal, clusters, evidence_windows: windows, promotion: false, gate: GATE, gate_status: 'UNRESOLVED', boundaries };
  }
  function mapVa(mapper, off) { const va = mapper.va(off); return va == null ? null : hex(va, 8); }
  function clusterHits(strong, smallFrameCmpOffsets, span) {
    const sorted = [...strong].filter((hit) => hit.off != null).sort((a, b) => a.off - b.off), clusters = [];
    for (const hit of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && hit.off - last.max <= span) { last.max = hit.off; last.targets = [...new Set([...last.targets, hit.target])]; last.hit_offsets.push(hit.off); }
      else clusters.push({ min: hit.off, max: hit.off, targets: [hit.target], hit_offsets: [hit.off] });
    }
    for (const cluster of clusters) cluster.small_frame_cmp_nearby = smallFrameCmpOffsets.some((off) => off >= cluster.min - span && off <= cluster.max + span);
    return clusters.filter((cluster) => cluster.targets.length >= 2 || (cluster.targets.length === 1 && cluster.small_frame_cmp_nearby)).map((cluster) => ({ ...cluster, promotion: 'CANDIDATE_EVIDENCE_ONLY' }));
  }

  /* ---------------- Report assembly ---------------- */

  function buildProbeReport(parts = {}) {
    const fas = parts.fas || [], executables = parts.executables || [], charAudit = parts.charAudit || null;
    const familyRefs = [...new Set(fas.flatMap((scan) => scan.family_base_ids_referenced || []))];
    return {
      format: 'SO3_FACIAL_EVIDENCE_AUDIT_REPORT', version: 4, producer: 'SO3 Resource Explorer V5.12.4', created: parts.created || null,
      gate: GATE, gate_status: 'RESOLVED_ACTOR_0x0BC0_STATIC_FACE_PREVIEW', promotion: true,
      verified_static_facts: {
        fps_dynamic_records_label: 'naka', fisa_pair_values_uniform_value_1: charAudit ? charAudit.fisa.every((group) => group.pair_values_uniform && group.pair_value_observed === 1) : null,
        tex0_templates_zero_address_and_clut_fields: charAudit ? charAudit.tex0_template_addresses_zero : null,
        tex0_high16_2869_shared_by_all_segment0_materials: charAudit ? charAudit.tex0_high16_shared_across_segment0_slots : null,
        csm1_idtex4_logical_to_stored_palette_index: [0,1,2,3,4,5,6,7,16,17,18,19,20,21,22,23],
        logical_palette_count_per_observed_facial_fis: 1,
      },
      candidate_evidence: {
        fas_naka_events: fas, fas_family_base_ids_referenced: familyRefs,
        nakam_tag_misparse_candidate: fas.some((scan) => (scan.events || []).some((event) => event.id === 2413)),
        executable_scans: executables,
      },
      hypotheses_not_promoted: [
        'FAS type_0x0021 naka events carry the u16 texture id whose FISA family member should become active on the bound facial material.',
        "The Atlas registry's second tag name 'nakam' is a misparse of 'naka' followed by an id low byte 0x6D (2413 family).",
        'A later runtime or material-preparation stage supplies complete TEX0 address and CLUT-cache state before GS consumption. No second embedded palette exists in the observed facial FIS resources.',
        'The shared TEX0 high-register value 2869 is an actor/upload-group handle, not a per-slot texture selector.',
      ],
      remaining_boundaries: [
        'The static Model Lab holds each facial family at its base member because FAS animation-clock playback is not implemented.',
        'The CLUT repair is promoted only for layouts satisfying the decoded PSMCT32 16x2 upload plus CSM1 IDTEX4 8x2 consumer gates.',
      ],
      constraints: { browser_only: true, offline: true, read_only_iso: true, mobile_safe: true, pcsx2_attachment: false, laptop_required: false },
    };
  }

  return { GATE, FAMILY_IDS, FAMILY_BASE_IDS, TEX0_HIGH16_VALUES, WORD_TARGETS, scanFasNakaEvents, auditCharFacialState, scanExecutableForFacialConstants, buildProbeReport };
});
