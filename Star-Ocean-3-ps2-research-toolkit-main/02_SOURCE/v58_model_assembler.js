/* SO3 Resource Explorer V5.8 evidence-gated model assembly core. */
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(
    node ? require('./v5_1_geometry.js') : root.SO3V51Geometry,
    node ? require('./v5_fis.js') : root.SO3V5Fis,
    node ? require('./v58_model_index.js') : root.SO3V58ModelIndex,
  );
  if (node) module.exports = api;
  else root.SO3V58Assembler = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Geometry, Fis, ModelIndex) {
  'use strict';
  if (!Geometry || !Fis) throw new Error('SO3 V5.1 geometry and FIS cores are required');

  const VERSION = '5.12.8';
  const FORMAT = 'SO3_MODEL_ASSEMBLY_V1';
  const CONFIDENCE = Object.freeze({ VERIFIED: 'VERIFIED', STRUCTURAL: 'STRUCTURAL', STRONG: 'STRONG_INFERENCE', UNRESOLVED: 'UNRESOLVED' });
  const TEX0_PSM_NAMES = Object.freeze({ 0x00: 'PSMCT32', 0x01: 'PSMCT24', 0x02: 'PSMCT16', 0x0a: 'PSMCT16S', 0x13: 'PSMT8', 0x14: 'PSMT4', 0x1b: 'PSMT8H', 0x24: 'PSMT4HL', 0x2c: 'PSMT4HH' });
  const asU8 = (x) => x instanceof Uint8Array ? x : new Uint8Array(x);
  const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const hex = (n, width) => `0x${Number(n).toString(16).toUpperCase().padStart(width || 0, '0')}`;

  function parseFisa(input) {
    const bytes = asU8(input), d = view(bytes);
    if (bytes.length < 0x18 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'FISA') throw new Error('Not FISA');
    const storedSize = d.getUint32(4, true), totalSize = storedSize + 0x10;
    if (totalSize > bytes.length) throw new Error(`Truncated FISA: need ${totalSize}, have ${bytes.length}`);
    const count = d.getUint16(0x10, true), recordVersion = d.getUint16(0x12, true), countMirror = d.getUint32(0x14, true);
    if (0x18 + count * 8 > totalSize) throw new Error('FISA pair table exceeds section');
    const pairs = [];
    for (let i = 0; i < count; i++) {
      const off = 0x18 + i * 8;
      pairs.push({ index: i, key: d.getUint32(off, true), value: d.getUint32(off + 4, true) });
    }
    return {
      magic: 'FISA', stored_size: storedSize, total_size: totalSize, unknown_08: d.getUint32(8, true),
      count, record_version: recordVersion, count_mirror: countMirror, pairs,
      layout_confidence: count === countMirror ? CONFIDENCE.STRUCTURAL : CONFIDENCE.UNRESOLVED,
      semantics_confidence: CONFIDENCE.UNRESOLVED,
    };
  }

  function decodeEmbeddedTextures(model) {
    const textures = [], companions = [];
    for (const section of model.textures || []) {
      const raw = model.bytes.subarray(section.off, section.off + section.size);
      if (section.magic === 'FISA') {
        companions.push({ section, parsed: parseFisa(raw) });
        continue;
      }
      if (section.magic !== 'FIS\0') continue;
      const info = Fis.parseFis(raw, { allowTrailing: false }), banks = Math.max(1, info.palette_bank_count || 0), variants = [];
      for (let paletteBank = 0; paletteBank < banks; paletteBank++) variants.push(Fis.decodeFis(info, { paletteBank }));
      textures.push({
        section, texture_id: info.texture_id, asset_label: info.asset_label, width: variants[0].width,
        height: variants[0].height, psm: info.actual_psm_name, palette_banks: banks, info, variants,
        membership_confidence: CONFIDENCE.VERIFIED, fisa_group_memberships: [],
      });
    }
    const textureByOffset = new Map(textures.map((texture) => [texture.section.off, texture]));
    for (let groupIndex = 0; groupIndex < companions.length; groupIndex++) {
      const companion = companions[groupIndex], parsed = companion.parsed, stride = parsed.unknown_08;
      const firstMemberOffset = companion.section.off - parsed.count * stride, groupBase = firstMemberOffset - 0x10;
      const members = parsed.pairs.map((pair) => {
        const expectedOffset = groupBase + pair.key, texture = textureByOffset.get(expectedOffset) || null;
        if (texture) texture.fisa_group_memberships.push({ group_index: groupIndex, member_index: pair.index, pair_value: pair.value, confidence: CONFIDENCE.VERIFIED });
        return { member_index: pair.index, key: pair.key, value: pair.value, expected_offset: expectedOffset, texture_id: texture ? texture.texture_id : null, resolved: !!texture };
      });
      const arithmetic = parsed.pairs.every((pair, i) => pair.key === 0x10 + i * stride);
      parsed.group_binding = {
        group_index: groupIndex, first_member_offset: firstMemberOffset, stride, members,
        resolved_members: members.filter((member) => member.resolved).length,
        exact_preceding_group: arithmetic && members.every((member) => member.resolved),
        link_confidence: arithmetic && members.every((member) => member.resolved) ? CONFIDENCE.VERIFIED : CONFIDENCE.UNRESOLVED,
        role: arithmetic && members.every((member) => member.resolved) ? 'PRECEDING_CONTIGUOUS_FIS_GROUP_INDEX' : 'UNRESOLVED',
        role_confidence: arithmetic && members.every((member) => member.resolved) ? CONFIDENCE.VERIFIED : CONFIDENCE.UNRESOLVED,
        pair_value_confidence: CONFIDENCE.UNRESOLVED,
        note: 'Pair keys resolve mechanically to the immediately preceding contiguous FIS sections. The exact runtime meaning of pair value remains unresolved.',
      };
      parsed.semantics_confidence = parsed.group_binding.role_confidence;
    }
    return { textures, companions };
  }

  function materialWrites(model, packet) {
    if (packet.materialOff == null) return null;
    const d = view(model.bytes), writes = [];
    for (let qword = 1; qword <= 4; qword++) {
      const off = packet.materialOff + qword * 16;
      if (off + 16 > model.bytes.length) break;
      const value = d.getBigUint64(off, true), register = d.getBigUint64(off + 8, true), registerId = Number(register & 0xffn);
      writes.push({
        qword, off, value_hex: `0x${value.toString(16).toUpperCase()}`, register_hex: `0x${register.toString(16).toUpperCase()}`,
        register_id: registerId, register_name: registerId === 0x06 ? 'TEX0_1' : registerId === 0x42 ? 'ALPHA_1' : null,
        runtime_patch_id_candidate: registerId === 0x06 && register > 0xffffffffn ? Number((register >> 32n) & 0xffffn) : null,
      });
    }
    return writes;
  }

  function materialSlots(model) {
    const changes = [], assignments = []; let active = null;
    for (const packet of model.packets || []) {
      if (packet.materialOff != null) {
        const writes = materialWrites(model, packet), patchIds = writes.filter((x) => x.runtime_patch_id_candidate != null).map((x) => x.runtime_patch_id_candidate);
        active = { slot: changes.length, segment: packet.segment, source_packet: packet.packet, material_off: packet.materialOff, writes, runtime_patch_ids_candidate: patchIds };
        changes.push(active);
      }
      assignments.push({ segment: packet.segment, packet: packet.packet, material_slot: active ? active.slot : null });
    }
    return {
      changes, packet_assignments: assignments,
      patch_id_confidence: CONFIDENCE.STRONG,
      texture_assignment_confidence: CONFIDENCE.UNRESOLVED,
      unresolved: 'Runtime TEX0 patch identifiers do not directly equal the embedded FIS texture IDs; no automatic material-to-texture assignment is made.',
    };
  }

  function materialSlotStatistics(model, materials) {
    const slotByPacket = new Map(materials.packet_assignments.map((row) => [row.packet, row.material_slot])), grouped = new Map();
    for (let index = 0; index < model.vertices.length; index++) {
      const vertex = model.vertices[index], slot = slotByPacket.get(vertex.packet);
      if (slot == null) continue;
      if (!grouped.has(slot)) grouped.set(slot, { slot, vertex_indices: [], triangle_count: 0 });
      grouped.get(slot).vertex_indices.push(index);
    }
    for (const packet of model.packets) {
      const slot = slotByPacket.get(packet.packet);
      if (slot != null && grouped.has(slot)) grouped.get(slot).triangle_count += packet.triangleCountRendered || 0;
    }
    return Array.from(grouped.values()).map((row) => {
      const vertices = row.vertex_indices.map((index) => model.vertices[index]), uvMin = [Infinity, Infinity], uvMax = [-Infinity, -Infinity];
      for (const vertex of vertices) for (let axis = 0; axis < 2; axis++) { uvMin[axis] = Math.min(uvMin[axis], vertex.uv[axis]); uvMax[axis] = Math.max(uvMax[axis], vertex.uv[axis]); }
      const hasUv = vertices.some((vertex) => Math.abs(vertex.uv[0]) > 1e-9 || Math.abs(vertex.uv[1]) > 1e-9);
      return {
        slot: row.slot, vertices: vertices.length, triangles: row.triangle_count, has_uv: hasUv,
        uv_min: vertices.length ? uvMin : [0, 0], uv_max: vertices.length ? uvMax : [0, 0],
        vertex_indices: row.vertex_indices,
      };
    }).sort((a, b) => a.slot - b.slot);
  }

  function parseMaterialReferenceTables(model, materials, decoded) {
    const d = view(model.bytes), tables = [], bindings = [], assignmentByPacket = new Map(materials.packet_assignments.map((row) => [row.packet, row.material_slot]));
    const textureBySegmentAndId = new Map(decoded.textures.map((texture) => [`${texture.section.segment}:${texture.texture_id}`, texture]));
    for (let segmentIndex = 0; segmentIndex < model.segments.length; segmentIndex++) {
      const segment = model.segments[segmentIndex];
      if (segment.off + 0x5c > model.bytes.length) continue;
      const declaredSlots = d.getUint32(segment.off + 0x50, true), tableRelative = d.getUint32(segment.off + 0x58, true), tableOff = segment.off + tableRelative;
      if (!declaredSlots || declaredSlots > 64 || !tableRelative || tableOff + 8 > segment.end || tableOff + 8 > model.bytes.length) continue;
      const slotCount = d.getUint32(tableOff, true), startsEnd = tableOff + 4 + slotCount * 4;
      if (slotCount !== declaredSlots || startsEnd + 4 > segment.end || startsEnd + 4 > model.bytes.length) continue;
      const packetStartQwords = [];
      for (let index = 0; index < slotCount; index++) packetStartQwords.push(d.getUint32(tableOff + 4 + index * 4, true));
      const dynamicCount = d.getUint32(startsEnd, true), recordsOff = startsEnd + 4;
      if (dynamicCount > slotCount || recordsOff + dynamicCount * 16 > segment.end || recordsOff + dynamicCount * 16 > model.bytes.length) continue;
      const slotMap = packetStartQwords.map((qword, ordinal) => {
        const expected = qword * 16, packet = model.packets.find((candidate) => candidate.segment === segmentIndex && candidate.off + 0x10 === expected) || null;
        return { ordinal, packet_start_qword: qword, expected_file_offset: expected, packet: packet ? packet.packet : null, material_slot: packet ? assignmentByPacket.get(packet.packet) : null, exact_packet_match: !!packet };
      });
      const dynamicRecords = [];
      for (let index = 0; index < dynamicCount; index++) {
        const off = recordsOff + index * 16, label = String.fromCharCode(...model.bytes.subarray(off, off + 4)).replaceAll('\0', ''), textureId = d.getUint32(off + 4, true), slotOrdinal = d.getUint32(off + 8, true), frameLastIndex = d.getUint32(off + 12, true), slot = slotMap[slotOrdinal] || null, texture = textureBySegmentAndId.get(`${segmentIndex}:${textureId}`) || null;
        const membership = texture?.fisa_group_memberships?.[0] || null, group = membership ? decoded.companions[membership.group_index]?.parsed?.group_binding : null;
        const textureIds = group ? group.members.map((member) => member.texture_id).filter((value) => value != null) : texture ? [texture.texture_id] : [];
        const record = {
          index, off, asset_label: label, base_texture_id: textureId, material_slot_ordinal: slotOrdinal,
          frame_last_index: frameLastIndex, material_slot: slot?.material_slot ?? null, source_packet: slot?.packet ?? null,
          texture_resolved: !!texture, fisa_group_index: membership?.group_index ?? null, texture_ids: textureIds,
          fisa_cardinality_matches: !!(group && frameLastIndex + 1 === textureIds.length),
        };
        dynamicRecords.push(record);
        if (slot?.material_slot != null && texture) bindings.push({
          material_slot: slot.material_slot, segment: segmentIndex, source_packet: slot.packet, texture_id: textureId,
          texture_ids: textureIds, asset_label: label, fisa_group_index: record.fisa_group_index, animated_family: textureIds.length > 1,
          source: 'FPS_MATERIAL_REFERENCE_TABLE', confidence: slot.exact_packet_match && (!group || record.fisa_cardinality_matches) ? CONFIDENCE.STRUCTURAL : CONFIDENCE.STRONG,
          default_palette_bank: 0, default_texture_id: textureId, default_selector_status: 'BASE_FRAME_STATIC_PREVIEW',
          clut_variant_status: texture.info.palette_storage_layout === 'CSM1_IDTEX4_8X2_FROM_PSMCT32_UPLOAD' ? 'ONE_LOGICAL_CSM1_CLUT' : 'FORMAT_DEFAULT',
        });
      }
      const explicitlyBoundOrdinals = new Set(dynamicRecords.filter((record) => record.texture_resolved).map((record) => record.material_slot_ordinal));
      const remainingSlots = slotMap.filter((slot) => slot.material_slot != null && !explicitlyBoundOrdinals.has(slot.ordinal));
      const staticTextures = decoded.textures.filter((texture) => texture.section.segment === segmentIndex && !texture.fisa_group_memberships.length && !dynamicRecords.some((record) => record.base_texture_id === texture.texture_id));
      if (remainingSlots.length === 1 && staticTextures.length === 1) bindings.push({
        material_slot: remainingSlots[0].material_slot, segment: segmentIndex, source_packet: remainingSlots[0].packet,
        texture_id: staticTextures[0].texture_id, texture_ids: [staticTextures[0].texture_id], asset_label: staticTextures[0].asset_label,
        fisa_group_index: null, animated_family: false, source: 'EXCLUSIVE_REMAINING_STATIC_FIS', confidence: CONFIDENCE.STRONG,
        default_palette_bank: 0,
      });
      tables.push({
        segment: segmentIndex, off: tableOff, declared_material_slots: declaredSlots, material_slots: slotMap,
        dynamic_count: dynamicCount, dynamic_records: dynamicRecords,
        exact_packet_start_matches: slotMap.every((slot) => slot.exact_packet_match),
        confidence: slotMap.every((slot) => slot.exact_packet_match) ? CONFIDENCE.STRUCTURAL : CONFIDENCE.UNRESOLVED,
      });
    }
    return { tables, bindings };
  }

  function materialTex0Psm(change) {
    const write = (change?.writes || []).find((candidate) => candidate.register_id === 0x06 && candidate.qword === 2)
      || (change?.writes || []).find((candidate) => candidate.register_id === 0x06);
    if (!write?.value_hex) return null;
    let value;
    try { value = BigInt(write.value_hex); } catch (_) { return null; }
    const code = Number((value >> 20n) & 0x3fn);
    return { code, name: TEX0_PSM_NAMES[code] || hex(code, 2), stored_tbp0: Number(value & 0x3fffn) };
  }

  function materialAlphaValue(change) {
    const write = (change?.writes || []).find((candidate) => candidate.register_id === 0x42);
    if (!write?.value_hex) return null;
    try { return BigInt(write.value_hex); } catch (_) { return null; }
  }

  function completeFormatOrdinalFallback(materials, decoded, stats) {
    const uvStats = stats.filter((row) => row.has_uv).sort((a, b) => a.slot - b.slot);
    const changeBySlot = new Map(materials.changes.map((change) => [change.slot, change]));
    const slotRows = uvStats.map((stat) => ({ stat, change: changeBySlot.get(stat.slot) || null, psm: materialTex0Psm(changeBySlot.get(stat.slot)) }));
    const fail = (reason, detail) => ({ applied: false, source: 'PSM_CARDINALITY_FALLBACK', scope: 'EVIDENCE_LINKED_PREVIEW', confidence: CONFIDENCE.UNRESOLVED, reason, ...(detail ? { detail } : {}), bindings: [], guard: 'NO_FPS_BINDINGS_AND_COMPLETE_UNAMBIGUOUS_TEX0_PSM_COVERAGE', partial_assignments_allowed: false });
    if (!slotRows.length) return fail('NO_UV_BEARING_MATERIAL_SLOTS');
    for (const row of slotRows) {
      if (!row.change || !row.psm || !['PSMT8', 'PSMT4'].includes(row.psm.name)) return fail('UV_SLOT_HAS_UNKNOWN_TEX0_PSM', { material_slot: row.stat.slot });
      if (row.psm.stored_tbp0) return fail('STORED_TBP0_PRESENT_UNMODELED', { material_slot: row.stat.slot, tbp0: row.psm.stored_tbp0 });
    }

    const bindings = [], decisions = [], segments = [...new Set(slotRows.map((row) => row.change.segment))].sort((a, b) => a - b);
    for (const segment of segments) {
      const segmentRows = slotRows.filter((row) => row.change.segment === segment), textures = decoded.textures.filter((texture) => texture.section?.segment === segment);
      const multiMembership = textures.find((texture) => (texture.fisa_group_memberships || []).length > 1);
      if (multiMembership) return fail('TEXTURE_IN_MULTIPLE_FISA_GROUPS', { segment, texture_id: multiMembership.texture_id });
      const textureById = new Map(textures.map((texture) => [texture.texture_id, texture])), groups = [];
      for (const companion of decoded.companions.filter((candidate) => candidate.section?.segment === segment)) {
        const group = companion.parsed?.group_binding;
        if (!group?.exact_preceding_group || group.link_confidence !== CONFIDENCE.VERIFIED) return fail('NON_EXACT_FISA_GROUP_IN_SLOT_SEGMENT', { segment, group_index: group?.group_index ?? null });
        const ids = group.members.map((member) => member.texture_id), members = ids.map((id) => textureById.get(id) || null);
        if (members.some((texture) => !texture)) return fail('FISA_MEMBER_TEXTURE_UNRESOLVED', { segment, group_index: group.group_index });
        if (new Set(members.map((texture) => texture.psm)).size !== 1) return fail('FISA_GROUP_MIXED_PSM', { segment, group_index: group.group_index });
        groups.push({ group_index: group.group_index, ids, members, psm: members[0].psm });
      }
      const staticTextures = textures.filter((texture) => !(texture.fisa_group_memberships || []).length);
      for (const psm of [...new Set(segmentRows.map((row) => row.psm.name))]) {
        const slots = segmentRows.filter((row) => row.psm.name === psm).sort((a, b) => a.stat.slot - b.stat.slot), statics = staticTextures.filter((texture) => texture.psm === psm), compatibleGroups = groups.filter((group) => group.psm === psm).sort((a, b) => a.group_index - b.group_index);
        if (!compatibleGroups.length && statics.length === 1) {
          const texture = statics[0];
          for (const row of slots) bindings.push({
            material_slot: row.stat.slot, segment, source_packet: row.change.source_packet,
            texture_id: texture.texture_id, texture_ids: [texture.texture_id], asset_label: texture.asset_label,
            fisa_group_index: null, animated_family: false, source: 'EXCLUSIVE_TEX0_PSM_STATIC_FIS', confidence: CONFIDENCE.STRONG,
            material_tex0_psm: psm, default_palette_bank: 0, default_texture_id: texture.texture_id,
            default_selector_status: 'BASE_FRAME_STATIC_PREVIEW', clut_variant_status: 'FORMAT_DEFAULT',
          });
          decisions.push({ segment, psm, kind: 'SHARED_EXCLUSIVE_STATIC_FIS', material_slots: slots.map((row) => row.stat.slot), texture_ids: [texture.texture_id] });
          continue;
        }
        if (!statics.length && compatibleGroups.length === slots.length) {
          for (let index = 0; index < slots.length; index++) {
            const row = slots[index], group = compatibleGroups[index], texture = group.members[0];
            bindings.push({
              material_slot: row.stat.slot, segment, source_packet: row.change.source_packet,
              texture_id: texture.texture_id, texture_ids: group.ids, asset_label: texture.asset_label,
              fisa_group_index: group.group_index, animated_family: group.ids.length > 1,
              source: 'EXACT_TEX0_PSM_FISA_GROUP_ORDINAL', confidence: CONFIDENCE.STRONG,
              material_tex0_psm: psm, default_palette_bank: 0, default_texture_id: texture.texture_id,
              default_selector_status: 'BASE_FRAME_STATIC_PREVIEW',
              clut_variant_status: texture.info?.palette_storage_layout === 'CSM1_IDTEX4_8X2_FROM_PSMCT32_UPLOAD' ? 'ONE_LOGICAL_CSM1_CLUT' : 'FORMAT_DEFAULT',
            });
          }
          decisions.push({ segment, psm, kind: 'EXACT_SLOT_TO_FISA_GROUP_ORDINAL', material_slots: slots.map((row) => row.stat.slot), fisa_groups: compatibleGroups.map((group) => group.group_index), texture_ids: compatibleGroups.map((group) => group.ids) });
          continue;
        }
        if (!compatibleGroups.length && !statics.length) return fail('NO_PSM_MATCHING_TEXTURES', { segment, psm, material_slots: slots.map((row) => row.stat.slot) });
        return fail('AMBIGUOUS_PSM_CLASS', { segment, psm, material_slots: slots.map((row) => row.stat.slot), static_texture_ids: statics.map((texture) => texture.texture_id), fisa_group_count: compatibleGroups.length });
      }
    }
    const covered = new Set(bindings.map((binding) => binding.material_slot));
    if (bindings.length !== uvStats.length || covered.size !== uvStats.length || uvStats.some((stat) => !covered.has(stat.slot))) return fail('FALLBACK_DID_NOT_COVER_EVERY_UV_SLOT');
    return {
      applied: true, source: 'PSM_CARDINALITY_FALLBACK', scope: 'EVIDENCE_LINKED_PREVIEW', confidence: CONFIDENCE.STRONG, reason: null, bindings, decisions,
      guard: 'NO_FPS_BINDINGS_AND_COMPLETE_UNAMBIGUOUS_TEX0_PSM_COVERAGE', partial_assignments_allowed: false,
      note: 'TEX0 PSM plus exclusive/ordered cardinality inference for the evidence-linked preview only; ordered slot-to-family pairing assumes authoring-order isomorphism and is not runtime verification.',
    };
  }

  function resolveMaterialReferences(model, materials, decoded) {
    const parsed = parseMaterialReferenceTables(model, materials, decoded), stats = materialSlotStatistics(model, materials), inference = parsed.bindings.length ? null : completeFormatOrdinalFallback(materials, decoded, stats), bindings = parsed.bindings.length ? parsed.bindings : inference.bindings, boundSlots = new Set(bindings.map((binding) => binding.material_slot));
    const boundPositionKeys = new Set();
    for (const stat of stats.filter((row) => boundSlots.has(row.slot))) for (const index of stat.vertex_indices) boundPositionKeys.add(model.vertices[index].position.join(','));
    const unresolvedSlots = stats.filter((stat) => !boundSlots.has(stat.slot)).map((stat) => {
      const overlapVertices = stat.vertex_indices.filter((index) => boundPositionKeys.has(model.vertices[index].position.join(','))).length, overlapRatio = stat.vertices ? overlapVertices / stat.vertices : 0;
      const change = materials.changes.find((candidate) => candidate.slot === stat.slot), tex0Psm = materialTex0Psm(change), alpha = materialAlphaValue(change), noUvShadowSignature = !!bindings.length && !stat.has_uv && tex0Psm?.code === 0 && Number(change?.segment) > 0 && alpha === 0x44n;
      const auxiliaryCandidate = !stat.has_uv && (overlapRatio >= 0.5 || noUvShadowSignature), previewRole = overlapRatio >= 0.5 ? 'OVERLAPPING_NO_UV_AUXILIARY_CANDIDATE' : noUvShadowSignature ? 'SEGMENT_NO_UV_PSM0_ALPHA44_AUXILIARY_CANDIDATE' : 'UNRESOLVED_MATERIAL';
      return {
        material_slot: stat.slot, has_uv: stat.has_uv, vertices: stat.vertices, triangles: stat.triangles,
        exact_position_overlap_vertices: overlapVertices, exact_position_overlap_ratio: overlapRatio,
        default_visible: !auxiliaryCandidate,
        preview_role: previewRole, material_tex0_psm: tex0Psm?.name || null,
        confidence: auxiliaryCandidate ? CONFIDENCE.STRONG : CONFIDENCE.UNRESOLVED,
      };
    });
    const publicStats = stats.map(({ vertex_indices, ...row }) => row), uvSlots = new Set(stats.filter((row) => row.has_uv).map((row) => row.slot)), resolvedUvSlots = new Set(bindings.filter((binding) => uvSlots.has(binding.material_slot)).map((binding) => binding.material_slot));
    Object.assign(materials, {
      reference_tables: parsed.tables, bindings, ...(inference ? { binding_inference: inference } : {}), slot_statistics: publicStats, unresolved_slots: unresolvedSlots,
      resolved_textured_slots: resolvedUvSlots.size, required_textured_slots: uvSlots.size,
      preview_assignments_allowed: bindings.length > 0,
      texture_assignment_confidence: parsed.bindings.length ? CONFIDENCE.STRUCTURAL : inference?.applied ? CONFIDENCE.STRONG : CONFIDENCE.UNRESOLVED,
      unresolved: unresolvedSlots.length ? 'UV-bearing material slots are linked for evidence-scoped preview; unresolved auxiliary or external materials remain gated.' : null,
    });
    return materials;
  }

  function matrixBinding(model, rta) {
    const stats = Geometry.matrixAddressStats(model), addresses = stats.map((x) => x.address), base = addresses.length ? Math.min(...addresses) : null;
    const stride = addresses.length > 1 && addresses.every((x, i) => !i || x - addresses[i - 1] === 4) ? 4 : null;
    const aligned = base != null && addresses.every((x) => x >= base && (x - base) % 4 === 0), candidates = [];
    for (const row of stats) {
      const ordinal = aligned ? (row.address - base) / 4 : null, node = rta && ordinal != null ? rta.nodes[ordinal] || null : null;
      candidates.push({
        address: row.address, vertex_count: row.count, ordinal_candidate: ordinal,
        rta_node_candidate: node ? { index: node.index, name: node.name } : null,
        mapping_status: 'CANDIDATE_NOT_APPLIED', confidence: CONFIDENCE.STRONG,
      });
    }
    const exactCardinality = !!(rta && addresses.length && addresses.length === rta.nodeCount);
    return {
      base, stride, distinct_addresses: addresses.length, vertex_coverage: stats.reduce((n, x) => n + x.count, 0),
      rta_nodes: rta ? rta.nodeCount : null, exact_cardinality: exactCardinality, aligned, candidates,
      final_mapping_verified: false, applied_to_geometry: false, confidence: addresses.length ? CONFIDENCE.STRONG : CONFIDENCE.UNRESOLVED,
      evidence: exactCardinality ? 'Address cardinality and 4-qword stride equal the RTA node count.' : 'Matrix-address encoding is observed; node correspondence is not proven.',
      unresolved_id: 'U-GEO-01',
    };
  }

  function worldSkeleton(rta) {
    if (!rta) return null;
    const byIndex = new Map(rta.nodes.map((node) => [node.index, node])), errors = [];
    for (const node of rta.nodes) if (node.parent !== -1 && !byIndex.has(node.parent)) errors.push(`node ${node.index} has unavailable record link ${node.parent}`);
    const nodes = rta.nodes.map((node) => ({
      index: node.index, record_link: node.parent, parent: node.parent, name: node.name,
      raw_vector: node.translation.slice(0, 3), diagnostic_chain_position: null,
    }));
    return {
      nodes, roots: nodes.filter((x) => x.parent === -1).map((x) => x.index), hierarchy_valid: !errors.length, errors,
      record_links_confidence: CONFIDENCE.STRUCTURAL, spatial_preview_available: false,
      position_confidence: CONFIDENCE.UNRESOLVED,
      note: 'Record indices and link fields are preserved, but this actor does not support an anatomical parent-plus-local-translation reading. Spatial skeleton composition is withheld pending the engine consumer or a matrix-window capture.',
    };
  }

  function animationBindings(animationInputs, rta) {
    const clips = [];
    for (let i = 0; i < (animationInputs || []).length; i++) {
      const input = animationInputs[i], parsed = input && input.channels ? input : Geometry.parseFas(input.bytes || input), binding = rta ? Geometry.bindFasToRta(parsed, rta) : null;
      clips.push({
        index: i, name: input && input.name ? input.name : `animation_${i}`, parsed,
        binding: binding ? { matched: binding.matched, total: binding.total, channels: binding.channels.map((x) => ({ name: x.channel.name, rta_node: x.node ? x.node.index : null, status: x.binding })) } : null,
        channel_structure_confidence: CONFIDENCE.VERIFIED, evaluation_confidence: 'VERIFIED_ORIGINAL_R5900_VU0_MACRO_AND_MICROCODE_EXECUTION',
      });
    }
    return clips;
  }

  function geometryGrade(model, rta, decoded) {
    const hasGeometry = !!(model && model.vertices.length && model.triangles.length), fixed = !!model.fixedProfile;
    if (!hasGeometry) return 'PARTIAL_NO_RENDERABLE_GEOMETRY';
    if (fixed) return rta && decoded.textures.length ? 'COMPONENT_COMPLETE_DIAGNOSTIC' : 'PARTIAL_SKINNED_DIAGNOSTIC';
    return 'FULLY_RENDERABLE_RIGID';
  }

  function assemble(options) {
    const opts = options || {}, model = opts.geometry && opts.geometry.vertices ? opts.geometry : Geometry.parseGeometry(opts.geometry),
      rta = !opts.rta ? null : opts.rta.nodes ? opts.rta : Geometry.parseRta(opts.rta), decoded = decodeEmbeddedTextures(model),
      materials = resolveMaterialReferences(model, materialSlots(model), decoded), matrices = matrixBinding(model, rta), skeleton = worldSkeleton(rta), animations = animationBindings(opts.animations, rta),
      grade = geometryGrade(model, rta, decoded), fixed = model.fixedProfile;
    const materialPreviewComplete = materials.required_textured_slots > 0 && materials.resolved_textured_slots === materials.required_textured_slots;
    const rotationTrackCount = animations.reduce((total, clip) => total + clip.parsed.channels.reduce((channelTotal, channel) => channelTotal + channel.subs.filter((sub) => sub.type === 0x135 && sub.quantized?.length).length, 0), 0);
    const hasRotationTracks = rotationTrackCount > 0;
    const actorText = String(opts.actorId || '').trim(), actorNumber = /^0x/i.test(actorText) ? Number.parseInt(actorText.slice(2), 16) : Number.parseInt(actorText, 10);
    const nodeMatrixExecutionScoped = hasRotationTracks && !!rta && [0x08FF, 0x0BC0].includes(actorNumber);
    const gates = {
      geometry_structure: { passed: model.vertices.length > 0 && model.triangles.length > 0, confidence: CONFIDENCE.VERIFIED },
      embedded_texture_decode: { passed: decoded.textures.every((x) => x.variants.length > 0), count: decoded.textures.length, confidence: CONFIDENCE.VERIFIED },
      rta_record_links: { passed: !!(rta && skeleton.hierarchy_valid), confidence: rta ? CONFIDENCE.STRUCTURAL : CONFIDENCE.UNRESOLVED },
      fas_name_binding: { passed: animations.some((x) => x.binding && x.binding.matched), matched: animations.reduce((n, x) => n + (x.binding?.matched || 0), 0), confidence: animations.length ? CONFIDENCE.VERIFIED : CONFIDENCE.UNRESOLVED },
      matrix_to_rta: { passed: false, confidence: CONFIDENCE.UNRESOLVED, unresolved_id: 'U-GEO-01' },
      material_to_fis: { passed: materialPreviewComplete, confidence: materialPreviewComplete ? materials.texture_assignment_confidence : CONFIDENCE.UNRESOLVED, scope: 'EVIDENCE_LINKED_PREVIEW', resolved_slots: materials.resolved_textured_slots, required_slots: materials.required_textured_slots, ...(materials.binding_inference?.applied ? { binding_source: 'PSM_CARDINALITY_STRONG_INFERENCE' } : {}) },
      facial_frame_palette_selector: {
        passed: true,
        confidence: CONFIDENCE.VERIFIED,
        frame_selector: 'VERIFIED_R5900_EXECUTION',
        palette_variant_selector: 'NOT_APPLICABLE_ONE_LOGICAL_CSM1_CLUT_PER_FIS',
        preview_default: 'BASE_FAMILY_MEMBER_STATIC_NO_ANIMATION_CLOCK',
        note: 'The FISA member selector is instruction-executed. Each observed facial FIS stores one logical 16-color CSM1 CLUT in a padded 16x2 PSMCT32 upload; CSA is a temporary-buffer destination, not a second embedded palette variant.',
      },
      auxiliary_mesh_role: { passed: !materials.unresolved_slots.length, confidence: materials.unresolved_slots.length ? CONFIDENCE.UNRESOLVED : CONFIDENCE.VERIFIED },
      animation_rotation_evaluator: {
        passed: hasRotationTracks,
        confidence: hasRotationTracks ? CONFIDENCE.VERIFIED : CONFIDENCE.UNRESOLVED,
        rotation_tracks: rotationTrackCount,
        key_selection: 'VERIFIED_R5900_EXECUTION',
        quaternion_decompression: 'VERIFIED_R5900_VU0_MACRO_EXECUTION',
        interpolation: 'VERIFIED_ORIGINAL_R5900_VU0_MACRO_AND_MICROCODE_EXECUTION',
      },
      animation_node_matrix_execution: {
        passed: nodeMatrixExecutionScoped,
        confidence: nodeMatrixExecutionScoped ? CONFIDENCE.VERIFIED : CONFIDENCE.UNRESOLVED,
        evaluator_input: hasRotationTracks ? 'AVAILABLE_VERIFIED' : 'NO_TYPE_0x0135_TRACKS',
        target_node_setter: nodeMatrixExecutionScoped ? 'VERIFIED_ORIGINAL_R5900_CONCRETE_VTABLE_TARGET' : 'WITHHELD_OUTSIDE_EXECUTED_ACTOR_SCOPE',
        node_matrix_write: nodeMatrixExecutionScoped ? 'VERIFIED_ORIGINAL_R5900_VU0_LOCAL_AND_WORLD_WRITER' : 'WITHHELD_OUTSIDE_EXECUTED_ACTOR_SCOPE',
        hierarchy_composition: 'VERIFIED_ORIGINAL_INDIRECT_VTABLE_CALL_AND_VU0_ENTRY_0x15D_CONTROLLED_TWO_NODE_INPUT',
        translation_source: nodeMatrixExecutionScoped ? 'CONTROLLED_EXACT_NAME_RTA_INPUT_ORIGINAL_LOADER_WITHHELD' : 'WITHHELD',
      },
      animation_mesh_skinning_playback: {
        passed: false,
        confidence: CONFIDENCE.UNRESOLVED,
        node_matrices: nodeMatrixExecutionScoped ? 'AVAILABLE_EXECUTION_VERIFIED' : 'WITHHELD_OUTSIDE_EXECUTED_ACTOR_SCOPE',
        matrix_to_packet_binding: 'WITHHELD_U_GEO_01',
        browser_preview: 'STATIC_UNPOSED_NOT_APPLIED',
      },
    };
    return {
      format: FORMAT, version: 1, tool_version: VERSION, actor_id: opts.actorId || null, source_names: opts.sourceNames || {}, grade,
      render_mode: fixed ? (materialPreviewComplete ? 'EVIDENCE_LINKED_MATERIALS_UNPOSED' : 'RAW_PACKET_LOCAL_UNPOSED') : 'VALIDATED_RIGID', final_skinned_model: false,
      model, rta, textures: decoded.textures, fisa: decoded.companions, materials, matrices, skeleton, animations, gates,
      counts: {
        segments: model.segments.length, packets: model.packets.length, vertices: model.vertices.length, triangles: model.triangles.length,
        texture_files: decoded.textures.length, texture_variants: decoded.textures.reduce((n, x) => n + x.variants.length, 0),
        fisa_groups: decoded.companions.length, fisa_grouped_textures: decoded.textures.filter((x) => x.fisa_group_memberships.length).length,
        material_slots: materials.changes.length, material_slots_linked: materials.bindings.length,
        rta_nodes: rta ? rta.nodeCount : 0, animation_clips: animations.length,
      },
      warnings: [
        ...(fixed ? ['FIXED/XBDC vertices remain packet-local and unposed; candidate matrix ordinals are not applied.'] : []),
        ...(rta ? ['RTA node names and record links are listed, but a spatial bind-pose skeleton is withheld because the record vectors/links do not form a credible anatomical chain on this actor.'] : []),
        ...(materialPreviewComplete ? [`${materials.resolved_textured_slots}/${materials.required_textured_slots} UV-bearing material slots are linked for evidence-scoped preview.`] : materials.changes.length ? ['Material-to-FIS assignment remains incomplete.'] : []),
        ...(materials.binding_inference?.applied ? ['This actor uses a complete TEX0-PSM/cardinality STRONG_INFERENCE preview link because no FPS material-reference binding exists; ordered slot-to-family pairing assumes authoring-order isomorphism and is not runtime verification.'] : []),
        ...(materials.bindings.some((binding) => binding.animated_family) ? ['Facial FISA member selection is verified; this static preview holds the base member because animation-clock playback is not implemented. Each facial FIS has one logical CSM1 CLUT.'] : []),
        ...(materials.unresolved_slots.some((slot) => !slot.default_visible) ? ['A strongly indicated no-UV auxiliary/shadow layer is hidden by default because its exact runtime role and external material remain unresolved.'] : []),
        ...(nodeMatrixExecutionScoped ? ['FAS rotation output is instruction-executed through the original concrete target-node setter and local/world matrix writer for this actor scope. RTA translations are controlled exact-name inputs; matrix-to-packet binding and visible mesh skinning remain withheld.'] : animations.length ? ['FAS rotation evaluation is verified, but this actor is outside the packaged runtime-node matrix execution scope.'] : []),
      ],
    };
  }

  function assemblyManifest(assembly) {
    return {
      format: FORMAT, version: 1, tool_version: VERSION, actor_id: assembly.actor_id, source_names: assembly.source_names,
      grade: assembly.grade, render_mode: assembly.render_mode, final_skinned_model: assembly.final_skinned_model,
      counts: assembly.counts, gates: assembly.gates, warnings: assembly.warnings,
      textures: assembly.textures.map((x) => ({ texture_id: x.texture_id, asset_label: x.asset_label, width: x.width, height: x.height, psm: x.psm, palette_banks: x.palette_banks, membership_confidence: x.membership_confidence })),
      fisa: assembly.fisa.map((x) => x.parsed),
      materials: { changes: assembly.materials.changes, reference_tables: assembly.materials.reference_tables, bindings: assembly.materials.bindings, ...(assembly.materials.binding_inference ? { binding_inference: assembly.materials.binding_inference } : {}), slot_statistics: assembly.materials.slot_statistics, unresolved_slots: assembly.materials.unresolved_slots, patch_id_confidence: assembly.materials.patch_id_confidence, texture_assignment_confidence: assembly.materials.texture_assignment_confidence, unresolved: assembly.materials.unresolved },
      matrix_binding: assembly.matrices, skeleton: assembly.skeleton,
      animations: assembly.animations.map((x) => ({ index: x.index, name: x.name, root: x.parsed.root, channels: x.parsed.channels.length, binding: x.binding, channel_structure_confidence: x.channel_structure_confidence, evaluation_confidence: x.evaluation_confidence })),
    };
  }

  function diagnosticObj(assembly) {
    const model = assembly.model, lines = [
      '# SO3 Resource Explorer V5.8 diagnostic geometry',
      `# assembly grade: ${assembly.grade}`,
      `# render mode: ${assembly.render_mode}`,
      '# FIXED/XBDC coordinates are packet-local and unposed. Matrix-to-RTA candidates are NOT applied.',
      '# Evidence-linked material assignments are recorded in the assembly JSON; this diagnostic OBJ intentionally has no MTL or automatic skinning.',
    ];
    for (const vertex of model.vertices) lines.push(`v ${vertex.position.map((x) => Number(x).toPrecision(9)).join(' ')}`);
    for (const vertex of model.vertices) lines.push(`vt ${vertex.uv.map((x) => Number(x).toPrecision(9)).join(' ')}`);
    for (const vertex of model.vertices) lines.push(`vn ${vertex.normal.map((x) => Number(x).toPrecision(9)).join(' ')}`);
    for (const triangle of model.triangles) lines.push(`f ${triangle.map((i) => `${i + 1}/${i + 1}/${i + 1}`).join(' ')}`);
    return `${lines.join('\n')}\n`;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function adler32(bytes) { let a = 1, b = 0; for (const value of bytes) { a = (a + value) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; }
  function concat(parts) { const size = parts.reduce((n, x) => n + x.length, 0), out = new Uint8Array(size); let p = 0; for (const part of parts) { out.set(part, p); p += part.length; } return out; }
  function be32(value) { return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value); }
  function pngChunk(type, data) { const name = new TextEncoder().encode(type), body = concat([name, data]); return concat([be32(data.length), body, be32(crc32(body))]); }
  function zlibStore(data) {
    const parts = [Uint8Array.of(0x78, 0x01)];
    for (let off = 0; off < data.length;) {
      const size = Math.min(65535, data.length - off), final = off + size === data.length, inv = (~size) & 0xffff;
      parts.push(Uint8Array.of(final ? 1 : 0, size & 255, size >>> 8, inv & 255, inv >>> 8), data.subarray(off, off + size)); off += size;
    }
    parts.push(be32(adler32(data))); return concat(parts);
  }
  function rgbaToPng(width, height, rgba) {
    if (rgba.length !== width * height * 4) throw new Error('RGBA dimensions do not match pixel data');
    const scan = new Uint8Array(height * (1 + width * 4));
    for (let y = 0; y < height; y++) scan.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
    const ihdr = concat([be32(width), be32(height), Uint8Array.of(8, 6, 0, 0, 0)]);
    return concat([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlibStore(scan)), pngChunk('IEND', new Uint8Array())]);
  }

  function findIndexedActor(actorId) {
    const normalized = typeof actorId === 'number' ? hex(actorId, 4) : String(actorId || '').toUpperCase().replace(/^0X/, '0x');
    return (ModelIndex?.actors || []).find((x) => x.actor_id.toUpperCase() === normalized.toUpperCase()) || null;
  }

  function decodedResourceFormat(bytes) {
    const magic = String.fromCharCode(...asU8(bytes).subarray(0, 4));
    if (magic === 'RTA\0') return 'RTA';
    if (magic === 'FAS\0' || magic === 'HFAS') return 'FAS';
    if (['XBDC', 'RMAC', 'FPS\0'].includes(magic)) return 'GEOMETRY';
    return magic.replaceAll('\0', '') || 'UNKNOWN';
  }

  async function decodeIndexedIsoResource(resource, bridge, progress) {
    const iso = bridge?.state?.iso, rows = bridge?.state?.hidden || [];
    if (!bridge || !iso) throw new Error('Open the SO3 ISO first');
    const row = rows.find((item) => Number(item.index) === Number(resource.entry) && item.sectors);
    if (!row) throw new Error(`Hidden entry ${resource.entry} is unavailable on this disc`);
    const childOffset = Number(resource.offset), storedSize = Number(resource.stored_size);
    if (!Number.isSafeInteger(childOffset) || !Number.isSafeInteger(storedSize) || childOffset < 0 || storedSize < 1 || childOffset + storedSize > row.size) throw new Error(`${resource.tag} ${resource.res_id} has an invalid indexed extent`);
    if (progress) await progress({ stage: 'read', resource, row, child_offset: childOffset, stored_size: storedSize });
    const raw = new Uint8Array(await iso.slice(row.offset + childOffset, row.offset + childOffset + storedSize).arrayBuffer()), wrapper = String.fromCharCode(...raw.subarray(0, 3));
    let bytes = raw, decodeRecord = null;
    if (wrapper === 'SLZ' || wrapper === 'SLE') {
      const key = wrapper === 'SLE' ? bridge.parseKey(bridge.finalSleKey) : null, result = await bridge.decodeChunk(new Blob([raw]), key);
      bytes = result.out; decodeRecord = result.info;
    }
    const format = decodedResourceFormat(bytes), expected = resource.tag === 'CHAR' ? 'GEOMETRY' : resource.tag === 'ATRC' ? 'RTA' : resource.tag === 'ANIM' ? 'FAS' : null;
    if (expected && format !== expected) throw new Error(`${resource.tag} ${resource.res_id} decoded as ${format}, expected ${expected}`);
    const declaredDecoded = resource.parsed?.find((item) => item.metrics?.decoded_size)?.metrics?.decoded_size;
    if (declaredDecoded != null && bytes.length !== Number(declaredDecoded)) throw new Error(`${resource.tag} ${resource.res_id} decoded-size mismatch: ${bytes.length} != ${declaredDecoded}`);
    return { resource, row: { index: row.index, offset: row.offset, size: row.size }, child_offset: childOffset, stored_size: storedSize, bytes, wrapper: wrapper === 'SLZ' || wrapper === 'SLE' ? `${wrapper}${raw[3]}` : null, format, decode_record: decodeRecord };
  }

  async function assembleIndexedIsoActor(actorId, bridge, progress) {
    const actor = findIndexedActor(actorId);
    if (!actor) throw new Error(`Actor ${actorId} is not in the indexed Atlas actor set`);
    const geometryResource = actor.resources.find((resource) => resource.tag === 'CHAR'), rtaResource = actor.resources.find((resource) => resource.tag === 'ATRC'), animationResources = actor.resources.filter((resource) => resource.tag === 'ANIM');
    if (!geometryResource) throw new Error(`Actor ${actor.actor_id} has no indexed CHAR geometry`);
    const plan = [geometryResource, ...(rtaResource ? [rtaResource] : []), ...animationResources], decoded = [];
    for (let index = 0; index < plan.length; index++) {
      if (progress) await progress({ stage: 'plan', actor, resource: plan[index], index, total: plan.length });
      decoded.push(await decodeIndexedIsoResource(plan[index], bridge, progress ? (event) => progress({ ...event, actor, index, total: plan.length }) : null));
    }
    const geometry = decoded.find((item) => item.resource === geometryResource), rta = decoded.find((item) => item.resource === rtaResource), animations = decoded.filter((item) => item.resource.tag === 'ANIM').map((item) => ({ name: `${item.resource.tag}_${item.resource.res_id}.fas`, bytes: item.bytes }));
    const assembly = assemble({ actorId: actor.actor_id, geometry: geometry.bytes, rta: rta?.bytes || null, animations, sourceNames: { mode: 'OPEN_ISO_INDEXED_ACTOR', geometry: `entry_${geometryResource.entry}@${geometryResource.offset}`, rta: rtaResource ? `entry_${rtaResource.entry}@${rtaResource.offset}` : null, animations: animationResources.map((resource) => `entry_${resource.entry}@${resource.offset}`) } });
    return { actor, plan, decoded, assembly };
  }

  function workspaceActorNodes(workspace, actorId) {
    const state = workspace?.state || workspace, value = typeof actorId === 'string' ? Number.parseInt(actorId.replace(/^0x/i, ''), 16) : Number(actorId);
    if (!state?.nodes || !Number.isFinite(value)) return [];
    return Array.from(state.nodes.values()).filter((node) => Number(node.actor_id) === value && node.provider).sort((a, b) => String(a.tag || a.format).localeCompare(String(b.tag || b.format)) || Number(a.animation_slot || 0) - Number(b.animation_slot || 0));
  }

  return Object.freeze({
    VERSION, FORMAT, CONFIDENCE, parseFisa, decodeEmbeddedTextures, materialWrites, materialSlots, materialSlotStatistics,
    parseMaterialReferenceTables, materialTex0Psm, materialAlphaValue, completeFormatOrdinalFallback, resolveMaterialReferences, matrixBinding,
    worldSkeleton, animationBindings, assemble, assemblyManifest, diagnosticObj, rgbaToPng, findIndexedActor,
    decodedResourceFormat, decodeIndexedIsoResource, assembleIndexedIsoActor, workspaceActorNodes,
  });
});
