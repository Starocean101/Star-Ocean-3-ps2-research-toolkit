#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const M = require('../02_SOURCE/v53_movie_decoder.js');

let checks = 0;
function check(name, condition, detail = '') {
  checks++;
  if (!condition) throw new Error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  check('decoder version', M.VERSION === '5.4.0');
  check('routine address pinned', M.PROVENANCE.function_va === '0x0041A2F0');
  check('content-key address pinned', M.PROVENANCE.content_key_va === '0x001CC730');

  const expectedLanes = [
    '4e5223ddf0efdf84', 'b323271fba593a0a', 'ab1aabdd204e04f2', 'bf266094b7db2e19',
    '742512703a1ec293', 'a1f45d79b65ec2b1', '257f661ac5e6d984', 'b3e7e9067a59250a',
  ];
  check('all executable-derived lane keys', M.DEFAULT_LANE_KEYS.every((value, i) => {
    const bytes = new Uint8Array(8);
    M.writeU64LE ? M.writeU64LE(bytes, 0, value) : (() => {
      let x = value;
      for (let p = 0; p < 8; p++) { bytes[p] = Number(x & 255n); x >>= 8n; }
    })();
    return M.hex(bytes) === expectedLanes[i];
  }));

  // Pinned 64-byte observation from the user-supplied entry 21 carrier.  This
  // catches endianness, 64-bit borrow propagation, lane order and row offset.
  const observedCarrier = M.fromHex('77522267b4efdb848e22262b21a13a0a91a1abd4a0d449f2e5598073b1db2e186d35e8f3fb13f3939bce9c68b65fdc107218601ac5e76aac8927ca1435faa71a');
  const expectedMpeg = '000001ba44000400040101349bf8000001bb0009809a4d00217fe0e706000001e00ffa83c10d3100013ac11100011ea11e6706000001b32801c023124fa38210';
  const decodedObservation = M.decodeBytes(observedCarrier);
  check('entry 21 pinned decode', M.hex(decodedObservation) === expectedMpeg, M.hex(decodedObservation));
  check('pinned observation round-trip', M.hex(M.encodeBytes(decodedObservation)) === M.hex(observedCarrier));
  const head = M.validateProgramStreamHead(decodedObservation);
  check('decoded MPEG program-stream grammar', head.valid && head.system_header_offset === 14 && head.video_pes_offset === 29);

  const synthetic = new Uint8Array(0x9000);
  for (let i = 0; i < synthetic.length; i++) synthetic[i] = (i * 73 + (i >>> 5) * 19 + 11) & 255;
  for (const offset of [0, 0x4000, 0x8000]) synthetic.set([0, 0, 1, 0xba], offset);
  synthetic.set([0, 0, 1, 0xbb], 14);
  synthetic.set([0, 0, 1, 0xe0], 29);
  synthetic.set([0, 0, 1, 0xb3], 52);
  const encoded = M.encodeBytes(synthetic), decoded = M.decodeBytes(encoded);
  check('synthetic full-allocation round-trip', Buffer.from(decoded).equals(Buffer.from(synthetic)));

  const split = new Uint8Array(encoded.length);
  split.set(M.decodeBytes(encoded.subarray(0, 0x4000), { baseOffset: 0 }), 0);
  split.set(M.decodeBytes(encoded.subarray(0x4000), { baseOffset: 0x4000 }), 0x4000);
  check('chunked base-offset decode parity', Buffer.from(split).equals(Buffer.from(synthetic)));

  const provider = {
    size: encoded.length,
    async read(offset, length) { return encoded.slice(offset, offset + length); },
  };
  const progress = [];
  const result = await M.decodeProvider(provider, { chunkBytes: 0x4000, progress: async (value) => progress.push(value.bytes) });
  check('provider head validation', result.validation.valid);
  check('provider frame-prefix census', result.checked_frames === 2 && result.valid_frame_prefixes === 2 && result.frame_prefix_ratio === 1);
  check('provider exact output size', result.blob && result.blob.size === synthetic.length);
  check('provider progress reaches end', progress.at(-1) === synthetic.length);
  check('provider output parity', Buffer.from(await result.blob.arrayBuffer()).equals(Buffer.from(synthetic)));

  let cancelled = false;
  try { await M.decodeProvider(provider, { cancelled: () => true }); }
  catch (error) { cancelled = error.code === 'CANCELLED'; }
  check('provider cancellation boundary', cancelled);

  console.log(`=> ${checks} checks, 0 failures`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
