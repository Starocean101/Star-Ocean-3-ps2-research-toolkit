#!/usr/bin/env node
/* Bridge fully executed FAS type-0x0135 quaternions into SO3's original VU0
 * IDOM matrix compositor. Quaternion-to-local-matrix construction remains a
 * named modeled boundary until the runtime node setter/matrix writer executes.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Geometry = require('./v5_1_geometry.js');
const Rotation = require('./run_fas_rotation_r5900.js');
const Idom = require('./run_idom_loader_r5900.js');
const Vu0 = require('./run_vu0_idom_matrix_micro.js');

function sha256(input) {
  return crypto.createHash('sha256').update(Buffer.from(input)).digest('hex');
}

function hex(value, width = 8) {
  return `0x${Number(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

function f32(value) { return Math.fround(value); }
function fmul(a, b) { return f32(f32(a) * f32(b)); }
function fsub(a, b) { return f32(f32(a) - f32(b)); }
function fadd(a, b) { return f32(f32(a) + f32(b)); }

function quaternionTranslationMatrix(quaternion, translation) {
  const [x, y, z, w] = quaternion.map(f32);
  const xx = fmul(x, x), yy = fmul(y, y), zz = fmul(z, z);
  const xy = fmul(x, y), xz = fmul(x, z), yz = fmul(y, z);
  const wx = fmul(w, x), wy = fmul(w, y), wz = fmul(w, z);
  const twice = value => fadd(value, value);
  return [
    fsub(1, twice(fadd(yy, zz))), twice(fsub(xy, wz)), twice(fadd(xz, wy)), f32(translation[0]),
    twice(fadd(xy, wz)), fsub(1, twice(fadd(xx, zz))), twice(fsub(yz, wx)), f32(translation[1]),
    twice(fsub(xz, wy)), twice(fadd(yz, wx)), fsub(1, twice(fadd(xx, yy))), f32(translation[2]),
    0, 0, 0, 1,
  ];
}

function matrixBytes(matrix) {
  const output = Buffer.alloc(0x40);
  matrix.forEach((value, index) => output.writeFloatLE(f32(value), index * 4));
  return output;
}

function matrixFromBytes(bytes, offset) {
  return Array.from({ length: 16 }, (_, index) => bytes.readFloatLE(offset + index * 4));
}

function identityMatrix() {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
}

function findRotationTrack(fasBytes, nodeName) {
  const parsed = Geometry.parseFas(fasBytes);
  const channel = parsed.channels.find(row => row.name === nodeName);
  const sub = channel && channel.subs.find(row => row.type === 0x135);
  if (!channel || !sub) throw new Error(`FAS has no type-0x0135 channel named ${nodeName}`);
  return { channel, keys: sub.quantized };
}

function findRtaNode(rtaBytes, nodeName) {
  const parsed = Geometry.parseRta(rtaBytes);
  const node = parsed.nodes.find(row => row.name === nodeName);
  if (!node) throw new Error(`RTA has no node named ${nodeName}`);
  return node;
}

function numericHex(value) {
  return typeof value === 'number' ? value : Number.parseInt(String(value), 16);
}

function buildReport({ lib: libInput, actors, identityBridge }) {
  const lib = Buffer.from(libInput), program = Vu0.extractVu0Program(lib), executions = [];
  for (const actor of actors) {
    const char = Buffer.from(actor.char), rta = Buffer.from(actor.rta), fas = Buffer.from(actor.fas);
    const track = findRotationTrack(fas, actor.nodeName);
    const rtaNode = findRtaNode(rta, actor.nodeName);
    const actorBridge = identityBridge.actors.find(row => row.actor === actor.actor);
    if (!actorBridge) throw new Error(`identity report has no ${actor.actor}`);
    const sections = Idom.parseIdomSections(char);
    for (const palette of actorBridge.idom_palettes) {
      const slot = palette.slots.find(row => row.name === actor.nodeName && row.rta_name_exact_match);
      if (!slot) continue;
      const sectionOffset = numericHex(palette.file_offset);
      const section = sections.find(row => row.offset === sectionOffset);
      if (!section) throw new Error(`${actor.actor} IDOM ${palette.file_offset} is absent`);
      if (slot.palette_slot >= section.header.matrix_count) throw new Error(`${actor.actor} palette slot exceeds IDOM count`);
      const runtimeMatrices = Buffer.from(Idom.expectedRuntimeMatrices(char, section));
      const idomMatrix = matrixFromBytes(runtimeMatrices, slot.palette_slot * 0x40);
      const sampleTimes = [
        { kind: 'TERMINAL_ORIGINAL_EXECUTION', time: track.keys.at(-1).time },
        { kind: 'BETWEEN_KEY_ORIGINAL_INTERPOLATION', time: f32((track.keys[0].time + track.keys[1].time) / 2) },
      ];
      for (const sample of sampleTimes) {
        const rotation = Rotation.executeTrack(lib, track.keys, sample.time, { traceLimit: 0 });
        const nodeMatrix = quaternionTranslationMatrix(rotation.quaternion, rtaNode.translation);
        const composed = Vu0.executeMatrix(program.program, program.entryIndex, idomMatrix, nodeMatrix, identityMatrix());
        const expectedMatrix = Vu0.independentExpected(idomMatrix, nodeMatrix, identityMatrix());
        const expectedBytes = matrixBytes(expectedMatrix);
        const exact = composed.bytes.equals(expectedBytes);
        if (!exact) throw new Error(`${actor.actor} ${actor.nodeName} VU0 output differs from independent affine oracle`);
        executions.push({
          actor: actor.actor,
          node_name: actor.nodeName,
          fas_source_name: actor.fasName,
          fas_source_sha256: sha256(fas),
          rta_source_name: actor.rtaName,
          rta_source_sha256: sha256(rta),
          char_source_name: actor.charName,
          char_source_sha256: sha256(char),
          idom_offset: hex(section.offset),
          idom_palette_slot: slot.palette_slot,
          fss_descriptor_index: slot.fss_descriptor_index,
          rta_ordinal: slot.rta_name_ordinal,
          rta_translation: rtaNode.translation,
          sample_kind: sample.kind,
          animation_time: sample.time,
          rotation_evaluator: {
            instruction_count: rotation.instruction_count,
            original_interpolator_calls: rotation.original_interpolator_calls,
            original_acos_helper_calls: rotation.original_acos_helper_calls,
            original_sine_helper_calls: rotation.original_sine_helper_calls,
            original_vu0_microprogram_calls: rotation.original_vu0_microprogram_calls.length,
            original_vu0_microinstruction_pairs: rotation.original_vu0_microinstruction_pairs,
            host_model_calls: rotation.host_model_calls,
            quaternion: rotation.quaternion,
            quaternion_norm: rotation.norm,
            quaternion_sha256: rotation.quaternion_sha256,
          },
          modeled_quaternion_translation_matrix: nodeMatrix,
          idom_matrix_sha256: sha256(matrixBytes(idomMatrix)),
          original_vu0: {
            entry_instruction_index: hex(program.entryIndex, 3),
            instruction_pairs: composed.runtime.instruction_pairs,
            output_sha256: sha256(composed.bytes),
            independent_affine_oracle_sha256: sha256(expectedBytes),
            byte_exact_against_independent_affine_oracle: exact,
          },
        });
      }
    }
  }
  const terminal = executions.filter(row => row.sample_kind === 'TERMINAL_ORIGINAL_EXECUTION');
  const between = executions.filter(row => row.sample_kind === 'BETWEEN_KEY_ORIGINAL_INTERPOLATION');
  return {
    format: 'SO3_FAS_ROTATION_TO_VU0_MATRIX_BRIDGE_REPORT_V2',
    status: 'HYBRID_BRIDGE_EXECUTED_WITH_EXPLICIT_MODELED_NODE_MATRIX_BOUNDARY',
    promotion: { fas_terminal_quaternion: true, fas_between_key_interpolation: true, vu0_matrix_composition: true, quaternion_to_runtime_node_matrix: false, final_skinning: false },
    purpose: 'Demonstrate that terminal and between-key quaternions produced entirely by the original FAS evaluator/helpers can be carried through the verified actor-scoped FSS/IDOM/RTA identity bridge and the original SO3 VU0 matrix compositor.',
    module: {
      lib_sha256: sha256(lib),
      rotation_evaluator_va: hex(Rotation.ENTRY),
      vu0_program_entry_instruction_index: hex(program.entryIndex, 3),
      vu0_program_sha256: program.occupiedProgramSha256,
    },
    aggregate: {
      actors: new Set(executions.map(row => row.actor)).size,
      actor_idom_slot_paths: terminal.length,
      terminal_original_rotation_paths: terminal.length,
      between_key_original_interpolation_paths: between.length,
      original_rotation_guest_instructions: executions.reduce((sum, row) => sum + row.rotation_evaluator.instruction_count, 0),
      original_rotation_vu0_microprogram_calls: executions.reduce((sum, row) => sum + row.rotation_evaluator.original_vu0_microprogram_calls, 0),
      original_rotation_vu0_microinstruction_pairs: executions.reduce((sum, row) => sum + row.rotation_evaluator.original_vu0_microinstruction_pairs, 0),
      original_vu0_instruction_pairs: executions.reduce((sum, row) => sum + row.original_vu0.instruction_pairs, 0),
      all_vu0_outputs_byte_exact_against_independent_affine_oracle: executions.every(row => row.original_vu0.byte_exact_against_independent_affine_oracle),
      all_terminal_paths_skip_original_interpolator: terminal.every(row => row.rotation_evaluator.original_interpolator_calls === 0),
      all_between_key_paths_call_original_interpolator_once: between.every(row => row.rotation_evaluator.original_interpolator_calls === 1),
      all_paths_have_zero_host_model_calls_in_rotation_evaluator: executions.every(row => row.rotation_evaluator.host_model_calls === 0),
    },
    executions,
    gates: {
      fas_terminal_rotation: 'PASS_EXECUTED_ORIGINAL_R5900_VU0_MACRO',
      fas_between_key_interpolation: 'PASS_EXECUTED_ORIGINAL_R5900_VU0_MACRO_AND_MICROCODE',
      fss_idom_rta_node_identity: 'PASS_EXISTING_BYTE_EXACT_ACTOR_SCOPED_BRIDGE',
      quaternion_to_node_matrix: 'PARTIAL_MODELED_STANDARD_QUATERNION_AFFINE_CONSTRUCTION',
      vu0_idom_matrix_composition: 'PASS_EXECUTED_ORIGINAL_VU0_MICROCODE_BYTE_EXACT',
      final_skinning: 'WITHHELD_UNRESOLVED',
    },
    boundaries: [
      'The terminal-key quaternion comes from original R5900 and VU0 macro instructions and correctly skips the interpolation helper.',
      'The between-key quaternion executes original 0x004CD310/0x004CCF80 code and, when selected by the original branch, 0x004CD230 plus its embedded VU0 entries. No host interpolation call remains.',
      'FSS descriptor name, RTA name, and IDOM palette slot are taken from the previously verified byte-exact actor-scoped identity report.',
      'Quaternion plus RTA translation is converted to a conventional row-major affine matrix by modeled host code. This is not claimed to be the still-unexecuted runtime node matrix writer.',
      'The resulting node matrix is composed with the real IDOM matrix by the original VU0 program and is byte-exact against the independent float32 affine oracle.',
      'No final vertex skinning is claimed.',
    ],
  };
}

function cli(argv) {
  const args = { actors: [] };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--lib') args.lib = argv[++index];
    else if (key === '--identity') args.identity = argv[++index];
    else if (key === '--actor') args.actors.push({ actor: argv[++index], nodeName: argv[++index], charFile: argv[++index], rtaFile: argv[++index], fasFile: argv[++index] });
    else if (key === '--output') args.output = argv[++index];
    else throw new Error(`unknown argument ${key}`);
  }
  if (!args.lib || !args.identity || !args.actors.length || !args.output) throw new Error('usage: run_fas_rotation_matrix_bridge.js --lib Lib.bin --identity bridge.json --actor 0x0BC0 "Bip01 L Calf" CHAR.bin RTA.rta FAS.fas --output report.json');
  const report = buildReport({
    lib: fs.readFileSync(args.lib),
    identityBridge: JSON.parse(fs.readFileSync(args.identity, 'utf8')),
    actors: args.actors.map(row => ({
      actor: row.actor, nodeName: row.nodeName,
      char: fs.readFileSync(row.charFile), charName: path.basename(row.charFile),
      rta: fs.readFileSync(row.rtaFile), rtaName: path.basename(row.rtaFile),
      fas: fs.readFileSync(row.fasFile), fasName: path.basename(row.fasFile),
    })),
  });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: report.status, output: args.output, paths: report.executions.length, vu0_pairs: report.aggregate.original_vu0_instruction_pairs })}\n`);
}

module.exports = Object.freeze({ quaternionTranslationMatrix, matrixBytes, buildReport });

if (require.main === module) cli(process.argv.slice(2));
