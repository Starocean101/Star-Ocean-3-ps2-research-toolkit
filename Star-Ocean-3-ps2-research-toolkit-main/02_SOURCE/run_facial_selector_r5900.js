#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const V510 = require('./v510_targeted_runtime.js');
const Probe = require('./v5122_facial_selector_probe.js');
const Geometry = require('./v5_1_geometry.js');
const Assembler = require('./v58_model_assembler.js');

const ENTRY = 0x004d7bb0;
const END_EXCLUSIVE = 0x004d7cb0;
const SENTINEL = 0x0badf00d;
const ACTOR_BASE = 0x01000000;
const OBJECT_BASE = 0x01100000;
const NODE_BASE = 0x01101000;
const POINTER_ARRAY_BASE = 0x01102000;
const REG = ['zero','at','v0','v1','a0','a1','a2','a3','t0','t1','t2','t3','t4','t5','t6','t7','s0','s1','s2','s3','s4','s5','s6','s7','t8','t9','k0','k1','gp','sp','fp','ra'];

function numeric(text) {
  if (typeof text === 'number') return text >>> 0;
  return /^0x/i.test(String(text)) ? parseInt(text, 16) >>> 0 : Number(text) >>> 0;
}

function hex(value, width = 8) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sign16(value) {
  return value & 0x8000 ? value - 0x10000 : value;
}

class FacialSelectorR5900 {
  constructor(memory) {
    this.memory = memory;
    this.gpr = new Uint32Array(32);
    this.hi = 0;
    this.lo = 0;
    this.pc = 0;
    this.steps = 0;
    this.trace = [];
    this.traceRows = [];
    this.stopPc = null;
    this.writes = [];
    this.executedOpcodes = new Set();
  }

  r(index) { return index ? this.gpr[index] >>> 0 : 0; }
  s(index) { return this.r(index) | 0; }
  set(index, value) { if (index) this.gpr[index] = value >>> 0; }
  load8(address) { return Number(this.memory.load(address >>> 0, 1)); }
  load16(address) { return Number(this.memory.load(address >>> 0, 2)); }
  load32(address) { return Number(this.memory.load(address >>> 0, 4)) >>> 0; }
  address(base, immediate) { return (this.r(base) + sign16(immediate)) >>> 0; }

