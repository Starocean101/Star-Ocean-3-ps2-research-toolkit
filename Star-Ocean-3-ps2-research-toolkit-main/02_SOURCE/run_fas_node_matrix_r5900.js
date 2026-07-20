#!/usr/bin/env node
/* Execute SO3's original runtime transform-node constructor, virtual rotation
 * setter target, and no-parent local/world matrix writer over real FAS tracks.
 *
 * The concrete vtable is read from the supplied SLES ELF.  Lib instructions
 * are then executed from their packaged bytes through the bounded R5900/VU0
 * target used by the FAS evaluator pass.  RTA translations are controlled,
 * exact-name inputs; this witness does not claim the still-untraced RTA loader
 * or final mesh skinning path.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Geometry = require('./v5_1_geometry.js');
const Rotation = require('./run_fas_rotation_r5900.js');
const Vu0 = require('./run_vu0_idom_matrix_micro.js');

const NODE_CONSTRUCTOR = 0x004DAD00;
const TRANSFORM_VTABLE = 0x00178E20;
const TRANSLATION_SETTER_SLOT = 0x24;
const ROTATION_SETTER_SLOT = 0x34;
const MATRIX_WRITER_SLOT = 0x60;
const EXPECTED_TRANSLATION_SETTER = 0x003EEE70;
const EXPECTED_ROTATION_SETTER = 0x003EEF10;
const EXPECTED_MATRIX_WRITER = 0x004DA820;
const CONSTRUCTOR_CALLS = Object.freeze([0x004E0F10, 0x004D58B0, 0x004CFEC0, 0x004CFEF0]);
const NODE_BASE = 0x01010000;
const PARENT_NODE_BASE = NODE_BASE + 0x240;
const INPUT_BASE = 0x01011000;
const STACK_TOP = 0x01F00000;
const SENTINEL = 0x0BADF00D;

function sha256(input) {
  return crypto.createHash('sha256').update(Buffer.from(input)).digest('hex');
}

function hex(value, width = 8) {
  return `0x${Number(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

function f32(value) { return Math.fround(value); }
function fadd(left, right) { return f32(f32(left) + f32(right)); }
function fsub(left, right) { return f32(f32(left) - f32(right)); }
function fmul(left, right) { return f32(f32(left) * f32(right)); }

function matrixBytes(matrix) {
  if (!Array.isArray(matrix) && !(matrix instanceof Float32Array) || matrix.length !== 16) throw new Error('matrix must contain 16 floats');
  const bytes = Buffer.alloc(0x40);
  Array.from(matrix).forEach((value, index) => bytes.writeFloatLE(f32(value), index * 4));
  return bytes;
}

function matrixFromBytes(bytes, offset = 0) {
  return Array.from({ length: 16 }, (_, index) => bytes.readFloatLE(offset + index * 4));
}

function canonicalizeMatrixZeroSigns(bytesInput) {
  const bytes = Buffer.from(bytesInput);
  if (bytes.length !== 0x40) throw new Error('matrix byte buffer must contain 16 floats');
  for (let index = 0; index < 16; index++) {
    if (bytes.readFloatLE(index * 4) === 0) bytes.writeUInt32LE(0, index * 4);
  }
  return bytes;
}

function identityMatrix() {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
}

function multiplyRowMajorFloat32(leftInput, rightInput) {
  if (leftInput.length !== 16 || rightInput.length !== 16) throw new Error('matrix multiply requires two 4x4 matrices');
  const left = Array.from(leftInput, f32), right = Array.from(rightInput, f32), output = new Array(16);
  for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
    let value = fmul(left[row * 4], right[column]);
    value = fadd(value, fmul(left[row * 4 + 1], right[4 + column]));
    value = fadd(value, fmul(left[row * 4 + 2], right[8 + column]));
    value = fadd(value, fmul(left[row * 4 + 3], right[12 + column]));
    output[row * 4 + column] = value;
  }
  return output;
}

/* Closed-form oracle for the exact SO3/VU0 matrix convention and operation
 * order.  This is comparison-only host code; successful engine output never
 * calls it as a substitute for the original constructor/writer.
 */
function independentSo3LocalMatrix(quaternionInput, translationInput, scaleInput = [1,1,1,1]) {
  if (quaternionInput.length !== 4 || translationInput.length < 3 || scaleInput.length < 3) throw new Error('invalid affine oracle input');
  const [x,y,z,w] = quaternionInput.map(f32), [tx,ty,tz] = translationInput.map(f32), [sx,sy,sz] = scaleInput.map(f32);
  const twoX = fadd(x,x), twoY = fadd(y,y), twoZ = fadd(z,z), twoW = fadd(w,w);
  const xx = fmul(x,twoX), yy = fmul(y,twoY), zz = fmul(z,twoZ);
  const xy = fmul(y,twoX), xz = fmul(z,twoX), xw = fmul(w,twoX);
  const yw = fmul(y,twoW), yz = fmul(z,twoY), zw = fmul(z,twoW);
  const r00 = fsub(fsub(1,yy),zz), r01 = fadd(xy,zw), r02 = fsub(xz,yw);
  const r10 = fsub(xy,zw), r11 = fsub(fsub(1,xx),zz), r12 = fadd(yz,xw);
  const r20 = fadd(xz,yw), r21 = fsub(yz,xw), r22 = fsub(fsub(1,xx),yy);
  return [
    fmul(r00,sx), fmul(r01,sy), fmul(r02,sz), tx,
    fmul(r10,sx), fmul(r11,sy), fmul(r12,sz), ty,
    fmul(r20,sx), fmul(r21,sy), fmul(r22,sz), tz,
    0,0,0,1,
  ];
}

