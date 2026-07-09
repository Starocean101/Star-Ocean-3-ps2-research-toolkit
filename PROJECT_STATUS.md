# Project Status

## Solved

- ISO9660/Joliet visible file traversal
- tri-Ace hidden resource table for SO3 PAL Disc 1
- all 5,883 nonempty hidden entries enumerated and extractable
- SLZ stored/type 1/type 2/type 3 decoding
- chained SLZ resources
- SLE byte preprocessing
- hidden entry-1 IOP module bundle
- RPC server `0x1234`
- RPC function `0x0E`
- `gunSecretKeyCode` source constant
- EE VU0 post-processing
- final 16-byte PAL SLE key
- strict validation against entry 1068
- browser-based SLE extraction

## Active container research targets

- `PACK`
- `ZLS`
- decoded resources with unknown signatures
- nested archive/index formats inside large SLE outputs
- texture, model, map, script, audio, and movie containers encountered later

## Not yet verified

- PAL Disc 2 compatibility
- NTSC-U hidden-table constants and key
- NTSC-J hidden-table constants and key
- applicability to Radiata Stories
- applicability to Valkyrie Profile 2
- general tri-Ace profile detection

## Ground rule

A format is not marked solved because one sample opens. It should have:

1. a written structure;
2. parser/extractor code;
3. bounds checking;
4. multiple sample validations;
5. hashes or expected metadata;
6. synthetic regression fixtures where practical.
