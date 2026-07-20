/* Embedded companion assets for the browser-hosted V5.9.0 Runtime Capture Importer. */
(function () {
  'use strict';
  const LEGACY_CE_LUA = String.raw`-- SO3 Runtime Capture profile: PCSX2 c16db05e0c3a5806fad1fd571141284facc7b421 (32-bit)
-- Run only with a legally obtained game image and your own emulator process.
-- This profile is intentionally build-specific. Do not reuse its host addresses on another build.

OUTPUT_DIRECTORY = "X:/"
PAYLOAD_NAME = "SO3_capture_payload.bin"
TRANSFER_LOG_NAME = "SO3_capture_transfers.tsv"
EXPECTED_OUTPUT_BYTES = 0
DESTINATION_START = 0x2410BD00
DESTINATION_END = 0x241A7D00

payload = assert(io.open(OUTPUT_DIRECTORY .. PAYLOAD_NAME, "wb"))
transferlog = assert(io.open(OUTPUT_DIRECTORY .. TRANSFER_LOG_NAME, "wb"))
transferlog:write("sequence\tpayload_offset\tsource_address\tdestination_address\trequested_bytes\tcaptured_bytes\tcaller\ttimestamp_ms\n")
outputsize = 0
outputwant = EXPECTED_OUTPUT_BYTES
sequence = 0
finished = false
MEMCPY_ADDR = getAddress("VCRUNTIME140.memcpy")

function ReadBytesSafe(addr, size)
  local data_table = readBytes(addr, size, true)
  if data_table == nil then return nil end
  return byteTableToString(data_table)
end

function FinishCapture(reason)
  if finished then return end
  finished = true
  if payload ~= nil then payload:flush(); payload:close(); payload = nil end
  if transferlog ~= nil then
    transferlog:write("# finished\t" .. tostring(reason) .. "\tbytes\t" .. tostring(outputsize) .. "\n")
    transferlog:flush(); transferlog:close(); transferlog = nil
  end
  print("SO3 capture finished: " .. tostring(outputsize) .. " bytes (" .. tostring(reason) .. ")")
end

function debugger_onBreakpoint()
  if finished then return 0 end
  if EIP ~= MEMCPY_ADDR then return 1 end
  local dest = readInteger(ESP + 0x4)
  if dest == nil or dest < DESTINATION_START or dest >= DESTINATION_END then return 1 end
  local src = readInteger(ESP + 0x8)
  local requested = readInteger(ESP + 0xC)
  local caller = readInteger(ESP)
  if src == nil or requested == nil or requested <= 0 then return 1 end
  if outputwant == 0 and requested >= 0x18 then
    local magic = ReadBytesSafe(src, 3)
    local declared = readInteger(src + 0x14)
    if magic == "PK3" and declared ~= nil and declared >= 0x18 then outputwant = declared end
  end
  local capture = requested
  if outputwant > 0 and outputsize + capture > outputwant then capture = outputwant - outputsize end
  if capture <= 0 then FinishCapture("target already complete"); return 0 end
  local data = ReadBytesSafe(src, capture)
  if data == nil then return 1 end
  payload:write(data)
  transferlog:write(string.format("%d\t%d\t0x%08X\t0x%08X\t%d\t%d\t0x%08X\t%d\n", sequence, outputsize, src, dest, requested, string.len(data), caller or 0, getTickCount()))
  payload:flush(); transferlog:flush()
  outputsize = outputsize + string.len(data)
  sequence = sequence + 1
  if outputwant > 0 and outputsize >= outputwant then FinishCapture("declared target reached"); return 0 end
  return 1
end

debug_setBreakpoint(MEMCPY_ADDR)
print(string.format("SO3 capture armed at memcpy 0x%08X", MEMCPY_ADDR))
print("Start the target movie. The script records only writes into the historical SIF1/IOP staging window.")
`;
  const LOG_TEMPLATE = 'sequence\tpayload_offset\tsource_address\tdestination_address\trequested_bytes\tcaptured_bytes\tcaller\ttimestamp_ms\n';
  globalThis.SO3V590CaptureAssets = Object.freeze({ LEGACY_CE_LUA, LOG_TEMPLATE });
})();