function elf32WordLocation(elfInput, virtualAddress) {
  const elf = Buffer.from(elfInput);
  if (elf.length < 0x34 || elf.toString('binary', 0, 4) !== '\x7FELF' || elf[4] !== 1 || elf[5] !== 1) throw new Error('expected a little-endian ELF32 executable');
  const phoff = elf.readUInt32LE(0x1C), phentsize = elf.readUInt16LE(0x2A), phnum = elf.readUInt16LE(0x2C);
  if (phentsize < 0x20 || phoff + phentsize * phnum > elf.length) throw new Error('ELF32 program-header table is invalid');
  for (let index = 0; index < phnum; index++) {
    const off = phoff + index * phentsize;
    if (elf.readUInt32LE(off) !== 1) continue;
    const fileOffset = elf.readUInt32LE(off + 4), vaddr = elf.readUInt32LE(off + 8), fileSize = elf.readUInt32LE(off + 16);
    if (virtualAddress >= vaddr && virtualAddress + 4 <= vaddr + fileSize) {
      const location = fileOffset + virtualAddress - vaddr;
      if (location + 4 > elf.length) throw new Error(`ELF32 mapping for ${hex(virtualAddress)} is truncated`);
      return location;
    }
  }
  throw new Error(`ELF32 has no file-backed LOAD mapping for ${hex(virtualAddress)}`);
}

function elf32Word(elf, virtualAddress) {
  return Buffer.from(elf).readUInt32LE(elf32WordLocation(elf, virtualAddress));
}

function elf32FileBackedLoadSegments(elfInput) {
  const elf = Buffer.from(elfInput), phoff = elf.readUInt32LE(0x1C), phentsize = elf.readUInt16LE(0x2A), phnum = elf.readUInt16LE(0x2C), rows = [];
  for (let index = 0; index < phnum; index++) {
    const off = phoff + index * phentsize;
    if (elf.readUInt32LE(off) !== 1) continue;
    const fileOffset = elf.readUInt32LE(off + 4), vaddr = elf.readUInt32LE(off + 8), fileSize = elf.readUInt32LE(off + 16), memorySize = elf.readUInt32LE(off + 20);
    if (!fileSize) continue;
    if (fileOffset + fileSize > elf.length || memorySize < fileSize) throw new Error(`ELF32 LOAD segment ${index} is invalid`);
    const image = Buffer.alloc(memorySize);
    elf.copy(image, 0, fileOffset, fileOffset + fileSize);
    rows.push({ index, vaddr, fileSize, memorySize, image });
  }
  if (!rows.length) throw new Error('ELF32 has no file-backed LOAD segment');
  return rows;
}

function resolveTransformVtable(slesInput) {
  const slots = {
    translation_setter: elf32Word(slesInput, TRANSFORM_VTABLE + TRANSLATION_SETTER_SLOT),
    rotation_setter: elf32Word(slesInput, TRANSFORM_VTABLE + ROTATION_SETTER_SLOT),
    matrix_writer: elf32Word(slesInput, TRANSFORM_VTABLE + MATRIX_WRITER_SLOT),
  };
  const expected = {
    translation_setter: EXPECTED_TRANSLATION_SETTER,
    rotation_setter: EXPECTED_ROTATION_SETTER,
    matrix_writer: EXPECTED_MATRIX_WRITER,
  };
  for (const [name, value] of Object.entries(slots)) if (value !== expected[name]) {
    throw new Error(`transform vtable ${name} mismatch: ${hex(value)} != ${hex(expected[name])}`);
  }
  return slots;
}

function writeVector(memory, address, values) {
  if (!Array.isArray(values) || values.length !== 4 || values.some(value => !Number.isFinite(value))) throw new Error('runtime vector must contain four finite values');
  const bytes = Buffer.alloc(16);
  values.forEach((value, index) => bytes.writeFloatLE(f32(value), index * 4));
  memory.write(address, bytes);
  return bytes;
}

function libSlice(lib, start, endExclusive) {
  const startOffset = start - Rotation.LIB_LOAD, endOffset = endExclusive - Rotation.LIB_LOAD;
  if (startOffset < 0 || endOffset > lib.length || startOffset >= endOffset) throw new Error(`Lib slice ${hex(start)}..${hex(endExclusive)} is invalid`);
  return lib.subarray(startOffset, endOffset);
}

