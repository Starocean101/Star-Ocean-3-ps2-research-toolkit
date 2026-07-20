'use strict';
const assert = require('assert'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const Runtime = require('../02_SOURCE/v510_targeted_runtime.js'), Movie = require('../02_SOURCE/v53_movie_decoder.js');

const vector = Buffer.from(fs.readFileSync(path.join(__dirname, 'vectors/lib_movie_transform_minimal.elf.b64'), 'utf8').trim(), 'base64');
assert.strictEqual(crypto.createHash('sha256').update(vector).digest('hex'), '77794efeca9cf85884d5f9dd902f84f239fd69c2c6bb4e28771b9d85aa068196');
assert.strictEqual(Runtime.VERSION, '5.10.1');

const plain = new Uint8Array(0x4000); for (let i = 0; i < plain.length; i++) plain[i] = i * 73 + (i >>> 4) & 0xff; plain.set([0, 0, 1, 0xba], 0);
const carrier = Movie.encodeBytes(plain), result = Runtime.runMovieTransform(vector, carrier, { length: 0x4000, traceLimit: 1200 });
assert.deepStrictEqual(Buffer.from(result.output), Buffer.from(plain));
assert.strictEqual(result.report.output.mpeg_pack_at_zero, true); assert.strictEqual(result.report.execution.stop_reason, 'RETURN_SENTINEL'); assert.strictEqual(result.report.execution.instruction_count, 12382); assert.strictEqual(result.report.execution.calls.length, 2); assert.deepStrictEqual(result.report.execution.memory_writes, { '8_byte': 2049, '16_byte': 5 });
assert.strictEqual(result.report.version, 2); assert.strictEqual(result.report.output.artifact_kind, 'MPEG_PS_EXECUTION_FRAGMENT'); assert.strictEqual(result.report.output.standalone_complete_movie, false); assert.strictEqual(result.report.execution.trace_records_committed, 12382); assert.strictEqual(result.report.execution.trace_records_retained, 1200); assert.strictEqual(crypto.createHash('sha256').update(result.traceCommitmentInput).digest('hex'), '3d700be566192092f35f80180a6815ba04bda7e3108eb1c8087997adaa9bfa5e');
assert.strictEqual(result.report.routine.kind, 'R5900_INSTRUCTION_EXECUTION'); assert(result.report.trace.some((row) => row.delay_slot));
assert.throws(() => Runtime.runMovieTransform(vector, carrier, { length: 63 }), /0x40-byte/);
const code = vector.subarray(0x80), mwo3 = new Uint8Array(0x80 + code.length); mwo3.set([0x4d, 0x57, 0x6f, 0x33], 0); new DataView(mwo3.buffer).setUint32(8, 0x0041a270, true); new DataView(mwo3.buffer).setUint32(0x0c, mwo3.length - 0x40, true); mwo3.set(code, 0x80);
const rawResult = Runtime.runMovieTransform(mwo3, carrier, { length: 0x4000, traceLimit: 4, moduleName: 'synthetic Lib MWo3' }); assert.deepStrictEqual(Buffer.from(rawResult.output), Buffer.from(plain)); assert.strictEqual(rawResult.report.elf.format, 'MWo3');
console.log('[PASS] V5.10.1 module-bound, trace-committed R5900 movie execution reproduces the independent transform byte-exactly');