  record(pc, word, text, delaySlot) {
    const row = { step: this.steps, pc: hex(pc), word: hex(word), instruction: text, delay_slot: Boolean(delaySlot) };
    this.trace.push(row);
    this.traceRows.push(`${row.step}|${row.pc}|${row.word}|${row.delay_slot ? 1 : 0}\n`);
    this.steps++;
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
        this.set(rd, this.r(rt) << sa);
        text = `sll ${REG[rd]},${REG[rt]},${sa}`;
      } else if (fn === 0x10) {
        this.set(rd, this.hi);
        text = `mfhi ${REG[rd]}`;
      } else if (fn === 0x12) {
        this.set(rd, this.lo);
        text = `mflo ${REG[rd]}`;
      } else if (fn === 0x1b) {
        const dividend = this.r(rs);
        const divisor = this.r(rt);
        if (!divisor) throw new Error(`divu by zero at ${hex(pc)}`);
        this.lo = Math.floor(dividend / divisor) >>> 0;
        this.hi = (dividend % divisor) >>> 0;
        text = `divu ${REG[rs]},${REG[rt]}`;
      } else if (fn === 0x21 || fn === 0x2d) {
        this.set(rd, this.r(rs) + this.r(rt));
        text = `${fn === 0x21 ? 'addu' : 'daddu'} ${REG[rd]},${REG[rs]},${REG[rt]}`;
      } else if (fn === 0x23) {
        this.set(rd, this.r(rs) - this.r(rt));
        text = `subu ${REG[rd]},${REG[rs]},${REG[rt]}`;
      } else if (fn === 0x2a) {
        this.set(rd, this.s(rs) < this.s(rt) ? 1 : 0);
        text = `slt ${REG[rd]},${REG[rs]},${REG[rt]}`;
      } else {
        throw new Error(`unsupported SPECIAL fn ${hex(fn, 2)} at ${hex(pc)} (word ${hex(word)})`);
      }
    } else if (op === 0x09) {
      this.set(rt, this.r(rs) + sign16(imm));
      text = `addiu ${REG[rt]},${REG[rs]},${sign16(imm)}`;
    } else if (op === 0x0c) {
      this.set(rt, this.r(rs) & imm);
      text = `andi ${REG[rt]},${REG[rs]},${hex(imm, 4)}`;
    } else if (op === 0x23) {
      const address = this.address(rs, imm);
      this.set(rt, this.load32(address));
      text = `lw ${REG[rt]},${sign16(imm)}(${REG[rs]})`;
    } else if (op === 0x25) {
      const address = this.address(rs, imm);
      this.set(rt, this.load16(address));
      text = `lhu ${REG[rt]},${sign16(imm)}(${REG[rs]})`;
    } else if (op === 0x2b) {
      const address = this.address(rs, imm);
      const value = this.r(rt);
      this.memory.store(address, BigInt(value), 4);
      this.writes.push({ pc: hex(pc), address: hex(address), size: 4, value: hex(value) });
      text = `sw ${REG[rt]},${sign16(imm)}(${REG[rs]})`;
    } else {
      throw new Error(`unsupported opcode ${hex(op, 2)} at ${hex(pc)} (word ${hex(word)})`);
    }
    this.executedOpcodes.add(op === 0 ? `SPECIAL:${hex(fn, 2)}` : `OP:${hex(op, 2)}`);
    this.record(pc, word, text, delaySlot);
  }

  delay(pc) {
    const word = this.load32(pc);
    const op = word >>> 26;
    const fn = word & 63;
    if ([1,2,3,4,5,6,7].includes(op) || op === 0 && [8,9].includes(fn)) {
      throw new Error(`control transfer in delay slot at ${hex(pc)}`);
    }
    this.noncontrol(pc, word, true);
  }

  run(start, maxSteps = 1000) {
    this.pc = start >>> 0;
    while (this.steps < maxSteps) {
      const pc = this.pc;
      const word = this.load32(pc);
      const op = word >>> 26;
      const rs = word >>> 21 & 31;
      const rt = word >>> 16 & 31;
      const fn = word & 63;
      const imm = word & 0xffff;
      let target;
      let taken;
      let name;
      if (op === 0 && fn === 8) {
        target = this.r(rs);
        this.record(pc, word, `jr ${REG[rs]}`, false);
        this.delay(pc + 4);
        if (this.stopPc != null && target === this.stopPc) return 'RETURN_SENTINEL';
        this.pc = target;
      } else if (op === 1 && (rt === 0 || rt === 1)) {
        target = (pc + 4 + (sign16(imm) << 2)) >>> 0;
        taken = rt === 0 ? this.s(rs) < 0 : this.s(rs) >= 0;
        name = rt === 0 ? 'bltz' : 'bgez';
        this.record(pc, word, `${name} ${REG[rs]} -> ${hex(target)} (${taken ? 'taken' : 'not taken'})`, false);
        this.delay(pc + 4);
        this.pc = taken ? target : pc + 8;
      } else if ([4,5,6,7].includes(op)) {
        target = (pc + 4 + (sign16(imm) << 2)) >>> 0;
        if (op === 4) { taken = this.r(rs) === this.r(rt); name = 'beq'; }
        else if (op === 5) { taken = this.r(rs) !== this.r(rt); name = 'bne'; }
        else if (op === 6) { taken = this.s(rs) <= 0; name = 'blez'; }
        else { taken = this.s(rs) > 0; name = 'bgtz'; }
        this.record(pc, word, `${name} -> ${hex(target)} (${taken ? 'taken' : 'not taken'})`, false);
        this.delay(pc + 4);
        this.pc = taken ? target : pc + 8;
      } else {
        this.noncontrol(pc, word, false);
        this.pc = pc + 4;
      }
    }
    throw new Error(`instruction limit ${maxSteps} reached`);
  }
}

function write32(memory, address, value) {
  memory.store(address >>> 0, BigInt(value >>> 0), 4);
}

