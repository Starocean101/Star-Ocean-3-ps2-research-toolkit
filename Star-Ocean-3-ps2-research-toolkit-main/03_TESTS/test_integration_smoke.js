#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
global.SO3V52Identify = require('../02_SOURCE/v52_identification.js');
global.SO3V53Movie = require('../02_SOURCE/v53_movie_decoder.js');
global.SO3V54Sac = require('../02_SOURCE/v54_sac_decoder.js');
global.SO3V55Mux = require('../02_SOURCE/v55_mpeg_muxer.js');

class Element {
  constructor(id = '') { this.id = id; this.innerHTML = ''; this.textContent = ''; this.className = ''; this.value = 0; this.max = 1; this.onclick = null; this.style = {}; }
  append() {}
  after() {}
  addEventListener() {}
  closest() { return { querySelector: () => elements.commandbar }; }
  querySelector() { return null; }
}

const ids = ['explorerList', 'explorerDetails', 'explorerNav', 'explorerBreadcrumb', 'explorerDownloads', 'openBtn', 'v52IdentifyBtn', 'v52MovieBtn', 'v52StopBtn', 'v52ExportBtn', 'v52Progress', 'v52Status', 'v52Metrics'];
const elements = Object.fromEntries(ids.map((id) => [id, new Element(id)]));
elements.commandbar = new Element('commandbar');
const appTitle = new Element(), appSubtitle = new Element();
global.document = {
  title: '', head: new Element('head'),
  createElement: () => new Element(),
  getElementById: (id) => elements[id] || null,
  querySelector: (selector) => selector === '.appbar h1' ? appTitle : selector === '.appbar p' ? appSubtitle : null,
};
global.localStorage = { data: new Map(), getItem(k) { return this.data.get(k) || null; }, setItem(k, v) { this.data.set(k, v); } };
global.state = {
  iso: { name: 'synthetic.iso', size: 0x100000, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) },
  isoInfo: { chosen: { volumeId: 'SO3_TEST' } },
  hidden: [
    { index: 12, lba: 1, offset: 0x800, size: 0x10000, sectors: 32, runtime: 0, header: 'SO3_MOVIE_CARRIER_CANDIDATE', rawHeaderHex: '77522267B4EFDB84' },
    { index: 40, lba: 40, offset: 0x14000, size: 0x800, sectors: 1, runtime: 0, header: 'MWo3', rawHeaderHex: '4D576F3300000000' },
    { index: 41, lba: 41, offset: 0x14800, size: 0x800, sectors: 1, runtime: 0, header: '5615D527F1BC44AF', rawHeaderHex: '5615D527F1BC44AF' },
    { index: 42, lba: 42, offset: 0x15000, size: 0x800, sectors: 1, runtime: 0, header: '5615D527F1BC44AF', rawHeaderHex: '5615D527F1BC44AF' },
  ],
};
global.classifyHeader = () => 'LEGACY';
global.EXPLORER_VIEWS = { home: { label: 'Home', icon: 'H' }, all: { label: 'All', icon: 'A' }, visible: { label: 'Visible', icon: 'V' }, hidden: { label: 'Hidden', icon: 'H' }, decoded: { label: 'Decoded', icon: 'D' }, archives: { label: 'Archives', icon: 'A' }, compressed: { label: 'Compressed', icon: 'C' }, executables: { label: 'Executables', icon: 'E' }, textures: { label: 'Textures', icon: 'T' }, audio: { label: 'Audio', icon: 'A' }, video: { label: 'Video', icon: 'V' }, text: { label: 'Text', icon: 'T' }, unknown: { label: 'Unknown', icon: 'U' }, priorities: { label: 'Priorities', icon: 'P' } };
global.roleInfo = () => ({ role: 'Unknown binary', category: 'unknown', icon: '?', folderLike: false, description: 'legacy' });
global.explorerItems = () => state.hidden.map((row) => ({ id: `h:${row.index}`, source: 'hidden', name: `Entry ${row.index}`, path: '', type: row.header, size: row.size, index: row.index, raw: row, ...roleInfo(row.header, '', 'hidden') }));
global.viewItems = (view, items) => view === 'priorities' ? [] : items;
global.explorerCounts = () => ({});
global.renderExplorerNav = () => {};
global.renderHome = () => {};
global.renderExplorerDetails = () => {};
global.renderExplorer = () => {};
global.renderHidden = () => {};
global.esc = (x) => String(x);
global.fmt = (x) => String(x);
global.sleep = async () => {};
global.clearBox = () => {};
global.addDownload = () => {};
global.SO3V5Workspace = { state: { nodes: new Map() } };
elements.openBtn.onclick = async () => {};

require('../02_SOURCE/v52_integration.js');

(async () => {
  await elements.openBtn.onclick({});
  assert.equal(document.title, 'SO3 Resource Explorer V5.5.0 — Muxed Cutscenes');
  assert.equal(appTitle.textContent, 'SO3 Resource Explorer V5.5.0');
  assert.equal(state.hidden[0].v52.format, 'SO3_MOVIE_CARRIER_CANDIDATE');
  assert.equal(state.hidden[0].v52.playable, false);
  assert.equal(state.hidden[0].v52.decodable, false);
  assert.equal(state.hidden[1].v52.format, 'MWo3');
  assert.equal(state.hidden[2].v52.format, 'UNKNOWN');
  assert.equal(typeof elements.v52IdentifyBtn.onclick, 'function');
  assert.equal(typeof elements.v52MovieBtn.onclick, 'function');
  assert.equal(typeof global.SO3V53Integration.decodeMovie, 'function');
  const census = global.SO3V53Integration.census();
  assert.equal(census.rows.length, 4);
  assert.equal(census.format, 'SO3_V550_IDENTIFICATION_CENSUS');
  assert.equal(census.version, 5);
  assert.equal(census.summary.verified_movie_carriers, 0);
  assert.equal(census.summary.unknown_classification, 2);
  assert.equal(census.disc.provenance.hidden_layout_sha256.length, 64);
  assert.equal(census.rows[0].metrics.raw_header_hex, '77522267B4EFDB84');
  assert.equal(census.policy.exact_movie_decode_requires_all_carrier_gates, true);

  const terminal = global.SO3V52Identify.meta('SO3_MOVIE_CARRIER_NOT_VERIFIED', {
    category: 'candidates', confidence: 'UNRESOLVED', playable: false, decodable: false,
    evidence: ['deep validation completed'], reasons: ['duplicate-sector gate failed'],
  });
  terminal.metrics = state.hidden[0].v52.metrics;
  terminal.detector = { candidate: { family_marker: true }, recurrence: { complete: true, ratio: 1 }, duplicate_groups: [] };
  state.hidden[0].v52 = terminal;
  await global.SO3V53Integration.identifyUnknowns();
  assert.equal(state.hidden[0].v52, terminal, 'completed movie evidence must not regress');

  const first = global.SO3V53Integration.census(), second = global.SO3V53Integration.census();
  assert.deepEqual(first.rows.map((x) => x.metrics.header_cluster_count), second.rows.map((x) => x.metrics.header_cluster_count));
  assert.equal(first.rows.filter((x) => x.metrics.raw_header_hex === '77522267B4EFDB84')[0].metrics.header_cluster_count, 1);
  assert.equal(first.rows.filter((x) => x.metrics.raw_header_hex === '5615D527F1BC44AF')[0].metrics.header_cluster_count, 2);
  console.log(JSON.stringify({ status: 'PASS', initial_rows: 4, marker_candidate_only: true, exact_decoder_exposed: true, monotonic_movie_state: true, deterministic_clusters: true }, null, 2));
})().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
