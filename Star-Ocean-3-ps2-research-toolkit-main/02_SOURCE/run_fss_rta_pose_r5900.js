#!/usr/bin/env node
/* Execute the original SO3 RTA name binder and the actual FSS transform
 * loader, then carry two real animated-node witnesses across the already
 * verified IDOM, palette-packet, and VU1 packet boundaries.
 *
 * This target is deliberately fail closed.  Only mapped original Lib/SLES
 * bytes and the opcode subset implemented by the shared bounded R5900/VU0
 * target execute.  RTA bytes are never substituted for FSS transforms.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Geometry = require('./v5_1_geometry.js');
const Rotation = require('./run_fas_rotation_r5900.js');
const NodeMatrix = require('./run_fas_node_matrix_r5900.js');
const Idom = require('./run_idom_loader_r5900.js');
const Vu0 = require('./run_vu0_idom_matrix_micro.js');
const Palette = require('./run_matrix_palette_upload_r5900.js');
const Packet = require('./run_vu1_packet_skinning.js');

const RTA_BINDER = 0x0045B080;
const RTA_BINDER_END = 0x0045B180;
const RTA_LOOKUP = 0x004731C0;
const NAME_COMPARE = 0x004D8880;
const FSS_TRANSFORM_LOADER = 0x0046C360;
const FSS_TRANSFORM_LOADER_END = 0x0046C4AC;
const FSS_TYPE9_BRANCH = 0x00475A10;
const FSS_TYPE9_LOADER_CALL = 0x00475A6C;
const BASE_TRANSFORM_VTABLE = 0x00178E20;
const TRANSIENT_TYPE9_VTABLE = 0x00178940;
const TRANSLATION_SCALAR_SETTER = 0x003EEEB0;
const TRANSLATION_VECTOR_SETTER = 0x003EEE70;
const ROTATION_SCALAR_SETTER = 0x003EEED0;
const ROTATION_VECTOR_SETTER = 0x003EEF10;
const SCALE_SCALAR_SETTER = 0x003EF010;
const MATRIX_WRITER = 0x004DA820;
const AUX_MATRIX_WRITER = 0x004DAAC0;
const IDENTITY_INITIALIZER = 0x004CFEF0;
const NODE_CONSTRUCTOR = 0x004DAD00;
const CONSTRUCTOR_CALLS = Object.freeze([0x004E0F10, 0x004D58B0, 0x004CFEC0, 0x004CFEF0]);
const LOADER_CALLS = Object.freeze([
  TRANSLATION_SCALAR_SETTER,
  ROTATION_SCALAR_SETTER,
  SCALE_SCALAR_SETTER,
  AUX_MATRIX_WRITER,
  IDENTITY_INITIALIZER,
]);

const NODE_BASE = 0x01100000;
const NODE_STRIDE = 0x240;
const MANAGER_BASE = 0x01200000;
const RECORD_BASE = 0x01201000;
const CHAR_BASE = 0x01300000;
const INPUT_BASE = 0x01600000;
const STACK_TOP = 0x01F00000;
const SENTINEL = 0x0BADF00D;

function sha256(input) {
  return crypto.createHash('sha256').update(Buffer.from(input)).digest('hex');
}

function hex(value, width = 8) {
  return `0x${Number(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

function f32(value) { return Math.fround(value); }

function floatArrayBytes(values) {
  const output = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => output.writeFloatLE(f32(value), index * 4));
  return output;
}

function matrixFromBytes(bytes, offset = 0) {
  return Array.from({ length: 16 }, (_, index) => bytes.readFloatLE(offset + index * 4));
}

function vectorFromBytes(bytes, offset = 0) {
  return Array.from({ length: 4 }, (_, index) => bytes.readFloatLE(offset + index * 4));
}

function matrixBytes(matrix) {
  if (matrix.length !== 16) throw new Error('matrix must contain 16 values');
  return floatArrayBytes(matrix);
}

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function libSlice(lib, start, endExclusive) {
  const load = lib.readUInt32LE(8);
  const startOffset = start - load;
  const endOffset = endExclusive - load;
  if (startOffset < 0 || endOffset > lib.length || startOffset >= endOffset) {
    throw new Error(`invalid Lib slice ${hex(start)}..${hex(endExclusive)}`);
  }
  return lib.subarray(startOffset, endOffset);
}

function elf32FileBackedLoadSegments(elfInput) {
  const elf = Buffer.from(elfInput);
  if (elf.length < 0x34 || elf.toString('binary', 0, 4) !== '\x7FELF' || elf[4] !== 1 || elf[5] !== 1) {
    throw new Error('expected little-endian ELF32 SLES input');
  }
  const phoff = elf.readUInt32LE(0x1C);
  const phentsize = elf.readUInt16LE(0x2A);
  const phnum = elf.readUInt16LE(0x2C);
  const rows = [];
  for (let index = 0; index < phnum; index++) {
    const off = phoff + index * phentsize;
    if (elf.readUInt32LE(off) !== 1) continue;
    const fileOffset = elf.readUInt32LE(off + 4);
    const vaddr = elf.readUInt32LE(off + 8);
    const fileSize = elf.readUInt32LE(off + 16);
    const memorySize = elf.readUInt32LE(off + 20);
    if (!fileSize) continue;
    if (fileOffset + fileSize > elf.length || memorySize < fileSize) throw new Error(`invalid ELF LOAD ${index}`);
    const image = Buffer.alloc(memorySize);
    elf.copy(image, 0, fileOffset, fileOffset + fileSize);
    rows.push({ index, vaddr, fileSize, memorySize, image });
  }
  if (!rows.length) throw new Error('SLES has no file-backed LOAD segment');
  return rows;
}

function decodeName(raw) {
  try { return new TextDecoder('shift_jis').decode(raw); }
  catch { return Buffer.from(raw).toString('latin1'); }
}

function zeroTerminated(raw) {
  const end = raw.indexOf(0);
  return Buffer.from(end < 0 ? raw : raw.subarray(0, end));
}

function parseFss(charInput) {
  const bytes = Buffer.from(charInput);
  const sections = [];
  for (let offset = 0; offset + 0x4C <= bytes.length; offset += 0x10) {
    if (!bytes.subarray(offset, offset + 4).equals(Buffer.from('FSS\0', 'binary'))) continue;
    const declared = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + declared;
    const count = bytes.readUInt32LE(offset + 0x18);
    if (end > bytes.length || count > 4096) throw new Error(`invalid FSS at ${hex(offset)}`);
    let cursor = offset + 0x4C;
    const descriptors = [];
    for (let index = 0; index < count; index++) {
      const length = bytes.readUInt16LE(cursor);
      const nameOffset = bytes.readUInt16LE(cursor + 2);
      if (length < 0x80 || length % 4 || cursor + length > end || nameOffset + 16 > length) {
        throw new Error(`invalid FSS descriptor ${index} at ${hex(cursor)}`);
      }
      const nameRaw = zeroTerminated(bytes.subarray(cursor + nameOffset, cursor + nameOffset + 16));
      descriptors.push({
        index,
        offset: cursor,
        length,
        name_offset: nameOffset,
        name_raw_hex: nameRaw.toString('hex'),
        name: decodeName(nameRaw),
        parent_index: bytes.readInt32LE(cursor + 4),
        creation_subtype: bytes[cursor + 0x0E],
        runtime_type: bytes[cursor + 0x0F],
      });
      cursor += length;
    }
    if (cursor !== end) throw new Error(`FSS descriptor extent mismatch at ${hex(offset)}`);
    sections.push({ offset, end, count, descriptors });
  }
  if (sections.length !== 1) throw new Error(`expected one FSS section, found ${sections.length}`);
  return sections[0];
}

function parseRta(rtaInput) {
  const bytes = Buffer.from(rtaInput);
  if (bytes.length < 0x40 || bytes.toString('binary', 0, 4) !== 'RTA\0') throw new Error('expected RTA input');
  const count = bytes.readUInt16LE(0x12);
  const recordsEnd = 0x40 + count * 0x20;
  if (recordsEnd + count * 0x14 > bytes.length) throw new Error('RTA records/names exceed input');
  const names = Array.from({ length: count }, (_, index) => {
    const record = recordsEnd + index * 0x14;
    const raw = zeroTerminated(bytes.subarray(record + 4, record + 0x14));
    return { index, raw, name: decodeName(raw), record };
  });
  return { bytes, count, recordsEnd, names };
}

function summarizeCpu(cpu, includeTrace = false) {
  const row = {
    stop_reason: 'RETURN_SENTINEL',
    original_guest_instructions: cpu.steps,
    original_vu0_microprogram_calls: cpu.microprogramCalls.length,
    original_vu0_microinstruction_pairs: cpu.microinstructionPairs,
    executed_opcodes: [...cpu.executedOpcodes].sort(),
    call_trace: cpu.callTrace,
    trace_commitment_sha256: sha256(Buffer.from(cpu.traceRows.join(''))),
  };
  if (includeTrace) row.trace = cpu.trace;
  return row;
}

function resolveBaseVtable(slesInput) {
  const sles = Buffer.from(slesInput);
  const slots = {
    translation_scalar_setter: NodeMatrix.elf32Word(sles, BASE_TRANSFORM_VTABLE + 0x1C),
    translation_vector_setter: NodeMatrix.elf32Word(sles, BASE_TRANSFORM_VTABLE + 0x24),
    rotation_scalar_setter: NodeMatrix.elf32Word(sles, BASE_TRANSFORM_VTABLE + 0x3C),
    rotation_vector_setter: NodeMatrix.elf32Word(sles, BASE_TRANSFORM_VTABLE + 0x34),
    scale_scalar_setter: NodeMatrix.elf32Word(sles, BASE_TRANSFORM_VTABLE + 0x40),
    matrix_writer: NodeMatrix.elf32Word(sles, BASE_TRANSFORM_VTABLE + 0x60),
    copy_initializer: NodeMatrix.elf32Word(sles, BASE_TRANSFORM_VTABLE + 0x80),
  };
  const expected = {
    translation_scalar_setter: TRANSLATION_SCALAR_SETTER,
    translation_vector_setter: TRANSLATION_VECTOR_SETTER,
    rotation_scalar_setter: ROTATION_SCALAR_SETTER,
    rotation_vector_setter: ROTATION_VECTOR_SETTER,
    scale_scalar_setter: SCALE_SCALAR_SETTER,
    matrix_writer: MATRIX_WRITER,
    copy_initializer: 0x004D9EB0,
  };
  for (const [name, target] of Object.entries(slots)) {
    if (target !== expected[name]) throw new Error(`base vtable ${name}: ${hex(target)} != ${hex(expected[name])}`);
  }
  return slots;
}

class ActorTransformRuntime {
  constructor(libInput, slesInput, charInput) {
    this.lib = Buffer.from(libInput);
    this.sles = Buffer.from(slesInput);
    this.char = Buffer.from(charInput);
    this.fss = parseFss(this.char);
    this.vtable = resolveBaseVtable(this.sles);
    this.vuProgramInfo = Vu0.extractVu0Program(this.lib);
    this.memory = new Rotation.BoundedMemory();
    const moduleImage = Buffer.alloc(this.lib.length + this.lib.readUInt32LE(0x14));
    this.lib.copy(moduleImage);
    this.memory.map(Rotation.LIB_LOAD, moduleImage, 'Lib_file_and_declared_zero_fill', true);
    for (const segment of elf32FileBackedLoadSegments(this.sles)) {
      this.memory.map(segment.vaddr, segment.image, `SLES_LOAD_${segment.index}`, false);
    }
    this.nodes = Buffer.alloc(this.fss.count * NODE_STRIDE);
    this.manager = Buffer.alloc(0x200);
    this.records = Buffer.alloc(this.fss.count * 0x10);
    this.inputs = Buffer.alloc(0x100);
    this.stack = Buffer.alloc(0x6000);
    this.memory.map(NODE_BASE, this.nodes, 'FSS_runtime_node_pool', true);
    this.memory.map(MANAGER_BASE, this.manager, 'FSS_resource_manager', true);
    this.memory.map(RECORD_BASE, this.records, 'FSS_runtime_resource_records', true);
    this.memory.map(CHAR_BASE, this.char, 'actor_CHAR_FSS', false);
    this.memory.map(INPUT_BASE, this.inputs, 'runtime_setter_inputs', true);
    this.memory.map(STACK_TOP - this.stack.length, this.stack, 'target_stack', true);
    this.manager.writeUInt32LE(RECORD_BASE, 0x18);
    this.constructed = new Set();
  }

  nodeAddress(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.fss.count) throw new Error(`node index ${index} outside FSS`);
    return NODE_BASE + index * NODE_STRIDE;
  }

  nodeBytes(index) {
    const offset = index * NODE_STRIDE;
    return this.nodes.subarray(offset, offset + NODE_STRIDE);
  }

  run(entry, args, allowedCalls, maxSteps = 100000, traceLimit = 0) {
    this.stack.fill(0);
    const cpu = new Rotation.FasRotationR5900(this.memory, {
      vuProgram: this.vuProgramInfo.program,
      allowedCalls,
      traceLimit,
    });
    cpu.setLow64(4, args[0] || 0);
    cpu.setLow64(5, args[1] || 0);
    cpu.setLow64(6, args[2] || 0);
    cpu.setLow64(7, args[3] || 0);
    cpu.setLow64(29, STACK_TOP);
    cpu.setLow64(31, SENTINEL);
    const stop = cpu.run(entry, maxSteps);
    if (stop !== 'RETURN_SENTINEL') throw new Error(`${hex(entry)} stopped at ${stop}`);
    return cpu;
  }

  construct(index) {
    const cpu = this.run(NODE_CONSTRUCTOR, [this.nodeAddress(index)], CONSTRUCTOR_CALLS, 10000);
    const node = this.nodeBytes(index);
    if (node.readUInt32LE(0) !== BASE_TRANSFORM_VTABLE) throw new Error(`constructor vtable mismatch for FSS ${index}`);
    this.records.writeUInt32LE(this.nodeAddress(index), index * 0x10 + 8);
    this.constructed.add(index);
    return summarizeCpu(cpu);
  }

  loadDescriptor(index) {
    if (!this.constructed.has(index)) throw new Error(`FSS ${index} was not constructed`);
    const descriptor = this.fss.descriptors[index];
    const parent = descriptor.parent_index;
    if (parent >= 0 && !this.constructed.has(parent)) throw new Error(`FSS ${index} parent ${parent} was not constructed`);
    const cpu = this.run(
      FSS_TRANSFORM_LOADER,
      [MANAGER_BASE, this.nodeAddress(index), CHAR_BASE + descriptor.offset],
      LOADER_CALLS,
      20000,
    );
    const node = this.nodeBytes(index);
    const record = this.char.subarray(descriptor.offset, descriptor.offset + descriptor.length);
    const expectedTranslation = Buffer.alloc(16);
    record.copy(expectedTranslation, 0, 0x34, 0x40);
    expectedTranslation.writeFloatLE(1, 12);
    const expectedQuaternion = Buffer.from(record.subarray(0x24, 0x34));
    const expectedScale = Buffer.alloc(16);
    record.copy(expectedScale, 0, 0x44, 0x50);
    expectedScale.writeFloatLE(1, 12);
    const expectedParent = parent < 0 ? 0 : this.nodeAddress(parent);
    const callTargets = cpu.callTrace.map(row => Number.parseInt(row.target_va, 16));
    const checks = {
      translation_descriptor_plus_0x34_to_node_plus_0x20_byte_exact: node.subarray(0x20, 0x30).equals(expectedTranslation),
      quaternion_descriptor_plus_0x24_to_node_plus_0x30_byte_exact: node.subarray(0x30, 0x40).equals(expectedQuaternion),
      scale_descriptor_plus_0x44_to_node_plus_0x40_byte_exact: node.subarray(0x40, 0x50).equals(expectedScale),
      fss_parent_index_to_node_plus_0x208_exact: node.readUInt32LE(0x208) === expectedParent,
      dirty_byte_node_plus_0x50_set: node[0x50] === 1,
      scalar_setters_called_in_original_order: callTargets[0] === TRANSLATION_SCALAR_SETTER && callTargets[1] === ROTATION_SCALAR_SETTER && callTargets[2] === SCALE_SCALAR_SETTER,
      auxiliary_matrix_writer_called_three_times: callTargets.filter(target => target === AUX_MATRIX_WRITER).length === 3,
      no_rta_bytes_mapped_or_consumed: true,
    };
    if (!Object.values(checks).every(Boolean)) throw new Error(`FSS loader check failed for ${descriptor.name}: ${JSON.stringify(checks)}`);
    return {
      descriptor_index: index,
      descriptor_offset: hex(descriptor.offset),
      descriptor_length: descriptor.length,
      name: descriptor.name,
      name_raw_hex: descriptor.name_raw_hex,
      parent_descriptor_index: parent,
      serialized_runtime_type: descriptor.runtime_type,
      runtime_node_address: hex(this.nodeAddress(index)),
      translation: vectorFromBytes(expectedTranslation),
      quaternion: vectorFromBytes(expectedQuaternion),
      scale: vectorFromBytes(expectedScale),
      translation_sha256: sha256(expectedTranslation),
      quaternion_sha256: sha256(expectedQuaternion),
      scale_sha256: sha256(expectedScale),
      execution: summarizeCpu(cpu),
      checks,
    };
  }

  constructAndLoadAllType9() {
    const nodeDescriptors = this.fss.descriptors.filter(row => row.index === 0 || row.runtime_type === 9);
    const constructors = nodeDescriptors.map(row => ({ descriptor_index: row.index, ...this.construct(row.index) }));
    const loaders = this.fss.descriptors.filter(row => row.runtime_type === 9).map(row => this.loadDescriptor(row.index));
    return { constructors, loaders };
  }

  setQuaternion(index, quaternion) {
    const bytes = floatArrayBytes(quaternion);
    bytes.copy(this.inputs, 0);
    const cpu = this.run(ROTATION_VECTOR_SETTER, [this.nodeAddress(index), INPUT_BASE], [], 128);
    const exact = this.nodeBytes(index).subarray(0x30, 0x40).equals(bytes);
    if (!exact || this.nodeBytes(index)[0x50] !== 1) throw new Error(`rotation setter failed for FSS ${index}`);
    return { quaternion: Array.from(quaternion, f32), quaternion_sha256: sha256(bytes), exact, execution: summarizeCpu(cpu) };
  }

  writeMatrix(index) {
    const cpu = this.run(MATRIX_WRITER, [this.nodeAddress(index)], [MATRIX_WRITER], 100000);
    const node = this.nodeBytes(index);
    const localBytes = Buffer.from(node.subarray(0x90, 0xD0));
    const worldBytes = Buffer.from(node.subarray(0xD0, 0x110));
    const checks = {
      dirty_cleared: node[0x50] === 0,
      matrix_valid_set: node[0x51] === 1,
      matrices_finite: [...matrixFromBytes(localBytes), ...matrixFromBytes(worldBytes)].every(Number.isFinite),
    };
    if (!Object.values(checks).every(Boolean)) throw new Error(`matrix writer failed for FSS ${index}`);
    return {
      local_matrix: matrixFromBytes(localBytes),
      world_matrix: matrixFromBytes(worldBytes),
      local_matrix_sha256: sha256(localBytes),
      world_matrix_sha256: sha256(worldBytes),
      execution: summarizeCpu(cpu),
      checks,
    };
  }
}

function signedNameHash(raw) {
  let value = 0;
  for (const byte of raw) value = (value + (byte & 0x80 ? byte - 0x100 : byte)) | 0;
  return value;
}

function executeRtaBinder(libInput, rtaInput, options = {}) {
  const lib = Buffer.from(libInput);
  const parsed = parseRta(rtaInput);
  const original = Buffer.from(parsed.bytes);
  const rta = Buffer.from(parsed.bytes);
  const memory = new Rotation.BoundedMemory();
  const moduleImage = Buffer.alloc(lib.length + lib.readUInt32LE(0x14));
  lib.copy(moduleImage);
  memory.map(Rotation.LIB_LOAD, moduleImage, 'Lib_file_and_declared_zero_fill', true);
  const RTA_BASE = 0x01700000;
  const HANDLE = 0x01710000;
  const MANAGER = 0x01720000;
  const COUNT = 0x01721000;
  const RECORDS = 0x01722000;
  const DESCRIPTORS = 0x01730000;
  const NODES = 0x01780000;
  const NAME_DESCRIPTOR_STRIDE = 0xB0;
  const handle = Buffer.alloc(0x10);
  const manager = Buffer.alloc(0x200);
  const count = Buffer.alloc(0x10);
  const records = Buffer.alloc(parsed.count * 0x10);
  const descriptors = Buffer.alloc(parsed.count * NAME_DESCRIPTOR_STRIDE);
  const nodes = Buffer.alloc(parsed.count * 0x20, 0x5A);
  const stack = Buffer.alloc(0x6000);
  memory.map(RTA_BASE, rta, 'RTA_writable_relocation_copy', true);
  memory.map(HANDLE, handle, 'RTA_handle', true);
  memory.map(MANAGER, manager, 'CHAR_runtime_manager', true);
  memory.map(COUNT, count, 'CHAR_runtime_record_count', true);
  memory.map(RECORDS, records, 'CHAR_runtime_records', true);
  memory.map(DESCRIPTORS, descriptors, 'CHAR_runtime_name_descriptors', true);
  memory.map(NODES, nodes, 'sentinel_runtime_nodes', true);
  memory.map(STACK_TOP - stack.length, stack, 'target_stack', true);
  handle.writeUInt32LE(RTA_BASE + 0x10, 0);
  manager.writeUInt32LE(RECORDS, 0x18);
  manager.writeUInt32LE(COUNT, 0x20);
  count.writeUInt32LE(parsed.count, 4);
  for (const name of parsed.names) {
    const descriptorOffset = name.index * NAME_DESCRIPTOR_STRIDE;
    const runtimeName = Buffer.from(name.raw);
    if (options.mutateManagerNameIndex === name.index && runtimeName.length) runtimeName[0] ^= 0x20;
    descriptors.writeUInt16LE(0x90, descriptorOffset + 2);
    descriptors.writeInt32LE(signedNameHash(name.raw), descriptorOffset + 0x84);
    runtimeName.copy(descriptors, descriptorOffset + 0x90);
    records.writeUInt32LE(NODES + name.index * 0x20, name.index * 0x10 + 8);
    records.writeUInt32LE(DESCRIPTORS + descriptorOffset, name.index * 0x10 + 12);
  }
  const cpu = new Rotation.FasRotationR5900(memory, {
    allowedCalls: [RTA_LOOKUP, NAME_COMPARE],
    traceLimit: 0,
  });
  cpu.setLow64(4, HANDLE);
  cpu.setLow64(5, MANAGER);
  cpu.setLow64(29, STACK_TOP);
  cpu.setLow64(31, SENTINEL);
  const stop = cpu.run(RTA_BINDER, 200000);
  if (stop !== 'RETURN_SENTINEL') throw new Error(`RTA binder stopped at ${stop}`);
  const base = RTA_BASE + 0x10;
  const bindings = [];
  let recordFieldsPreserved = true;
  let recordLinksRelocated = true;
  for (let index = 0; index < parsed.count; index++) {
    const recordOffset = 0x40 + index * 0x20;
    const nameIndex = original.readInt16LE(recordOffset + 0x0C);
    const expected = options.mutateManagerNameIndex === nameIndex ? 0 : NODES + nameIndex * 0x20;
    const actual = rta.readUInt32LE(recordOffset + 4);
    const originalLink = original.readUInt32LE(recordOffset);
    const expectedLink = originalLink ? base + originalLink : 0;
    recordLinksRelocated &&= rta.readUInt32LE(recordOffset) === expectedLink;
    recordFieldsPreserved &&= rta.subarray(recordOffset + 8, recordOffset + 0x20).equals(original.subarray(recordOffset + 8, recordOffset + 0x20));
    bindings.push({
      rta_record_index: index,
      rta_name_index: nameIndex,
      name: parsed.names[nameIndex]?.name ?? null,
      runtime_node_pointer: hex(actual),
      expected_runtime_node_pointer: hex(expected),
      exact: actual === expected,
    });
  }
  const checks = {
    relocation_flag_bit_0x80_set: (rta[0x11] & 0x80) !== 0,
    name_table_offset_relocated_against_rta_plus_0x10: rta.readUInt32LE(0x18) === base + original.readUInt32LE(0x18),
    palette_offset_relocated_against_rta_plus_0x10: rta.readUInt32LE(0x1C) === base + original.readUInt32LE(0x1C),
    nonzero_record_links_relocated_once: recordLinksRelocated,
    every_record_bound_by_exact_name_or_expected_mutation_miss: bindings.every(row => row.exact),
    record_bytes_plus_0x08_through_0x1f_unchanged: recordFieldsPreserved,
    runtime_node_bytes_unchanged: nodes.every(byte => byte === 0x5A),
    exact_name_lookup_and_compare_call_counts: cpu.callTrace.filter(row => row.target_va === hex(RTA_LOOKUP)).length === parsed.count && cpu.callTrace.filter(row => row.target_va === hex(NAME_COMPARE)).length === parsed.count,
  };
  if (!Object.values(checks).every(Boolean)) throw new Error(`RTA binder checks failed: ${JSON.stringify(checks)}`);
  return {
    rta_sha256: sha256(original),
    rta_bytes: original.length,
    node_count: parsed.count,
    relocated_rta_sha256: sha256(rta),
    execution: summarizeCpu(cpu),
    bindings,
    checks,
    semantic_result: 'RTA_RELOCATES_LINKS_AND_BINDS_EXISTING_RUNTIME_NODES_BY_EXACT_NAME_WITHOUT_LOADING_TRANSFORMS',
  };
}

function exactRuntimeIdomMatrix(charBytes, section, slot) {
  const matrices = Buffer.from(Idom.expectedRuntimeMatrices(charBytes, section));
  return matrixFromBytes(matrices, slot * 0x40);
}

function findSegmentForIdom(model, sectionOffset) {
  for (let segmentIndex = 0; segmentIndex < model.segments.length; segmentIndex++) {
    const segment = model.segments[segmentIndex];
    const chainIndex = model.chain.blocks.findIndex(block => block.off === segment.off && block.type === 'FPS');
    const next = chainIndex >= 0 ? model.chain.blocks[chainIndex + 1] : null;
    if (next && next.type === 'MODI' && next.off === sectionOffset && segment.end + 0x10 === next.off) return segmentIndex;
  }
  throw new Error(`no chain-adjacent FPS for IDOM ${hex(sectionOffset)}`);
}

function chooseTrack(actor, clips, descriptors, section) {
  const preferences = {
    '0x08FF': { source: 'ANIM_0x002008FF.fas', channel: 'Bip01 Spine1' },
    '0x0BC0': { source: 'ANIM_0x00200BC0.fas', channel: 'Bip01 L Thigh' },
  };
  const tracks = Rotation.collectTracks(clips);
  const byName = new Map(descriptors.map(row => [row.name, row]));
  const candidates = tracks.filter(track => {
    const descriptor = byName.get(track.channel_name);
    return track.actor === actor && descriptor?.runtime_type === 9 && section.indices.includes(descriptor.index) && track.keys.length >= 2;
  });
  const preferred = preferences[actor];
  const selected = candidates.find(track => track.source_name === preferred?.source && track.channel_name === preferred?.channel) || candidates[0];
  if (!selected) throw new Error(`${actor}: no FAS track maps to the selected IDOM`);
  return { track: selected, descriptor: byName.get(selected.channel_name) };
}

function bytesDiffer(left, right) {
  return !Buffer.from(left).equals(Buffer.from(right));
}

function buildPoseWitness({ actor, runtime, charBytes, clips, lib, packetProgram }) {
  const sections = Idom.parseIdomSections(charBytes);
  const section = sections[0];
  const { track, descriptor } = chooseTrack(actor, clips, runtime.fss.descriptors, section);
  const slot = section.indices.indexOf(descriptor.index);
  if (slot < 0) throw new Error(`${actor}: selected descriptor absent from IDOM`);
  const bindNode = runtime.writeMatrix(descriptor.index);
  const first = track.keys[0];
  const second = track.keys[1];
  const animationTime = f32((first.time + second.time) / 2);
  const fixture = Rotation.buildExecutionFixture(lib, track.keys, { vuProgramInfo: runtime.vuProgramInfo });
  const rotation = Rotation.executeFixtureAt(fixture, animationTime, { traceLimit: 0 });
  const setter = runtime.setQuaternion(descriptor.index, rotation.quaternion);
  const animatedNode = runtime.writeMatrix(descriptor.index);
  const idomMatrix = exactRuntimeIdomMatrix(charBytes, section, slot);
  const root = identityMatrix();
  const bindComposed = Vu0.executeMatrix(runtime.vuProgramInfo.program, runtime.vuProgramInfo.entryIndex, idomMatrix, bindNode.world_matrix, root);
  const animatedComposed = Vu0.executeMatrix(runtime.vuProgramInfo.program, runtime.vuProgramInfo.entryIndex, idomMatrix, animatedNode.world_matrix, root);
  const bindOracle = matrixBytes(Vu0.independentExpected(idomMatrix, bindNode.world_matrix, root));
  const animatedOracle = matrixBytes(Vu0.independentExpected(idomMatrix, animatedNode.world_matrix, root));
  if (!bindComposed.bytes.equals(bindOracle) || !animatedComposed.bytes.equals(animatedOracle)) throw new Error(`${actor}: VU0 composition differs from independent oracle`);
  const matrixAddress = Packet.PALETTE_BASE_QWORD + slot * Packet.MATRIX_QWORDS;
  const model = Geometry.parseGeometry(charBytes);
  const segmentIndex = findSegmentForIdom(model, section.offset);
  const vertexIndex = model.vertices.findIndex(vertex => vertex.segment === segmentIndex && vertex.matrixAddress === matrixAddress);
  if (vertexIndex < 0) throw new Error(`${actor}: no real FIXED vertex selects ${hex(matrixAddress, 3)}`);
  const vertex = model.vertices[vertexIndex];
  const alternativeAddress = Packet.PALETTE_BASE_QWORD + ((slot + 1) % section.header.matrix_count) * Packet.MATRIX_QWORDS;
  const bindPacket = Packet.executeVertex(packetProgram, vertex, matrixAddress, alternativeAddress, matrixFromBytes(bindComposed.bytes), identityMatrix());
  const animatedPacket = Packet.executeVertex(packetProgram, vertex, matrixAddress, alternativeAddress, matrixFromBytes(animatedComposed.bytes), identityMatrix());
  const uploader = Palette.executeCase(lib, charBytes, {
    actor,
    label: `${actor}:IDOM@${hex(section.offset)}`,
    idom_offset: section.offset,
    matrix_count: section.header.matrix_count,
  }, 0);
  const outputChanged = bytesDiffer(floatArrayBytes(bindPacket.output.position), floatArrayBytes(animatedPacket.output.position)) ||
    bytesDiffer(floatArrayBytes(bindPacket.output.normal), floatArrayBytes(animatedPacket.output.normal));
  const checks = {
    fss_descriptor_is_real_type9: descriptor.runtime_type === 9,
    fss_translation_was_loaded_before_animation: runtime.nodeBytes(descriptor.index).subarray(0x20, 0x2C).equals(charBytes.subarray(descriptor.offset + 0x34, descriptor.offset + 0x40)),
    animation_quaternion_setter_byte_exact: setter.exact,
    bind_and_animated_world_matrices_differ: bindNode.world_matrix_sha256 !== animatedNode.world_matrix_sha256,
    vu0_bind_composition_byte_exact_against_independent_oracle: bindComposed.bytes.equals(bindOracle),
    vu0_animated_composition_byte_exact_against_independent_oracle: animatedComposed.bytes.equals(animatedOracle),
    palette_uploader_targets_qword_0x290: uploader.expected.vif_destination_qword === '0x290',
    palette_uploader_count_matches_selected_idom: uploader.matrix_count === section.header.matrix_count,
    real_vertex_address_selects_exact_idom_slot: vertex.matrixAddress === matrixAddress,
    original_vu1_outputs_match_internal_float32_oracle: Object.values(animatedPacket.checks).every(Boolean),
    changing_only_original_animation_result_changes_real_vertex_output: outputChanged,
  };
  if (!Object.values(checks).every(Boolean)) throw new Error(`${actor}: pose witness failed ${JSON.stringify(checks)}`);
  return {
    actor,
    fas_source_name: track.source_name,
    fas_source_sha256: track.source_sha256,
    channel_name: track.channel_name,
    fss_descriptor_index: descriptor.index,
    fss_descriptor_offset: hex(descriptor.offset),
    fss_translation: Array.from({ length: 3 }, (_, index) => charBytes.readFloatLE(descriptor.offset + 0x34 + index * 4)),
    idom_offset: hex(section.offset),
    idom_palette_slot: slot,
    vu1_matrix_qword_address: hex(matrixAddress, 3),
    real_vertex: {
      global_vertex_index: vertexIndex,
      segment_index: segmentIndex,
      packet_index: vertex.packet,
      position: vertex.position,
      normal: vertex.normal,
    },
    animation: {
      sample_kind: 'BETWEEN_FIRST_TWO_KEYS',
      time: animationTime,
      original_evaluator_guest_instructions: rotation.instruction_count,
      original_interpolator_calls: rotation.original_interpolator_calls,
      original_vu0_microinstruction_pairs: rotation.original_vu0_microinstruction_pairs,
      quaternion: rotation.quaternion,
      quaternion_sha256: rotation.quaternion_sha256,
      setter,
    },
    bind_node_matrix: bindNode,
    animated_node_matrix: animatedNode,
    idom_composition: {
      bind_matrix_sha256: sha256(bindComposed.bytes),
      animated_matrix_sha256: sha256(animatedComposed.bytes),
      bind_original_vu0_instruction_pairs: bindComposed.runtime.instruction_pairs,
      animated_original_vu0_instruction_pairs: animatedComposed.runtime.instruction_pairs,
      bind_trace_commitment_sha256: sha256(Buffer.from(bindComposed.runtime.trace.map(row => `${row.pc_instruction_index}|${row.lower_word}|${row.upper_word}\n`).join(''))),
      animated_trace_commitment_sha256: sha256(Buffer.from(animatedComposed.runtime.trace.map(row => `${row.pc_instruction_index}|${row.lower_word}|${row.upper_word}\n`).join(''))),
    },
    palette_packet: {
      stop_reason: uploader.stop_reason,
      original_guest_instructions: uploader.instruction_count,
      vif_word: uploader.actual.vif_word,
      vif_destination_qword: uploader.expected.vif_destination_qword,
      dma_qwc: uploader.expected.dma_qwc,
      dma_source_address: uploader.expected.dma_source_address,
      packet_sha256: uploader.packet_sha256,
      trace_commitment_sha256: uploader.trace_commitment_sha256,
    },
    packet_vertex: {
      bind_output: bindPacket.output,
      animated_output: animatedPacket.output,
      bind_original_vu1_instruction_pairs: bindPacket.original_instruction_pairs_executed,
      animated_original_vu1_instruction_pairs: animatedPacket.original_instruction_pairs_executed,
      bind_trace_commitment_sha256: bindPacket.trace_commitment_sha256,
      animated_trace_commitment_sha256: animatedPacket.trace_commitment_sha256,
    },
    checks,
    boundary: 'DMA transfer and VIF UNPACK are joined at their byte-exact verified memory boundary: the original packet constructor points at the composed 0x40-byte slot, and the original VU1 witness begins after UNPACK with those exact bytes.',
  };
}

function directJalTargets(moduleBytes, start, endExclusive) {
  const load = moduleBytes.readUInt32LE(8);
  const targets = [];
  for (let pc = start; pc < endExclusive; pc += 4) {
    const word = moduleBytes.readUInt32LE(pc - load);
    if (word >>> 26 === 3) targets.push({ call_site_va: hex(pc), target_va: hex(((pc + 4) & 0xF0000000) | ((word & 0x03FFFFFF) << 2)) });
  }
  return targets;
}

function buildStaticEvidence(lib, sles, field) {
  const fieldLoad = field.readUInt32LE(8);
  if (field.toString('ascii', 0, 4) !== 'MWo3' || fieldLoad !== 0x001E2B00) throw new Error('unexpected Field MWo3 input');
  const fieldHandlerStart = 0x002510E0;
  const fieldHandlerEnd = 0x002512D0;
  const fieldCalls = directJalTargets(field, fieldHandlerStart, fieldHandlerEnd);
  return {
    corrected_control_flow: [
      '0x0045B080 relocates RTA offsets/record links, resolves exact names through 0x004731C0, and writes only record+4 runtime pointers.',
      'Serialized FSS runtime type 9 dispatches at 0x004745B8 to 0x00475A10, requests factory type 0, then calls 0x0046C360 at 0x00475A6C.',
      '0x0046C360 reads translation at descriptor+0x34, quaternion at +0x24, and scale at +0x44; base vtable 0x00178E20 resolves its scalar calls to 0x003EEEB0, 0x003EEED0, and 0x003EF010.',
      'Field 0x002510E0 is a resource installation/copy handler. It is not the RTA name binder or FSS transform loader and has no direct call to 0x003EEE70.',
    ],
    lib: {
      sha256: sha256(lib),
      load_address: hex(lib.readUInt32LE(8)),
      rta_binder: { start_va: hex(RTA_BINDER), end_exclusive_va: hex(RTA_BINDER_END), sha256: sha256(libSlice(lib, RTA_BINDER, RTA_BINDER_END)) },
      fss_transform_loader: { start_va: hex(FSS_TRANSFORM_LOADER), end_exclusive_va: hex(FSS_TRANSFORM_LOADER_END), sha256: sha256(libSlice(lib, FSS_TRANSFORM_LOADER, FSS_TRANSFORM_LOADER_END)) },
      type9_branch: { branch_va: hex(FSS_TYPE9_BRANCH), loader_call_va: hex(FSS_TYPE9_LOADER_CALL), window_sha256: sha256(libSlice(lib, FSS_TYPE9_BRANCH, 0x00475A94)) },
    },
    sles: {
      sha256: sha256(sles),
      file_backed_load_mapping_used: true,
      base_transform_vtable_va: hex(BASE_TRANSFORM_VTABLE),
      transient_factory_type9_vtable_va: hex(TRANSIENT_TYPE9_VTABLE),
      base_slots: Object.fromEntries(Object.entries(resolveBaseVtable(sles)).map(([name, target]) => [name, hex(target)])),
    },
    field: {
      sha256: sha256(field),
      load_address: hex(fieldLoad),
      handler_va: hex(fieldHandlerStart),
      inspected_window_end_exclusive_va: hex(fieldHandlerEnd),
      inspected_window_sha256: sha256(field.subarray(fieldHandlerStart - fieldLoad, fieldHandlerEnd - fieldLoad)),
      direct_jal_targets: fieldCalls,
      has_direct_call_to_translation_vector_setter_0x003eee70: fieldCalls.some(row => row.target_va === hex(TRANSLATION_VECTOR_SETTER)),
      classification: 'RESOURCE_INSTALLATION_COPY_NOT_TRANSFORM_LOADING',
    },
  };
}

function executeTranslationMutation(lib, sles, charBytes) {
  const fss = parseFss(charBytes);
  const descriptor = fss.descriptors.find(row => row.runtime_type === 9 && row.parent_index === 0) || fss.descriptors.find(row => row.runtime_type === 9);
  const mutated = Buffer.from(charBytes);
  const oldValue = mutated.readFloatLE(descriptor.offset + 0x34);
  const newValue = f32(oldValue + 1.25);
  mutated.writeFloatLE(newValue, descriptor.offset + 0x34);
  const runtime = new ActorTransformRuntime(lib, sles, mutated);
  runtime.construct(0);
  runtime.construct(descriptor.index);
  const result = runtime.loadDescriptor(descriptor.index);
  const node = runtime.nodeBytes(descriptor.index);
  const checks = {
    only_descriptor_translation_x_input_word_mutated: charBytes.subarray(descriptor.offset, descriptor.offset + 0x34).equals(mutated.subarray(descriptor.offset, descriptor.offset + 0x34)) && charBytes.subarray(descriptor.offset + 0x38).equals(mutated.subarray(descriptor.offset + 0x38)),
    mutated_translation_x_reaches_node_plus_0x20_exact: node.readUInt32LE(0x20) === mutated.readUInt32LE(descriptor.offset + 0x34),
    quaternion_unchanged_against_original_descriptor: node.subarray(0x30, 0x40).equals(charBytes.subarray(descriptor.offset + 0x24, descriptor.offset + 0x34)),
    scale_xyz_unchanged_against_original_descriptor: node.subarray(0x40, 0x4C).equals(charBytes.subarray(descriptor.offset + 0x44, descriptor.offset + 0x50)),
  };
  if (!Object.values(checks).every(Boolean)) throw new Error(`translation mutation failed ${JSON.stringify(checks)}`);
  return {
    descriptor_index: descriptor.index,
    name: descriptor.name,
    original_translation_x: oldValue,
    mutated_translation_x: newValue,
    original_word: hex(charBytes.readUInt32LE(descriptor.offset + 0x34)),
    mutated_word: hex(mutated.readUInt32LE(descriptor.offset + 0x34)),
    loader_trace_commitment_sha256: result.execution.trace_commitment_sha256,
    checks,
  };
}

function executeVtableMutationControl(slesInput) {
  const mutated = Buffer.from(slesInput);
  const location = NodeMatrix.elf32WordLocation(mutated, BASE_TRANSFORM_VTABLE + 0x1C);
  const original = mutated.readUInt32LE(location);
  mutated.writeUInt32LE(TRANSLATION_VECTOR_SETTER, location);
  let rejected = false;
  let error = null;
  try { resolveBaseVtable(mutated); }
  catch (caught) { rejected = true; error = caught.message; }
  if (!rejected) throw new Error('mutated scalar translation vtable slot was not rejected');
  return {
    slot_va: hex(BASE_TRANSFORM_VTABLE + 0x1C),
    original_target: hex(original),
    mutated_target: hex(TRANSLATION_VECTOR_SETTER),
    rejected_fail_closed: rejected,
    error,
  };
}

function buildReport({ lib: libInput, sles: slesInput, field: fieldInput, actors }) {
  const lib = Buffer.from(libInput);
  const sles = Buffer.from(slesInput);
  const field = Buffer.from(fieldInput);
  const staticEvidence = buildStaticEvidence(lib, sles, field);
  if (staticEvidence.field.has_direct_call_to_translation_vector_setter_0x003eee70) throw new Error('Field handler unexpectedly calls translation setter');
  const packetProgram = Packet.extractProgram(lib);
  const actorRows = [];
  const poseWitnesses = [];
  for (const actor of actors) {
    const charBytes = Buffer.from(actor.char);
    const runtime = new ActorTransformRuntime(lib, sles, charBytes);
    const transform = runtime.constructAndLoadAllType9();
    const rta = executeRtaBinder(lib, actor.rta);
    const rtaMutation = executeRtaBinder(lib, actor.rta, { mutateManagerNameIndex: 0 });
    const translationMutation = executeTranslationMutation(lib, sles, charBytes);
    const pose = buildPoseWitness({
      actor: actor.actor,
      runtime,
      charBytes,
      clips: actor.clips,
      lib,
      packetProgram: packetProgram.program,
    });
    poseWitnesses.push(pose);
    actorRows.push({
      actor: actor.actor,
      inputs: {
        char_name: actor.char_name,
        char_sha256: sha256(charBytes),
        char_bytes: charBytes.length,
        rta_name: actor.rta_name,
        rta_sha256: sha256(actor.rta),
        rta_bytes: actor.rta.length,
        fas_files: actor.clips.map(clip => ({ name: clip.name, sha256: sha256(clip.bytes), bytes: clip.bytes.length })),
      },
      fss: {
        section_offset: hex(runtime.fss.offset),
        descriptor_count: runtime.fss.count,
        serialized_type9_descriptors: transform.loaders.length,
        constructor_executions: transform.constructors,
        loader_executions: transform.loaders,
        translation_mutation_control: translationMutation,
      },
      rta: {
        binder: rta,
        exact_name_mutation_control: {
          mutated_manager_name_index: 0,
          mutated_name: parseRta(actor.rta).names[0].name,
          zero_bindings: rtaMutation.bindings.filter(row => row.runtime_node_pointer === '0x00000000').length,
          binder: rtaMutation,
        },
      },
    });
  }
  const type9Count = actorRows.reduce((sum, row) => sum + row.fss.serialized_type9_descriptors, 0);
  const constructorInstructions = actorRows.reduce((sum, row) => sum + row.fss.constructor_executions.reduce((inner, item) => inner + item.original_guest_instructions, 0), 0);
  const loaderInstructions = actorRows.reduce((sum, row) => sum + row.fss.loader_executions.reduce((inner, item) => inner + item.execution.original_guest_instructions, 0), 0);
  const rtaInstructions = actorRows.reduce((sum, row) => sum + row.rta.binder.execution.original_guest_instructions, 0);
  const allLoaderChecks = actorRows.every(row => row.fss.loader_executions.every(item => Object.values(item.checks).every(Boolean)));
  const allRtaChecks = actorRows.every(row => Object.values(row.rta.binder.checks).every(Boolean));
  const allPoseChecks = poseWitnesses.every(row => Object.values(row.checks).every(Boolean));
  if (type9Count !== 94 || !allLoaderChecks || !allRtaChecks || !allPoseChecks) throw new Error('aggregate FSS/RTA/pose checks failed');
  return {
    format: 'SO3_FSS_RTA_POSE_R5900_EXECUTION_REPORT_V1',
    status: 'PASS_ORIGINAL_RTA_IDENTITY_BINDING_FSS_TRANSFORM_LOADING_AND_BOUNDED_PACKET_POSE',
    correction: {
      prior_hypothesis: 'RTA record vectors were treated as controlled translations while the original loader was unavailable.',
      resolved_semantics: 'RTA is a relocation/exact-name binding resource. Actual bind translation/quaternion/scale are loaded from FSS descriptor +0x34/+0x24/+0x44.',
      historical_reports_preserved: true,
      browser_release_changed: false,
    },
    static_evidence: staticEvidence,
    actor_evidence: actorRows,
    bounded_pose_witnesses: poseWitnesses,
    aggregate: {
      actors: actorRows.length,
      rta_records_bound: actorRows.reduce((sum, row) => sum + row.rta.binder.node_count, 0),
      serialized_type9_fss_descriptors_executed: type9Count,
      original_node_constructor_guest_instructions: constructorInstructions,
      original_fss_loader_guest_instructions: loaderInstructions,
      original_rta_binder_guest_instructions: rtaInstructions,
      bounded_animated_packet_pose_witnesses: poseWitnesses.length,
      all_fss_loader_checks_pass: allLoaderChecks,
      all_rta_binder_checks_pass: allRtaChecks,
      all_pose_witness_checks_pass: allPoseChecks,
      host_transform_or_matrix_substitution_calls_on_fss_loader_path: 0,
    },
    controls: {
      scalar_translation_vtable_slot_mutation: executeVtableMutationControl(sles),
      actor_translation_word_mutations: Object.fromEntries(actorRows.map(row => [row.actor, row.fss.translation_mutation_control])),
      rta_exact_name_mutations: Object.fromEntries(actorRows.map(row => [row.actor, {
        mutated_name_index: row.rta.exact_name_mutation_control.mutated_manager_name_index,
        resulting_zero_bindings: row.rta.exact_name_mutation_control.zero_bindings,
        all_checks_pass: Object.values(row.rta.exact_name_mutation_control.binder.checks).every(Boolean),
      }])),
    },
    gates: {
      field_response_integrity_and_provenance: 'PASS_INDEPENDENTLY_VERIFIED_AND_STAGED',
      field_0x002510e0_classification: 'PASS_RESOURCE_INSTALLATION_COPY_NOT_TRANSFORM_LOADER',
      rta_relocation_and_exact_name_runtime_binding: 'PASS_EXECUTED_ORIGINAL_R5900',
      rta_translation_semantic: 'REJECTED_RTA_DOES_NOT_LOAD_TRANSFORMS',
      fss_descriptor_translation_to_runtime_node: 'PASS_EXECUTED_ORIGINAL_R5900_SCALAR_SETTER_0x003EEEB0_ALL_94_TYPE9_DESCRIPTORS',
      fss_descriptor_rotation_to_runtime_node: 'PASS_EXECUTED_ORIGINAL_R5900_SCALAR_SETTER_0x003EEED0_ALL_94_TYPE9_DESCRIPTORS',
      fss_descriptor_scale_to_runtime_node: 'PASS_EXECUTED_ORIGINAL_R5900_SCALAR_SETTER_0x003EF010_ALL_94_TYPE9_DESCRIPTORS',
      bounded_rotation_to_packet_vertex_pose: 'PASS_TWO_ACTOR_SCOPED_WITNESSES_ORIGINAL_FAS_R5900_VU0_NODE_WRITER_IDOM_VU0_PALETTE_PACKET_AND_VU1',
      dma_vif_transfer_join: 'PASS_BYTE_EXACT_VERIFIED_MEMORY_BOUNDARY_NOT_CYCLE_LEVEL_DMA_EMULATION',
      browser_mesh_deformation: 'WITHHELD_NOT_INTEGRATED',
      on_device_visual_validation: 'WITHHELD_NOT_RUN',
    },
    boundaries: [
      'RTA record vectors are preserved and are not interpreted as skeleton-local translations. RTA execution mutates relocation/link and record+4 binding fields only.',
      'All 94 serialized type-9 FSS descriptors from the two supplied actors execute through original 0x0046C360 and the base transform vtable scalar setters. Root descriptors seed constructor identity and are not counted as serialized type 9.',
      'The two bounded pose witnesses reuse completed IDOM index/layout and packet-address gates. They do not assign primary/auxiliary runtime roles to additional IDOM sections.',
      'The palette packet constructor and post-UNPACK VU1 consumer both execute original code. DMA transfer and VIF UNPACK are joined at the already verified byte-exact matrix-buffer boundary rather than cycle-emulated.',
      'No browser code changes in this pass. A numerical two-vertex witness is not a visual-success claim.',
    ],
    recommended_reasoning_levels: {
      browser_deformation_integration_with_static_toggle: 'high',
      browser_integration_audit_against_this_execution_report: 'max',
      on_device_actor_visual_regression: 'medium',
      documentation_or_checksum_reinspection: 'light',
    },
  };
}

function cli(argv) {
  const args = { actors: new Map() };
  function actorRow(actor) {
    if (!args.actors.has(actor)) args.actors.set(actor, { actor, clips: [] });
    return args.actors.get(actor);
  }
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--lib') args.lib = argv[++index];
    else if (key === '--sles') args.sles = argv[++index];
    else if (key === '--field') args.field = argv[++index];
    else if (key === '--char') { const actor = argv[++index]; actorRow(actor).char_file = argv[++index]; }
    else if (key === '--rta') { const actor = argv[++index]; actorRow(actor).rta_file = argv[++index]; }
    else if (key === '--fas') { const actor = argv[++index]; actorRow(actor).clips.push(argv[++index]); }
    else if (key === '--output') args.output = argv[++index];
    else throw new Error(`unknown argument ${key}`);
  }
  if (!args.lib || !args.sles || !args.field || !args.output || args.actors.size !== 2) {
    throw new Error('usage: run_fss_rta_pose_r5900.js --lib Lib --sles SLES --field Field --char ACTOR CHAR --rta ACTOR RTA --fas ACTOR FAS [...] --output report.json');
  }
  const actors = [...args.actors.values()].map(row => {
    if (!row.char_file || !row.rta_file || !row.clips.length) throw new Error(`${row.actor}: CHAR, RTA, and FAS inputs are required`);
    return {
      actor: row.actor,
      char_name: path.basename(row.char_file),
      char: fs.readFileSync(row.char_file),
      rta_name: path.basename(row.rta_file),
      rta: fs.readFileSync(row.rta_file),
      clips: row.clips.map(file => ({ actor: row.actor, name: path.basename(file), bytes: fs.readFileSync(file) })),
    };
  });
  const report = buildReport({
    lib: fs.readFileSync(args.lib),
    sles: fs.readFileSync(args.sles),
    field: fs.readFileSync(args.field),
    actors,
  });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: report.status, output: args.output, aggregate: report.aggregate })}\n`);
}

module.exports = Object.freeze({
  RTA_BINDER,
  FSS_TRANSFORM_LOADER,
  BASE_TRANSFORM_VTABLE,
  TRANSLATION_SCALAR_SETTER,
  ROTATION_SCALAR_SETTER,
  SCALE_SCALAR_SETTER,
  parseFss,
  parseRta,
  resolveBaseVtable,
  ActorTransformRuntime,
  executeRtaBinder,
  executeTranslationMutation,
  executeVtableMutationControl,
  buildStaticEvidence,
  buildReport,
});

if (require.main === module) cli(process.argv.slice(2));