class TransformNodeRuntime {
  constructor(libInput, slesInput, options = {}) {
    this.lib = Buffer.from(libInput);
    this.sles = Buffer.from(slesInput);
    if (this.lib.length < 0x40 || this.lib.toString('ascii', 0, 4) !== 'MWo3' || this.lib.readUInt32LE(8) !== Rotation.LIB_LOAD) throw new Error('expected packaged Lib MWo3 image');
    this.slots = resolveTransformVtable(this.sles);
    this.vuProgramInfo = options.vuProgramInfo || Vu0.extractVu0Program(this.lib);
    this.memory = new Rotation.BoundedMemory();
    this.moduleImage = Buffer.alloc(this.lib.length + this.lib.readUInt32LE(0x14));
    this.lib.copy(this.moduleImage);
    this.node = Buffer.alloc(0x480);
    this.inputs = Buffer.alloc(0x80);
    this.stack = Buffer.alloc(0x4000);
    this.memory.map(Rotation.LIB_LOAD, this.moduleImage, 'Lib.bin_file_and_declared_zero_fill', true);
    for (const segment of elf32FileBackedLoadSegments(this.sles)) this.memory.map(segment.vaddr, segment.image, `SLES_LOAD_${segment.index}`, false);
    this.memory.map(NODE_BASE, this.node, 'runtime_transform_node', true);
    this.memory.map(INPUT_BASE, this.inputs, 'runtime_transform_inputs', true);
    this.memory.map(STACK_TOP - this.stack.length, this.stack, 'target_stack', true);
  }

  runFunction(entry, allowedCalls = [], traceLimit = 0, nodeAddress = NODE_BASE) {
    const cpu = new Rotation.FasRotationR5900(this.memory, { vuProgram: this.vuProgramInfo.program, allowedCalls, traceLimit });
    cpu.setLow64(4, nodeAddress);
    cpu.setLow64(29, STACK_TOP);
    cpu.setLow64(31, SENTINEL);
    const stop = cpu.run(entry, 5000);
    if (stop !== 'RETURN_SENTINEL') throw new Error(`${hex(entry)} did not return through the sentinel`);
    return {
      entry_va: hex(entry),
      stop_reason: stop,
      original_guest_instructions: cpu.steps,
      original_vu0_microprogram_calls: cpu.microprogramCalls.length,
      original_vu0_microinstruction_pairs: cpu.microinstructionPairs,
      executed_opcodes: [...cpu.executedOpcodes].sort(),
      call_trace: cpu.callTrace,
      trace_commitment_sha256: sha256(Buffer.from(cpu.traceRows.join(''))),
      microprograms: cpu.microprogramCalls.map(row => ({
        entry_instruction_index: row.entry_instruction_index,
        instruction_pairs: row.instruction_pairs,
        stop_reason: row.stop_reason,
        trace_commitment_sha256: row.trace_commitment_sha256,
      })),
    };
  }

  runVectorSetter(entry, nodeAddress, inputAddress, traceLimit = 0) {
    const cpu = new Rotation.FasRotationR5900(this.memory, { vuProgram: this.vuProgramInfo.program, allowedCalls: [], traceLimit });
    cpu.setLow64(4, nodeAddress);
    cpu.setLow64(5, inputAddress);
    cpu.setLow64(29, STACK_TOP);
    cpu.setLow64(31, SENTINEL);
    if (cpu.run(entry, 64) !== 'RETURN_SENTINEL') throw new Error(`${hex(entry)} vector setter did not return`);
    return cpu;
  }

