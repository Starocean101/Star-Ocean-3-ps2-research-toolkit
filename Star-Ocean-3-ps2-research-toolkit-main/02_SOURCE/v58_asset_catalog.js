/* SO3 Resource Explorer V5.8 asset catalogue and human annotation layer. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SO3V58Catalog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '5.8.1';
  const FORMAT = 'SO3_USER_ASSET_LABELS_V1';
  const CATEGORIES = Object.freeze([
    'unknown', 'playable_character', 'npc', 'monster', 'weapon', 'armor', 'item', 'map', 'environment',
    'prop', 'texture', 'animation', 'music', 'voice', 'sound_effect', 'cutscene', 'ui', 'script', 'system',
  ]);
  const LABEL_CONFIDENCE = Object.freeze(['UNREVIEWED', 'USER_OBSERVED', 'USER_PROBABLE', 'USER_CONFIRMED']);

  function fnv1a64(text) {
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(String(text))) { hash ^= BigInt(byte); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
    return hash.toString(16).padStart(16, '0');
  }

  function discIdentity(context) {
    const value = context || {};
    const raw = [value.size || 0, value.volume_id || '', value.hidden_layout_sha256 || ''].join('|');
    return `disc:${fnv1a64(raw)}`;
  }

  function identityParts(asset) {
    const raw = asset.raw || {};
    return {
      source: asset.source || raw.source || 'unknown',
      path: asset.path || raw.path || '',
      entry: asset.index ?? raw.index ?? raw.hiddenEntry ?? '',
      offset: asset.offset ?? raw.offset ?? raw.isoOffset ?? '',
      size: asset.size ?? raw.size ?? raw.storedSize ?? raw.decodedSize ?? '',
      resource_id: asset.res_id ?? raw.res_id ?? '',
      tag: asset.tag || raw.tag || '',
    };
  }

  function stableAssetId(asset, discId) {
    const p = identityParts(asset), canonical = [discId || 'disc:unknown', p.source, p.path, p.entry, p.offset, p.size, p.resource_id, p.tag].join('|');
    return `so3asset:${fnv1a64(canonical)}`;
  }

  function cleanText(value, max) { return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }
  function normalizeTags(value) {
    const list = Array.isArray(value) ? value : String(value || '').split(',');
    return Array.from(new Set(list.map((tag) => cleanText(tag, 48).toLowerCase()).filter(Boolean))).slice(0, 32);
  }
  function normalizeAnnotation(value, id) {
    const row = value || {}, category = CATEGORIES.includes(row.category) ? row.category : 'unknown';
    return {
      asset_id: id || cleanText(row.asset_id, 96),
      label: cleanText(row.label, 160),
      category,
      tags: normalizeTags(row.tags),
      notes: cleanText(row.notes, 4000),
      reviewed: !!row.reviewed,
      confidence: LABEL_CONFIDENCE.includes(row.confidence) ? row.confidence : 'UNREVIEWED',
      updated_at: cleanText(row.updated_at, 40) || null,
    };
  }

  function annotationPackage(discId, annotations) {
    const rows = Array.from(annotations instanceof Map ? annotations.entries() : Object.entries(annotations || {}))
      .map(([id, value]) => normalizeAnnotation(value, id))
      .sort((a, b) => a.asset_id.localeCompare(b.asset_id));
    return { format: FORMAT, version: 1, tool_version: VERSION, disc_id: discId, annotations: rows };
  }

  function parseAnnotationPackage(input, expectedDiscId) {
    const value = typeof input === 'string' ? JSON.parse(input) : input;
    if (!value || value.format !== FORMAT || value.version !== 1 || !Array.isArray(value.annotations)) throw Error('not an SO3 V5.8 label package');
    const annotations = new Map();
    for (const row of value.annotations) {
      const clean = normalizeAnnotation(row);
      if (!/^so3asset:[0-9a-f]{16}$/.test(clean.asset_id)) throw Error(`invalid asset id ${clean.asset_id || '(empty)'}`);
      annotations.set(clean.asset_id, clean);
    }
    return { disc_id: value.disc_id || null, disc_match: !expectedDiscId || !value.disc_id || value.disc_id === expectedDiscId, annotations };
  }

  function confidenceRank(asset) {
    const value = String(asset.identification?.confidence || asset.confidence || asset.raw?.v52?.confidence || 'UNRESOLVED');
    if (/VERIFIED/.test(value)) return 4;
    if (/STRUCTURAL|STRONG/.test(value)) return 3;
    if (/OBSERVED|HYPOTHESIS|CANDIDATE/.test(value)) return 2;
    return 1;
  }
  function compareText(a, b) { return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' }); }
  function sortAssets(items, mode) {
    const list = [...items], key = mode || 'name';
    return list.sort((a, b) => {
      if (key === 'size_desc') return (b.size || 0) - (a.size || 0) || compareText(a.name, b.name);
      if (key === 'size_asc') return (a.size || 0) - (b.size || 0) || compareText(a.name, b.name);
      if (key === 'offset') return (a.offset ?? a.raw?.offset ?? Number.MAX_SAFE_INTEGER) - (b.offset ?? b.raw?.offset ?? Number.MAX_SAFE_INTEGER);
      if (key === 'type') return compareText(a.type, b.type) || compareText(a.name, b.name);
      if (key === 'confidence') return confidenceRank(b) - confidenceRank(a) || compareText(a.name, b.name);
      if (key === 'review') return Number(!!a.annotation?.reviewed) - Number(!!b.annotation?.reviewed) || compareText(a.name, b.name);
      if (key === 'label') return compareText(a.annotation?.label || a.name, b.annotation?.label || b.name);
      return compareText(a[key] || a.name, b[key] || b.name);
    });
  }

  function filterAssets(items, options) {
    const opts = options || {}, text = String(opts.text || '').trim().toLowerCase();
    return items.filter((asset) => {
      const a = asset.annotation || {};
      if (opts.review === 'reviewed' && !a.reviewed) return false;
      if (opts.review === 'unreviewed' && a.reviewed) return false;
      if (opts.review === 'unlabeled' && a.label) return false;
      if (opts.review === 'labeled' && !a.label) return false;
      if (opts.category && opts.category !== 'all' && a.category !== opts.category) return false;
      if (!text) return true;
      return [asset.name, asset.originalName, asset.type, asset.role, asset.legacySearchText, a.label, a.category, ...(a.tags || []), a.notes].join(' ').toLowerCase().includes(text);
    });
  }

  function installBrowser() {
    if (typeof document === 'undefined' || !document.getElementById('explorerList') || globalThis.__SO3_V58_CATALOG_INSTALLED) return false;
    globalThis.__SO3_V58_CATALOG_INSTALLED = true;
    const q = (id) => document.getElementById(id), escape = globalThis.esc || ((x) => String(x));
    const context = () => ({
      size: globalThis.state?.iso?.size || 0,
      volume_id: globalThis.state?.isoInfo?.chosen?.volumeId || '',
      hidden_layout_sha256: globalThis.SO3V53Integration?.state?.provenance?.hidden_layout_sha256 || '',
    });
    let discId = discIdentity(context()), annotations = new Map(), filters = { text: '', review: 'all', category: 'all' };
    const storageKey = () => `so3-v58-labels:${discId}`;
    function load() {
      annotations = new Map();
      try { const raw = localStorage.getItem(storageKey()); if (raw) annotations = parseAnnotationPackage(raw, discId).annotations; } catch (_) {}
    }
    function persist() { localStorage.setItem(storageKey(), JSON.stringify(annotationPackage(discId, annotations))); }
    load();

    const originalExplorerItems = globalThis.explorerItems || explorerItems;
    explorerItems = function () {
      const list = originalExplorerItems();
      for (const asset of list) {
        asset.originalName = asset.originalName || asset.name;
        asset.assetId = stableAssetId(asset, discId);
        asset.annotation = annotations.get(asset.assetId) || normalizeAnnotation({}, asset.assetId);
        if (asset.annotation.label) asset.name = `${asset.annotation.label} — ${asset.originalName}`;
      }
      return list;
    };

    const originalViewItems = viewItems;
    viewItems = function (view, items) { return filterAssets(originalViewItems(view, items), filters); };
    explorerSort = function (items) { return sortAssets(items, q('explorerSort')?.value || 'name'); };

    const select = q('explorerSort');
    if (select) select.innerHTML = [
      ['name', 'Name'], ['size_desc', 'Size: largest'], ['size_asc', 'Size: smallest'], ['type', 'Type'],
      ['offset', 'Disc offset'], ['confidence', 'Verification confidence'], ['review', 'Unreviewed first'], ['label', 'User label'],
    ].map(([value, label]) => `<option value="${value}">${label}</option>`).join('');

    const host = q('v52IdentifyPanel') || q('explorerList')?.parentElement;
    if (host) {
      const panel = document.createElement('section'); panel.id = 'v58CatalogControls'; panel.className = 'v58-catalog-controls';
      panel.innerHTML = `<div class="v58-control-grid"><label>Search labels and assets<input id="v58CatalogSearch" type="search" placeholder="Fayt, monster, voice…"></label><label>Review state<select id="v58ReviewFilter"><option value="all">All</option><option value="unreviewed">Unreviewed</option><option value="reviewed">Reviewed</option><option value="unlabeled">Unlabeled</option><option value="labeled">Labeled</option></select></label><label>Label category<select id="v58CategoryFilter"><option value="all">All categories</option>${CATEGORIES.map((x) => `<option>${x}</option>`).join('')}</select></label></div><div class="v58-buttons"><button id="v58NextUnreviewed" class="action secondary">Next unreviewed</button><button id="v58ExportLabels" class="action ghost">Export labels</button><label class="file-button">Import labels<input id="v58ImportLabels" type="file" accept=".json,application/json"></label></div><div id="v58CatalogStatus" class="v52-status">Labels are stored separately from verified machine classifications.</div>`;
      host.after(panel);
    }

    const originalDetails = renderExplorerDetails;
    renderExplorerDetails = function (asset) {
      originalDetails(asset);
      if (!asset) return;
      const id = asset.assetId || stableAssetId(asset, discId), a = annotations.get(id) || normalizeAnnotation({}, id), box = document.createElement('section');
      box.className = 'v58-label-card'; box.dataset.assetId = id;
      box.innerHTML = `<h3>V5.8 human label</h3><p class="help">Your annotation cannot overwrite the machine classification above.</p><div class="v58-label-grid"><label>Friendly name<input data-v58field="label" value="${escape(a.label)}" placeholder="Fayt battle model"></label><label>Category<select data-v58field="category">${CATEGORIES.map((x) => `<option ${x === a.category ? 'selected' : ''}>${x}</option>`).join('')}</select></label><label>Label confidence<select data-v58field="confidence">${LABEL_CONFIDENCE.map((x) => `<option ${x === a.confidence ? 'selected' : ''}>${x}</option>`).join('')}</select></label><label class="v58-reviewed"><input data-v58field="reviewed" type="checkbox" ${a.reviewed ? 'checked' : ''}> Reviewed</label><label class="v58-span">Tags<input data-v58field="tags" value="${escape(a.tags.join(', '))}" placeholder="party, costume, blue"></label><label class="v58-span">Notes<textarea data-v58field="notes" rows="4">${escape(a.notes)}</textarea></label></div><div class="v58-buttons"><button class="action" data-v58save="${id}">Save label</button><button class="action secondary" data-v58clear="${id}">Clear label</button></div><div class="v5-mono">Stable asset ID: ${id}</div>`;
      q('explorerDetails').append(box);
    };

    function rerender(message) { if (message && q('v58CatalogStatus')) q('v58CatalogStatus').textContent = message; renderExplorer(); }
    q('v58CatalogSearch')?.addEventListener('input', (event) => { filters.text = event.target.value; rerender(); });
    q('v58ReviewFilter')?.addEventListener('change', (event) => { filters.review = event.target.value; rerender(); });
    q('v58CategoryFilter')?.addEventListener('change', (event) => { filters.category = event.target.value; rerender(); });
    q('v58ExportLabels')?.addEventListener('click', () => {
      const body = JSON.stringify(annotationPackage(discId, annotations), null, 2), box = q('explorerDownloads');
      globalThis.addDownload(box, 'SO3_USER_ASSET_LABELS_V1.json', body, 'application/json');
      rerender(`Exported ${annotations.size} annotation records.`);
    });
    q('v58ImportLabels')?.addEventListener('change', async (event) => {
      try {
        const parsed = parseAnnotationPackage(await event.target.files[0].text(), discId);
        for (const [id, value] of parsed.annotations) annotations.set(id, value);
        persist(); rerender(`Imported ${parsed.annotations.size} labels${parsed.disc_match ? '' : '; disc identity differs, unmatched IDs remain inert'}.`);
      } catch (error) { rerender(`Label import failed: ${error.message}`); }
      event.target.value = '';
    });
    q('v58NextUnreviewed')?.addEventListener('click', () => {
      const asset = explorerItems().find((item) => !item.annotation?.reviewed);
      if (!asset) return rerender('Every currently indexed asset is reviewed.');
      state.explorerSelected = asset.id; renderExplorer(); renderExplorerDetails(asset);
      q('explorerDetails')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.addEventListener('click', (event) => {
      const save = event.target.closest('[data-v58save]'), clear = event.target.closest('[data-v58clear]');
      if (!save && !clear) return;
      const id = (save || clear).dataset.v58save || (save || clear).dataset.v58clear, card = (save || clear).closest('.v58-label-card');
      if (clear) annotations.delete(id);
      else {
        const get = (field) => card.querySelector(`[data-v58field="${field}"]`), current = {
          asset_id: id, label: get('label').value, category: get('category').value, confidence: get('confidence').value,
          reviewed: get('reviewed').checked, tags: get('tags').value, notes: get('notes').value, updated_at: new Date().toISOString(),
        };
        annotations.set(id, normalizeAnnotation(current, id));
      }
      persist(); rerender(clear ? 'Label cleared.' : 'Label saved.');
    });

    const previousOpen = q('openBtn')?.onclick;
    if (previousOpen) q('openBtn').onclick = async (event) => {
      await previousOpen(event); discId = discIdentity(context()); load(); rerender(`Asset identity ready for ${discId}.`);
    };
    return true;
  }

  const API = Object.freeze({ VERSION, FORMAT, CATEGORIES, LABEL_CONFIDENCE, fnv1a64, discIdentity, identityParts, stableAssetId, normalizeTags, normalizeAnnotation, annotationPackage, parseAnnotationPackage, confidenceRank, sortAssets, filterAssets, installBrowser });
  if (typeof document !== 'undefined') setTimeout(installBrowser, 0);
  return API;
});
