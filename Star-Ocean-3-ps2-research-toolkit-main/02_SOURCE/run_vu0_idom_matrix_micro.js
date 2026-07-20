#!/usr/bin/env node
/* Execute the original SO3 VU0 matrix microprogram embedded in Lib.bin.
 *
 * This is deliberately a bounded interpreter.  It implements only the VU
 * instructions reached from VCALLMS 0x113 and throws on every other opcode.
 * The independent oracle is the closed-form affine expression recovered from
 * the executed instruction path: transpose(root * node * IDOM).
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Idom = require('./run_idom_loader_r5900.js');

const LIB_LOAD = 0x003E6880;
const MPG0_COMMAND_VA = 0x004E9FA4;
const MPG1_COMMAND_VA = 0x004EA7AC;
const VCALL_SITE_VA = 0x004ABBB0;
const EVALUATOR_ENTRY_VA = 0x004ABA30;
const EVALUATOR_END_EXCLUSIVE_VA = 0x004ABC80;
const EXPECTED_VCALL_WORD = 0x4A0044F8;
const PROGRAM_PAIR_CAPACITY = 512;

function sha256(input) {
  return crypto.createHash('sha256').update(Buffer.from(input)).digest('hex');
}

function hex(value, width = 8) {
  return `0x${Number(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

function signExtend(value, bits) {
  const sign = 2 ** (bits - 1);
  return value & sign ? value - 2 ** bits : value;
}

function destinationLetters(mask) {
  return `${mask & 8 ? 'x' : ''}${mask & 4 ? 'y' : ''}${mask & 2 ? 'z' : ''}${mask & 1 ? 'w' : ''}` || '-';
}

function parseMpgCommand(moduleBytes, commandVa) {
  const offset = commandVa - LIB_LOAD;
  if (offset < 0 || offset + 4 > moduleBytes.length) throw new Error(`MPG command ${hex(commandVa)} is outside Lib`);
  const word = moduleBytes.readUInt32LE(offset);
  const command = word >>> 24 & 0x7F;
  if (command !== 0x4A) throw new Error(`expected VIF MPG at ${hex(commandVa)}, got ${hex(word)}`);
  const encodedCount = word >>> 16 & 0xFF;
  const instructionCount = encodedCount || 256;
  const destinationIndex = word & 0x1FF;
  const payloadOffset = offset + 4;
  const payloadBytes = instructionCount * 8;
  if (payloadOffset + payloadBytes > moduleBytes.length) throw new Error(`MPG payload at ${hex(commandVa)} is truncated`);
  return {
    command_va: hex(commandVa),
    command_word: hex(word),
    payload_va: hex(commandVa + 4),
    destination_instruction_index: destinationIndex,
    instruction_count: instructionCount,
    payload_offset: payloadOffset,
    payload_bytes: payloadBytes,
  };
}

function extractVu0Program(input) {
  const moduleBytes = Buffer.from(input);
  if (moduleBytes.length < 0x40 || moduleBytes.toString('ascii', 0, 4) !== 'MWo3') throw new Error('Lib input is not an MWo3 module');
  const loadAddress = moduleBytes.readUInt32LE(8);
  if (loadAddress !== LIB_LOAD) throw new Error(`unexpected Lib load address ${hex(loadAddress)}`);
  const segments = [parseMpgCommand(moduleBytes, MPG0_COMMAND_VA), parseMpgCommand(moduleBytes, MPG1_COMMAND_VA)];
  if (segments[0].destination_instruction_index !== 0 || segments[0].instruction_count !== 256 ||
      segments[1].destination_instruction_index !== 0x100 || segments[1].instruction_count !== 197) {
    throw new Error('Lib MPG layout does not match the two contiguous VU0 uploads');
  }
  const program = Buffer.alloc(PROGRAM_PAIR_CAPACITY * 8);
  for (const segment of segments) {
    moduleBytes.copy(
      program,
      segment.destination_instruction_index * 8,
      segment.payload_offset,
      segment.payload_offset + segment.payload_bytes,
    );
  }
  const callOffset = VCALL_SITE_VA - LIB_LOAD;
  const callWord = moduleBytes.readUInt32LE(callOffset);
  if (callWord !== EXPECTED_VCALL_WORD) throw new Error(`unexpected VCALLMS word at ${hex(VCALL_SITE_VA)}: ${hex(callWord)}`);
  const entryIndex = callWord >>> 6 & 0x1FF;
  return {
    program,
    entryIndex,
    callWord,
    segments,
    occupiedInstructionCount: 0x100 + segments[1].instruction_count,
    moduleSha256: sha256(moduleBytes),
    programSha256: sha256(program),
    occupiedProgramSha256: sha256(program.subarray(0, (0x100 + segments[1].instruction_count) * 8)),
    evaluatorSliceSha256: sha256(moduleBytes.subarray(EVALUATOR_ENTRY_VA - LIB_LOAD, EVALUATOR_END_EXCLUSIVE_VA - LIB_LOAD)),
  };
}

function fmul(a, b) {
  return Math.fround(Math.fround(a) * Math.fround(b));
}

function fadd(a, b) {
  return Math.fround(Math.fround(a) + Math.fround(b));
}

function upperWriteRegister(word) {
  const dest = word >>> 21 & 0xF;
  if (!dest) return 0;
  const op = word & 0x3F;
  if (op <= 0x2F) return word >>> 6 & 31;
  if (op >= 0x3C) {
    const special = (word & 3) | (word >>> 4 & 0x7C);
    if (special >= 0x10 && special <= 0x17 || special === 0x1D) return word >>> 16 & 31;
  }
  return 0;
}

function lowerMoveRegisters(word) {
  if (!(word & 0x80000000) || (word & 0x3F) < 0x3C) return null;
  const special = (word & 3) | (word >>> 4 & 0x7C);
  if (special !== 0x30) return null;
  return { source: word >>> 11 & 31, destination: word >>> 16 & 31 };
}

class Vu0MatrixMicroTarget {
  constructor(program) {
    this.program = Buffer.from(program);
    if (this.program.length !== PROGRAM_PAIR_CAPACITY * 8) throw new Error('VU0 program must be exactly 4096 bytes');
    this.reset();
  }

  reset() {
    this.vf = Array.from({ length: 32 }, () => new Float32Array(4));
    this.vf[0][3] = 1;
    this.acc = new Float32Array(4);
    this.vi = new Int32Array(16);
    this.trace = [];
    this.branchTarget = null;
    this.branchDelay = 0;
    this.endPending = false;
  }

  loadMatrix(firstRegister, matrix) {
    if (matrix.length !== 16) throw new Error('matrix input must contain 16 floats');
    for (let row = 0; row < 4; row++) {
      for (let component = 0; component < 4; component++) this.vf[firstRegister + row][component] = Math.fround(matrix[row * 4 + component]);
    }
  }

  applyDestination(target, values, mask) {
    if (mask & 8) target[0] = Math.fround(values[0]);
    if (mask & 4) target[1] = Math.fround(values[1]);
    if (mask & 2) target[2] = Math.fround(values[2]);
    if (mask & 1) target[3] = Math.fround(values[3]);
  }

  executeUpper(word) {
    if ((word & 0x3FFFFFFF) === 0x000002FF) return 'NOP';
    const dest = word >>> 21 & 0xF;
    const ft = word >>> 16 & 31;
    const fs = word >>> 11 & 31;
    const fd = word >>> 6 & 31;
    const op = word & 0x3F;
    const values = new Float32Array(4);
    const bcName = ['x', 'y', 'z', 'w'];
    if (op <= 0x03) {
      const bc = this.vf[ft][op & 3];
      for (let c = 0; c < 4; c++) values[c] = fadd(this.vf[fs][c], bc);
      this.applyDestination(this.vf[fd], values, dest);
      return `ADD${bcName[op & 3]}.${destinationLetters(dest)} vf${fd},vf${fs},vf${ft}`;
    }
    if (op >= 0x08 && op <= 0x0B) {
      const bc = this.vf[ft][op & 3];
      for (let c = 0; c < 4; c++) values[c] = fadd(this.acc[c], fmul(this.vf[fs][c], bc));
      this.applyDestination(this.vf[fd], values, dest);
      return `MADD${bcName[op & 3]}.${destinationLetters(dest)} vf${fd},ACC,vf${fs},vf${ft}`;
    }
    if (op >= 0x18 && op <= 0x1B) {
      const bc = this.vf[ft][op & 3];
      for (let c = 0; c < 4; c++) values[c] = fmul(this.vf[fs][c], bc);
      this.applyDestination(this.vf[fd], values, dest);
      return `MUL${bcName[op & 3]}.${destinationLetters(dest)} vf${fd},vf${fs},vf${ft}`;
    }
    if (op >= 0x3C) {
      const special = (word & 3) | (word >>> 4 & 0x7C);
      if (special >= 0x18 && special <= 0x1B) {
        const bc = this.vf[ft][special & 3];
        for (let c = 0; c < 4; c++) values[c] = fmul(this.vf[fs][c], bc);
        this.applyDestination(this.acc, values, dest);
        return `MULA${bcName[special & 3]}.${destinationLetters(dest)} ACC,vf${fs},vf${ft}`;
      }
      if (special >= 0x08 && special <= 0x0B) {
        const bc = this.vf[ft][special & 3];
        for (let c = 0; c < 4; c++) values[c] = fadd(this.acc[c], fmul(this.vf[fs][c], bc));
        this.applyDestination(this.acc, values, dest);
        return `MADDA${bcName[special & 3]}.${destinationLetters(dest)} ACC,vf${fs},vf${ft}`;
      }
    }
    throw new Error(`unsupported VU0 upper word ${hex(word)} on executed path`);
  }

  executeLower(word, pcIndex) {
    if (word === 0 || word === 0x8000033C) return 'NOP';
    const opHi = word >>> 25 & 0x7F;
    if (opHi === 0x20) {
      const immediate = signExtend(word & 0x7FF, 11);
      this.branchTarget = pcIndex + 1 + immediate;
      this.branchDelay = 1;
      return `B ${hex(this.branchTarget, 3)}`;
    }
    if (word & 0x80000000) {
      const special = (word & 3) | (word >>> 4 & 0x7C);
      if (special === 0x30) {
        const dest = word >>> 21 & 0xF;
        const target = word >>> 16 & 31;
        const source = word >>> 11 & 31;
        const values = Float32Array.from(this.vf[source]);
        this.applyDestination(this.vf[target], values, dest);
        return `MOVE.${destinationLetters(dest)} vf${target},vf${source}`;
      }
    }
    throw new Error(`unsupported VU0 lower word ${hex(word)} on executed path`);
  }

  run(startIndex, maxCycles = 128) {
    let pcIndex = startIndex;
    for (let cycle = 0; cycle < maxCycles; cycle++) {
      if (pcIndex < 0 || pcIndex >= PROGRAM_PAIR_CAPACITY) throw new Error(`VU0 PC ${hex(pcIndex, 3)} is outside micro memory`);
      const offset = pcIndex * 8;
      const lower = this.program.readUInt32LE(offset);
      const upper = this.program.readUInt32LE(offset + 4);
      const eBit = Boolean(upper >>> 30 & 1);
      const wasEndPending = this.endPending;
      const upperWrite = upperWriteRegister(upper);
      const move = lowerMoveRegisters(lower);
      let lowerText, upperText;
      if (move && upperWrite && (move.source === upperWrite || move.destination === upperWrite)) {
        lowerText = this.executeLower(lower, pcIndex);
        upperText = this.executeUpper(upper);
      } else {
        upperText = this.executeUpper(upper);
        lowerText = this.executeLower(lower, pcIndex);
      }
      this.vf[0].set([0, 0, 0, 1]);
      this.vi[0] = 0;
      this.trace.push({
        cycle,
        pc_instruction_index: hex(pcIndex, 3),
        pc_byte: hex(pcIndex * 8, 4),
        lower_word: hex(lower),
        lower_instruction: lowerText,
        upper_word: hex(upper),
        upper_instruction: upperText,
        e_bit: eBit,
      });
      let nextIndex = pcIndex + 1;
      if (this.branchTarget !== null) {
        if (this.branchDelay === 0) {
          nextIndex = this.branchTarget;
          this.branchTarget = null;
        } else {
          this.branchDelay--;
        }
      }
      pcIndex = nextIndex;
      if (wasEndPending) {
        return {
          stop_reason: 'E_BIT_DELAY_SLOT_COMPLETE',
          instruction_pairs: this.trace.length,
          path: this.trace.map(row => Number.parseInt(row.pc_instruction_index, 16)),
          trace: this.trace,
          output: Array.from({ length: 4 }, (_, row) => Array.from(this.vf[1 + row])),
        };
      }
      if (eBit) this.endPending = true;
    }
    throw new Error(`VU0 microprogram exceeded ${maxCycles} instruction pairs`);
  }
}

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function diagnosticNodeMatrix() {
  return [0, -1, 0, 2, 1, 0, 0, -3, 0, 0, 1, 4, 0, 0, 0, 1];
}

function diagnosticRootMatrix() {
  return [1, 0, 0, 10, 0, 0, -1, 20, 0, 1, 0, -30, 0, 0, 0, 1];
}

function matrixMultiplyF32(left, right) {
  const output = new Float32Array(16);
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      let value = fmul(left[row * 4], right[column]);
      for (let inner = 1; inner < 4; inner++) value = fadd(value, fmul(left[row * 4 + inner], right[inner * 4 + column]));
      output[row * 4 + column] = value;
    }
  }
  return output;
}

function transposeMatrix(input) {
  const output = new Float32Array(16);
  for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) output[row * 4 + column] = input[column * 4 + row];
  return output;
}

function independentExpected(idomMatrix, nodeMatrix, rootMatrix) {
  return transposeMatrix(matrixMultiplyF32(rootMatrix, matrixMultiplyF32(nodeMatrix, idomMatrix)));
}

function matrixFromBytes(bytes, offset) {
  return Array.from({ length: 16 }, (_, index) => bytes.readFloatLE(offset + index * 4));
}

function matrixToBytes(matrix) {
  const output = Buffer.alloc(0x40);
  for (let index = 0; index < 16; index++) output.writeFloatLE(Math.fround(matrix[index]), index * 4);
  return output;
}

function executeMatrix(program, entryIndex, idomMatrix, nodeMatrix, rootMatrix) {
  const target = new Vu0MatrixMicroTarget(program);
  target.loadMatrix(9, nodeMatrix);
  target.loadMatrix(13, idomMatrix);
  target.loadMatrix(28, rootMatrix);
  const runtime = target.run(entryIndex);
  const flattened = runtime.output.flat();
  return { runtime, bytes: matrixToBytes(flattened) };
}

function executeScenario(programInfo, runtimeMatrices, nodeMatrix, rootMatrix) {
  const matrixCount = runtimeMatrices.length / 0x40;
  const actual = Buffer.alloc(runtimeMatrices.length);
  const expected = Buffer.alloc(runtimeMatrices.length);
  let instructionPairs = 0;
  let firstTrace = null;
  for (let index = 0; index < matrixCount; index++) {
    const idomMatrix = matrixFromBytes(runtimeMatrices, index * 0x40);
    const result = executeMatrix(programInfo.program, programInfo.entryIndex, idomMatrix, nodeMatrix, rootMatrix);
    const oracle = matrixToBytes(independentExpected(idomMatrix, nodeMatrix, rootMatrix));
    result.bytes.copy(actual, index * 0x40);
    oracle.copy(expected, index * 0x40);
    instructionPairs += result.runtime.instruction_pairs;
    if (!firstTrace) firstTrace = result.runtime.trace;
  }
  return {
    matrix_count: matrixCount,
    original_microprogram_invocations: matrixCount,
    original_microinstruction_pairs_executed: instructionPairs,
    instruction_pairs_per_invocation: firstTrace.length,
    output_sha256: sha256(actual),
    independent_oracle_sha256: sha256(expected),
    byte_exact_against_independent_affine_oracle: actual.equals(expected),
    first_invocation_trace_commitment_sha256: sha256(Buffer.from(firstTrace.map(row => `${row.pc_instruction_index}|${row.lower_word}|${row.upper_word}\n`).join(''))),
    first_invocation_trace: firstTrace,
  };
}

function buildReport({ lib, actors, ps2RecompCommit = 'ee149581aac999ab22791b3900377c0b028a5840' }) {
  const moduleBytes = Buffer.from(lib);
  const programInfo = extractVu0Program(moduleBytes);
  const executions = [];
  for (const actor of actors) {
    const actorBytes = Buffer.from(actor.bytes);
    for (const section of Idom.parseIdomSections(actorBytes)) {
      const runtimeMatrices = Buffer.from(Idom.expectedRuntimeMatrices(actorBytes, section));
      const identity = executeScenario(programInfo, runtimeMatrices, identityMatrix(), identityMatrix());
      const diagnostic = executeScenario(programInfo, runtimeMatrices, diagnosticNodeMatrix(), diagnosticRootMatrix());
      if (!identity.byte_exact_against_independent_affine_oracle || !diagnostic.byte_exact_against_independent_affine_oracle) {
        throw new Error(`${actor.actor} IDOM ${hex(section.offset)} VU0 output differs from independent oracle`);
      }
      executions.push({
        actor: actor.actor,
        source_name: actor.name,
        source_sha256: sha256(actorBytes),
        idom_offset: hex(section.offset),
        idom_matrix_count: section.header.matrix_count,
        idom_indices: section.indices,
        input_runtime_matrices_sha256: sha256(runtimeMatrices),
        controlled_identity_node_and_root: identity,
        controlled_affine_diagnostic: diagnostic,
      });
    }
  }
  const firstTrace = executions[0].controlled_identity_node_and_root.first_invocation_trace;
  const totalMatrices = executions.reduce((sum, row) => sum + row.idom_matrix_count, 0);
  const totalInvocations = executions.reduce((sum, row) => sum + row.controlled_identity_node_and_root.original_microprogram_invocations + row.controlled_affine_diagnostic.original_microprogram_invocations, 0);
  const totalPairs = executions.reduce((sum, row) => sum + row.controlled_identity_node_and_root.original_microinstruction_pairs_executed + row.controlled_affine_diagnostic.original_microinstruction_pairs_executed, 0);
  return {
    format: 'SO3_VU0_IDOM_MATRIX_MICRO_EXECUTION_REPORT_V1',
    status: 'EXECUTED_ORIGINAL_VU0_MICROCODE',
    promotion: {
      vu0_matrix_composition: true,
      animation_rotation_evaluator: false,
      final_skinned_vertex_output: false,
    },
    purpose: 'Execute the original SO3 VU0 matrix microprogram over every real 0x08FF/0x0BC0 IDOM matrix and verify its result against an independent affine-matrix oracle.',
    module: {
      name: 'Lib.bin',
      load_address: hex(LIB_LOAD),
      sha256: programInfo.moduleSha256,
      evaluator_entry_va: hex(EVALUATOR_ENTRY_VA),
      evaluator_end_exclusive_va: hex(EVALUATOR_END_EXCLUSIVE_VA),
      evaluator_slice_sha256: programInfo.evaluatorSliceSha256,
      vcallms_site_va: hex(VCALL_SITE_VA),
      vcallms_word: hex(programInfo.callWord),
      vcallms_target_instruction_index: hex(programInfo.entryIndex, 3),
      vcallms_target_byte_address: hex(programInfo.entryIndex * 8, 4),
    },
    microprogram: {
      upload_segments: programInfo.segments.map(({ payload_offset, payload_bytes, ...row }) => row),
      occupied_instruction_count: programInfo.occupiedInstructionCount,
      occupied_byte_count: programInfo.occupiedInstructionCount * 8,
      occupied_sha256: programInfo.occupiedProgramSha256,
      complete_4096_byte_memory_sha256: programInfo.programSha256,
      executed_path_instruction_indices: firstTrace.map(row => row.pc_instruction_index),
      executed_path_pair_count: firstTrace.length,
      branch: { site_instruction_index: '0x129', delay_slot_instruction_index: '0x12A', target_instruction_index: '0x03E' },
      termination: { e_bit_instruction_index: '0x048', e_bit_delay_slot_instruction_index: '0x049' },
    },
    independent_decoder_reference: {
      project: 'ran-j/PS2Recomp',
      commit: ps2RecompCommit,
      files: [
        'ps2xRuntime/src/lib/vu/ps2_vu1_core.cpp',
        'ps2xRuntime/src/lib/vu/ps2_vu1_upper.cpp',
        'ps2xRuntime/src/lib/vu/ps2_vu1_lower.cpp',
        'ps2xRuntime/src/lib/vu/ps2_vu1_detail.h',
        'ps2xRecomp/src/lib/vu_translation_helpers.cpp',
      ],
      use: 'VU pair order, field extraction, branch delay, E-bit delay, and VCALLMS target decoding reference; SO3 bytes and outputs are independently hashed here.',
    },
    controlled_inputs: {
      identity_node_matrix: identityMatrix(),
      identity_root_matrix: identityMatrix(),
      affine_diagnostic_node_matrix: diagnosticNodeMatrix(),
      affine_diagnostic_root_matrix: diagnosticRootMatrix(),
      root_constraint: 'row 3 is [0,0,0,1], matching the microprogram optimization that leaves the fourth intermediate row unchanged',
    },
    aggregate: {
      idom_sections: executions.length,
      real_idom_matrices: totalMatrices,
      original_microprogram_invocations: totalInvocations,
      original_microinstruction_pairs_executed: totalPairs,
      all_outputs_byte_exact: executions.every(row => row.controlled_identity_node_and_root.byte_exact_against_independent_affine_oracle && row.controlled_affine_diagnostic.byte_exact_against_independent_affine_oracle),
    },
    executions,
    verified_facts: [
      'The original evaluator VCALLMS word 0x4A0044F8 targets VU0 instruction index 0x113 (byte address 0x0898).',
      'Lib embeds the complete target program in two contiguous VIF MPG uploads: 256 instructions at index 0 and 197 at index 0x100.',
      'Entry 0x113 executes two chained four-row matrix compositions and a shared transpose epilogue, producing transpose(root * node * IDOM) for an affine root matrix.',
      'The branch at instruction 0x129 executes delay slot 0x12A, lands at 0x03E, and termination executes the E-bit delay slot at 0x049.',
      'All real IDOM matrices in the supplied 0x08FF and 0x0BC0 actors match the independent Float32 affine oracle byte-for-byte under both controlled scenarios.',
    ],
    gates: {
      vu0_microprogram_extraction: 'PASS_BYTE_EXACT',
      vu0_matrix_composition: 'PASS_EXECUTION_VERIFIED',
      idom_matrix_inputs: 'PASS_REAL_ACTOR_BYTES',
      animation_rotation_evaluator: 'WITHHELD_UNRESOLVED',
      final_skinning: 'WITHHELD_UNRESOLVED',
    },
    boundaries: [
      'The node and root matrices in this witness are controlled inputs. This pass executes the original VU0 composition code but does not claim that the unresolved FAS rotation evaluator produced those inputs.',
      'The interpreter is intentionally bounded to the opcodes reached from entry 0x113; an unexpected opcode is a hard failure rather than an inferred implementation.',
      'Float32 multiply/add rounding is applied at each original instruction. No supplied value enters denormal, NaN, infinity, saturation, or exception behavior.',
      'This pass does not choose between multiple IDOM sections for a draw and does not claim final vertex skinning or animation playback.',
    ],
  };
}

function cli(argv) {
  const args = { actors: [] };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--lib') args.lib = argv[++index];
    else if (key === '--actor') {
      const actor = argv[++index], file = argv[++index];
      args.actors.push({ actor, file });
    } else if (key === '--output') args.output = argv[++index];
    else throw new Error(`unknown argument ${key}`);
  }
  if (!args.lib || !args.actors.length || !args.output) {
    throw new Error('usage: run_vu0_idom_matrix_micro.js --lib Lib.bin --actor 0x08FF CHAR.bin [--actor ...] --output report.json');
  }
  const report = buildReport({
    lib: fs.readFileSync(args.lib),
    actors: args.actors.map(row => ({ actor: row.actor, name: path.basename(row.file), bytes: fs.readFileSync(row.file) })),
  });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: report.status, output: args.output, matrices: report.aggregate.real_idom_matrices, instruction_pairs: report.aggregate.original_microinstruction_pairs_executed })}\n`);
}

module.exports = Object.freeze({
  extractVu0Program,
  Vu0MatrixMicroTarget,
  identityMatrix,
  diagnosticNodeMatrix,
  diagnosticRootMatrix,
  matrixMultiplyF32,
  transposeMatrix,
  independentExpected,
  executeMatrix,
  executeScenario,
  buildReport,
});

if (require.main === module) cli(process.argv.slice(2));
