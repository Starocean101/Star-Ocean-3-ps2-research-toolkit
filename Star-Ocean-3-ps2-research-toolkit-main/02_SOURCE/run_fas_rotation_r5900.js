#!/usr/bin/env node
/* Execute SO3's original type-0x0135 FAS quaternion evaluator in Lib.bin.
 *
 * The R5900/VU0 interpreter is deliberately bounded to instructions reached
 * from 0x004AD7D0, its original quaternion helpers, the three VCALLMS targets
 * those helpers invoke, and Lib's math-table initializer at 0x00507610.
 * Unknown instructions, unmapped accesses, invalid key times, and execution
 * caps are hard failures. No host quaternion/interpolation replacement is
 * used on the successful path.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Geometry = require('./v5_1_geometry.js');
const VuMatrix = require('./run_vu0_idom_matrix_micro.js');

const LIB_LOAD = 0x003E6880;
const ENTRY = 0x004AD7D0;
const END_EXCLUSIVE = 0x004ADBCC;
const INTERPOLATOR = 0x004CD310;
const ACOS_HELPER = 0x004CCF80;
const SIN_HELPER = 0x004CD230;
const MATH_TABLE_INITIALIZER = 0x00507610;
const MATH_TABLE_BASE = 0x0050CBC0;
const MATH_TABLE_SIZE = 0x78;
const SENTINEL = 0x0BADF00D;
const TRACK_BASE = 0x01000000;
const OUTPUT_BASE = 0x01001000;
const KEYS_BASE = 0x01002000;
const STACK_TOP = 0x01F00000;
const MASK64 = (1n << 64n) - 1n;
const MASK128 = (1n << 128n) - 1n;
const REG = ['zero','at','v0','v1','a0','a1','a2','a3','t0','t1','t2','t3','t4','t5','t6','t7','s0','s1','s2','s3','s4','s5','s6','s7','t8','t9','k0','k1','gp','sp','fp','ra'];

function hex(value, width = 8) {
  return `0x${Number(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

function sha256(input) {
  return crypto.createHash('sha256').update(Buffer.from(input)).digest('hex');
}

function sign16(value) {
  return value & 0x8000 ? value - 0x10000 : value;
}

function f32(value) {
  return Math.fround(value);
}

function fadd(left, right) {
  return f32(f32(left) + f32(right));
}

function fsub(left, right) {
  return f32(f32(left) - f32(right));
}

function fmul(left, right) {
  return f32(f32(left) * f32(right));
}

function fdiv(left, right) {
  return f32(f32(left) / f32(right));
}

const scalarBits = new ArrayBuffer(4);
const scalarBitsView = new DataView(scalarBits);
function bitsToFloat(bits) {
  scalarBitsView.setUint32(0, bits >>> 0, true);
  return scalarBitsView.getFloat32(0, true);
}
function floatToBits(value) {
  scalarBitsView.setFloat32(0, f32(value), true);
  return scalarBitsView.getUint32(0, true);
}

class BoundedMemory {
  constructor() {
    this.regions = [];
  }

  map(address, input, name, writable = true) {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const end = address + bytes.length;
    if (!Number.isSafeInteger(address) || address < 0 || end > 0x02000000) throw new Error(`invalid mapping ${name}`);
    for (const row of this.regions) if (address < row.end && end > row.start) throw new Error(`mapping overlap: ${name} and ${row.name}`);
    this.regions.push({ start: address >>> 0, end: end >>> 0, bytes, name, writable });
    return bytes;
  }

  locate(address, size, write = false) {
    const end = address + size;
    const row = this.regions.find(item => address >= item.start && end <= item.end);
    if (!row) throw new Error(`unmapped ${write ? 'write' : 'read'} at ${hex(address)} size ${size}`);
    if (write && !row.writable) throw new Error(`write to read-only ${row.name} at ${hex(address)}`);
    return { row, offset: address - row.start };
  }

  read(address, size) {
    const { row, offset } = this.locate(address >>> 0, size, false);
    return row.bytes.subarray(offset, offset + size);
  }

  write(address, input) {
    const bytes = Buffer.from(input);
    const { row, offset } = this.locate(address >>> 0, bytes.length, true);
    bytes.copy(row.bytes, offset);
  }

  load(address, size) {
    const bytes = this.read(address, size);
    let value = 0n;
    for (let index = size - 1; index >= 0; index--) value = value << 8n | BigInt(bytes[index]);
    return value;
  }

  store(address, value, size) {
    let current = BigInt.asUintN(size * 8, BigInt(value));
    const bytes = Buffer.alloc(size);
    for (let index = 0; index < size; index++) {
      bytes[index] = Number(current & 0xFFn);
      current >>= 8n;
    }
    this.write(address, bytes);
  }
}

function readQuaternion(memory, address) {
  const bytes = memory.read(address, 16);
  return Array.from({ length: 4 }, (_, index) => bytes.readFloatLE(index * 4));
}

function writeQuaternion(memory, address, quaternion) {
  const bytes = Buffer.alloc(16);
  quaternion.forEach((value, index) => bytes.writeFloatLE(f32(value), index * 4));
  memory.write(address, bytes);
}

function normalizeQuaternion(input) {
  const norm = Math.hypot(...input);
  if (!Number.isFinite(norm) || norm <= 0) throw new Error('independent slerp oracle received a non-normalizable quaternion');
  return input.map(value => f32(value / norm));
}

function shortestPathSlerp(q0Input, q1Input, amountInput) {
  const q0 = Array.from(q0Input, Number);
  let q1 = Array.from(q1Input, Number);
  const amount = Math.max(0, Math.min(1, Number(amountInput)));
  let dot = q0.reduce((sum, value, index) => sum + value * q1[index], 0);
  if (dot < 0) {
    dot = -dot;
    q1 = q1.map(value => -value);
  }
  dot = Math.max(-1, Math.min(1, dot));
  if (dot > 0.9995) return normalizeQuaternion(q0.map((value, index) => value + amount * (q1[index] - value)));
  const theta = Math.acos(dot);
  const sine = Math.sin(theta);
  if (!Number.isFinite(sine) || Math.abs(sine) < 1e-12) return normalizeQuaternion(q0);
  const left = Math.sin((1 - amount) * theta) / sine;
  const right = Math.sin(amount * theta) / sine;
  return normalizeQuaternion(q0.map((value, index) => left * value + right * q1[index]));
}

class FasRotationR5900 {
  constructor(memory, options = {}) {
    this.memory = memory;
    this.gpr = Array(32).fill(0n);
    this.fprBits = new Uint32Array(32);
    this.fpuAcc = 0;
    this.fpuCondition = false;
    this.vf = Array.from({ length: 32 }, () => new Float32Array(4));
    this.vf[0][3] = 1;
    this.acc = new Float32Array(4);
    this.q = 1;
    this.vuI = 0;
    this.vuStatus = 0;
    this.vuProgram = options.vuProgram ? Buffer.from(options.vuProgram) : null;
    this.steps = 0;
    this.trace = [];
    this.traceRows = [];
    this.traceLimit = Number(options.traceLimit ?? 500);
    this.stopPc = options.stopPc ?? SENTINEL;
    this.allowedCalls = new Set(options.allowedCalls || [INTERPOLATOR, ACOS_HELPER, SIN_HELPER]);
    this.callTrace = [];
    this.microprogramCalls = [];
    this.microinstructionPairs = 0;
    this.executedOpcodes = new Set();
  }

  r128(index) { return index ? this.gpr[index] & MASK128 : 0n; }
  u64(index) { return this.r128(index) & MASK64; }
  s64(index) { return BigInt.asIntN(64, this.u64(index)); }
  u32(index) { return Number(this.u64(index) & 0xFFFFFFFFn) >>> 0; }
  s32(index) { return this.u32(index) | 0; }
  setLow64(index, value) {
    if (!index) return;
    this.gpr[index] = (this.r128(index) & (MASK128 ^ MASK64)) | BigInt.asUintN(64, BigInt(value));
  }
  setSigned32(index, value) { this.setLow64(index, BigInt.asIntN(32, BigInt(value))); }
  setVector(index, value) { if (index) this.gpr[index] = BigInt.asUintN(128, BigInt(value)); }
  address(base, immediate) { return (this.u32(base) + sign16(immediate)) >>> 0; }
  getF(index) { return bitsToFloat(this.fprBits[index]); }
  setF(index, value) { this.fprBits[index] = floatToBits(value); }

  record(pc, word, instruction, delaySlot = false) {
    const row = { step: this.steps, pc: hex(pc), word: hex(word), instruction, delay_slot: Boolean(delaySlot) };
    this.traceRows.push(`${row.step}|${row.pc}|${row.word}|${row.delay_slot ? 1 : 0}\n`);
    if (this.trace.length < this.traceLimit) this.trace.push(row);
    this.steps++;
  }

  tag(name) { this.executedOpcodes.add(name); }

  applyMask(target, values, mask) {
    const bits = [8, 4, 2, 1];
    for (let component = 0; component < 4; component++) if (mask & bits[component]) target[component] = f32(values[component]);
  }

  executeCop1(pc, word) {
    const format = word >>> 21 & 31;
    const rt = word >>> 16 & 31;
    const fs = word >>> 11 & 31;
    const fd = word >>> 6 & 31;
    const fn = word & 63;
    if (format === 0) {
      this.setLow64(rt, BigInt(this.fprBits[fs]));
      this.tag('COP1:MFC1');
      return `mfc1 ${REG[rt]},f${fs}`;
    }
    if (format === 4) {
      this.fprBits[fs] = this.u32(rt);
      this.tag('COP1:MTC1');
      return `mtc1 ${REG[rt]},f${fs}`;
    }
    if (format === 20 && fn === 0x20) {
      this.setF(fd, this.fprBits[fs] | 0);
      this.tag('COP1:CVT.S.W');
      return `cvt.s.w f${fd},f${fs}`;
    }
    if (format === 16) {
      const left = this.getF(fs), right = this.getF(rt);
      if (fn === 0x00) { this.setF(fd, fadd(left, right)); this.tag('COP1:ADD.S'); return `add.s f${fd},f${fs},f${rt}`; }
      if (fn === 0x01) { this.setF(fd, fsub(left, right)); this.tag('COP1:SUB.S'); return `sub.s f${fd},f${fs},f${rt}`; }
      if (fn === 0x02) { this.setF(fd, fmul(left, right)); this.tag('COP1:MUL.S'); return `mul.s f${fd},f${fs},f${rt}`; }
      if (fn === 0x03) { this.setF(fd, fdiv(left, right)); this.tag('COP1:DIV.S'); return `div.s f${fd},f${fs},f${rt}`; }
      if (fn === 0x04) { this.setF(fd, f32(Math.sqrt(Math.max(0, left)))); this.tag('COP1:SQRT.S'); return `sqrt.s f${fd},f${fs}`; }
      if (fn === 0x05) { this.setF(fd, Math.abs(left)); this.tag('COP1:ABS.S'); return `abs.s f${fd},f${fs}`; }
      if (fn === 0x06) { this.fprBits[fd] = this.fprBits[fs]; this.tag('COP1:MOV.S'); return `mov.s f${fd},f${fs}`; }
      if (fn === 0x07) { this.setF(fd, -left); this.tag('COP1:NEG.S'); return `neg.s f${fd},f${fs}`; }
      if (fn === 0x18) { this.fpuAcc = fadd(left, right); this.tag('COP1:ADDA.S'); return `adda.s f${fs},f${rt}`; }
      if (fn === 0x19) { this.fpuAcc = fsub(left, right); this.tag('COP1:SUBA.S'); return `suba.s f${fs},f${rt}`; }
      if (fn === 0x1A) { this.fpuAcc = fmul(left, right); this.tag('COP1:MULA.S'); return `mula.s f${fs},f${rt}`; }
      if (fn === 0x1C) { this.setF(fd, fadd(this.fpuAcc, fmul(left, right))); this.tag('COP1:MADD.S'); return `madd.s f${fd},f${fs},f${rt}`; }
      if (fn === 0x1D) { this.setF(fd, fsub(this.fpuAcc, fmul(left, right))); this.tag('COP1:MSUB.S'); return `msub.s f${fd},f${fs},f${rt}`; }
      if (fn === 0x1E) { this.fpuAcc = fadd(this.fpuAcc, fmul(left, right)); this.tag('COP1:MADDA.S'); return `madda.s f${fs},f${rt}`; }
      if (fn === 0x1F) { this.fpuAcc = fsub(this.fpuAcc, fmul(left, right)); this.tag('COP1:MSUBA.S'); return `msuba.s f${fs},f${rt}`; }
      if (fn === 0x28) { this.setF(fd, Math.max(left, right)); this.tag('COP1:MAX.S'); return `max.s f${fd},f${fs},f${rt}`; }
      if (fn === 0x29) { this.setF(fd, Math.min(left, right)); this.tag('COP1:MIN.S'); return `min.s f${fd},f${fs},f${rt}`; }
      if (fn === 0x34) { this.fpuCondition = !Number.isNaN(left) && !Number.isNaN(right) && left < right; this.tag('COP1:C.LT.S'); return `c.lt.s f${fs},f${rt}`; }
      if (fn === 0x36) { this.fpuCondition = !Number.isNaN(left) && !Number.isNaN(right) && left <= right; this.tag('COP1:C.LE.S'); return `c.le.s f${fs},f${rt}`; }
    }
    throw new Error(`unsupported COP1 word ${hex(word)} at ${hex(pc)}`);
  }

  executeVuUpper(word, source = 'macro') {
    const mask = word >>> 21 & 15;
    const ft = word >>> 16 & 31;
    const fs = word >>> 11 & 31;
    const fd = word >>> 6 & 31;
    const op = word & 63;
    const special = op >= 0x3C;
    const operation = special ? ((fd << 2) | (op & 3)) : op;
    const values = new Float32Array(4);
    const fieldNames = 'XYZW';
    const target = this.vf[fd];
    const binary = (kind, rightForComponent) => {
      for (let c = 0; c < 4; c++) {
        const right = rightForComponent(c);
        if (kind === 'ADD') values[c] = fadd(this.vf[fs][c], right);
        else if (kind === 'SUB') values[c] = fsub(this.vf[fs][c], right);
        else if (kind === 'MUL') values[c] = fmul(this.vf[fs][c], right);
        else if (kind === 'MADD') values[c] = fadd(this.acc[c], fmul(this.vf[fs][c], right));
        else if (kind === 'MSUB') values[c] = fsub(this.acc[c], fmul(this.vf[fs][c], right));
        else if (kind === 'MAX') values[c] = f32(Math.max(this.vf[fs][c], right));
        else if (kind === 'MINI') values[c] = f32(Math.min(this.vf[fs][c], right));
      }
    };
    let name;
    if (!special) {
      if (operation <= 0x03) { name = `VADD${fieldNames[operation]}`; binary('ADD', () => this.vf[ft][operation]); }
      else if (operation <= 0x07) { name = `VSUB${fieldNames[operation & 3]}`; binary('SUB', () => this.vf[ft][operation & 3]); }
      else if (operation <= 0x0B) { name = `VMADD${fieldNames[operation & 3]}`; binary('MADD', () => this.vf[ft][operation & 3]); }
      else if (operation <= 0x0F) { name = `VMSUB${fieldNames[operation & 3]}`; binary('MSUB', () => this.vf[ft][operation & 3]); }
      else if (operation <= 0x13) { name = `VMAX${fieldNames[operation & 3]}`; binary('MAX', () => this.vf[ft][operation & 3]); }
      else if (operation <= 0x17) { name = `VMINI${fieldNames[operation & 3]}`; binary('MINI', () => this.vf[ft][operation & 3]); }
      else if (operation <= 0x1B) { name = `VMUL${fieldNames[operation & 3]}`; binary('MUL', () => this.vf[ft][operation & 3]); }
      else if (operation === 0x1C) { name = 'VMULQ'; binary('MUL', () => this.q); }
      else if (operation === 0x1D) { name = 'VMAXI'; binary('MAX', () => this.vuI); }
      else if (operation === 0x1E) { name = 'VMULI'; binary('MUL', () => this.vuI); }
      else if (operation === 0x1F) { name = 'VMINII'; binary('MINI', () => this.vuI); }
      else if (operation === 0x20) { name = 'VADDQ'; binary('ADD', () => this.q); }
      else if (operation === 0x21) { name = 'VMADDQ'; binary('MADD', () => this.q); }
      else if (operation === 0x22) { name = 'VADDI'; binary('ADD', () => this.vuI); }
      else if (operation === 0x23) { name = 'VMADDI'; binary('MADD', () => this.vuI); }
      else if (operation === 0x24) { name = 'VSUBQ'; binary('SUB', () => this.q); }
      else if (operation === 0x25) { name = 'VMSUBQ'; binary('MSUB', () => this.q); }
      else if (operation === 0x26) { name = 'VSUBI'; binary('SUB', () => this.vuI); }
      else if (operation === 0x27) { name = 'VMSUBI'; binary('MSUB', () => this.vuI); }
      else if (operation === 0x28) { name = 'VADD'; binary('ADD', c => this.vf[ft][c]); }
      else if (operation === 0x29) { name = 'VMADD'; binary('MADD', c => this.vf[ft][c]); }
      else if (operation === 0x2A) { name = 'VMUL'; binary('MUL', c => this.vf[ft][c]); }
      else if (operation === 0x2B) { name = 'VMAX'; binary('MAX', c => this.vf[ft][c]); }
      else if (operation === 0x2C) { name = 'VSUB'; binary('SUB', c => this.vf[ft][c]); }
      else if (operation === 0x2D) { name = 'VMSUB'; binary('MSUB', c => this.vf[ft][c]); }
      else if (operation === 0x2F) { name = 'VMINI'; binary('MINI', c => this.vf[ft][c]); }
      else throw new Error(`unsupported VU upper operation ${hex(operation, 2)} (${source})`);
      if (fd) this.applyMask(target, values, mask);
    } else if (operation <= 0x0F) {
      const family = operation >>> 2;
      const field = operation & 3;
      name = ['VADDA', 'VSUBA', 'VMADDA', 'VMSUBA'][family] + fieldNames[field];
      binary(['ADD', 'SUB', 'MADD', 'MSUB'][family], () => this.vf[ft][field]);
      this.applyMask(this.acc, values, mask);
    } else if (operation >= 0x10 && operation <= 0x17) {
      const shift = [0, 4, 12, 15][operation & 3];
      const toInteger = operation >= 0x14;
      name = `${toInteger ? 'VFTOI' : 'VITOF'}${shift}`;
      for (let c = 0; c < 4; c++) {
        if (toInteger) {
          const integer = Math.trunc(f32(this.vf[fs][c]) * (shift ? 2 ** shift : 1)) | 0;
          values[c] = bitsToFloat(integer >>> 0);
        } else {
          const integer = floatToBits(this.vf[fs][c]) | 0;
          values[c] = f32(integer / (shift ? 2 ** shift : 1));
        }
      }
      if (ft) this.applyMask(this.vf[ft], values, mask);
    } else if (operation >= 0x18 && operation <= 0x1B) {
      const field = operation & 3; name = `VMULA${fieldNames[field]}`;
      binary('MUL', () => this.vf[ft][field]); this.applyMask(this.acc, values, mask);
    } else if (operation === 0x1C || operation === 0x1E || operation === 0x2A) {
      name = operation === 0x1C ? 'VMULAQ' : operation === 0x1E ? 'VMULAI' : 'VMULA';
      binary('MUL', c => operation === 0x1C ? this.q : operation === 0x1E ? this.vuI : this.vf[ft][c]);
      this.applyMask(this.acc, values, mask);
    } else if (operation === 0x1D) {
      name = 'VABS'; for (let c = 0; c < 4; c++) values[c] = f32(Math.abs(this.vf[fs][c]));
      if (ft) this.applyMask(this.vf[ft], values, mask);
    } else if ([0x20,0x22,0x24,0x26,0x28,0x29,0x2C,0x2D].includes(operation)) {
      const rows = {
        0x20:['VADDAQ','ADD',() => this.q], 0x22:['VADDAI','ADD',() => this.vuI],
        0x24:['VSUBAQ','SUB',() => this.q], 0x26:['VSUBAI','SUB',() => this.vuI],
        0x28:['VADDA','ADD',c => this.vf[ft][c]], 0x29:['VMADDA','MADD',c => this.vf[ft][c]],
        0x2C:['VSUBA','SUB',c => this.vf[ft][c]], 0x2D:['VMSUBA','MSUB',c => this.vf[ft][c]],
      };
      const row = rows[operation]; name = row[0]; binary(row[1], row[2]); this.applyMask(this.acc, values, mask);
    } else if (operation === 0x2F || operation === 0x30) {
      name = 'VNOP';
    } else if (operation === 0x38) {
      const fsf = word >>> 21 & 3, ftf = word >>> 23 & 3, denominator = this.vf[ft][ftf];
      this.q = denominator !== 0 ? fdiv(this.vf[fs][fsf], denominator) : 0; name = 'VDIV';
    } else if (operation === 0x39) {
      const ftf = word >>> 23 & 3; this.q = f32(Math.sqrt(Math.max(0, this.vf[ft][ftf]))); name = 'VSQRT';
    } else if (operation === 0x3A) {
      const fsf = word >>> 21 & 3, ftf = word >>> 23 & 3, root = Math.sqrt(Math.max(0, this.vf[ft][ftf]));
      this.q = root > 0 ? fdiv(this.vf[fs][fsf], root) : 0; name = 'VRSQRT';
    } else if (operation === 0x3B) {
      name = 'VWAITQ';
    } else {
      throw new Error(`unsupported VU special operation ${hex(operation, 2)} (${source}, word ${hex(word)})`);
    }
    this.vf[0].set([0, 0, 0, 1]);
    this.tag(`VU:${name}`);
    return `${name.toLowerCase()}.${mask.toString(16)} (${source})`;
  }

  runVuMicroprogram(entryIndex, maxPairs = 64) {
    if (!this.vuProgram || this.vuProgram.length !== 4096) throw new Error(`VCALLMS ${hex(entryIndex, 3)} without the extracted 4096-byte VU0 program`);
    const rows = [];
    let pcIndex = entryIndex, endPending = false;
    for (let cycle = 0; cycle < maxPairs; cycle++) {
      if (pcIndex < 0 || pcIndex >= 512) throw new Error(`VU0 micro PC ${hex(pcIndex, 3)} is outside micro memory`);
      const lower = this.vuProgram.readUInt32LE(pcIndex * 8);
      const upper = this.vuProgram.readUInt32LE(pcIndex * 8 + 4);
      const iBit = Boolean(upper >>> 31 & 1), eBit = Boolean(upper >>> 30 & 1), wasEndPending = endPending;
      const upperText = this.executeVuUpper(upper, `micro@${hex(pcIndex, 3)}`);
      let lowerText = 'NOP';
      if (iBit) {
        this.vuI = bitsToFloat(lower);
        lowerText = `LOI ${this.vuI}`;
        this.tag('VU_MICRO:LOI');
      } else if (lower === 0 || lower === 0x8000033C) {
        lowerText = 'NOP';
      } else if (lower & 0x80000000 && ((lower & 3) | (lower >>> 4 & 0x7C)) === 0x30) {
        const mask = lower >>> 21 & 0xF;
        const destination = lower >>> 16 & 31;
        const source = lower >>> 11 & 31;
        const values = Float32Array.from(this.vf[source]);
        if (destination) this.applyMask(this.vf[destination], values, mask);
        lowerText = `MOVE.${mask.toString(16)} vf${destination},vf${source}`;
        this.tag('VU_MICRO:MOVE');
      } else {
        throw new Error(`unsupported VU0 lower word ${hex(lower)} at micro index ${hex(pcIndex, 3)}`);
      }
      rows.push({
        cycle,
        pc_instruction_index: hex(pcIndex, 3),
        pc_byte: hex(pcIndex * 8, 4),
        lower_word: hex(lower),
        lower_instruction: lowerText,
        upper_word: hex(upper),
        upper_instruction: upperText,
        i_bit: iBit,
        e_bit: eBit,
      });
      this.microinstructionPairs++;
      pcIndex++;
      if (wasEndPending) {
        const commitment = sha256(Buffer.from(rows.map(row => `${row.pc_instruction_index}|${row.lower_word}|${row.upper_word}\n`).join('')));
        const call = {
          entry_instruction_index: hex(entryIndex, 3),
          entry_byte_address: hex(entryIndex * 8, 4),
          stop_reason: 'E_BIT_DELAY_SLOT_COMPLETE',
          instruction_pairs: rows.length,
          trace_commitment_sha256: commitment,
        };
        if (this.traceLimit > 0) call.trace = rows;
        this.microprogramCalls.push(call);
        return call;
      }
      if (eBit) endPending = true;
    }
    throw new Error(`VU0 microprogram ${hex(entryIndex, 3)} exceeded ${maxPairs} instruction pairs`);
  }

  executeCop2(pc, word) {
    const format = word >>> 21 & 31;
    const rt = word >>> 16 & 31;
    const rd = word >>> 11 & 31;
    const fn = word & 63;
    if (format === 1) {
      let value = 0n;
      for (let component = 3; component >= 0; component--) value = value << 32n | BigInt(floatToBits(this.vf[rd][component]));
      this.setVector(rt, value); this.tag('COP2:QMFC2'); return `qmfc2 ${REG[rt]},vf${rd}`;
    }
    if (format === 2) {
      this.setLow64(rt, BigInt(rd === 0 ? this.vuStatus : 0)); this.tag('COP2:CFC2'); return `cfc2 ${REG[rt]},cr${rd}`;
    }
    if (format === 5) {
      const value = this.r128(rt);
      if (rd) for (let component = 0; component < 4; component++) this.vf[rd][component] = bitsToFloat(Number(value >> BigInt(component * 32) & 0xFFFFFFFFn));
      this.tag('COP2:QMTC2');
      return `qmtc2 ${REG[rt]},vf${rd}`;
    }
    if (format < 16) throw new Error(`unsupported COP2 format ${format} at ${hex(pc)}`);
    if (format === 16 && fn === 0x38) {
      const entryIndex = word >>> 6 & 0x1FF;
      this.runVuMicroprogram(entryIndex);
      this.tag('VU:VCALLMS');
      return `vcallms ${hex(entryIndex, 3)}`;
    }
    return this.executeVuUpper(word, `macro@${hex(pc)}`);
  }

  noncontrol(pc, word, delaySlot = false) {
    const op = word >>> 26;
    const rs = word >>> 21 & 31;
    const rt = word >>> 16 & 31;
    const rd = word >>> 11 & 31;
    const sa = word >>> 6 & 31;
    const fn = word & 63;
    const imm = word & 0xFFFF;
    let text;
    if (word === 0) {
      text = 'nop'; this.tag('NOP');
    } else if (op === 0) {
      if (fn === 0x00) { this.setSigned32(rd, (this.u32(rt) << sa) >>> 0); text = `sll ${REG[rd]},${REG[rt]},${sa}`; this.tag('SPECIAL:SLL'); }
      else if (fn === 0x21) { this.setSigned32(rd, (this.u32(rs) + this.u32(rt)) >>> 0); text = `addu ${REG[rd]},${REG[rs]},${REG[rt]}`; this.tag('SPECIAL:ADDU'); }
      else if (fn === 0x24) { this.setLow64(rd, this.u64(rs) & this.u64(rt)); text = `and ${REG[rd]},${REG[rs]},${REG[rt]}`; this.tag('SPECIAL:AND'); }
      else if (fn === 0x25) { this.setLow64(rd, this.u64(rs) | this.u64(rt)); text = `or ${REG[rd]},${REG[rs]},${REG[rt]}`; this.tag('SPECIAL:OR'); }
      else if (fn === 0x2A) { this.setLow64(rd, this.s64(rs) < this.s64(rt) ? 1n : 0n); text = `slt ${REG[rd]},${REG[rs]},${REG[rt]}`; this.tag('SPECIAL:SLT'); }
      else if (fn === 0x2B) { this.setLow64(rd, this.u64(rs) < this.u64(rt) ? 1n : 0n); text = `sltu ${REG[rd]},${REG[rs]},${REG[rt]}`; this.tag('SPECIAL:SLTU'); }
      else if (fn === 0x2D) { this.setLow64(rd, this.u64(rs) + this.u64(rt)); text = `daddu ${REG[rd]},${REG[rs]},${REG[rt]}`; this.tag('SPECIAL:DADDU'); }
      else if (fn === 0x38) { this.setLow64(rd, this.u64(rt) << BigInt(sa)); text = `dsll ${REG[rd]},${REG[rt]},${sa}`; this.tag('SPECIAL:DSLL'); }
      else if (fn === 0x3C) { this.setLow64(rd, this.u64(rt) << BigInt(sa + 32)); text = `dsll32 ${REG[rd]},${REG[rt]},${sa}`; this.tag('SPECIAL:DSLL32'); }
      else if (fn === 0x3E) { this.setLow64(rd, this.u64(rt) >> BigInt(sa + 32)); text = `dsrl32 ${REG[rd]},${REG[rt]},${sa}`; this.tag('SPECIAL:DSRL32'); }
      else if (fn === 0x3F) { this.setLow64(rd, this.s64(rt) >> BigInt(sa + 32)); text = `dsra32 ${REG[rd]},${REG[rt]},${sa}`; this.tag('SPECIAL:DSRA32'); }
      else throw new Error(`unsupported SPECIAL fn ${hex(fn, 2)} at ${hex(pc)} (word ${hex(word)})`);
    } else if (op === 0x09) {
      this.setSigned32(rt, (this.u32(rs) + sign16(imm)) >>> 0); text = `addiu ${REG[rt]},${REG[rs]},${sign16(imm)}`; this.tag('OP:ADDIU');
    } else if (op === 0x0A) {
      this.setLow64(rt, this.s64(rs) < BigInt(sign16(imm)) ? 1n : 0n); text = `slti ${REG[rt]},${REG[rs]},${sign16(imm)}`; this.tag('OP:SLTI');
    } else if (op === 0x0C) {
      this.setLow64(rt, this.u64(rs) & BigInt(imm)); text = `andi ${REG[rt]},${REG[rs]},${hex(imm, 4)}`; this.tag('OP:ANDI');
    } else if (op === 0x0D) {
      this.setLow64(rt, this.u64(rs) | BigInt(imm)); text = `ori ${REG[rt]},${REG[rs]},${hex(imm, 4)}`; this.tag('OP:ORI');
    } else if (op === 0x0E) {
      this.setLow64(rt, this.u64(rs) ^ BigInt(imm)); text = `xori ${REG[rt]},${REG[rs]},${hex(imm, 4)}`; this.tag('OP:XORI');
    } else if (op === 0x0F) {
      this.setSigned32(rt, (imm << 16) >>> 0); text = `lui ${REG[rt]},${hex(imm, 4)}`; this.tag('OP:LUI');
    } else if (op === 0x19) {
      this.setLow64(rt, this.s64(rs) + BigInt(sign16(imm))); text = `daddiu ${REG[rt]},${REG[rs]},${sign16(imm)}`; this.tag('OP:DADDIU');
    } else if (op === 0x1C && fn === 0x09 && sa === 0x0E) {
      this.setVector(rd, this.u64(rt) | this.u64(rs) << 64n); text = `pcpyld ${REG[rd]},${REG[rs]},${REG[rt]}`; this.tag('MMI2:PCPYLD');
    } else if ([0x20, 0x21, 0x23, 0x24, 0x25, 0x28, 0x29, 0x2B, 0x31, 0x36, 0x37, 0x39, 0x3F, 0x1E, 0x1F].includes(op)) {
      const address = this.address(rs, imm);
      if (op === 0x20) { this.setLow64(rt, BigInt.asIntN(8, this.memory.load(address, 1))); text = `lb ${REG[rt]},${sign16(imm)}(${REG[rs]})`; this.tag('MEM:LB'); }
      else if (op === 0x21) { this.setLow64(rt, BigInt.asIntN(16, this.memory.load(address, 2))); text = `lh ${REG[rt]},${sign16(imm)}(${REG[rs]})`; this.tag('MEM:LH'); }
      else if (op === 0x23) { this.setSigned32(rt, this.memory.load(address, 4)); text = `lw ${REG[rt]},${sign16(imm)}(${REG[rs]})`; this.tag('MEM:LW'); }
      else if (op === 0x24) { this.setLow64(rt, this.memory.load(address, 1)); text = `lbu ${REG[rt]},${sign16(imm)}(${REG[rs]})`; this.tag('MEM:LBU'); }
      else if (op === 0x25) { this.setLow64(rt, this.memory.load(address, 2)); text = `lhu ${REG[rt]},${sign16(imm)}(${REG[rs]})`; this.tag('MEM:LHU'); }
      else if (op === 0x28) { this.memory.store(address, this.u64(rt), 1); text = `sb ${REG[rt]},${sign16(imm)}(${REG[rs]})`; this.tag('MEM:SB'); }
      else if (op === 0x29) { this.memory.store(address, this.u64(rt), 2); text = `sh ${REG[rt]},${sign16(imm)}(${REG[rs]})`; this.tag('MEM:SH'); }
      else if (op === 0x2B) { this.memory.store(address, this.u64(rt), 4); text = `sw ${REG[rt]},${sign16(imm)}(${REG[rs]})`; this.tag('MEM:SW'); }
      else if (op === 0x31) { this.fprBits[rt] = Number(this.memory.load(address, 4)); text = `lwc1 f${rt},${sign16(imm)}(${REG[rs]})`; this.tag('MEM:LWC1'); }
      else if (op === 0x36) {
        const bytes = this.memory.read(address, 16);
        if (rt) for (let component = 0; component < 4; component++) this.vf[rt][component] = bitsToFloat(bytes.readUInt32LE(component * 4));
        text = `lqc2 vf${rt},${sign16(imm)}(${REG[rs]})`; this.tag('MEM:LQC2');
      }
      else if (op === 0x37) { this.setLow64(rt, this.memory.load(address, 8)); text = `ld ${REG[rt]},${sign16(imm)}(${REG[rs]})`; this.tag('MEM:LD'); }
      else if (op === 0x39) { this.memory.store(address, this.fprBits[rt], 4); text = `swc1 f${rt},${sign16(imm)}(${REG[rs]})`; this.tag('MEM:SWC1'); }
      else if (op === 0x3F) { this.memory.store(address, this.u64(rt), 8); text = `sd ${REG[rt]},${sign16(imm)}(${REG[rs]})`; this.tag('MEM:SD'); }
      else if (op === 0x1E) { this.setVector(rt, this.memory.load(address, 16)); text = `lq ${REG[rt]},${sign16(imm)}(${REG[rs]})`; this.tag('MEM:LQ'); }
      else { this.memory.store(address, this.r128(rt), 16); text = `sq ${REG[rt]},${sign16(imm)}(${REG[rs]})`; this.tag('MEM:SQ'); }
    } else if (op === 0x11) {
      text = this.executeCop1(pc, word);
    } else if (op === 0x12) {
      text = this.executeCop2(pc, word);
    } else if (op === 0x3E) {
      const address = this.address(rs, imm);
      const bytes = Buffer.alloc(16);
      for (let component = 0; component < 4; component++) bytes.writeUInt32LE(floatToBits(this.vf[rt][component]), component * 4);
      this.memory.write(address, bytes);
      text = `sqc2 vf${rt},${sign16(imm)}(${REG[rs]})`; this.tag('MEM:SQC2');
    } else if (op === 0x33) {
      text = `pref ${rt},${sign16(imm)}(${REG[rs]})`; this.tag('MEM:PREF');
    } else {
      throw new Error(`unsupported opcode ${hex(op, 2)} at ${hex(pc)} (word ${hex(word)})`);
    }
    this.record(pc, word, text, delaySlot);
  }

  delay(pc) {
    const word = Number(this.memory.load(pc, 4));
    const op = word >>> 26, rs = word >>> 21 & 31, fn = word & 63;
    if ([1,2,3,4,5,6,7].includes(op) || op === 0 && [8,9].includes(fn) || op === 0x11 && rs === 8) throw new Error(`control transfer in delay slot at ${hex(pc)}`);
    this.noncontrol(pc, word, true);
  }

  run(start = ENTRY, maxSteps = 20000) {
    let pc = start >>> 0;
    while (this.steps < maxSteps) {
      const word = Number(this.memory.load(pc, 4));
      const op = word >>> 26, rs = word >>> 21 & 31, rt = word >>> 16 & 31, fn = word & 63, imm = word & 0xFFFF;
      if (op === 3) {
        const target = ((pc + 4) & 0xF0000000) | ((word & 0x03FFFFFF) << 2);
        this.setLow64(31, pc + 8);
        this.record(pc, word, `jal ${hex(target)}`);
        this.tag('CTRL:JAL');
        this.delay(pc + 4);
        if (!this.allowedCalls.has(target)) throw new Error(`call outside bounded target ${hex(target)} from ${hex(pc)}`);
        const call = { call_site_va: hex(pc), target_va: hex(target), return_va: hex(pc + 8) };
        if (target === INTERPOLATOR) {
          call.arguments = {
            output_va: hex(this.u32(4)),
            left_quaternion_va: hex(this.u32(5)),
            right_quaternion_va: hex(this.u32(6)),
            amount_f12: this.getF(12),
          };
        } else if (target === ACOS_HELPER) {
          call.arguments = { input_f12: this.getF(12) };
        } else if (target === SIN_HELPER) {
          call.arguments = { input_f12: this.getF(12), input_f13: this.getF(13), input_f14: this.getF(14) };
        }
        this.callTrace.push(call);
        pc = target;
      } else if (op === 0 && fn === 9) {
        const target = this.u32(rs), rd = word >>> 11 & 31;
        if (!this.allowedCalls.has(target)) throw new Error(`indirect call outside bounded target ${hex(target)} from ${hex(pc)}`);
        this.setLow64(rd, pc + 8);
        this.record(pc, word, `jalr ${REG[rd]},${REG[rs]} -> ${hex(target)}`);
        this.tag('CTRL:JALR');
        this.delay(pc + 4);
        this.callTrace.push({ call_site_va: hex(pc), target_va: hex(target), return_va: hex(pc + 8), indirect: true });
        pc = target;
      } else if (op === 0 && fn === 8) {
        const target = this.u32(rs);
        this.record(pc, word, `jr ${REG[rs]} -> ${hex(target)}`);
        this.tag('CTRL:JR');
        this.delay(pc + 4);
        if (target === this.stopPc) return 'RETURN_SENTINEL';
        pc = target;
      } else if (op === 1 && (rt === 0 || rt === 1)) {
        const target = (pc + 4 + (sign16(imm) << 2)) >>> 0;
        const taken = rt === 0 ? this.s64(rs) < 0n : this.s64(rs) >= 0n;
        const name = rt === 0 ? 'bltz' : 'bgez';
        this.record(pc, word, `${name} ${REG[rs]} -> ${hex(target)} (${taken ? 'taken' : 'not taken'})`);
        this.tag(`CTRL:${name.toUpperCase()}`);
        this.delay(pc + 4);
        pc = taken ? target : pc + 8;
      } else if ([4,5,6,7].includes(op)) {
        const target = (pc + 4 + (sign16(imm) << 2)) >>> 0;
        let taken, name;
        if (op === 4) { taken = this.u64(rs) === this.u64(rt); name = 'beq'; }
        else if (op === 5) { taken = this.u64(rs) !== this.u64(rt); name = 'bne'; }
        else if (op === 6) { taken = this.s64(rs) <= 0n; name = 'blez'; }
        else { taken = this.s64(rs) > 0n; name = 'bgtz'; }
        this.record(pc, word, `${name} -> ${hex(target)} (${taken ? 'taken' : 'not taken'})`);
        this.tag(`CTRL:${name.toUpperCase()}`);
        this.delay(pc + 4);
        pc = taken ? target : pc + 8;
      } else if (op === 0x11 && rs === 8) {
        const target = (pc + 4 + (sign16(imm) << 2)) >>> 0;
        if (rt > 1) throw new Error(`unsupported COP1 likely branch at ${hex(pc)}`);
        const taken = rt === 1 ? this.fpuCondition : !this.fpuCondition;
        const name = rt === 1 ? 'bc1t' : 'bc1f';
        this.record(pc, word, `${name} -> ${hex(target)} (${taken ? 'taken' : 'not taken'})`);
        this.tag(`CTRL:${name.toUpperCase()}`);
        this.delay(pc + 4);
        pc = taken ? target : pc + 8;
      } else {
        this.noncontrol(pc, word);
        pc = (pc + 4) >>> 0;
      }
    }
    throw new Error(`instruction limit ${maxSteps} reached`);
  }
}

function encodeKeys(keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 0x7FFF) throw new Error('type-0x0135 track must contain 1..32767 keys');
  let prior = -1;
  const bytes = Buffer.alloc(keys.length * 8);
  keys.forEach((key, index) => {
    if (!Array.isArray(key.xyz) || key.xyz.length !== 3 || key.xyz.some(value => !Number.isInteger(value) || value < -32768 || value > 32767)) throw new Error(`invalid xyz at key ${index}`);
    if (!Number.isInteger(key.time) || key.time < 0 || key.time > 0xFFFF) throw new Error(`invalid time at key ${index}`);
    if (index && key.time <= prior) throw new Error(`non-increasing type-0x0135 key time at key ${index}: ${key.time} <= ${prior}`);
    key.xyz.forEach((value, component) => bytes.writeInt16LE(value, index * 8 + component * 2));
    bytes.writeUInt16LE(key.time, index * 8 + 6);
    prior = key.time;
  });
  return bytes;
}

function buildExecutionFixture(libInput, keys, options = {}) {
  const lib = Buffer.from(libInput), keyBytes = encodeKeys(keys), memory = new BoundedMemory();
  if (lib.length < 0x40 || lib.toString('ascii', 0, 4) !== 'MWo3' || lib.readUInt32LE(8) !== LIB_LOAD) throw new Error('expected the packaged Lib MWo3 image at 0x003E6880');
  const zeroFillSize = lib.readUInt32LE(0x14);
  const moduleImage = Buffer.alloc(lib.length + zeroFillSize);
  lib.copy(moduleImage);
  const vuProgramInfo = options.vuProgramInfo || VuMatrix.extractVu0Program(lib);
  const track = Buffer.alloc(0x80), output = Buffer.alloc(0x10), stack = Buffer.alloc(0x4000);
  memory.map(LIB_LOAD, moduleImage, 'Lib.bin_file_and_declared_zero_fill', true);
  memory.map(TRACK_BASE, track, 'runtime_type_0x0135_track', true);
  memory.map(OUTPUT_BASE, output, 'quaternion_output', true);
  memory.map(KEYS_BASE, keyBytes, 'raw_type_0x0135_keys', false);
  memory.map(STACK_TOP - stack.length, stack, 'target_stack', true);
  const initializerCpu = new FasRotationR5900(memory, { traceLimit: options.initializerTraceLimit ?? 0, vuProgram: vuProgramInfo.program, allowedCalls: [] });
  initializerCpu.setLow64(29, STACK_TOP);
  initializerCpu.setLow64(31, SENTINEL);
  const initializerStop = initializerCpu.run(MATH_TABLE_INITIALIZER, 512);
  const mathTable = Buffer.from(memory.read(MATH_TABLE_BASE, MATH_TABLE_SIZE));
  track.writeUInt32LE(KEYS_BASE, 0x04);
  track.writeInt16LE(keys.length, 0x18);
  track.writeInt16LE(0, 0x1C);
  track.writeInt16LE(-1, 0x1E);
  return {
    lib,
    moduleImage,
    zeroFillSize,
    vuProgramInfo,
    keys,
    keyBytes,
    memory,
    track,
    output,
    stack,
    initializer: {
      entry_va: hex(MATH_TABLE_INITIALIZER),
      stop_reason: initializerStop,
      original_guest_instructions: initializerCpu.steps,
      table_base_va: hex(MATH_TABLE_BASE),
      table_byte_size: MATH_TABLE_SIZE,
      table_sha256_after_original_initializer: sha256(mathTable),
      trace_commitment_sha256: sha256(Buffer.from(initializerCpu.traceRows.join(''))),
    },
    options,
  };
}

function executeFixtureAt(fixture, time, options = {}) {
  fixture.output.fill(0);
  const cpu = new FasRotationR5900(fixture.memory, { traceLimit: options.traceLimit ?? 500, vuProgram: fixture.vuProgramInfo.program });
  cpu.setLow64(4, OUTPUT_BASE);
  cpu.setLow64(5, TRACK_BASE);
  cpu.setLow64(29, STACK_TOP);
  cpu.setLow64(31, SENTINEL);
  cpu.setF(12, time);
  const stopReason = cpu.run(ENTRY, options.maxSteps ?? 20000);
  const quaternion = readQuaternion(fixture.memory, OUTPUT_BASE);
  if (quaternion.some(value => !Number.isFinite(value))) throw new Error(`non-finite quaternion at time ${time}`);
  return {
    time,
    stop_reason: stopReason,
    instruction_count: cpu.steps,
    original_interpolator_calls: cpu.callTrace.filter(row => row.target_va === hex(INTERPOLATOR)).length,
    original_acos_helper_calls: cpu.callTrace.filter(row => row.target_va === hex(ACOS_HELPER)).length,
    original_sine_helper_calls: cpu.callTrace.filter(row => row.target_va === hex(SIN_HELPER)).length,
    host_model_calls: 0,
    call_trace: cpu.callTrace,
    original_vu0_microprogram_calls: cpu.microprogramCalls,
    original_vu0_microinstruction_pairs: cpu.microinstructionPairs,
    current_key_index: fixture.track.readInt16LE(0x1C),
    cached_key_index: fixture.track.readInt16LE(0x1E),
    cache_terminal_flag: fixture.track.readUInt32LE(0x10),
    quaternion,
    quaternion_sha256: sha256(fixture.output),
    norm: Math.hypot(...quaternion),
    executed_opcodes: [...cpu.executedOpcodes].sort(),
    trace_commitment_sha256: sha256(Buffer.from(cpu.traceRows.join(''))),
    trace_records_committed: cpu.traceRows.length,
    trace_records_retained: cpu.trace.length,
    trace: cpu.trace,
  };
}

function executeTrack(lib, keys, time, options = {}) {
  return executeFixtureAt(buildExecutionFixture(lib, keys, options), time, options);
}

function decompressOracle(key) {
  const xyz = key.xyz.map(value => f32(value / 32768));
  const squares = xyz.map(value => fmul(value, value));
  let residual = f32(1);
  residual = fsub(residual, squares[0]);
  residual = fsub(residual, squares[1]);
  residual = fsub(residual, squares[2]);
  return [...xyz, f32(Math.sqrt(Math.max(0, residual)))];
}

function quaternionBytes(quaternion) {
  const bytes = Buffer.alloc(16);
  quaternion.forEach((value, index) => bytes.writeFloatLE(f32(value), index * 4));
  return bytes;
}

function independentBracket(keys, time) {
  if (time >= keys[keys.length - 1].time) return { terminal: true, index: keys.length - 1, amount: null };
  let index = 0;
  while (index + 1 < keys.length && time >= keys[index + 1].time) index++;
  const amount = (time - keys[index].time) / (keys[index + 1].time - keys[index].time);
  return { terminal: false, index, amount };
}

function collectTracks(clips) {
  const rows = [];
  for (const clip of clips) {
    const bytes = Buffer.from(clip.bytes), parsed = Geometry.parseFas(bytes);
    parsed.channels.forEach((channel, channelIndex) => channel.subs.forEach((sub, subIndex) => {
      if (sub.type !== 0x135) return;
      rows.push({
        actor: clip.actor,
        source_name: clip.name,
        source_sha256: sha256(bytes),
        channel_index: channelIndex,
        channel_off: channel.off,
        channel_name: channel.name,
        sub_index: subIndex,
        keys: sub.quantized,
      });
    }));
  }
  return rows;
}

function compactExecution(execution, includeTrace = false) {
  const { trace, ...row } = execution;
  return includeTrace ? execution : row;
}

function findMutationTrack(tracks) {
  return tracks.find(row => row.actor === '0x0BC0' && /0020/i.test(row.source_name) && /L Calf/i.test(row.channel_name)) || tracks.find(row => row.keys.length >= 3);
}

function findMicroprogramTrack(tracks) {
  return tracks.find(row => {
    if (row.keys.length < 2) return false;
    const q0 = decompressOracle(row.keys[0]), q1 = decompressOracle(row.keys[1]);
    return Math.abs(q0.reduce((sum, value, index) => sum + value * q1[index], 0)) < 0.999;
  });
}

function runControls(lib, tracks) {
  const source = findMutationTrack(tracks);
  if (!source) throw new Error('no real multi-key track is available for mutation controls');
  const baseLast = executeTrack(lib, source.keys, source.keys[source.keys.length - 1].time, { traceLimit: 80 });
  const mutatedKeys = source.keys.map(key => ({ xyz: [...key.xyz], time: key.time }));
  const last = mutatedKeys[mutatedKeys.length - 1];
  last.xyz[0] += last.xyz[0] < 32767 ? 1 : -1;
  const mutatedLast = executeTrack(lib, mutatedKeys, last.time, { traceLimit: 80 });
  const mutationChangedOutput = baseLast.quaternion_sha256 !== mutatedLast.quaternion_sha256;
  const mutationMatchesOracle = quaternionBytes(decompressOracle(last)).equals(quaternionBytes(mutatedLast.quaternion));
  if (!mutationChangedOutput || !mutationMatchesOracle || mutatedLast.original_interpolator_calls) throw new Error('raw-key mutation control did not change original-only decompressor output as expected');

  let nonIncreasingRejected = false;
  try {
    const invalid = source.keys.map(key => ({ xyz: [...key.xyz], time: key.time }));
    invalid[1].time = invalid[0].time;
    executeTrack(lib, invalid, invalid[0].time);
  } catch (error) {
    nonIncreasingRejected = /non-increasing/.test(error.message);
  }
  if (!nonIncreasingRejected) throw new Error('non-increasing time control was not rejected');

  let unknownOpcodeRejected = false, unknownOpcodeError = null;
  try {
    const mutatedLib = Buffer.from(lib);
    mutatedLib.writeUInt32LE(0x74000000, ENTRY - LIB_LOAD); // opcode 0x1D is outside the bounded evaluator subset
    executeTrack(mutatedLib, source.keys, source.keys[source.keys.length - 1].time);
  } catch (error) {
    unknownOpcodeError = error.message;
    unknownOpcodeRejected = /unsupported/.test(error.message);
  }
  if (!unknownOpcodeRejected) throw new Error('unknown-opcode control did not fail closed');

  const microSource = findMicroprogramTrack(tracks);
  if (!microSource) throw new Error('no real track exercises the original VU0 sine microprogram');
  const programInfo = VuMatrix.extractVu0Program(lib);
  const mutatedProgramInfo = { ...programInfo, program: Buffer.from(programInfo.program) };
  mutatedProgramInfo.program.writeUInt32LE(0xDEADBEEF, 0x13E * 8);
  let unknownMicroRejected = false, unknownMicroError = null;
  try {
    const midpoint = f32((microSource.keys[0].time + microSource.keys[1].time) / 2);
    executeFixtureAt(buildExecutionFixture(lib, microSource.keys, { vuProgramInfo: mutatedProgramInfo }), midpoint, { traceLimit: 0 });
  } catch (error) {
    unknownMicroError = error.message;
    unknownMicroRejected = /unsupported VU0 lower word/.test(error.message);
  }
  if (!unknownMicroRejected) throw new Error('unknown VU0 microinstruction control did not fail closed');

  const memory = new BoundedMemory(), track = Buffer.alloc(0x80), output = Buffer.alloc(0x10), stack = Buffer.alloc(0x4000);
  const moduleImage = Buffer.alloc(lib.length + lib.readUInt32LE(0x14));
  lib.copy(moduleImage);
  memory.map(LIB_LOAD, moduleImage, 'Lib.bin_file_and_declared_zero_fill', true);
  memory.map(TRACK_BASE, track, 'null_key_track', true);
  memory.map(OUTPUT_BASE, output, 'null_key_output', true);
  memory.map(STACK_TOP - stack.length, stack, 'target_stack', true);
  const cpu = new FasRotationR5900(memory, { traceLimit: 80, vuProgram: programInfo.program });
  cpu.setLow64(4, OUTPUT_BASE); cpu.setLow64(5, TRACK_BASE); cpu.setLow64(29, STACK_TOP); cpu.setLow64(31, SENTINEL); cpu.setF(12, 0);
  const nullStop = cpu.run();
  const nullQuaternion = readQuaternion(memory, OUTPUT_BASE);
  const nullOutputsZero = nullQuaternion.every(value => Object.is(value, 0));
  if (!nullOutputsZero || cpu.callTrace.length || cpu.microprogramCalls.length) throw new Error('null-pointer original path did not return four zero components');

  return {
    source: { actor: source.actor, clip: source.source_name, channel: source.channel_name },
    raw_key_mutation: {
      changed_key: 'last.xyz[0] by one signed quantization unit',
      base_output_sha256: baseLast.quaternion_sha256,
      mutated_output_sha256: mutatedLast.quaternion_sha256,
      output_changed: mutationChangedOutput,
      mutated_output_byte_exact_against_oracle: mutationMatchesOracle,
      original_only: mutatedLast.original_interpolator_calls === 0,
    },
    malformed_time: { non_increasing_rejected_before_execution: nonIncreasingRejected },
    unknown_opcode: { rejected_fail_closed: unknownOpcodeRejected, error: unknownOpcodeError },
    unknown_vu0_microinstruction: {
      source: { actor: microSource.actor, clip: microSource.source_name, channel: microSource.channel_name },
      mutated_instruction_index: hex(0x13E, 3),
      rejected_fail_closed: unknownMicroRejected,
      error: unknownMicroError,
    },
    null_key_pointer: {
      stop_reason: nullStop,
      instruction_count: cpu.steps,
      quaternion: nullQuaternion,
      outputs_four_zero_components: nullOutputsZero,
      original_interpolator_calls: cpu.callTrace.filter(row => row.target_va === hex(INTERPOLATOR)).length,
      original_vu0_microprogram_calls: cpu.microprogramCalls.length,
      host_model_calls: 0,
    },
  };
}

function buildReport({ lib: libInput, clips, ps2RecompCommit = 'ee149581aac999ab22791b3900377c0b028a5840' }) {
  const lib = Buffer.from(libInput), tracks = collectTracks(clips);
  if (!tracks.length) throw new Error('no type-0x0135 tracks found');
  const programInfo = VuMatrix.extractVu0Program(lib);
  const microTraceSource = findMicroprogramTrack(tracks);
  const microTraceTrackIndex = tracks.indexOf(microTraceSource);
  const results = [], opcodeUnion = new Set();
  let totalInstructions = 0, terminalInvocations = 0, interpolatedInvocations = 0;
  let interpolatorCalls = 0, acosCalls = 0, sineCalls = 0, microCalls = 0, microPairs = 0, totalKeys = 0;
  let initializerEvidence = null, maxSignInvariantOracleError = 0;
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const track = tracks[trackIndex], keys = track.keys;
    encodeKeys(keys);
    const firstTime = keys[0].time;
    const midpoint = keys.length > 1 ? f32((keys[0].time + keys[1].time) / 2) : firstTime;
    const lastTime = keys[keys.length - 1].time;
    const fixture = buildExecutionFixture(lib, keys, { vuProgramInfo: programInfo });
    if (!initializerEvidence) initializerEvidence = fixture.initializer;
    const samples = [firstTime, midpoint, lastTime].map((time, sampleIndex) => executeFixtureAt(fixture, time, {
      traceLimit: trackIndex === microTraceTrackIndex && sampleIndex === 1 ? 1200 : 0,
      maxSteps: 50000,
    }));
    const checks = samples.map(sample => {
      const bracket = independentBracket(keys, sample.time);
      const interpolationCall = sample.call_trace.find(row => row.target_va === hex(INTERPOLATOR));
      const selectedExact = bracket.terminal ? !interpolationCall : sample.current_key_index === bracket.index && Boolean(interpolationCall);
      const amountExact = bracket.terminal || Math.abs(interpolationCall.arguments.amount_f12 - bracket.amount) <= 1e-6;
      if (!selectedExact || !amountExact) throw new Error(`${track.source_name}:${track.channel_name} original key selection differs from independent bracket at ${sample.time}`);
      const oracle = bracket.terminal
        ? decompressOracle(keys[keys.length - 1])
        : shortestPathSlerp(decompressOracle(keys[bracket.index]), decompressOracle(keys[bracket.index + 1]), bracket.amount);
      const directError = Math.max(...oracle.map((value, index) => Math.abs(value - sample.quaternion[index])));
      const negatedError = Math.max(...oracle.map((value, index) => Math.abs(value + sample.quaternion[index])));
      const signInvariantError = Math.min(directError, negatedError);
      maxSignInvariantOracleError = Math.max(maxSignInvariantOracleError, signInvariantError);
      if (signInvariantError > 2e-7) throw new Error(`${track.source_name}:${track.channel_name} original quaternion differs from the sign-invariant slerp oracle by ${signInvariantError}`);
      if (bracket.terminal) {
        const expected = quaternionBytes(decompressOracle(keys[keys.length - 1]));
        if (!expected.equals(quaternionBytes(sample.quaternion))) throw new Error(`${track.source_name}:${track.channel_name} terminal decompression differs byte-for-byte`);
      }
      if (Math.abs(sample.norm - 1) > 2e-5) throw new Error(`${track.source_name}:${track.channel_name} non-unit quaternion at ${sample.time}: ${sample.norm}`);
      return {
        bracket,
        key_selection_exact: selectedExact,
        interpolation_amount_exact: amountExact,
        independent_shortest_path_slerp_oracle: oracle,
        direct_max_abs_error: directError,
        negated_max_abs_error: negatedError,
        quaternion_sign_invariant_max_abs_error: signInvariantError,
        within_two_float32_ulps: signInvariantError <= 2e-7,
      };
    });
    samples.forEach(sample => {
      totalInstructions += sample.instruction_count;
      interpolatorCalls += sample.original_interpolator_calls;
      acosCalls += sample.original_acos_helper_calls;
      sineCalls += sample.original_sine_helper_calls;
      microCalls += sample.original_vu0_microprogram_calls.length;
      microPairs += sample.original_vu0_microinstruction_pairs;
      sample.executed_opcodes.forEach(value => opcodeUnion.add(value));
      if (sample.original_interpolator_calls) interpolatedInvocations++; else terminalInvocations++;
    });
    totalKeys += keys.length;
    results.push({
      actor: track.actor,
      source_name: track.source_name,
      source_sha256: track.source_sha256,
      channel_index: track.channel_index,
      channel_off: hex(track.channel_off),
      channel_name: track.channel_name,
      sub_index: track.sub_index,
      key_count: keys.length,
      first_time: firstTime,
      last_time: lastTime,
      key_payload_sha256: sha256(encodeKeys(keys)),
      samples: samples.map((sample, index) => ({ ...compactExecution(sample, trackIndex === microTraceTrackIndex && index === 1), checks: checks[index] })),
    });
  }
  const controls = runControls(lib, tracks);
  const allTerminalExact = results.every(row => {
    const sample = row.samples[2], expected = decompressOracle(tracks.find(track => track.actor === row.actor && track.source_name === row.source_name && track.channel_index === row.channel_index && track.sub_index === row.sub_index).keys.at(-1));
    return quaternionBytes(sample.quaternion).equals(quaternionBytes(expected));
  });
  const clipSummaries = clips.map(clip => {
    const rows = results.filter(row => row.actor === clip.actor && row.source_name === clip.name);
    return {
      actor: clip.actor,
      source_name: clip.name,
      source_sha256: sha256(clip.bytes),
      type_0x0135_tracks: rows.length,
      quantized_keys: rows.reduce((sum, row) => sum + row.key_count, 0),
      terminal_original_execution_witnesses: rows.length,
      between_key_original_interpolation_witnesses: rows.length * 2,
    };
  });
  const firstMicroSample = results[microTraceTrackIndex].samples[1];
  const uniqueMicroPaths = [...new Map(firstMicroSample.original_vu0_microprogram_calls.map(row => [row.entry_instruction_index, row])).values()];
  return {
    format: 'SO3_FAS_ROTATION_R5900_EXECUTION_REPORT_V2',
    status: 'EXECUTED_ORIGINAL_R5900_VU0_MACRO_AND_MICROCODE',
    promotion: {
      type_0x0135_key_selection_and_clock: true,
      type_0x0135_quantized_quaternion_decompression: true,
      interpolation_helper_original_execution: true,
      interpolation_vu0_microprogram_execution: true,
      runtime_node_matrix_write: false,
      final_skinning: false,
    },
    purpose: 'Execute the original SO3 type-0x0135 FAS evaluator, original quaternion interpolation helpers, and their exact embedded VU0 microprogram entries over every supplied 0x08FF/0x0BC0 rotation track without a host interpolation substitution.',
    module: {
      name: 'Lib.bin',
      load_address: hex(LIB_LOAD),
      sha256: sha256(lib),
      file_bytes: lib.length,
      declared_zero_fill_bytes: lib.readUInt32LE(0x14),
      allocation_end_exclusive: hex(LIB_LOAD + lib.length + lib.readUInt32LE(0x14)),
      evaluator_entry_va: hex(ENTRY),
      evaluator_end_exclusive_va: hex(END_EXCLUSIVE),
      evaluator_slice_sha256: sha256(lib.subarray(ENTRY - LIB_LOAD, END_EXCLUSIVE - LIB_LOAD)),
      interpolator_va: hex(INTERPOLATOR),
      acos_helper_va: hex(ACOS_HELPER),
      sine_helper_va: hex(SIN_HELPER),
      math_table_initializer: initializerEvidence,
    },
    vu0_microprogram: {
      upload_segments: programInfo.segments.map(({ payload_offset, payload_bytes, ...row }) => row),
      occupied_instruction_count: programInfo.occupiedInstructionCount,
      occupied_sha256: programInfo.occupiedProgramSha256,
      complete_4096_byte_memory_sha256: programInfo.programSha256,
      executed_entries: uniqueMicroPaths.map(row => ({
        entry_instruction_index: row.entry_instruction_index,
        entry_byte_address: row.entry_byte_address,
        instruction_pairs: row.instruction_pairs,
        stop_reason: row.stop_reason,
        trace_commitment_sha256: row.trace_commitment_sha256,
        trace: row.trace,
      })),
    },
    original_data_flow: [
      'descriptor type 0x0135 at 0x004BD768 dispatches to 0x004AD7D0',
      'runtime track +0x04 points to raw 8-byte FAS keys; +0x18 is count; +0x1C/+0x1E cache the bracket index',
      'each raw key is {s16 x,s16 y,s16 z,u16 time}',
      'original COP1 instructions select the time bracket and compute (time-t0)/(t1-t0)',
      'original VU0 macro instructions execute VITOF15 and reconstruct positive w=sqrt(max(0,1-x^2-y^2-z^2))',
      'between keys, original code calls 0x004CD310, which calls the original 0x004CCF80 angle helper and conditionally 0x004CD230 sine helper',
      '0x004CD230 invokes embedded VU0 instruction entries 0x13D, 0x143, and 0x14F; all reached upper/LOI pairs execute directly from Lib MPG payloads',
      'the original 0x00507610 initializer materializes the helper coefficient table in Lib zero-fill at 0x0050CBC0 before evaluator execution',
    ],
    independent_decoder_reference: {
      project: 'ran-j/PS2Recomp',
      commit: ps2RecompCommit,
      files: [
        'ps2xRecomp/src/lib/r5900_decoder.cpp',
        'ps2xRecomp/src/lib/fpu_translator.cpp',
        'ps2xRecomp/src/lib/vu_translation_helpers.cpp',
        'ps2xRuntime/src/lib/vu/ps2_vu1_core.cpp',
        'ps2xRuntime/src/lib/vu/ps2_vu1_upper.cpp',
      ],
      use: 'R5900 low-64 preservation, COP1 accumulator semantics, COP2/VU0 macro fields, VCALLMS target decoding, LOI commit order, E-bit delay termination, and VU upper arithmetic. SO3 code and all input/output bytes are independently hashed here.',
    },
    aggregate: {
      actors: new Set(clips.map(row => row.actor)).size,
      clips: clips.length,
      type_0x0135_tracks: tracks.length,
      quantized_keys: totalKeys,
      evaluator_invocations: terminalInvocations + interpolatedInvocations,
      fully_original_evaluator_invocations: terminalInvocations + interpolatedInvocations,
      fully_original_terminal_key_invocations: terminalInvocations,
      fully_original_between_key_interpolation_invocations: interpolatedInvocations,
      original_interpolator_calls: interpolatorCalls,
      original_acos_helper_calls: acosCalls,
      original_sine_helper_calls: sineCalls,
      original_vu0_microprogram_invocations: microCalls,
      original_vu0_microinstruction_pairs_executed: microPairs,
      host_interpolation_or_math_calls: 0,
      original_guest_instructions_executed: totalInstructions,
      original_math_table_initializer_guest_instructions_per_fixture: initializerEvidence.original_guest_instructions,
      all_original_terminal_outputs_byte_exact_against_independent_decompression_oracle: allTerminalExact,
      all_key_brackets_and_amounts_match_independent_oracle: results.every(row => row.samples.every(sample => sample.checks.key_selection_exact && sample.checks.interpolation_amount_exact)),
      all_original_outputs_match_sign_invariant_shortest_path_slerp_oracle_within_two_float32_ulps: results.every(row => row.samples.every(sample => sample.checks.within_two_float32_ulps)),
      maximum_sign_invariant_max_abs_error_against_oracle: maxSignInvariantOracleError,
      all_outputs_finite_and_unit_length: results.every(row => row.samples.every(sample => sample.quaternion.every(Number.isFinite) && Math.abs(sample.norm - 1) <= 2e-5)),
      executed_opcode_families: [...opcodeUnion].sort(),
    },
    clips: clipSummaries,
    tracks: results,
    controls,
    gates: {
      fas_type_0x0135_record_layout: 'PASS_REAL_BYTES',
      fas_key_selection_clock: 'PASS_EXECUTED_ORIGINAL_R5900',
      fas_quantized_rotation_decompression: 'PASS_EXECUTED_ORIGINAL_R5900_VU0_MACRO',
      fas_positive_w_reconstruction: 'PASS_EXECUTED_ORIGINAL_R5900_VU0_MACRO',
      lib_math_table_initialization: 'PASS_EXECUTED_ORIGINAL_R5900',
      fas_interpolation: 'PASS_EXECUTED_ORIGINAL_R5900_VU0_MACRO_AND_MICROCODE',
      fas_to_runtime_node_setter: 'PASS_STATIC_CALLSITE_ONLY',
      runtime_node_matrix_write: 'WITHHELD_UNRESOLVED',
      final_skinning: 'WITHHELD_UNRESOLVED',
    },
    boundaries: [
      'The 0x004AD7D0 key search, cache maintenance, time fraction, packed-lane construction, VITOF15 conversion, positive-w reconstruction, 0x004CD310 interpolation, 0x004CCF80 angle approximation, and 0x004CD230 sine path are executed instruction by instruction from the packaged Lib image.',
      'Terminal-key runs do not invoke any host math helper and are byte-exact against an independently implemented float32 decompression oracle.',
      'Between-key runs execute the original helper. Depending on quaternion proximity, the original helper either takes its near-linear branch or invokes all three embedded VU0 sine microprogram entries.',
      'Quaternion q and -q represent the same rotation. The independent comparison therefore takes the smaller component error against q and -q; every sample is within two float32 ULP-sized steps and the observed maximum is recorded.',
      'The embedded VU0 paths reached here contain only upper FMAC instructions, LOI immediates, and E-bit termination. Any unexpected lower instruction is a hard failure; a negative control proves that boundary.',
      'This pass does not yet execute the descriptor dispatcher, the target-node quaternion setter, node-local matrix construction, or final vertex skinning.',
      'The interpreter implements only opcode families reached by the initializer/evaluator/helpers. Every unexpected opcode and unmapped memory access is a hard failure.',
    ],
  };
}

function cli(argv) {
  const args = { clips: [] };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--lib') args.lib = argv[++index];
    else if (key === '--fas') args.clips.push({ actor: argv[++index], file: argv[++index] });
    else if (key === '--output') args.output = argv[++index];
    else throw new Error(`unknown argument ${key}`);
  }
  if (!args.lib || !args.clips.length || !args.output) throw new Error('usage: run_fas_rotation_r5900.js --lib Lib.bin --fas 0x08FF clip.fas [--fas ...] --output report.json');
  const report = buildReport({
    lib: fs.readFileSync(args.lib),
    clips: args.clips.map(row => ({ actor: row.actor, name: path.basename(row.file), bytes: fs.readFileSync(row.file) })),
  });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: report.status, output: args.output, tracks: report.aggregate.type_0x0135_tracks, instructions: report.aggregate.original_guest_instructions_executed })}\n`);
}

module.exports = Object.freeze({
  LIB_LOAD,
  ENTRY,
  END_EXCLUSIVE,
  INTERPOLATOR,
  BoundedMemory,
  FasRotationR5900,
  encodeKeys,
  buildExecutionFixture,
  executeFixtureAt,
  executeTrack,
  decompressOracle,
  independentBracket,
  shortestPathSlerp,
  collectTracks,
  buildReport,
});

if (require.main === module) cli(process.argv.slice(2));
