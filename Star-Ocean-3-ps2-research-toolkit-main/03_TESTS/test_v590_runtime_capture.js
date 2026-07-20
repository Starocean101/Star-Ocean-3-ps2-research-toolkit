'use strict';
const assert = require('assert'), crypto = require('crypto'), vm = require('vm');
const C = require('../02_SOURCE/v590_runtime_capture.js');
require('../02_SOURCE/v590_capture_assets.js');

(async () => {
  assert.strictEqual(C.VERSION, '5.9.0');
  assert.strictEqual(C.LEGACY_WINDOW.end - C.LEGACY_WINDOW.start, 0x9c000);
  const log = 'sequence\tpayload_offset\tsource_address\tdestination_address\trequested_bytes\tcaptured_bytes\tcaller\ttimestamp_ms\n0\t0\t0x1000\t0x2410BD00\t16\t16\t0x2000\t1\n1\t16\t0x1100\t0x2410BE00\t16\t8\t0x2000\t2\n';
  const rows = C.parseTransferLog(log), valid = C.validateTransfers(rows, 24);
  assert.strictEqual(rows.length, 2); assert.strictEqual(valid.valid, true); assert.strictEqual(valid.captured_total, 24); assert.strictEqual(valid.destination_window.all_rows_inside, true);
  const gap = rows.map((x) => ({ ...x })); gap[1].payload_offset = 17; assert.strictEqual(C.validateTransfers(gap, 25).valid, false);

  const bytes = new Uint8Array(70000); bytes.set([0x50, 0x4b, 0x33], 0); new DataView(bytes.buffer).setUint32(0x14, 69990, true); bytes.set([0x00, 0x00, 0x01, 0xba], 65534); bytes.set([0x50, 0x41, 0x43, 0x4b], 222);
  const analysis = await C.analyzeBlob(new Blob([bytes]), { chunkSize: 65536 });
  assert.strictEqual(analysis.header.magic_pk3, true); assert.strictEqual(analysis.header.declared_size_le, 69990); assert.strictEqual(analysis.signatures.MPEG_PACK.count, 1); assert.deepStrictEqual(analysis.signatures.MPEG_PACK.sample_offsets, [65534]); assert.strictEqual(analysis.signatures.PACK.count, 1);
  assert.strictEqual(analysis.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.deepStrictEqual(C.chooseReconstructionSize(bytes.length, analysis.header, ''), { size: 69990, source: 'PK3_HEADER_LE32_AT_0x14' });
  const report = C.buildReport({ name: 'capture.bin', size: bytes.length }, analysis, valid, { output_bytes: 69990, size_source: 'PK3_HEADER_LE32_AT_0x14', trimmed_bytes: 10, complete: true });
  assert.strictEqual(report.format, 'SO3_RUNTIME_CAPTURE_REPORT'); assert.strictEqual(C.buildAtlasUpdate(report).promotion_status, 'CANDIDATE_EVIDENCE_ONLY');
  new vm.Script(C.workerSource());
  const lua = global.SO3V590CaptureAssets.LEGACY_CE_LUA;
  assert(lua.includes('sequence\\tpayload_offset')); assert(!lua.includes('sequence\\\\tpayload_offset')); assert(lua.includes('debug_setBreakpoint(MEMCPY_ADDR)'));
  console.log('[PASS] V5.9 runtime capture parser, continuity gate, chunk-boundary scan, SHA-256, reports, and worker source');
})().catch((error) => { console.error(error); process.exit(1); });
