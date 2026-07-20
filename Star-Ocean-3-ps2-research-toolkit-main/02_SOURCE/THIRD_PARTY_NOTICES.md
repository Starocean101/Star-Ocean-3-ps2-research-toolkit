# Third-party notices

The FIS image conversion module (`v5_fis.js`) is a JavaScript port of the verified algorithms and PlayStation 2 GS address tables supplied in `SO3_FIS_FORMAT_PASS_V2/parser/so3_fis_tool_v2.py`. That supplied work is licensed under GNU GPL version 3 or later. The corresponding license text is included as `LICENSE_GPL-3.0.txt`.

No network library, CDN asset, font, renderer, or server-side component is used by the release HTML. The RTA viewport and all other V5 interface code are self-contained source in this package.

V5.8.1 includes a normalized data transcription of `SO3_fileList.txt`, whose
embedded title attributes the historical claims to “The Dude” and “A Satoh
Production.” The original text is included solely for provenance and
reproducibility. No legacy Windows executable, MaxScript, or QuickBMS script is
embedded in or executed by the release HTML.

The audit compares the supplied tools against publicly available CUE SLZ and
triAce-PS2 source and Nisto's public `pk3dec` repository. No code from those
external sources was added in V5.8.1; existing Explorer decoders and parsers
remain the previously tested implementations.
