# SO3 Resource Explorer V5.11.0 — Model Evidence Pass

## Outcome

V5.11.0 corrects a corpus-wide embedded-texture discovery defect, resolves FISA group membership, and removes an unsafe spatial-skeleton claim.

## Aligned texture discovery

The earlier parser advanced through a VIF stream until it desynchronized. A valid `FIS\0` header can also decode as harmless VIF words, so real textures could be swallowed without a parser error. V5.11 performs a separate 16-byte-aligned scan inside each bounded FPS block and validates the stored section size before accepting a member.

Across the 13 canonical geometry fixtures:

- previous exposed sections: 121;
- corrected sections: 184;
- FIS images: 175, with 175 strict parses and 175 successful image decodes;
- FISA tables: 9, with 9 strict parses.

Actor `0x0BC0` changes from six decoded FIS images / twelve palette variants to eight images / fifteen variants. The recovered omissions are texture `1289` (128×128 PSMT8, one palette bank) and texture `2413` (64×64 PSMT4, two banks).

## FISA groups

All nine FISA tables use the same mechanical relationship:

1. `unknown_08` is the FIS member stride.
2. The FISA table trails the indexed group.
3. The first FIS begins at `fisa_offset - count * stride`.
4. Pair key `i` equals `0x10 + i * stride` relative to the group base sixteen bytes before the first FIS header.

All 34 pair keys resolve exactly to FIS headers. FISA group membership is therefore verified across the corpus. The runtime meaning of pair value `1` remains unresolved.

## RTA safety correction

The RTA sample has bounded record indices, link fields, vectors, and verified fixed-width names. However, treating its link field as an anatomical parent and adding the three stored floats as local translations produces impossible anatomy on actor `0x0BC0`. V5.11 therefore lists the raw records but withholds the spatial skeleton drawing. This does not invalidate exact FAS-to-RTA name matches; it prevents a separate unverified spatial interpretation from being presented as fact.

## Remaining model gates

- Matrix address to RTA node mapping (`U-GEO-01`).
- Exact RTA bind-pose composition.
- Runtime material/TEX0 metadata to FIS assignment.
- FAS quaternion evaluation and interpolation.

The diagnostic unposed mesh remains available. Final skinned/animated export is still withheld.
