/* SO3 Resource Explorer V5.12.8 hybrid sandbox/browser evidence bridge.
 * The browser is the read-only ISO authority. A sandbox emits a bounded JSON
 * request; this module returns exact byte members plus hashes in a store ZIP.
 */
(function () {
  'use strict';
  const VERSION = '5.12.8', FORMAT_REQUEST = 'SO3_HYBRID_DATA_REQUEST_V1', FORMAT_RESPONSE = 'SO3_HYBRID_DATA_RESPONSE_V1';
  const MAX_TOTAL = 96 * 1024 * 1024, MAX_MEMBER = 16 * 1024 * 1024, MAX_RANGES = 64, MAX_ACTORS = 8, MAX_VISIBLE_EXECUTABLES = 16, MAX_HIDDEN_BLOCKS = 256;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const asU8 = (value) => value instanceof Uint8Array ? value : new Uint8Array(value);
  const safe = (value) => String(value || 'item').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 128) || 'item';
  const hex = (value, width = 0) => `0x${Number(value).toString(16).toUpperCase().padStart(width, '0')}`;
  const u32 = (bytes, off) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(off, true);
  async function sha256(bytes) { const hash = await crypto.subtle.digest('SHA-256', asU8(bytes)); return Array.from(new Uint8Array(hash), (x) => x.toString(16).padStart(2, '0')).join(''); }

  function validateRequest(input) {
    if (!input || input.format !== FORMAT_REQUEST) throw new Error(`Expected ${FORMAT_REQUEST}`);
    const requestId = String(input.request_id || '').trim(); if (!/^[A-Za-z0-9._-]{1,96}$/.test(requestId)) throw new Error('request_id must use 1–96 safe characters');
    const ranges = Array.isArray(input.iso_ranges) ? input.iso_ranges : [], actors = Array.isArray(input.actors) ? input.actors : [], hiddenEntries = Array.isArray(input.hidden_entries) ? input.hidden_entries : [];
    if (ranges.length > MAX_RANGES) throw new Error(`At most ${MAX_RANGES} ISO ranges are allowed`); if (actors.length > MAX_ACTORS) throw new Error(`At most ${MAX_ACTORS} actors are allowed`);
    const normalizedRanges = ranges.map((row, index) => { const offset = Number(row.offset), size = Number(row.size); if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 1 || size > MAX_MEMBER) throw new Error(`Invalid ISO range ${index}`); return { id: safe(row.id || `range_${index}`), offset, size, purpose: String(row.purpose || 'sandbox missing-data request').slice(0, 256) }; });
    const normalizedActors = actors.map((value) => { const text = typeof value === 'object' ? value.actor_id : value, number = typeof text === 'number' ? text : Number.parseInt(String(text).replace(/^0x/i, ''), 16); if (!Number.isInteger(number) || number < 0 || number > 0xffff) throw new Error(`Invalid actor ${text}`); return hex(number, 4); });
    const normalizedHidden = hiddenEntries.map((value) => { const index = Number(typeof value === 'object' ? value.index : value); if (!Number.isInteger(index) || index < 0 || index > 65535) throw new Error(`Invalid hidden entry ${index}`); return index; });
    return { format: FORMAT_REQUEST, request_id: requestId, iso_ranges: normalizedRanges, actors: [...new Set(normalizedActors)], hidden_entries: [...new Set(normalizedHidden)], visible_executables: !!input.visible_executables, notes: String(input.notes || '').slice(0, 2000) };
  }

  async function decodedHiddenBlocks(row, bridge) {
    const raw = await bridge.mediaProviderFromIso(row.offset, row.size)(), out = []; let pos = row.header === 'ZLS' ? bridge.findMagicOffset(raw) : 0;
    if (pos < 0) throw new Error(`Hidden entry ${row.index} has no SLZ/SLE stream`);
    for (let block = 0; block < MAX_HIDDEN_BLOCKS && pos + 16 <= raw.length; block++) {
      const magic = bridge.td.decode(raw.slice(pos, pos + 3)); if (magic !== 'SLZ' && magic !== 'SLE') break;
      const total = 16 + bridge.u32(raw, pos + 4), next = bridge.u32(raw, pos + 12); if (pos + total > raw.length) throw new Error(`Hidden entry ${row.index} block ${block} is truncated`);
      const result = await bridge.decodeChunk(new Blob([raw.slice(pos, pos + total)]), magic === 'SLE' ? bridge.parseKey(bridge.finalSleKey) : null);
      out.push({ block, wrapper: `${magic}${raw[pos + 3]}`, source_offset: pos, bytes: asU8(result.out) });
      if (!next) break; if (next < 16 || pos + next <= pos || pos + next > raw.length) throw new Error(`Hidden entry ${row.index} has invalid next offset`); pos += next;
    }
    return out;
  }

  async function collect(requestInput, bridge = globalThis.SO3V44MediaBridge, assembler = globalThis.SO3V58Assembler) {
    const request = validateRequest(requestInput), iso = bridge?.state?.iso; if (!iso) throw new Error('Open the SO3 ISO first'); if (!assembler?.decodeIndexedIsoResource) throw new Error('V5.12 model decoder is unavailable');
    const files = [], records = [], errors = []; let total = 0;
    async function add(name, bytes, metadata) { bytes = asU8(bytes); if (bytes.length > MAX_MEMBER) throw new Error(`${name} exceeds the ${MAX_MEMBER}-byte member cap`); if (total + bytes.length > MAX_TOTAL) throw new Error(`Response exceeds the ${MAX_TOTAL}-byte total cap`); const path = name.split('/').map(safe).join('/'), hash = await sha256(bytes); files.push({ name: path, data: bytes }); records.push({ path, size: bytes.length, sha256: hash, ...metadata }); total += bytes.length; }
    for (const range of request.iso_ranges) { if (range.offset + range.size > iso.size) { errors.push({ kind: 'iso_range', id: range.id, error: 'range exceeds ISO size' }); continue; } const bytes = new Uint8Array(await iso.slice(range.offset, range.offset + range.size).arrayBuffer()); await add(`iso_ranges/${range.id}_off_${range.offset}_size_${range.size}.bin`, bytes, { kind: 'ISO_RANGE', offset: range.offset, size: range.size, purpose: range.purpose }); }
    for (const actorId of request.actors) {
      const actor = assembler.findIndexedActor(actorId); if (!actor) { errors.push({ kind: 'actor', actor_id: actorId, error: 'actor is absent from packaged index' }); continue; }
      for (const resource of actor.resources || []) try { const decoded = await assembler.decodeIndexedIsoResource(resource, bridge); await add(`actors/${actorId}/${resource.tag}_${resource.res_id || resource.offset}.${decoded.format === 'GEOMETRY' ? 'bin' : decoded.format.toLowerCase()}`, decoded.bytes, { kind: 'INDEXED_ACTOR_RESOURCE', actor_id: actorId, tag: resource.tag, res_id: resource.res_id, hidden_entry: resource.entry, child_offset: resource.offset, stored_size: resource.stored_size, wrapper: decoded.wrapper, decoded_format: decoded.format }); } catch (error) { errors.push({ kind: 'actor_resource', actor_id: actorId, tag: resource.tag, res_id: resource.res_id, error: error.message }); }
    }
    if (request.visible_executables) for (const row of (bridge.state.files || []).filter((row) => !row.isDir && row.size && (/^(?:SL[EUP][SM]?[_\-.]?\d[\d.]*)$/i.test(String(row.name || row.path || '').split('/').pop()) || /\.elf$/i.test(String(row.name || row.path || '')))).slice(0, MAX_VISIBLE_EXECUTABLES)) try { if (row.size > MAX_MEMBER) throw new Error('visible executable exceeds member cap'); const bytes = new Uint8Array(await iso.slice(row.offset, row.offset + row.size).arrayBuffer()); await add(`executables/${safe(row.name || row.path)}.bin`, bytes, { kind: 'VISIBLE_ISO_EXECUTABLE', iso_offset: row.offset, size: row.size, original_name: row.name || row.path }); } catch (error) { errors.push({ kind: 'visible_executable', name: row.name || row.path, error: error.message }); }
    for (const index of request.hidden_entries) {
      const row = (bridge.state.hidden || []).find((item) => Number(item.index) === index && item.sectors); if (!row) { errors.push({ kind: 'hidden_entry', index, error: 'entry unavailable' }); continue; }
      try { for (const item of await decodedHiddenBlocks(row, bridge)) { if (item.bytes.length > MAX_MEMBER) { errors.push({ kind: 'hidden_block', index, block: item.block, error: 'decoded block exceeds member cap' }); continue; } const load = item.bytes.length >= 12 && dec.decode(item.bytes.subarray(0, 4)) === 'MWo3' ? u32(item.bytes, 8) : null; await add(`hidden_entry_${index}/block_${item.block}${load == null ? '' : `_base_${hex(load, 8)}`}.bin`, item.bytes, { kind: 'DECODED_HIDDEN_BLOCK', hidden_entry: index, block: item.block, wrapper: item.wrapper, wrapper_offset: item.source_offset, load_address: load == null ? null : hex(load, 8) }); } } catch (error) { errors.push({ kind: 'hidden_entry', index, error: error.message }); }
    }
    const response = { format: FORMAT_RESPONSE, version: 1, producer: `SO3 Resource Explorer V${VERSION}`, request, iso: { name: iso.name || null, size: iso.size, last_modified: iso.lastModified || null }, caps: { max_total_bytes: MAX_TOTAL, max_member_bytes: MAX_MEMBER, max_ranges: MAX_RANGES, max_actors: MAX_ACTORS }, total_payload_bytes: total, members: records, errors, complete: errors.length === 0 };
    const responseBytes = enc.encode(JSON.stringify(response, null, 2)), sums = `${records.map((row) => `${row.sha256}  ${row.path}`).join('\n')}\n${await sha256(responseBytes)}  SO3_HYBRID_DATA_RESPONSE.json\n`;
    files.push({ name: 'SO3_HYBRID_DATA_RESPONSE.json', data: responseBytes }, { name: 'SHA256SUMS.txt', data: enc.encode(sums) });
    return { request, response, files };
  }

  globalThis.SO3V5128HybridBridge = Object.freeze({ VERSION, FORMAT_REQUEST, FORMAT_RESPONSE, LIMITS: Object.freeze({ MAX_TOTAL, MAX_MEMBER, MAX_RANGES, MAX_ACTORS }), validateRequest, collect, sha256 });
})();