function parseGroup(actor, group) {
  const payloadOffset = group.off + 0x10;
  const count = actor.readUInt16LE(payloadOffset);
  const mode = actor.readUInt16LE(payloadOffset + 2);
  const total = actor.readUInt32LE(payloadOffset + 4);
  const pairs = [];
  for (let index = 0; index < count; index++) {
    const offset = payloadOffset + 8 + index * 8;
    pairs.push({ key: actor.readUInt32LE(offset), duration: actor.readUInt32LE(offset + 4) });
  }
  const chainBaseOffset = group.members[0].expected_off - pairs[0].key;
  const members = pairs.map((pair, index) => {
    const sectionOff = chainBaseOffset + pair.key;
    return {
      index,
      key: pair.key,
      duration: pair.duration,
      fis_section_off: sectionOff,
      pointer: ACTOR_BASE + sectionOff,
      texture_id: actor.readUInt32LE(sectionOff + 0x18)
    };
  });
  return { fisa_off: group.off, payload_off: payloadOffset, count, mode, total, chain_base_off: chainBaseOffset, members };
}

function independentIndex(group, counter) {
  let position = ((counter % group.total) + group.total) % group.total;
  const cycle = Math.floor(counter / group.total);
  if (cycle !== 0 && group.mode === 1 && (cycle & 1)) position = group.total - position - 1;
  else if (cycle !== 0 && group.mode === 2) position = cycle > 0 ? group.total - 1 : 0;
  let index = 0;
  for (; index < group.members.length; index++) {
    position -= group.members[index].duration;
    if (position < 0) break;
  }
  return Math.min(index, group.members.length - 1);
}

function executeCase(moduleBytes, actor, group, counter) {
  const memory = new V510.SparseMemory();
  const moduleInfo = V510.loadModule(moduleBytes, memory, 'Lib.bin');
  memory.map(ACTOR_BASE, actor, '03_CHAR_00000BC0.bin');
  memory.map(OBJECT_BASE, new Uint8Array(0x1000), 'facial_selector_object');
  memory.map(NODE_BASE, new Uint8Array(0x1000), 'runtime_material_node');
  memory.map(POINTER_ARRAY_BASE, new Uint8Array(0x1000), 'resolved_FISA_member_pointer_array');
  group.members.forEach((member, index) => write32(memory, POINTER_ARRAY_BASE + index * 4, member.pointer));
  write32(memory, OBJECT_BASE + 0x48, counter);
  write32(memory, OBJECT_BASE + 0x4c, NODE_BASE);
  write32(memory, OBJECT_BASE + 0x50, POINTER_ARRAY_BASE);
  write32(memory, OBJECT_BASE + 0x54, ACTOR_BASE + group.payload_off);
  const cpu = new FacialSelectorR5900(memory);
  cpu.set(4, OBJECT_BASE);
  cpu.set(31, SENTINEL);
  cpu.stopPc = SENTINEL;
  const stopReason = cpu.run(ENTRY);
  const selectedPointer = cpu.load32(NODE_BASE + 0x28);
  const selectedOffset = selectedPointer - ACTOR_BASE;
  const selectedIndex = group.members.findIndex((member) => member.pointer === selectedPointer);
  const expectedIndex = independentIndex(group, counter);
  if (selectedIndex !== expectedIndex) {
    throw new Error(`counter ${counter}: guest chose ${selectedIndex}, independent expectation ${expectedIndex}`);
  }
  const selected = group.members[selectedIndex];
  return {
    counter,
    stop_reason: stopReason,
    instruction_count: cpu.steps,
    selected_index: selectedIndex,
    selected_member_pointer: hex(selectedPointer),
    selected_member_fixture_off: hex(selectedOffset),
    selected_texture_id: selected.texture_id,
    target_write: cpu.writes.find((write) => numeric(write.address) === NODE_BASE + 0x28),
    trace_commitment_sha256: sha256(Buffer.from(cpu.traceRows.join(''), 'utf8')),
    trace_commitment_scheme: 'SHA-256 over UTF-8 rows step|PC|word|delay-slot, using the actual mapped Lib MWo3 instruction words',
    trace: cpu.trace,
    executed_opcode_subset: [...cpu.executedOpcodes].sort(),
    module_info: moduleInfo
  };
}

