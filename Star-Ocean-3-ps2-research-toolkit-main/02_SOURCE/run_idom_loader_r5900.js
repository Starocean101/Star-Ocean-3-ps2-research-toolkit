#!/usr/bin/env node
/* Execute SO3's original Lib IDOM loader over packaged actor bytes. */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Runtime = require('./v510_targeted_runtime.js');

const ENTRY = 0x004ABF60;
const END_EXCLUSIVE = 0x004AC1D0;
const BIND_ENTRY = 0x00478860;
const BIND_END_EXCLUSIVE = 0x00478A20;
const MAGIC = Uint8Array.from([0x49, 0x44, 0x4F, 0x4D]); // "IDOM"

function bytes(input) {
  return input instanceof Uint8Array ? input : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

function u32(data, offset) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function f32(data, offset) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat32(offset, true);
}

function hex(value, width = 8) {
  return `0x${Number(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

function sha256(data) {
  return crypto.createHash('sha256').update(Buffer.from(data)).digest('hex');
}

function sameMagic(data, offset) {
  return MAGIC.every((value, index) => data[offset + index] === value);
}

function parseIdomSections(input) {
  const data = bytes(input), sections = [];
  for (let offset = 0; offset + 0x20 <= data.length; offset += 4) {
    if (!sameMagic(data, offset)) continue;
    const matrixCount = u32(data, offset + 0x14);
    const indexTableOffset = offset + 0x20;
    const storedMatricesOffset = indexTableOffset + matrixCount * 4;
    const storedMatricesEnd = storedMatricesOffset + matrixCount * 0x30;
    if (!matrixCount || matrixCount > 256 || storedMatricesEnd > data.length) continue;
    const indices = Array.from({ length: matrixCount }, (_, index) => u32(data, indexTableOffset + index * 4));
    const allFinite = Array.from({ length: matrixCount * 12 }, (_, index) => f32(data, storedMatricesOffset + index * 4)).every(Number.isFinite);
    if (!allFinite) continue;
    sections.push({
      section_index: sections.length,
      offset,
      header: {
        magic: 'IDOM',
        field_0x04: u32(data, offset + 0x04),
        field_0x08: u32(data, offset + 0x08),
        field_0x0c: u32(data, offset + 0x0c),
        field_0x10: u32(data, offset + 0x10),
        matrix_count: matrixCount,
        auxiliary_relative_offset: u32(data, offset + 0x18),
        packed_flags: u32(data, offset + 0x1c),
        secondary_buffer_flag: data[offset + 0x1c],
      },
      index_table_offset: indexTableOffset,
      stored_matrices_offset: storedMatricesOffset,
      stored_matrices_end: storedMatricesEnd,
      indices,
      indices_unique: new Set(indices).size === indices.length,
    });
  }
  return sections;
}

function expectedRuntimeMatrices(input, section) {
  const data = bytes(input), out = new Uint8Array(section.header.matrix_count * 0x40);
  const outView = new DataView(out.buffer);
  const oneBits = 0x3F800000;
  const destinationOffsets = [0x00, 0x10, 0x20, 0x04, 0x14, 0x24, 0x08, 0x18, 0x28, 0x0C, 0x1C, 0x2C];
  for (let index = 0; index < section.header.matrix_count; index++) {
    const destination = index * 0x40;
    outView.setUint32(destination + 0x00, oneBits, true);
    outView.setUint32(destination + 0x14, oneBits, true);
    outView.setUint32(destination + 0x28, oneBits, true);
    outView.setUint32(destination + 0x3C, oneBits, true);
    for (let word = 0; word < 12; word++) {
      const bits = u32(data, section.stored_matrices_offset + index * 0x30 + word * 4);
      outView.setUint32(destination + destinationOffsets[word], bits, true);
    }
  }
  return out;
}

function executeIdomLoader(libInput, elfInput, actorInput, section, options = {}) {
  const lib = bytes(libInput), elf = bytes(elfInput), actor = bytes(actorInput);
  const memory = new Runtime.SparseMemory();
  const elfMap = Runtime.loadModule(elf, memory, options.elfName || 'SLES_820.28');
  const libMap = Runtime.loadModule(lib, memory, options.libName || 'Lib');
  const actorBase = 0x01100000, manager = 0x01000000, heapBase = 0x01400000;
  const stack = 0x01F00000, sentinel = 0x0BADF00D;
  memory.map(actorBase, actor, options.actorName || 'actor_CHAR');
  memory.map(manager, new Uint8Array(0x100), 'IDOM_manager');
  memory.map(stack - 0x2000, new Uint8Array(0x4000), 'target_stack');

  let nextHeap = heapBase;
  const allocations = [];
  function allocator(target) {
    const requested = Number(target.u64(4) & 0xFFFFFFFFn);
    const address = (nextHeap + 0x0F) & ~0x0F;
    nextHeap = address + Math.max(requested, 0x10);
    memory.map(address, new Uint8Array(Math.max(requested, 0x10)), `heap_${allocations.length}`);
    allocations.push({ address: hex(address), requested_bytes: requested });
    target.set(2, BigInt(address));
  }
  function flushCache() {}

  const cpu = new Runtime.R5900Target(memory, Number(options.traceLimit || 3000));
  cpu.stubs.set(0x00100B00, allocator);
  cpu.stubs.set(0x00121FA0, flushCache);
  cpu.set(4, BigInt(manager));
  cpu.set(5, BigInt(actorBase + section.offset));
  cpu.set(29, BigInt(stack));
  cpu.set(31, BigInt(sentinel));
  cpu.stopPc = sentinel;
  const stopReason = cpu.run(ENTRY, Number(options.maxSteps || 500000));

  const matrixCount = Number(memory.load(actorBase + section.offset + 0x14, 4));
  const runtimeMatricesAddress = Number(memory.load(manager + 0x40, 4));
  const pointerTableAddress = Number(memory.load(manager + 0x3C, 4));
  const auxiliaryStreamAddress = Number(memory.load(manager + 0x44, 4));
  const secondaryBufferAddress = Number(memory.load(manager + 0x4C, 4));
  const runtimeMatrices = memory.read(runtimeMatricesAddress, matrixCount * 0x40);
  const expected = expectedRuntimeMatrices(actor, section);
  const byteExact = Buffer.from(runtimeMatrices).equals(Buffer.from(expected));
  if (!byteExact) throw new Error(`original loader output mismatch for IDOM at ${hex(section.offset)}`);

  const resourceHolder = 0x01020000, managerWrapper = 0x01021000, nodeDirectory = 0x01500000;
  const highestIndex = Math.max(...section.indices);
  memory.map(resourceHolder, new Uint8Array(0x100), 'runtime_resource_holder');
  memory.map(managerWrapper, new Uint8Array(0x100), 'runtime_manager_wrapper');
  memory.map(nodeDirectory, new Uint8Array((highestIndex + 1) * 0x10), 'runtime_node_record_table');
  memory.store(resourceHolder + 0x18, BigInt(nodeDirectory), 4);
  memory.store(managerWrapper + 0x08, BigInt(manager), 4);
  const nodeAddressByIndex = new Map();
  for (let index = 0; index <= highestIndex; index++) {
    const nodeAddress = 0x01600000 + index * 0x100;
    nodeAddressByIndex.set(index, nodeAddress);
    memory.store(nodeDirectory + index * 0x10 + 0x08, BigInt(nodeAddress), 4);
  }
  const bindCpu = new Runtime.R5900Target(memory, Number(options.traceLimit || 3000));
  bindCpu.set(7, BigInt(managerWrapper));
  bindCpu.set(20, BigInt(resourceHolder));
  bindCpu.set(29, BigInt(stack));
  bindCpu.stopAddresses.add(BIND_END_EXCLUSIVE);
  const bindStopReason = bindCpu.run(BIND_ENTRY, Number(options.maxSteps || 500000));
  const boundNodePointers = Array.from({ length: matrixCount }, (_, index) => Number(memory.load(pointerTableAddress + index * 4, 4)));
  const expectedNodePointers = section.indices.map(index => nodeAddressByIndex.get(index));
  const bindingExact = boundNodePointers.every((value, index) => value === expectedNodePointers[index]);
  if (!bindingExact) throw new Error(`original binder output mismatch for IDOM at ${hex(section.offset)}`);

  const matrixHead = Array.from({ length: Math.min(matrixCount, 3) }, (_, index) => {
    const base = index * 0x40;
    return Array.from({ length: 16 }, (_, word) => f32(runtimeMatrices, base + word * 4));
  });
  return {
    stop_reason: stopReason,
    instruction_count: cpu.steps,
    original_code: {
      entry_va: hex(ENTRY),
      end_exclusive_va: hex(END_EXCLUSIVE),
      routine_sha256: sha256(lib.subarray(ENTRY - 0x003E6880, END_EXCLUSIVE - 0x003E6880)),
      executed_array_helper_va: '0x00142ED0',
      executed_matrix_identity_va: '0x004CFEC0',
      pointer_bind_entry_va: hex(BIND_ENTRY),
      pointer_bind_end_exclusive_va: hex(BIND_END_EXCLUSIVE),
      pointer_bind_slice_sha256: sha256(lib.subarray(BIND_ENTRY - 0x003E6880, BIND_END_EXCLUSIVE - 0x003E6880)),
    },
    explicit_external_stubs: [
      { va: '0x00100B00', role: 'heap allocator only' },
      { va: '0x00121FA0', role: 'FlushCache side effect only' },
    ],
    input: {
      actor_source_address: hex(actorBase + section.offset),
      idom_offset: hex(section.offset),
      matrix_count: matrixCount,
      stored_matrix_stride: 0x30,
      index_table: section.indices,
    },
    manager: {
      address: hex(manager),
      source_payload: hex(Number(memory.load(manager + 0x34, 4))),
      index_table: hex(Number(memory.load(manager + 0x38, 4))),
      pointer_table: hex(pointerTableAddress),
      runtime_matrices: hex(runtimeMatricesAddress),
      auxiliary_stream: hex(auxiliaryStreamAddress),
      secondary_buffer: hex(secondaryBufferAddress),
      buffer_selector: Number(memory.load(manager + 0x50, 1)),
    },
    output: {
      runtime_matrix_stride: 0x40,
      runtime_matrix_bytes: runtimeMatrices.length,
      runtime_matrix_sha256: sha256(runtimeMatrices),
      expected_matrix_sha256: sha256(expected),
      byte_exact_against_independent_layout_conversion: byteExact,
      matrix_head: matrixHead,
      pointer_binding: {
        stop_reason: bindStopReason,
        instruction_count: bindCpu.steps,
        table_value_semantic: 'runtime_resource_record_index_resolving_node_object',
        bound_node_pointers: boundNodePointers.map(value => hex(value)),
        expected_node_pointers: expectedNodePointers.map(value => hex(value)),
        byte_exact_against_independent_index_lookup: bindingExact,
        trace_records_retained: bindCpu.trace.length,
        trace_records_committed: bindCpu.traceCommitmentRows.length,
        trace_commitment_sha256: sha256(new TextEncoder().encode(bindCpu.traceCommitmentRows.join(''))),
        trace: bindCpu.trace,
      },
    },
    execution: {
      calls: cpu.calls,
      allocations,
      memory_writes: cpu.writeSummary,
      trace_records_retained: cpu.trace.length,
      trace_records_committed: cpu.traceCommitmentRows.length,
      trace_commitment_sha256: sha256(new TextEncoder().encode(cpu.traceCommitmentRows.join(''))),
      trace: cpu.trace,
    },
    mapped_modules: { elf: elfMap, lib: libMap },
  };
}

function buildReport({ lib, elf, actors }) {
  const executions = [];
  for (const actor of actors) {
    const actorBytes = bytes(actor.bytes), sections = parseIdomSections(actorBytes);
    for (const section of sections) {
      executions.push({
        actor: actor.actor,
        source_name: actor.name,
        source_sha256: sha256(actorBytes),
        section: {
          ...section,
          offset: hex(section.offset),
          index_table_offset: hex(section.index_table_offset),
          stored_matrices_offset: hex(section.stored_matrices_offset),
          stored_matrices_end: hex(section.stored_matrices_end),
        },
        runtime: executeIdomLoader(lib, elf, actorBytes, section, { actorName: actor.name }),
      });
    }
  }
  return {
    format: 'SO3_IDOM_LOADER_R5900_EXECUTION_REPORT_V1',
    status: 'EXECUTED_ORIGINAL_R5900_CODE',
    promotion: false,
    purpose: 'Execute the original Lib type-7 IDOM loader over real actor CHAR sections and expose its matrix/index products for the hybrid reconstruction.',
    modules: {
      lib_sha256: sha256(lib),
      elf_sha256: sha256(elf),
    },
    executions,
    verified_facts: [
      'IDOM+0x14 is the matrix count consumed by Lib 0x004ABF60.',
      'IDOM+0x20 contains count u32 indices; count stored 3x4 matrices follow immediately at 0x30 bytes each.',
      'Lib 0x00478860..0x00478A1C uses each IDOM table value as an index into the generic 0x10-byte runtime resource-record table, loads the selected node-object pointer at record+8, and writes it to manager+0x3C in IDOM order.',
      'The original loader expands each stored matrix into one 0x40-byte affine 4x4 matrix and retains an auxiliary-stream pointer from IDOM+0x18.',
      'When the low byte at IDOM+0x1C is nonzero, the loader allocates the double-buffered output used by the downstream evaluator/uploader.',
    ],
    corrections: [
      'An ATRC/RTA header count is not a substitute for the active IDOM manager count. Downstream VIF packet sizing must use the selected IDOM section at runtime.',
    ],
    boundaries: [
      'This pass executes initialization, array construction, identity-matrix setup, and stored-matrix expansion. It does not yet execute actor-node callbacks or VU0 matrix multiplication in 0x004ABA30/0x004ABCB0.',
      'Heap allocation and FlushCache are explicit host stubs; neither contains SO3 selection or matrix semantics.',
      'Multiple IDOM sections in one CHAR are reported separately. Their primary/auxiliary runtime role is not inferred from file order alone.',
      'The IDOM values are proven runtime resource-record indices, not packet IDs. The remaining unresolved link is from those selected node objects to human-readable RTA names.',
    ],
  };
}

function cli(argv) {
  const args = { actors: [] };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--lib') args.lib = argv[++index];
    else if (key === '--elf') args.elf = argv[++index];
    else if (key === '--actor') {
      const actor = argv[++index], file = argv[++index];
      args.actors.push({ actor, file });
    } else if (key === '--output') args.output = argv[++index];
    else throw new Error(`unknown argument ${key}`);
  }
  if (!args.lib || !args.elf || !args.actors.length || !args.output) {
    throw new Error('usage: run_idom_loader_r5900.js --lib Lib.bin --elf SLES.bin --actor 0x08FF CHAR.bin [--actor ...] --output report.json');
  }
  const report = buildReport({
    lib: bytes(fs.readFileSync(args.lib)),
    elf: bytes(fs.readFileSync(args.elf)),
    actors: args.actors.map(row => ({ actor: row.actor, name: path.basename(row.file), bytes: bytes(fs.readFileSync(row.file)) })),
  });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: report.status, output: args.output, executions: report.executions.length })}\n`);
}

module.exports = Object.freeze({ parseIdomSections, expectedRuntimeMatrices, executeIdomLoader, buildReport });
if (require.main === module) cli(process.argv.slice(2));
