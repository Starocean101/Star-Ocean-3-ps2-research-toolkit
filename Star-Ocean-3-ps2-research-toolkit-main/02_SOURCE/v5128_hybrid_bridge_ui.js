/* V5.12.8 UI for sandbox-requested, browser-local ISO evidence bundles. */
(function () {
  'use strict';
  const Core = globalThis.SO3V5128HybridBridge; if (!Core || typeof document === 'undefined') throw new Error('V5.12.8 hybrid bridge core is required');
  const q = (id) => document.getElementById(id), esc = globalThis.esc || ((value) => String(value)); let attempts = 0, running = false;
  function status(message, bad = false) { const el = q('v5128HybridStatus'); if (el) { el.innerHTML = message; el.className = `status${bad ? ' bad' : ''}`; } }
  function download(name, data, type) { const host = q('v5128HybridDownloads'); if (globalThis.addDownload) return globalThis.addDownload(host, name, data, type); const a = document.createElement('a'); a.download = name; a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type })); a.textContent = `Download ${name}`; host.append(a); }
  async function run() {
    if (running) return; const file = q('v5128HybridRequest')?.files?.[0]; if (!file) return status('Choose a sandbox request JSON first.', true);
    running = true; q('v5128HybridRun').disabled = true; q('v5128HybridDownloads').replaceChildren();
    try {
      status('Validating request and collecting bounded local ISO evidence…'); const request = JSON.parse(await file.text()), result = await Core.collect(request), zipper = globalThis.makeStoreZip || (typeof makeStoreZip === 'function' ? makeStoreZip : null); if (!zipper) throw new Error('ZIP builder is unavailable');
      const zip = zipper(result.files), name = `SO3_HYBRID_DATA_RESPONSE_${result.request.request_id}.zip`; download(name, zip, 'application/zip');
      status(`<b>Response ready:</b> ${result.response.members.length} byte member(s), ${Number(result.response.total_payload_bytes).toLocaleString()} payload bytes, ${result.response.errors.length} recorded error(s). Send the ZIP back to the sandbox thread; no ISO bytes left the browser except this explicit download.`);
    } catch (error) { status(`Hybrid response failed: ${esc(error.message)}`, true); } finally { running = false; q('v5128HybridRun').disabled = false; }
  }
  function install() {
    const page = q('page-v510runtime'); if (!page) { if (attempts++ < 80) setTimeout(install, 50); return; } if (q('v5128HybridCard')) return;
    page.insertAdjacentHTML('beforeend', `<div class="card" id="v5128HybridCard"><h2>Hybrid sandbox + browser execution bridge</h2><p class="notice">The sandbox supplies a bounded request. This browser reads only the requested ISO ranges/resources locally and produces a hash-bound response ZIP. Requests cannot write to the ISO, execute pasted JavaScript, or silently exceed the fixed caps.</p><label class="file-button">Sandbox data request JSON<input id="v5128HybridRequest" type="file" accept=".json,application/json"></label><div class="v510-actions"><button id="v5128HybridRun" class="action">Build requested evidence response</button></div><div id="v5128HybridStatus" class="status">Open the ISO, choose a <code>SO3_HYBRID_DATA_REQUEST_V1</code> file, then build the response.</div><div id="v5128HybridDownloads"></div></div>`);
    q('v5128HybridRun').addEventListener('click', run);
  }
  install();
  globalThis.SO3V5128HybridBridgeUI = Object.freeze({ VERSION: '5.12.8', run });
})();
