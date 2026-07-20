#!/usr/bin/env node
'use strict';

/* Historical controlled execution, corrected in V5.12.4.
 * This proves a generic FISP-record-to-TEX0-high-byte transformation. It does
 * not prove that FISP selects a facial palette, and its two controlled CSA
 * values must not be presented as two embedded palettes in a facial FIS.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const V510 = require('./v510_targeted_runtime.js');
const Probe = require('./v5122_facial_selector_probe.js');

const MASK32 = 0xffffffffn;
const MASK64 = (1n << 64n) - 1n;
const REG = ['zero','at','v0','v1','a0','a1','a2','a3','t0','t1','t2','t3','t4','t5','t6','t7','s0','s1','s2','s3','s4','s5','s6','s7','t8','t9','k0','k1','gp','sp','fp','ra'];

const MODEL = 0x01000000;
const NODE = 0x01100000;
const FISP = 0x01200000;
const MANAGER = 0x01300000;
const GP = 0x01400000;
const PACKET_ALIAS = (MODEL + 0x6f0) | 0x30000000;

const FISP_SELECT_START = 0x0046ada8;
const FISP_SELECT_STOP = 0x0046ae48;
const FIS_UPLOAD_ARG_START = 0x00468590;
const FIS_UPLOAD_ARG_STOP = 0x004685dc;
const FIS_PALETTE_ARG_START = 0x004686a8;
const FIS_PALETTE_ARG_STOP = 0x004686c8;
const TEX0_START = 0x00468720;
const TEX0_STOP = 0x00468850;

function hex(value, width = 8) {
  const v = typeof value === 'bigint' ? value : BigInt(value >>> 0);
  return `0x${v.toString(16).toUpperCase().padStart(width, '0')}`;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sx(value, bits) {
  const width = 1n << BigInt(bits);
  const sign = width >> 1n;
  const masked = BigInt(value) & (width - 1n);
  return masked & sign ? masked - width : masked;
}

function sign16(value) {
  return value & 0x8000 ? value - 0x10000 : value;
}

function write16(memory, address, value) {
  memory.store(address >>> 0, BigInt(value & 0xffff), 2);
}

function write32(memory, address, value) {
  memory.store(address >>> 0, BigInt(value >>> 0), 4);
}

function write64(memory, address, value) {
  memory.store(address >>> 0, BigInt(value) & MASK64, 8);
}

class SliceR5900 {
  constructor(memory) {
    this.memory = memory;
    this.gpr = Array(32).fill(0n);
    this.pc = 0;
    this.steps = 0;
    this.trace = [];
    this.traceRows = [];
    this.writes = [];
    this.executed = new Set();
  }

  r(index) { return index ? this.gpr[index] & MASK64 : 0n; }
  set(index, value) { if (index) this.gpr[index] = BigInt(value) & MASK64; }
  u32(index) { return Number(this.r(index) & MASK32) >>> 0; }
  address(base, immediate) { return (this.u32(base) + sign16(immediate)) >>> 0; }
  load(address, size) { return this.memory.load(address >>> 0, size); }

  record(pc, word, instruction, delaySlot) {
    const row = { step: this.steps, pc: hex(pc), word: hex(word), instruction, delay_slot: Boolean(delaySlot) };
    this.trace.push(row);
    this.traceRows.push(`${row.step}|${row.pc}|${row.word}|${row.delay_slot ? 1 : 0}\n`);
    this.steps++;
  }

  store(pc, address, value, size) {
    const masked = BigInt(value) & ((1n << BigInt(size * 8)) - 1n);
    this.memory.store(address >>> 0, masked, size);
    this.writes.push({ pc: hex(pc), address: hex(address), size, value: hex(masked, size * 2) });
  }

  noncontrol(pc, word, delaySlot = false) {
    const op = word >>> 26;
    const rs = word >>> 21 & 31;
    const rt = word >>> 16 & 31;
    const rd = word >>> 11 & 31;
    const sa = word >>> 6 & 31;
    const fn = word & 63;
    const imm = word & 0xffff;
    let text = '';
    if (word === 0) {
      text = 'nop';
    } else if (op === 0) {
      if (fn === 0x00) { this.set(rd, (this.r(rt) & MASK32) << BigInt(sa)); text = `sll ${REG[rd]},${REG[rt]},${sa}`; }
      else if (fn === 0x02) { this.set(rd, (this.r(rt) & MASK32) >> BigInt(sa)); text = `srl ${REG[rd]},${REG[rt]},${sa}`; }
      else if (fn === 0x21 || fn === 0x2d) { this.set(rd, this.r(rs) + this.r(rt)); text = `${fn === 0x21 ? 'addu' : 'daddu'} ${REG[rd]},${REG[rs]},${REG[rt]}`; }
      else if (fn === 0x24) { this.set(rd, this.r(rs) & this.r(rt)); text = `and ${REG[rd]},${REG[rs]},${REG[rt]}`; }
      else if (fn === 0x25) { this.set(rd, this.r(rs) | this.r(rt)); text = `or ${REG[rd]},${REG[rs]},${REG[rt]}`; }
      else if (fn === 0x2b) { this.set(rd, this.r(rs) < this.r(rt) ? 1n : 0n); text = `sltu ${REG[rd]},${REG[rs]},${REG[rt]}`; }
      else if (fn === 0x38) { this.set(rd, this.r(rt) << BigInt(sa)); text = `dsll ${REG[rd]},${REG[rt]},${sa}`; }
      else if (fn === 0x3a) { this.set(rd, this.r(rt) >> BigInt(sa)); text = `dsrl ${REG[rd]},${REG[rt]},${sa}`; }
      else if (fn === 0x3c) { this.set(rd, this.r(rt) << BigInt(sa + 32)); text = `dsll32 ${REG[rd]},${REG[rt]},${sa}`; }
      else if (fn === 0x3e) { this.set(rd, this.r(rt) >> BigInt(sa + 32)); text = `dsrl32 ${REG[rd]},${REG[rt]},${sa}`; }
      else if (fn === 0x3f) { this.set(rd, sx(this.r(rt), 64) >> BigInt(sa + 32)); text = `dsra32 ${REG[rd]},${REG[rt]},${sa}`; }
      else throw new Error(`unsupported SPECIAL fn ${hex(fn, 2)} at ${hex(pc)} (${hex(word)})`);
      this.executed.add(`SPECIAL:${hex(fn, 2)}`);
    } else if (op === 0x09) {
      this.set(rt, sx((this.r(rs) + BigInt(sign16(imm))) & MASK32, 32));
      text = `addiu ${REG[rt]},${REG[rs]},${sign16(imm)}`;
      this.executed.add(`OP:${hex(op, 2)}`);
    } else if (op === 0x0c) {
      this.set(rt, this.r(rs) & BigInt(imm));
      text = `andi ${REG[rt]},${REG[rs]},${hex(imm, 4)}`;
      this.executed.add(`OP:${hex(op, 2)}`);
    } else if (op === 0x0d) {
      this.set(rt, this.r(rs) | BigInt(imm));
      text = `ori ${REG[rt]},${REG[rs]},${hex(imm, 4)}`;
      this.executed.add(`OP:${hex(op, 2)}`);
    } else if (op === 0x0f) {
      this.set(rt, sx(BigInt((imm << 16) >>> 0), 32));
      text = `lui ${REG[rt]},${hex(imm, 4)}`;
      this.executed.add(`OP:${hex(op, 2)}`);
    } else if ([0x21, 0x23, 0x24, 0x25, 0x37].includes(op)) {
      const address = this.address(rs, imm);
      if (op === 0x21) { this.set(rt, sx(this.load(address, 2), 16)); text = `lh ${REG[rt]},${sign16(imm)}(${REG[rs]})`; }
      else if (op === 0x23) { this.set(rt, sx(this.load(address, 4), 32)); text = `lw ${REG[rt]},${sign16(imm)}(${REG[rs]})`; }
      else if (op === 0x24) { this.set(rt, this.load(address, 1)); text = `lbu ${REG[rt]},${sign16(imm)}(${REG[rs]})`; }
      else if (op === 0x25) { this.set(rt, this.load(address, 2)); text = `lhu ${REG[rt]},${sign16(imm)}(${REG[rs]})`; }
      else { this.set(rt, this.load(address, 8)); text = `ld ${REG[rt]},${sign16(imm)}(${REG[rs]})`; }
      this.executed.add(`OP:${hex(op, 2)}`);
    } else if ([0x29, 0x2b, 0x3f].includes(op)) {
      const address = this.address(rs, imm);
      const size = op === 0x29 ? 2 : op === 0x2b ? 4 : 8;
      this.store(pc, address, this.r(rt), size);
      text = `${op === 0x29 ? 'sh' : op === 0x2b ? 'sw' : 'sd'} ${REG[rt]},${sign16(imm)}(${REG[rs]})`;
      this.executed.add(`OP:${hex(op, 2)}`);
    } else {
      throw new Error(`unsupported opcode ${hex(op, 2)} at ${hex(pc)} (${hex(word)})`);
    }
    this.record(pc, word, text, delaySlot);
  }

  delay(pc) {
    const word = Number(this.load(pc, 4));
    const op = word >>> 26;
    const fn = word & 63;
    if ([1,2,3,4,5,6,7].includes(op) || op === 0 && [8,9].includes(fn)) throw new Error(`control transfer in delay slot at ${hex(pc)}`);
    this.noncontrol(pc, word, true);
  }

  runUntil(start, stopPc, maxSteps = 1000) {
    this.pc = start >>> 0;
    while (this.steps < maxSteps) {
      if (this.pc === (stopPc >>> 0)) return 'STOP_PC';
      const pc = this.pc;
      const word = Number(this.load(pc, 4));
      const op = word >>> 26;
      const rs = word >>> 21 & 31;
      const rt = word >>> 16 & 31;
      const imm = word & 0xffff;
      if ([4,5].includes(op)) {
        const target = (pc + 4 + (sign16(imm) << 2)) >>> 0;
        const taken = op === 4 ? this.r(rs) === this.r(rt) : this.r(rs) !== this.r(rt);
        this.record(pc, word, `${op === 4 ? 'beq' : 'bne'} -> ${hex(target)} (${taken ? 'taken' : 'not taken'})`, false);
        this.delay(pc + 4);
        this.pc = taken ? target : pc + 8;
      } else {
        this.noncontrol(pc, word, false);
        this.pc = pc + 4;
      }
    }
    throw new Error(`instruction limit ${maxSteps} reached before ${hex(stopPc)}`);
  }

  evidence(stopReason) {
    return {
      stop_reason: stopReason,
      instruction_count: this.steps,
      trace_commitment_sha256: sha256(Buffer.from(this.traceRows.join(''), 'utf8')),
      trace_commitment_scheme: 'SHA-256 over UTF-8 rows step|PC|word|delay-slot using the mapped Lib MWo3 words',
      executed_opcode_subset: [...this.executed].sort(),
      writes: this.writes,
      trace: this.trace
    };
  }
}

function makeFispSection() {
  const data = Buffer.alloc(0x200);
  data.write('FISP', 0, 'ascii');
  data.writeUInt32LE(data.length - 0x10, 4);
  data.writeUInt32LE(data.length, 0x0c);
  data.writeUInt32LE(2, 0x10);
  data.writeUInt32LE(0x20, 0x14);
  data.writeUInt32LE(0xe0, 0x18);
  const records = [0x30, 0xf0];
  data[records[0] + 2] = 0;
  data[records[1] + 2] = 1;
  return { data, records };
}

function parseFis(actor, sectionOffset) {
  const flags = actor.readUInt32LE(sectionOffset + 0x10);
  const descriptor = sectionOffset + 0x10 + actor.readUInt32LE(sectionOffset + 0x1c);
  return {
    section_offset: sectionOffset,
    texture_id: actor.readUInt32LE(sectionOffset + 0x18),
    palette_entries: flags >>> 16,
    flags_low16: flags & 0xffff,
    width: actor.readUInt16LE(descriptor),
    height: actor.readUInt16LE(descriptor + 2),
    psm: actor[descriptor + 0x0c],
    tw: actor[descriptor + 0x0e],
    th: actor[descriptor + 0x0f],
    descriptor_offset: descriptor
  };
}

function tex0(fields) {
  return BigInt(fields.tbp0)
    | BigInt(fields.tbw) << 14n
    | BigInt(fields.psm) << 20n
    | BigInt(fields.tw) << 26n
    | BigInt(fields.th) << 30n
    | BigInt(fields.tcc) << 34n
    | BigInt(fields.tfx || 0) << 35n
    | BigInt(fields.cbp) << 37n
    | BigInt(fields.cpsm || 0) << 51n
    | BigInt(fields.csm || 0) << 55n
    | BigInt(fields.csa || 0) << 56n
    | BigInt(fields.cld || 0) << 61n;
}

function decodeTex0(value) {
  const v = BigInt(value);
  return {
    value_hex: hex(v, 16),
    tbp0: Number(v & 0x3fffn),
    tbw: Number(v >> 14n & 0x3fn),
    psm: Number(v >> 20n & 0x3fn),
    tw: Number(v >> 26n & 0xfn),
    th: Number(v >> 30n & 0xfn),
    tcc: Number(v >> 34n & 1n),
    tfx: Number(v >> 35n & 3n),
    cbp: Number(v >> 37n & 0x3fffn),
    cpsm: Number(v >> 51n & 0xfn),
    csm: Number(v >> 55n & 1n),
    csa: Number(v >> 56n & 0x1fn),
    cld: Number(v >> 61n & 7n)
  };
}

function mappedRoutineHash(moduleBytes, load, start, stop) {
  const off = start - load;
  const bytes = moduleBytes.subarray(off, off + stop - start);
  return { start_va: hex(start), stop_va: hex(stop), module_file_offset: hex(off), byte_size: bytes.length, sha256: sha256(bytes) };
}

function execute(moduleBytes, actor, fisOffset, profileIndex) {
  const memory = new V510.SparseMemory();
  const moduleInfo = V510.loadModule(moduleBytes, memory, 'Lib.bin');
  const fisp = makeFispSection();
  memory.map(MODEL, new Uint8Array(0x2000), 'controlled_model_state');
  memory.map(NODE, new Uint8Array(0x1000), 'runtime_material_node');
  memory.map(FISP, fisp.data, 'controlled_FISP_two_profile_section');
  memory.map(MANAGER, new Uint8Array(0x4000), 'controlled_texture_manager_tables');
  memory.map(GP - 0x8000, new Uint8Array(0x10000), 'controlled_gp_window');
  memory.map(PACKET_ALIAS & ~0xfff, new Uint8Array(0x2000), 'uncached_packet_alias');
  memory.map(0x02000000, actor, '03_CHAR_00000BC0.bin');

  const profileCpu = new SliceR5900(memory);
  profileCpu.set(5, FISP);
  profileCpu.set(6, profileIndex);
  profileCpu.set(16, MODEL);
  const profileStop = profileCpu.runUntil(FISP_SELECT_START, FISP_SELECT_STOP);
  const selectedProfile = Number(memory.load(MODEL + 0x618, 4));
  const expectedProfile = FISP + fisp.records[profileIndex];
  if (selectedProfile !== expectedProfile) throw new Error(`FISP profile ${profileIndex} selected ${hex(selectedProfile)}, expected ${hex(expectedProfile)}`);

  const selectedFis = 0x02000000 + fisOffset;
  write32(memory, NODE + 0x28, selectedFis);
  const uploadCpu = new SliceR5900(memory);
  uploadCpu.set(16, MODEL);
  uploadCpu.set(17, 0);
  uploadCpu.set(19, NODE);
  uploadCpu.set(28, GP);
  write32(memory, GP - 0x79b4, MANAGER);
  const uploadStop = uploadCpu.runUntil(FIS_UPLOAD_ARG_START, FIS_UPLOAD_ARG_STOP);
  if (uploadCpu.u32(5) !== selectedFis) throw new Error(`texture upload argument ${hex(uploadCpu.u32(5))} != selected FIS ${hex(selectedFis)}`);

  const paletteCpu = new SliceR5900(memory);
  paletteCpu.set(18, selectedFis);
  paletteCpu.set(28, GP);
  const paletteStop = paletteCpu.runUntil(FIS_PALETTE_ARG_START, FIS_PALETTE_ARG_STOP);
  if (paletteCpu.u32(5) !== selectedFis) throw new Error('palette upload did not retain selected FIS pointer');

  const info = parseFis(actor, fisOffset);
  const controlledAllocation = { tbp0: 0x0120, cbp: 0x01a0 };
  const textureEntry = tex0({ tbp0: controlledAllocation.tbp0, tbw: 1, psm: info.psm, tw: info.tw, th: info.th, tcc: 1, cbp: 0 });
  const paletteEntry = tex0({ tbp0: 0, tbw: 0, psm: 0, tw: 0, th: 0, tcc: 0, cbp: controlledAllocation.cbp, csa: 0 });
  write16(memory, MANAGER + 0x2670, 0);
  write16(memory, MANAGER + 0x2870, 0);
  write64(memory, MANAGER + 0x1010, textureEntry);
  write64(memory, MANAGER + 0x2220, paletteEntry);
  write64(memory, PACKET_ALIAS + 0x40, 0n);

  const tex0Cpu = new SliceR5900(memory);
  tex0Cpu.set(16, MODEL);
  tex0Cpu.set(28, GP);
  const tex0Stop = tex0Cpu.runUntil(TEX0_START, TEX0_STOP);
  const packetValue = memory.load(PACKET_ALIAS + 0x40, 8);
  const decoded = decodeTex0(packetValue);
  if (decoded.csa !== profileIndex) throw new Error(`profile ${profileIndex}: CSA ${decoded.csa}`);
  if (decoded.tbp0 !== controlledAllocation.tbp0 || decoded.cbp !== controlledAllocation.cbp) throw new Error(`profile ${profileIndex}: TEX0 address fields changed unexpectedly`);
  if (decoded.psm !== 0x14) throw new Error(`profile ${profileIndex}: expected PSMT4, got ${hex(decoded.psm, 2)}`);

  return {
    profile_index: profileIndex,
    controlled_fisp_record: {
      section_pointer: hex(FISP),
      selected_record_pointer: hex(selectedProfile),
      record_byte_2: Number(memory.load(selectedProfile + 2, 1)),
      provenance: 'CONTROLLED_INPUT: the supplied artifacts contain no FISP resource sample; records differ only at byte +2 (0/1)'
    },
    fisp_profile_selection_execution: profileCpu.evidence(profileStop),
    selected_fis_to_upload_execution: {
      selected_fis_pointer: hex(selectedFis),
      jal_0x4A6C90_argument_a1: hex(uploadCpu.u32(5)),
      jal_0x4A6C90_argument_a0_texture_manager: hex(uploadCpu.u32(4)),
      ...uploadCpu.evidence(uploadStop)
    },
    palette_upload_branch_execution: {
      fis_palette_entry_count: info.palette_entries,
      jal_0x4A6E10_argument_a1: hex(paletteCpu.u32(5)),
      branch_taken_to_palette_upload: paletteCpu.pc === FIS_PALETTE_ARG_STOP,
      ...paletteCpu.evidence(paletteStop)
    },
    tex0_packet_execution: {
      controlled_runtime_allocation: controlledAllocation,
      texture_manager_texture_entry: hex(textureEntry, 16),
      texture_manager_palette_entry_without_csa: hex(paletteEntry, 16),
      output_packet_address: hex(PACKET_ALIAS + 0x40),
      output_tex0: decoded,
      ...tex0Cpu.evidence(tex0Stop)
    },
    module_info: moduleInfo
  };
}

function main() {
  const modulePath = process.argv[2] || path.join(__dirname, '../03_TESTS/fixtures/runtime/entry_0002_block_01_Lib.bin_base_3E6880.bin');
  const actorPath = process.argv[3] || path.join(__dirname, '../03_TESTS/fixtures/model/03_CHAR_00000BC0.bin');
  const frameReportPath = process.argv[4] || path.join(__dirname, '../04_REPORTS/SO3_FACIAL_SELECTOR_R5900_EXECUTION_REPORT.json');
  const outputPath = process.argv[5] || null;
  const moduleBytes = fs.readFileSync(modulePath);
  const actor = fs.readFileSync(actorPath);
  const frameReport = JSON.parse(fs.readFileSync(frameReportPath, 'utf8'));
  const audit = Probe.auditCharFacialState(actor);
  const lower = audit.fisa.find((entry) => entry.members.some((member) => member.texture_id === 2413));
  if (!lower) throw new Error('fixture facial family 2413 not found');
  const fisOffset = lower.members.find((member) => member.texture_id === 2413).expected_off;
  const fis = parseFis(actor, fisOffset);
  if (fis.psm !== 0x14 || fis.palette_entries !== 32) throw new Error(`fixture FIS 2413 is not the expected PSMT4 texture with a 16x2 PSMCT32 upload`);
  const moduleLoad = moduleBytes.readUInt32LE(8);
  const cases = [0, 1].map((profileIndex) => execute(moduleBytes, actor, fisOffset, profileIndex));
  const csaValues = cases.map((entry) => entry.tex0_packet_execution.output_tex0.csa);
  if (csaValues.join(',') !== '0,1') throw new Error(`expected CSA outputs 0,1, got ${csaValues.join(',')}`);

  const report = {
    format: 'SO3_GENERIC_FISP_TEX0_HIGH_BYTE_EXECUTION_REPORT',
    version: 2,
    created_utc: new Date().toISOString(),
    model_level: 'Max',
    gate: 'facial_frame_palette_selector',
    gate_status: 'SUPERSEDED_AS_FACIAL_EVIDENCE_GENERIC_FISP_PATH_ONLY',
    promotion: false,
    component_status: {
      fas_naka_to_selector_counter: 'VERIFIED_STATIC_DATAFLOW',
      facial_frame_member_selector: 'VERIFIED_R5900_EXECUTION',
      selected_fis_to_texture_and_palette_upload: 'VERIFIED_R5900_EXECUTION',
      generic_fisp_record_byte_2_to_tex0_high_byte: 'VERIFIED_R5900_EXECUTION_WITH_CONTROLLED_INPUT',
      association_between_fisp_and_actor_0x0BC0_facial_fisa: 'NOT_ESTABLISHED',
      facial_palette_variant_selector: 'NOT_APPLICABLE_ONE_LOGICAL_CSM1_CLUT_PER_FIS'
    },
    inputs: {
      module: { name: path.basename(modulePath), byte_size: moduleBytes.length, sha256: sha256(moduleBytes), load_address: hex(moduleLoad) },
      actor_fixture: { name: path.basename(actorPath), byte_size: actor.length, sha256: sha256(actor) },
      prior_frame_execution_report: { name: path.basename(frameReportPath), byte_size: fs.statSync(frameReportPath).size, sha256: sha256(fs.readFileSync(frameReportPath)), component_status: frameReport.component_status },
      fisp_resource: { supplied: false, consequence: 'Controlled records 0 and 1 are used solely to execute the generic Lib TEX0-high-byte machinery. They do not represent two actor facial palettes.' }
    },
    fixture_fis: {
      ...fis,
      section_offset: hex(fis.section_offset),
      descriptor_offset: hex(fis.descriptor_offset),
      psm_name: 'PSMT4',
      stored_palette_upload_entries: fis.palette_entries,
      logical_palette_count: 1,
      logical_to_stored_palette_index: [0,1,2,3,4,5,6,7,16,17,18,19,20,21,22,23]
    },
    executed_ranges: {
      fisp_profile_select: mappedRoutineHash(moduleBytes, moduleLoad, FISP_SELECT_START, FISP_SELECT_STOP),
      selected_fis_upload_argument: mappedRoutineHash(moduleBytes, moduleLoad, FIS_UPLOAD_ARG_START, FIS_UPLOAD_ARG_STOP),
      selected_fis_palette_branch: mappedRoutineHash(moduleBytes, moduleLoad, FIS_PALETTE_ARG_START, FIS_PALETTE_ARG_STOP),
      tex0_packet_builder: mappedRoutineHash(moduleBytes, moduleLoad, TEX0_START, TEX0_STOP)
    },
    executions: cases,
    verified_findings: [
      'The actual Lib FISA selector execution chooses the exact fixture FIS member for both facial families (incorporated by hash from the prior execution report).',
      'At 0x004685B0 the actual Lib code loads runtime-node+0x28 and presents that exact selected FIS pointer as a1 to texture lookup/upload routine 0x004A6C90.',
      'FIS 2413 has 32 palette entries; the actual branch at 0x004686A8 reaches the palette lookup/upload call at 0x004686C8.',
      'The generic FISP resolver stores payload_base + offset[index] at model+0x618.',
      'The actual packet builder loads byte +2 from that controlled FISP record, shifts it by 56, and ORs it into GS TEX0 bits 56..63.',
      'Two fail-closed R5900 executions differing only in controlled FISP record byte +2 produce otherwise identical TEX0 values with CSA 0 and CSA 1; this demonstrates a cache-address transform, not two embedded facial palettes.',
      'FIS 2413 has one logical CSM1 IDTEX4 CLUT: logical colors 0–7 use stored entries 0–7 and logical colors 8–15 use stored entries 16–23.'
    ],
    verdict: {
      mechanism: 'VERIFIED, RECLASSIFIED: the controlled execution proves a generic FISP byte-to-TEX0-high-byte transform. It does not connect that FISP record to actor 0x0BC0, naka, or FISA.',
      facial_clut: 'RESOLVED INDEPENDENTLY: each observed facial FIS contains one logical CSM1 IDTEX4 CLUT, so no actor-specific embedded-palette choice exists to enable.',
      promotion: 'RETRACTED AS FACIAL EVIDENCE: retain this report only as a generic renderer-context execution artifact.'
    },
    reasoning_boundary: [
      'All executed instructions come from the supplied Lib MWo3 bytes; any unsupported reached opcode fails closed.',
      'The CHAR FIS/FISA bytes and prior frame-selector execution are from the supplied fixture.',
      'Texture-manager allocation addresses are controlled runtime inputs because a live GS/VRAM allocator snapshot was not supplied; the execution verifies only how the generic path changes TEX0.',
      'The two FISP records are controlled minimal inputs because no FISP data resource was supplied. This proves code semantics, not a live actor 0x0BC0 palette choice or even a FISP-to-face association.',
      'No renderer, allocator, BIOS, or game-service result is claimed as observed.'
    ]
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) fs.writeFileSync(outputPath, serialized);
  else process.stdout.write(serialized);
}

main();
