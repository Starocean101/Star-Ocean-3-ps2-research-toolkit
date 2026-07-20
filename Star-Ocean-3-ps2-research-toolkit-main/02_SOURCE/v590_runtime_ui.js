/* SO3 Resource Explorer V5.9.0 browser Runtime Capture Importer UI. */
(function () {
  'use strict';
  const Core = globalThis.SO3V590RuntimeCapture, Assets = globalThis.SO3V590CaptureAssets;
  if (!Core || !Assets || typeof document === 'undefined') throw new Error('V5.9 runtime capture core and assets are required');
  const q = (id) => document.getElementById(id), html = globalThis.esc || ((value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]));
  const UI = { worker: null, workerReject: null, cancel: null, analysis: null, report: null, payload: null };

  function install() {
    if (q('page-v590capture') || !q('tabs') || !q('page-reports')) return false;
    q('tabs').insertAdjacentHTML('beforeend', '<button class="tab" data-page="v590capture">Runtime Capture</button>');
    q('page-reports').insertAdjacentHTML('beforebegin', `
<section id="page-v590capture" class="page">
  <div class="card v590-hero"><div><h2>V5.9 Runtime Capture Importer</h2><p>Analyze PCSX2 runtime dumps locally in this browser. Capture bytes stay on this device and are never uploaded to the host.</p></div><span class="v590-badge">V5.9.0</span></div>
  <div class="card">
    <h2>1. Capture on the PC</h2>
    <p class="notice"><b>Hard boundary:</b> a hosted browser cannot attach to PCSX2 memory. The companion script performs that one external step. The supplied address profile is only for PCSX2 commit <code>c16db05e…</code>, 32-bit.</p>
    <div class="v590-actions"><button id="v590DownloadScript" class="action">Download legacy capture script</button><button id="v590DownloadLogTemplate" class="action ghost">Download transfer-log template</button></div>
    <details><summary>Historical capture profile</summary><div class="table-wrap"><table><tbody><tr><th>Host staging window</th><td><code>0x2410BD00–0x241A7D00</code></td></tr><tr><th>Mapped IOP window</th><td><code>0x0010BD00–0x001A7D00</code></td></tr><tr><th>Window size</th><td><code>0x9C000</code> (638,976 bytes)</td></tr><tr><th>Hook</th><td><code>VCRUNTIME140.memcpy</code>, x86 stack arguments</td></tr></tbody></table></div></details>
  </div>
  <div class="card">
    <h2>2. Import the capture</h2>
    <div class="v590-grid">
      <label class="file-button">Capture payload<input id="v590Payload" type="file" accept=".bin,.file,.pk3,.cap,application/octet-stream"></label>
      <label class="file-button">Transfer log (optional)<input id="v590TransferLog" type="file" accept=".tsv,.csv,text/tab-separated-values,text/csv"></label>
      <label>Expected output bytes (optional)<input id="v590Expected" inputmode="text" placeholder="auto from PK3 +0x14, or 0x35A000"></label>
      <label>Capture profile<select id="v590Profile"><option value="LEGACY_C16DB05E">Legacy PCSX2 c16db05e, x86</option><option value="UNSPECIFIED">Unknown / other PCSX2 build</option></select></label>
    </div>
    <div class="v590-actions"><button id="v590Analyze" class="action">Analyze capture</button><button id="v590Cancel" class="action secondary" disabled>Cancel</button><button id="v590Clear" class="action ghost">Clear results</button></div>
    <progress id="v590Progress" max="1" value="0"></progress>
    <div id="v590Status" class="status">Choose a raw <code>output.file</code> or <code>SO3_capture_payload.bin</code>. A transfer log adds continuity and address-window verification.</div>
    <div id="v590Metrics" class="metric-grid"></div>
  </div>
  <div class="card">
    <h2>3. Evidence</h2>
    <div id="v590Header" class="status">No capture analyzed.</div>
    <div id="v590Signatures" class="table-wrap"></div>
    <details><summary>Transfer-log validation</summary><pre id="v590TransferResult">No transfer log supplied.</pre></details>
    <details><summary>Full report preview</summary><pre id="v590ReportPreview">No report.</pre></details>
  </div>
  <div class="card v590-download-card">
    <h2>4. Local exports</h2>
    <p class="help">The reconstructed payload is a local slice of the selected file. Report downloads contain evidence and hashes, not the original game data.</p>
    <div id="v590Downloads"></div>
  </div>
</section>`);
    const style = document.createElement('style'); style.id = 'so3-v590-styles'; style.textContent = `
      .v590-hero{display:flex;justify-content:space-between;align-items:center;gap:16px;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 13%,var(--panel)),var(--panel))}.v590-hero h2{margin:0 0 6px}.v590-badge{display:inline-flex;border:1px solid currentColor;border-radius:999px;padding:5px 10px;font-weight:800;color:var(--accent);white-space:nowrap}.v590-grid{display:grid;grid-template-columns:repeat(2,minmax(180px,1fr));gap:10px}.v590-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.v590-actions>*{min-height:44px;margin:0}.v590-download-card{scroll-margin-bottom:max(760px,65vh)}#v590Downloads{display:grid;gap:8px}#v590Status code{font-size:.9em}.v590-hit{color:#197a43;font-weight:800}.v590-zero{color:var(--muted)}
      @media(max-width:700px){.v590-hero{align-items:flex-start}.v590-grid{grid-template-columns:1fr}.v590-actions{display:grid;grid-template-columns:1fr}.v590-actions>*{width:100%}#page-v590capture{padding-bottom:calc(max(760px,65vh) + env(safe-area-inset-bottom))}.v590-download-card,#v590Downloads,.v590-download-card .download{scroll-margin-bottom:max(760px,65vh)}}`;
    document.head.append(style);
    document.querySelector('[data-page="v590capture"]').onclick = () => globalThis.switchPage ? globalThis.switchPage('v590capture') : switchPage('v590capture');
    bind(); brand(); return true;
  }

  function brand() {
    if (globalThis.SO3ApplyCurrentBrand) return globalThis.SO3ApplyCurrentBrand();
    document.title = 'SO3 Resource Explorer V5.9.0 — Runtime Capture Importer'; const title = document.querySelector('.appbar h1'), subtitle = document.querySelector('.appbar p');
    if (title) title.textContent = 'SO3 Resource Explorer V5.9.0';
    if (subtitle) subtitle.textContent = 'V5.8.1 preserved • browser-local runtime capture reconstruction • chunked signature analysis • offline and read-only.';
  }
  function fmt(value) { return Number(value || 0).toLocaleString(); }
  function size(value) { const n = Number(value || 0); if (n < 1024) return `${n} B`; const units = ['KiB', 'MiB', 'GiB', 'TiB']; let v = n / 1024, i = 0; while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; } return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`; }
  function status(message, bad = false) { q('v590Status').innerHTML = message; q('v590Status').className = `status${bad ? ' bad' : ''}`; }
  function clearDownloads() { const host = q('v590Downloads'); while (host.firstChild) host.firstChild.remove(); }
  function download(name, data, type = 'application/octet-stream') { if (globalThis.addDownload) return globalThis.addDownload(q('v590Downloads'), name, data, type); const link = document.createElement('a'); link.className = 'download'; link.download = name; link.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type })); link.textContent = `Download ${name}`; q('v590Downloads').append(link); return link; }
  function downloadAsset(name, data, type) { const blob = new Blob([data], { type }); const link = document.createElement('a'); link.download = name; link.href = URL.createObjectURL(blob); link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 2000); }

  function workerAnalyze(file) {
    if (typeof Worker === 'undefined') return Core.analyzeBlob(file, { cancel: UI.cancel, onProgress: progress });
    return new Promise((resolve, reject) => {
      let worker; try { worker = new Worker(URL.createObjectURL(new Blob([Core.workerSource()], { type: 'text/javascript' }))); } catch (_) { return Core.analyzeBlob(file, { cancel: UI.cancel, onProgress: progress }).then(resolve, reject); }
      UI.worker = worker; UI.workerReject = reject; worker.onmessage = (event) => { const message = event.data; if (message.type === 'progress') progress(message); else if (message.type === 'complete') { worker.terminate(); UI.worker = null; UI.workerReject = null; resolve(message.result); } else if (message.type === 'error') { worker.terminate(); UI.worker = null; UI.workerReject = null; reject(new Error(message.error)); } }; worker.onerror = (event) => { worker.terminate(); UI.worker = null; UI.workerReject = null; reject(new Error(event.message || 'Capture worker failed')); }; worker.postMessage({ type: 'analyze', file, chunkSize: Core.DEFAULT_CHUNK, maxSamples: 64 });
    });
  }
  function progress(value) { q('v590Progress').value = value.ratio || 0; status(`Analyzing locally: <b>${size(value.processed)}</b> / ${size(value.total)}. Nothing is being uploaded.`); }

  async function analyze() {
    const file = q('v590Payload').files[0]; if (!file) throw new Error('Choose a capture payload first');
    UI.payload = file; UI.cancel = { cancelled: false }; q('v590Analyze').disabled = true; q('v590Cancel').disabled = false; q('v590Progress').value = 0; clearDownloads(); q('v590Metrics').innerHTML = ''; q('v590Signatures').innerHTML = '';
    let transfers = null, transferValidation = { supplied: false };
    const log = q('v590TransferLog').files[0]; if (log) { transfers = Core.parseTransferLog(await log.text()); transferValidation = { supplied: true, name: log.name, ...Core.validateTransfers(transfers, file.size) }; }
    const analysis = await workerAnalyze(file); const reconstructionChoice = Core.chooseReconstructionSize(file.size, analysis.header, q('v590Expected').value); const reconstruction = { output_bytes: reconstructionChoice.size, size_source: reconstructionChoice.source, trimmed_bytes: file.size - reconstructionChoice.size, complete: transferValidation.supplied ? transferValidation.valid && transferValidation.reconstructed_end >= reconstructionChoice.size : analysis.header.declared_size_plausible || reconstructionChoice.source === 'USER_OVERRIDE' };
    const legacy = q('v590Profile').value === 'LEGACY_C16DB05E', profile = legacy ? { id: 'PCSX2_C16DB05E_X86_CE_MEMCPY', pcsx2_build: 'c16db05e0c3a5806fad1fd571141284facc7b421', host_architecture: 'x86', historical_claim: true } : { id: 'UNSPECIFIED' };
    const report = Core.buildReport(file, analysis, transferValidation, reconstruction, profile), atlas = Core.buildAtlasUpdate(report); UI.analysis = analysis; UI.report = report; render(report);
    download('SO3_RUNTIME_CAPTURE_REPORT.json', JSON.stringify(report, null, 2), 'application/json'); download('SO3_ATLAS_RUNTIME_UPDATE.json', JSON.stringify(atlas, null, 2), 'application/json'); download(`SO3_reconstructed_${reconstruction.output_bytes}.bin`, file.slice(0, reconstruction.output_bytes), 'application/octet-stream');
    q('v590Progress').value = 1; status(`Analysis complete. SHA-256 <code>${analysis.sha256}</code>. ${reconstruction.complete ? '<b>Reconstruction checks passed within the supplied evidence.</b>' : '<b>Reconstruction remains candidate evidence.</b>'}`); q('v590Analyze').disabled = false; q('v590Cancel').disabled = true;
  }

  function render(report) {
    const signatureRows = Object.entries(report.signatures).sort((a, b) => b[1].count - a[1].count); q('v590Metrics').innerHTML = [['Capture', size(report.source.captured_bytes)], ['Reconstruction', size(report.reconstruction.output_bytes)], ['Signatures', signatureRows.filter(([, x]) => x.count).length], ['Transfer rows', report.transfer_log.rows || 0]].map(([label, value]) => `<div class="metric"><b>${html(value)}</b><span>${html(label)}</span></div>`).join('');
    q('v590Header').innerHTML = `<b>${html(report.header.classification)}</b> • ${html(report.header.confidence)}<br>Magic: <code>${html(report.header.magic || 'none')}</code> • declared size at +0x14: ${report.header.declared_size_le == null ? 'unavailable' : `${fmt(report.header.declared_size_le)} bytes`} • plausible: ${report.header.declared_size_plausible ? 'yes' : 'no'}`;
    q('v590Signatures').innerHTML = `<table><thead><tr><th>Signature</th><th>Hits</th><th>First offsets</th></tr></thead><tbody>${signatureRows.map(([name, value]) => `<tr><td>${html(name)}</td><td class="${value.count ? 'v590-hit' : 'v590-zero'}">${fmt(value.count)}</td><td><code>${html((value.sample_offsets_hex || []).slice(0, 8).join(', ') || '—')}</code></td></tr>`).join('')}</tbody></table>`;
    q('v590TransferResult').textContent = JSON.stringify(report.transfer_log, null, 2); q('v590ReportPreview').textContent = JSON.stringify(report, null, 2);
  }

  function clear() { if (UI.worker) UI.worker.terminate(); if (UI.workerReject) UI.workerReject(new Error('Capture analysis cancelled')); UI.worker = null; UI.workerReject = null; UI.cancel = null; UI.analysis = null; UI.report = null; UI.payload = null; q('v590Progress').value = 0; q('v590Metrics').innerHTML = ''; q('v590Header').textContent = 'No capture analyzed.'; q('v590Signatures').innerHTML = ''; q('v590TransferResult').textContent = 'No transfer log supplied.'; q('v590ReportPreview').textContent = 'No report.'; clearDownloads(); q('v590Analyze').disabled = false; q('v590Cancel').disabled = true; status('Results cleared. Selected files remain local to this browser.'); }
  function bind() {
    q('v590DownloadScript').onclick = () => downloadAsset('so3_pcsx2_legacy_runtime_capture.lua', Assets.LEGACY_CE_LUA, 'text/plain'); q('v590DownloadLogTemplate').onclick = () => downloadAsset('SO3_capture_transfers_template.tsv', Assets.LOG_TEMPLATE, 'text/tab-separated-values');
    q('v590Analyze').onclick = async () => { try { await analyze(); } catch (error) { status(html(error.message), true); q('v590Analyze').disabled = false; q('v590Cancel').disabled = true; console.error(error); } };
    q('v590Cancel').onclick = () => { if (UI.worker) { UI.worker.terminate(); const reject = UI.workerReject; UI.worker = null; UI.workerReject = null; if (reject) reject(new Error('Capture analysis cancelled')); } else if (UI.cancel) UI.cancel.cancelled = true; status('Capture analysis cancelled.'); q('v590Analyze').disabled = false; q('v590Cancel').disabled = true; };
    q('v590Clear').onclick = clear;
  }

  if (!install()) setTimeout(install, 0);
})();