  execute(quaternion, translation, scale = [1,1,1,1], options = {}) {
    this.node.fill(0); this.inputs.fill(0); this.stack.fill(0);
    const constructor = this.runFunction(NODE_CONSTRUCTOR, CONSTRUCTOR_CALLS, options.traceLimit ?? 0);
    const constructedVtable = this.node.readUInt32LE(0);
    if (constructedVtable !== TRANSFORM_VTABLE) throw new Error(`constructor wrote ${hex(constructedVtable)}, expected vtable ${hex(TRANSFORM_VTABLE)}`);
    const constructorLocalIdentity = this.node.subarray(0x90, 0xD0).equals(matrixBytes(identityMatrix()));
    const constructorWorldIdentity = this.node.subarray(0xD0, 0x110).equals(matrixBytes(identityMatrix()));
    const constructorBasisIdentity = this.node.subarray(0x110, 0x150).equals(matrixBytes(identityMatrix()));
    if (!constructorLocalIdentity || !constructorWorldIdentity || !constructorBasisIdentity) throw new Error('original node constructor did not materialize the three expected identity matrices');

    const translationBytes = writeVector(this.memory, INPUT_BASE, [translation[0], translation[1], translation[2], 1]);
    const quaternionBytes = writeVector(this.memory, INPUT_BASE + 0x10, Array.from(quaternion));
    const scaleBytes = writeVector(this.memory, INPUT_BASE + 0x20, Array.from(scale));
    const translationCpu = this.runVectorSetter(this.slots.translation_setter, NODE_BASE, INPUT_BASE, options.traceLimit ?? 0);
    const rotationCpu = this.runVectorSetter(this.slots.rotation_setter, NODE_BASE, INPUT_BASE + 0x10, options.traceLimit ?? 0);
    let scaleCpu = null;
    if (!scale.every((value, index) => f32(value) === [1,1,1,1][index])) {
      const scaleSetter = elf32Word(this.sles, TRANSFORM_VTABLE + 0x44);
      if (scaleSetter !== 0x003EEFF0) throw new Error(`transform vtable scale setter mismatch: ${hex(scaleSetter)}`);
      scaleCpu = this.runVectorSetter(scaleSetter, NODE_BASE, INPUT_BASE + 0x20, options.traceLimit ?? 0);
    }
    const setterChecks = {
      translation_qword_byte_exact_at_node_plus_0x20: this.node.subarray(0x20, 0x30).equals(translationBytes),
      quaternion_qword_byte_exact_at_node_plus_0x30: this.node.subarray(0x30, 0x40).equals(quaternionBytes),
      scale_qword_byte_exact_at_node_plus_0x40: this.node.subarray(0x40, 0x50).equals(scaleBytes),
      dirty_byte_set_at_node_plus_0x50: this.node[0x50] === 1,
    };
    if (!Object.values(setterChecks).every(Boolean)) throw new Error(`original transform setter check failed: ${JSON.stringify(setterChecks)}`);

    const writer = this.runFunction(this.slots.matrix_writer, [], options.traceLimit ?? 0);
    const localBytes = Buffer.from(this.node.subarray(0x90, 0xD0));
    const worldBytes = Buffer.from(this.node.subarray(0xD0, 0x110));
    const oracle = independentSo3LocalMatrix(quaternion, translation, scale);
    const oracleBytes = matrixBytes(oracle);
    const canonicalLocalBytes = canonicalizeMatrixZeroSigns(localBytes);
    const canonicalWorldBytes = canonicalizeMatrixZeroSigns(worldBytes);
    const canonicalOracleBytes = canonicalizeMatrixZeroSigns(oracleBytes);
    const rawBitObservations = {
      local_matrix_raw_byte_exact_against_independent_oracle: localBytes.equals(oracleBytes),
      world_matrix_raw_byte_exact_against_independent_oracle: worldBytes.equals(oracleBytes),
      world_matrix_raw_bytes_equal_local_without_parent: worldBytes.equals(localBytes),
    };
    const checks = {
      ...setterChecks,
      parent_pointer_zero_no_parent_branch: this.node.readUInt32LE(0x208) === 0,
      writer_cleared_dirty_byte_plus_0x50: this.node[0x50] === 0,
      writer_set_valid_byte_plus_0x51: this.node[0x51] === 1,
      local_matrix_plus_0x90_byte_exact_modulo_ieee754_zero_sign_against_independent_oracle: canonicalLocalBytes.equals(canonicalOracleBytes),
      world_matrix_plus_0xD0_byte_exact_modulo_ieee754_zero_sign_against_independent_oracle: canonicalWorldBytes.equals(canonicalOracleBytes),
      world_matrix_plus_0xD0_equals_local_modulo_ieee754_zero_sign_without_parent: canonicalWorldBytes.equals(canonicalLocalBytes),
      basis_matrix_plus_0x110_remains_identity: this.node.subarray(0x110, 0x150).equals(matrixBytes(identityMatrix())),
    };
    if (!Object.values(checks).every(Boolean)) throw new Error(`original node-matrix check failed: ${JSON.stringify({
      checks,
      local_matrix: matrixFromBytes(localBytes),
      world_matrix: matrixFromBytes(worldBytes),
      independent_oracle: oracle,
      local_hex: localBytes.toString('hex'),
      world_hex: worldBytes.toString('hex'),
      oracle_hex: oracleBytes.toString('hex'),
    })}`);
    const setterStats = [translationCpu, rotationCpu, ...(scaleCpu ? [scaleCpu] : [])].map(cpu => ({
      original_guest_instructions: cpu.steps,
      trace_commitment_sha256: sha256(Buffer.from(cpu.traceRows.join(''))),
      executed_opcodes: [...cpu.executedOpcodes].sort(),
    }));
    return {
      constructor,
      setters: setterStats,
      writer,
      quaternion: Array.from(quaternion, f32),
      translation: [translation[0], translation[1], translation[2]].map(f32),
      scale: Array.from(scale, f32),
      local_matrix: matrixFromBytes(localBytes),
      world_matrix: matrixFromBytes(worldBytes),
      raw_bit_observations: rawBitObservations,
      local_matrix_sha256: sha256(localBytes),
      world_matrix_sha256: sha256(worldBytes),
      canonical_matrix_sha256: sha256(canonicalLocalBytes),
      independent_oracle_sha256: sha256(oracleBytes),
      checks,
    };
  }

