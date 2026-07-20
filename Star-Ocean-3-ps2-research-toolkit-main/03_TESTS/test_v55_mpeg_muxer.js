#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const X = require('../02_SOURCE/v55_mpeg_muxer.js');
let checks = 0;
function check(name, condition) { assert.ok(condition, name); checks++; console.log(`[PASS] ${name}`); }

check('muxer version', X.VERSION === '5.5.0');

for (const value of [0, 1, 4566, 7520, 90000, (2 ** 33) - 1]) {
  const p = new Uint8Array(5); X.writePts(p, 0, value);
  check(`PTS round trip ${value}`, X.readPts(p, 0) === value);
}

function sacPes(pts, payloadByte) {
  const payload = Uint8Array.from([...X.SAC_SUBHEADER, payloadByte]);
  const length = 3 + 5 + payload.length, out = new Uint8Array(6 + length);
  out.set([0, 0, 1, 0xbd, length >> 8, length & 0xff, 0x80, 0x80, 5]);
  X.writePts(out, 9, pts); out.set(payload, 14); return out;
}

const pack = Uint8Array.from([0, 0, 1, 0xba, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const video = Uint8Array.from([0, 0, 1, 0xe0, 0, 3, 0x11, 0x22, 0x33]);
const source = X.concat([pack, sacPes(7520, 0x44), video, sacPes(8460, 0x55)]);
const left = Array.from({ length: 750 }, (_, i) => i - 375);
const right = Array.from({ length: 750 }, (_, i) => 375 - i);
const muxed = X.muxProgramStream(source, { sample_rate: 48000, left, right });

check('two SAC packets found', X.sacPackets(source).length === 2);
check('SAC transport removed', !Buffer.from(muxed.bytes).includes(Buffer.from(X.SAC_SUBHEADER)));
check('all PCM frames emitted', muxed.metrics.pcm_frames === 750);
check('SAC packet count recorded', muxed.metrics.replaced_sac_packets === 2);
check('LPCM packets recorded', muxed.metrics.lpcm_packets === 3);
check('first PTS retained', muxed.metrics.first_audio_pts === 7520);
check('video PES bytes preserved', Buffer.from(muxed.bytes).includes(Buffer.from(video)));
check('DVD LPCM subheader emitted', Buffer.from(muxed.bytes).includes(Buffer.from(X.LPCM_SUBHEADER)));

const firstBd = Buffer.from(muxed.bytes).indexOf(Buffer.from([0, 0, 1, 0xbd]));
const firstPayload = firstBd + 14 + X.LPCM_SUBHEADER.length;
check('PCM is stereo big-endian', Buffer.from(muxed.bytes.slice(firstPayload, firstPayload + 4)).equals(Buffer.from([0xfe, 0x89, 0x01, 0x77])));
check('LPCM PTS retained', X.readPts(muxed.bytes, firstBd + 9) === 7520);

assert.throws(() => X.muxProgramStream(source, { sample_rate: 44100, left, right }), /48000 Hz/);
checks++; console.log('[PASS] rejects non-48-kHz input');
assert.throws(() => X.muxProgramStream(video, { sample_rate: 48000, left, right }), /no timestamped SO3 SAC/);
checks++; console.log('[PASS] rejects stream without SAC');

console.log(`=> ${checks} checks, 0 failures`);
