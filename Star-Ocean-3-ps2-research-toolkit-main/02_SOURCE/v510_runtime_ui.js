/* SO3 Resource Explorer V5.10.1 browser-only targeted runtime reconstruction lab. */
(function () {
  'use strict';
  const Runtime = globalThis.SO3V510TargetRuntime, Movie = globalThis.SO3V53Movie;
  if (!Runtime || !Movie || typeof document === 'undefined') throw new Error('V5.10.1 runtime and verified movie decoder are required');
  const q = (id) => document.getElementById(id), html = globalThis.esc || ((value) => String(value).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]));
  const S = { result: null, libSource: null, carrierSource: null };

  function install() {
    if (q('page-v510runtime') || !q('tabs') || !q('page-reports')) return false;
    const oldTab = document.querySelector('[data-page="v590capture"]'), oldPage = q('page-v590capture'); if (oldTab) oldTab.hidden = true; if (oldPage) oldPage.hidden = true;
    q('tabs').insertAdjacentHTML('beforeend', '<button class="tab" data-page="v510runtime">Runtime Reconstruction</button>');
    q('page-reports').insertAdjacentHTML('beforebegin', `
<section id="page-v510runtime" class="page">
  <div class="card v510-hero"><div><h2>V5.10.1 targeted runtime reconstruction</h2><p>Execute a proven SO3 R5900 routine from the supplied game module entirely inside this browser. No PCSX2, Cheat Engine, laptop, server execution, or runtime capture is used.</p></div><span class="v510-badge">V5.10.1</span></div>
  <div class="card">
    <h2>Inputs</h2>
    <p class="notice">This is a bounded execution harness, not a full PS2 emulator. V5.10.1 supports the verified movie transform at Lib VA <code>0x0041A2F0</code> and stops on any unsupported instruction.</p>
    <div class="v510-grid"><label class="file-button">Lib.elf or decoded Lib MWo3<input id="v510LibFile" type="file" accept=".elf,.mwo3,.bin,application/octet-stream"></label><label class="file-button">SO3 movie carrier<input id="v510CarrierFile" type="file" accept=".bin,.dat,.pss,.mpg,application/octet-stream"></label></div>
    <div class="v510-actions"><button id="v510ExecuteIso" class="action">Run directly from open ISO</button><button id="v510ExecuteFiles" class="action secondary">Execute selected files</button><button id="v510ExecuteWorkspace" class="action ghost">Use expanded project nodes</button><button id="v510CancelClear" class="action ghost">Clear results</button></div>
    <div id="v510Status" class="status">Open the SO3 Disc 1 ISO, then press <b>Run directly from open ISO</b>. The lab locally decodes hidden entry 2, selects its Lib MWo3 block by load address, and reads the first frame of a known movie carrier.</div>
    <div id="v510Metrics" class="metric-grid"></div>
  </div>
  <div class="card">
    <h2>Execution proof</h2>
    <div id="v510Proof" class="status">No routine executed.</div>
    <div id="v510Calls" class="table-wrap"></div>
    <details><summary>Instruction trace preview</summary><div id="v510Trace" class="table-wrap"></div></details>
    <details><summary>Mapped memory regions</summary><pre id="v510Memory">No memory map.</pre></details>
  </div>
  <div class="card v510-download-card"><h2>Evidence exports</h2><p class="help">The MPEG-PS fragment comes from guest instruction execution. The clean ZIP records the module hash, complete-trace commitment, implemented boundaries, and explicit host-service stubs.</p><div id="v510Downloads"></div></div>
</section>`);
    const style = document.createElement('style'); style.id = 'so3-v510-styles'; style.textContent = `
      .v510-hero{display:flex;justify-content:space-between;align-items:center;gap:16px;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 13%,var(--panel)),var(--panel))}.v510-hero h2{margin:0 0 6px}.v510-badge{display:inline-flex;border:1px solid currentColor;border-radius:999px;padding:5px 10px;font-weight:800;color:var(--accent);white-space:nowrap}.v510-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.v510-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.v510-actions>*{min-height:44px;margin:0}.v510-good{color:#197a43;font-weight:800}.v510-bad{color:#b42318;font-weight:800}.v510-download-card{scroll-margin-bottom:max(760px,65vh)}#v510Downloads{display:grid;gap:8px}#v510Trace table{font-size:10px}#v510Trace td{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
      @media(max-width:700px){.v510-hero{align-items:flex-start}.v510-grid{grid-template-columns:1fr}.v510-actions{display:grid;grid-template-columns:1fr}.v510-actions>*{width:100%}#page-v510runtime{padding-bottom:calc(max(760px,65vh) + env(safe-area-inset-bottom))}.v510-download-card,#v510Downloads,.v510-download-card .download{scroll-margin-bottom:max(760px,65vh)}}`;
    document.head.append(style); document.querySelector('[data-page="v510runtime"]').onclick = () => globalThis.switchPage ? globalThis.switchPage('v510runtime') : switchPage('v510runtime'); bind(); brand(); return true;
  }
  function brand() { if (globalThis.SO3ApplyCurrentBrand) return globalThis.SO3ApplyCurrentBrand(); document.title = 'SO3 Resource Explorer V5.10.1 — Browser Runtime Reconstruction'; const title = document.querySelector('.appbar h1'), subtitle = document.querySelector('.appbar p'); if (title) title.textContent = 'SO3 Resource Explorer V5.10.1'; if (subtitle) subtitle.textContent = 'V5.10 preserved • module-bound and trace-committed browser execution evidence • offline and read-only.'; }
  function status(message, bad = false) { q('v510Status').innerHTML = message; q('v510Status').className = `status${bad ? ' bad' : ''}`; }
  function fmt(value) { return Number(value || 0).toLocaleString(); }
  function clearDownloads() { const host = q('v510Downloads'); while (host.firstChild) host.firstChild.remove(); }
  function download(name, data, type = 'application/octet-stream') { if (globalThis.addDownload) return globalThis.addDownload(q('v510Downloads'), name, data, type); const link = document.createElement('a'); link.className = 'download'; link.download = name; link.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type })); link.textContent = `Download ${name}`; q('v510Downloads').append(link); }
  async function digest(bytes) { const hash = await crypto.subtle.digest('SHA-256', bytes); return Array.from(new Uint8Array(hash), (x) => x.toString(16).padStart(2, '0')).join(''); }
  async function fileBytes(file) { if (!file) throw new Error('Required file is not selected'); return new Uint8Array(await file.arrayBuffer()); }
  async function nodeBytes(node, limit) { const size = Math.min(Number(node.decodedSize ?? node.storedSize ?? node.size), limit ?? Infinity); if (!node.provider || !Number.isFinite(size) || size <= 0) throw new Error(`${node.name || node.id} has no readable byte provider`); return node.provider.read(0, size); }

  async function uploadedInputs() { const libFile = q('v510LibFile').files[0], carrierFile = q('v510CarrierFile').files[0]; if (!libFile || !carrierFile) throw new Error('Choose both Lib.elf and a movie carrier'); return { lib: await fileBytes(libFile), carrier: await fileBytes(carrierFile), libName: libFile.name, carrierName: carrierFile.name, source: 'USER_SELECTED_BROWSER_FILES' }; }
  async function workspaceInputs() {
    const W = globalThis.SO3V5Workspace, nodes = W?.state?.nodes ? [...W.state.nodes.values()] : []; if (!nodes.length) throw new Error('Open the SO3 ISO and expand its decoded executable/movie nodes first');
    const libNode = nodes.find((node) => /(?:^|[/\\ _.-])lib(?:\.elf)?$/i.test(`${node.name || ''} ${node.path || ''}`)) || nodes.find((node) => node.format === 'ELF' && /lib/i.test(`${node.name || ''} ${node.id || ''}`));
    const carrierNode = nodes.find((node) => node.format === 'SO3_MOVIE_CARRIER' && node.provider) || nodes.find((node) => /movie.*carrier|entry[-_ ](?:15|21)/i.test(`${node.name || ''} ${node.id || ''}`) && node.provider);
    if (!libNode || !carrierNode) throw new Error(`Browser project search found ${libNode ? 'Lib.elf' : 'no Lib.elf'} and ${carrierNode ? 'a carrier' : 'no verified carrier'}. Expand/decode those nodes or use the file selectors.`);
    status(`Reading ${html(libNode.name || libNode.id)} and the first 0x4000 bytes of ${html(carrierNode.name || carrierNode.id)}…`); return { lib: await nodeBytes(libNode, 4 * 1024 * 1024), carrier: await nodeBytes(carrierNode, 0x4000), libName: libNode.name || libNode.id, carrierName: carrierNode.name || carrierNode.id, source: 'CURRENT_BROWSER_PROJECT_NODES' };
  }

  async function decodeIsoWrapper(row) {
    const B = globalThis.SO3V44MediaBridge, raw = await B.mediaProviderFromIso(row.offset, row.size)(), made = []; let pos = row.header === 'ZLS' ? B.findMagicOffset(raw) : 0;
    if (pos < 0) throw new Error(`Hidden entry ${row.index} has no inner SLZ/SLE stream`);
    for (let block = 0; block < 256 && pos + 16 <= raw.length; block++) { const magic = B.td.decode(raw.slice(pos, pos + 3)); if (magic !== 'SLZ' && magic !== 'SLE') break; const compressed = B.u32(raw, pos + 4), next = B.u32(raw, pos + 12), total = 16 + compressed; if (pos + total > raw.length) throw new Error(`Hidden entry ${row.index}, block ${block} is truncated`); const result = await B.decodeChunk(new Blob([raw.slice(pos, pos + total)]), magic === 'SLE' ? B.parseKey(B.finalSleKey) : null); made.push({ block, bytes: result.out, wrapper: `${magic}${raw[pos + 3]}` }); if (!next) break; if (next < 16 || pos + next <= pos || pos + next > raw.length) throw new Error(`Hidden entry ${row.index} has invalid next-block offset`); pos += next; }
    if (!made.length) throw new Error(`Hidden entry ${row.index} did not decode`); return made;
  }
  function u32le(bytes, offset) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true); }
  async function directIsoInputs() {
    const B = globalThis.SO3V44MediaBridge, iso = B?.state?.iso, rows = B?.state?.hidden || []; if (!iso || !rows.length) throw new Error('Open the SO3 Disc 1 ISO first'); const overlay = rows.find((row) => row.index === 2 && row.sectors); if (!overlay) throw new Error('Disc 1 hidden entry 2 is unavailable');
    status('Decoding hidden entry 2 locally and locating the Lib MWo3 load image…'); const blocks = await decodeIsoWrapper(overlay), libBlock = blocks.find((item) => item.bytes.length >= 0x20 && String.fromCharCode(...item.bytes.slice(0, 4)) === 'MWo3' && u32le(item.bytes, 8) === 0x003e6880); if (!libBlock) throw new Error('Entry 2 decoded, but no Lib MWo3 block with load address 0x003E6880 was found');
    const carrierRows = rows.filter((row) => [15, 21].includes(row.index) && row.sectors && row.size >= 0x4000); for (const row of carrierRows) { const head = new Uint8Array(await iso.slice(row.offset, row.offset + 8).arrayBuffer()); if (Array.from(head).map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase() !== '77522267B4EFDB84') continue; return { lib: libBlock.bytes, carrier: new Uint8Array(await iso.slice(row.offset, row.offset + 0x4000).arrayBuffer()), libName: `entry_2_block_${libBlock.block}_Lib.mwo3`, carrierName: `hidden_entry_${row.index}_frame_0`, source: 'OPEN_ISO_DIRECT_BROWSER_DECODE' }; }
    throw new Error('Known entries 15/21 did not expose the expected SO3 movie-family marker');
  }

  async function execute(inputs) {
    if (inputs.carrier.length < 0x4000) throw new Error('Carrier must contain at least one complete 0x4000-byte frame'); status('Mapping Lib.elf and executing guest R5900 instructions locally…'); clearDownloads();
    const runtime = Runtime.runMovieTransform(inputs.lib, inputs.carrier, { length: 0x4000, traceLimit: 1200, moduleName: inputs.libName }), reference = Movie.decodeBytes(inputs.carrier.subarray(0, 0x4000)), exact = reference.length === runtime.output.length && reference.every((value, index) => value === runtime.output[index]), moduleSha = await digest(inputs.lib), inputSha = await digest(inputs.carrier.subarray(0, 0x4000)), outputSha = await digest(runtime.output), referenceSha = await digest(reference), traceSha = await digest(runtime.traceCommitmentInput);
    const report = runtime.report; report.created = new Date().toISOString(); report.source_mode = inputs.source; report.module_image = { name: inputs.libName, byte_size: inputs.lib.length, sha256: moduleSha, format: report.elf.format, load_address: report.elf.load_address || null, segments: report.elf.segments }; report.input.name = inputs.carrierName; report.input.sha256 = inputSha; report.elf.name = inputs.libName; report.output.sha256 = outputSha; report.output.reference_sha256 = referenceSha; report.output.byte_exact_reference_match = exact; report.output.reference = 'V5.3 translated decoder'; report.execution.trace_commitment_sha256 = traceSha;
    report.promotion = exact && report.output.mpeg_pack_at_zero ? 'VERIFIED_TARGET_ROUTINE_EXECUTION' : 'FAILED_RUNTIME_COMPARISON'; S.result = { runtime, report }; render(report);
    const atlas = { format: 'SO3_ATLAS_RUNTIME_RECONSTRUCTION_UPDATE', version: 2, producer: report.producer, created: report.created, records: [{ module: inputs.libName, module_sha256: moduleSha, module_entry: report.routine.entry_va, input_sha256: inputSha, output_sha256: outputSha, instruction_count: report.execution.instruction_count, trace_records_committed: report.execution.trace_records_committed, trace_commitment_sha256: traceSha, explicit_stubs: report.routine.external_stubs, output_artifact_kind: report.output.artifact_kind, byte_exact_reference_match: exact, promotion: report.promotion }], automatic_engine_wide_generalization_allowed: false };
    const fragmentName = 'SO3_RUNTIME_EXECUTED_MPEG_PS_FRAGMENT_0000.mpg', reportName = 'SO3_TARGETED_RUNTIME_EXECUTION_REPORT.json', atlasName = 'SO3_ATLAS_RUNTIME_RECONSTRUCTION_UPDATE.json', reportBytes = new TextEncoder().encode(JSON.stringify(report, null, 2)), atlasBytes = new TextEncoder().encode(JSON.stringify(atlas, null, 2)), readmeBytes = new TextEncoder().encode('SO3 V5.10.1 browser runtime evidence. The MPG member is one 0x4000-byte MPEG-PS execution fragment, not a complete standalone movie. The ZIP is generated in-browser from an explicit member list and contains no platform metadata sidecars.\n'), sumsBytes = new TextEncoder().encode(`${outputSha}  ${fragmentName}\n${await digest(reportBytes)}  ${reportName}\n${await digest(atlasBytes)}  ${atlasName}\n${await digest(readmeBytes)}  README.txt\n`);
    download(fragmentName, runtime.output, 'video/mpeg'); download(reportName, reportBytes, 'application/json'); download(atlasName, atlasBytes, 'application/json');
    const zipper = globalThis.makeStoreZip || (typeof makeStoreZip === 'function' ? makeStoreZip : null); if (!zipper) throw new Error('Clean ZIP builder is unavailable'); download('SO3_V5101_RUNTIME_EVIDENCE.zip', zipper([{ name: fragmentName, data: runtime.output }, { name: reportName, data: reportBytes }, { name: atlasName, data: atlasBytes }, { name: 'README.txt', data: readmeBytes }, { name: 'SHA256SUMS.txt', data: sumsBytes }]), 'application/zip');
    status(exact ? `<b>Runtime execution passed:</b> ${fmt(report.execution.instruction_count)} guest instructions produced a byte-exact match with the independent decoder.` : '<b>Runtime execution failed its byte-exact comparison.</b>', !exact);
  }
  function render(report) {
    q('v510Metrics').innerHTML = [['Guest instructions', fmt(report.execution.instruction_count)], ['Guest output', fmt(report.output.bytes)], ['Explicit stubs', report.execution.calls.length], ['Trace committed', fmt(report.execution.trace_records_committed)]].map(([label,value]) => `<div class="metric"><b>${html(value)}</b><span>${html(label)}</span></div>`).join('');
    q('v510Proof').innerHTML = `<span class="${report.output.byte_exact_reference_match ? 'v510-good' : 'v510-bad'}">${report.output.byte_exact_reference_match ? 'BYTE-EXACT PASS' : 'FAILED'}</span><br>Routine: <code>${html(report.routine.entry_va)}</code> • output SHA-256: <code>${html(report.output.sha256)}</code><br>Module SHA-256: <code>${html(report.module_image.sha256)}</code><br>Complete trace commitment: <code>${html(report.execution.trace_commitment_sha256)}</code><br>Artifact: MPEG-PS execution fragment (${fmt(report.output.frame_unit_bytes)} bytes), not a complete movie.<br>MPEG pack at byte zero: ${report.output.mpeg_pack_at_zero ? 'yes' : 'no'} • stop: ${html(report.execution.stop_reason)}`;
    q('v510Calls').innerHTML = `<table><thead><tr><th>Call site</th><th>Target</th><th>Explicit stub</th></tr></thead><tbody>${report.execution.calls.map((call) => `<tr><td><code>${call.pc}</code></td><td><code>${call.target}</code></td><td>${html(call.stub)}</td></tr>`).join('')}</tbody></table>`;
    q('v510Trace').innerHTML = `<table><thead><tr><th>Step</th><th>PC</th><th>Word</th><th>Instruction</th></tr></thead><tbody>${report.trace.slice(0, 240).map((row) => `<tr><td>${row.step}</td><td>${row.pc}</td><td>${row.word}</td><td>${html(row.instruction)}${row.delay_slot ? ' [delay]' : ''}</td></tr>`).join('')}</tbody></table><p class="help">Preview shows 240 of ${fmt(report.trace.length)} retained trace records. The JSON export contains all retained records.</p>`;
    q('v510Memory').textContent = JSON.stringify(report.memory_regions, null, 2);
  }
  function clear() { S.result = null; q('v510Metrics').innerHTML = ''; q('v510Proof').textContent = 'No routine executed.'; q('v510Calls').innerHTML = ''; q('v510Trace').innerHTML = ''; q('v510Memory').textContent = 'No memory map.'; clearDownloads(); status('Results cleared. Inputs remain local to this browser.'); }
  function handle(fn) { return async () => { try { await fn(); } catch (error) { status(html(error.message), true); console.error(error); } }; }
  function bind() { q('v510ExecuteIso').onclick = handle(async () => execute(await directIsoInputs())); q('v510ExecuteFiles').onclick = handle(async () => execute(await uploadedInputs())); q('v510ExecuteWorkspace').onclick = handle(async () => execute(await workspaceInputs())); q('v510CancelClear').onclick = clear; }
  if (!install()) setTimeout(install, 0);
})();
