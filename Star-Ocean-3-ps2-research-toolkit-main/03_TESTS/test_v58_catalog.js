#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const C = require('../02_SOURCE/v58_asset_catalog.js');

const discA = C.discIdentity({ size: 1000, volume_id: 'SO3', hidden_layout_sha256: 'aa' });
const discB = C.discIdentity({ size: 1001, volume_id: 'SO3', hidden_layout_sha256: 'aa' });
assert.match(discA, /^disc:[0-9a-f]{16}$/); assert.notEqual(discA, discB);
const asset = { source: 'hidden', index: 12, offset: 0x1200, size: 4096, type: 'XBDC', tag: 'CHAR', res_id: 0x0bc0, name: 'Entry 12' };
const id = C.stableAssetId(asset, discA); assert.equal(id, C.stableAssetId({ ...asset }, discA)); assert.notEqual(id, C.stableAssetId(asset, discB));
const annotations = new Map([[id, { label: 'Fayt battle model', category: 'playable_character', tags: ['Party', 'blue', 'party'], notes: 'Observed in viewer', reviewed: true, confidence: 'USER_CONFIRMED' }]]);
const pkg = C.annotationPackage(discA, annotations), parsed = C.parseAnnotationPackage(JSON.stringify(pkg), discA); assert.equal(parsed.disc_match, true); assert.equal(parsed.annotations.get(id).tags.join(','), 'party,blue');
assert.equal(C.parseAnnotationPackage(pkg, discB).disc_match, false);
const items = [
  { name: 'small', size: 2, type: 'FAS', confidence: 'STRUCTURAL', annotation: { reviewed: false, label: '', category: 'animation', tags: [] } },
  { name: 'large', size: 20, type: 'XBDC', confidence: 'VERIFIED', annotation: { reviewed: true, label: 'Fayt', category: 'playable_character', tags: ['party'] } },
];
assert.deepEqual(C.sortAssets(items, 'size_desc').map((x) => x.name), ['large', 'small']);
assert.deepEqual(C.sortAssets(items, 'review').map((x) => x.name), ['small', 'large']);
assert.deepEqual(C.filterAssets(items, { text: 'party' }).map((x) => x.name), ['large']);
assert.deepEqual(C.filterAssets(items, { review: 'unreviewed' }).map((x) => x.name), ['small']);
console.log(JSON.stringify({ status: 'PASS', stable_ids: true, annotation_round_trip: true, sorting: true, filtering: true }, null, 2));
