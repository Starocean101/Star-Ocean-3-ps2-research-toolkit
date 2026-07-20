#!/usr/bin/env python3
"""Build the deterministic single-file V5.12.8 Pass 6.2 release."""

from __future__ import annotations

import hashlib
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BASELINE = HERE / "v5_1_baseline.html"
OUTPUT = ROOT / "01_RELEASE" / "so3_resource_explorer_v5_12_8_pass6_2.html"
FISP_COMMAND_INJECTION = HERE / "v5123_fisp_command_injection.js"
EXPECTED_V51 = "5a84df8a37cf5e0a6ce723b77b58b5513f325ed66d5834449c2dfc02e1c905b4"
SOURCES = [
    HERE / "v5_core.js",
    HERE / "v5_fis.js",
    HERE / "v5_1_geometry.js",
    HERE / "v52_identification.js",
    HERE / "v53_movie_decoder.js",
    HERE / "v54_sac_decoder.js",
    HERE / "v55_mpeg_muxer.js",
    HERE / "v52_integration.js",
    HERE / "v58_model_index.js",
    HERE / "v581_legacy_claims.js",
    HERE / "v58_asset_catalog.js",
    HERE / "v58_model_assembler.js",
    HERE / "v58_model_ui.js",
    HERE / "v581_legacy_integration.js",
    HERE / "v590_runtime_capture.js",
    HERE / "v590_capture_assets.js",
    HERE / "v590_runtime_ui.js",
    HERE / "v510_targeted_runtime.js",
    HERE / "v510_runtime_ui.js",
    HERE / "v5122_facial_selector_probe.js",
    HERE / "v5122_facial_probe_ui.js",
    HERE / "v5123_fisp_probe.js",
    HERE / "v5128_hybrid_bridge.js",
    HERE / "v5128_hybrid_bridge_ui.js",
]
BASELINE_TEXT_PATCHES = {
    "The browser could not decode this video stream. It remains available for extraction; PS2 PSS demuxing will be added later.":
    "The browser could not decode this stream. Extraction remains available. V5.5 exports one MPEG-PS movie with its recovered stereo audio; in-page MPEG-2 playback remains browser-dependent.",
    "document.title = 'SO3 Resource Explorer V5.1';":
    "document.title = 'SO3 Resource Explorer V5.12.8 Pass 6.2';",
    "if (title) title.textContent = 'SO3 Resource Explorer V5.1';":
    "if (title) title.textContent = 'SO3 Resource Explorer V5.12.8 Pass 6.2';",
    "if (subtitle) subtitle.textContent = 'V4.4 preserved • V5.0.1 hotfix preserved • verified rigid model/map viewer • limited unposed XBDC inspection • offline and read-only.';":
    "if (subtitle) subtitle.textContent = 'Original FAS evaluator, target-node setter, local/world writer, and parent composition verified • mesh skinning pending • corrected PS2 texture decoding • offline and read-only.';",
    "const p=parsePack(data);if(!p||p.kind!=='local'){issues.push(`${meta.name||'PACK'}: unsupported/nonlocal PACK framing`);return;}":
    "const p=parsePack(data);if(!p){issues.push(`${meta.name||'PACK'}: malformed PACK descriptor table`);return;}if(p.kind!=='local')return;",
    "let header='';if(sectors&&offset+8<=file.size){const h=await readSlice(file,offset,Math.min(16,size));header=classifyHeader(h)}rows.push({index:i,lba,sectors,runtime,offset,size,runtimeOffset:runtime*SECTOR,header})":
    "let header='',rawHeaderHex='';if(sectors&&offset+8<=file.size){const h=await readSlice(file,offset,Math.min(16,size));rawHeaderHex=bytesHex(h).toUpperCase();header=classifyHeader(h)}rows.push({index:i,lba,sectors,runtime,offset,size,runtimeOffset:runtime*SECTOR,header,rawHeaderHex})",
    "COMMAND_ACTIONS.scan_mwo3_modules='Decode wrapper allocations, identify MWo3 modules, and export modules matching load-base/class/end criteria.';":
    "COMMAND_ACTIONS.scan_mwo3_modules='Decode wrapper allocations, identify MWo3 modules, and export modules matching load-base/class/end criteria.';COMMAND_ACTIONS.facial_selector_evidence_hunt='Run the preserved facial-event and executable evidence audit against the open ISO.';COMMAND_ACTIONS.extract_fisp_palette_evidence='Decode bounded ISO allocations and export generic FISP renderer-context evidence; this action is not a facial-palette selector.';",
    "case'scan_mwo3_modules':return await scanMwo3Modules(c);":
    "case'scan_mwo3_modules':return await scanMwo3Modules(c);case'facial_selector_evidence_hunt':{const hunt=globalThis.SO3V5122FacialProbeUI;if(!hunt?.runCompleteEvidenceHunt)throw Error('V5.12.2 facial-selector probe UI is unavailable');const result=await hunt.runCompleteEvidenceHunt();return`facial hunt: ${result.executables} executable(s), ${result.events} naka event(s), ${result.clusters} cluster(s), ${result.errors} collection error(s)`;}case'extract_fisp_palette_evidence':return await scanFispPaletteRecords(c);",
}
BASELINE_SOURCE_PATCHES = {
    """        if (p + 8 > end) break; const size = u32(d, p + 4);
        segment.fis.push({ off: p, magic: ascii(b, p, 4), size, boundaryOk: size >= 8 && p + size <= end });""":
    """        if (p + 8 > end) break; const storedSize = u32(d, p + 4), magic = ascii(b, p, 4), size = storedSize + 0x10;
        segment.fis.push({ off: p, magic, size, storedSize, boundaryOk: size >= 8 && p + size <= end });""",
    """    const names = []; if (off1 + 16 <= b.length) { const tail = Array.from(b.subarray(off1 + 16, Math.min(off2 || b.length, b.length)), x => String.fromCharCode(x)).join(''), re = /[A-Za-z_][A-Za-z0-9_ .]{1,30}/g; let m; while ((m = re.exec(tail)) && names.length < nodeCount) { const n = m[0].trim(); if (n) names.push(n); } }
    nodes.forEach((n, i) => n.name = names[i] || `node_${n.index}`);
    return { magic: 'RTA', size, nodeCount, off1, off2, nodes, names, confidence: { hierarchy: 'VERIFIED', names: names.length === nodeCount ? 'VERIFIED' : 'STRUCTURAL', attachments: 'INFERENCE' } };""":
    """    /* V5.8: verified fixed 0x14-byte records: unresolved f32 + char[16] CP932. */
    const names = [], nameRecords = [], namesAt = off1 + 16;
    if (namesAt + nodeCount * 0x14 <= b.length) for (let i = 0; i < nodeCount; i++) { const rec = namesAt + i * 0x14, field = b.subarray(rec + 4, rec + 0x14); let cut = field.indexOf(0); if (cut < 0) cut = field.length; const name = decodeText(field.subarray(0, cut)).trim(); names.push(name || `node_${nodes[i].index}`); nameRecords.push({ off: rec, scalar: f32(d, rec), name: names[i] }); }
    nodes.forEach((n, i) => { n.name = names[i] || `node_${n.index}`; n.nameScalar = nameRecords[i] ? nameRecords[i].scalar : null; });
    return { magic: 'RTA', size, nodeCount, off1, off2, nodes, names, nameRecords, confidence: { hierarchy: 'VERIFIED', names: names.length === nodeCount ? 'VERIFIED' : 'STRUCTURAL', nameScalar: 'UNRESOLVED', attachments: 'INFERENCE' } };""",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    actual = sha256(BASELINE)
    if actual != EXPECTED_V51:
        raise SystemExit(f"V5.1 baseline mismatch: {actual}")
    text = BASELINE.read_text(encoding="utf-8")
    for patches in (BASELINE_TEXT_PATCHES, BASELINE_SOURCE_PATCHES):
        for old, new in patches.items():
            if text.count(old) != 1:
                raise SystemExit(f"expected one baseline patch target, found {text.count(old)}")
            text = text.replace(old, new)
    injection_marker = "function parseCommandScript(){"
    if text.count(injection_marker) != 1:
        raise SystemExit(f"expected one command-injection marker, found {text.count(injection_marker)}")
    injection = FISP_COMMAND_INJECTION.read_text(encoding="utf-8")
    if "</script" in injection.lower():
        raise SystemExit(f"unsafe inline script terminator in {FISP_COMMAND_INJECTION.name}")
    text = text.replace(injection_marker, injection + "\n" + injection_marker)
    marker = "</body>"
    if marker not in text:
        raise SystemExit("baseline has no body terminator")
    blocks = []
    for source in SOURCES:
        body = source.read_text(encoding="utf-8")
        if "</script" in body.lower():
            raise SystemExit(f"unsafe inline script terminator in {source.name}")
        blocks.append(f'\n<script data-v510-source="{source.name}">\n{body}\n</script>\n')
    head, tail = text.rsplit(marker, 1)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(head + "".join(blocks) + marker + tail, encoding="utf-8")
    print(f"built {OUTPUT}")
    print(f"sha256 {sha256(OUTPUT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