function main() {
  const modulePath = process.argv[2] || path.join(__dirname, '../03_TESTS/fixtures/runtime/entry_0002_block_01_Lib.bin_base_3E6880.bin');
  const actorPath = process.argv[3] || path.join(__dirname, '../03_TESTS/fixtures/model/03_CHAR_00000BC0.bin');
  const outputPath = process.argv[4] || null;
  const moduleBytes = fs.readFileSync(modulePath);
  const actor = fs.readFileSync(actorPath);
  let audit = null, groupDescriptors = [], discovery = null;
  try {
    audit = Probe.auditCharFacialState(actor);
    groupDescriptors = audit.fisa;
    discovery = 'INDEPENDENT_XBDC_CHAR_AUDIT';
  } catch (error) {
    const model = Geometry.parseGeometry(actor), decoded = Assembler.decodeEmbeddedTextures(model);
    groupDescriptors = decoded.companions.map((entry) => ({
      off: entry.section.off,
      members: entry.parsed.group_binding.members.map((member) => ({ expected_off: member.expected_offset }))
    }));
    if (!groupDescriptors.length || groupDescriptors.some((group) => !group.members.length)) throw new Error(`No executable FISA groups found in ${path.basename(actorPath)}: ${error.message}`);
    discovery = 'GENERIC_FPS_CHAIN_FISA_SCAN';
  }
  const groups = groupDescriptors.map((entry) => parseGroup(actor, entry));
  const cases = groups.map((group) => {
    const counters = Array.from({ length: group.total * 2 + 1 }, (_, index) => index);
    return { group, executions: counters.map((counter) => executeCase(moduleBytes, actor, group, counter)) };
  });
  const moduleLoad = moduleBytes.readUInt32LE(8);
  const routineOffset = ENTRY - moduleLoad;
  const routineBytes = moduleBytes.subarray(routineOffset, routineOffset + (END_EXCLUSIVE - ENTRY));
  const report = {
    format: 'SO3_FACIAL_SELECTOR_R5900_EXECUTION_REPORT',
    version: 1,
    created_utc: new Date().toISOString(),
    model_level: 'Max',
    gate: 'facial_frame_palette_selector',
    gate_status: 'UNRESOLVED',
    promotion: false,
    component_status: {
      facial_frame_member_selector: 'VERIFIED',
      palette_bank_selector: 'UNRESOLVED'
    },
    inputs: {
      module: { name: path.basename(modulePath), byte_size: moduleBytes.length, sha256: sha256(moduleBytes), load_address: hex(moduleLoad) },
      fixture: { name: path.basename(actorPath), byte_size: actor.length, sha256: sha256(actor), fisa_discovery: discovery }
    },
    routine: {
      entry_va: hex(ENTRY),
      end_exclusive_va: hex(END_EXCLUSIVE),
      module_file_offset: hex(routineOffset),
      byte_size: routineBytes.length,
      sha256: sha256(routineBytes),
      kind: 'R5900_INSTRUCTION_EXECUTION',
      external_stubs: [],
      allocator_or_recursion_modeled: false,
      writes_selected_member_to: `runtime node ${hex(NODE_BASE)} + 0x28`
    },
    static_dataflow_prerequisite: {
      fas_type_range: '0x0021-0x0024',
      binding_case_va: '0x004BF750',
      binding_payload: "u32 tag ('naka') + u32 base texture id",
      mapper_va: '0x004D5D80',
      evaluator_dispatch_va: '0x004B47B0',
      type_0x0021_case_va: '0x004B5500',
      rounded_integer_write_va: '0x004B5570',
      rounded_integer_destination: 'bound facial selector object +0x48',
      selector_counter_read_va: '0x004D7BC0'
    },
    groups: cases,
    verdict: {
      frame_selector: 'The actual Lib R5900 leaf routine selected the fixture FIS member expected from each FISA duration pair for a complete forward/reverse mode-1 cycle in both facial families.',
      palette_selector: 'No CBP/CSA write is executed by this routine; palette-bank selection remains outside this evidence and the combined gate is not promoted.'
    },
    reasoning_boundary: [
      'Only the opcode subset actually reached by 0x004D7BB0 is implemented; unsupported instructions fail closed.',
      'The Lib MWo3 code bytes and CHAR/FISA bytes are mapped directly from the supplied artifacts.',
      'The pointer array and object fields reproduce values established by the separately decoded 0x004D7CB0 parser; no allocator, parser recursion, renderer, or GS service is stubbed.',
      'This verifies facial FISA member choice, not TEX0 palette-bank choice.'
    ]
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) fs.writeFileSync(outputPath, serialized);
  else process.stdout.write(serialized);
}

main();
