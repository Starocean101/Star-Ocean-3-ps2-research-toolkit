/* SO3 Resource Explorer V5.10.1 targeted R5900 runtime reconstruction core. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SO3V510TargetRuntime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '5.10.1', MASK32 = 0xffffffffn, MASK64 = (1n << 64n) - 1n, MASK128 = (1n << 128n) - 1n;
  const REG = ['zero','at','v0','v1','a0','a1','a2','a3','t0','t1','t2','t3','t4','t5','t6','t7','s0','s1','s2','s3','s4','s5','s6','s7','t8','t9','k0','k1','gp','sp','fp','ra'];
  const DEFAULT_CONTENT_KEY = Uint8Array.from([0x66,0x66,0x54,0x42,0xb3,0x79,0xf0,0xc7,0xe7,0xd5,0x1e,0x4b,0x7b,0xa4,0x1c,0x7d]);

  function asBytes(input) { if (input instanceof Uint8Array) return input; if (input instanceof ArrayBuffer) return new Uint8Array(input); if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength); return Uint8Array.from(input || []); }
  function sxNumber(value, bits) { const sign = 2 ** (bits - 1), full = 2 ** bits, v = Number(value) & (full - 1); return v >= sign ? v - full : v; }
  function sxBig(value, bits) { const width = 1n << BigInt(bits), sign = width >> 1n, v = BigInt(value) & (width - 1n); return v & sign ? v - width : v; }
  function sx128(value, bits) { return sxBig(value, bits) & MASK128; }
  function hex(value, width = 8) { return `0x${Number(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`; }

  class SparseMemory {
    constructor() { this.pageSize = 0x1000; this.pages = new Map(); this.regions = []; }
    page(address, create = false) { const number = Math.floor(address / this.pageSize); if (!this.pages.has(number) && create) this.pages.set(number, new Uint8Array(this.pageSize)); return this.pages.get(number); }
    map(address, input, name, memorySize) { const data = asBytes(input), size = Math.max(data.length, Number(memorySize ?? data.length)); this.write(address, data); for (let p = (address + data.length) & ~(this.pageSize - 1); p < address + size; p += this.pageSize) this.page(p, true); this.regions.push({ name, start: hex(address), end_exclusive: hex(address + size), file_bytes: data.length, memory_bytes: size }); }
    read(address, size) { const out = new Uint8Array(size); for (let i = 0; i < size; i++) { const page = this.page(address + i); if (!page) throw new Error(`unmapped read at ${hex(address + i)}`); out[i] = page[(address + i) & (this.pageSize - 1)]; } return out; }
    write(address, input) { const data = asBytes(input); for (let i = 0; i < data.length; i++) this.page(address + i, true)[(address + i) & (this.pageSize - 1)] = data[i]; }
    load(address, size) { const data = this.read(address, size); let value = 0n; for (let i = data.length - 1; i >= 0; i--) value = value << 8n | BigInt(data[i]); return value; }
    store(address, value, size) { let v = BigInt(value); const data = new Uint8Array(size); for (let i = 0; i < size; i++) { data[i] = Number(v & 0xffn); v >>= 8n; } this.write(address, data); }
  }

  function loadElf32(input, memory, name = 'ELF') {
    const bytes = asBytes(input); if (bytes.length < 52 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46 || bytes[4] !== 1 || bytes[5] !== 1) throw new Error('Expected ELF32 little-endian input');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), machine = view.getUint16(18, true), entry = view.getUint32(24, true), phoff = view.getUint32(28, true), phentsize = view.getUint16(42, true), phnum = view.getUint16(44, true), segments = [];
    for (let index = 0; index < phnum; index++) { const p = phoff + index * phentsize; if (p + 32 > bytes.length) throw new Error(`Truncated program header ${index}`); const type = view.getUint32(p, true), offset = view.getUint32(p + 4, true), va = view.getUint32(p + 8, true), fileSize = view.getUint32(p + 16, true), memorySize = view.getUint32(p + 20, true), flags = view.getUint32(p + 24, true), alignment = view.getUint32(p + 28, true); if (type !== 1 || !memorySize) continue; if (offset + fileSize > bytes.length) throw new Error(`Truncated PT_LOAD ${index}`); memory.map(va, bytes.subarray(offset, offset + fileSize), `${name}:PT_LOAD:${index}`, memorySize); segments.push({ index, va: hex(va), file_size: fileSize, memory_size: memorySize, flags, alignment }); }
    return { name, machine, entry: hex(entry), segments };
  }

  function loadModule(input, memory, name = 'module') {
    const bytes = asBytes(input);
    if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return { format: 'ELF32', ...loadElf32(bytes, memory, name) };
    if (bytes.length >= 0x40 && bytes[0] === 0x4d && bytes[1] === 0x57 && bytes[2] === 0x6f && bytes[3] === 0x33) { const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), loadAddress = view.getUint32(8, true), region0Size = view.getUint32(0x0c, true), region1Size = view.getUint32(0x10, true), zeroFillSize = view.getUint32(0x14, true), expectedFileSize = 0x40 + region0Size + region1Size, memorySize = bytes.length + zeroFillSize; if (expectedFileSize !== bytes.length) throw new Error(`MWo3 region sizes declare ${expectedFileSize} file bytes, got ${bytes.length}`); if (loadAddress < 0x100000 || loadAddress + memorySize > 0x02000000) throw new Error(`MWo3 load address ${hex(loadAddress)} is outside EE user RAM`); memory.map(loadAddress, bytes, `${name}:MWo3`, memorySize); return { format: 'MWo3', name, machine: 8, entry: null, load_address: hex(loadAddress), class_value: view.getUint32(4, true), region0_size: region0Size, region1_size: region1Size, zero_fill_size: zeroFillSize, allocation_end: hex(loadAddress + memorySize), segments: [{ index: 0, va: hex(loadAddress), file_size: bytes.length, memory_size: memorySize, flags: 7, alignment: 0x80 }] }; }
    throw new Error('Expected ELF32 little-endian or decoded MWo3 module input');
  }

  class R5900Target {
    constructor(memory, traceLimit = 1000) { this.memory = memory; this.gpr = Array(32).fill(0n); this.fprBits = new Uint32Array(32); this.pc = 0; this.steps = 0; this.traceLimit = traceLimit; this.trace = []; this.traceCommitmentRows = []; this.calls = []; this.writeSummary = {}; this.stubs = new Map(); this.stopPc = null; this.stopAddresses = new Set(); }
    r(index) { return index ? this.gpr[index] : 0n; }
    set(index, value) { if (index) this.gpr[index] = BigInt(value) & MASK128; }
    u64(index) { return this.r(index) & MASK64; }
    s64(index) { return sxBig(this.u64(index), 64); }
    record(pc, word, instruction, delaySlot = false) { const row = { step: this.steps, pc: hex(pc), word: hex(word), instruction, delay_slot: delaySlot }; this.traceCommitmentRows.push(`${row.step}|${row.pc}|${row.word}|${delaySlot ? 1 : 0}\n`); if (this.trace.length < this.traceLimit) this.trace.push(row); }
    address(rs, imm) { return Number((this.u64(rs) + BigInt(sxNumber(imm, 16))) & MASK32); }
    store(address, value, size) { this.memory.store(address, value, size); const key = `${size}_byte`; this.writeSummary[key] = (this.writeSummary[key] || 0) + 1; }
    noncontrol(pc, word, delay = false) {
      const op = word >>> 26, rs = word >>> 21 & 31, rt = word >>> 16 & 31, rd = word >>> 11 & 31, sa = word >>> 6 & 31, fn = word & 63, imm = word & 0xffff; let text = '';
      if (word === 0) text = 'nop';
      else if (op === 0) {
        if (fn === 0x00) { this.set(rd, sx128((this.u64(rt) & MASK32) << BigInt(sa), 32)); text = `sll ${REG[rd]},${REG[rt]},${sa}`; }
        else if (fn === 0x21) { this.set(rd, sx128((this.u64(rs) + this.u64(rt)) & MASK32, 32)); text = `addu ${REG[rd]},${REG[rs]},${REG[rt]}`; }
        else if (fn === 0x23) { this.set(rd, sx128((this.u64(rs) - this.u64(rt)) & MASK32, 32)); text = `subu ${REG[rd]},${REG[rs]},${REG[rt]}`; }
        else if (fn === 0x24) { this.set(rd, this.u64(rs) & this.u64(rt)); text = `and ${REG[rd]},${REG[rs]},${REG[rt]}`; }
        else if (fn === 0x25) { this.set(rd, this.u64(rs) | this.u64(rt)); text = `or ${REG[rd]},${REG[rs]},${REG[rt]}`; }
        else if (fn === 0x26) { this.set(rd, this.u64(rs) ^ this.u64(rt)); text = `xor ${REG[rd]},${REG[rs]},${REG[rt]}`; }
        else if (fn === 0x2a) { this.set(rd, this.s64(rs) < this.s64(rt) ? 1n : 0n); text = `slt ${REG[rd]},${REG[rs]},${REG[rt]}`; }
        else if (fn === 0x2b) { this.set(rd, this.u64(rs) < this.u64(rt) ? 1n : 0n); text = `sltu ${REG[rd]},${REG[rs]},${REG[rt]}`; }
        else if (fn === 0x2d) { this.set(rd, (this.u64(rs) + this.u64(rt)) & MASK64); text = `daddu ${REG[rd]},${REG[rs]},${REG[rt]}`; }
        else if (fn === 0x2f) { this.set(rd, (this.u64(rs) - this.u64(rt)) & MASK64); text = `dsubu ${REG[rd]},${REG[rs]},${REG[rt]}`; }
        else if (fn === 0x38) { this.set(rd, this.u64(rt) << BigInt(sa) & MASK64); text = `dsll ${REG[rd]},${REG[rt]},${sa}`; }
        else if (fn === 0x3c) { this.set(rd, this.u64(rt) << BigInt(sa + 32) & MASK64); text = `dsll32 ${REG[rd]},${REG[rt]},${sa}`; }
        else throw new Error(`unsupported SPECIAL fn ${hex(fn, 2)} at ${hex(pc)}`);
      } else if (op === 0x09) { this.set(rt, sx128((this.u64(rs) + BigInt(sxNumber(imm, 16))) & MASK32, 32)); text = `addiu ${REG[rt]},${REG[rs]},${sxNumber(imm,16)}`; }
      else if (op === 0x0a) { this.set(rt, this.s64(rs) < BigInt(sxNumber(imm, 16)) ? 1n : 0n); text = `slti ${REG[rt]},${REG[rs]},${sxNumber(imm,16)}`; }
      else if (op === 0x0b) { this.set(rt, this.u64(rs) < (BigInt(sxNumber(imm, 16)) & MASK64) ? 1n : 0n); text = `sltiu ${REG[rt]},${REG[rs]},${sxNumber(imm,16)}`; }
      else if (op === 0x19) { this.set(rt, (this.u64(rs) + BigInt(sxNumber(imm, 16))) & MASK64); text = `daddiu ${REG[rt]},${REG[rs]},${sxNumber(imm,16)}`; }
      else if (op === 0x0c) { this.set(rt, this.u64(rs) & BigInt(imm)); text = `andi ${REG[rt]},${REG[rs]},${hex(imm,4)}`; }
      else if (op === 0x0d) { this.set(rt, this.u64(rs) | BigInt(imm)); text = `ori ${REG[rt]},${REG[rs]},${hex(imm,4)}`; }
      else if (op === 0x0e) { this.set(rt, this.u64(rs) ^ BigInt(imm)); text = `xori ${REG[rt]},${REG[rs]},${hex(imm,4)}`; }
      else if (op === 0x0f) { this.set(rt, sx128(BigInt(imm << 16 >>> 0), 32)); text = `lui ${REG[rt]},${hex(imm,4)}`; }
      else if (op === 0x1c && fn === 0x09 && sa === 0x0e) { this.set(rd, this.u64(rs) << 64n | this.u64(rt)); text = `pcpyld ${REG[rd]},${REG[rs]},${REG[rt]}`; }
      else if ([0x20, 0x21, 0x23, 0x24, 0x25, 0x27, 0x28, 0x29, 0x2b, 0x31, 0x39].includes(op)) { const address = this.address(rs, imm);
        if (op === 0x20) { this.set(rt, sx128(this.memory.load(address, 1), 8)); text = `lb ${REG[rt]},${sxNumber(imm,16)}(${REG[rs]})`; }
        else if (op === 0x21) { this.set(rt, sx128(this.memory.load(address, 2), 16)); text = `lh ${REG[rt]},${sxNumber(imm,16)}(${REG[rs]})`; }
        else if (op === 0x23) { this.set(rt, sx128(this.memory.load(address, 4), 32)); text = `lw ${REG[rt]},${sxNumber(imm,16)}(${REG[rs]})`; }
        else if (op === 0x24) { this.set(rt, this.memory.load(address, 1)); text = `lbu ${REG[rt]},${sxNumber(imm,16)}(${REG[rs]})`; }
        else if (op === 0x25) { this.set(rt, this.memory.load(address, 2)); text = `lhu ${REG[rt]},${sxNumber(imm,16)}(${REG[rs]})`; }
        else if (op === 0x27) { this.set(rt, this.memory.load(address, 4)); text = `lwu ${REG[rt]},${sxNumber(imm,16)}(${REG[rs]})`; }
        else if (op === 0x28) { this.store(address, this.u64(rt), 1); text = `sb ${REG[rt]},${sxNumber(imm,16)}(${REG[rs]})`; }
        else if (op === 0x29) { this.store(address, this.u64(rt), 2); text = `sh ${REG[rt]},${sxNumber(imm,16)}(${REG[rs]})`; }
        else if (op === 0x2b) { this.store(address, this.u64(rt), 4); text = `sw ${REG[rt]},${sxNumber(imm,16)}(${REG[rs]})`; }
        else if (op === 0x31) { this.fprBits[rt] = Number(this.memory.load(address, 4) & 0xffffffffn); text = `lwc1 f${rt},${sxNumber(imm,16)}(${REG[rs]})`; }
        else { this.store(address, BigInt(this.fprBits[rt]), 4); text = `swc1 f${rt},${sxNumber(imm,16)}(${REG[rs]})`; }
      }
      else if ([0x1e, 0x1f, 0x37, 0x3f].includes(op)) { const address = this.address(rs, imm); if (op === 0x1e) { this.set(rt, this.memory.load(address, 16)); text = `lq ${REG[rt]},${sxNumber(imm,16)}(${REG[rs]})`; } else if (op === 0x1f) { this.store(address, this.r(rt), 16); text = `sq ${REG[rt]},${sxNumber(imm,16)}(${REG[rs]})`; } else if (op === 0x37) { this.set(rt, sx128(this.memory.load(address, 8), 64)); text = `ld ${REG[rt]},${sxNumber(imm,16)}(${REG[rs]})`; } else { this.store(address, this.u64(rt), 8); text = `sd ${REG[rt]},${sxNumber(imm,16)}(${REG[rs]})`; } }
      else throw new Error(`unsupported opcode ${hex(op,2)} at ${hex(pc)} (word ${hex(word)})`);
      this.record(pc, word, text, delay); this.steps++;
    }
    delay(pc) { const word = Number(this.memory.load(pc, 4)); const op = word >>> 26, fn = word & 63; if ([2,3,4,5,6,7].includes(op) || op === 0 && [8,9].includes(fn)) throw new Error(`control transfer in delay slot at ${hex(pc)}`); this.noncontrol(pc, word, true); }
    run(start, maxSteps = 2000000) {
      this.pc = start;
      while (this.steps < maxSteps) { if (this.stopAddresses.has(this.pc)) return 'STOP_ADDRESS'; const pc = this.pc, word = Number(this.memory.load(pc, 4)), op = word >>> 26, rs = word >>> 21 & 31, rt = word >>> 16 & 31, fn = word & 63, imm = word & 0xffff;
        if (op === 3) { const target = (pc + 4 & 0xf0000000) | (word & 0x03ffffff) << 2; this.set(31, pc + 8); this.record(pc, word, `jal ${hex(target)}`); this.steps++; this.delay(pc + 4); if (this.stubs.has(target)) { const stub = this.stubs.get(target); this.calls.push({ pc: hex(pc), target: hex(target), stub: stub.name }); stub(this); this.pc = pc + 8; } else this.pc = target; }
        else if (op === 0 && fn === 8) { const target = Number(this.u64(rs) & MASK32); this.record(pc, word, `jr ${REG[rs]}`); this.steps++; this.delay(pc + 4); if (this.stopPc != null && target === this.stopPc) return 'RETURN_SENTINEL'; this.pc = target; }
        else if (op === 0 && fn === 9) { const rd = word >>> 11 & 31, target = Number(this.u64(rs) & MASK32); this.set(rd, pc + 8); this.record(pc, word, `jalr ${REG[rd]},${REG[rs]} -> ${hex(target)}`); this.steps++; this.delay(pc + 4); if (this.stubs.has(target)) { const stub = this.stubs.get(target); this.calls.push({ pc: hex(pc), target: hex(target), stub: stub.name }); stub(this); this.pc = pc + 8; } else this.pc = target; }
        else if ([4,5,6,7].includes(op)) { const target = pc + 4 + (sxNumber(imm,16) << 2) >>> 0; let taken, name; if (op === 4) { taken = this.u64(rs) === this.u64(rt); name = 'beq'; } else if (op === 5) { taken = this.u64(rs) !== this.u64(rt); name = 'bne'; } else if (op === 6) { taken = this.s64(rs) <= 0n; name = 'blez'; } else { taken = this.s64(rs) > 0n; name = 'bgtz'; } this.record(pc, word, `${name} -> ${hex(target)} (${taken ? 'taken' : 'not taken'})`); this.steps++; this.delay(pc + 4); this.pc = taken ? target : pc + 8; }
        else { this.noncontrol(pc, word); this.pc = pc + 4; }
      }
      throw new Error(`instruction limit ${maxSteps} reached`);
    }
  }

  function runMovieTransform(libInput, carrierInput, options = {}) {
    const lib = asBytes(libInput), carrier = asBytes(carrierInput), length = Number(options.length || Math.min(carrier.length, 0x4000)); if (length <= 0 || length > carrier.length || length % 0x40 || length > 0x4000) throw new Error('Execution length must be a positive 0x40-byte multiple no larger than one 0x4000 frame');
    const memory = new SparseMemory(), elf = loadModule(lib, memory, options.moduleName || 'Lib'), buffer = 0x01000000, stack = 0x01f00000, sentinel = 0x0badf00d, key = asBytes(options.contentKey || DEFAULT_CONTENT_KEY); if (key.length !== 16) throw new Error('Content key must be 16 bytes');
    memory.map(buffer, carrier.subarray(0, length), 'movie_carrier'); memory.map(0x001cc730, key, 'PAL_content_key'); memory.map(stack - 0x1000, new Uint8Array(0x2000), 'target_stack'); const cpu = new R5900Target(memory, Number(options.traceLimit || 1200));
    function hostContext(target) { target.set(2, 0x001b6a80n); } function flushCache() {}
    cpu.stubs.set(0x0010d880, hostContext); cpu.stubs.set(0x00121fa0, flushCache); cpu.set(4, 0n); cpu.set(5, BigInt(buffer)); cpu.set(6, BigInt(length)); cpu.set(7, BigInt(buffer)); cpu.set(8, BigInt(length)); cpu.set(29, BigInt(stack)); cpu.set(31, BigInt(sentinel)); cpu.stopPc = sentinel;
    const stopReason = cpu.run(0x0041a2f0, Number(options.maxSteps || 2000000)), output = memory.read(buffer, length);
    return { output, traceCommitmentInput: new TextEncoder().encode(cpu.traceCommitmentRows.join('')), report: { format: 'SO3_TARGETED_RUNTIME_EXECUTION_REPORT', version: 2, producer: `SO3 Resource Explorer ${VERSION}`, routine: { module: options.moduleName || 'Lib', entry_va: '0x0041A2F0', kind: 'R5900_INSTRUCTION_EXECUTION', external_stubs: ['0x0010D880 host context getter', '0x00121FA0 FlushCache'] }, elf, input: { bytes: length }, output: { bytes: output.length, artifact_kind: 'MPEG_PS_EXECUTION_FRAGMENT', standalone_complete_movie: false, frame_unit_bytes: length, mpeg_pack_at_zero: output[0] === 0 && output[1] === 0 && output[2] === 1 && output[3] === 0xba }, execution: { stop_reason: stopReason, instruction_count: cpu.steps, calls: cpu.calls, memory_writes: cpu.writeSummary, trace_records_retained: cpu.trace.length, trace_records_committed: cpu.traceCommitmentRows.length, trace_commitment_scheme: 'SHA-256 over UTF-8 rows: step|uppercase_0x_PC|uppercase_0x_word|delay_slot_0_or_1\\n', trace_commitment_sha256: null }, memory_regions: memory.regions, trace: cpu.trace, reasoning_boundary: ['Only the instruction subset reached by this routine is implemented.', 'External services are explicit stubs, not emulated BIOS behavior.', 'The MPEG-PS output is one execution fragment and is not asserted to be a complete standalone movie.', 'A byte-exact comparison validates this routine and fixture, not the complete game runtime.'] } };
  }

  return Object.freeze({ VERSION, DEFAULT_CONTENT_KEY, SparseMemory, loadElf32, loadModule, R5900Target, runMovieTransform });
});