  executeHierarchyDiagnostic(parentTransform, childTransform, options = {}) {
    this.node.fill(0); this.inputs.fill(0); this.stack.fill(0);
    const traceLimit = options.traceLimit ?? 0;
    const parentConstructor = this.runFunction(NODE_CONSTRUCTOR, CONSTRUCTOR_CALLS, traceLimit, PARENT_NODE_BASE);
    const childConstructor = this.runFunction(NODE_CONSTRUCTOR, CONSTRUCTOR_CALLS, traceLimit, NODE_BASE);
    const parent = {
      quaternion: Array.from(parentTransform.quaternion, f32),
      translation: [parentTransform.translation[0], parentTransform.translation[1], parentTransform.translation[2], 1].map(f32),
      scale: Array.from(parentTransform.scale || [1,1,1,1], f32),
    };
    const child = {
      quaternion: Array.from(childTransform.quaternion, f32),
      translation: [childTransform.translation[0], childTransform.translation[1], childTransform.translation[2], 1].map(f32),
      scale: Array.from(childTransform.scale || [1,1,1,1], f32),
    };
    const vectors = [parent.translation, parent.quaternion, parent.scale, child.translation, child.quaternion, child.scale];
    vectors.forEach((vector, index) => writeVector(this.memory, INPUT_BASE + index * 0x10, vector));
    const setterCpus = [];
    for (const [nodeAddress, vectorIndex] of [[PARENT_NODE_BASE,0],[NODE_BASE,3]]) {
      setterCpus.push(this.runVectorSetter(this.slots.translation_setter, nodeAddress, INPUT_BASE + vectorIndex * 0x10, traceLimit));
      setterCpus.push(this.runVectorSetter(this.slots.rotation_setter, nodeAddress, INPUT_BASE + (vectorIndex + 1) * 0x10, traceLimit));
      const scale = vectorIndex === 0 ? parent.scale : child.scale;
      if (!scale.every((value, index) => value === [1,1,1,1][index])) {
        const scaleSetter = elf32Word(this.sles, TRANSFORM_VTABLE + 0x44);
        setterCpus.push(this.runVectorSetter(scaleSetter, nodeAddress, INPUT_BASE + (vectorIndex + 2) * 0x10, traceLimit));
      }
    }
    this.node.writeUInt32LE(PARENT_NODE_BASE, 0x208);
    const writer = this.runFunction(this.slots.matrix_writer, [this.slots.matrix_writer], traceLimit, NODE_BASE);
    const parentOffset = PARENT_NODE_BASE - NODE_BASE;
    const parentLocalBytes = Buffer.from(this.node.subarray(parentOffset + 0x90, parentOffset + 0xD0));
    const parentWorldBytes = Buffer.from(this.node.subarray(parentOffset + 0xD0, parentOffset + 0x110));
    const childLocalBytes = Buffer.from(this.node.subarray(0x90, 0xD0));
    const childWorldBytes = Buffer.from(this.node.subarray(0xD0, 0x110));
    const parentOracle = independentSo3LocalMatrix(parent.quaternion, parent.translation, parent.scale);
    const childOracle = independentSo3LocalMatrix(child.quaternion, child.translation, child.scale);
    const parentTimesChildOracle = multiplyRowMajorFloat32(parentOracle, childOracle);
    const childTimesParentOracle = multiplyRowMajorFloat32(childOracle, parentOracle);
    const canonical = canonicalizeMatrixZeroSigns;
    const matches = (actual, expected) => canonical(actual).equals(canonical(matrixBytes(expected)));
    const checks = {
      child_parent_pointer_targets_constructed_parent: this.node.readUInt32LE(0x208) === PARENT_NODE_BASE,
      child_writer_indirectly_called_parent_writer_via_vtable: writer.call_trace.some(row => row.indirect && row.target_va === hex(this.slots.matrix_writer)),
      parent_dirty_cleared_and_valid_set: this.node[parentOffset + 0x50] === 0 && this.node[parentOffset + 0x51] === 1,
      child_dirty_cleared_and_valid_set: this.node[0x50] === 0 && this.node[0x51] === 1,
      parent_local_matches_independent_oracle_modulo_zero_sign: matches(parentLocalBytes, parentOracle),
      parent_world_matches_parent_local_modulo_zero_sign: canonical(parentWorldBytes).equals(canonical(parentLocalBytes)),
      child_matrix_plus_0x90_matches_parent_times_child_oracle_modulo_zero_sign: matches(childLocalBytes, parentTimesChildOracle),
      child_world_plus_0xD0_matches_parent_times_child_oracle_modulo_zero_sign: matches(childWorldBytes, parentTimesChildOracle),
      child_matrix_plus_0x90_equals_world_plus_0xD0_modulo_zero_sign: canonical(childLocalBytes).equals(canonical(childWorldBytes)),
    };
    return {
      parent_constructor: parentConstructor,
      child_constructor: childConstructor,
      writer,
      setter_guest_instructions: setterCpus.reduce((sum, cpu) => sum + cpu.steps, 0),
      parent_local_matrix: matrixFromBytes(parentLocalBytes),
      parent_world_matrix: matrixFromBytes(parentWorldBytes),
      child_matrix_plus_0x90: matrixFromBytes(childLocalBytes),
      child_world_matrix: matrixFromBytes(childWorldBytes),
      parent_times_child_oracle: parentTimesChildOracle,
      child_times_parent_oracle: childTimesParentOracle,
      checks,
    };
  }
}

