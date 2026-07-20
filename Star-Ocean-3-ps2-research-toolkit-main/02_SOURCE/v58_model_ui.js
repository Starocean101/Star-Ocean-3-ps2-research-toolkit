/* SO3 Resource Explorer V5.12.8 Pass 6.2 original node-matrix execution. */
(function () {
  'use strict';
  const A = globalThis.SO3V58Assembler, Index = globalThis.SO3V58ModelIndex, Catalog = globalThis.SO3V58Catalog;
  if (!A || !Index || !Catalog || typeof document === 'undefined') throw new Error('V5.8 model assembler, index, and catalogue are required');
  const q = (id) => document.getElementById(id), html = globalThis.esc || ((value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]));
  const enc = new TextEncoder();
  const UI = { actorId: null, assembly: null, renderer: null, sourceFiles: null, materialSelections: new Map() };

  function addUi() {
    if (q('page-v58lab')) return;
    q('tabs').insertAdjacentHTML('beforeend', '<button class="tab" data-page="v58lab">V5.12 Model Lab</button>');
    q('page-reports').insertAdjacentHTML('beforebegin', `
<section id="page-v58lab" class="page">
  <div class="card v58-hero"><div><h2>V5.12.8 Pass 6.2 original node-matrix evidence</h2><p>Loads indexed actors directly from the ISO. Original type-0x0135 rotation evaluation, concrete target-node setter, local/world writer, and controlled parent composition are verified. Matrix-to-packet binding and visible mesh skinning remain separately withheld.</p></div><span class="v58-release-badge">PASS 6.2</span></div>
  <div class="card">
    <h2>Assemble an actor</h2>
    <div class="v58-source-grid">
      <label>Actor ID<input id="v58ActorId" value="0x0BC0" placeholder="0x0BC0"></label>
      <label class="file-button">Geometry (FPS / XBDC / RMAC)<input id="v58GeometryFile" type="file" accept=".bin,.fps,.xbdc,.rmac"></label>
      <label class="file-button">RTA skeleton<input id="v58RtaFile" type="file" accept=".rta,.bin"></label>
      <label class="file-button">FAS animation(s)<input id="v58FasFiles" type="file" multiple accept=".fas,.bin"></label>
    </div>
    <div class="v58-buttons"><button id="v511LoadActorIso" class="action">Load and assemble selected actor from open ISO</button><button id="v58AssembleTree" class="action secondary">Use already-loaded Workspace nodes</button><button id="v58AssembleFiles" class="action ghost">Assemble uploaded components</button><button id="v58ResetView" class="action ghost">Reset view</button></div>
    <div id="v58AssemblyStatus" class="status">Open the SO3 ISO, tap an actor card, then press <b>Load and assemble selected actor from open ISO</b>.</div>
    <div id="v58AssemblyMetrics" class="metric-grid"></div>
  </div>
  <div class="card">
    <h2>Canonical actor groups from Atlas V1.1.1</h2>
    <p class="help">These cards are an index, not proof that every source byte is currently loaded. Tap a card to stage its actor ID.</p>
    <div id="v58ActorIndex" class="v58-actor-index"></div>
  </div>
  <div class="card v58-view-grid">
    <div><div class="v58-section-head"><h2>Geometry preview</h2><span id="v58RenderGrade" class="v58-grade">No assembly</span></div><div class="v58-model-view"><canvas id="v58ModelCanvas" aria-label="3D diagnostic model viewer"></canvas><div class="v58-view-help">Drag to rotate • pinch/wheel to zoom • PS2-filtered material preview</div></div><div class="v58-preview-controls"><button id="v58ResetMaterials" class="action ghost">Reset linked materials</button><label class="checkline"><input id="v58LinearFiltering" type="checkbox" checked> PS2-style filtered textures</label><label class="checkline"><input id="v58ShowAuxiliary" type="checkbox"> Show unresolved no-UV auxiliary layer</label><span id="v58AuxiliarySummary" class="help">No assembly.</span></div></div>
    <aside><h2>Evidence gates</h2><div id="v58Gates" class="v58-gates"><p class="help">No assembly.</p></div><h3>Reasoning boundary</h3><div id="v58Warnings" class="status">No inferred link is applied silently.</div></aside>
  </div>
  <div class="card"><div class="v58-section-head"><h2>Embedded textures</h2><span class="help">Tap a verified FISA face frame to change only its linked material slot. Each observed facial FIS has one logical 16-color CSM1 CLUT; the former “bank 0 / bank 1” split was a decoder error.</span></div><div id="v58Textures" class="v58-textures"><p class="help">No decoded textures.</p></div></div>
  <div class="card v58-two-col"><div><h2>RTA node records</h2><canvas id="v58SkeletonCanvas" class="v58-skeleton" aria-label="RTA spatial preview status"></canvas><div id="v58SkeletonInfo" class="table-wrap"></div></div><div><h2>Matrix-address candidates</h2><div id="v58MatrixInfo" class="table-wrap"></div></div></div>
  <div class="card v58-two-col"><div><h2>Material patch diagnostics</h2><div id="v58Materials" class="table-wrap"></div></div><div><h2>FAS name bindings</h2><div id="v58Animations" class="table-wrap"></div></div></div>
  <div class="card v58-export-card"><h2>Evidence-safe exports</h2><p class="notice">The ZIP includes diagnostic geometry and decoded textures. Original FAS-to-node matrix execution is verified for actors 0x08FF and 0x0BC0; the export does not claim the withheld matrix-to-packet link, final skinning, or automatic browser playback.</p><div class="v58-buttons"><button id="v58ExportAssembly" class="action" disabled>Download assembly ZIP</button><button id="v58ExportAtlas" class="action secondary" disabled>Download Atlas update</button></div><div id="v58Downloads"></div></div>
</section>`);

    const style = document.createElement('style'); style.id = 'so3-v58-styles'; style.textContent = `
      .v58-hero{display:flex;justify-content:space-between;align-items:center;gap:18px;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 13%,var(--panel)),var(--panel))}.v58-hero h2{margin:0 0 6px}.v58-release-badge,.v58-grade{display:inline-flex;border:1px solid currentColor;border-radius:999px;padding:5px 10px;font-weight:800;white-space:nowrap}.v58-release-badge{color:var(--accent)}
      .v58-source-grid{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px;align-items:end}.v58-buttons{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.v58-buttons .action,.v58-source-grid .file-button{min-height:44px;margin:0}.v58-actor-index{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:9px}.v58-actor-card{border:1px solid var(--line);border-radius:11px;padding:10px;background:var(--panel2);cursor:pointer;min-height:96px;text-align:left;color:inherit}.v58-actor-card.active{outline:3px solid color-mix(in srgb,var(--accent) 55%,transparent)}.v58-actor-card b{font-size:15px}.v58-actor-card small{display:block;color:var(--muted);margin-top:5px}.v58-actor-state{font-size:9px;font-weight:800;color:var(--accent)}
      .v58-view-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(250px,1fr);gap:14px}.v58-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.v58-model-view{position:relative;height:min(68vh,700px);min-height:380px;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:radial-gradient(circle at 50% 40%,#202b3b,#070a0f 70%)}.v58-model-view canvas{display:block;width:100%;height:100%;touch-action:none}.v58-view-help{position:absolute;left:8px;bottom:8px;padding:5px 8px;border-radius:7px;background:#000b;color:#fff;font-size:10px;pointer-events:none}.v58-preview-controls{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-top:9px}.v58-preview-controls .action{margin:0}.v58-gates{display:grid;gap:7px}.v58-gate{display:flex;justify-content:space-between;gap:8px;border:1px solid var(--line);border-radius:8px;padding:7px}.v58-pass{color:#197a43}.v58-blocked{color:#9a4d00}.v58-textures{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px}.v58-texture{border:1px solid var(--line);border-radius:10px;padding:8px;background:var(--panel2);text-align:left;color:inherit;cursor:pointer}.v58-texture.selected{outline:3px solid color-mix(in srgb,var(--accent) 55%,transparent)}.v58-texture canvas{display:block;width:100%;max-width:160px;aspect-ratio:1;image-rendering:pixelated;margin:auto;background:#999}.v58-texture b,.v58-texture small{display:block;margin-top:5px}.v58-two-col{display:grid;grid-template-columns:1fr 1fr;gap:14px}.v58-skeleton{display:block;width:100%;height:420px;border:1px solid var(--line);border-radius:10px;background:#0b1019}.v58-label-card,.v58-catalog-controls{border:1px solid var(--line);border-radius:10px;padding:10px;margin:10px 0;background:var(--panel2)}.v58-control-grid,.v58-label-grid{display:grid;grid-template-columns:repeat(2,minmax(140px,1fr));gap:8px}.v58-span{grid-column:1/-1}.v58-reviewed{display:flex!important;align-items:center;gap:7px}.v58-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9px;word-break:break-all}.v58-export-card{scroll-margin-bottom:max(760px,65vh)}.v4-selection-bar.v58-empty-selection{display:none!important}
      @media(max-width:850px){.v58-source-grid{grid-template-columns:1fr 1fr}.v58-view-grid,.v58-two-col{grid-template-columns:1fr}.v58-model-view{height:56vh;min-height:340px}}
      @media(max-width:700px){html{scroll-padding-bottom:max(760px,65vh)}.shell{padding-bottom:calc(max(760px,65vh) + env(safe-area-inset-bottom))!important}.download,#v58Downloads,.v58-export-card{scroll-margin-bottom:max(760px,65vh)}.v58-hero{align-items:flex-start}.v58-source-grid,.v58-control-grid,.v58-label-grid{grid-template-columns:1fr}.v58-span{grid-column:auto}.v58-buttons{display:grid;grid-template-columns:1fr}.v58-buttons>*{width:100%}.v58-preview-controls{display:grid;grid-template-columns:1fr}.v58-preview-controls .action{width:100%}.v58-skeleton{height:340px}.v58-textures{grid-template-columns:repeat(2,minmax(0,1fr))}.v4-selection-bar:not(.v58-empty-selection){top:6px;padding:7px}.v4-selection-bar:not(.v58-empty-selection) .summary{flex-basis:100%;min-width:0}.v4-selection-bar:not(.v58-empty-selection) .action{margin:0;min-height:42px;padding:8px 11px}}
    `; document.head.append(style);

    document.querySelector('[data-page="v58lab"]').onclick = () => globalThis.switchPage ? globalThis.switchPage('v58lab') : switchPage('v58lab');
  }

  function installSelectionTrayCompaction() {
    const bar = q('v4SelectionBar'), summary = q('v4TopSelectionSummary');
    if (!bar || !summary) return;
    const sync = () => bar.classList.toggle('v58-empty-selection', /^\s*0 selected\b/i.test(summary.textContent || ''));
    sync();
    if (typeof MutationObserver !== 'undefined') new MutationObserver(sync).observe(summary, { childList: true, subtree: true, characterData: true });
  }

  function actorNumber(value) {
    const text = String(value || '').trim(); return /^0x/i.test(text) ? Number.parseInt(text.slice(2), 16) : Number.parseInt(text, 10);
  }
  function actorHex(value) { return `0x${Number(value).toString(16).toUpperCase().padStart(4, '0')}`; }
  function fmt(value) { return Number(value || 0).toLocaleString(); }
  function setStatus(message, bad) { q('v58AssemblyStatus').textContent = message; q('v58AssemblyStatus').className = `status${bad ? ' bad' : ''}`; }
  function fileBytes(file) { return file.arrayBuffer().then((buffer) => new Uint8Array(buffer)); }

  function indexedActor(value) {
    return A.findIndexedActor(actorNumber(value));
  }

  async function assembleIndexedActorFromIso() {
    const actor = indexedActor(q('v58ActorId').value);
    if (!actor) throw new Error('Choose one of the indexed actor cards first');
    UI.actorId = actor.actor_id; q('v58ActorId').value = actor.actor_id; renderActorIndex();
    const bridge = globalThis.SO3V44MediaBridge;
    UI.assembly = (await A.assembleIndexedIsoActor(actor.actor_id, bridge, async ({ stage, resource, index, total }) => {
      if (stage === 'read') {
        setStatus(`Actor ${actor.actor_id}: reading ${resource.tag} ${resource.res_id} (${index + 1}/${total}) from hidden entry ${resource.entry}…`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })).assembly;
    renderAssembly();
    setStatus(`Actor ${actor.actor_id} loaded directly from the open ISO: ${UI.assembly.counts.vertices.toLocaleString()} vertices, ${UI.assembly.counts.texture_files} textures, ${UI.assembly.counts.rta_nodes} RTA records, ${UI.assembly.counts.animation_clips} animation clips.`);
  }

  function renderActorIndex() {
    q('v58ActorIndex').innerHTML = Index.actors.map((actor) => `<button class="v58-actor-card ${UI.actorId === actor.actor_id ? 'active' : ''}" data-v58actor="${actor.actor_id}"><b>Actor ${actor.actor_id}</b><span class="v58-actor-state">${html(actor.assembly_state)}</span><small>${actor.component_counts.geometry} geometry • ${actor.component_counts.skeleton} skeleton • ${actor.component_counts.animation} animation</small><small>${actor.resources.reduce((n, x) => n + (x.stored_size || 0), 0).toLocaleString()} stored bytes indexed</small></button>`).join('');
  }

  class ModelRenderer {
    constructor(canvas) {
      this.canvas = canvas; this.gl = canvas.getContext('webgl', { alpha: false, antialias: true }); this.defaultRotX = -0.2; this.defaultRotY = 0.4; this.rotX = this.defaultRotX; this.rotY = this.defaultRotY; this.zoom = 0.8; this.drag = null; this.pinch = null; this.pointers = new Map(); this.batches = []; this.materialTextures = new Map(); this.materialVisibility = new Map(); this.linearFiltering = true;
      if (!this.gl) throw new Error('WebGL is unavailable in this browser');
      /* FIS decode stores GS row y=0 first and the source ST stream also uses
       * v=0 for that row. WebGL samples the first uploaded row at t=0, so an
       * extra 1-v inversion is incorrect and swaps the body atlas vertically. */
      this.program = this.makeProgram(`attribute vec3 aPos;attribute vec3 aNormal;attribute vec2 aUv;uniform vec3 uCenter;uniform float uScale;uniform float uAspect;uniform float uZoom;uniform vec2 uRot;varying vec2 vUv;varying float vLight;vec3 turn(vec3 p){float cy=cos(uRot.y),sy=sin(uRot.y),cx=cos(uRot.x),sx=sin(uRot.x);p=vec3(cy*p.x+sy*p.z,p.y,-sy*p.x+cy*p.z);return vec3(p.x,cx*p.y-sx*p.z,sx*p.y+cx*p.z);}void main(){vec3 p=turn((aPos-uCenter)*uScale);vec3 n=normalize(turn(aNormal));gl_Position=vec4(p.x/uAspect*uZoom,p.y*uZoom,p.z*.12,1.0);vUv=aUv;vLight=.32+.68*abs(dot(n,normalize(vec3(.35,.55,1.0))));}`, `precision mediump float;varying vec2 vUv;varying float vLight;uniform sampler2D uTex;uniform float uUseTex;void main(){vec4 flatColor=vec4(.62,.72,.86,1.0);vec4 tex=texture2D(uTex,vUv);vec4 base=mix(flatColor,tex,uUseTex);if(base.a<.08)discard;gl_FragColor=vec4(base.rgb*vLight,max(base.a,.25));}`);
      this.bindEvents(); this.emptyTexture();
    }
    shader(type, source) { const gl = this.gl, s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
    makeProgram(vertex, fragment) { const gl = this.gl, p = gl.createProgram(); gl.attachShader(p, this.shader(gl.VERTEX_SHADER, vertex)); gl.attachShader(p, this.shader(gl.FRAGMENT_SHADER, fragment)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; }
    buffer(name, size, values) { const gl = this.gl, b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW); const loc = gl.getAttribLocation(this.program, name); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); return b; }
    filterTexture(texture) { const gl = this.gl, filter = this.linearFiltering ? gl.LINEAR : gl.NEAREST; gl.bindTexture(gl.TEXTURE_2D, texture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter); }
    uploadTexture(decoded) { const gl = this.gl, texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, decoded.width, decoded.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, decoded.rgba); this.filterTexture(texture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return texture; }
    emptyTexture() { this.whiteTexture = this.uploadTexture({ width: 1, height: 1, rgba: new Uint8Array([255, 255, 255, 255]) }); }
    clearMaterialTextures() { for (const texture of this.materialTextures.values()) this.gl.deleteTexture(texture); this.materialTextures.clear(); this.materialVisibility.clear(); }
    setAssembly(assembly) {
      const positions = [], normals = [], uvs = [], m = assembly.model, zUp = !!assembly.model.fixedProfile, slotByPacket = new Map(assembly.materials.packet_assignments.map((row) => [row.packet, row.material_slot])); this.batches = [];
      for (const packet of m.packets) {
        const first = positions.length / 3, slot = slotByPacket.get(packet.packet) ?? -1;
        for (let ti = packet.triangleStart; ti < packet.triangleStart + packet.triangleCountRendered; ti++) for (const index of m.triangles[ti]) { const v = m.vertices[index], position = zUp ? [v.position[0], v.position[2], -v.position[1]] : v.position, normal = zUp ? [v.normal[0], v.normal[2], -v.normal[1]] : v.normal; positions.push(...position); normals.push(...normal); uvs.push(...v.uv); }
        const count = positions.length / 3 - first;
        if (!count) continue;
        const previous = this.batches[this.batches.length - 1];
        if (previous && previous.material_slot === slot && previous.first + previous.count === first) previous.count += count;
        else this.batches.push({ material_slot: slot, first, count });
      }
      if (!positions.length) throw new Error('No renderable triangles');
      const mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) { mins[a] = Math.min(mins[a], positions[i + a]); maxs[a] = Math.max(maxs[a], positions[i + a]); }
      this.center = mins.map((x, i) => (x + maxs[i]) / 2); this.scale = 1.65 / Math.max(...maxs.map((x, i) => x - mins[i]), 1e-6); this.count = positions.length / 3; this.defaultRotX = assembly.model.fixedProfile ? -0.1 : -0.2; this.defaultRotY = assembly.model.fixedProfile ? Math.PI : 0.4;
      const gl = this.gl; gl.useProgram(this.program); this.buffer('aPos', 3, new Float32Array(positions)); this.buffer('aNormal', 3, new Float32Array(normals)); this.buffer('aUv', 2, new Float32Array(uvs)); this.reset();
    }
    setMaterialTexture(slot, decoded, redraw = true) { const old = this.materialTextures.get(slot); if (old) this.gl.deleteTexture(old); this.materialTextures.set(slot, this.uploadTexture(decoded)); if (redraw) this.draw(); }
    setMaterialVisible(slot, visible, redraw = true) { this.materialVisibility.set(slot, !!visible); if (redraw) this.draw(); }
    setTextureFiltering(linear, redraw = true) { this.linearFiltering = !!linear; this.filterTexture(this.whiteTexture); for (const texture of this.materialTextures.values()) this.filterTexture(texture); if (redraw) this.draw(); }
    applyAssemblyMaterials(assembly) {
      this.clearMaterialTextures();
      for (const unresolved of assembly.materials.unresolved_slots || []) this.setMaterialVisible(unresolved.material_slot, unresolved.default_visible, false);
      for (const binding of assembly.materials.bindings || []) {
        const texture = assembly.textures.find((candidate) => candidate.texture_id === binding.texture_id), variant = texture?.variants?.[binding.default_palette_bank || 0];
        if (variant) this.setMaterialTexture(binding.material_slot, variant, false);
      }
      this.draw();
    }
    reset() { this.rotX = this.defaultRotX; this.rotY = this.defaultRotY; this.zoom = 0.8; this.draw(); }
    bindEvents() {
      const c = this.canvas;
      const distance = () => { const p = [...this.pointers.values()]; return p.length < 2 ? null : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };
      const release = (e) => { this.pointers.delete(e.pointerId); this.pinch = null; const left = [...this.pointers.values()][0]; this.drag = left ? { x: left.x, y: left.y } : null; };
      c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (this.pointers.size === 1) this.drag = { x: e.clientX, y: e.clientY }; else { this.pinch = distance(); this.drag = null; } });
      c.addEventListener('pointermove', (e) => { if (!this.pointers.has(e.pointerId)) return; this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (this.pointers.size > 1) { const next = distance(); if (this.pinch && next) this.zoom = Math.max(.15, Math.min(3, this.zoom * next / this.pinch)); this.pinch = next; this.draw(); return; } if (!this.drag) return; this.rotY += (e.clientX - this.drag.x) * .01; this.rotX += (e.clientY - this.drag.y) * .01; this.drag = { x: e.clientX, y: e.clientY }; this.draw(); });
      c.addEventListener('pointerup', release); c.addEventListener('pointercancel', release);
      c.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom = Math.max(.15, Math.min(3, this.zoom * Math.exp(-e.deltaY * .001))); this.draw(); }, { passive: false });
    }
    draw() {
      if (!this.count) return; const gl = this.gl, dpr = Math.min(2, globalThis.devicePixelRatio || 1), width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr)), height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
      if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
      gl.viewport(0, 0, width, height); gl.clearColor(.03, .045, .07, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.useProgram(this.program);
      gl.uniform3fv(gl.getUniformLocation(this.program, 'uCenter'), this.center); gl.uniform1f(gl.getUniformLocation(this.program, 'uScale'), this.scale); gl.uniform1f(gl.getUniformLocation(this.program, 'uAspect'), width / height); gl.uniform1f(gl.getUniformLocation(this.program, 'uZoom'), this.zoom); gl.uniform2f(gl.getUniformLocation(this.program, 'uRot'), this.rotX, this.rotY); gl.activeTexture(gl.TEXTURE0); gl.uniform1i(gl.getUniformLocation(this.program, 'uTex'), 0);
      for (const batch of this.batches) {
        if (this.materialVisibility.get(batch.material_slot) === false) continue;
        const texture = this.materialTextures.get(batch.material_slot) || null;
        gl.uniform1f(gl.getUniformLocation(this.program, 'uUseTex'), texture ? 1 : 0); gl.bindTexture(gl.TEXTURE_2D, texture || this.whiteTexture); gl.drawArrays(gl.TRIANGLES, batch.first, batch.count);
      }
    }
  }

  function ensureRenderer() { if (!UI.renderer) UI.renderer = new ModelRenderer(q('v58ModelCanvas')); return UI.renderer; }

  function renderTextureCanvas(canvas, decoded) { canvas.width = decoded.width; canvas.height = decoded.height; const ctx = canvas.getContext('2d'); ctx.putImageData(new ImageData(decoded.rgba, decoded.width, decoded.height), 0, 0); }
  function bindingsForTexture(textureId) { return UI.assembly?.materials.bindings.filter((binding) => binding.texture_ids.includes(textureId)) || []; }
  function renderTextureSelection() {
    document.querySelectorAll('.v58-texture').forEach((item) => { const textureIndex = Number(item.dataset.texture), bank = Number(item.dataset.bank), texture = UI.assembly?.textures[textureIndex], bindings = texture ? bindingsForTexture(texture.texture_id) : []; item.classList.toggle('selected', !!(bindings.length && bindings.every((binding) => { const selected = UI.materialSelections.get(binding.material_slot); return selected && selected.textureIndex === textureIndex && selected.bank === bank; }))); });
  }
  function resetLinkedMaterials() {
    if (!UI.assembly) return;
    UI.materialSelections.clear();
    for (const binding of UI.assembly.materials.bindings) { const textureIndex = UI.assembly.textures.findIndex((texture) => texture.texture_id === binding.texture_id); if (textureIndex >= 0) UI.materialSelections.set(binding.material_slot, { textureIndex, bank: binding.default_palette_bank || 0 }); }
    ensureRenderer().applyAssemblyMaterials(UI.assembly); renderTextureSelection();
  }
  function selectTexture(index, bank) {
    const texture = UI.assembly.textures[index], bindings = bindingsForTexture(texture.texture_id);
    if (!bindings.length) return setStatus(`Texture ${texture.texture_id} has no evidence-linked material slot; it was not painted across the model.`);
    for (const binding of bindings) { UI.materialSelections.set(binding.material_slot, { textureIndex: index, bank }); ensureRenderer().setMaterialTexture(binding.material_slot, texture.variants[bank]); }
    renderTextureSelection(); const slots = bindings.map((binding) => binding.material_slot);
    setStatus(`Material slot${slots.length === 1 ? '' : 's'} ${slots.join(', ')} now use${slots.length === 1 ? 's' : ''} texture ${texture.texture_id}. Every slot explicitly bound to this texture was updated; no unrelated packet range changed.`);
  }
  function renderTextures() {
    const host = q('v58Textures'), a = UI.assembly;
    if (!a.textures.length) return (host.innerHTML = '<p class="help">No embedded FIS texture decoded.</p>');
    host.innerHTML = a.textures.flatMap((texture, ti) => texture.variants.map((variant, bank) => { const groups = texture.fisa_group_memberships.length ? ` • FISA group ${texture.fisa_group_memberships.map((x) => x.group_index).join(',')}` : ' • ungrouped', bindings = bindingsForTexture(texture.texture_id), linked = bindings.length ? ` • material slot${bindings.length === 1 ? '' : 's'} ${bindings.map((binding) => binding.material_slot).join(',')} ${html(bindings[0].confidence)}` : ' • not material-linked', clut = texture.info.palette_storage_layout === 'CSM1_IDTEX4_8X2_FROM_PSMCT32_UPLOAD' ? ' • one CSM1 CLUT' : ''; return `<button class="v58-texture" data-texture="${ti}" data-bank="${bank}"><canvas id="v58tex-${ti}-${bank}"></canvas><b>ID ${texture.texture_id}</b><small>${texture.width}×${texture.height} ${html(texture.psm)}${clut}${groups}${linked}</small></button>`; })).join('');
    a.textures.forEach((texture, ti) => texture.variants.forEach((variant, bank) => renderTextureCanvas(q(`v58tex-${ti}-${bank}`), variant)));
    resetLinkedMaterials();
  }

  function drawSkeleton() {
    const canvas = q('v58SkeletonCanvas'), s = UI.assembly.skeleton, dpr = Math.min(2, devicePixelRatio || 1), width = Math.max(300, canvas.clientWidth), height = Math.max(260, canvas.clientHeight); canvas.width = width * dpr; canvas.height = height * dpr;
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr); ctx.fillStyle = '#0b1019'; ctx.fillRect(0, 0, width, height);
    if (!s?.nodes.length) { ctx.fillStyle = '#aab4c4'; ctx.fillText('No RTA records loaded', 16, 24); return; }
    if (!s.spatial_preview_available) { ctx.fillStyle = '#f7cc6a'; ctx.font = 'bold 15px system-ui'; ctx.fillText('Spatial bind pose withheld', 16, 30); ctx.fillStyle = '#aab4c4'; ctx.font = '12px system-ui'; const lines = ['Node names and record links are decoded.', 'This sample does not validate parent-wise vector addition.', 'A runtime matrix-window capture or engine consumer trace is required.']; lines.forEach((line, i) => ctx.fillText(line, 16, 58 + i * 20)); return; }
    const points = s.nodes.filter((x) => x.diagnostic_chain_position).map((x) => ({ ...x, x: x.diagnostic_chain_position[0], y: -x.diagnostic_chain_position[1] })), minX = Math.min(...points.map((x) => x.x)), maxX = Math.max(...points.map((x) => x.x)), minY = Math.min(...points.map((x) => x.y)), maxY = Math.max(...points.map((x) => x.y)), scale = .82 * Math.min(width / Math.max(1, maxX - minX), height / Math.max(1, maxY - minY)), by = new Map(points.map((x) => [x.index, x]));
    const xy = (p) => [width / 2 + (p.x - (minX + maxX) / 2) * scale, height / 2 + (p.y - (minY + maxY) / 2) * scale]; ctx.strokeStyle = '#6ca8ff'; ctx.lineWidth = 2;
    for (const p of points) { const parent = by.get(p.parent); if (!parent) continue; const [x1, y1] = xy(parent), [x2, y2] = xy(p); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
    ctx.font = '10px system-ui'; for (const p of points) { const [x, y] = xy(p); ctx.fillStyle = '#f7cc6a'; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#e8eef8'; ctx.fillText(p.name, x + 5, y - 4); }
  }

  function table(headers, rows) { return `<table><thead><tr>${headers.map((x) => `<th>${html(x)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map((row) => `<tr>${row.map((x) => `<td>${x}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}">None</td></tr>`}</tbody></table>`; }

  function renderAssembly() {
    const a = UI.assembly; q('v58RenderGrade').textContent = a.grade; q('v58AssemblyMetrics').innerHTML = [['Vertices', a.counts.vertices], ['Triangles', a.counts.triangles], ['Textures / CLUTs', a.counts.texture_variants], ['Linked materials', a.counts.material_slots_linked], ['Material slots', a.counts.material_slots], ['RTA nodes', a.counts.rta_nodes], ['FAS clips', a.counts.animation_clips]].map(([label, value]) => `<div class="metric"><b>${html(fmt(value))}</b><span>${label}</span></div>`).join('');
    q('v58Gates').innerHTML = Object.entries(a.gates).map(([name, gate]) => `<div class="v58-gate"><span>${html(name.replaceAll('_', ' '))}</span><b class="${gate.passed ? 'v58-pass' : 'v58-blocked'}">${gate.passed ? 'PASS' : 'WITHHELD'} • ${html(gate.confidence)}</b></div>`).join(''); q('v58Warnings').innerHTML = `<b>Pass 6.2 gate split:</b> original FAS-to-node matrices may pass while matrix-to-packet skinning remains withheld.<br>` + (a.warnings.map((x) => `• ${html(x)}`).join('<br>') || 'No warnings.');
    ensureRenderer().setAssembly(a); renderTextures(); drawSkeleton();
    const hiddenAux = a.materials.unresolved_slots.filter((slot) => !slot.default_visible); q('v58LinearFiltering').checked = ensureRenderer().linearFiltering; q('v58ShowAuxiliary').checked = false; q('v58ShowAuxiliary').disabled = !hiddenAux.length; q('v58AuxiliarySummary').textContent = hiddenAux.length ? `${hiddenAux.length} strongly indicated no-UV auxiliary/shadow layer(s) hidden by default (${hiddenAux.reduce((sum, slot) => sum + slot.triangles, 0).toLocaleString()} triangles). Facial CLUT decode is verified; the static preview holds each family’s base frame.` : 'No auxiliary layer was withheld. Facial CLUT decode is verified; the static preview holds each family’s base frame.';
    q('v58SkeletonInfo').innerHTML = `<p class="notice">Record links are structurally bounded; anatomical parent semantics and spatial composition remain withheld.</p>` + table(['Index', 'Record link', 'Name', 'Raw vector'], (a.skeleton?.nodes || []).map((x) => [x.index, x.record_link, html(x.name), x.raw_vector.map((v) => Number(v).toFixed(2)).join(', ')]));
    q('v58MatrixInfo').innerHTML = `<p class="notice">Candidate only; never applied. Base ${a.matrices.base == null ? '—' : a.matrices.base}, stride ${a.matrices.stride || '—'}, exact cardinality ${a.matrices.exact_cardinality ? 'yes' : 'no'}.</p>` + table(['Address', 'Vertices', 'Ordinal candidate', 'RTA candidate'], a.matrices.candidates.map((x) => [x.address, fmt(x.vertex_count), x.ordinal_candidate ?? '—', x.rta_node_candidate ? `${x.rta_node_candidate.index}: ${html(x.rta_node_candidate.name)}` : '—']));
    q('v58Materials').innerHTML = `<p class="notice">${a.materials.binding_inference?.applied ? 'This actor uses a segment-scoped TEX0-PSM/FISA cardinality fallback labeled STRONG_INFERENCE. Stored TBP0, multi-group membership, incomplete FISA groups, or any coverage ambiguity reject every fallback assignment.' : 'FPS reference-table links remain authoritative; no fallback altered this actor.'} Runtime patch IDs, matrix-to-RTA, and the exact no-UV auxiliary role remain separate gates.</p>` + table(['Slot', 'Segment / packet', 'Texture family', 'Link'], a.materials.changes.map((change) => { const binding = a.materials.bindings.find((candidate) => candidate.material_slot === change.slot), unresolved = a.materials.unresolved_slots.find((candidate) => candidate.material_slot === change.slot); return [change.slot, `${change.segment} / ${change.source_packet}`, binding ? binding.texture_ids.join(' → ') : '—', binding ? `${html(binding.source)} • ${html(binding.confidence)}` : html(unresolved?.preview_role || 'UNRESOLVED')]; }));
    q('v58Animations').innerHTML = table(['Clip', 'Channels', 'RTA names matched', 'Evaluator'], a.animations.map((x) => [html(x.name), x.parsed.channels.length, x.binding ? `${x.binding.matched} / ${x.binding.total}` : '—', html(x.evaluation_confidence)]));
    q('v58ExportAssembly').disabled = false; q('v58ExportAtlas').disabled = false; setStatus(`Assembly complete: ${a.grade}. ${a.counts.material_slots_linked}/${a.counts.material_slots} material slots linked with corrected CSM1 facial CLUTs. Runtime FAS-to-node matrices are actor-scoped and verified where shown green; visible mesh skinning and the no-UV auxiliary role remain separate gates.`);
  }

  async function assembleFiles() {
    const geometry = q('v58GeometryFile').files[0], rta = q('v58RtaFile').files[0], animations = Array.from(q('v58FasFiles').files || []); if (!geometry) throw new Error('Choose a geometry file first');
    setStatus('Reading selected components…'); const actorId = q('v58ActorId').value.trim() || null;
    UI.assembly = A.assemble({ actorId, geometry: await fileBytes(geometry), rta: rta ? await fileBytes(rta) : null, animations: await Promise.all(animations.map(async (file) => ({ name: file.name, bytes: await fileBytes(file) }))), sourceNames: { geometry: geometry.name, rta: rta?.name || null, animations: animations.map((x) => x.name) } }); UI.actorId = actorId; renderActorIndex(); renderAssembly();
  }

  async function readNode(node) { const size = Number(node.decodedSize ?? node.storedSize); if (!node.provider || !Number.isFinite(size) || size <= 0) throw new Error(`${node.name} has no complete readable provider`); return node.provider.read(0, size); }
  async function assembleTree() {
    const workspace = globalThis.SO3V5Workspace, selected = workspace?.selectedNode, staged = actorNumber(q('v58ActorId').value), actorId = Number.isFinite(selected?.actor_id) ? selected.actor_id : staged;
    if (!workspace || !Number.isFinite(actorId)) throw new Error('Select an actor resource in V5 Workspace or enter an actor ID');
    const nodes = A.workspaceActorNodes(workspace, actorId), geometry = nodes.find((x) => x.tag === 'CHAR' || ['FPS', 'XBDC', 'RMAC'].includes(x.format)), rta = nodes.find((x) => ['ATRC', 'ATRM'].includes(x.tag) || x.format === 'RTA'), animations = nodes.filter((x) => ['ANIM', 'MAPA'].includes(x.tag) || x.format === 'FAS');
    if (!geometry) throw new Error(`Actor ${actorHex(actorId)} has no loaded geometry node. Expand its semantic-bundle branch first.`);
    setStatus(`Reading loaded nodes for actor ${actorHex(actorId)}…`); UI.assembly = A.assemble({ actorId: actorHex(actorId), geometry: await readNode(geometry), rta: rta ? await readNode(rta) : null, animations: await Promise.all(animations.map(async (node) => ({ name: node.name, bytes: await readNode(node) }))), sourceNames: { geometry: geometry.id, rta: rta?.id || null, animations: animations.map((x) => x.id) } }); UI.actorId = actorHex(actorId); q('v58ActorId').value = UI.actorId; renderActorIndex(); renderAssembly();
  }

  function download(name, data, type) { const host = q('v58Downloads'); if (globalThis.addDownload) return globalThis.addDownload(host, name, data, type); const link = document.createElement('a'); link.className = 'download'; link.download = name; link.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type })); link.textContent = `Download ${name}`; host.append(link); return link; }
  function zipBuilder(files) { if (globalThis.makeStoreZip) return globalThis.makeStoreZip(files); if (typeof makeStoreZip === 'function') return makeStoreZip(files); throw new Error('ZIP builder is unavailable'); }
  function exportAssembly() {
    const a = UI.assembly, manifest = A.assemblyManifest(a), files = [
      { name: 'SO3_MODEL_ASSEMBLY_V1.json', data: enc.encode(JSON.stringify(manifest, null, 2)) },
      { name: 'geometry/CHAR_DECODED.bin', data: a.model.bytes },
      { name: 'geometry/DIAGNOSTIC_UNPOSED.obj', data: enc.encode(A.diagnosticObj(a)) },
      { name: 'skeleton/RTA_NODE_RECORDS_SPATIAL_WITHHELD.json', data: enc.encode(JSON.stringify(a.skeleton, null, 2)) },
      { name: 'research/MATRIX_ADDRESS_CANDIDATES_NOT_APPLIED.json', data: enc.encode(JSON.stringify(a.matrices, null, 2)) },
      { name: 'research/MATERIAL_PATCHES_UNRESOLVED.json', data: enc.encode(JSON.stringify({ materials: a.materials, fisa: a.fisa.map((x) => x.parsed) }, null, 2)) },
    ];
    a.textures.forEach((texture) => texture.variants.forEach((variant) => files.push({ name: `textures/FIS_${String(texture.texture_id).padStart(4, '0')}_logical_clut.png`, data: A.rgbaToPng(variant.width, variant.height, variant.rgba) })));
    const id = String(a.actor_id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_'), zip = zipBuilder(files); download(`SO3_V5128_PASS62_MODEL_ASSEMBLY_${id}.zip`, zip, 'application/zip'); setStatus(`Assembly ZIP ready: ${files.length} members, including the decoded CHAR bytes needed for independent material and matrix analysis. Scroll below the download link if the host preview overlay is open.`);
  }
  function exportAtlas() {
    const a = UI.assembly, update = {
      format: 'SO3_ATLAS_UPDATE', version: 1, producer: 'SO3 Resource Explorer V5.12.8 Pass 6.2',
      records: [{
        actor_id: a.actor_id, assembly_grade: a.grade, render_mode: a.render_mode, counts: a.counts,
        evidence_gates: a.gates, material_reference_tables: a.materials.reference_tables, material_bindings: a.materials.bindings,
        ...(a.materials.binding_inference ? { material_binding_inference: a.materials.binding_inference } : {}),
        preview_texture_filter: 'LINEAR', preview_texture_coordinates: 'PS2_ST_DIRECT_NO_VERTICAL_INVERSION', preview_texture_wrap: 'CLAMP_TO_EDGE',
        verified_observations: [
          'Aligned section scan recovers FIS/FISA headers even when their words are legal VIF no-ops',
          'FPS material qword starts resolve exactly to source packets 0, 82, and 87 on actor 0x0BC0',
          'FPS records link material slot 1 to FISA family 1294–1296 and slot 2 to 2413–3362',
          'Each actor 0x0BC0 facial FIS stores one logical 16-color CSM1 CLUT',
          'When no FPS binding exists, the guarded preview fallback is segment-scoped and labeled STRONG_INFERENCE',
          'Original Lib execution verifies FAS type-0x0135 evaluation and between-key interpolation over 255 tracks',
          'Original Lib execution verifies concrete vtable +0x34 target 0x003EEF10, local/world writer 0x004DA820, and 378 real FAS-to-node matrix samples for actors 0x08FF and 0x0BC0',
          'A controlled two-node witness executes indirect parent vtable dispatch and VU0 entry 0x15D composition',
        ],
        superseded_claims: [
          'The 32 stored PSMCT32 entries represent two PSMT4 palette banks',
          'FISP is the missing actor 0x0BC0 facial palette selector',
          'The type-0x0135 quaternion w sign is unresolved',
          'Original between-key interpolation microcode is unavailable',
          'The concrete target-node setter and runtime node-matrix writer are unresolved',
        ],
        unresolved_fields: [
          'automatic FAS animation-clock integration in the static Model Lab preview',
          'original RTA translation-loader data path into the runtime node object',
          'U-GEO-01 matrix-address and matrix-to-packet binding',
          'RTA record-link/vector anatomical semantics',
          'no-UV auxiliary segment exact runtime role/external material',
          'final visible mesh skinning',
        ],
      }],
    };
    download('SO3_V5128_PASS62_MODEL_ASSEMBLY_ATLAS_UPDATE.json', JSON.stringify(update, null, 2), 'application/json');
  }

  function handle(fn) { return async (event) => { try { await fn(event); } catch (error) { setStatus(error.message, true); console.error(error); } }; }

  addUi(); installSelectionTrayCompaction(); renderActorIndex();
  q('v58ActorIndex').onclick = (event) => { const card = event.target.closest('[data-v58actor]'); if (!card) return; UI.actorId = card.dataset.v58actor; q('v58ActorId').value = UI.actorId; renderActorIndex(); setStatus(`Actor ${UI.actorId} selected. Press “Load and assemble selected actor from open ISO.”`); };
  q('v58Textures').onclick = (event) => { const item = event.target.closest('.v58-texture'); if (item && UI.assembly) selectTexture(Number(item.dataset.texture), Number(item.dataset.bank)); };
  q('v511LoadActorIso').onclick = handle(assembleIndexedActorFromIso); q('v58AssembleFiles').onclick = handle(assembleFiles); q('v58AssembleTree').onclick = handle(assembleTree); q('v58ResetView').onclick = () => UI.renderer?.reset(); q('v58ResetMaterials').onclick = resetLinkedMaterials; q('v58LinearFiltering').onchange = (event) => { ensureRenderer().setTextureFiltering(event.target.checked); setStatus(event.target.checked ? 'PS2-style filtered texture preview enabled.' : 'Raw nearest-neighbor texel preview enabled. The corrected CSM1 CLUT mapping remains active.'); }; q('v58ShowAuxiliary').onchange = (event) => { if (!UI.assembly) return; for (const slot of UI.assembly.materials.unresolved_slots.filter((item) => !item.default_visible)) ensureRenderer().setMaterialVisible(slot.material_slot, event.target.checked, false); ensureRenderer().draw(); q('v58AuxiliarySummary').textContent = event.target.checked ? 'Unresolved no-UV auxiliary layer shown in flat diagnostic color.' : 'Unresolved no-UV auxiliary layer hidden; linked body and face materials remain visible.'; }; q('v58ExportAssembly').onclick = handle(exportAssembly); q('v58ExportAtlas').onclick = handle(exportAtlas);
  globalThis.addEventListener?.('resize', () => { UI.renderer?.draw(); if (UI.assembly) drawSkeleton(); });
  function applyCurrentBrand() { document.title = 'SO3 Resource Explorer V5.12.8 Pass 6.2 — Original Node Matrices'; const title = document.querySelector('.appbar h1'), subtitle = document.querySelector('.appbar p'); if (title) title.textContent = 'SO3 Resource Explorer V5.12.8 Pass 6.2'; if (subtitle) subtitle.textContent = 'Original FAS evaluator, target-node setter, local/world writer, and parent composition verified • media PACK index scan corrected • offline and read-only.'; }
  globalThis.SO3ApplyCurrentBrand = applyCurrentBrand; applyCurrentBrand(); setTimeout(applyCurrentBrand, 0);
  globalThis.SO3V58ModelUI = Object.freeze({ VERSION: '5.12.8', state: UI, indexedActor, assembleIndexedActorFromIso, assembleFiles, assembleTree, renderAssembly, applyCurrentBrand, resetLinkedMaterials, selectTexture, bindingsForTexture });
})();
