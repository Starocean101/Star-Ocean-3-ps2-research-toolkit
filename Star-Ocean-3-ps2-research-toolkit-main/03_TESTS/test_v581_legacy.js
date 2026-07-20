#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const Claims = require('../02_SOURCE/v581_legacy_claims.js');
const Legacy = require('../02_SOURCE/v581_legacy_integration.js');
const Catalog = require('../02_SOURCE/v58_asset_catalog.js');

assert.equal(Claims.DATA.summary.claims, 156);
assert.equal(Claims.DATA.summary.top_level_claims, 10);
assert.equal(Claims.DATA.summary.child_claims, 146);
assert.equal(Claims.DATA.summary.range_claims, 1);
assert.equal(Claims.DATA.summary.conflicting_keys, 1);
assert.equal(Claims.DATA.source.sha256, 'a8ffe9ef3ffecc27ebe87dd452271ffed6d1d9b4d8ee42903054a961325c1cab');

assert.equal(Claims.claimsFor(1, 3882, null)[0].label, 'Fayt');
assert.equal(Claims.claimsFor(2, 3246, 13)[0].label, 'Clair');
assert.deepEqual(Claims.conflictsFor(2, 1160, 33)[0].labels, ['Nel Hi-poly', 'Woltar']);
assert.equal(Legacy.inferDisc({ name: 'Star Ocean Disc 2.iso' }), 2);
assert.equal(Legacy.inferDisc({ volume_id: 'SLES_820.28' }), 1);
assert.equal(Legacy.inferDisc({ name: 'unknown.iso' }), null);

const d1 = Legacy.claimsForAsset({ source: 'hidden', index: 3882 }, 1);
assert.equal(Legacy.displaySummary(d1), 'Fayt');
const parent = Legacy.claimsForAsset({ source: 'hidden', index: 3246 }, 2);
assert(parent.some((x) => x.child === 1 && x.label === 'Adray'));
assert(parent.some((x) => x.child === 13 && x.label === 'Clair'));
assert.equal(Legacy.claimsForAsset({ source: 'hidden', index: 3882 }, null).length, 0);
assert.equal(Legacy.claimsForAsset({ source: 'visible', index: 3882 }, 1).length, 0);

const filtered = Catalog.filterAssets([{ name: 'entry 3246', type: 'unknown', role: '', legacySearchText: 'Clair Adray', annotation: { tags: [] } }], { text: 'clair' });
assert.equal(filtered.length, 1);
console.log(JSON.stringify({ status: 'PASS', claims: 156, conflict_preserved: true, disc_gate: true, catalogue_search: true }, null, 2));