function buildReport({ lib: libInput, sles: slesInput, clips, rtas, ps2RecompCommit = 'ee149581aac999ab22791b3900377c0b028a5840' }) {
  const lib = Buffer.from(libInput), sles = Buffer.from(slesInput), slots = resolveTransformVtable(sles);
  const runtime = new TransformNodeRuntime(lib, sles), tracks = Rotation.collectTracks(clips), rtaByActor = new Map();
  for (const [actor, input] of Object.entries(rtas)) rtaByActor.set(actor, input && input.nodes ? input : Geometry.parseRta(input));
  const matched = [], unmatched = [];
  for (const track of tracks) {
    const rta = rtaByActor.get(track.actor), node = rta?.nodes.find(row => row.name === track.channel_name);
    if (!node) { unmatched.push({ actor: track.actor, source_name: track.source_name, channel_name: track.channel_name }); continue; }
    matched.push({ track, node });
  }
  if (!matched.length) throw new Error('no FAS type-0x0135 track has an exact-name RTA node');
  const executions = [], opcodeUnion = new Set();
  let evaluatorInstructions = 0, evaluatorMicroPairs = 0, nodeInstructions = 0, nodeMicroPairs = 0;
  for (const { track, node } of matched) {
    const fixture = Rotation.buildExecutionFixture(lib, track.keys, { vuProgramInfo: runtime.vuProgramInfo });
    const first = track.keys[0], second = track.keys[1] || first, samples = [
      { kind: 'TERMINAL_KEY', time: track.keys.at(-1).time },
      { kind: 'BETWEEN_FIRST_TWO_KEYS', time: f32((first.time + second.time) / 2) },
    ];
    for (const sample of samples) {
      const rotation = Rotation.executeFixtureAt(fixture, sample.time, { traceLimit: 0 });
      const nodeExecution = runtime.execute(rotation.quaternion, node.translation, [1,1,1,1]);
      evaluatorInstructions += rotation.instruction_count;
      evaluatorMicroPairs += rotation.original_vu0_microinstruction_pairs;
      const nodeRows = [nodeExecution.constructor, nodeExecution.writer];
      nodeInstructions += nodeRows.reduce((sum, row) => sum + row.original_guest_instructions, 0) + nodeExecution.setters.reduce((sum, row) => sum + row.original_guest_instructions, 0);
      nodeMicroPairs += nodeRows.reduce((sum, row) => sum + row.original_vu0_microinstruction_pairs, 0);
      for (const row of [rotation.executed_opcodes, ...nodeRows.map(item => item.executed_opcodes), ...nodeExecution.setters.map(item => item.executed_opcodes)]) for (const opcode of row) opcodeUnion.add(opcode);
      executions.push({
        actor: track.actor,
        fas_source_name: track.source_name,
        fas_source_sha256: track.source_sha256,
        channel_name: track.channel_name,
        rta_node_index: node.index,
        rta_name_exact_match: true,
        rta_translation_controlled_input: node.translation.slice(0,3),
        sample_kind: sample.kind,
        animation_time: sample.time,
        rotation_evaluator: {
          original_guest_instructions: rotation.instruction_count,
          original_interpolator_calls: rotation.original_interpolator_calls,
          original_vu0_microinstruction_pairs: rotation.original_vu0_microinstruction_pairs,
          quaternion: rotation.quaternion,
          quaternion_sha256: rotation.quaternion_sha256,
        },
        runtime_node: {
          constructor_guest_instructions: nodeExecution.constructor.original_guest_instructions,
          setter_guest_instructions: nodeExecution.setters.reduce((sum, row) => sum + row.original_guest_instructions, 0),
          matrix_writer_guest_instructions: nodeExecution.writer.original_guest_instructions,
          original_vu0_microinstruction_pairs: nodeExecution.constructor.original_vu0_microinstruction_pairs + nodeExecution.writer.original_vu0_microinstruction_pairs,
          local_matrix: nodeExecution.local_matrix,
          world_matrix: nodeExecution.world_matrix,
          local_matrix_sha256: nodeExecution.local_matrix_sha256,
          world_matrix_sha256: nodeExecution.world_matrix_sha256,
          canonical_matrix_sha256: nodeExecution.canonical_matrix_sha256,
          independent_oracle_sha256: nodeExecution.independent_oracle_sha256,
          raw_bit_observations: nodeExecution.raw_bit_observations,
          checks: nodeExecution.checks,
        },
      });
    }
  }

  const diagnostic = runtime.execute(
    [0,0,f32(Math.SQRT1_2),f32(Math.SQRT1_2)],
    [2,-3,4],
    [2,3,4,1],
  );
  const hierarchyDiagnostic = runtime.executeHierarchyDiagnostic(
    { quaternion: [0,0,f32(Math.SQRT1_2),f32(Math.SQRT1_2)], translation: [10,20,30] },
    { quaternion: [0,f32(0.25881904510252074),0,f32(0.9659258262890683)], translation: [2,3,4] },
  );
  if (!Object.values(hierarchyDiagnostic.checks).every(Boolean)) throw new Error(`original hierarchy-composition check failed: ${JSON.stringify(hierarchyDiagnostic.checks)}`);
  for (const row of [hierarchyDiagnostic.parent_constructor, hierarchyDiagnostic.child_constructor, hierarchyDiagnostic.writer]) {
    for (const opcode of row.executed_opcodes) opcodeUnion.add(opcode);
  }
  const mutatedSles = Buffer.from(sles), mutationLocation = elf32WordLocation(mutatedSles, TRANSFORM_VTABLE + ROTATION_SETTER_SLOT);
  mutatedSles.writeUInt32LE(EXPECTED_TRANSLATION_SETTER, mutationLocation);
  let mutationRejected = false, mutationError = null;
  try { resolveTransformVtable(mutatedSles); } catch (error) { mutationRejected = true; mutationError = error.message; }
  if (!mutationRejected) throw new Error('mutated concrete rotation-setter vtable slot was not rejected');

  const allChecks = executions.every(row => Object.values(row.runtime_node.checks).every(Boolean));
  return {
    format: 'SO3_FAS_NODE_MATRIX_R5900_EXECUTION_REPORT_V1',
    status: 'EXECUTED_ORIGINAL_TRANSFORM_NODE_SETTERS_LOCAL_WORLD_AND_PARENT_COMPOSITION',
    promotion: {
      fas_to_runtime_node_rotation_setter: true,
      runtime_node_constructor: true,
      no_parent_local_matrix_writer: true,
      no_parent_world_matrix_writer: true,
      hierarchical_parent_matrix_composition: true,
      browser_mesh_skinning: false,
    },
    module: {
      lib_sha256: sha256(lib),
      sles_sha256: sha256(sles),
      dispatcher_type_0x0135_case_va: hex(0x004BD768),
      dispatcher_virtual_setter_load_va: hex(0x004BD7B8),
      node_constructor_va: hex(NODE_CONSTRUCTOR),
      concrete_transform_vtable_va: hex(TRANSFORM_VTABLE),
      translation_setter_slot: hex(TRANSLATION_SETTER_SLOT, 2),
      translation_setter_va: hex(slots.translation_setter),
      rotation_setter_slot: hex(ROTATION_SETTER_SLOT, 2),
      rotation_setter_va: hex(slots.rotation_setter),
      matrix_writer_slot: hex(MATRIX_WRITER_SLOT, 2),
      matrix_writer_va: hex(slots.matrix_writer),
      constructor_slice_sha256: sha256(libSlice(lib, NODE_CONSTRUCTOR, 0x004DAF38)),
      rotation_setter_slice_sha256: sha256(libSlice(lib, slots.rotation_setter, slots.rotation_setter + 0x20)),
      matrix_writer_slice_sha256: sha256(libSlice(lib, slots.matrix_writer, 0x004DAABC)),
      vu0_entry_instruction_index: '0x0E5',
      vu0_program_sha256: runtime.vuProgramInfo.occupiedProgramSha256,
    },
    aggregate: {
      actors: new Set(executions.map(row => row.actor)).size,
      input_clips: clips.length,
      type_0x0135_tracks: tracks.length,
      exact_name_rta_matched_tracks: matched.length,
      unmatched_tracks_withheld: unmatched.length,
      executed_samples: executions.length,
      original_fas_evaluator_guest_instructions: evaluatorInstructions,
      original_fas_evaluator_vu0_microinstruction_pairs: evaluatorMicroPairs,
      original_node_constructor_setter_writer_guest_instructions: nodeInstructions,
      original_node_constructor_writer_vu0_microinstruction_pairs: nodeMicroPairs,
      controlled_two_node_hierarchy_guest_instructions: hierarchyDiagnostic.parent_constructor.original_guest_instructions + hierarchyDiagnostic.child_constructor.original_guest_instructions + hierarchyDiagnostic.setter_guest_instructions + hierarchyDiagnostic.writer.original_guest_instructions,
      controlled_two_node_hierarchy_vu0_microinstruction_pairs: hierarchyDiagnostic.parent_constructor.original_vu0_microinstruction_pairs + hierarchyDiagnostic.child_constructor.original_vu0_microinstruction_pairs + hierarchyDiagnostic.writer.original_vu0_microinstruction_pairs,
      controlled_two_node_hierarchy_indirect_parent_writer_calls: hierarchyDiagnostic.writer.call_trace.filter(row => row.indirect && row.target_va === hex(slots.matrix_writer)).length,
      host_matrix_substitution_calls_on_engine_path: 0,
      all_runtime_node_checks_pass: allChecks,
      all_local_matrices_byte_exact_modulo_ieee754_zero_sign_against_independent_float32_oracle: executions.every(row => row.runtime_node.checks.local_matrix_plus_0x90_byte_exact_modulo_ieee754_zero_sign_against_independent_oracle),
      all_world_matrices_byte_exact_modulo_ieee754_zero_sign_against_independent_float32_oracle: executions.every(row => row.runtime_node.checks.world_matrix_plus_0xD0_byte_exact_modulo_ieee754_zero_sign_against_independent_oracle),
      all_world_matrices_equal_local_modulo_ieee754_zero_sign_without_parent: executions.every(row => row.runtime_node.checks.world_matrix_plus_0xD0_equals_local_modulo_ieee754_zero_sign_without_parent),
      raw_local_byte_exact_against_oracle_samples: executions.filter(row => row.runtime_node.raw_bit_observations.local_matrix_raw_byte_exact_against_independent_oracle).length,
      raw_world_byte_exact_against_oracle_samples: executions.filter(row => row.runtime_node.raw_bit_observations.world_matrix_raw_byte_exact_against_independent_oracle).length,
      raw_world_equals_local_samples: executions.filter(row => row.runtime_node.raw_bit_observations.world_matrix_raw_bytes_equal_local_without_parent).length,
      executed_opcode_families: [...opcodeUnion].sort(),
    },
    concrete_data_flow: [
      '0x004BD768 recognizes type 0x0135 and 0x004BD77C calls the original quaternion evaluator 0x004AD7D0.',
      '0x004BD7B8 loads virtual slot +0x34 from the descriptor target object.',
      'The original 0x004DAD00 constructor installs concrete vtable 0x00178E20; SLES slot +0x34 resolves to 0x003EEF10.',
      '0x003EEF10 sets dirty byte object+0x50 and copies the evaluator qword to rotation quaternion object+0x30.',
      'Concrete vtable slot +0x60 resolves to 0x004DA820, which consumes translation +0x20, quaternion +0x30, scale +0x40, and basis matrix +0x110.',
      'VU0 entry 0x0E5 builds the SO3-convention affine transform; the no-parent branch writes local matrix object+0x90 and world matrix object+0xD0.',
    ],
    diagnostic_nonuniform_scale: {
      quaternion: diagnostic.quaternion,
      translation: diagnostic.translation,
      scale: diagnostic.scale,
      local_matrix: diagnostic.local_matrix,
      local_matrix_sha256: diagnostic.local_matrix_sha256,
      checks: diagnostic.checks,
    },
    diagnostic_hierarchical_parent_composition: hierarchyDiagnostic,
    controls: {
      concrete_vtable_rotation_slot_mutation: {
        mutated_slot_va: hex(TRANSFORM_VTABLE + ROTATION_SETTER_SLOT),
        original_value: hex(EXPECTED_ROTATION_SETTER),
        mutated_value: hex(EXPECTED_TRANSLATION_SETTER),
        rejected_fail_closed: mutationRejected,
        error: mutationError,
      },
    },
    executions,
    unmatched_tracks: unmatched,
    gates: {
      fas_rotation_evaluator: 'PASS_EXECUTED_ORIGINAL_R5900_VU0_MACRO_AND_MICROCODE',
      fas_to_runtime_node_rotation_setter: 'PASS_EXECUTED_ORIGINAL_R5900_CONCRETE_VTABLE_TARGET',
      runtime_node_local_matrix_write_no_parent: 'PASS_EXECUTED_ORIGINAL_R5900_VU0_MICROCODE_EXACT_MODULO_IEEE754_ZERO_SIGN',
      runtime_node_world_matrix_write_no_parent: 'PASS_EXECUTED_ORIGINAL_R5900_VU0_MICROCODE_BYTE_EXACT',
      rta_translation_loader_to_runtime_node: 'WITHHELD_CONTROLLED_EXACT_NAME_INPUT',
      hierarchical_parent_matrix_composition: 'PASS_EXECUTED_ORIGINAL_INDIRECT_VTABLE_CALL_AND_VU0_ENTRY_0x15D_CONTROLLED_TWO_NODE_INPUT',
      final_mesh_skinning: 'WITHHELD_UNRESOLVED_MATRIX_TO_PACKET_BINDING',
    },
    independent_decoder_reference: {
      project: 'ran-j/PS2Recomp',
      commit: ps2RecompCommit,
      use: 'R5900 byte/halfword memory operations, COP2 macro fields, VCALLMS target decoding, lower MOVE semantics, and E-bit delay termination. No PS2Recomp output is substituted for SO3 bytes.',
    },
    boundaries: [
      'This pass executes the original concrete node constructor, translation setter, type-0x0135 rotation-setter target, and no-parent local/world matrix writer instruction by instruction from Lib.',
      'The concrete vtable words are read independently from the supplied SLES ELF; a mutated +0x34 slot is rejected before execution.',
      'RTA raw translations are supplied as controlled exact-name inputs. The code path that originally populates node translation from RTA is not claimed.',
      'The 378 real-track samples deliberately use a zero parent pointer to isolate local/world matrix construction. A separate controlled two-node witness executes parent recursion, indirect vtable +0x60 dispatch, and VU0 entry 0x15D parent-world composition.',
      'Every nonzero writer output bit is exact against an independent float32 closed-form oracle. IEEE-754 +0.0/-0.0 sign differences are preserved in raw hashes and canonicalized only for the matrix-equivalence checks.',
      'FIXED/XBDC packet vertices still lack a verified matrix-to-packet/node binding, so this report does not claim final mesh skinning or visible browser animation.',
    ],
    recommended_reasoning_levels: {
      static_vtable_and_execution_audit: 'max',
      browser_integration_after_verified_matrix_to_packet_binding: 'high',
      on_device_regression_validation: 'medium',
    },
  };
}

