/* Injected inside the preserved V4.4/V5.1 closure by build_release.py.
 * It therefore uses the existing private ISO, wrapper-decoder, download,
 * hashing, and store-ZIP helpers without exposing them to page JavaScript.
 */
async function scanFispPaletteRecords(c={}){
  if(!state.iso)throw Error('Open the SO3 Disc 1 ISO first');
  const Core=globalThis.SO3V5124FispProbe||globalThis.SO3V5123FispProbe;if(!Core?.scanSections)throw Error('V5.12.4 FISP context scanner is unavailable; reload the V5.12.4 Explorer');
  const scope=c.scope||'all',maxAllocation=Math.max(1,Math.min(256,Number(c.max_allocation_mb||64)))*1048576,maxSection=Math.max(1,Math.min(16,Number(c.max_section_mb||4)))*1048576,maxMatches=Math.max(1,Math.min(512,Number(c.max_matches||128))),alignment=Number(c.alignment||4);
  if(![1,2,4,8,16].includes(alignment))throw Error('alignment must be 1, 2, 4, 8, or 16');
  const candidates=scope==='selected'?selectedHiddenRows():state.hidden.filter(x=>x.sectors),rows=candidates.slice(0,4096),found=[],errors=[],omitted=[],seen=new Set();let decodedBlocks=0,scannedBytes=0;
  if(candidates.length>rows.length)omitted.push({source_kind:'HIDDEN_ROW_LIMIT',reason:'candidate allocation count exceeded 4096-row cap',candidate_allocations:candidates.length,scanned_allocations:rows.length});
  const scan=async(bytes,meta)=>{
    const parsed=Core.scanSections(bytes,{alignment,maxBytes:maxAllocation,maxSectionBytes:maxSection,maxMatches:maxMatches-found.length}),limit=parsed.scanned_range[1];scannedBytes+=limit;
    for(const item of parsed.sections){
      const off=item.offset,sectionSize=item.section_size,section=bytes.slice(off,off+sectionSize),hash=await sha256(section),dedupeKey=`${hash}:${sectionSize}`;
      if(seen.has(dedupeKey))continue;seen.add(dedupeKey);
      found.push({...meta,scan_offset:off,section_size:sectionSize,content_size:item.content_size,stored_after_prefix:item.stored_after_prefix,chain_stride:item.chain_stride,bytes_after_content_in_stride:item.bytes_after_content_in_stride,profile_count:item.profile_count,profiles:item.profiles,sha256:hash,_data:section});
      if(found.length>=maxMatches)return true;
    }
    if(bytes.length>limit)omitted.push({...meta,reason:'decoded/raw source exceeded scan cap',source_bytes:bytes.length,scanned_prefix_bytes:limit});
    return false;
  };
  const scanWrapped=async(x,meta)=>{
    const raw=await readSlice(state.iso,x.offset,x.size);let pos=x.header==='ZLS'?findMagicOffset(raw):0;
    if(pos<0)throw Error('No inner SLZ/SLE stream found inside ZLS wrapper');
    for(let block=0;block<256&&pos+16<=raw.length;block++){
      const magic=td.decode(raw.slice(pos,pos+3));if(magic!=='SLZ'&&magic!=='SLE')break;
      const compressed=u32(raw,pos+4),declaredDecoded=u32(raw,pos+8),next=u32(raw,pos+12),total=16+compressed,blockMeta={...meta,source_kind:'DECODED_WRAPPER_BLOCK',block,wrapper_source_offset:pos,declared_decoded_bytes:declaredDecoded};
      if(pos+total>raw.length)throw Error(`Block ${block} truncated`);
      if(declaredDecoded>maxAllocation)omitted.push({...blockMeta,reason:'declared decoded block exceeded cap before decompression'});
      else{
        const out=(await decodeChunk(new Blob([raw.slice(pos,pos+total)]),magic==='SLE'?parseKey(FINAL_SLE_KEY_HEX):null)).out;decodedBlocks++;
        if(await scan(out,{...blockMeta,decoded_bytes:out.length}))return true;
      }
      if(!next)break;if(next<16||pos+next<=pos||pos+next>raw.length)throw Error(`Invalid next-block offset ${hex(next)}`);pos+=next;
      if((block&15)===15)await sleep();
    }
    return false;
  };
  $('commandProgress').max=Math.max(1,rows.length);$('commandProgress').value=0;
  for(let i=0;i<rows.length&&found.length<maxMatches;i++){
    if(state.commandCancel)break;const x=rows[i],meta={entry:x.index,source_header:x.header,iso_offset:x.offset,allocated_bytes:x.size};
    try{
      if(x.size>maxAllocation){omitted.push({...meta,reason:'allocated source exceeded cap before decode'});continue}
      if(/^(?:SLZ|SLE)[0-3]$/.test(x.header)||x.header==='ZLS'){
        await scanWrapped(x,meta);
      }else{
        const raw=await readSlice(state.iso,x.offset,x.size);if(await scan(raw,{...meta,source_kind:'RAW_HIDDEN_ALLOCATION',block:null,decoded_bytes:raw.length}))break;
      }
    }catch(e){errors.push({...meta,error:e.message})}
    finally{$('commandProgress').value=i+1;if((i&15)===0)await sleep()}
  }
  const clean=found.map(({_data,...row})=>row),created=new Date().toISOString(),report={format:'SO3_GENERIC_FISP_CONTEXT_SCAN',version:2,tool_version:'5.12.4',created,classification:'GENERIC_RENDERER_TEMPLATE_NOT_FACIAL',promotion:false,criteria:{scope,max_allocation_bytes:maxAllocation,max_section_bytes:maxSection,max_matches:maxMatches,alignment},coverage:{candidate_allocations_total:candidates.length,candidate_allocations_scanned:rows.length,decoded_blocks:decodedBlocks,scanned_bytes:scannedBytes,cancelled:state.commandCancel},finding_count:clean.length,findings:clean,omitted,errors,evidence_note:'Corrected parser: header +0x04 plus 0x10 is FISP content size; +0x0C is the chain/alignment stride. Lib 0x0046AD90 uses FISP in a generic render-descriptor path. No captured FISP instance or caller is associated with actor 0x0BC0, FAS naka events, or the FISA facial-member selector.'};
  const tsv=['entry\tblock\tsource_kind\tsource_header\tscan_offset\tcontent_size\tchain_stride\tprofile_count\trecord_byte_2\ttex0_csa_low5\ttex0_cld_high3\tsha256',...clean.map(r=>`${r.entry}\t${r.block??''}\t${r.source_kind}\t${r.source_header}\t${hex(r.scan_offset)}\t${r.content_size}\t${r.chain_stride}\t${r.profile_count}\t${r.profiles.map(p=>p.record_byte_2).join(',')}\t${r.profiles.map(p=>p.tex0_csa_low5).join(',')}\t${r.profiles.map(p=>p.tex0_cld_high3).join(',')}\t${r.sha256}`)].join('\n')+'\n';
  const reportText=JSON.stringify(report,null,2),files=[{name:'SO3_GENERIC_FISP_CONTEXT_SCAN.json',data:te.encode(reportText)},{name:'SO3_GENERIC_FISP_CONTEXT_SCAN.tsv',data:te.encode(tsv)},{name:'README.txt',data:te.encode('Read-only generic FISP context extraction from the opened SO3 ISO. V5.12.4 corrects the section length: stored_after_prefix + 0x10 is content; +0x0C is a chain stride. FISP is not promoted as a facial resource or actor 0x0BC0 palette selector.\n')}];
  for(let i=0;i<found.length;i++){const r=found[i],name=`fisp/entry_${String(r.entry).padStart(4,'0')}_block_${String(r.block??0).padStart(2,'0')}_off_${hex(r.scan_offset).slice(2)}_${r.sha256.slice(0,12)}.fisp`;files.push({name,data:r._data})}
  const sums=[];for(const f of files)sums.push(`${await sha256(f.data)}  ${f.name}`);files.push({name:'SHA256SUMS.txt',data:te.encode(sums.join('\n')+'\n')});
  const manifest={format:'SO3_GENERIC_FISP_CONTEXT_PACKAGE',version:2,tool_version:'5.12.4',created,note:'MANIFEST.json does not hash itself. SHA256SUMS covers report, TSV, README, and captured FISP members; MANIFEST hashes SHA256SUMS too.',summary:{findings:found.length,allocations:rows.length,decoded_blocks:decodedBlocks,scanned_bytes:scannedBytes,omitted:omitted.length,errors:errors.length},members:await Promise.all(files.map(async f=>({path:f.name,byte_size:f.data.length,sha256:await sha256(f.data)})))};files.push({name:'MANIFEST.json',data:te.encode(JSON.stringify(manifest,null,2))});
  clearBox('commandDownloads');addDownload($('commandDownloads'),'SO3_GENERIC_FISP_CONTEXT_SCAN.json',reportText,'application/json');addDownload($('commandDownloads'),'SO3_GENERIC_FISP_CONTEXT.zip',makeStoreZip(files),'application/zip');
  return`generic FISP context scan: ${found.length} unique content section(s), ${decodedBlocks} decoded wrapper block(s), ${errors.length} error(s)`;
}
