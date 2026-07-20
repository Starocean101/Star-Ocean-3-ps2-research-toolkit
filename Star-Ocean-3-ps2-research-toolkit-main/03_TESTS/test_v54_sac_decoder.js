#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const S = require('../02_SOURCE/v54_sac_decoder.js');

let checks = 0;
function check(name, condition) { assert.ok(condition, name); checks++; console.log(`[PASS] ${name}`); }

check('decoder version', S.VERSION === '5.4.0');
check('sample rate', S.SAMPLE_RATE === 48000);
check('synthesis window length', S.WINDOW.length === 512);
check('synthesis window positive peak', S.WINDOW[256] === 1.144989013671875);
check('synthesis window negative peak', S.WINDOW[255] === -1.144287109375);
const windowBytes = Buffer.alloc(2048);
S.WINDOW.forEach((value, index) => windowBytes.writeFloatLE(value, index * 4));
check('executable-derived window hash', crypto.createHash('sha256').update(windowBytes).digest('hex') === '7afe6664ff924458ed3cc91dc75dbe7b08131fe42122bbb7baa6bff93e64d000');
check('CRC empty vector', S.crc16(new Uint8Array(), 0, 0) === 0x0000);
const wave = S.wav({ sample_rate: 48000, left: [0, -32768, 32767], right: [0, 32767, -32768] });
check('WAV byte count', wave.length === 56);
check('WAV RIFF marker', Buffer.from(wave.subarray(0, 4)).toString('ascii') === 'RIFF');
check('WAV stereo PCM fields', new DataView(wave.buffer).getUint16(22, true) === 2 && new DataView(wave.buffer).getUint32(24, true) === 48000);
assert.throws(() => S.demuxSac(new Uint8Array(64)), /no SO3 SAC/); checks++; console.log('[PASS] rejects non-SAC program stream');
console.log(`=> ${checks} checks, 0 failures`);
