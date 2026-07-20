#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
require('../02_SOURCE/v5128_hybrid_bridge.js');
const B = globalThis.SO3V5128HybridBridge;
assert.equal(B.VERSION, '5.12.8');
const request = B.validateRequest({ format: B.FORMAT_REQUEST, request_id: 'bootstrap-1', visible_executables: true, hidden_entries: [2,2], actors: ['0x08FF', '0x0BC0'], iso_ranges: [{ id: 'window', offset: 2048, size: 4096, purpose: 'test' }] });
assert.deepEqual(request.actors, ['0x08FF', '0x0BC0']);
assert.deepEqual(request.hidden_entries, [2]);
assert.equal(request.iso_ranges[0].offset, 2048);
assert.throws(() => B.validateRequest({ format: B.FORMAT_REQUEST, request_id: '../bad' }), /request_id/);
assert.throws(() => B.validateRequest({ format: B.FORMAT_REQUEST, request_id: 'big', iso_ranges: [{ offset: 0, size: B.LIMITS.MAX_MEMBER + 1 }] }), /Invalid ISO range/);
assert.throws(() => B.validateRequest({ format: 'wrong', request_id: 'x' }), /Expected/);
console.log('V5.12.8 hybrid request validation: PASS');
