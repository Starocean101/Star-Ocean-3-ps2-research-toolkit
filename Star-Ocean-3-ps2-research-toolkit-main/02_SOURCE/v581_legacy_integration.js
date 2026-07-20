/* SO3 Resource Explorer V5.8.1 historical identity-claim integration. */
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./v581_legacy_claims.js') : root.SO3LegacyClaims);
  if (node) module.exports = api;
  else root.SO3V581Legacy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Legacy) {
  'use strict';
  if (!Legacy) throw new Error('SO3 legacy claim data is required');
  const VERSION = '5.8.1';

  function inferDisc(context) {
    const value = `${context?.name || ''} ${context?.volume_id || ''}`.toLowerCase();
    if (/(?:disc|disk|dvd|cd)[\s_.-]*2\b|sles[\s_.-]*82029\b|820[._-]?29\b/.test(value)) return 2;
    if (/(?:disc|disk|dvd|cd)[\s_.-]*1\b|sles[\s_.-]*82028\b|820[._-]?28\b/.test(value)) return 1;
    return null;
  }

  function uniqueClaims(claims) {
    const map = new Map();
    for (const claim of claims || []) {
      const key = `${claim.disc}:${claim.entry}:${claim.child == null ? '*' : claim.child}:${claim.label}`;
      if (!map.has(key)) map.set(key, { ...claim, source_lines: [claim.source_line] });
      else map.get(key).source_lines.push(claim.source_line);
    }
    return [...map.values()];
  }

  function claimsForAsset(asset, disc) {
    if (!asset || asset.source !== 'hidden' || !Number.isFinite(Number(asset.index)) || !disc) return [];
    const rows = Legacy.claimsFor(disc, Number(asset.index));
    for (const range of Legacy.DATA.range_claims) if (range.disc === Number(disc) && Number(asset.index) >= range.entry_start && Number(asset.index) <= range.entry_end) rows.push({ ...range, entry: Number(asset.index), child: null, range: [range.entry_start, range.entry_end] });
    return uniqueClaims(rows);
  }

  function displaySummary(claims) {
    const direct = uniqueClaims((claims || []).filter((x) => x.child == null)), children = uniqueClaims((claims || []).filter((x) => x.child != null));
    if (direct.length) return direct.map((x) => x.label).join(' / ');
    if (children.length) return `${children.length} historical child label${children.length === 1 ? '' : 's'}`;
    return '';
  }

  function installBrowser() {
    if (typeof document === 'undefined' || globalThis.__SO3_V581_LEGACY_INSTALLED || !document.getElementById('explorerList')) return false;
    globalThis.__SO3_V581_LEGACY_INSTALLED = true;
    const q = (id) => document.getElementById(id), html = globalThis.esc || ((x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]));
    let disc = inferDisc({ name: globalThis.state?.iso?.name, volume_id: globalThis.state?.isoInfo?.chosen?.volumeId });

    const style = document.createElement('style');
    style.textContent = `.v581-legacy{border:1px solid #b8c4d8;border-radius:14px;padding:14px;margin:14px 0;background:#f8faff}.v581-legacy h3{margin:.1rem 0 .4rem}.v581-legacy-grid{display:grid;grid-template-columns:minmax(150px,.7fr) minmax(220px,1.5fr);gap:10px}.v581-claim{border-left:4px solid #7c8fb3;padding:8px 10px;margin:8px 0;background:white;border-radius:7px}.v581-claim.conflict{border-left-color:#b42318;background:#fff5f4}.v581-claim small{display:block;color:#5e6d84}.v581-stage{margin-top:7px}.v581-warning{color:#8a261d;font-weight:700}.v581-badge{color:#4b5e80;font-size:.86em}@media(max-width:620px){.v581-legacy-grid{grid-template-columns:1fr}.v581-legacy{padding:12px}.v581-claim button{width:100%;min-height:44px}}`;
    document.head.append(style);

    const host = q('v58CatalogControls') || q('v52IdentifyPanel') || q('explorerList')?.parentElement;
    if (host) {
      const panel = document.createElement('section'); panel.id = 'v581LegacyPanel'; panel.className = 'v581-legacy';
      panel.innerHTML = `<h3>Historical model identity claims</h3><p class="help">156 names recovered from “The Dude / A Satoh Production.” They are research leads, never machine classifications. Select the matching disc before using them.</p><div class="v581-legacy-grid"><label>Disc represented by this ISO<select id="v581LegacyDisc"><option value="">Unknown — claims disabled</option><option value="1">Disc 1</option><option value="2">Disc 2</option></select></label><label>Search historical claims<input id="v581LegacySearch" type="search" placeholder="Fayt, Clair, monster, 3246_13…"></label></div><div class="v58-buttons"><button id="v581LegacyExport" class="action ghost">Export historical claims</button></div><div id="v581LegacyStatus" class="v52-status"></div><div id="v581LegacyResults"></div>`;
      host.after(panel);
    }
    if (q('v581LegacyDisc')) q('v581LegacyDisc').value = disc ? String(disc) : '';

    const originalExplorerItems = globalThis.explorerItems || explorerItems;
    explorerItems = function () {
      const list = originalExplorerItems();
      for (const asset of list) {
        asset.legacyClaims = claimsForAsset(asset, disc);
        asset.legacySearchText = asset.legacyClaims.map((x) => `${x.entry}_${x.child ?? ''} ${x.label} ${x.group}`).join(' ');
        const summary = displaySummary(asset.legacyClaims), hasUserLabel = !!asset.annotation?.label;
        if (summary && !hasUserLabel) asset.name = `[Historical claim: ${summary}] — ${asset.originalName || asset.name}`;
      }
      return list;
    };

    const originalDetails = renderExplorerDetails;
    renderExplorerDetails = function (asset) {
      originalDetails(asset);
      if (!asset || !q('explorerDetails')) return;
      const claims = claimsForAsset(asset, disc); if (!claims.length) return;
      const direct = claims.filter((x) => x.child == null), children = claims.filter((x) => x.child != null), box = document.createElement('section');
      const conflicts = Legacy.conflictsFor(disc, Number(asset.index));
      box.className = 'v581-legacy';
      const row = (claim) => `<div class="v581-claim ${conflicts.some((x) => x.child === claim.child) ? 'conflict' : ''}"><b>${claim.child == null ? `Entry ${claim.entry}` : `Legacy child ${claim.entry}_${claim.child}`}: ${html(claim.label)}</b><small>${html(claim.group)} • source line${claim.source_lines.length === 1 ? '' : 's'} ${claim.source_lines.join(', ')} • HISTORICAL_USER_CLAIM</small>${claim.child == null ? `<button class="action ghost v581-stage" data-v581stage="${html(claim.label)}">Stage as editable friendly name</button>` : ''}</div>`;
      box.innerHTML = `<h3>Historical claims for Disc ${disc}, entry ${asset.index}</h3><p class="help">Primary numbers reproduce the old unpacker’s zero-based output index. Child ordinals remain unverified until reproduced against a child inventory.</p>${conflicts.length ? '<p class="v581-warning">Conflicting historical labels exist below; no label was selected automatically.</p>' : ''}${direct.map(row).join('')}${children.length ? `<details><summary>${children.length} child claim${children.length === 1 ? '' : 's'}</summary>${children.map(row).join('')}</details>` : ''}`;
      q('explorerDetails').append(box);
    };

    function status(message) { if (q('v581LegacyStatus')) q('v581LegacyStatus').textContent = message; }
    function renderResults() {
      const host = q('v581LegacyResults'), text = q('v581LegacySearch')?.value || '';
      if (!host) return;
      if (!disc) { host.innerHTML = ''; return status('Disc is unknown, so all automatic matching is disabled.'); }
      const rows = uniqueClaims(Legacy.search(text, disc)).slice(0, 100);
      host.innerHTML = text ? rows.map((x) => `<div class="v581-claim"><b>${x.entry}${x.child == null ? '' : `_${x.child}`} — ${html(x.label)}</b><small>${html(x.group)} • line ${x.source_line}</small></div>`).join('') || '<p>No historical claims match.</p>' : '';
      status(`Disc ${disc}: ${Legacy.search('', disc).length} source claims available. ${Legacy.DATA.summary.conflicting_keys} conflicting key is preserved.`);
    }
    q('v581LegacyDisc')?.addEventListener('change', (event) => { disc = Number(event.target.value) || null; renderResults(); renderExplorer(); });
    q('v581LegacySearch')?.addEventListener('input', renderResults);
    q('v581LegacyExport')?.addEventListener('click', () => {
      const data = { ...Legacy.DATA, export_filter_disc: disc, claims: disc ? Legacy.DATA.claims.filter((x) => x.disc === disc) : Legacy.DATA.claims };
      globalThis.addDownload(q('explorerDownloads'), 'SO3_LEGACY_IDENTITY_CLAIMS_V1.json', JSON.stringify(data, null, 2), 'application/json');
      status(`Historical claim export ready${disc ? ` for Disc ${disc}` : ''}.`);
    });
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-v581stage]'); if (!button) return;
      const input = q('explorerDetails')?.querySelector('[data-v58field="label"]');
      if (!input) return status('Open the V5.8 human-label card before staging a friendly name.');
      input.value = button.dataset.v581stage; input.focus(); status('Historical wording staged. Review it, choose confidence, then press Save label.');
    });

    const previousOpen = q('openBtn')?.onclick;
    if (previousOpen) q('openBtn').onclick = async (event) => {
      await previousOpen(event);
      const inferred = inferDisc({ name: globalThis.state?.iso?.name, volume_id: globalThis.state?.isoInfo?.chosen?.volumeId });
      if (inferred) { disc = inferred; if (q('v581LegacyDisc')) q('v581LegacyDisc').value = String(disc); }
      renderResults(); renderExplorer();
    };
    renderResults();
    if (globalThis.SO3ApplyCurrentBrand) globalThis.SO3ApplyCurrentBrand();
    else {
      document.title = 'SO3 Resource Explorer V5.8.1 — Legacy Knowledge Integration';
      const title = document.querySelector('.appbar h1'), subtitle = document.querySelector('.appbar p');
      if (title) title.textContent = 'SO3 Resource Explorer V5.8.1';
      if (subtitle) subtitle.textContent = 'V5.8 preserved • historical identity claims with conflict gates • legacy toolkit audit • offline and read-only.';
    }
    return true;
  }

  const API = Object.freeze({ VERSION, inferDisc, uniqueClaims, claimsForAsset, displaySummary, installBrowser });
  if (typeof document !== 'undefined') setTimeout(installBrowser, 0);
  return API;
});
