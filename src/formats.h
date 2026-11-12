/*
 * formats.h - "unpack / convert" engine: recognises common PS4 game data
 * formats from their first bytes and unpacks or converts them.
 *
 * Containers : tri-Ace KCAP packs (+SLZ), PSARC (zlib/lzma), Wwise AKPK (.pck)
 *              and BKHD (.bnk), CRI AFS and AFS2/AWB, LZ4 frames, standalone SLZ
 * Conversions: DDS textures -> PNG (RGBA/BGRA/RGB 8-bit, BC1-BC5, BC7),
 *              tri-Ace AIF textures (BC7 / RGBA8, PS4 tiling) -> PNG
 *
 * Sources are read with 64-bit offsets from (fd, offset, length), so an entry
 * inside a big archive (e.g. Star Ocean 4's 0001.bin) can be unpacked in place.
 * Nothing is ever written to the source.
 */
#ifndef FORMATS_H
#define FORMATS_H

#include <stdint.h>
#include <stddef.h>
#include <stdio.h>

typedef struct {
    /* progress: called often; return nonzero to cancel */
    int  (*cb)(void *user);
    void *user;
    const char *current;     /* name being written (for the progress screen) */
    uint32_t files;          /* files written */
    uint32_t failed;         /* members that could not be unpacked */
    uint64_t bytes;          /* bytes written */
    int      cancelled;
    char     kind[64];       /* what the top-level file was recognised as */
    char     error[256];     /* first error */
    FILE    *log;            /* optional: one line per output file */
    int      depth;          /* internal */
} FmtJob;

/* Describe the data at (fd, off, len) from its first bytes. Returns 1 if the
 * engine can unpack/convert it (desc says what it is), 0 otherwise. */
int fmt_identify(int fd, uint64_t off, uint64_t len, char *desc, size_t n);

/* Unpack/convert into out_dir (created if needed). name_hint names single
 * outputs (e.g. "00656" -> 00656.png). Returns 0 ok, 1 not a supported
 * format, -1 error (job->error), -2 cancelled. Partial output is kept. */
int fmt_unpack(int fd, uint64_t off, uint64_t len, const char *name_hint, const char *out_dir, FmtJob *job);

/* Same for a whole file. */
int fmt_unpack_path(const char *path, const char *out_dir, FmtJob *job);

/* Lower-level pieces (exposed for tests). */
uint8_t *slz_decompress(const uint8_t *in, size_t in_len, size_t *out_len, char *err, size_t errn);
uint8_t *slz_decompress_prefix(const uint8_t *in, size_t in_len, size_t maxout, size_t *out_len, char *err, size_t errn);
uint8_t *lz4f_decompress(const uint8_t *in, size_t in_len, size_t *out_len, char *err, size_t errn);
uint8_t *dds_to_rgba(const uint8_t *in, size_t in_len, uint32_t *w, uint32_t *h, char *err, size_t errn);
int      png_write(const char *path, const uint8_t *rgba, uint32_t w, uint32_t h);

/* Images for the on-screen viewer: DDS (as above), PNG (all colour types,
 * 1-16 bit, interlaced), BMP (24/32-bit, 8-bit palette), TGA (true-colour,
 * grey, palette; RLE or not). Returns malloc'd RGBA, desc says what it was. */
int      img_is_image(const uint8_t *head, size_t n);
/* tri-Ace AIF texture sets (BC7 / RGBA8, PS4-tiled): number of images, or
 * -1; and image `index` as malloc'd RGBA. */
int      aif_count(const uint8_t *in, size_t n);
uint8_t *aif_decode_pixels(const uint8_t *pix, size_t n, uint32_t fmt, uint32_t w, uint32_t h, uint32_t bpb, uint32_t wb, uint32_t hb, char *err, size_t en);
uint8_t *aif_to_rgba(const uint8_t *in, size_t n, int index, uint32_t *w, uint32_t *h, char *desc, size_t dn, char *err, size_t en);
uint8_t *img_decode(const uint8_t *in, size_t n, uint32_t *w, uint32_t *h, char *desc, size_t dn, char *err, size_t errn);

#endif