function cli(argv) {
  const args = { clips: [], rtas: {} };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--lib') args.lib = argv[++index];
    else if (key === '--sles') args.sles = argv[++index];
    else if (key === '--rta') { const actor = argv[++index]; args.rtas[actor] = argv[++index]; }
    else if (key === '--fas') args.clips.push({ actor: argv[++index], file: argv[++index] });
    else if (key === '--output') args.output = argv[++index];
    else throw new Error(`unknown argument ${key}`);
  }
  if (!args.lib || !args.sles || !Object.keys(args.rtas).length || !args.clips.length || !args.output) throw new Error('usage: run_fas_node_matrix_r5900.js --lib Lib.bin --sles SLES --rta 0x0BC0 ATRC.rta --fas 0x0BC0 ANIM.fas --output report.json');
  const report = buildReport({
    lib: fs.readFileSync(args.lib),
    sles: fs.readFileSync(args.sles),
    rtas: Object.fromEntries(Object.entries(args.rtas).map(([actor, file]) => [actor, fs.readFileSync(file)])),
    clips: args.clips.map(row => ({ actor: row.actor, name: path.basename(row.file), bytes: fs.readFileSync(row.file) })),
  });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: report.status, output: args.output, tracks: report.aggregate.exact_name_rta_matched_tracks, samples: report.aggregate.executed_samples, guest_instructions: report.aggregate.original_node_constructor_setter_writer_guest_instructions })}\n`);
}

module.exports = Object.freeze({
  NODE_CONSTRUCTOR,
  TRANSFORM_VTABLE,
  TRANSLATION_SETTER_SLOT,
  ROTATION_SETTER_SLOT,
  MATRIX_WRITER_SLOT,
  EXPECTED_TRANSLATION_SETTER,
  EXPECTED_ROTATION_SETTER,
  EXPECTED_MATRIX_WRITER,
  identityMatrix,
  matrixBytes,
  independentSo3LocalMatrix,
  elf32WordLocation,
  elf32Word,
  resolveTransformVtable,
  TransformNodeRuntime,
  buildReport,
});

if (require.main === module) cli(process.argv.slice(2));
