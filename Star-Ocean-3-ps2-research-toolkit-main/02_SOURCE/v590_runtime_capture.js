/* SO3 Resource Explorer V5.9.0 browser-side runtime capture analysis core. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SO3V590RuntimeCapture = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '5.9.0';
  const FORMAT = 'SO3_RUNTIME_CAPTURE_REPORT';
  const DEFAULT_CHUNK = 4 * 1024 * 1024;
  const LEGACY_WINDOW = Object.freeze({ start: 0x2410bd00, end: 0x241a7d00, size: 0x9c000 });
  const SIGNATURES = Object.freeze([
    { name: 'MPEG_PACK', bytes: [0x00, 0x00, 0x01, 0xba] },
    { name: 'MPEG_SYSTEM_HEADER', bytes: [0x00, 0x00, 0x01, 0xbb] },
    { name: 'MPEG_VIDEO_PES', bytes: [0x00, 0x00, 0x01, 0xe0] },
    { name: 'MPEG_PRIVATE_STREAM_1', bytes: [0x00, 0x00, 0x01, 0xbd] },
    { name: 'PK3', bytes: [0x50, 0x4b, 0x33] },
    { name: 'PACK', bytes: [0x50, 0x41, 0x43, 0x4b] },
    { name: 'SLZ', bytes: [0x53, 0x4c, 0x5a] },
    { name: 'SLE', bytes: [0x53, 0x4c, 0x45] },
    { name: 'ZLS', bytes: [0x5a, 0x4c, 0x53] },
    { name: 'FPS', bytes: [0x46, 0x50, 0x53] },
    { name: 'RTA', bytes: [0x52, 0x54, 0x41] },
    { name: 'FAS', bytes: [0x46, 0x41, 0x53] },
    { name: 'FIS', bytes: [0x46, 0x49, 0x53] },
    { name: 'XBDC', bytes: [0x58, 0x42, 0x44, 0x43] },
    { name: 'TIM2', bytes: [0x54, 0x49, 0x4d, 0x32] },
    { name: 'MWO3', bytes: [0x4d, 0x57, 0x4f, 0x33] },
    { name: 'ELF', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  ]);

  function parseInteger(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value == null ? '' : value).trim();
    if (!text) return null;
    const result = /^[-+]?0x/i.test(text) ? Number.parseInt(text, 16) : Number.parseInt(text, 10);
    return Number.isFinite(result) ? result : null;
  }

  function hex(value, width = 0) {
    if (!Number.isFinite(Number(value))) return null;
    return `0x${Math.trunc(Number(value)).toString(16).toUpperCase().padStart(width, '0')}`;
  }

  function bytesHex(bytes) { return Array.from(bytes || [], (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase(); }
  function u32le(bytes, offset) { return ((bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0); }

  function splitRow(line, delimiter) { return line.split(delimiter).map((x) => x.trim()); }
  function parseTransferLog(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
    if (!lines.length) throw new Error('Transfer log is empty');
    const delimiter = lines[0].includes('\t') ? '\t' : ',';
    const headers = splitRow(lines.shift(), delimiter).map((x) => x.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
    const aliases = {
      sequence: ['sequence', 'seq', 'index'], payload_offset: ['payload_offset', 'output_offset', 'file_offset'],
      source_address: ['source_address', 'source', 'src'], destination_address: ['destination_address', 'destination', 'dest'],
      requested_bytes: ['requested_bytes', 'requested', 'count', 'size'], captured_bytes: ['captured_bytes', 'captured', 'written'],
      caller: ['caller', 'return_address', 'pc'], timestamp_ms: ['timestamp_ms', 'time_ms', 'timestamp'],
    };
    const column = {};
    for (const [field, names] of Object.entries(aliases)) column[field] = headers.findIndex((name) => names.includes(name));
    for (const required of ['sequence', 'payload_offset', 'source_address', 'destination_address', 'captured_bytes']) if (column[required] < 0) throw new Error(`Transfer log is missing ${required}`);
    return lines.map((line, row) => {
      const cells = splitRow(line, delimiter), item = { row: row + 2 };
      for (const field of Object.keys(aliases)) item[field] = column[field] < 0 ? null : parseInteger(cells[column[field]]);
      if (['sequence', 'payload_offset', 'source_address', 'destination_address', 'captured_bytes'].some((field) => item[field] == null)) throw new Error(`Transfer log row ${item.row} has an invalid required number`);
      return item;
    });
  }

  function validateTransfers(transfers, payloadSize, window = LEGACY_WINDOW) {
    const issues = [], rows = Array.isArray(transfers) ? transfers : [];
    let expectedOffset = 0, previousSequence = null, insideWindow = 0, capturedTotal = 0;
    for (const item of rows) {
      if (previousSequence != null && item.sequence !== previousSequence + 1) issues.push({ code: 'SEQUENCE_GAP', row: item.row, expected: previousSequence + 1, actual: item.sequence });
      if (item.payload_offset !== expectedOffset) issues.push({ code: item.payload_offset < expectedOffset ? 'PAYLOAD_OVERLAP' : 'PAYLOAD_GAP', row: item.row, expected: expectedOffset, actual: item.payload_offset });
      if (item.captured_bytes <= 0) issues.push({ code: 'INVALID_CAPTURE_SIZE', row: item.row, actual: item.captured_bytes });
      if (item.requested_bytes != null && item.captured_bytes > item.requested_bytes) issues.push({ code: 'CAPTURE_EXCEEDS_REQUEST', row: item.row, requested: item.requested_bytes, captured: item.captured_bytes });
      if (item.destination_address >= window.start && item.destination_address < window.end) insideWindow++;
      expectedOffset = item.payload_offset + Math.max(0, item.captured_bytes); capturedTotal += Math.max(0, item.captured_bytes); previousSequence = item.sequence;
    }
    if (Number.isFinite(payloadSize) && expectedOffset !== payloadSize) issues.push({ code: expectedOffset < payloadSize ? 'UNLOGGED_PAYLOAD_TAIL' : 'LOG_EXCEEDS_PAYLOAD', expected: payloadSize, actual: expectedOffset });
    return {
      valid: issues.length === 0, rows: rows.length, captured_total: capturedTotal, reconstructed_end: expectedOffset,
      destination_window: { start: hex(window.start, 8), end_exclusive: hex(window.end, 8), size: window.end - window.start, rows_inside: insideWindow, all_rows_inside: rows.length > 0 && insideWindow === rows.length }, issues,
    };
  }

  function parsePk3Header(head, fileSize) {
    const bytes = head instanceof Uint8Array ? head : new Uint8Array(head || 0), magic = bytes.length >= 3 ? String.fromCharCode(...bytes.subarray(0, 3)) : '';
    const declared = bytes.length >= 0x18 ? u32le(bytes, 0x14) : null;
    return {
      magic, magic_pk3: magic === 'PK3', header_hex: bytesHex(bytes.subarray(0, Math.min(64, bytes.length))),
      declared_size_offset: '0x14', declared_size_le: declared, declared_size_plausible: declared != null && declared >= 0x18 && (!Number.isFinite(fileSize) || declared <= fileSize),
      classification: magic === 'PK3' ? 'SO3 PK3 runtime-stream candidate' : 'Unclassified runtime capture',
      confidence: magic === 'PK3' ? 'STRUCTURAL' : 'UNRESOLVED',
    };
  }

  function rotr(value, count) { return value >>> count | value << (32 - count); }
  class Sha256 {
    constructor() { this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]); this.buffer = new Uint8Array(64); this.used = 0; this.bytes = 0; }
    update(input) { const data = input instanceof Uint8Array ? input : new Uint8Array(input); this.bytes += data.length; let p = 0; while (p < data.length) { const take = Math.min(64 - this.used, data.length - p); this.buffer.set(data.subarray(p, p + take), this.used); this.used += take; p += take; if (this.used === 64) { this.compress(this.buffer); this.used = 0; } } return this; }
    compress(chunk) {
      const k = Sha256.K, w = new Uint32Array(64); for (let i = 0; i < 16; i++) { const p = i * 4; w[i] = (chunk[p] << 24 | chunk[p + 1] << 16 | chunk[p + 2] << 8 | chunk[p + 3]) >>> 0; }
      for (let i = 16; i < 64; i++) { const a = w[i - 15], b = w[i - 2], s0 = rotr(a, 7) ^ rotr(a, 18) ^ a >>> 3, s1 = rotr(b, 17) ^ rotr(b, 19) ^ b >>> 10; w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0; }
      let [a, b, c, d, e, f, g, h] = this.h; for (let i = 0; i < 64; i++) { const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = e & f ^ ~e & g, t1 = (h + s1 + ch + k[i] + w[i]) >>> 0, s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), maj = a & b ^ a & c ^ b & c, t2 = (s0 + maj) >>> 0; h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0; }
      const v = [a, b, c, d, e, f, g, h]; for (let i = 0; i < 8; i++) this.h[i] = (this.h[i] + v[i]) >>> 0;
    }
    digestHex() {
      const total = this.bytes, tail = new Uint8Array(this.used + 1 + 8 + 64), used = this.used; tail.set(this.buffer.subarray(0, used)); tail[used] = 0x80; const finalLength = Math.ceil((used + 1 + 8) / 64) * 64, bitsHigh = Math.floor(total / 0x20000000), bitsLow = (total << 3) >>> 0;
      tail[finalLength - 8] = bitsHigh >>> 24; tail[finalLength - 7] = bitsHigh >>> 16; tail[finalLength - 6] = bitsHigh >>> 8; tail[finalLength - 5] = bitsHigh; tail[finalLength - 4] = bitsLow >>> 24; tail[finalLength - 3] = bitsLow >>> 16; tail[finalLength - 2] = bitsLow >>> 8; tail[finalLength - 1] = bitsLow;
      for (let p = 0; p < finalLength; p += 64) this.compress(tail.subarray(p, p + 64)); return Array.from(this.h, (x) => x.toString(16).padStart(8, '0')).join('');
    }
  }
  Sha256.K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);

  async function analyzeBlob(blob, options = {}) {
    if (!blob || !Number.isFinite(blob.size)) throw new Error('A Blob or File is required');
    const chunkSize = Math.max(64 * 1024, Number(options.chunkSize) || DEFAULT_CHUNK), maxPattern = Math.max(...SIGNATURES.map((x) => x.bytes.length)), maxSamples = Math.max(1, Number(options.maxSamples) || 64), findings = Object.fromEntries(SIGNATURES.map((x) => [x.name, { count: 0, sample_offsets: [] }]));
    const hash = new Sha256(), head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 256)).arrayBuffer()); let overlap = new Uint8Array(0), processed = 0;
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      if (options.cancel?.cancelled) throw new Error('Capture analysis cancelled');
      const part = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + chunkSize)).arrayBuffer()); hash.update(part); const joined = new Uint8Array(overlap.length + part.length); joined.set(overlap); joined.set(part, overlap.length); const base = offset - overlap.length;
      for (const signature of SIGNATURES) { const out = findings[signature.name], pattern = signature.bytes; outer: for (let i = 0; i <= joined.length - pattern.length; i++) { const absolute = base + i; if (absolute < offset && absolute + pattern.length <= offset) continue; for (let j = 0; j < pattern.length; j++) if (joined[i + j] !== pattern[j]) continue outer; out.count++; if (out.sample_offsets.length < maxSamples) out.sample_offsets.push(absolute); } }
      overlap = joined.slice(Math.max(0, joined.length - maxPattern + 1)); processed += part.length; if (options.onProgress) options.onProgress({ processed, total: blob.size, ratio: blob.size ? processed / blob.size : 1 }); await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { sha256: hash.digestHex(), header: parsePk3Header(head, blob.size), signatures: findings };
  }

  function chooseReconstructionSize(fileSize, header, override) {
    const manual = parseInteger(override); if (manual != null) { if (manual <= 0 || manual > fileSize) throw new Error('Expected size must be greater than zero and no larger than the capture'); return { size: manual, source: 'USER_OVERRIDE' }; }
    if (header?.declared_size_plausible) return { size: header.declared_size_le, source: 'PK3_HEADER_LE32_AT_0x14' };
    return { size: fileSize, source: 'CAPTURE_FILE_SIZE' };
  }

  function buildReport(file, analysis, transferValidation, reconstruction, profile = {}) {
    return {
      format: FORMAT, version: 1, producer: `SO3 Resource Explorer ${VERSION}`, created: new Date().toISOString(), local_only: true,
      source: { name: file?.name || 'capture_payload.bin', captured_bytes: file?.size || 0, sha256: analysis.sha256 },
      capture_profile: { id: profile.id || 'UNSPECIFIED', pcsx2_build: profile.pcsx2_build || null, host_architecture: profile.host_architecture || null, historical_claim: profile.historical_claim || null },
      header: analysis.header, transfer_log: transferValidation || { supplied: false }, reconstruction,
      signatures: Object.fromEntries(Object.entries(analysis.signatures).map(([name, value]) => [name, { ...value, sample_offsets_hex: value.sample_offsets.map((x) => hex(x)) }])),
      reasoning_boundary: [
        'A signature hit proves only that the byte sequence occurs at the reported offset.',
        'The historical PCSX2 address profile is build-specific and is not promoted to a universal memory map.',
        'A contiguous capture and plausible PK3 header do not by themselves prove decoded audio, script, model, or map semantics.',
      ],
    };
  }

  function buildAtlasUpdate(report) {
    const present = Object.entries(report.signatures || {}).filter(([, value]) => value.count > 0).map(([name, value]) => ({ signature: name, count: value.count, first_offsets: value.sample_offsets_hex?.slice(0, 8) || [] }));
    return {
      format: 'SO3_ATLAS_RUNTIME_UPDATE', version: 1, producer: report.producer, created: report.created,
      records: [{ source_sha256: report.source.sha256, source_size: report.source.captured_bytes, classification: report.header.classification, classification_confidence: report.header.confidence, reconstruction: report.reconstruction, observed_signatures: present, transfer_validation: report.transfer_log }],
      promotion_status: 'CANDIDATE_EVIDENCE_ONLY', automatic_format_override_allowed: false,
    };
  }

  function workerSource() {
    return `'use strict';\nconst SIGNATURES=${JSON.stringify(SIGNATURES)};\nconst DEFAULT_CHUNK=${DEFAULT_CHUNK};\n${rotr.toString()}\n${Sha256.toString()}\nSha256.K=new Uint32Array(${JSON.stringify(Array.from(Sha256.K))});\n${bytesHex.toString()}\n${u32le.toString()}\n${parsePk3Header.toString()}\n${analyzeBlob.toString()}\nlet token={cancelled:false};onmessage=async(e)=>{if(e.data.type==='cancel'){token.cancelled=true;return}if(e.data.type!=='analyze')return;token={cancelled:false};try{const result=await analyzeBlob(e.data.file,{chunkSize:e.data.chunkSize,maxSamples:e.data.maxSamples,cancel:token,onProgress:(p)=>postMessage({type:'progress',...p})});postMessage({type:'complete',result})}catch(error){postMessage({type:'error',error:error.message})}};`;
  }

  return Object.freeze({ VERSION, FORMAT, DEFAULT_CHUNK, LEGACY_WINDOW, SIGNATURES, parseInteger, hex, parseTransferLog, validateTransfers, parsePk3Header, Sha256, analyzeBlob, chooseReconstructionSize, buildReport, buildAtlasUpdate, workerSource });
});
