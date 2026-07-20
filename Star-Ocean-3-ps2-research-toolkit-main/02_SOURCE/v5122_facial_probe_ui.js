/* SO3 Resource Explorer V5.12.4 facial-evidence audit UI.
 * Native browser integration for the declarative Command Runner and the
 * Runtime Reconstruction tab. JavaScript pasted into Command Runner is not
 * supported; use the built-in button or the facial_selector_evidence_hunt
 * command action. All ISO access is local and read-only.
 */
(function () {
  'use strict';
  const Probe = globalThis.SO3V5122FacialProbe;
  if (!Probe || typeof document === 'undefined') throw new Error('V5.12.2 facial probe engine is required');

  const EXEC_CAP = 8 * 1024 * 1024, FAS_CAP = 2 * 1024 * 1024;
  const q = (id) => document.getElementById(id);
  const html = globalThis.esc || ((value) => String(value).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]));
  const S = { fasScans: [], execScans: [], charAudit: null, errors: [], execSources: new Map(), execKeys: new Set(), fasKeys: new Set(), running: false };
  let attempts = 0;

  function install() {
    const page = q('page-v510runtime');
    if (!page) { if (attempts++ < 40) setTimeout(install, 50); return false; }
    if (!q('v5122ProbeCard')) {
      page.insertAdjacentHTML('beforeend', `
<div class="card" id="v5122ProbeCard">
  <h2>V5.12.4 facial-evidence audit</h2>
  <p class="notice">Actor 0x0BC0's static face-preview gate is <b>RESOLVED</b>. The frame-member selector is instruction-executed and verified. Each facial FIS supplies one logical CSM1 IDTEX4 CLUT; the 32 uploaded PSMCT32 entries form a 16×2 transfer image whose second half-row maps logical colors 8–15. FISP is a separate generic renderer path, not the missing facial palette selector. This audit is bounded, local, read-only, and never changes the Model Lab's selected facial textures.</p>
  <div class="v510-actions"><button id="v5122CompleteHunt" class="action">Run complete evidence hunt</button><button id="v5122ScanIso" class="action secondary">Scan ISO executables only</button></div>
  <div class="v510-grid"><label class="file-button">Executable images (ELF / MWo3)<input id="v5122ExecFiles" type="file" multiple accept=".elf,.mwo3,.bin,application/octet-stream"></label><label class="file-button">FAS clips<input id="v5122FasFiles" type="file" multiple accept=".fas,.bin,application/octet-stream"></label></div>
  <div class="v510-actions"><button id="v5122ScanExecFiles" class="action secondary">Scan selected executables</button><button id="v5122ScanFasFiles" class="action secondary">Scan selected FAS clips</button><button id="v5122ScanFasNodes" class="action ghost">Scan loaded FAS nodes</button><button id="v5122Clear" class="action ghost">Clear probe results</button></div>
  <div id="v5122Status" class="status">Open the PAL Disc 1 ISO, then press <b>Run complete evidence hunt</b>. Do not paste JavaScript into Command Runner; it accepts declarative JSON commands only.</div>
  <div id="v5122Metrics" class="metric-grid"></div><div id="v5122FasTable" class="table-wrap"></div><div id="v5122ExecTable" class="table-wrap"></div><div id="v5122Downloads"></div>
</div>`);
      const style = document.createElement('style'); style.id = 'so3-v5122-styles'; style.textContent = '#v5122Downloads{display:grid;gap:8px;margin-top:8px}#v5122ProbeCard .v5122-gate{color:#176b39;font-weight:800}#v5122FasTable table,#v5122ExecTable table{font-size:11px}'; document.head.append(style);
      bind();
    }
    installCommandHelper();
    return true;
  }

  function status(message, bad = false) { const el = q('v5122Status'); if (!el) return; el.innerHTML = message; el.className = `status${bad ? ' bad' : ''}`; }
  function fmt(value) { return Number(value || 0).toLocaleString(); }
  const yieldFrame = () => new Promise((resolve) => setTimeout(resolve, 0));
  async function digest(bytes) { const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); const hash = await crypto.subtle.digest('SHA-256', view); return Array.from(new Uint8Array(hash), (x) => x.toString(16).padStart(2, '0')).join(''); }
  function u32le(bytes, offset) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true); }
  function download(name, data, type) { if (globalThis.addDownload) return globalThis.addDownload(q('v5122Downloads'), name, data, type); const link = document.createElement('a'); link.className = 'download'; link.download = name; link.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' })); link.textContent = `Download ${name}`; q('v5122Downloads').append(link); }
  function clearDownloads() { const host = q('v5122Downloads'); while (host?.firstChild) host.firstChild.remove(); }
  function workspaceNodes() { const W = globalThis.SO3V5Workspace; return W?.state?.nodes ? [...W.state.nodes.values()] : []; }
  function nodeSize(node) { return Number(node.decodedSize ?? node.storedSize ?? node.size); }
  async function nodePrefix(node, cap) { const size = nodeSize(node); if (!node.provider || !Number.isFinite(size) || size <= 0) throw new Error(`${node.name || node.id} has no readable byte provider`); return { bytes: await node.provider.read(0, Math.min(size, cap)), source_size: size, source_complete: size <= cap }; }
  function safeName(value) { return String(value || 'module').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 140) || 'module'; }
  function pushError(stage, name, error) { S.errors.push({ stage, name, error: error?.message || String(error) }); }

  async function decodeHiddenEntry(row) {
    const B = globalThis.SO3V44MediaBridge, raw = await B.mediaProviderFromIso(row.offset, row.size)(), made = []; let pos = row.header === 'ZLS' ? B.findMagicOffset(raw) : 0;
    if (pos < 0) throw new Error(`Hidden entry ${row.index} has no inner SLZ/SLE stream`);
    for (let block = 0; block < 256 && pos + 16 <= raw.length; block++) {
      const magic = B.td.decode(raw.slice(pos, pos + 3)); if (magic !== 'SLZ' && magic !== 'SLE') break;
      const compressed = B.u32(raw, pos + 4), next = B.u32(raw, pos + 12), total = 16 + compressed;
      if (pos + total > raw.length) throw new Error(`Hidden entry ${row.index}, block ${block} is truncated`);
      const result = await B.decodeChunk(new Blob([raw.slice(pos, pos + total)]), magic === 'SLE' ? B.parseKey(B.finalSleKey) : null);
      made.push({ block, bytes: result.out, wrapper: `${magic}${raw[pos + 3]}` });
      if (!next) break;
      if (next < 16 || pos + next <= pos || pos + next > raw.length) throw new Error(`Hidden entry ${row.index} has invalid next-block offset`);
      pos += next; await yieldFrame();
    }
    return made;
  }

  async function scanExecutable(name, bytes, meta = {}) {
    const sourceSize = Number.isSafeInteger(meta.source_size) ? meta.source_size : bytes.length;
    const scan = Probe.scanExecutableForFacialConstants(bytes, { maxBytes: EXEC_CAP, sourceSize, sourceOffset: 0 });
    const scanned = bytes.subarray(0, scan.module.scanned_byte_size), scannedSha = await digest(scanned);
    const sourceSha = meta.source_complete && bytes.length === sourceSize ? scannedSha : null;
    const key = `${meta.source_kind || 'unknown'}:${name}:${sourceSize}:${scannedSha}`;
    if (S.execKeys.has(key)) return null; S.execKeys.add(key);
    const entry = { name, source_kind: meta.source_kind || 'UNKNOWN', source_size: sourceSize, scanned_size: scanned.length, scanned_range: [0, scanned.length], scanned_sha256: scannedSha, source_sha256: sourceSha, ...scan };
    S.execScans.push(entry); S.execSources.set(name, { bytes: scanned, source_size: sourceSize, complete: scan.module.scan_complete, scanned_sha256: scannedSha }); await yieldFrame(); return entry;
  }

  async function scanFas(name, bytes, meta = {}) {
    const sourceSize = Number.isSafeInteger(meta.source_size) ? meta.source_size : bytes.length, scannedSha = await digest(bytes), key = `${sourceSize}:${scannedSha}`;
    if (S.fasKeys.has(key)) return null; S.fasKeys.add(key);
    const scan = Probe.scanFasNakaEvents(bytes);
    if (sourceSize > bytes.length) scan.boundaries.push(`source coverage is [0, ${bytes.length}) of ${sourceSize} bytes; negative results apply only to this scanned range`);
    const entry = { name, source_kind: meta.source_kind || 'UNKNOWN', source_size: sourceSize, scanned_size: bytes.length, scanned_sha256: scannedSha, source_sha256: sourceSize === bytes.length ? scannedSha : null, ...scan };
    S.fasScans.push(entry); await yieldFrame(); return entry;
  }

  function visibleExecutableRows(B) {
    return (B.state.files || []).filter((row) => {
      if (row.isDir || !row.size) return false;
      const name = String(row.name || row.path || '').split('/').pop();
      return /^(?:SL[EUP][SM]?[_\-.]?\d[\d.]*)$/i.test(name) || /\.elf$/i.test(name);
    }).slice(0, 8);
  }

  async function scanIsoExecutableSources() {
    const B = globalThis.SO3V44MediaBridge, iso = B?.state?.iso, rows = B?.state?.hidden || []; if (!iso) throw new Error('Open the SO3 Disc 1 ISO first');
    let found = 0;
    for (const file of visibleExecutableRows(B)) {
      const size = Number(file.size), read = Math.min(size, EXEC_CAP), name = file.name || file.path;
      status(`Reading visible executable ${html(name)}…`); const bytes = new Uint8Array(await iso.slice(file.offset, file.offset + read).arrayBuffer());
      if (await scanExecutable(name, bytes, { source_kind: 'VISIBLE_ISO_EXECUTABLE', source_size: size, source_complete: size <= EXEC_CAP })) found++;
    }
    for (const node of workspaceNodes().slice(0, 4096)) {
      if (found >= 16 || !node.provider) continue; const label = `${node.name || ''} ${node.id || ''}`;
      if (node.format !== 'ELF' && !/(?:^|[/\\ _.-])SL[EUP][SM]?[_.]?\d/i.test(label)) continue;
      try { status(`Scanning loaded executable node ${html(node.name || node.id)}…`); const input = await nodePrefix(node, EXEC_CAP); if (await scanExecutable(node.name || node.id, input.bytes, { source_kind: 'WORKSPACE_EXECUTABLE_NODE', ...input })) found++; } catch (error) { pushError('workspace_executable', node.name || node.id, error); }
    }
    const overlay = rows.find((row) => row.index === 2 && row.sectors);
    if (overlay) {
      status('Decoding hidden entry 2 locally and scanning its MWo3 load images…');
      for (const item of await decodeHiddenEntry(overlay)) {
        if (item.bytes.length < 0x1000 || String.fromCharCode(...item.bytes.slice(0, 4)) !== 'MWo3') continue;
        const name = `entry_2_block_${item.block}_load_0x${u32le(item.bytes, 8).toString(16).toUpperCase().padStart(8, '0')}.mwo3`;
        status(`Scanning ${html(name)}…`); if (await scanExecutable(name, item.bytes, { source_kind: 'HIDDEN_ENTRY_2_MWO3', source_size: item.bytes.length, source_complete: true })) found++;
      }
    }
    if (!found) throw new Error('No executable candidates were found in the visible ISO filesystem, loaded project nodes, or hidden entry 2');
    return found;
  }

  async function scanLoadedFasNodes() {
    const nodes = workspaceNodes().filter((node) => node.provider && (node.format === 'FAS' || /(?:^|[/\\ _.-])FAS_[0-9A-F]{8}|\.fas$/i.test(`${node.name || ''} ${node.id || ''}`))).slice(0, 64); let count = 0;
    for (const node of nodes) { try { status(`Scanning loaded FAS node ${html(node.name || node.id)}…`); const input = await nodePrefix(node, FAS_CAP); if (await scanFas(node.name || node.id, input.bytes, { source_kind: 'WORKSPACE_FAS_NODE', ...input })) count++; } catch (error) { pushError('workspace_fas', node.name || node.id, error); } }
    return count;
  }

  async function scanIndexedIsoActorEvidence() {
    const A = globalThis.SO3V58Assembler, Index = globalThis.SO3V58ModelIndex, B = globalThis.SO3V44MediaBridge;
    if (!A?.decodeIndexedIsoResource || !Index?.actors) { pushError('indexed_iso', 'model index', new Error('Indexed actor decoder is unavailable')); return 0; }
    const seen = new Set(), animations = [];
    for (const actor of Index.actors) for (const resource of actor.resources || []) if (resource.tag === 'ANIM') { const key = `${resource.entry}:${resource.offset}:${resource.stored_size}`; if (!seen.has(key)) { seen.add(key); animations.push({ actor: actor.actor_id, resource }); } }
    let count = 0;
    for (const item of animations.slice(0, 64)) {
      const r = item.resource, label = `actor_${item.actor}_entry_${r.entry}_${r.res_id || r.offset}.fas`;
      try { status(`Decoding indexed FAS ${html(label)}…`); const decoded = await A.decodeIndexedIsoResource(r, B); if (await scanFas(label, decoded.bytes, { source_kind: 'INDEXED_ISO_FAS', source_size: decoded.bytes.length })) count++; } catch (error) { pushError('indexed_fas', label, error); }
    }
    const actor = Index.actors.find((item) => String(item.actor_id).toUpperCase().replace(/^0X0*/, '') === 'BC0');
    const char = actor?.resources?.find((resource) => resource.tag === 'CHAR');
    if (char) try { status('Decoding indexed actor 0x0BC0 CHAR state…'); const decoded = await A.decodeIndexedIsoResource(char, B), hash = await digest(decoded.bytes); S.charAudit = { name: `actor_${actor.actor_id}_${char.res_id}.char`, source_kind: 'INDEXED_ISO_CHAR', sha256: hash, audit: Probe.auditCharFacialState(decoded.bytes) }; } catch (error) { pushError('indexed_char', 'actor 0x0BC0', error); }
    return count;
  }

  async function auditLoadedCharNode() {
    if (S.charAudit) return; const node = workspaceNodes().find((item) => /03_CHAR_00000BC0/i.test(`${item.name || ''} ${item.id || ''}`) && item.provider); if (!node) return;
    try { const input = await nodePrefix(node, FAS_CAP), hash = await digest(input.bytes); S.charAudit = { name: node.name || node.id, source_kind: 'WORKSPACE_CHAR_NODE', sha256: hash, audit: Probe.auditCharFacialState(input.bytes) }; } catch (error) { pushError('workspace_char', node.name || node.id, error); }
  }

  function bestClusterScan() { return S.execScans.filter((scan) => scan.clusters.length).sort((a, b) => b.clusters.reduce((n, c) => n + c.targets.length + (c.small_frame_cmp_nearby ? 1 : 0), 0) - a.clusters.reduce((n, c) => n + c.targets.length + (c.small_frame_cmp_nearby ? 1 : 0), 0))[0] || null; }

  async function finish(summary) {
    await auditLoadedCharNode(); const created = new Date().toISOString();
    const report = Probe.buildProbeReport({ created, fas: S.fasScans, executables: S.execScans, charAudit: S.charAudit?.audit || null });
    report.version = 4; report.producer = 'SO3 Resource Explorer V5.12.4'; report.gate_status = 'RESOLVED_ACTOR_0x0BC0_STATIC_FACE_PREVIEW'; report.promotion = true;
    report.verified_runtime_facts = { fas_type_0x0021_binding: 'payload naka/id is bound to the matching facial selector; evaluator 0x004B5500 writes selector+0x48 at 0x004B5570', fisa_member_selection: 'routine 0x004D7BB0 executed over both actor 0x0BC0 FISA families', selected_fis_upload: 'runtime node+0x28 is passed to texture lookup/upload at 0x004685B0' };
    report.verified_fixture_facts = { facial_fis_ids: [1294,1295,1296,2413,2414,2415,3362], stored_palette_upload: 'PSMCT32 16x2, 32 entries', gs_consumer: 'CSM1 IDTEX4 8x2, 16 logical colors', logical_to_stored_palette_index: [0,1,2,3,4,5,6,7,16,17,18,19,20,21,22,23], palette_variant_selector: 'NOT_APPLICABLE_ONE_LOGICAL_CSM1_CLUT_PER_FIS', former_entries_8_15_and_24_31: 'transfer-row padding for this IDTEX4 use, not two palette banks' };
    report.hypotheses_not_promoted = ["The Atlas registry's second tag name 'nakam' is a misparse of 'naka' followed by an id low byte 0x6D (2413 family).", 'The shared TEX0 high-register value 2869 is an actor/upload-group handle; its exact non-selector meaning remains unresolved.'];
    report.remaining_boundaries = ['The static Model Lab holds each family at its base frame because FAS animation-clock playback is not implemented.', 'This promotion is scoped to the observed actor 0x0BC0 facial FIS layout; other texture layouts remain format-gated.'];
    report.collection = { mode: 'EXPLORER_NATIVE_V5124_EVIDENCE_AUDIT', executable_cap_bytes: EXEC_CAP, fas_cap_bytes: FAS_CAP, errors: S.errors };
    report.v5124_mechanism_closure = { confidence: 'VERIFIED', promotion: true, scope: 'actor 0x0BC0 static Model Lab face preview', frame_selector: { routine_va: '0x004D7BB0', counter_source_write_va: '0x004B5570', selected_fis_destination: 'runtime node +0x28', execution_report: 'SO3_FACIAL_SELECTOR_R5900_EXECUTION_REPORT.json' }, palette_variant_selector: 'NOT_APPLICABLE_ONE_LOGICAL_CSM1_CLUT_PER_FIS', corrected_clut_mapping: [0,1,2,3,4,5,6,7,16,17,18,19,20,21,22,23], fisp_correction: 'V5.12.3 FISP-as-facial-palette claim superseded; FISP is retained only as a generic renderer-context diagnostic.' };
    if (S.charAudit) report.char_fixture = { name: S.charAudit.name, source_kind: S.charAudit.source_kind, sha256: S.charAudit.sha256 };
    const best = bestClusterScan(), bestSource = best ? S.execSources.get(best.name) : null;
    report.best_cluster_module = best ? { name: best.name, source_kind: best.source_kind, source_size: best.source_size, scanned_size: best.scanned_size, scanned_sha256: best.scanned_sha256, source_sha256: best.source_sha256, scan_complete: best.module.scan_complete, clusters: best.clusters } : null;
    const atlas = { format: 'SO3_ATLAS_FACIAL_CLUT_REPAIR_UPDATE', version: 4, producer: 'SO3 Resource Explorer V5.12.4', created, gate: Probe.GATE, gate_status: 'RESOLVED_ACTOR_0x0BC0_STATIC_FACE_PREVIEW', promotion: true, promotion_scope: 'actor 0x0BC0 static Model Lab decoding', records: [
      { kind: 'FAS_NAKA_EVENTS_STRUCTURAL', scans: S.fasScans.map((entry) => ({ name: entry.name, source_kind: entry.source_kind, source_size: entry.source_size, scanned_size: entry.scanned_size, scanned_sha256: entry.scanned_sha256, event_count: entry.event_count, family_base_ids_referenced: entry.family_base_ids_referenced, semantics_confidence: 'UNRESOLVED', boundaries: entry.boundaries })) },
      { kind: 'EXECUTABLE_CONSTANT_CLUSTERS_CANDIDATE', scans: S.execScans.map((entry) => ({ name: entry.name, source_kind: entry.source_kind, source_size: entry.source_size, scanned_size: entry.scanned_size, scanned_sha256: entry.scanned_sha256, source_sha256: entry.source_sha256, scan_complete: entry.module.scan_complete, hit_count: entry.hit_count, cluster_count: entry.clusters.length, boundaries: entry.boundaries, promotion: false })) },
      { kind: 'FACIAL_FRAME_SELECTOR_EXECUTED', confidence: 'VERIFIED', routine_va: '0x004D7BB0', input_write_va: '0x004B5570', output: 'selected FIS pointer at runtime node+0x28' },
      { kind: 'CSM1_IDTEX4_LOGICAL_CLUT_REPAIR', confidence: 'VERIFIED', facial_fis_ids: [1294,1295,1296,2413,2414,2415,3362], source_upload: 'PSMCT32 16x2', logical_clut: 'IDTEX4 CSM1 8x2', logical_to_stored_palette_index: [0,1,2,3,4,5,6,7,16,17,18,19,20,21,22,23], logical_palette_count_per_fis: 1 },
      { kind: 'FISP_FACIAL_ASSOCIATION_RETRACTED', confidence: 'VERIFIED_NEGATIVE_SCOPED_TO_CAPTURED_EVIDENCE', previous_claim: 'FISP byte +2 selects actor 0x0BC0 facial palette bank', correction: 'The executed TEX0 high-byte transform is generic and returned FISP instances are not associated with actor 0x0BC0, naka, or FISA. CSA is a temporary CLUT-cache destination, not evidence of a second embedded palette.' },
      { kind: 'REGISTRY_HYGIENE_CANDIDATE', notes: ["formats[1] type_0x0021 tag 'nakam' is a candidate misparse of 'naka' plus a u16 id whose low byte is 0x6D.", 'Raw sub-block mark bytes are 00 01 (data) and 01 0C (event); the registry text mixes endian presentations.'] },
    ], collection_errors: S.errors, automatic_engine_wide_generalization_allowed: false, remaining_boundary: 'Automatic FAS animation-clock playback is not implemented.' };

    render(report); clearDownloads();
    const enc = new TextEncoder(), reportBytes = enc.encode(JSON.stringify(report, null, 2)), atlasBytes = enc.encode(JSON.stringify(atlas, null, 2));
    const readmeBytes = enc.encode('SO3 V5.12.4 facial-evidence audit. Actor 0x0BC0 uses one logical CSM1 IDTEX4 CLUT per facial FIS. Logical colors 0–7 use stored PSMCT32 entries 0–7 and colors 8–15 use entries 16–23. The V5.12.3 FISP facial-palette claim is superseded. Frame selection remains instruction-executed and verified; automatic FAS animation-clock playback is outside this pass.\n');
    const members = [{ name: 'SO3_FACIAL_EVIDENCE_AUDIT_REPORT.json', data: reportBytes }, { name: 'SO3_ATLAS_FACIAL_CLUT_REPAIR_UPDATE.json', data: atlasBytes }, { name: 'README.txt', data: readmeBytes }];
    if (bestSource) { const suffix = bestSource.complete ? '' : `_scanned_prefix_0x0_0x${bestSource.bytes.length.toString(16).toUpperCase()}`; members.push({ name: `best_module/${safeName(best.name)}${suffix}.bin`, data: bestSource.bytes }); }
    const sums = []; for (const member of members) sums.push(`${await digest(member.data)}  ${member.name}`); const sumsBytes = enc.encode(`${sums.join('\n')}\n`); members.push({ name: 'SHA256SUMS.txt', data: sumsBytes });
    download('SO3_FACIAL_EVIDENCE_AUDIT_REPORT.json', reportBytes, 'application/json'); download('SO3_ATLAS_FACIAL_CLUT_REPAIR_UPDATE.json', atlasBytes, 'application/json');
    if (bestSource) download(`${safeName(best.name)}${bestSource.complete ? '' : '_SCANNED_PREFIX'}.bin`, bestSource.bytes, 'application/octet-stream');
    const zipper = globalThis.makeStoreZip || (typeof makeStoreZip === 'function' ? makeStoreZip : null); if (zipper) download('SO3_V5124_FACIAL_EVIDENCE_AUDIT.zip', zipper(members), 'application/zip');
    const clusters = S.execScans.reduce((n, scan) => n + scan.clusters.length, 0), events = S.fasScans.reduce((n, scan) => n + scan.event_count, 0);
    status(clusters ? `<b>${clusters} candidate constant cluster(s) located</b> — best module: <code>${html(best.name)}</code>. <span class="v5122-gate">The actor 0x0BC0 static face-preview gate remains RESOLVED.</span>` : `${html(summary)} ${S.execScans.length} executable image(s), ${events} naka event(s), zero qualifying clusters. Negative results are limited to the explicit scanned ranges. <span class="v5122-gate">The actor 0x0BC0 static face-preview gate is RESOLVED.</span>`);
    return { executables: S.execScans.length, fas_scans: S.fasScans.length, events, clusters, errors: S.errors.length, best_module: best?.name || null };
  }

  function resetState() { S.fasScans = []; S.execScans = []; S.charAudit = null; S.errors = []; S.execSources.clear(); S.execKeys.clear(); S.fasKeys.clear(); }
  async function runCompleteEvidenceHunt() {
    if (S.running) throw new Error('A facial-selector hunt is already running'); const B = globalThis.SO3V44MediaBridge; if (!B?.state?.iso) throw new Error('Open the SO3 Disc 1 ISO first');
    S.running = true; resetState(); clearDownloads();
    try { status('Collecting visible SLES/SLUS, loaded ELF nodes, and hidden-entry-2 MWo3 modules…'); await scanIsoExecutableSources(); status('Scanning indexed ISO animation resources and actor 0x0BC0 CHAR state…'); await scanIndexedIsoActorEvidence(); await scanLoadedFasNodes(); return await finish('Complete evidence hunt finished.'); }
    finally { S.running = false; }
  }
  async function scanIsoExecutables() { resetState(); clearDownloads(); const count = await scanIsoExecutableSources(); return finish(`Scanned ${count} executable image(s) from the open ISO.`); }
  async function scanExecFileList() { resetState(); clearDownloads(); const files = [...q('v5122ExecFiles').files]; if (!files.length) throw new Error('Choose at least one ELF or MWo3 image'); for (const file of files.slice(0, 16)) { status(`Scanning ${html(file.name)}…`); const read = Math.min(file.size, EXEC_CAP), bytes = new Uint8Array(await file.slice(0, read).arrayBuffer()); await scanExecutable(file.name, bytes, { source_kind: 'SELECTED_EXECUTABLE_FILE', source_size: file.size, source_complete: file.size <= EXEC_CAP }); } return finish(`Scanned ${Math.min(files.length, 16)} selected executable image(s).`); }
  async function scanFasFileList() { resetState(); clearDownloads(); const files = [...q('v5122FasFiles').files]; if (!files.length) throw new Error('Choose at least one FAS clip'); for (const file of files.slice(0, 64)) { const read = Math.min(file.size, FAS_CAP), bytes = new Uint8Array(await file.slice(0, read).arrayBuffer()); status(`Scanning ${html(file.name)}…`); await scanFas(file.name, bytes, { source_kind: 'SELECTED_FAS_FILE', source_size: file.size }); } return finish(`Scanned ${Math.min(files.length, 64)} selected FAS clip(s).`); }
  async function scanFasNodesOnly() { resetState(); clearDownloads(); const count = await scanLoadedFasNodes(); if (!count) throw new Error('No loaded FAS nodes were found. Use Run complete evidence hunt to decode indexed FAS resources directly from the open ISO.'); return finish(`Scanned ${count} loaded FAS node(s).`); }

  function render() {
    const fasEvents = S.fasScans.flatMap((entry) => entry.events.map((event) => ({ file: entry.name, ...event }))), clusters = S.execScans.flatMap((entry) => entry.clusters.map((cluster) => ({ file: entry.name, complete: entry.module.scan_complete, ...cluster })));
    q('v5122Metrics').innerHTML = [['FAS resources', S.fasScans.length], ['naka events', fasEvents.length], ['Executables', S.execScans.length], ['Constant clusters', clusters.length], ['Collection errors', S.errors.length]].map(([label, value]) => `<div class="metric"><b>${html(fmt(value))}</b><span>${html(label)}</span></div>`).join('');
    q('v5122FasTable').innerHTML = fasEvents.length ? `<table><thead><tr><th>Clip</th><th>Header</th><th>Tag</th><th>id</th><th>Family</th><th>Channel</th></tr></thead><tbody>${fasEvents.slice(0, 64).map((event) => `<tr><td>${html(event.file)}</td><td><code>0x${event.header_off.toString(16).toUpperCase()}</code></td><td><code>${html(event.tag)}</code></td><td>${event.id}</td><td>${event.is_family_base_id ? '<b>base</b>' : event.is_family_id ? 'member' : '—'}</td><td>${event.channel ? `${html(event.channel.name || '?')} #${event.channel.id}` : '—'}</td></tr>`).join('')}</tbody></table>` : '';
    q('v5122ExecTable').innerHTML = S.execScans.length ? `<table><thead><tr><th>Module</th><th>Coverage</th><th>Clusters</th><th>Boundaries</th></tr></thead><tbody>${S.execScans.map((entry) => `<tr><td>${html(entry.name)}</td><td>${fmt(entry.scanned_size)} / ${fmt(entry.source_size)}${entry.module.scan_complete ? ' complete' : ' prefix'}</td><td>${entry.clusters.length}</td><td class="path">${html(entry.boundaries.join(' | ') || 'complete')}</td></tr>`).join('')}</tbody></table>` : '';
  }

  function clear() { resetState(); q('v5122Metrics').innerHTML = ''; q('v5122FasTable').innerHTML = ''; q('v5122ExecTable').innerHTML = ''; clearDownloads(); status('Audit results cleared. Inputs remain local. The corrected actor 0x0BC0 CSM1 face-preview gate remains resolved.'); }
  function handle(fn) { return async () => { try { await fn(); } catch (error) { status(html(error.message), true); console.error(error); } }; }
  function bind() { q('v5122CompleteHunt').onclick = handle(runCompleteEvidenceHunt); q('v5122ScanIso').onclick = handle(scanIsoExecutables); q('v5122ScanExecFiles').onclick = handle(scanExecFileList); q('v5122ScanFasFiles').onclick = handle(scanFasFileList); q('v5122ScanFasNodes').onclick = handle(scanFasNodesOnly); q('v5122Clear').onclick = clear; }

  function huntCommand() { return { format: 'SO3_COMMAND_SCRIPT', version: 1, name: 'SO3 V5.12.4 facial evidence audit', requires: { tool_version: '5.12.4', disc: 'SO3_PAL_DISC1' }, settings: { continue_on_error: false }, commands: [{ action: 'facial_selector_evidence_hunt' }] }; }
  function fispCommand() { return { format: 'SO3_COMMAND_SCRIPT', version: 1, name: 'SO3 V5.12.4 generic FISP renderer-context scan', requires: { tool_version: '5.12.4', disc: 'SO3_PAL_DISC1' }, settings: { continue_on_error: false }, commands: [{ action: 'assert_hidden_signature' }, { action: 'extract_fisp_palette_evidence', scope: 'all', alignment: 4, max_allocation_mb: 64, max_section_mb: 4, max_matches: 128 }] }; }
  function installCommandHelper() {
    const example = q('commandExampleBtn'); if (!example || q('v5122CommandExampleBtn')) return;
    const button = document.createElement('button'); button.id = 'v5122CommandExampleBtn'; button.className = 'action ghost'; button.textContent = 'Load facial hunt command';
    button.onclick = () => { q('commandText').value = JSON.stringify(huntCommand(), null, 2); q('commandDryRunBtn')?.click(); };
    example.insertAdjacentElement('afterend', button);
    const fisp = document.createElement('button'); fisp.id = 'v5123FispCommandBtn'; fisp.className = 'action ghost'; fisp.textContent = 'Load generic FISP context command';
    fisp.onclick = () => { q('commandText').value = JSON.stringify(fispCommand(), null, 2); q('commandDryRunBtn')?.click(); };
    button.insertAdjacentElement('afterend', fisp);
  }

  globalThis.SO3V5122FacialProbeUI = Object.freeze({ VERSION: '5.12.4', runCompleteEvidenceHunt, huntCommand, fispCommand });
  install();
})();
