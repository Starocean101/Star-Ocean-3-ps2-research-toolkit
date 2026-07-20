/* SO3 Resource Explorer V5.5 muxed cutscene video/audio integration.
 * Appended after the preserved V5.1 release and V5.2 identification core.
 */
(function () {
  'use strict';
  const I = globalThis.SO3V52Identify;
  if (!I) throw new Error('SO3V52Identify is required');
  const M = globalThis.SO3V53Movie;
  if (!M) throw new Error('SO3V53Movie is required');
  const A = globalThis.SO3V54Sac;
  if (!A) throw new Error('SO3V54Sac is required');
  const X = globalThis.SO3V55Mux;
  if (!X) throw new Error('SO3V55Mux is required');
  const q = (id) => document.getElementById(id);
  const U = {
    running: false,
    cancel: false,
    results: new Map(),
    baselineHiddenUnknown: 0,
    started: null,
    finished: null,
    current: null,
    checkpoints: new Map(),
    provenance: null,
    decodedMovies: new Map(),
  };

  const style = document.createElement('style');
  style.id = 'so3-v52-styles';
  style.textContent = `
    .v52-identify{padding:10px 12px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--accent) 5%,var(--panel2))}
    .v52-actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center}.v52-actions button{margin:0;min-height:44px}
    .v52-identify progress{margin:8px 0 4px}.v52-status{font-size:11px;color:var(--muted);white-space:pre-wrap;word-break:break-word}
    .v52-metrics{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.v52-metric{border:1px solid var(--line);border-radius:8px;padding:5px 8px;background:var(--panel);font-size:10px}.v52-metric b{font-size:12px}
    .v52-evidence{margin:9px 0;padding:9px;border:1px solid var(--line);border-radius:9px;background:var(--panel)}
    .v52-evidence h3{margin-top:0}.v52-evidence ul{padding-left:18px;margin:6px 0}.v52-evidence .v52-grade{font-weight:800}
    @media(max-width:700px){html{scroll-padding-bottom:max(520px,55vh)}.shell{padding-bottom:calc(max(520px,55vh) + env(safe-area-inset-bottom))!important}.download,.v52-evidence{scroll-margin-bottom:max(520px,55vh)}}
    @media(max-width:620px){.v52-actions{display:grid;grid-template-columns:1fr 1fr}.v52-actions button{width:100%}.v52-actions button:last-child{grid-column:1/-1}}
  `;
  document.head.append(style);

  const commandbar = q('explorerList')?.closest('.explorer-card')?.querySelector('.explorer-commandbar');
  if (commandbar) {
    const panel = document.createElement('div');
    panel.className = 'v52-identify';
    panel.id = 'v52IdentifyPanel';
    panel.innerHTML = `<div class="v52-actions"><button id="v52IdentifyBtn" class="action">Identify unknowns</button><button id="v52MovieBtn" class="action secondary">Deep-validate movie candidates</button><button id="v52StopBtn" class="action danger">Stop</button><button id="v52ExportBtn" class="action ghost">Export identification census</button></div><progress id="v52Progress" value="0" max="1"></progress><div id="v52Status" class="v52-status">Open the PAL Disc 1 ISO. Verified magic is classified immediately; deeper checks run only when requested.</div><div id="v52Metrics" class="v52-metrics"></div>`;
    commandbar.after(panel);
  }

  const priorClassifyHeader = classifyHeader;
  classifyHeader = function (bytes) {
    const found = I.magicClassification(bytes);
    return found ? found.format : priorClassifyHeader(bytes);
  };

  EXPLORER_VIEWS.models = { label: 'Models, maps & animation', icon: '🧊' };
  EXPLORER_VIEWS.candidates = { label: 'Candidates / needs validation', icon: '🧪' };

  const priorRoleInfo = roleInfo;
  roleInfo = function (type, name, source) {
    const t = String(type || '');
    if (/^SO3_MOVIE_CARRIER_CANDIDATE|^SO3_MOVIE_FRAMING_CANDIDATE|^SO3_MOVIE_CARRIER_NOT_VERIFIED/.test(t))
      return { role: 'Movie-family candidate', category: 'candidates', icon: '🧪', folderLike: false, description: 'Observed 77522267B4EFDB84 family evidence. Deep structural gates have not all passed.' };
    if (t === 'SO3_MOVIE_CARRIER')
      return { role: 'SO3 movie carrier', category: 'video', icon: '🎬', folderLike: false, description: 'Verified carrier with an executable-derived exact MPEG-PS decoder. Browser preview depends on MPEG-2 support.' };
    if (/^(TEXT_DATA_CANDIDATE|EMBEDDED_FORMAT_CANDIDATE|ZERO_FILLED_ALLOCATION|SMCD)$/.test(t))
      return { role: t === 'ZERO_FILLED_ALLOCATION' ? 'Padding / empty allocation' : 'Research candidate', category: 'candidates', icon: '🔬', folderLike: false, description: 'Evidence-bearing candidate; see the confidence and reasons in the details panel.' };
    if (t === 'SEMANTIC_BUNDLE' || t === 'SEMANTIC_BUNDLE_SET') return { role: t === 'SEMANTIC_BUNDLE_SET' ? 'Multi-bundle allocation' : 'Semantic resource bundle', category: 'archives', icon: '📦', folderLike: true, description: 'Verified descriptor-based SO3 resource bundle layout, distinct from PACK.' };
    if (t === 'MWo3') return { role: 'Engine overlay', category: 'executables', icon: '⚙️', folderLike: false, description: 'Verified MWo3 application-overlay magic.' };
    if (['FPS', 'XBDC', 'RMAC', 'RTA', 'FAS'].includes(t)) return { role: I.FORMAT_META[t][0], category: 'models', icon: I.FORMAT_META[t][2], folderLike: false, description: 'Atlas V1.1.1 verified model/map/skeleton/animation family.' };
    if (['FIS', 'DMM'].includes(t)) return { role: I.FORMAT_META[t][0], category: 'textures', icon: I.FORMAT_META[t][2], folderLike: false, description: 'Atlas V1.1.1 verified image family.' };
    if (['SEQW', 'SEQW_BANK', 'VSC'].includes(t)) return { role: I.FORMAT_META[t][0], category: 'audio', icon: I.FORMAT_META[t][2], folderLike: t === 'SEQW_BANK', description: 'Atlas V1.1.1 verified audio or lip-state family.' };
    if (t === 'MPEG_PS') return { role: 'MPEG program stream', category: 'video', icon: '🎬', folderLike: false, description: 'Raw MPEG-PS pack header at offset zero.' };
    return priorRoleInfo(type, name, source);
  };

  const priorExplorerItems = explorerItems;
  explorerItems = function () {
    const items = priorExplorerItems();
    for (const item of items) {
      if (item.source !== 'hidden' || !item.raw?.v52) continue;
      const result = item.raw.v52, type = result.format === 'UNKNOWN' ? (result.metrics?.raw_header || item.type) : result.format;
      const r = roleInfo(type, item.name, item.source);
      Object.assign(item, {
        type,
        role: r.role,
        category: r.category,
        icon: r.icon,
        folderLike: r.folderLike,
        description: result.reasons?.join(' ') || r.description,
        identification: result,
      });
    }
    return items;
  };

  const priorViewItems = viewItems;
  viewItems = function (view, items) {
    if (view === 'models' || view === 'candidates') return items.filter((x) => x.category === view);
    return priorViewItems(view, items);
  };

  explorerCounts = function (items) {
    const out = {
      all: items.length,
      visible: items.filter((x) => x.source === 'visible').length,
      hidden: items.filter((x) => x.source === 'hidden').length,
      decoded: items.filter((x) => x.source === 'decoded').length,
    };
    for (const key of ['archives', 'compressed', 'executables', 'models', 'textures', 'audio', 'video', 'text', 'candidates', 'unknown'])
      out[key] = items.filter((x) => x.category === key).length;
    out.priorities = priorViewItems('priorities', items).length + out.candidates;
    return out;
  };

  renderExplorerNav = function (items) {
    const counts = explorerCounts(items), groups = [
      ['Locations', ['home', 'all', 'visible', 'hidden', 'decoded']],
      ['Type groups', ['archives', 'compressed', 'executables', 'models', 'textures', 'audio', 'video', 'text', 'candidates', 'unknown']],
      ['Planning', ['priorities']],
    ];
    q('explorerNav').innerHTML = groups.map(([title, keys]) => `<div class="explorer-section-title">${title}</div>` + keys.map((key) => `<button class="explorer-nav-btn ${state.explorerView === key ? 'active' : ''}" data-exview="${key}"><span>${EXPLORER_VIEWS[key].icon}</span><span>${esc(EXPLORER_VIEWS[key].label)}</span><span class="count">${counts[key] ?? ''}</span></button>`).join('')).join('');
  };

  renderHome = function (items) {
    const counts = explorerCounts(items), tiles = ['visible', 'hidden', 'decoded', 'archives', 'compressed', 'executables', 'models', 'textures', 'audio', 'video', 'candidates', 'unknown'];
    q('explorerBreadcrumb').innerHTML = '<span>💿 SO3 Disc</span><span>Overview</span>';
    q('explorerList').innerHTML = `<div class="folder-summary-grid">${tiles.map((key) => `<div class="folder-tile" data-exview="${key}"><div class="tile-icon">${EXPLORER_VIEWS[key].icon}</div><b>${esc(EXPLORER_VIEWS[key].label)}</b><small>${counts[key] || 0} item${counts[key] === 1 ? '' : 's'}</small></div>`).join('')}</div><div class="notice" style="margin:0 10px 12px"><b>V5.3 evidence rule:</b> verified formats, structural candidates, hypotheses, and unresolved binaries remain separate. Movie decoding is enabled only after the complete carrier gates pass.</div>`;
  };

  const priorRenderDetails = renderExplorerDetails;
  renderExplorerDetails = function (item) {
    priorRenderDetails(item);
    if (!item?.identification) return;
    const r = item.identification, metrics = r.metrics || {}, evidence = r.evidence || [], reasons = r.reasons || [];
    const box = document.createElement('section');
    box.className = 'v52-evidence';
    const candidateButton = /^SO3_MOVIE_/.test(r.format) && r.format !== 'SO3_MOVIE_CARRIER' ? `<button class="action" data-v52deep="${item.index}">Deep-validate this carrier</button>` : '';
    const decodeButton = r.format === 'SO3_MOVIE_CARRIER' ? `<button class="action" data-v53decode="${item.index}">Build movie with audio</button>` : '';
    const decoded = U.decodedMovies.get(item.index);
    box.innerHTML = `<h3>V5.3 identification evidence</h3><div class="detail-row"><b>Classification</b><span>${esc(r.display || r.format)}</span></div><div class="detail-row"><b>Confidence</b><span class="v52-grade">${esc(r.confidence || 'UNRESOLVED')}</span></div><div class="detail-row"><b>Exact decode</b><span>${r.decodable == null ? 'not applicable' : r.decodable ? 'available' : 'not enabled'}</span></div><div class="detail-row"><b>Browser preview</b><span>${esc(r.browser_preview || 'not applicable')}</span></div><div class="detail-row"><b>Header</b><span class="v5-mono">${esc(metrics.raw_header_hex || metrics.raw_header || item.raw?.header || '—')}</span></div><div class="detail-row"><b>Sample metrics</b><span>${metrics.bytes_examined == null ? 'not yet scanned' : `${fmt(metrics.bytes_examined)} bytes; entropy ${metrics.entropy}; printable ${((metrics.printable_ratio || 0) * 100).toFixed(1)}%; zero ${((metrics.zero_ratio || 0) * 100).toFixed(1)}%`}</span></div>${decoded ? `<div class="notice"><b>Decoded:</b> ${fmt(decoded.size)}-byte MPEG-PS; ${(decoded.frame_prefix_ratio * 100).toFixed(2)}% pack-prefix recurrence.</div>` : ''}<h3>Evidence</h3>${evidence.length ? `<ul>${evidence.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="help">No positive format evidence.</p>'}<h3>Reasoning boundary</h3><ul>${reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${candidateButton}${decodeButton}`;
    q('explorerDetails').append(box);
  };

  function providerFor(row) {
    return {
      size: row.size,
      async read(offset, length) {
        if (!state.iso) throw new Error('No ISO open');
        if (offset < 0 || length < 0 || offset + length > row.size) throw new RangeError('Allocation read outside bounds');
        return new Uint8Array(await state.iso.slice(row.offset + offset, row.offset + offset + length).arrayBuffer());
      },
    };
  }

  async function sha256Hex(input) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : I.asBytes(input);
    if (!globalThis.crypto?.subtle) return null;
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    return I.hex(digest);
  }

  async function buildDiscProvenance() {
    const layout = state.hidden.filter((row) => row.sectors && row.size).map((row) =>
      [row.index, row.lba, row.sectors, row.runtime, row.rawHeaderHex || ''].join(':')).join('\n');
    const pvd = state.isoInfo?.chosen?.raw || null;
    U.provenance = {
      method: 'disc size + volume ID + decoded hidden-layout SHA-256 + selected volume-descriptor SHA-256',
      full_iso_sha256: null,
      hidden_layout_sha256: await sha256Hex(layout),
      volume_descriptor_sha256: pvd ? await sha256Hex(pvd) : null,
    };
    return U.provenance;
  }

  function checkpointKey(row) {
    const iso = state.iso;
    return `so3-v52:${iso?.name || 'none'}:${iso?.size || 0}:${row.index}:${row.offset}:${row.size}`;
  }

  function loadCheckpoint(row) {
    const key = checkpointKey(row);
    if (U.checkpoints.has(key)) return U.checkpoints.get(key);
    try {
      const value = JSON.parse(localStorage.getItem(key) || '{}');
      U.checkpoints.set(key, value);
      return value;
    } catch (_) { const value = {}; U.checkpoints.set(key, value); return value; }
  }

  function saveCheckpoint(row, value) {
    const key = checkpointKey(row);
    U.checkpoints.set(key, value);
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  }

  function setStatus(text, bad) {
    if (q('v52Status')) {
      q('v52Status').textContent = text;
      q('v52Status').className = `v52-status ${bad ? 'bad' : ''}`;
    }
  }

  function setProgress(value, max = 1) {
    if (!q('v52Progress')) return;
    q('v52Progress').max = Math.max(1, max);
    q('v52Progress').value = Math.max(0, Math.min(value, max));
  }

  function legacyHiddenUnknownCount() {
    return state.hidden.filter((row) => row.sectors && priorRoleInfo(row.header, `entry_${row.index}`, 'hidden').category === 'unknown').length;
  }

  function initialResult(row) {
    const format = row.header || 'UNKNOWN';
    if (format === 'SO3_MOVIE_CARRIER_CANDIDATE') return Object.assign(I.meta(format, {
      display: 'SO3 movie carrier candidate', role: 'Movie-family candidate', category: 'candidates', icon: '🧪', confidence: 'OBSERVED', playable: false, decodable: false,
      evidence: ['8-byte family marker'], reasons: ['Marker only. Recurrence, duplicate-sector, MPEG pack and PES-cadence gates remain pending.'],
    }), { metrics: { raw_header: I.FAMILY8, raw_header_hex: row.rawHeaderHex || I.FAMILY8, bytes_examined: 8, complete_allocation: false } });
    const atlasKnown = ['PACK', 'MWo3', 'XBDC', 'RMAC', 'SEQW', 'FIS', 'FPS', 'RTA', 'FAS', 'DMM', 'VSC', 'TIM2', 'ELF', 'PNG', 'ZLS', 'MPEG_PS'];
    if (atlasKnown.includes(format) || /^(?:SLZ|SLE)[0-3]$/.test(format)) {
      const role = roleInfo(format, `entry_${row.index}`, 'hidden');
      return Object.assign(I.meta(format, {
      role: role.role, category: role.category, icon: role.icon, confidence: 'VERIFIED', evidence: ['verified offset-zero signature'], reasons: ['Classified from the Atlas V1.1.1 signature registry.'],
    }), { metrics: { raw_header: format, raw_header_hex: row.rawHeaderHex || null, bytes_examined: 16, complete_allocation: false } });
    }
    return Object.assign(I.meta('UNKNOWN', {
      display: format, confidence: 'UNRESOLVED', evidence: ['8-byte header observation'], reasons: ['Run Identify unknowns for bounded structural diagnostics.'],
    }), { metrics: { raw_header: format, raw_header_hex: row.rawHeaderHex || (/^[0-9A-F]{16}$/.test(format) ? format : null), bytes_examined: 8, complete_allocation: false } });
  }

  function initializeRows() {
    U.results.clear();
    for (const row of state.hidden.filter((x) => x.sectors && x.size)) {
      row.v52InitialHeader = row.header;
      row.v52LegacyCategory = priorRoleInfo(row.header, `entry_${row.index}`, 'hidden').category;
      row.v52 = initialResult(row);
      U.results.set(row.index, row.v52);
    }
    U.baselineHiddenUnknown = legacyHiddenUnknownCount();
    renderMetrics();
    renderExplorer();
  }

  function rowsByCategory(category) {
    return explorerItems().filter((x) => x.source === 'hidden' && (!category || x.category === category));
  }

  function renderMetrics() {
    if (!q('v52Metrics') || !state.iso) return;
    const rows = state.hidden.filter((x) => x.sectors && x.size).map((x) => x.v52 || initialResult(x));
    q('v52Metrics').innerHTML = [
      ['V5.1 legacy unknown category', U.baselineHiddenUnknown],
      ['V5.3 UNKNOWN classification', rows.filter((x) => x.format === 'UNKNOWN').length],
      ['Unresolved confidence', rows.filter((x) => x.confidence === 'UNRESOLVED').length],
      ['Candidate category', rows.filter((x) => x.category === 'candidates').length],
    ].map(([label, value]) => `<span class="v52-metric"><b>${fmt(value)}</b> ${esc(label)}</span>`).join('');
  }

  function updateRow(row, result) {
    const raw = result.metrics?.raw_header || row.v52?.metrics?.raw_header || row.header;
    result.detector_version = I.VERSION;
    result.atlas = I.ATLAS;
    result.metrics = Object.assign({}, result.metrics || {}, { raw_header: raw, raw_header_hex: result.metrics?.raw_header_hex || row.rawHeaderHex || row.v52?.metrics?.raw_header_hex || null });
    row.v52 = result;
    U.results.set(row.index, result);
    if (result.format !== 'UNKNOWN') row.header = result.format;
    const W = globalThis.SO3V5Workspace, node = W?.state?.nodes?.get(`hidden-table/entry-${row.index}`);
    if (node) {
      node.format = result.format === 'UNKNOWN' ? (result.metrics.raw_header || 'UNKNOWN') : result.format;
      node.evidence = result.confidence;
      node.parserStatus = result.format === 'SO3_MOVIE_CARRIER' ? 'movie_carrier_verified_decodable' : 'v53_classified';
      node.provenance = Object.assign({}, node.provenance, { v53_detector: I.VERSION, movie_transform_va: M.PROVENANCE.function_va, atlas_sha256: I.ATLAS.atlas_sha256 });
    }
  }

  async function completeRecurrence(row, provider, result) {
    const head = await provider.read(0, 8), candidate = I.movieCandidate(provider, head), saved = loadCheckpoint(row);
    let recurrence = saved.recurrence || null;
    while (!recurrence?.complete) {
      if (U.cancel) throw new Error('cancelled');
      recurrence = await I.scanFrameRecurrence(provider, recurrence, 64, async (cp) => {
        saved.recurrence = cp;
        const persisted = saveCheckpoint(row, saved);
        setStatus(`Entry ${row.index}: 0x4000 recurrence ${fmt(cp.checked)}/${fmt(candidate.complete_frames)} frames; ${(cp.ratio * 100).toFixed(2)}% prefix hits. Checkpoint ${persisted ? 'saved' : 'retained in this tab only'}.`);
        await sleep();
      });
    }
    const pass = candidate.family_marker && candidate.sector_aligned && candidate.complete_frames >= 4 && recurrence.ratio >= 0.95;
    const next = Object.assign(I.meta(pass ? 'SO3_MOVIE_FRAMING_CANDIDATE' : 'SO3_MOVIE_CARRIER_NOT_VERIFIED', {
      display: pass ? 'SO3 movie carrier — framing verified, PES pending' : 'Movie marker — framing gate failed',
      role: 'Movie-family candidate', category: 'candidates', icon: '🧪', confidence: pass ? 'VERIFIED_OUTER_FRAMING' : 'UNRESOLVED', playable: false, decodable: false,
      evidence: ['8-byte family marker', `0x4000 prefix recurrence ${(recurrence.ratio * 100).toFixed(2)}%`],
      reasons: pass ? ['Outer framing passes. Duplicate-sector, MPEG pack and PES-cadence gates still remain.'] : ['Marker alone is insufficient and the recurrence gate did not pass.'],
    }), { metrics: result.metrics, detector: { candidate, recurrence } });
    updateRow(row, next);
    return next;
  }

  async function inspectRow(row) {
    const existing = row.v52;
    if (existing?.format === 'SO3_MOVIE_CARRIER' ||
        (existing?.format === 'SO3_MOVIE_CARRIER_NOT_VERIFIED' && Object.prototype.hasOwnProperty.call(existing.detector || {}, 'duplicate_groups'))) return existing;
    const provider = providerFor(row), fullLimit = 1024 * 1024, sampleLimit = 0x10000, complete = row.size <= fullLimit;
    const bytes = await provider.read(0, complete ? row.size : Math.min(row.size, sampleLimit));
    const diagnostics = I.inspectSample(bytes, { complete: false });
    let result = await I.detectSemanticBundleSparse(provider);
    if (result) result = Object.assign(result, { metrics: diagnostics.metrics });
    if (!result) {
      const bank = await I.detectSeqwBank(provider);
      if (bank) result = Object.assign(bank, { metrics: diagnostics.metrics });
    }
    if (!result) result = I.inspectSample(bytes, { complete });
    updateRow(row, result);
    if (result.format === 'SO3_MOVIE_CARRIER_CANDIDATE') result = await completeRecurrence(row, provider, result);
    return result;
  }

  async function identifyUnknowns() {
    if (!state.iso) return setStatus('Open the PAL Disc 1 ISO first.', true);
    if (U.running) return;
    U.running = true; U.cancel = false; U.started = new Date().toISOString(); U.finished = null;
    const targets = state.hidden.filter((row) => row.sectors && row.size && ['unknown', 'candidates'].includes(roleInfo(row.v52?.format || row.header, `entry_${row.index}`, 'hidden').category));
    setProgress(0, targets.length);
    try {
      for (let i = 0; i < targets.length; i++) {
        if (U.cancel) throw new Error('cancelled');
        const row = targets[i]; U.current = row.index;
        setStatus(`Identifying entry ${row.index} (${i + 1}/${targets.length})…`);
        try { await inspectRow(row); }
        catch (error) {
          if (error.message === 'cancelled') throw error;
          const current = row.v52 || initialResult(row);
          current.reasons = [...(current.reasons || []), `Detector stopped safely: ${error.message}`];
          updateRow(row, current);
        }
        setProgress(i + 1, targets.length);
        if (i % 4 === 3) { renderExplorer(); renderMetrics(); await sleep(); }
      }
      U.finished = new Date().toISOString();
      setStatus(`Identification pass complete. ${rowsByCategory('unknown').length} hidden allocations remain unresolved; ${rowsByCategory('candidates').length} remain evidence-bearing candidates.`);
    } catch (error) {
      setStatus(error.message === 'cancelled' ? 'Identification paused. Movie-frame checkpoints were saved; tap Identify unknowns to resume.' : `Identification stopped: ${error.message}`, error.message !== 'cancelled');
    } finally {
      U.running = false; U.current = null; renderExplorer(); renderHidden(); renderMetrics();
    }
  }

  async function deepValidateCarrier(row) {
    const provider = providerFor(row), saved = loadCheckpoint(row), head = await provider.read(0, 8), candidate = I.movieCandidate(provider, head);
    let result = row.v52 || initialResult(row), recurrence = saved.recurrence;
    if (!recurrence?.complete) {
      result = await completeRecurrence(row, provider, result);
      recurrence = result.detector.recurrence;
    }
    if (recurrence.ratio < 0.95) return result;
    let groups = saved.duplicate_groups || null;
    if (!groups) {
      setStatus(`Entry ${row.index}: searching exact duplicate sectors. This reads the allocation once and can be stopped safely.`);
      groups = await I.findDuplicateSectors(provider, {
        cancelled: () => U.cancel,
        progress: async (p) => { setStatus(`Entry ${row.index}: duplicate-sector scan ${fmt(p.next_sector)}/${fmt(p.sectors)} sectors.`); await sleep(); },
      });
      saved.duplicate_groups = groups;
      saveCheckpoint(row, saved);
    }
    if (!groups.length) {
      result = I.finalizeMovie(candidate, recurrence, groups, null, null);
      result.metrics = row.v52.metrics; result.detector = { candidate, recurrence, duplicate_groups: [] }; updateRow(row, result); return result;
    }
    let pad = saved.pad_probe || null;
    if (!pad) {
      setStatus(`Entry ${row.index}: testing duplicate-sector rotations against MPEG pack grammar.`);
      pad = await I.findBestPadProbe(provider, groups, { cancelled: () => U.cancel, progress: async () => sleep() });
      saved.pad_probe = pad;
      saveCheckpoint(row, saved);
    }
    if (!pad || pad.ratio < 0.95) {
      result = I.finalizeMovie(candidate, recurrence, groups, pad, null);
      result.metrics = row.v52.metrics; result.detector = { candidate, recurrence, duplicate_groups: groups, pad_probe: pad }; updateRow(row, result); return result;
    }
    let mask = saved.mask_base64 ? I.base64ToBytes(saved.mask_base64) : await I.diagnosticMask(provider, pad);
    saved.mask_base64 = I.bytesToBase64(mask);
    let cadence = saved.cadence || null;
    while (!cadence?.complete) {
      if (U.cancel) throw new Error('cancelled');
      cadence = await I.scanPesCadence(provider, mask, cadence, 32, async (cp) => {
        saved.cadence = cp; const persisted = saveCheckpoint(row, saved);
        setStatus(`Entry ${row.index}: PES cadence ${fmt(cp.checked)}/${fmt(candidate.complete_frames)} frames; ${(cp.valid_frame_ratio * 100).toFixed(2)}% exact frame chains. Checkpoint ${persisted ? 'saved' : 'retained in this tab only'}.`);
        await sleep();
      });
    }
    result = I.finalizeMovie(candidate, recurrence, groups, pad, cadence);
    result.metrics = row.v52.metrics;
    result.detector = { candidate, recurrence, duplicate_groups: groups, pad_probe: pad, cadence };
    updateRow(row, result);
    renderExplorer(); renderHidden(); renderMetrics();
    return result;
  }

  async function deepValidateOne(index) {
    if (!state.iso || U.running) return;
    const row = state.hidden.find((x) => x.index === Number(index));
    if (!row) return setStatus(`Entry ${index} is unavailable.`, true);
    U.running = true; U.cancel = false; U.current = row.index;
    try {
      const result = await deepValidateCarrier(row);
      setStatus(`Entry ${row.index}: ${result.display}; confidence ${result.confidence}; exact decode=${result.decodable === true ? 'available' : 'not enabled'}.`);
    } catch (error) {
      setStatus(error.message === 'cancelled' ? `Entry ${row.index} paused. Frame checkpoints were saved.` : `Entry ${row.index} validation stopped: ${error.message}`, error.message !== 'cancelled');
    } finally { U.running = false; U.current = null; renderExplorer(); renderMetrics(); }
  }

  async function deepValidateAll() {
    if (!state.iso) return setStatus('Open the PAL Disc 1 ISO first.', true);
    if (U.running) return;
    U.running = true; U.cancel = false;
    const rows = state.hidden.filter((row) => row.sectors && row.size && /^SO3_MOVIE_/.test(row.v52?.format || row.header));
    setProgress(0, rows.length);
    try {
      for (let i = 0; i < rows.length; i++) {
        if (U.cancel) throw new Error('cancelled');
        U.current = rows[i].index;
        await deepValidateCarrier(rows[i]);
        setProgress(i + 1, rows.length);
      }
      setStatus(`Deep movie validation complete: ${rows.filter((x) => x.v52?.format === 'SO3_MOVIE_CARRIER').length}/${rows.length} candidates passed all structural gates. Verified carriers now expose exact MPEG-PS decode.`);
    } catch (error) {
      setStatus(error.message === 'cancelled' ? 'Deep validation paused. Completed frame checkpoints were saved.' : `Deep validation stopped: ${error.message}`, error.message !== 'cancelled');
    } finally { U.running = false; U.current = null; renderExplorer(); renderHidden(); renderMetrics(); }
  }

  async function decodeMovie(index) {
    if (!state.iso) return setStatus('Open the PAL Disc 1 ISO first.', true);
    if (U.running) return;
    const row = state.hidden.find((x) => x.index === Number(index));
    if (!row) return setStatus(`Entry ${index} is unavailable.`, true);
    U.running = true; U.cancel = false; U.current = row.index;
    try {
      let result = row.v52 || initialResult(row);
      if (result.format !== 'SO3_MOVIE_CARRIER') result = await deepValidateCarrier(row);
      if (result.format !== 'SO3_MOVIE_CARRIER' || result.decodable !== true)
        throw new Error('carrier did not pass every gate; exact decode remains disabled');

      const provider = providerFor(row);
      setProgress(0, row.size);
      setStatus(`Entry ${row.index}: applying the Lib 0x0041A2F0 inverse to ${fmt(row.size)} bytes.`);
      const decoded = await M.decodeProvider(provider, {
        cancelled: () => U.cancel,
        progress: async (p) => {
          setProgress(p.bytes, p.size);
          setStatus(`Entry ${row.index}: decoded ${fmt(p.bytes)}/${fmt(p.size)} bytes; ${fmt(p.valid_frame_prefixes)}/${fmt(p.checked_frames)} complete frame prefixes valid.`);
          await sleep();
        },
      });
      if (!decoded.validation.valid) throw new Error('decoded output failed MPEG pack/system/video-PES header validation');
      if (decoded.checked_frames >= 4 && decoded.frame_prefix_ratio < 0.95) throw new Error(`decoded frame-prefix ratio ${(decoded.frame_prefix_ratio * 100).toFixed(2)}% is below 95%`);
      if (!decoded.blob) throw new Error('this browser cannot construct the decoded download blob');

      const box = q('explorerDownloads');
      setStatus(`Entry ${row.index}: video ready; decoding tri-Ace SAC and muxing standard stereo audio.`);
      const audioDecoded = A.decodeParts(decoded.parts);
      const muxed = X.muxProgramStream(A.concat(decoded.parts), audioDecoded);
      if (!muxed.blob) throw new Error('this browser cannot construct the muxed movie blob');
      const name = `entry_${String(row.index).padStart(4, '0')}_SO3_CUTSCENE_WITH_AUDIO.mpg`;
      addDownload(box, name, muxed.blob, 'video/mpeg');
      const preview = document.createElement('section');
      preview.className = 'v52-evidence';
      preview.innerHTML = `<h3>${esc(name)}</h3><div class="notice"><b>One normal movie file is ready.</b> It contains the original MPEG-2 video elementary stream and the recovered 48 kHz stereo audio as standard DVD LPCM. Audio and video retain the carrier's shared start timestamp.</div>`;
      const video = document.createElement('video');
      video.controls = true; video.playsInline = true; video.preload = 'metadata'; video.style.maxWidth = '100%';
      video.src = URL.createObjectURL(muxed.blob);
      video.onerror = () => {
        const note = document.createElement('div');
        note.className = 'notice';
        note.textContent = 'This browser does not natively preview MPEG-2/LPCM. The downloaded MPG contains both streams and plays in VLC, FFmpeg, and other MPEG-PS players.';
        preview.append(note);
      };
      preview.append(video); box.append(preview);

      const record = {
        size: muxed.metrics.output_bytes,
        filename: name,
        frame_prefix_ratio: decoded.frame_prefix_ratio,
        checked_frames: decoded.checked_frames,
        validation: decoded.validation,
        transform: M.PROVENANCE,
        muxed_audio: {
          codec: 'DVD LPCM',
          channels: muxed.metrics.channels,
          first_pts: muxed.metrics.first_audio_pts,
          replaced_sac_packets: muxed.metrics.replaced_sac_packets,
          lpcm_packets: muxed.metrics.lpcm_packets,
          sac_size: audioDecoded.result.sac_size,
          blocks: audioDecoded.result.header.block_count,
          crc_passed: audioDecoded.result.crc_passed,
          samples_per_channel: audioDecoded.result.left.length,
          sample_rate: audioDecoded.result.sample_rate,
          duration_seconds: audioDecoded.result.left.length / audioDecoded.result.sample_rate,
        },
      };
      U.decodedMovies.set(row.index, record);
      result = Object.assign({}, result, { playable: true, decodable: true, browser_preview: 'codec-dependent', decoder: record });
      updateRow(row, result);
      setStatus(`Entry ${row.index}: one MPG with video + audio is ready. ${fmt(muxed.metrics.output_bytes)} bytes; ${fmt(audioDecoded.result.left.length)} stereo samples; ${audioDecoded.result.crc_passed}/${audioDecoded.result.header.block_count} SAC CRCs passed.`);
    } catch (error) {
      setStatus(error.message === 'cancelled' ? `Entry ${row.index} decode stopped safely.` : `Entry ${row.index} decode failed: ${error.message}`, error.message !== 'cancelled');
    } finally {
      U.running = false; U.current = null; renderExplorer(); renderHidden(); renderMetrics();
    }
  }

  function census() {
    const sourceRows = state.hidden.filter((x) => x.sectors && x.size);
    const clusters = new Map();
    for (const row of sourceRows) {
      const r = row.v52 || initialResult(row), key = r.metrics?.raw_header_hex || r.metrics?.raw_header || row.rawHeaderHex || row.v52InitialHeader || row.header || 'UNKNOWN';
      clusters.set(key, (clusters.get(key) || 0) + 1);
    }
    const rows = sourceRows.map((row) => {
      const r = row.v52 || initialResult(row);
      const key = r.metrics?.raw_header_hex || r.metrics?.raw_header || row.rawHeaderHex || row.v52InitialHeader || row.header || 'UNKNOWN';
      return {
        entry: row.index, lba: row.lba, iso_offset: row.offset, size: row.size, sectors: row.sectors,
        legacy_header: row.v52InitialHeader || null, legacy_category: row.v52LegacyCategory || null,
        classification: r.format, display: r.display, category: r.category, confidence: r.confidence,
        playable: r.playable, decodable: r.decodable, browser_preview: r.browser_preview || null,
        evidence: r.evidence || [], reasons: r.reasons || [],
        metrics: Object.assign({}, r.metrics || {}, { raw_header_hex: r.metrics?.raw_header_hex || row.rawHeaderHex || null, header_cluster_count: clusters.get(key) || 1 }),
        structure: r.structure || null, detector: r.detector || null, decoder: r.decoder || U.decodedMovies.get(row.index) || null,
      };
    });
    const counts = {}, confidence = {}, categories = {}, transitions = {};
    for (const row of rows) {
      counts[row.classification] = (counts[row.classification] || 0) + 1;
      confidence[row.confidence] = (confidence[row.confidence] || 0) + 1;
      categories[row.category] = (categories[row.category] || 0) + 1;
      const transition = `${row.legacy_category || 'unrecorded'} -> ${row.category}`;
      transitions[transition] = (transitions[transition] || 0) + 1;
    }
    return {
      format: 'SO3_V550_IDENTIFICATION_CENSUS', version: 5, tool_version: I.VERSION,
      created: new Date().toISOString(), scan_started: U.started, scan_finished: U.finished,
      disc: { name: state.iso?.name || null, size: state.iso?.size || null, volume: state.isoInfo?.chosen?.volumeId || null, provenance: U.provenance },
      atlas: I.ATLAS,
      policy: { marker_alone_is_final: false, exact_movie_decode_requires_all_carrier_gates: true, movie_decoder: 'Lib 0x0041A2F0 executable-derived inverse', browser_preview: 'codec-dependent', unresolved_preserved: true },
      summary: {
        hidden_allocations: rows.length,
        legacy_v5_1_unknown_category: U.baselineHiddenUnknown,
        unknown_classification: rows.filter((x) => x.classification === 'UNKNOWN').length,
        unresolved_confidence: rows.filter((x) => x.confidence === 'UNRESOLVED').length,
        candidate_category_total: rows.filter((x) => x.category === 'candidates').length,
        hypothesis_confidence: rows.filter((x) => x.confidence === 'HYPOTHESIS').length,
        strong_inference_confidence: rows.filter((x) => x.confidence === 'STRONG_INFERENCE').length,
        verified_outer_framing: rows.filter((x) => x.confidence === 'VERIFIED_OUTER_FRAMING').length,
        verified_movie_carriers: rows.filter((x) => x.classification === 'SO3_MOVIE_CARRIER').length,
        decodable_movie_carriers: rows.filter((x) => x.classification === 'SO3_MOVIE_CARRIER' && x.decodable === true).length,
        decoded_in_session: rows.filter((x) => x.decoder).length,
        classifications: counts, confidence, categories, legacy_to_current_category: transitions,
      },
      rows,
    };
  }

  function csvText(rows) {
    const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const keys = ['entry', 'lba', 'iso_offset', 'size', 'sectors', 'legacy_header', 'legacy_category', 'classification', 'display', 'category', 'confidence', 'playable', 'decodable', 'browser_preview', 'raw_header_hex', 'raw_header', 'entropy', 'printable_ratio', 'zero_ratio', 'header_cluster_count', 'evidence', 'reasons'];
    return keys.join(',') + '\n' + rows.map((r) => [r.entry, r.lba, r.iso_offset, r.size, r.sectors, r.legacy_header, r.legacy_category, r.classification, r.display, r.category, r.confidence, r.playable, r.decodable, r.browser_preview, r.metrics?.raw_header_hex, r.metrics?.raw_header, r.metrics?.entropy, r.metrics?.printable_ratio, r.metrics?.zero_ratio, r.metrics?.header_cluster_count, (r.evidence || []).join(' | '), (r.reasons || []).join(' | ')].map(quote).join(',')).join('\n') + '\n';
  }

  function exportCensus() {
    if (!state.iso) return setStatus('Open the PAL Disc 1 ISO first.', true);
    const report = census(), box = q('explorerDownloads');
    clearBox('explorerDownloads');
    addDownload(box, 'SO3_V550_IDENTIFICATION_CENSUS.json', JSON.stringify(report, null, 2), 'application/json');
    addDownload(box, 'SO3_V550_IDENTIFICATION_CENSUS.csv', csvText(report.rows), 'text/csv');
    setStatus(`Exported ${report.rows.length} hidden-allocation identification records. ISO bytes were not embedded.`);
  }

  q('v52IdentifyBtn').onclick = identifyUnknowns;
  q('v52MovieBtn').onclick = deepValidateAll;
  q('v52StopBtn').onclick = () => { U.cancel = true; setStatus('Stop requested. The current safe batch will finish and frame checkpoints will be retained.'); };
  q('v52ExportBtn').onclick = exportCensus;
  q('explorerDetails').addEventListener('click', (event) => {
    const button = event.target.closest('[data-v52deep]');
    if (button) { event.preventDefault(); deepValidateOne(button.dataset.v52deep); }
    const decode = event.target.closest('[data-v53decode]');
    if (decode) { event.preventDefault(); decodeMovie(decode.dataset.v53decode); }
  });

  const priorOpen = q('openBtn').onclick;
  q('openBtn').onclick = async (event) => {
    await priorOpen(event);
    if (!state.iso) return;
    U.started = U.finished = null; U.cancel = false; U.running = false;
    await buildDiscProvenance();
    initializeRows();
    setStatus(`V5.3 initial classification ready. Candidate categories and unresolved confidence are separate; verified movie carriers expose exact MPEG-PS decode.`);
  };

  function applyBranding() {
    document.title = 'SO3 Resource Explorer V5.5.0 — Muxed Cutscenes';
    document.querySelector('.appbar h1').textContent = 'SO3 Resource Explorer V5.5.0';
    document.querySelector('.appbar p').textContent = 'V5.4 preserved • one-file cutscene video + LPCM audio • Atlas V1.1.1 • offline and read-only.';
  }
  applyBranding();
  setTimeout(applyBranding, 0);
  const API = Object.freeze({ state: U, identifyUnknowns, inspectRow, deepValidateCarrier, decodeMovie, census, providerFor, buildDiscProvenance, applyBranding });
  globalThis.SO3V53Integration = API;
  globalThis.SO3V52Integration = API;
})();
