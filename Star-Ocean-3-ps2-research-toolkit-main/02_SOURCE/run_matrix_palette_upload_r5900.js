#!/usr/bin/env node
'use strict';

/* Execute the original Lib.bin R5900 instructions that emit the actor matrix
 * palette DMA/VIF packet.  The slice has no service calls and therefore needs
 * no BIOS or allocator stubs.  Pointer values are controlled inputs; command
 * construction and all packet writes are guest instructions from Lib.bin. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const V510 = require('./v510_targeted_runtime.js');
const Idom = require('./run_idom_loader_r5900.js');

const ENTRY = 0x004a53f8;
const STOP = 0x004a5478;
const ACTOR = 0x01000000;
const MANAGER = 0x01010000;
const SOURCE = 0x01020000;
const MATRIX_BUFFER = 0x01030000;
const PACKET = 0x01080000;
const MASK32 = 0xffffffffn;
const MASK64 = (1n << 64n) - 1n;
const REG = ['zero','at','v0','v1','a0','a1','a2','a3','t0','t1','t2','t3','t4','t5','t6','t7','s0','s1','s2','s3','s4','s5','s6','s7','t8','t9','k0','k1','gp','sp','fp','ra'];

function hex(value, width = 8) {
  const v = typeof value === 'bigint' ? value : BigInt(value >>> 0);
  return `0x${v.toString(16).toUpperCase().padStart(width, '0')}`;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sign16(value) {
  return value & 0x8000 ? value - 0x10000 : value;
}

function write32(memory, address, value) {
  memory.store(address >>> 0, BigInt(value >>> 0), 4);
}

function read32(memory, address) {
  return Number(memory.load(address >>> 0, 4)) >>> 0;
}

function read64(memory, address) {
  return memory.load(address >>> 0, 8) & MASK64;
}

class MatrixPacketR5900 {
  constructor(memory) {
    this.memory = memory;
    this.gpr = Array(32).fill(0n);
    this.hi = 0n;
    this.lo = 0n;
    this.pc = 0;
    this.steps = 0;
    this.trace = [];
    this.traceRows = [];
    this.writes = [];
    this.executedOpcodes = new Set();
  }

  r(index) { return index ? this.gpr[index] & MASK64 : 0n; }
  u32(index) { return Number(this.r(index) & MASK32) >>> 0; }
  set(index, value) { if (index) this.gpr[index] = BigInt(value) & MASK64; }
  address(base, immediate) { return (this.u32(base) + sign16(immediate)) >>> 0; }

  record(pc, word, instruction, delaySlot = false) {
    const row = { step: this.steps, pc: hex(pc), word: hex(word), instruction, delay_slot: Boolean(delaySlot) };
    this.trace.push(row);
    this.traceRows.push(`${row.step}|${row.pc}|${row.word}|${row.delay_slot ? 1 : 0}\n`);
    this.steps++;
  }

  store(pc, address, value, size) {
    const mask = (1n << BigInt(size * 8)) - 1n;
    const stored = BigInt(value) & mask;
    this.memory.store(address >>> 0, stored, size);
    this.writes.push({ pc: hex(pc), address: hex(address), size, value: hex(stored, size * 2) });
  }

  noncontrol(pc, word, delaySlot = false) {
    const op = word >>> 26;
    const rs = word >>> 21 & 31;
    const rt = word >>> 16 & 31;
    const rd = word >>> 11 & 31;
    const sa = word >>> 6 & 31;
    const fn = word & 63;
    const imm = word & 0xffff;
    let text;
    if (word === 0) {
      text = 'nop';
    } else if (op === 0) {
      if (fn === 0x00) {
        this.set(rd, BigInt((this.u32(rt) << sa) >>> 0));
        text = `sll ${REG[rd]},${REG[rt]},${sa}`;
      } else if (fn === 0x18) {
        const lhs = BigInt(this.u32(rs));
        const rhs = BigInt(this.u32(rt));
        const product = lhs * rhs;
        this.lo = product & MASK32;
        this.hi = product >> 32n & MASK32;
        this.set(rd, this.lo);
        text = `mult ${REG[rd]},${REG[rs]},${REG[rt]}`;
      } else if (fn === 0x21 || fn === 0x2d) {
        this.set(rd, this.r(rs) + this.r(rt));
        text = `${fn === 0x21 ? 'addu' : 'daddu'} ${REG[rd]},${REG[rs]},${REG[rt]}`;
      } else if (fn === 0x25) {
        this.set(rd, this.r(rs) | this.r(rt));
        text = `or ${REG[rd]},${REG[rs]},${REG[rt]}`;
      } else if (fn === 0x3c) {
        this.set(rd, this.r(rt) << BigInt(sa + 32));
        text = `dsll32 ${REG[rd]},${REG[rt]},${sa}`;
      } else if (fn === 0x3e) {
        this.set(rd, this.r(rt) >> BigInt(sa + 32));
        text = `dsrl32 ${REG[rd]},${REG[rt]},${sa}`;
      } else {
        throw new Error(`unsupported SPECIAL fn ${hex(fn, 2)} at ${hex(pc)} (${hex(word)})`);
      }
      this.executedOpcodes.add(`SPECIAL:${hex(fn, 2)}`);
    } else if (op === 0x09) {
      this.set(rt, BigInt((this.u32(rs) + sign16(imm)) >>> 0));
      text = `addiu ${REG[rt]},${REG[rs]},${sign16(imm)}`;
      this.executedOpcodes.add(`OP:${hex(op, 2)}`);
    } else if (op === 0x0d) {
      this.set(rt, this.r(rs) | BigInt(imm));
      text = `ori ${REG[rt]},${REG[rs]},${hex(imm, 4)}`;
      this.executedOpcodes.add(`OP:${hex(op, 2)}`);
    } else if (op === 0x0f) {
      this.set(rt, BigInt((imm << 16) >>> 0));
      text = `lui ${REG[rt]},${hex(imm, 4)}`;
      this.executedOpcodes.add(`OP:${hex(op, 2)}`);
    } else if (op === 0x23 || op === 0x24) {
      const address = this.address(rs, imm);
      const size = op === 0x23 ? 4 : 1;
      this.set(rt, this.memory.load(address, size));
      text = `${op === 0x23 ? 'lw' : 'lbu'} ${REG[rt]},${sign16(imm)}(${REG[rs]})`;
      this.executedOpcodes.add(`OP:${hex(op, 2)}`);
    } else if (op === 0x2b || op === 0x3f || op === 0x1f) {
      const address = this.address(rs, imm);
      const size = op === 0x2b ? 4 : op === 0x3f ? 8 : 16;
      this.store(pc, address, this.r(rt), size);
      text = `${op === 0x2b ? 'sw' : op === 0x3f ? 'sd' : 'sq'} ${REG[rt]},${sign16(imm)}(${REG[rs]})`;
      this.executedOpcodes.add(`OP:${hex(op, 2)}`);
    } else {
      throw new Error(`unsupported opcode ${hex(op, 2)} at ${hex(pc)} (${hex(word)})`);
    }
    this.record(pc, word, text, delaySlot);
  }

  delay(pc) {
    const word = read32(this.memory, pc);
    const op = word >>> 26;
    const fn = word & 63;
    if ([1,2,3,4,5,6,7].includes(op) || op === 0 && [8,9].includes(fn)) {
      throw new Error(`control transfer in delay slot at ${hex(pc)}`);
    }
    this.noncontrol(pc, word, true);
  }

  run(start, stop, maxSteps = 128) {
    this.pc = start >>> 0;
    while (this.steps < maxSteps) {
      if (this.pc === (stop >>> 0)) return 'STOP_PC';
      const pc = this.pc;
      const word = read32(this.memory, pc);
      const op = word >>> 26;
      const rs = word >>> 21 & 31;
      const rt = word >>> 16 & 31;
      const imm = word & 0xffff;
      if (op === 4 || op === 5) {
        const target = (pc + 4 + (sign16(imm) << 2)) >>> 0;
        const taken = op === 4 ? this.r(rs) === this.r(rt) : this.r(rs) !== this.r(rt);
        this.record(pc, word, `${op === 4 ? 'beq' : 'bne'} -> ${hex(target)} (${taken ? 'taken' : 'not taken'})`);
        this.delay(pc + 4);
        this.pc = taken ? target : pc + 8;
      } else {
        this.noncontrol(pc, word);
        this.pc = pc + 4;
      }
    }
    throw new Error(`instruction limit ${maxSteps} reached before ${hex(stop)}`);
  }
}

function parseRta(bytes, label) {
  if (bytes.length < 0x40 || bytes.toString('ascii', 0, 4) !== 'RTA\0') throw new Error(`${label}: expected RTA`);
  const declaredSize = bytes.readUInt32LE(4);
  const version = bytes.readUInt16LE(0x10);
  const nodeCount = bytes.readUInt16LE(0x12);
  const matrixCount = bytes.readUInt32LE(0x14);
  const namesOffset = bytes.readUInt32LE(0x18);
  const paletteOffset = bytes.readUInt32LE(0x1c);
  if (declaredSize !== bytes.length) throw new Error(`${label}: declared ${declaredSize}, have ${bytes.length}`);
  if (0x40 + nodeCount * 0x20 > bytes.length) throw new Error(`${label}: node table truncated`);
  if (paletteOffset + 0x10 + matrixCount * 0x20 > bytes.length) throw new Error(`${label}: matrix-palette table truncated`);
  const roots = [];
  for (let i = 0; i < nodeCount; i++) if (bytes.readUInt16LE(0x40 + i * 0x20 + 0x0e) === 0xffff) roots.push(i);
  const paletteRecords = [];
  for (let i = 0; i < matrixCount; i++) {
    const off = paletteOffset + 0x10 + i * 0x20;
    const encoded = bytes.readUInt32LE(off + 0x0c);
    paletteRecords.push({
      record: i,
      offset: hex(off),
      encoded_word: hex(encoded),
      matrix_slot: encoded >>> 16 & 0xff,
      fixed_mask_valid: ((encoded & 0xff00ffff) >>> 0) === 0x80000020,
    });
  }
  const slots = paletteRecords.map((row) => row.matrix_slot);
  const permutation = slots.length === new Set(slots).size && slots.slice().sort((a, b) => a - b).every((slot, index) => slot === index);
  return {
    label,
    sha256: sha256(bytes),
    byte_size: bytes.length,
    declared_size: declaredSize,
    version,
    node_count: nodeCount,
    matrix_count: matrixCount,
    names_offset: hex(namesOffset),
    matrix_palette_offset: hex(paletteOffset),
    root_record_indices: roots,
    node_minus_matrix_count: nodeCount - matrixCount,
    matrix_slot_words_all_match_mask: paletteRecords.every((row) => row.fixed_mask_valid),
    matrix_slots_form_exact_permutation: permutation,
    matrix_palette_records: paletteRecords,
  };
}

function executeCase(moduleBytes, sourceBytes, sourceInfo, bufferSelector) {
  const memory = new V510.SparseMemory();
  const moduleInfo = V510.loadModule(moduleBytes, memory, 'Lib.bin');
  memory.map(ACTOR, new Uint8Array(0x1000), 'controlled_actor_state');
  memory.map(MANAGER, new Uint8Array(0x1000), 'controlled_matrix_manager');
  memory.map(SOURCE, sourceBytes, `${sourceInfo.label}:CHAR`);
  memory.map(MATRIX_BUFFER, new Uint8Array(0x5000), 'controlled_double_buffered_matrix_palette');
  memory.map(PACKET, new Uint8Array(0x1000), 'output_DMA_VIF_packet');
  write32(memory, ACTOR + 0x638, MANAGER);
  write32(memory, MANAGER + 0x34, SOURCE + sourceInfo.idom_offset + 0x10);
  write32(memory, MANAGER + 0x4c, MATRIX_BUFFER);
  memory.store(MANAGER + 0x50, BigInt(bufferSelector & 0xff), 1);

  const cpu = new MatrixPacketR5900(memory);
  cpu.set(16, PACKET); // s0: packet cursor
  cpu.set(18, ACTOR);  // s2: actor state
  const stopReason = cpu.run(ENTRY, STOP);
  const count = sourceInfo.matrix_count;
  const qwc = count * 4;
  const vif = (0x6c000290 | count << 18) >>> 0;
  const source = (MATRIX_BUFFER + count * bufferSelector * 64 + 0x40) >>> 0;
  const dmaTag = BigInt(source) << 32n | BigInt((0x30000000 | qwc) >>> 0);
  const packet = Buffer.from(memory.read(PACKET, 0x30));
  const actual = {
    first_tag: hex(read64(memory, PACKET), 16),
    vif_word: hex(read32(memory, PACKET + 0x1c)),
    dma_source_tag: hex(read64(memory, PACKET + 0x20), 16),
    final_packet_cursor: hex(cpu.u32(16)),
  };
  const expected = {
    first_tag: hex(0x10000001n, 16),
    vif_word: hex(vif),
    vif_command: 'UNPACK_V4_32',
    vif_command_code: hex(vif >>> 24 & 0x7f, 2),
    vif_num: vif >>> 16 & 0xff,
    vif_destination_qword: hex(vif & 0x3ff, 3),
    dma_qwc: qwc,
    dma_source_address: hex(source),
    dma_source_tag: hex(dmaTag, 16),
    matrix_bytes_per_slot: 64,
    final_packet_cursor: hex(PACKET + 0x30),
  };
  const checks = {
    first_tag_exact: actual.first_tag === expected.first_tag,
    vif_word_exact: actual.vif_word === expected.vif_word,
    dma_source_tag_exact: actual.dma_source_tag === expected.dma_source_tag,
    final_cursor_exact: actual.final_packet_cursor === expected.final_packet_cursor,
    zero_reserved_qword: memory.read(PACKET + 0x10, 0x0c).every((value) => value === 0),
  };
  if (!Object.values(checks).every(Boolean)) throw new Error(`${sourceInfo.label}/buffer${bufferSelector}: guest packet mismatch`);
  return {
    actor: sourceInfo.actor,
    idom_offset: hex(sourceInfo.idom_offset),
    source_label: sourceInfo.label,
    buffer_selector: bufferSelector,
    matrix_count: count,
    stop_reason: stopReason,
    instruction_count: cpu.steps,
    expected,
    actual,
    checks,
    packet_hex: packet.toString('hex').match(/.{1,32}/g),
    packet_sha256: sha256(packet),
    executed_opcode_subset: [...cpu.executedOpcodes].sort(),
    trace_commitment_sha256: sha256(Buffer.from(cpu.traceRows.join(''), 'utf8')),
    trace_commitment_scheme: 'SHA-256 over UTF-8 rows step|PC|word|delay-slot for original mapped Lib.bin words',
    writes: cpu.writes,
    trace: cpu.trace,
    module: moduleInfo,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 3 || args.length > 4) {
    console.error('usage: run_matrix_palette_upload_r5900.js LIB_MWO3 CHAR_08FF CHAR_0BC0 [OUTPUT_JSON]');
    process.exit(2);
  }
  const [modulePath, char08Path, char0bPath, outputPath] = args;
  const moduleBytes = fs.readFileSync(modulePath);
  const actorSources = [
    { actor: 'actor_0x08FF', bytes: fs.readFileSync(char08Path), path: char08Path },
    { actor: 'actor_0x0BC0', bytes: fs.readFileSync(char0bPath), path: char0bPath },
  ];
  const idomRows = actorSources.flatMap(source => Idom.parseIdomSections(source.bytes).map(section => ({
    actor: source.actor,
    label: `${source.actor}:IDOM@${hex(section.offset)}`,
    source_path: path.basename(source.path),
    source_sha256: sha256(source.bytes),
    idom_offset: section.offset,
    matrix_count: section.header.matrix_count,
    index_table: section.indices,
    secondary_buffer_flag: section.header.secondary_buffer_flag,
    source_bytes: source.bytes,
  })));
  const executions = [];
  for (const row of idomRows) for (const selector of [0, 1]) executions.push(executeCase(moduleBytes, row.source_bytes, row, selector));
  const load = moduleBytes.readUInt32LE(8);
  const startOff = ENTRY - load;
  const routineBytes = moduleBytes.subarray(startOff, startOff + STOP - ENTRY);
  const report = {
    format: 'SO3_MATRIX_PALETTE_R5900_EXECUTION_REPORT_V1',
    status: 'PASS_EXECUTED_ORIGINAL_R5900_SLICE',
    created: new Date().toISOString(),
    engine_module: {
      path: path.basename(modulePath),
      sha256: sha256(moduleBytes),
      byte_size: moduleBytes.length,
      load_address: hex(load),
    },
    routine: {
      entry_va: hex(ENTRY),
      stop_va_exclusive: hex(STOP),
      module_file_offset: hex(startOff),
      byte_size: routineBytes.length,
      sha256: sha256(routineBytes),
      external_stubs: [],
      kind: 'ORIGINAL_LIB_R5900_INSTRUCTION_EXECUTION',
    },
    idom_inputs: idomRows.map(({ source_bytes, ...row }) => ({ ...row, idom_offset: hex(row.idom_offset) })),
    executions,
    proven: [
      'The original Lib.bin instructions read matrix_count from the active IDOM payload pointer at manager+0x34, payload+4.',
      'The emitted VIF command is 0x6C000290 | (matrix_count << 18): UNPACK V4-32 to VU1 qword 0x290 with four qwords per matrix.',
      'The DMA QWC is matrix_count*4 and the selected source buffer advances by matrix_count*64 bytes.',
      'The supplied 0x08FF CHAR has IDOM counts 32 and 19; the supplied 0x0BC0 CHAR has two IDOM sections with count 22. Each is executed separately without inferring which manager is active for a particular draw.',
    ],
    boundaries: [
      'This executes the packet-construction slice only; it does not execute the upstream animation evaluator that fills the matrix buffer.',
      'Actor, manager, packet, and matrix-buffer addresses are controlled mapped inputs because a live game heap snapshot was not supplied.',
      'The IDOM index table is proven by a separate original-code execution to address runtime node records; this packet slice does not by itself attach human-readable RTA names to those records.',
      'No PCSX2, BIOS, or HLE service is used; no external call is reached in the executed slice.',
    ],
  };
  const encoded = JSON.stringify(report, null, 2) + '\n';
  if (outputPath) fs.writeFileSync(outputPath, encoded);
  else process.stdout.write(encoded);
  console.error(JSON.stringify({ status: report.status, output: outputPath || null, executions: executions.length, routine_sha256: report.routine.sha256 }));
}

if (require.main === module) main();

module.exports = { ENTRY, STOP, MatrixPacketR5900, parseRta, executeCase };
