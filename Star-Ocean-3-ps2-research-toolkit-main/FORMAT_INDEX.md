# Format index — Atlas V1.1.2

The canonical machine-readable details are in
`05_ATLAS/SO3_FORMAT_REGISTRY_V1_1_2.json`.

| Family | Current scope |
|---|---|
| ISO9660 / Joliet | Visible-disc traversal verified |
| Hidden allocation table | PAL Disc 1 verified |
| SLZ0/1/2/3 | Bounds-checked decode verified |
| SLE | PAL key and preprocessing verified |
| PACK | Local archive plus reference/index distinctions implemented |
| Semantic bundle | Child table and resource grouping implemented |
| MWo3 | Module mapping and bounded runtime tooling |
| FIS / FISA | Texture, CLUT, family membership, and selector evidence |
| SEQW | Sparse bank structure implemented |
| FPS | Chain segments, material records, packet structure |
| XBDC | FIXED-profile character geometry; one-matrix consumer scope verified |
| RMAC | Rigid/map geometry chain |
| RTA | Fixed records and exact-name runtime-object binding |
| FAS | Channels, events, rotation tracks, and executed evaluator |
| CHAR / ATRC / ANIM | Character geometry, rig, and animation resource family |
| MAP / ATRM / MAPA | Map geometry, hierarchy, and animation resource family |
| MMAP / DMM | Minimap/index raster family |
| SO3 movie carrier | Exact transform to MPEG program stream |
| SAC | Stereo PCM decode implemented |
| MPEG-PS/LPCM | Download mux implemented; Safari playback codec-limited |

Status labels in Atlas remain authoritative. A parser recognizing a structure
does not by itself verify gameplay meaning, world placement, or visual output.
