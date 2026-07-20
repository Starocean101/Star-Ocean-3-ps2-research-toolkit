# Browser Extractor Guide

## Launch

The application is:

```text
browser/so3_browser_disc_investigator.html
```

It is a self-contained HTML file. It can be hosted on a static host or opened by
a browser that permits local HTML execution. On iOS, hosting it on a simple static
site is usually more reliable than opening it through Files/Quick Look.

## Basic workflow

1. Open the page.
2. Select a legally obtained Star Ocean 3 ISO.
3. Press **Open and analyze**.
4. Review the summary and filesystem tree.
5. Open **Hidden Resources** to inspect the proprietary table entries.
6. Open **SLZ / SLE** to decode compressed resources.
7. Use **Decode all SLE entries from ISO** for the known PAL SLE resources.
8. Export individual files or the combined decoded ZIP and reports.

## Tabs and functions

### Summary

Shows disc size, ISO volume information, visible filesystem counts, and hidden
table recognition.

### Visible Files

Traverses ISO9660/Joliet directory records and permits direct extraction.

### Hidden Resources

Displays hidden table index, LBA, byte offset, sector count, allocated size,
runtime offset, and detected top-level signature.

### Extent Map

Compares visible file payload extents and hidden-resource extents. This is an
allocation comparison, not a complete map of all filesystem metadata sectors.

### Signature Scanner

Scans selected scopes for byte signatures:

- visible files;
- hidden resource ranges;
- raw ISO.

Use bounded chunk sizes on iOS. Raw full-disc scans can take time and Safari may
suspend the tab when the device sleeps.

### IOP / IRX

Parses `IOPRP271.IMG` ROMDIR entries, extracts modules, examines ELF imports and
exports, and identifies simple `sceSifRegisterRpc` registration patterns.

### SLZ / SLE

Decodes stored, type-1, type-2, and type-3 SLZ blocks and chained resources.
SLE first applies its byte/key transform and then runs the corresponding SLZ
decoder.

The embedded verified PAL key is:

```text
66665442b379f0c7e7d51e4b7ba41c7d
```

## Memory model

The ISO remains a browser `File` object. Operations call `slice(start, end)` and
read only the requested region. This is why a multi-gigabyte DVD image can be
processed on a phone without allocating the entire image.

Potentially large generated outputs, such as a combined ZIP, still require memory
for the output being assembled.

## Safety

The app is read-only:

- it does not patch the ISO;
- it does not write sectors;
- it does not upload the selected ISO to a server;
- processing occurs in the browser page.

A static host serves only the HTML/JavaScript application. The selected disc
remains local to the browser unless the hosting service itself injects unrelated
code, which is why a trusted static host is preferable.

## Known limitations

- The SO3 hidden-table profile is currently hardcoded for the verified PAL disc.
- The embedded SLE key is PAL-specific until other regions are validated.
- UDF recognition is limited; full UDF directory traversal is not the primary path.
- Multi-extent ISO files are not fully merged.
- Signature scanning is cooperative/chunked on the main thread rather than a
  dedicated Web Worker.
- Container formats inside decoded resources still require separate parsers.
