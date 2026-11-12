/* cpk.h - read-only CRI CPK archive reader / extractor (CRI File System).
 *
 * Supports: obfuscated @UTF tables, TOC (named files), ITOC (ID-only files),
 * CRILAYLA-compressed members, 64-bit offsets. Archives are only ever opened
 * O_RDONLY - nothing is written to the source.
 */
#pragma once
#include <stdint.h>
#include <stdio.h>

typedef struct {
    uint32_t    id;
    const char *dir;        /* "" if none (points into the TOC string table) */
    const char *name;       /* "" for ID-only entries */
    uint64_t    offset;     /* absolute offset in the archive */
    uint64_t    size;       /* stored size (FileSize) */
    uint64_t    xsize;      /* extracted size (ExtractSize) */
    int         beyond_end; /* data lies outside the archive (truncated/corrupt) */
} CpkEntry;

typedef struct {
    char        path[1024];
    int         fd;
    uint64_t    file_size;
    uint8_t     head[64];
    int         head_len;
    int         is_cpk;      /* "CPK " magic present */
    int         parsed;      /* tables read successfully */
    int         has_toc, has_itoc;
    uint64_t    toc_off, itoc_off, content_off, align, hdr_files;
    CpkEntry   *e;
    uint32_t    n;
    uint8_t    *toc_buf;    /* keeps the TOC strings alive */
    int         so4;         /* Star Ocean 4 (tri-Ace) archive read via the index in 0000.bin */
    int         so4_arch;    /* 0 = 0000.bin, 1 = 0001.bin */
    uint32_t    so4_used_all;/* used IDs in the whole index (both archives) */
    uint8_t     so4_key[192];/* the index's XOR key (to test whether file data uses it too) */
    char        error[256];
} Cpk;

/* Open and parse. Returns 0 if it is a CPK with a usable file table,
 * 1 if the file opened but is not a CPK (head[] still filled), -1 on error. */
int  cpk_open(Cpk *c, const char *path);

/* Quick check used when looking for archives: 1 if path is a CPK, or a Star
 * Ocean 4 0000.bin/0001.bin whose index (in 0000.bin) decodes and checks out. */
int  cpk_probe(const char *path);
void cpk_close(Cpk *c);

/* Progress callback: return non-zero to cancel. */
typedef struct {
    const char *current;
    uint32_t files_done, files_total, files_ok, files_failed, files_skipped;
    uint64_t bytes_done, bytes_total;   /* archive bytes processed / to process */
    uint64_t bytes_written;
    int cancelled, failed;
    char error[256];
} CpkProgress;
typedef int (*CpkProgressFn)(CpkProgress *p, void *user);

typedef struct {
    int keep_raw;        /* also save compressed members as <name>.crilayla */
    int resume;          /* skip outputs that already exist with the expected size */
} CpkOptions;

/* Bytes still to be written by extract_all (for the free-space check). */
uint64_t cpk_bytes_needed(Cpk *c, const char *out_dir, const CpkOptions *o, uint32_t *files_left);

/* Extract every entry into out_dir (= <dest>/<archive stem>). Appends one line per
 * file to log (may be NULL). Returns 0 if every file succeeded or was skipped. */
int  cpk_extract_all(Cpk *c, const char *out_dir, const CpkOptions *o, FILE *log,
                     CpkProgress *p, CpkProgressFn cb, void *user);

/* Extract a single entry into out_dir/<FileName> (unique name if taken). */
int  cpk_extract_one(Cpk *c, uint32_t index, const char *out_dir, char *saved, size_t n, char *err, size_t errn);

/* Find an entry by "Dir/File", "File" (case-insensitive) or decimal/hex ID. -1 if none. */
int  cpk_find(Cpk *c, const char *query);

/* Copy [offset, offset+len) of any file to out_path (streamed). */
int  cpk_dump_range(const char *src, uint64_t offset, uint64_t len, const char *out_path,
                    CpkProgress *p, CpkProgressFn cb, void *user, char *err, size_t errn);

/* Write the listing (ID, path, offset, size, extract size) as text. */
/* Short description of what an entry's data looks like (from its first bytes). */
void cpk_sniff(Cpk *c, uint32_t index, char *out, size_t n);

/* Magic survey: read the first 16 bytes of every entry (no extraction), tally
 * them by their first 4 bytes and write a short report to out. For Star Ocean 4
 * archives it also tallies the bytes as they would read XOR'd with the index
 * key, to show whether file data is scrambled the same way. cb may cancel.
 * Fills *known_raw / *known_xor with entries whose start is a recognised format.
 * Returns 0, -1 on error, -2 if cancelled. */
int cpk_survey(Cpk *c, FILE *out, int (*cb)(void *), void *user, uint32_t *known_raw, uint32_t *known_xor, uint32_t *readable);
/* Magic survey: for every entry of every archive in paths, write one line
 * "ID<TAB>archive<TAB>size<TAB>32 bytes hex<TAB>ASCII" sorted by ID. */
int  cpk_write_magic(const char *const *paths, int n, const char *out_path, uint32_t *lines, char *err, size_t errn);
/* Tiny companion: per-archive format tally + scrambled/plain verdict (cpk_survey)
 * written to out_path; verdict gets a one-line summary for the screen. */
int  cpk_write_magic_summary(const char *const *paths, int n, const char *out_path, char *verdict, size_t vn, char *err, size_t errn);
int  cpk_write_listing(Cpk *c, const char *out_path);

/* CRILAYLA: decompress a whole member. Returns malloc'd buffer or NULL. */
uint8_t *crilayla_decompress(const uint8_t *in, size_t in_len, size_t *out_len);

/* Archive stem for output folders: "0000.bin" -> "0000". */
void cpk_stem(const char *path, char *out, size_t n);
