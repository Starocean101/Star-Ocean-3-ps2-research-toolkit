#!/usr/bin/env node
'use strict';

/* Bounded VU1 witness for SO3's FIXED packet matrix selection.
 *
 * The original Lib.bin MPG payload is reconstructed in VU1 micro memory and
 * the one-vertex terminal path at instruction indices 0x298..0x2BB is
 * executed.  Only opcodes reached on that path are implemented.  Geometry,
 * IDOM and FSS/RTA identity inputs remain real packaged bytes; matrix values
 * are deliberately diagnostic controls so selection can be mutation-tested.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Geometry = require('./v5_1_geometry.js');
const Idom = require('./run_idom_loader_r5900.js');

const LIB_LOAD = 0x003E6880;
const PROGRAM_PAIR_CAPACITY = 1024;
const VU_DATA_QWORDS = 1024;
const VU_DATA_BYTES = VU_DATA_QWORDS * 16;
const CONSUMER_START = 0x298;
const CONSUMER_RETURN = 0x317;
const PALETTE_BASE_QWORD = 0x290;
const MATRIX_QWORDS = 4;
const PACKET_BASE_QWORD = 0x100;
const PROGRAM_DESCRIPTOR_VA = 0x004EF8A0;
const PROGRAM_DESCRIPTOR_END_VA = 0x004EF8D4;
const MPG_UPLOADS = Object.freeze([
  { command_va: 0x004EF8D4, word: 0x4A0000DC, destination: 0x0DC, count: 256 },
  { command_va: 0x004F00DC, word: 0x4A0001DC, destination: 0x1DC, count: 256 },
  { command_va: 0x004F08E4, word: 0x4A3B02DC, destination: 0x2DC, count: 59 },
]);

const MATRIX_A = Object.freeze([
  1.25, -0.5, 0.75, 0,
  0.2, 1.5, -0.4, 0,
  -0.6, 0.3, 0.9, 0,
  10, -4, 2, 1,
]);
const MATRIX_B = Object.freeze([
  -0.8, 0.45, 0.1, 0,
  0.35, 0.6, -1.1, 0,
  1.2, -0.25, 0.4, 0,
  -7, 12, 5, 1,
]);
const MATRIX_C = Object.freeze([
  0.1, 1.4, -0.2, 0,
  -1.3, 0.2, 0.7, 0,
  0.5, -0.9, 1.1, 0,
  33, -21, 8, 1,
]);

function hex(value, width = 8) {
  return `0x${Number(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function signExtend(value, bits) {
  const shift = 32 - bits;
  return value << shift >> shift;
}

function int16(value) {
  return value << 16 >> 16;
}

function fmul(left, right) {
  return Math.fround(Math.fround(left) * Math.fround(right));
}

function fadd(left, right) {
  return Math.fround(Math.fround(left) + Math.fround(right));
}

function floatArrayBytes(values) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(Math.fround(value), index * 4));
  return bytes;
}

function sameFloatBits(left, right) {
  return floatArrayBytes(left).equals(floatArrayBytes(right));
}

function destinationLetters(mask) {
  return ['x', 'y', 'z', 'w'].filter((_, index) => mask & (8 >> index)).join('') || '-';
}

function parseMpgUpload(moduleBytes, spec) {
  const offset = spec.command_va - LIB_LOAD;
  if (offset < 0 || offset + 4 > moduleBytes.length) throw new Error(`MPG command ${hex(spec.command_va)} outside Lib`);
  const word = moduleBytes.readUInt32LE(offset);
  if (word !== spec.word) throw new Error(`MPG command mismatch at ${hex(spec.command_va)}: ${hex(word)}`);
  const command = word >>> 24 & 0x7F;
  const rawCount = word >>> 16 & 0xFF;
  const count = rawCount || 256;
  const destination = word & 0xFFFF;
  if (command !== 0x4A || count !== spec.count || destination !== spec.destination) {
    throw new Error(`unexpected MPG fields at ${hex(spec.command_va)}`);
  }
  const payloadOffset = offset + 4;
  const payloadBytes = count * 8;
  if (payloadOffset + payloadBytes > moduleBytes.length) throw new Error(`MPG payload truncated at ${hex(spec.command_va)}`);
  return {
    command_va: hex(spec.command_va),
    command_word: hex(word),
    module_file_offset: hex(offset),
    destination_instruction_index: hex(destination, 3),
    instruction_count: count,
    payload_bytes: payloadBytes,
    payload_sha256: sha256(moduleBytes.subarray(payloadOffset, payloadOffset + payloadBytes)),
    payloadOffset,
    destination,
    count,
  };
}

function extractProgram(moduleInput) {
  const moduleBytes = Buffer.from(moduleInput);
  if (moduleBytes.length < 16 || moduleBytes.toString('ascii', 0, 4) !== 'MWo3') throw new Error('Lib input is not MWo3');
  const load = moduleBytes.readUInt32LE(8);
  if (load !== LIB_LOAD) throw new Error(`unexpected Lib load address ${hex(load)}`);
  const segments = MPG_UPLOADS.map(spec => parseMpgUpload(moduleBytes, spec));
  const program = Buffer.alloc(PROGRAM_PAIR_CAPACITY * 8);
  const occupied = new Uint8Array(PROGRAM_PAIR_CAPACITY);
  for (const segment of segments) {
    for (let index = 0; index < segment.count; index++) {
      const destination = segment.destination + index;
      if (destination >= PROGRAM_PAIR_CAPACITY) throw new Error('MPG write exceeds VU1 micro memory');
      if (occupied[destination]) throw new Error(`overlapping MPG write at ${hex(destination, 3)}`);
      occupied[destination] = 1;
    }
    moduleBytes.copy(
      program,
      segment.destination * 8,
      segment.payloadOffset,
      segment.payloadOffset + segment.count * 8,
    );
  }
  const occupiedIndices = [...occupied.keys()].filter(index => occupied[index]);
  const expectedOccupied = Array.from({ length: 571 }, (_, index) => 0x0DC + index);
  assert.deepEqual(occupiedIndices, expectedOccupied, 'MPG uploads must form exactly 0x0DC..0x316');
  const descriptorOffset = PROGRAM_DESCRIPTOR_VA - LIB_LOAD;
  const descriptorEnd = PROGRAM_DESCRIPTOR_END_VA - LIB_LOAD;
  const consumer = program.subarray(CONSUMER_START * 8, (0x2BC) * 8);
  const keyWords = {
    vertex_matrix_address_ilw_w: program.readUInt32LE(0x299 * 8),
    matrix_lq_0: program.readUInt32LE(0x2A1 * 8),
    matrix_lq_1: program.readUInt32LE(0x2A2 * 8),
    matrix_lq_2: program.readUInt32LE(0x2A3 * 8),
    matrix_lq_3: program.readUInt32LE(0x2A4 * 8),
  };
  assert.deepEqual(keyWords, {
    vertex_matrix_address_ilw_w: 0x08213003,
    matrix_lq_0: 0x01EB0800,
    matrix_lq_1: 0x01EC0801,
    matrix_lq_2: 0x01ED0802,
    matrix_lq_3: 0x01EE0803,
  }, 'VU1 matrix consumer key words changed');
  return {
    program,
    module: {
      sha256: sha256(moduleBytes),
      byte_size: moduleBytes.length,
      load_address: hex(load),
    },
    descriptor: {
      va_start: hex(PROGRAM_DESCRIPTOR_VA),
      va_end_exclusive: hex(PROGRAM_DESCRIPTOR_END_VA),
      byte_size: descriptorEnd - descriptorOffset,
      sha256: sha256(moduleBytes.subarray(descriptorOffset, descriptorEnd)),
      raw_hex: moduleBytes.subarray(descriptorOffset, descriptorEnd).toString('hex'),
    },
    segments: segments.map(({ payloadOffset, destination, count, ...row }) => row),
    occupied_instruction_range: { first: '0x0DC', last: '0x316', count: 571 },
    occupied_sha256: sha256(program.subarray(0x0DC * 8, 0x317 * 8)),
    full_micro_memory_sha256: sha256(program),
    consumer_slice: {
      first_instruction_index: hex(CONSUMER_START, 3),
      end_exclusive_instruction_index: '0x2BC',
      instruction_pairs_in_static_slice: 0x2BC - CONSUMER_START,
      sha256: sha256(consumer),
      key_words: Object.fromEntries(Object.entries(keyWords).map(([key, value]) => [key, hex(value)])),
    },
  };
}

class Vu1PacketSkinningTarget {
  constructor(program) {
    this.program = Buffer.from(program);
    if (this.program.length !== PROGRAM_PAIR_CAPACITY * 8) throw new Error('VU1 program must be exactly 8192 bytes');
    this.data = Buffer.alloc(VU_DATA_BYTES);
    this.vf = Array.from({ length: 32 }, () => new Float32Array(4));
    this.vf[0][3] = 1;
    this.vi = new Int16Array(16);
    this.acc = new Float32Array(4);
    this.trace = [];
    this.memoryReads = [];
    this.memoryWrites = [];
    this.branchPending = null;
    this.branchDelay = 0;
  }

  applyDestination(target, values, mask) {
    if (mask & 8) target[0] = Math.fround(values[0]);
    if (mask & 4) target[1] = Math.fround(values[1]);
    if (mask & 2) target[2] = Math.fround(values[2]);
    if (mask & 1) target[3] = Math.fround(values[3]);
  }

  qwordAddress(baseRegister, immediate) {
    return (int16(this.vi[baseRegister]) + immediate) & 0x3FF;
  }

  readQword(qword) {
    const values = new Float32Array(4);
    const offset = qword * 16;
    for (let component = 0; component < 4; component++) values[component] = this.data.readFloatLE(offset + component * 4);
    return values;
  }

  writeQword(qword, values, mask) {
    const offset = qword * 16;
    for (let component = 0; component < 4; component++) {
      if (mask & (8 >> component)) this.data.writeFloatLE(Math.fround(values[component]), offset + component * 4);
    }
  }

  executeUpper(word) {
    if ((word & 0x3FFFFFFF) === 0x000002FF) return 'NOP';
    const mask = word >>> 21 & 0xF;
    const ft = word >>> 16 & 31;
    const fs = word >>> 11 & 31;
    const fd = word >>> 6 & 31;
    const op = word & 0x3F;
    const fields = ['x', 'y', 'z', 'w'];
    const values = new Float32Array(4);
    if (op >= 0x08 && op <= 0x0B) {
      const field = op & 3;
      for (let component = 0; component < 4; component++) {
        values[component] = fadd(this.acc[component], fmul(this.vf[fs][component], this.vf[ft][field]));
      }
      this.applyDestination(this.vf[fd], values, mask);
      return `MADD${fields[field]}.${destinationLetters(mask)} vf${fd},ACC,vf${fs},vf${ft}`;
    }
    if (op >= 0x3C) {
      const special = (word & 3) | (word >>> 4 & 0x7C);
      if (special >= 0x18 && special <= 0x1B) {
        const field = special & 3;
        for (let component = 0; component < 4; component++) values[component] = fmul(this.vf[fs][component], this.vf[ft][field]);
        this.applyDestination(this.acc, values, mask);
        return `MULA${fields[field]}.${destinationLetters(mask)} ACC,vf${fs},vf${ft}`;
      }
      if (special >= 0x08 && special <= 0x0B) {
        const field = special & 3;
        for (let component = 0; component < 4; component++) {
          values[component] = fadd(this.acc[component], fmul(this.vf[fs][component], this.vf[ft][field]));
        }
        this.applyDestination(this.acc, values, mask);
        return `MADDA${fields[field]}.${destinationLetters(mask)} ACC,vf${fs},vf${ft}`;
      }
    }
    throw new Error(`unsupported VU1 upper word ${hex(word)} on bounded path`);
  }

  executeLower(word, pcIndex) {
    if (word === 0 || word === 0x8000033C) return 'NOP';
    const opHi = word >>> 25 & 0x7F;
    const mask = word >>> 21 & 0xF;
    const lit = word >>> 16 & 31;
    const lis = word >>> 11 & 31;
    const vit = word >>> 16 & 15;
    const vis = word >>> 11 & 15;
    const vid = word >>> 6 & 15;
    const immediate11 = signExtend(word & 0x7FF, 11);
    if (opHi === 0x00) {
      const qword = this.qwordAddress(vis, immediate11);
      const values = this.readQword(qword);
      this.applyDestination(this.vf[lit], values, mask);
      this.memoryReads.push({ pc_instruction_index: hex(pcIndex, 3), kind: 'LQ', qword_address: hex(qword, 3), vf: lit, mask: destinationLetters(mask) });
      return `LQ.${destinationLetters(mask)} vf${lit},${immediate11}(vi${vis})`;
    }
    if (opHi === 0x01) {
      const qword = this.qwordAddress(vit, immediate11);
      this.writeQword(qword, this.vf[lis], mask);
      this.memoryWrites.push({ pc_instruction_index: hex(pcIndex, 3), kind: 'SQ', qword_address: hex(qword, 3), vf: lis, mask: destinationLetters(mask) });
      return `SQ.${destinationLetters(mask)} vf${lis},${immediate11}(vi${vit})`;
    }
    if (opHi === 0x04) {
      const qword = this.qwordAddress(vis, immediate11);
      const component = mask & 8 ? 0 : mask & 4 ? 1 : mask & 2 ? 2 : 3;
      const raw = this.data.readUInt32LE(qword * 16 + component * 4);
      if (vit) this.vi[vit] = int16(raw & 0xFFFF);
      this.memoryReads.push({ pc_instruction_index: hex(pcIndex, 3), kind: 'ILW', qword_address: hex(qword, 3), component: ['x', 'y', 'z', 'w'][component], vi: vit, value: hex(raw & 0xFFFF, 4) });
      return `ILW.${['x', 'y', 'z', 'w'][component]} vi${vit},${immediate11}(vi${vis})`;
    }
    if (opHi === 0x08) {
      let immediate = (word & 0x7FF) | ((word >>> 10) & 0x7800);
      immediate = signExtend(immediate, 15);
      if (vit) this.vi[vit] = int16(this.vi[vis] + immediate);
      return `IADDIU vi${vit},vi${vis},${immediate}`;
    }
    if (opHi === 0x24) {
      const target = this.vi[vis] & 0xFFFF;
      this.branchPending = target;
      this.branchDelay = 1;
      return `JR vi${vis} -> ${hex(target, 3)}`;
    }
    if (opHi === 0x28) {
      const taken = int16(this.vi[vis]) === int16(this.vi[vit]);
      const target = pcIndex + 1 + immediate11;
      if (taken) {
        this.branchPending = target;
        this.branchDelay = 1;
      }
      return `IBEQ vi${vis},vi${vit} -> ${hex(target, 3)} (${taken ? 'taken' : 'not taken'})`;
    }
    if (opHi === 0x40 && (word & 0x3F) === 0x30) {
      if (vid) this.vi[vid] = int16(this.vi[vis] + this.vi[vit]);
      return `IADD vi${vid},vi${vis},vi${vit}`;
    }
    throw new Error(`unsupported VU1 lower word ${hex(word)} at ${hex(pcIndex, 3)}`);
  }

  run(startIndex = CONSUMER_START, stopIndex = CONSUMER_RETURN, maxPairs = 64) {
    let pcIndex = startIndex;
    for (let cycle = 0; cycle < maxPairs; cycle++) {
      if (pcIndex === stopIndex) {
        return { stop_reason: 'CONTROLLED_RETURN_PC', instruction_pairs: this.trace.length, trace: this.trace };
      }
      if (pcIndex < 0 || pcIndex >= PROGRAM_PAIR_CAPACITY) throw new Error(`VU1 PC ${hex(pcIndex, 3)} outside micro memory`);
      const lower = this.program.readUInt32LE(pcIndex * 8);
      const upper = this.program.readUInt32LE(pcIndex * 8 + 4);
      if (upper >>> 31 & 1) throw new Error(`unexpected LOI at ${hex(pcIndex, 3)}`);
      const upperText = this.executeUpper(upper);
      const lowerText = this.executeLower(lower, pcIndex);
      this.vf[0].set([0, 0, 0, 1]);
      this.vi[0] = 0;
      this.trace.push({
        cycle,
        pc_instruction_index: hex(pcIndex, 3),
        lower_word: hex(lower),
        lower_instruction: lowerText,
        upper_word: hex(upper),
        upper_instruction: upperText,
      });
      let nextIndex = pcIndex + 1;
      if (this.branchPending !== null) {
        if (this.branchDelay === 0) {
          nextIndex = this.branchPending;
          this.branchPending = null;
        } else {
          this.branchDelay--;
        }
      }
      pcIndex = nextIndex;
    }
    throw new Error(`VU1 bounded path exceeded ${maxPairs} instruction pairs`);
  }
}

function writeVector(data, qword, values, integerW = null) {
  if (qword < 0 || qword >= VU_DATA_QWORDS) throw new Error(`qword ${hex(qword, 3)} outside VU1 data`);
  for (let component = 0; component < 4; component++) data.writeFloatLE(Math.fround(values[component] || 0), qword * 16 + component * 4);
  if (integerW !== null) data.writeUInt32LE(integerW >>> 0, qword * 16 + 12);
}

function writeMatrix(data, qword, matrix) {
  if (matrix.length !== 16) throw new Error('matrix must contain 16 float32 values');
  if (qword < 0 || qword + 3 >= VU_DATA_QWORDS) throw new Error(`matrix ${hex(qword, 3)} outside VU1 data`);
  for (let column = 0; column < 4; column++) writeVector(data, qword + column, matrix.slice(column * 4, column * 4 + 4));
}

function oracleTransform(vector, matrix, withTranslation) {
  const output = new Float32Array(4);
  for (let component = 0; component < 4; component++) {
    let accumulator = fmul(matrix[component], vector[0]);
    accumulator = fadd(accumulator, fmul(matrix[4 + component], vector[1]));
    accumulator = fadd(accumulator, fmul(matrix[8 + component], vector[2]));
    if (withTranslation) accumulator = fadd(accumulator, fmul(matrix[12 + component], 1));
    output[component] = accumulator;
  }
  return Array.from(output);
}

function executeVertex(program, vertex, selectedAddress, alternativeAddress, selectedMatrix, alternativeMatrix) {
  const target = new Vu1PacketSkinningTarget(program);
  target.vi[7] = 1; // one vertex: original loop computes terminal qword base+8
  target.vi[10] = CONSUMER_RETURN;
  target.vi[13] = PACKET_BASE_QWORD;
  writeVector(target.data, PACKET_BASE_QWORD, [...vertex.normal, 0]);
  writeVector(target.data, PACKET_BASE_QWORD + 3, [...vertex.position, 0], selectedAddress);
  writeMatrix(target.data, selectedAddress, selectedMatrix);
  writeMatrix(target.data, alternativeAddress, alternativeMatrix);
  const result = target.run();
  const normal = Array.from(target.vf[15]);
  const position = Array.from(target.vf[16]);
  const storedNormal = Array.from(target.readQword(PACKET_BASE_QWORD));
  const storedPosition = Array.from(target.readQword(PACKET_BASE_QWORD + 3));
  const expectedNormal = oracleTransform(vertex.normal, selectedMatrix, false);
  const expectedPosition = oracleTransform(vertex.position, selectedMatrix, true);
  const currentMatrixLoads = target.memoryReads.filter(row => ['0x2A1', '0x2A2', '0x2A3', '0x2A4'].includes(row.pc_instruction_index));
  const checks = {
    returned_to_controlled_pc: result.stop_reason === 'CONTROLLED_RETURN_PC',
    current_matrix_loads_exact_four_qwords: currentMatrixLoads.length === 4 && currentMatrixLoads.every((row, index) => Number.parseInt(row.qword_address, 16) === selectedAddress + index),
    normal_matches_float32_oracle_bits: sameFloatBits(normal, expectedNormal),
    position_matches_float32_oracle_bits: sameFloatBits(position, expectedPosition),
    stored_normal_matches_register_bits: sameFloatBits(storedNormal, normal),
    stored_position_matches_register_bits: sameFloatBits(storedPosition, position),
  };
  if (!Object.values(checks).every(Boolean)) throw new Error(`VU1 vertex execution failed checks for address ${hex(selectedAddress, 3)}`);
  const traceCommitment = Buffer.from(result.trace.map(row => `${row.pc_instruction_index}|${row.lower_word}|${row.upper_word}\n`).join(''));
  return {
    selected_matrix_address: hex(selectedAddress, 3),
    alternative_matrix_address: hex(alternativeAddress, 3),
    stop_reason: result.stop_reason,
    original_instruction_pairs_executed: result.instruction_pairs,
    original_fmac_pairs_executed: result.trace.filter(row => row.upper_instruction !== 'NOP').length,
    current_matrix_lq_addresses: currentMatrixLoads.map(row => row.qword_address),
    output: {
      normal,
      position,
      normal_sha256: sha256(floatArrayBytes(normal)),
      position_sha256: sha256(floatArrayBytes(position)),
    },
    oracle: { normal: expectedNormal, position: expectedPosition },
    checks,
    trace_commitment_sha256: sha256(traceCommitment),
    trace: result.trace,
    memory_reads: target.memoryReads,
    memory_writes: target.memoryWrites,
  };
}

function parseHex(value) {
  return Number.parseInt(String(value), 16);
}

function exactRange(start, count, stride) {
  return Array.from({ length: count }, (_, index) => start + index * stride);
}

function buildActorEvidence(program, actorInput, bridgeActor, actorId, sourceName) {
  const actorBytes = Buffer.from(actorInput);
  const model = Geometry.parseGeometry(actorBytes);
  const sections = Idom.parseIdomSections(actorBytes);
  const rows = [];
  for (let segmentIndex = 0; segmentIndex < model.segments.length; segmentIndex++) {
    const segment = model.segments[segmentIndex];
    const chainIndex = model.chain.blocks.findIndex(block => block.off === segment.off && block.type === 'FPS');
    if (chainIndex < 0) throw new Error(`${actorId} segment ${segmentIndex}: FPS chain block missing`);
    const nextBlock = model.chain.blocks[chainIndex + 1];
    if (!nextBlock || nextBlock.type !== 'MODI' || segment.end + 0x10 !== nextBlock.off) {
      throw new Error(`${actorId} segment ${segmentIndex}: chain-adjacent IDOM missing`);
    }
    const section = sections.find(candidate => candidate.offset === nextBlock.off);
    if (!section) throw new Error(`${actorId} segment ${segmentIndex}: parsed IDOM missing at ${hex(nextBlock.off)}`);
    const bridgePalette = bridgeActor.idom_palettes.find(candidate => parseHex(candidate.file_offset) === section.offset);
    if (!bridgePalette) throw new Error(`${actorId} segment ${segmentIndex}: identity bridge row missing`);
    if (bridgePalette.matrix_count !== section.header.matrix_count || bridgePalette.slots.length !== section.header.matrix_count) {
      throw new Error(`${actorId} segment ${segmentIndex}: IDOM/bridge count mismatch`);
    }
    const vertices = model.vertices.map((vertex, globalIndex) => ({ vertex, globalIndex })).filter(row => row.vertex.segment === segmentIndex);
    if (!vertices.length || vertices.some(row => row.vertex.profile !== 'FIXED' || !Number.isInteger(row.vertex.matrixAddress))) {
      throw new Error(`${actorId} segment ${segmentIndex}: expected only addressed FIXED vertices`);
    }
    const observedAddresses = [...new Set(vertices.map(row => row.vertex.matrixAddress))].sort((left, right) => left - right);
    const expectedAddresses = exactRange(PALETTE_BASE_QWORD, section.header.matrix_count, MATRIX_QWORDS);
    assert.deepEqual(observedAddresses, expectedAddresses, `${actorId} segment ${segmentIndex}: matrix address coverage mismatch`);
    const addressRows = vertices.map(row => {
      const slot = (row.vertex.matrixAddress - PALETTE_BASE_QWORD) / MATRIX_QWORDS;
      if (!Number.isInteger(slot) || slot < 0 || slot >= bridgePalette.slots.length) throw new Error(`${actorId}: invalid matrix address ${row.vertex.matrixAddress}`);
      const identity = bridgePalette.slots[slot];
      if (identity.palette_slot !== slot) throw new Error(`${actorId}: bridge palette slot mismatch`);
      return { ...row, slot, identity };
    });
    const candidates = addressRows.filter(row => row.vertex.normal.reduce((sum, value) => sum + value * value, 0) > 0.25)
      .sort((left, right) => right.vertex.matrixAddress - left.vertex.matrixAddress || left.globalIndex - right.globalIndex);
    if (!candidates.length) throw new Error(`${actorId} segment ${segmentIndex}: no nondegenerate normal control vertex`);
    const selected = candidates[0];
    const alternativeAddress = observedAddresses.find(address => address !== selected.vertex.matrixAddress);
    if (alternativeAddress === undefined) throw new Error(`${actorId} segment ${segmentIndex}: no alternative palette address`);
    const primary = executeVertex(program, selected.vertex, selected.vertex.matrixAddress, alternativeAddress, MATRIX_A, MATRIX_B);
    const swapped = executeVertex(program, selected.vertex, alternativeAddress, selected.vertex.matrixAddress, MATRIX_B, MATRIX_A);
    const unselectedMutation = executeVertex(program, selected.vertex, selected.vertex.matrixAddress, alternativeAddress, MATRIX_A, MATRIX_C);
    const mutationChecks = {
      changing_only_vertex_w_selects_alternative_matrix: !sameFloatBits(primary.output.position, swapped.output.position) && sameFloatBits(swapped.output.position, oracleTransform(selected.vertex.position, MATRIX_B, true)),
      mutating_only_unselected_palette_slot_preserves_output: sameFloatBits(primary.output.normal, unselectedMutation.output.normal) && sameFloatBits(primary.output.position, unselectedMutation.output.position),
      original_vertex_address_maps_to_idom_slot: selected.slot === (selected.vertex.matrixAddress - PALETTE_BASE_QWORD) / MATRIX_QWORDS,
    };
    if (!Object.values(mutationChecks).every(Boolean)) throw new Error(`${actorId} segment ${segmentIndex}: mutation control failed`);
    rows.push({
      actor: actorId,
      segment_index: segmentIndex,
      fps_offset: hex(segment.off),
      fps_end_exclusive: hex(segment.end),
      chain_adjacent_idom_offset: hex(section.offset),
      chain_adjacency_bytes: nextBlock.off - segment.end,
      packets: segment.packets.length,
      vertices: vertices.length,
      idom_matrix_count: section.header.matrix_count,
      observed_unique_matrix_addresses: observedAddresses.map(address => hex(address, 3)),
      expected_complete_matrix_address_range: expectedAddresses.map(address => hex(address, 3)),
      address_formula: 'VU1_qword = 0x290 + 4 * IDOM_palette_slot',
      all_vertices_resolve_in_range: addressRows.length === vertices.length,
      all_palette_slots_observed: observedAddresses.length === section.header.matrix_count,
      selected_real_vertex: {
        global_vertex_index: selected.globalIndex,
        packet_index: selected.vertex.packet,
        position: selected.vertex.position,
        normal: selected.vertex.normal,
        original_matrix_address: hex(selected.vertex.matrixAddress, 3),
        idom_palette_slot: selected.slot,
        fss_descriptor_index: selected.identity.fss_descriptor_index,
        fss_name: selected.identity.name,
        rta_name_ordinal: selected.identity.rta_name_ordinal,
        rta_name_exact_match: selected.identity.rta_name_exact_match,
      },
      primary_execution: primary,
      mutation_controls: {
        changed_only_vertex_w: {
          selected_matrix_address: swapped.selected_matrix_address,
          output: swapped.output,
          checks: swapped.checks,
        },
        changed_only_unselected_palette_matrix: {
          unchanged_vertex_matrix_address: unselectedMutation.selected_matrix_address,
          output: unselectedMutation.output,
          checks: unselectedMutation.checks,
        },
        checks: mutationChecks,
      },
    });
  }
  return {
    actor: actorId,
    source_name: sourceName,
    source_sha256: sha256(actorBytes),
    source_bytes: actorBytes.length,
    chain_full_coverage: model.chain.fullCoverage,
    segment_rows: rows,
  };
}

function buildReport({ lib, actors, identityBridge }) {
  const extracted = extractProgram(lib);
  const bridge = typeof identityBridge === 'string' ? JSON.parse(identityBridge) : identityBridge;
  if (!bridge || bridge.format !== 'SO3_FSS_IDOM_RTA_NAME_BRIDGE_REPORT_V1') throw new Error('unexpected FSS/IDOM/RTA bridge format');
  const actorRows = actors.map(actor => {
    const bridgeActor = bridge.actors.find(candidate => candidate.actor.toUpperCase() === actor.actor.toUpperCase());
    if (!bridgeActor) throw new Error(`identity bridge missing actor ${actor.actor}`);
    return buildActorEvidence(extracted.program, actor.bytes, bridgeActor, actor.actor, actor.name);
  });
  const segments = actorRows.flatMap(actor => actor.segment_rows);
  const aggregate = {
    actors: actorRows.length,
    fixed_segments: segments.length,
    packets: segments.reduce((sum, row) => sum + row.packets, 0),
    fixed_vertices: segments.reduce((sum, row) => sum + row.vertices, 0),
    idom_palette_slots: segments.reduce((sum, row) => sum + row.idom_matrix_count, 0),
    controlled_original_vu1_executions: segments.length * 3,
    primary_original_instruction_pairs: segments.reduce((sum, row) => sum + row.primary_execution.original_instruction_pairs_executed, 0),
    primary_original_fmac_pairs: segments.reduce((sum, row) => sum + row.primary_execution.original_fmac_pairs_executed, 0),
    all_segment_address_ranges_exact: segments.every(row => row.all_vertices_resolve_in_range && row.all_palette_slots_observed && JSON.stringify(row.observed_unique_matrix_addresses) === JSON.stringify(row.expected_complete_matrix_address_range)),
    all_execution_checks_pass: segments.every(row => Object.values(row.primary_execution.checks).every(Boolean) && Object.values(row.mutation_controls.checks).every(Boolean)),
  };
  if (aggregate.packets !== 212 || aggregate.fixed_vertices !== 4712 || aggregate.idom_palette_slots !== 95) {
    throw new Error(`unexpected real corpus totals ${JSON.stringify(aggregate)}`);
  }
  if (!aggregate.all_segment_address_ranges_exact || !aggregate.all_execution_checks_pass) throw new Error('aggregate packet binding checks failed');
  const { program, ...microprogram } = extracted;
  return {
    format: 'SO3_VU1_PACKET_SKINNING_EXECUTION_REPORT_V1',
    status: 'PASS_EXECUTED_ORIGINAL_VU1_PACKET_MATRIX_CONSUMER',
    engine_module: microprogram.module,
    vu1_microprogram: microprogram,
    actor_evidence: actorRows,
    aggregate,
    proven: [
      'Original Lib MPG commands load a continuous VU1 microprogram at instruction indices 0x0DC..0x316.',
      'On the executed one-vertex terminal path, ILW.w at 0x299 reads the signed matrix qword address from FIXED position.w; LQ at 0x2A1..0x2A4 reads four consecutive qwords from that address.',
      'Original VU1 FMAC pairs at 0x2A5..0x2AB transform the normal by matrix columns 0..2 and the position by columns 0..3.',
      'All 4,712 supplied FIXED vertices use exactly 0x290 + 4*slot, and every slot in each chain-adjacent IDOM palette is observed.',
      'Changing only vertex position.w selects a different diagnostic matrix; changing only an unselected palette matrix leaves output bit-identical.',
      'Combining the original IDOM-sized uploader destination 0x290, chain-adjacent IDOM order, and the executed VU1 address consumer resolves packet address to IDOM palette slot without an ordinal guess.',
    ],
    gates: {
      fixed_vertex_matrix_address_to_idom_palette_slot: 'PASS_EXECUTED_ORIGINAL_VU1_AND_BYTE_EXACT_CORPUS',
      packet_vertex_matrix_selection: 'PASS_EXECUTED_ORIGINAL_VU1_MICROCODE',
      packet_vertex_controlled_matrix_transform: 'PASS_EXECUTED_ORIGINAL_VU1_FMAC',
      matrix_to_rta_actor_0x08FF: 'PASS_ALL_51_IDOM_ROWS_EXACT_RTA_NAME_IDENTITY',
      matrix_to_rta_actor_0x0BC0: 'PARTIAL_40_OF_44_ROWS_FOUR_RETAIN_NAMED_FSS_IDENTITY_WITHOUT_RTA_ORDINAL',
      rta_translation_loader_to_runtime_node: 'WITHHELD_MISSING_FIELD_OVERLAY',
      bounded_end_to_end_animated_pose: 'WITHHELD_MISSING_ORIGINAL_TRANSLATION_LOADER',
      browser_mesh_deformation: 'WITHHELD_BY_ORDERED_GATE',
    },
    boundaries: [
      'The executed VU1 path starts after VIF UNPACK. Real decoded FIXED position, normal, and matrix-address values are used, but diagnostic matrix contents are controlled.',
      'This is a rigid one-matrix-per-vertex consumer witness; it does not claim blended weights or generalize to unsupported packet profiles.',
      'The four geometry-to-IDOM pairings are established by forward chain adjacency and complete address-range equality, not by assigning runtime primary/auxiliary roles.',
      'The original RTA translation loader is still absent because the Field.bin overlay containing 0x002510E0 was not supplied.',
      'No browser deformation is integrated and no visual repair is claimed.',
    ],
    opcode_reference: {
      project: 'PS2Recomp',
      commit: 'ee149581aac999ab22791b3900377c0b028a5840',
      files: ['ps2xRuntime/src/lib/vu/ps2_vu1_lower.cpp', 'ps2xRuntime/src/lib/vu/ps2_vu1_upper.cpp', 'ps2xRuntime/src/lib/vu/ps2_vu1_detail.h'],
      use: 'Instruction-field and VU1 operation semantics only; all executed SO3 words and data are independently taken from and hashed within this package.',
    },
    recommended_reasoning_levels: {
      field_translation_loader_execution: 'max',
      bounded_end_to_end_pose_after_field_response: 'max',
      browser_integration_after_end_to_end_witness: 'high',
      on_device_actor_regression: 'medium',
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 5) {
    console.error('usage: run_vu1_packet_skinning.js LIB_MWO3 CHAR_08FF CHAR_0BC0 FSS_IDOM_RTA_BRIDGE_JSON OUTPUT_JSON');
    process.exit(2);
  }
  const [libPath, char08Path, char0bPath, bridgePath, outputPath] = args;
  const report = buildReport({
    lib: fs.readFileSync(libPath),
    actors: [
      { actor: '0x08FF', name: path.basename(char08Path), bytes: fs.readFileSync(char08Path) },
      { actor: '0x0BC0', name: path.basename(char0bPath), bytes: fs.readFileSync(char0bPath) },
    ],
    identityBridge: fs.readFileSync(bridgePath, 'utf8'),
  });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.error(JSON.stringify({ status: report.status, output: outputPath, aggregate: report.aggregate }));
}

if (require.main === module) main();

module.exports = {
  LIB_LOAD,
  CONSUMER_START,
  CONSUMER_RETURN,
  PALETTE_BASE_QWORD,
  MATRIX_QWORDS,
  MATRIX_A,
  MATRIX_B,
  MATRIX_C,
  Vu1PacketSkinningTarget,
  extractProgram,
  oracleTransform,
  executeVertex,
  buildReport,
};
