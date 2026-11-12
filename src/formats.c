/*
 * formats.c - unpack / convert engine (see formats.h).
 *
 * Every reader checks every offset and size against the data it really has;
 * corrupt input gives an error, never a crash or a huge allocation.
 */
#include "formats.h"
#include "bc7.h"
#include "asf.h"
#include "aac.h"
#include "text16.h"

#include <errno.h>
#include <math.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>
#include <zlib.h>
#include <lzma.h>

#define MAXMEM   (512ull << 20)   /* largest buffer we will hold in memory */
#define COPYBUF  (8u << 20)
#define MAXDEPTH 2
#define IMG_MAXPX (64u << 20)   /* 64 Mpixel = 256 MB RGBA */

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */
static uint16_t le16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }
static uint32_t le32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static uint64_t le64(const uint8_t *p) { return (uint64_t)le32(p) | (uint64_t)le32(p + 4) << 32; }
static uint32_t be32(const uint8_t *p) { return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3]; }
static uint64_t beN(const uint8_t *p, int n) { uint64_t v = 0; for (int i = 0; i < n; i++) v = v << 8 | p[i]; return v; }

static void seterr(FmtJob *j, const char *fmt, const char *a)
{
    if (j && !j->error[0]) snprintf(j->error, sizeof(j->error), fmt, a ? a : "");
}

static int rd(int fd, uint64_t off, void *buf, size_t n)
{
    uint8_t *b = buf;
    while (n) {
        ssize_t r = pread(fd, b, n, (off_t)off);
        if (r < 0) { if (errno == EINTR) continue; return -1; }
        if (r == 0) return -1;
        b += r; off += (uint64_t)r; n -= (size_t)r;
    }
    return 0;
}

static uint8_t *load(int fd, uint64_t off, uint64_t n)
{
    if (n > MAXMEM) return NULL;
    uint8_t *b = malloc(n ? (size_t)n : 1);
    if (!b) return NULL;
    if (n && rd(fd, off, b, (size_t)n) != 0) { free(b); return NULL; }
    return b;
}

static int mkdirs(const char *path)
{
    char tmp[2048];
    snprintf(tmp, sizeof(tmp), "%s", path);
    for (char *p = tmp + 1; *p; p++)
        if (*p == '/') { *p = 0; if (mkdir(tmp, 0777) != 0 && errno != EEXIST) return -1; *p = '/'; }
    if (mkdir(tmp, 0777) != 0 && errno != EEXIST) return -1;
    return 0;
}

/* Safe relative path: no "..", no leading '/', odd characters replaced. */
static void safe_rel(const char *in, char *out, size_t n)
{
    size_t o = 0;
    while (*in == '/' || *in == '\\') in++;
    for (; *in && o + 1 < n; in++) {
        char c = *in;
        if (c == '\\') c = '/';
        if (c == '/' && o && out[o - 1] == '/') continue;
        if ((unsigned char)c < 0x20 || strchr(":*?\"<>|", c)) c = '_';
        out[o++] = c;
    }
    out[o] = 0;
    /* neutralise ".." components */
    for (char *p = out; (p = strstr(p, "..")) != NULL; p += 2) {
        int start = (p == out || p[-1] == '/'), end = (p[2] == 0 || p[2] == '/');
        if (start && end) { p[0] = '_'; p[1] = '_'; }
    }
    if (!out[0]) snprintf(out, n, "unnamed");
}

static int tick(FmtJob *j)
{
    if (j->cancelled) return 1;
    if (j->cb && j->cb(j->user)) j->cancelled = 1;
    return j->cancelled;
}

static void join(char *out, size_t n, const char *dir, const char *rel)
{
    snprintf(out, n, "%s/%s", dir, rel);
}

static int prep_parent(const char *full)
{
    char d[2048];
    snprintf(d, sizeof(d), "%s", full);
    char *s = strrchr(d, '/');
    if (!s) return 0;
    *s = 0;
    return mkdirs(d);
}

static void logline(FmtJob *j, const char *full, uint64_t size, const char *res)
{
    if (j->log) fprintf(j->log, "%s\t%llu\t%s\n", full, (unsigned long long)size, res);
}

static int write_buf(FmtJob *j, const char *dir, const char *relname, const uint8_t *data, size_t len, char *saved, size_t sn)
{
    char rel[1024], full[2048], part[2100];
    safe_rel(relname, rel, sizeof(rel));
    join(full, sizeof(full), dir, rel);
    if (saved) snprintf(saved, sn, "%s", full);
    j->current = rel;
    if (prep_parent(full) != 0) { seterr(j, "cannot create folder for %s", full); j->failed++; return -1; }
    snprintf(part, sizeof(part), "%s.part", full);
    FILE *f = fopen(part, "wb");
    if (!f) { seterr(j, "cannot write %s", full); j->failed++; return -1; }
    size_t w = len ? fwrite(data, 1, len, f) : 0;
    int bad = (w != len) | (fclose(f) != 0);
    if (bad || rename(part, full) != 0) {
        unlink(part);
        seterr(j, errno == ENOSPC ? "destination full while writing %s" : "write failed: %s", full);
        j->failed++;
        logline(j, full, len, "ERROR");
        return -1;
    }
    j->files++;
    j->bytes += len;
    logline(j, full, len, "OK");
    tick(j);
    return 0;
}

static void post_process_file(FmtJob *j, const char *saved, uint64_t len);
static int aif_write_pngs(FmtJob *j, const uint8_t *in, size_t n, const char *stem);
static int asf_write_glb(FmtJob *j, const uint8_t *in, size_t n, const char *glb);
static int aac_write_at9(FmtJob *j, const uint8_t *in, size_t n, const char *stem);
static int exd_write_txt(FmtJob *j, const uint8_t *in, size_t n, const char *txt);

static int write_range(FmtJob *j, const char *dir, const char *relname, int fd, uint64_t off, uint64_t len, char *saved, size_t sn)
{
    char rel[1024], full[2048], part[2100];
    safe_rel(relname, rel, sizeof(rel));
    join(full, sizeof(full), dir, rel);
    if (saved) snprintf(saved, sn, "%s", full);
    j->current = rel;
    if (prep_parent(full) != 0) { seterr(j, "cannot create folder for %s", full); j->failed++; return -1; }
    snprintf(part, sizeof(part), "%s.part", full);
    FILE *f = fopen(part, "wb");
    if (!f) { seterr(j, "cannot write %s", full); j->failed++; return -1; }
    uint8_t *buf = malloc(COPYBUF);
    int rc = buf ? 0 : -1;
    for (uint64_t done = 0; rc == 0 && done < len;) {
        size_t n = (len - done) > COPYBUF ? COPYBUF : (size_t)(len - done);
        if (rd(fd, off + done, buf, n) != 0) { seterr(j, "read error in %s", rel); rc = -1; break; }
        if (fwrite(buf, 1, n, f) != n) { seterr(j, errno == ENOSPC ? "destination full while writing %s" : "write failed: %s", full); rc = -1; break; }
        done += n;
        j->bytes += n;
        if (tick(j)) rc = -2;
    }
    free(buf);
    if (fclose(f) != 0 && rc == 0) rc = -1;
    if (rc != 0 || rename(part, full) != 0) {
        unlink(part);
        if (rc != -2) { j->failed++; logline(j, full, len, "ERROR"); }
        return rc ? rc : -1;
    }
    j->files++;
    logline(j, full, len, "OK");
    post_process_file(j, full, len);
    return 0;
}

/* File extension guessed from content. */
static const char *ext_for(const uint8_t *b, size_t n)
{
    static char tag[8];
    if (n >= 4) {
        if (!memcmp(b, "KCAP", 4)) return "kcap";
        if (!memcmp(b, "SLZ", 3)) return "slz";
        if (!memcmp(b, "DDS ", 4)) return "dds";
        if (!memcmp(b, "GNF ", 4)) return "gnf";
        if (!memcmp(b, "RIFF", 4)) return n >= 12 && !memcmp(b + 8, "WAVE", 4) ? "wav" : "riff";
        if (!memcmp(b, "OggS", 4)) return "ogg";
        if (!memcmp(b, "BKHD", 4)) return "bnk";
        if (!memcmp(b, "AKPK", 4)) return "pck";
        if (!memcmp(b, "AFS2", 4)) return "awb";
        if (!memcmp(b, "AFS\0", 4)) return "afs";
        if (!memcmp(b, "PSAR", 4)) return "psarc";
        if (!memcmp(b, "CPK ", 4)) return "cpk";
        if (!memcmp(b, "@UTF", 4)) return "utf";
        if (!memcmp(b, "\x89PNG", 4)) return "png";
        if (!memcmp(b, "\x04\x22\x4D\x18", 4)) return "lz4";
        if ((b[0] & 0x7F) == 'H' && (b[1] & 0x7F) == 'C' && (b[2] & 0x7F) == 'A' && (b[3] & 0x7F) == 0) return "hca";
        if (b[0] == 0x80 && b[1] == 0x00 && n >= 6 && b[4] >= 2 && b[4] <= 4) return "adx";
        int pr = 1;
        for (int k = 0; k < 4; k++) if (b[k] < 0x20 || b[k] > 0x7E) pr = 0;
        if (pr && b[0] == ' ') { /* tri-Ace tags are stored reversed: " ERT" = TRE */
            int o = 0;
            for (int k = 3; k >= 1; k--) {
                char c = (char)b[k];
                if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
                if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) tag[o++] = c;
            }
            tag[o] = 0;
            if (o) return tag;
        }
    }
    return "bin";
}

/* After writing an in-memory member: convert DDS to PNG; unpack containers
 * one more level (KCAP inside SLZ etc). Errors there don't fail the parent. */
static void post_process(FmtJob *j, const char *saved, const uint8_t *data, size_t len)
{
    if (j->depth >= MAXDEPTH || len < 4) return;
    if (!memcmp(data, "DDS ", 4)) {
        uint32_t w, h;
        char err[128];
        uint8_t *rgba = dds_to_rgba(data, len, &w, &h, err, sizeof(err));
        if (rgba) {
            char png[2100];
            snprintf(png, sizeof(png), "%s", saved);
            char *dot = strrchr(png, '.'), *sl = strrchr(png, '/');
            if (dot && (!sl || dot > sl)) *dot = 0;
            strncat(png, ".png", sizeof(png) - strlen(png) - 1);
            if (png_write(png, rgba, w, h) == 0) { j->files++; logline(j, png, (uint64_t)w * h * 4, "OK (converted)"); }
            free(rgba);
        } else logline(j, saved, len, "DDS not converted");
        return;
    }
    if (!memcmp(data, " FIA", 4)) {       /* tri-Ace AIF texture set -> PNG(s) */
        char stem[2100];
        snprintf(stem, sizeof(stem), "%s", saved);
        char *dot = strrchr(stem, '.'), *sl = strrchr(stem, '/');
        if (dot && (!sl || dot > sl)) *dot = 0;
        aif_write_pngs(j, data, len, stem);
        return;
    }
    if (!memcmp(data, " CAA", 4) || (len >= 4 && !memcmp(data, "EXD", 4))) {   /* sounds -> .at9, text tables -> .txt */
        char stem[2100];
        snprintf(stem, sizeof(stem), "%s", saved);
        char *dot = strrchr(stem, '.'), *sl = strrchr(stem, '/');
        if (dot && (!sl || dot > sl)) *dot = 0;
        if (data[0] == ' ') aac_write_at9(j, data, len, stem);
        else { strncat(stem, ".txt", sizeof(stem) - strlen(stem) - 1); exd_write_txt(j, data, len, stem); }
        return;
    }
    if (!memcmp(data, " FSA", 4)) {       /* tri-Ace ASF model -> glTF */
        char glb[2100];
        snprintf(glb, sizeof(glb), "%s", saved);
        char *dot = strrchr(glb, '.'), *sl = strrchr(glb, '/');
        if (dot && (!sl || dot > sl)) *dot = 0;
        strncat(glb, ".glb", sizeof(glb) - strlen(glb) - 1);
        asf_write_glb(j, data, len, glb);
        return;
    }
    if (!memcmp(data, "KCAP", 4) || !memcmp(data, "PSAR", 4) || !memcmp(data, "AKPK", 4) || !memcmp(data, "BKHD", 4) ||
        !memcmp(data, "AFS2", 4) || !memcmp(data, "AFS\0", 4) || !memcmp(data, "SLZ", 3)) {
        char sub[2100];
        snprintf(sub, sizeof(sub), "%s_unpacked", saved);
        int fd = open(saved, O_RDONLY);
        if (fd < 0) return;
        j->depth++;
        const char *b = strrchr(saved, '/');
        fmt_unpack(fd, 0, len, b ? b + 1 : saved, sub, j);
        j->depth--;
        close(fd);
    }
}

/* Same for a member that was streamed to disk. */
static void post_process_file(FmtJob *j, const char *saved, uint64_t len)
{
    if (j->depth >= MAXDEPTH || len < 4 || j->cancelled) return;
    int fd = open(saved, O_RDONLY);
    if (fd < 0) return;
    uint8_t b[4];
    if (rd(fd, 0, b, 4) == 0) {
        if ((!memcmp(b, "DDS ", 4) || !memcmp(b, " FIA", 4) || !memcmp(b, " FSA", 4) || !memcmp(b, " CAA", 4) || !memcmp(b, "EXD", 4)) && len <= MAXMEM) {
            uint8_t *d = load(fd, 0, len);
            if (d) { post_process(j, saved, d, (size_t)len); free(d); }
        } else if (!memcmp(b, "KCAP", 4) || !memcmp(b, "PSAR", 4) || !memcmp(b, "AKPK", 4) || !memcmp(b, "BKHD", 4) ||
                   !memcmp(b, "AFS2", 4) || !memcmp(b, "AFS\0", 4) || !memcmp(b, "SLZ", 3)) {
            char sub[2100];
            snprintf(sub, sizeof(sub), "%s_unpacked", saved);
            const char *nm = strrchr(saved, '/');
            j->depth++;
            int keep = j->failed;
            char e0[sizeof(j->error)];
            memcpy(e0, j->error, sizeof(e0));
            if (fmt_unpack(fd, 0, len, nm ? nm + 1 : saved, sub, j) != 0) { j->failed = keep; memcpy(j->error, e0, sizeof(e0)); }
            j->depth--;
        }
    }
    close(fd);
}

/* ------------------------------------------------------------------ */
/* tri-Ace SLZ                                                         */
/* ------------------------------------------------------------------ */
/* Header (0x20 bytes): "SLZ" mode, ?, u32 compressed size, u32 size, u32 0,
 * u32 0x20, ... Data is cut in 64 KiB chunks, each prefixed with its u16
 * compressed size (0 = stored 64 KiB). Back references reach across chunks.
 * Mode 1: LZSS, 8 flag bits (LSB first, 1 = literal byte); match = 2 bytes,
 *         distance = b0 | (b1 & 0xF) << 8, length = (b1 >> 4) + 3.
 * Mode 2: as mode 1, but length nibble 0xF means a run: low nibble != 0 ->
 *         (lo + 3) copies of b0; low nibble 0 -> (b0 + 19) copies of next byte.
 * Mode 3: 16 flag bits, literals and matches count 16-bit units, length + 2. */
static int slz_chunk(int mode, const uint8_t *s, size_t n, uint8_t *out, size_t o, size_t want)
{
    size_t i = 0, end = o + want;
    if (mode == 3) {
        if (want & 1) return -1;
        while (o < end) {
            if (i + 2 > n) return -1;
            unsigned f = le16(s + i); i += 2;
            for (int b = 0; b < 16 && o < end; b++) {
                if (i + 2 > n) return -1;
                if (f >> b & 1) { out[o] = s[i]; out[o + 1] = s[i + 1]; o += 2; i += 2; continue; }
                unsigned b0 = s[i], b1 = s[i + 1]; i += 2;
                size_t dist = (size_t)(b0 | (b1 & 0xF) << 8) * 2, len = (size_t)((b1 >> 4) + 2) * 2;
                if (!dist || dist > o || o + len > end) return -1;
                for (size_t k = 0; k < len; k++) { out[o] = out[o - dist]; o++; }
            }
        }
        return 0;
    }
    while (o < end) {
        if (i >= n) return -1;
        unsigned f = s[i++];
        for (int b = 0; b < 8 && o < end; b++) {
            if (f >> b & 1) { if (i >= n) return -1; out[o++] = s[i++]; continue; }
            if (i + 2 > n) return -1;
            unsigned b0 = s[i], b1 = s[i + 1]; i += 2;
            unsigned hi = b1 >> 4, lo = b1 & 0xF;
            if (mode == 2 && hi == 0xF) {
                size_t cnt;
                uint8_t v;
                if (lo == 0) { if (i >= n) return -1; cnt = b0 + 19u; v = s[i++]; }
                else { cnt = lo + 3u; v = (uint8_t)b0; }
                if (o + cnt > end) return -1;
                memset(out + o, v, cnt);
                o += cnt;
                continue;
            }
            size_t dist = b0 | lo << 8, len = hi + 3u;
            if (!dist || dist > o || o + len > end) return -1;
            for (size_t k = 0; k < len; k++) { out[o] = out[o - dist]; o++; }
        }
    }
    return 0;
}

uint8_t *slz_decompress(const uint8_t *in, size_t in_len, size_t *out_len, char *err, size_t errn)
{
    if (in_len < 0x20 || memcmp(in, "SLZ", 3)) { snprintf(err, errn, "not SLZ data"); return NULL; }
    int mode = in[3];
    uint32_t zs = le32(in + 8), us = le32(in + 12);
    if (mode > 3) { snprintf(err, errn, "unknown SLZ mode %d", mode); return NULL; }
    if ((uint64_t)zs + 0x20 > in_len) { snprintf(err, errn, "SLZ data is cut off"); return NULL; }
    if (us > MAXMEM) { snprintf(err, errn, "SLZ output too large"); return NULL; }
    uint8_t *out = malloc(us ? us : 1);
    if (!out) { snprintf(err, errn, "out of memory"); return NULL; }
    size_t pos = 0x20, end = 0x20 + (size_t)zs, o = 0;
    if (mode == 0) {
        if (zs < us) { free(out); snprintf(err, errn, "SLZ stored data is short"); return NULL; }
        memcpy(out, in + 0x20, us);
        *out_len = us;
        return out;
    }
    while (o < us) {
        if (pos + 2 > end) { free(out); snprintf(err, errn, "SLZ chunk table cut off"); return NULL; }
        size_t cz = le16(in + pos); pos += 2;
        size_t want = us - o > 0x10000 ? 0x10000 : us - o;
        if (cz == 0) {
            if (pos + want > end) { free(out); snprintf(err, errn, "SLZ stored chunk cut off"); return NULL; }
            memcpy(out + o, in + pos, want);
            pos += want;
        } else {
            if (pos + cz > end || slz_chunk(mode, in + pos, cz, out, o, want) != 0) {
                free(out); snprintf(err, errn, "SLZ data is corrupt"); return NULL;
            }
            pos += cz;
        }
        o += want;
    }
    *out_len = us;
    return out;
}

/* Decompress only the start of an SLZ stream: whole 64 KiB chunks until at least
 * `maxout` bytes are out (or the stream ends). in_len may cover just the first part. */
uint8_t *slz_decompress_prefix(const uint8_t *in, size_t in_len, size_t maxout, size_t *out_len, char *err, size_t errn)
{
    if (in_len < 0x20 || memcmp(in, "SLZ", 3)) { snprintf(err, errn, "not SLZ data"); return NULL; }
    int mode = in[3];
    uint32_t zs = le32(in + 8), us = le32(in + 12);
    if (mode > 3) { snprintf(err, errn, "unknown SLZ mode %d", mode); return NULL; }
    size_t lim = us < maxout ? us : maxout;
    if (lim > MAXMEM) lim = MAXMEM;
    size_t cap = lim ? ((lim + 0xFFFF) & ~(size_t)0xFFFF) : 1;
    if (cap > us && us) cap = us;
    uint8_t *out = malloc(cap ? cap : 1);
    if (!out) { snprintf(err, errn, "out of memory"); return NULL; }
    size_t end = 0x20 + (size_t)zs;
    if (end > in_len) end = in_len;
    size_t pos = 0x20, o = 0;
    if (mode == 0) {
        size_t k = end - pos < lim ? end - pos : lim;
        memcpy(out, in + pos, k);
        *out_len = k;
        return out;
    }
    while (o < lim) {
        if (pos + 2 > end) break;
        size_t cz = le16(in + pos); pos += 2;
        size_t want = us - o > 0x10000 ? 0x10000 : us - o;
        if (o + want > cap) break;
        if (cz == 0) {
            if (pos + want > end) break;
            memcpy(out + o, in + pos, want);
            pos += want;
        } else {
            if (pos + cz > end) break;
            if (slz_chunk(mode, in + pos, cz, out, o, want) != 0) { free(out); snprintf(err, errn, "SLZ data is corrupt"); return NULL; }
            pos += cz;
        }
        o += want;
    }
    if (!o) { free(out); snprintf(err, errn, "SLZ data is cut off"); return NULL; }
    *out_len = o;
    return out;
}

/* ------------------------------------------------------------------ */
/* LZ4 frames (and the legacy frame format)                            */
/* ------------------------------------------------------------------ */
static int lz4_block(const uint8_t *s, size_t n, uint8_t **out, size_t *o, size_t *cap)
{
    size_t i = 0;
    while (i < n) {
        unsigned tok = s[i++];
        size_t lit = tok >> 4;
        if (lit == 15) { unsigned c; do { if (i >= n) return -1; c = s[i++]; lit += c; } while (c == 255); }
        if (lit > n - i) return -1;
        if (*o + lit > *cap) {
            size_t nc = *cap * 2 + lit + 65536;
            if (nc > MAXMEM) return -1;
            uint8_t *t = realloc(*out, nc);
            if (!t) return -1;
            *out = t; *cap = nc;
        }
        memcpy(*out + *o, s + i, lit); *o += lit; i += lit;
        if (i >= n) break;                     /* last sequence has no match */
        if (i + 2 > n) return -1;
        size_t dist = le16(s + i); i += 2;
        size_t ml = (tok & 15) + 4u;
        if ((tok & 15) == 15) { unsigned c; do { if (i >= n) return -1; c = s[i++]; ml += c; } while (c == 255); }
        if (!dist || dist > *o) return -1;
        if (*o + ml > *cap) {
            size_t nc = *cap * 2 + ml + 65536;
            if (nc > MAXMEM) return -1;
            uint8_t *t = realloc(*out, nc);
            if (!t) return -1;
            *out = t; *cap = nc;
        }
        for (size_t k = 0; k < ml; k++) { (*out)[*o] = (*out)[*o - dist]; (*o)++; }
    }
    return 0;
}

uint8_t *lz4f_decompress(const uint8_t *in, size_t n, size_t *out_len, char *err, size_t errn)
{
    size_t cap = 1 << 20, o = 0, i;
    uint8_t *out = malloc(cap);
    if (!out) { snprintf(err, errn, "out of memory"); return NULL; }
    if (n >= 4 && le32(in) == 0x184C2102) {    /* legacy: blocks of u32 size */
        i = 4;
        while (i + 4 <= n) {
            uint32_t bs = le32(in + i);
            if (bs == 0x184C2102) { i += 4; continue; }
            i += 4;
            if (bs > n - i || lz4_block(in + i, bs, &out, &o, &cap) != 0) { free(out); snprintf(err, errn, "LZ4 data is corrupt"); return NULL; }
            i += bs;
        }
        *out_len = o;
        return out;
    }
    if (n < 7 || le32(in) != 0x184D2204) { free(out); snprintf(err, errn, "not an LZ4 frame"); return NULL; }
    unsigned flg = in[4];
    if ((flg >> 6) != 1) { free(out); snprintf(err, errn, "unsupported LZ4 frame version"); return NULL; }
    i = 6 + ((flg & 8) ? 8 : 0) + ((flg & 1) ? 4 : 0) + 1;
    int bsum = flg & 0x10 ? 4 : 0;
    while (1) {
        if (i + 4 > n) { free(out); snprintf(err, errn, "LZ4 frame cut off"); return NULL; }
        uint32_t bs = le32(in + i); i += 4;
        if (bs == 0) break;
        size_t sz = bs & 0x7FFFFFFF;
        if (sz > n - i) { free(out); snprintf(err, errn, "LZ4 block cut off"); return NULL; }
        if (bs & 0x80000000u) {
            if (o + sz > cap) {
                size_t nc = cap * 2 + sz;
                uint8_t *t = nc <= MAXMEM ? realloc(out, nc) : NULL;
                if (!t) { free(out); snprintf(err, errn, "LZ4 output too large"); return NULL; }
                out = t; cap = nc;
            }
            memcpy(out + o, in + i, sz); o += sz;
        } else if (lz4_block(in + i, sz, &out, &o, &cap) != 0) {
            free(out); snprintf(err, errn, "LZ4 data is corrupt"); return NULL;
        }
        i += sz + (size_t)bsum;
    }
    *out_len = o;
    return out;
}

/* ------------------------------------------------------------------ */
/* DDS -> RGBA                                                         */
/* ------------------------------------------------------------------ */
static void c565(unsigned c, uint8_t *p)
{
    p[0] = (uint8_t)(((c >> 11) & 31) * 255 / 31);
    p[1] = (uint8_t)(((c >> 5) & 63) * 255 / 63);
    p[2] = (uint8_t)((c & 31) * 255 / 31);
    p[3] = 255;
}

static void bc1_block(const uint8_t *s, uint8_t px[16][4], int force4)
{
    unsigned c0 = le16(s), c1 = le16(s + 2);
    uint8_t pal[4][4];
    c565(c0, pal[0]); c565(c1, pal[1]);
    if (c0 > c1 || force4) {
        for (int k = 0; k < 3; k++) { pal[2][k] = (uint8_t)((2 * pal[0][k] + pal[1][k]) / 3); pal[3][k] = (uint8_t)((pal[0][k] + 2 * pal[1][k]) / 3); }
        pal[2][3] = pal[3][3] = 255;
    } else {
        for (int k = 0; k < 3; k++) { pal[2][k] = (uint8_t)((pal[0][k] + pal[1][k]) / 2); pal[3][k] = 0; }
        pal[2][3] = 255; pal[3][3] = 0;
    }
    uint32_t idx = le32(s + 4);
    for (int p = 0; p < 16; p++) memcpy(px[p], pal[idx >> (2 * p) & 3], 4);
}

static void bc4_block(const uint8_t *s, uint8_t v[16])
{
    unsigned a0 = s[0], a1 = s[1];
    uint8_t pal[8];
    pal[0] = (uint8_t)a0; pal[1] = (uint8_t)a1;
    if (a0 > a1) for (int k = 1; k < 7; k++) pal[k + 1] = (uint8_t)(((7 - k) * a0 + k * a1) / 7);
    else { for (int k = 1; k < 5; k++) pal[k + 1] = (uint8_t)(((5 - k) * a0 + k * a1) / 5); pal[6] = 0; pal[7] = 255; }
    uint64_t bits = 0;
    for (int k = 0; k < 6; k++) bits |= (uint64_t)s[2 + k] << (8 * k);
    for (int p = 0; p < 16; p++) v[p] = pal[bits >> (3 * p) & 7];
}

static unsigned isqrt255(int v) { /* sqrt for normal map z, v in 0..65025 */
    unsigned r = 0;
    while ((r + 1) * (r + 1) <= (unsigned)v) r++;
    return r;
}

enum { DF_NONE, DF_BC1, DF_BC2, DF_BC3, DF_BC4, DF_BC5, DF_BC7, DF_RGBA8, DF_BGRA8, DF_BGRX8, DF_MASK };
static const char *df_names[] = { "?", "BC1 (DXT1)", "BC2 (DXT3)", "BC3 (DXT5)", "BC4", "BC5 (normal map)", "BC7", "RGBA8", "BGRA8", "BGRX8", "uncompressed" };
static char dds_last_fmt[48];

uint8_t *dds_to_rgba(const uint8_t *in, size_t n, uint32_t *pw, uint32_t *ph, char *err, size_t errn)
{
    if (n < 128 || memcmp(in, "DDS ", 4) || le32(in + 4) != 124) { snprintf(err, errn, "not a DDS file"); return NULL; }
    uint32_t h = le32(in + 12), w = le32(in + 16);
    uint32_t pff = le32(in + 80), four = le32(in + 84), bits = le32(in + 88);
    uint32_t mask[4] = { le32(in + 92), le32(in + 96), le32(in + 100), le32(in + 104) };
    size_t data = 128;
    int fmt = DF_NONE;
    if (pff & 4) {
        char cc[5] = { (char)in[84], (char)in[85], (char)in[86], (char)in[87], 0 };
        if (!strcmp(cc, "DXT1")) fmt = DF_BC1;
        else if (!strcmp(cc, "DXT2") || !strcmp(cc, "DXT3")) fmt = DF_BC2;
        else if (!strcmp(cc, "DXT4") || !strcmp(cc, "DXT5")) fmt = DF_BC3;
        else if (!strcmp(cc, "ATI1") || !strcmp(cc, "BC4U")) fmt = DF_BC4;
        else if (!strcmp(cc, "ATI2") || !strcmp(cc, "BC5U")) fmt = DF_BC5;
        else if (!strcmp(cc, "DX10")) {
            if (n < 148) { snprintf(err, errn, "DDS header cut off"); return NULL; }
            uint32_t dx = le32(in + 128);
            data = 148;
            if (dx >= 70 && dx <= 72) fmt = DF_BC1;
            else if (dx >= 73 && dx <= 75) fmt = DF_BC2;
            else if (dx >= 76 && dx <= 78) fmt = DF_BC3;
            else if (dx >= 79 && dx <= 81) fmt = DF_BC4;
            else if (dx >= 82 && dx <= 84) fmt = DF_BC5;
            else if (dx >= 97 && dx <= 99) fmt = DF_BC7;
            else if (dx >= 27 && dx <= 29) fmt = DF_RGBA8;
            else if (dx == 87 || dx == 90 || dx == 91) fmt = DF_BGRA8;
            else if (dx == 88 || dx == 92 || dx == 93) fmt = DF_BGRX8;
            else { snprintf(err, errn, "DDS format %u is not supported yet (BC6H planned)", dx); return NULL; }
        } else { snprintf(err, errn, "DDS FourCC %s is not supported yet", cc); return NULL; }
        (void)four;
    } else if ((pff & 0x40 || pff & 0x20000 || pff & 2) && (bits == 8 || bits == 16 || bits == 24 || bits == 32)) fmt = DF_MASK;
    else { snprintf(err, errn, "DDS pixel format not supported"); return NULL; }
    if (!w || !h || w > 16384 || h > 16384) { snprintf(err, errn, "DDS size %ux%u is not usable", w, h); return NULL; }
    if (fmt == DF_MASK) snprintf(dds_last_fmt, sizeof(dds_last_fmt), "%u-bit uncompressed", bits);
    else snprintf(dds_last_fmt, sizeof(dds_last_fmt), "%s", df_names[fmt]);
    uint64_t need;
    uint32_t bw = (w + 3) / 4, bh = (h + 3) / 4;
    switch (fmt) {
    case DF_BC1: case DF_BC4: need = (uint64_t)bw * bh * 8; break;
    case DF_BC2: case DF_BC3: case DF_BC5: case DF_BC7: need = (uint64_t)bw * bh * 16; break;
    case DF_MASK: need = (uint64_t)w * h * (bits / 8); break;
    default: need = (uint64_t)w * h * 4;
    }
    if (data + need > n) { snprintf(err, errn, "DDS pixel data is cut off"); return NULL; }
    uint8_t *o = malloc((size_t)w * h * 4);
    if (!o) { snprintf(err, errn, "out of memory"); return NULL; }
    const uint8_t *s = in + data;
    if (fmt >= DF_BC1 && fmt <= DF_BC7) {
        size_t bsz = (fmt == DF_BC1 || fmt == DF_BC4) ? 8 : 16;
        for (uint32_t by = 0; by < bh; by++)
            for (uint32_t bx = 0; bx < bw; bx++, s += bsz) {
                uint8_t px[16][4], a[16], g[16];
                switch (fmt) {
                case DF_BC1: bc1_block(s, px, 0); break;
                case DF_BC7: bc7_block(s, px); break;
                case DF_BC2: bc1_block(s + 8, px, 1); for (int p = 0; p < 16; p++) px[p][3] = (uint8_t)((s[p / 2] >> (4 * (p & 1)) & 15) * 17); break;
                case DF_BC3: bc1_block(s + 8, px, 1); bc4_block(s, a); for (int p = 0; p < 16; p++) px[p][3] = a[p]; break;
                case DF_BC4: bc4_block(s, a); for (int p = 0; p < 16; p++) { px[p][0] = px[p][1] = px[p][2] = a[p]; px[p][3] = 255; } break;
                case DF_BC5:
                    bc4_block(s, a); bc4_block(s + 8, g);
                    for (int p = 0; p < 16; p++) {
                        int x = a[p] * 2 - 255, y = g[p] * 2 - 255, zz = 65025 - x * x - y * y;
                        px[p][0] = a[p]; px[p][1] = g[p];
                        px[p][2] = (uint8_t)((isqrt255(zz < 0 ? 0 : zz) + 255) / 2); px[p][3] = 255;
                    }
                    break;
                }
                for (int p = 0; p < 16; p++) {
                    uint32_t x = bx * 4 + (p & 3), y = by * 4 + (p >> 2);
                    if (x < w && y < h) memcpy(o + ((size_t)y * w + x) * 4, px[p], 4);
                }
            }
    } else if (fmt == DF_MASK) {
        unsigned bpp = bits / 8;
        for (uint64_t p = 0; p < (uint64_t)w * h; p++) {
            uint32_t v = 0;
            for (unsigned k = 0; k < bpp; k++) v |= (uint32_t)s[p * bpp + k] << (8 * k);
            for (int c = 0; c < 4; c++) {
                uint32_t m = mask[c];
                if (!m) { o[p * 4 + c] = (uint8_t)(c == 3 ? 255 : (mask[0] && !mask[1] && !mask[2] ? o[p * 4] : 0)); continue; }
                unsigned sh = 0; while (!(m >> sh & 1)) sh++;
                uint32_t mx = m >> sh, val = (v & m) >> sh;
                o[p * 4 + c] = (uint8_t)(mx ? val * 255 / mx : 0);
            }
            if (mask[0] && !mask[1] && !mask[2]) o[p * 4 + 1] = o[p * 4 + 2] = o[p * 4]; /* luminance */
        }
    } else {
        for (uint64_t p = 0; p < (uint64_t)w * h; p++) {
            const uint8_t *q = s + p * 4;
            uint8_t *d = o + p * 4;
            if (fmt == DF_RGBA8) memcpy(d, q, 4);
            else { d[0] = q[2]; d[1] = q[1]; d[2] = q[0]; d[3] = fmt == DF_BGRX8 ? 255 : q[3]; }
        }
    }
    *pw = w; *ph = h;
    return o;
}

int png_write(const char *path, const uint8_t *rgba, uint32_t w, uint32_t h)
{
    size_t row = (size_t)w * 4 + 1, rawn = row * h;
    uint8_t *raw = malloc(rawn);
    if (!raw) return -1;
    for (uint32_t y = 0; y < h; y++) { raw[y * row] = 0; memcpy(raw + y * row + 1, rgba + (size_t)y * w * 4, (size_t)w * 4); }
    uLongf zn = compressBound((uLong)rawn);
    uint8_t *z = malloc(zn);
    if (!z || compress2(z, &zn, raw, (uLong)rawn, 6) != Z_OK) { free(raw); free(z); return -1; }
    free(raw);
    char part[2100];
    snprintf(part, sizeof(part), "%s.part", path);
    FILE *f = fopen(part, "wb");
    if (!f) { free(z); return -1; }
    static const uint8_t sig[8] = { 0x89, 'P', 'N', 'G', 13, 10, 26, 10 };
    fwrite(sig, 1, 8, f);
    uint8_t ihdr[13] = { (uint8_t)(w >> 24), (uint8_t)(w >> 16), (uint8_t)(w >> 8), (uint8_t)w,
                         (uint8_t)(h >> 24), (uint8_t)(h >> 16), (uint8_t)(h >> 8), (uint8_t)h, 8, 6, 0, 0, 0 };
    struct { const char *t; const uint8_t *d; size_t n; } ch[3] = { { "IHDR", ihdr, 13 }, { "IDAT", z, zn }, { "IEND", NULL, 0 } };
    for (int k = 0; k < 3; k++) {
        uint8_t hd[8] = { (uint8_t)(ch[k].n >> 24), (uint8_t)(ch[k].n >> 16), (uint8_t)(ch[k].n >> 8), (uint8_t)ch[k].n,
                          (uint8_t)ch[k].t[0], (uint8_t)ch[k].t[1], (uint8_t)ch[k].t[2], (uint8_t)ch[k].t[3] };
        fwrite(hd, 1, 8, f);
        if (ch[k].n) fwrite(ch[k].d, 1, ch[k].n, f);
        uLong c = crc32(0, hd + 4, 4);
        if (ch[k].n) c = crc32(c, ch[k].d, (uInt)ch[k].n);
        uint8_t cb[4] = { (uint8_t)(c >> 24), (uint8_t)(c >> 16), (uint8_t)(c >> 8), (uint8_t)c };
        fwrite(cb, 1, 4, f);
    }
    free(z);
    int bad = ferror(f);
    if (fclose(f) != 0 || bad || rename(part, path) != 0) { unlink(part); return -1; }
    return 0;
}


/* ------------------------------------------------------------------ */
/* tri-Ace AIF texture sets (Star Ocean 4 PS4)                          */
/* ------------------------------------------------------------------ */
/* Tags are 4 bytes stored reversed (" FIA" = "AIF "), chunks 16-aligned.
 * "imgX" chunk: +0x20 format, +0x28 u16 width, +0x2a u16 height,
 *   +0x30 u16 bytes per block, +0x32/+0x34 u16 width/height in blocks,
 *   +0x3c u32 data size, +0x40 16-byte id.
 * "addr" chunk: +0x10 id, +0x20 u64 size, +0x28 u64 offset into the buffer.
 * "buff" chunk: +0x10 u64 total buffer size; the buffer ends the file.
 * Pixels are PS4-tiled: 8x8-block tiles in Morton order, tiles row by row.
 * Formats seen: 0x2e = BC7 (16-byte blocks), 0x08 = 32-bit RGBA. */
typedef struct { uint32_t fmt, w, h, bpb, wb, hb; uint64_t off, size; } AifImg;
#define AIF_MAXIMG 32


static int aif_parse(const uint8_t *in, size_t n, AifImg *im, char *err, size_t en)
{
    if (n < 0x40 || memcmp(in, " FIA", 4)) { snprintf(err, en, "not an AIF texture"); return -1; }
    uint64_t total = 0;
    size_t scan = n < 0x40000 ? n : 0x40000;
    for (size_t o = 0; o + 0x18 <= scan; o += 16)
        if (!memcmp(in + o, "ffub", 4)) { total = le64(in + o + 0x10); break; }
    if (!total || total > n) { snprintf(err, en, "AIF buffer size not found"); return -1; }
    size_t base = n - (size_t)total;
    int cnt = 0;
    struct { const uint8_t *id; uint64_t size, off; } ad[AIF_MAXIMG];
    int na = 0;
    const uint8_t *ids[AIF_MAXIMG];
    for (size_t o = 0; o + 0x50 <= base; o += 16) {
        if (!memcmp(in + o, "rdda", 4) && na < AIF_MAXIMG) {
            ad[na].id = in + o + 0x10; ad[na].size = le64(in + o + 0x20); ad[na].off = le64(in + o + 0x28); na++;
        } else if (!memcmp(in + o, "Xgmi", 4) && cnt < AIF_MAXIMG) {
            AifImg *g = &im[cnt];
            g->fmt = in[o + 0x20];
            g->w = le16(in + o + 0x28); g->h = le16(in + o + 0x2a);
            g->bpb = le16(in + o + 0x30); g->wb = le16(in + o + 0x32); g->hb = le16(in + o + 0x34);
            g->size = le32(in + o + 0x3c); g->off = UINT64_MAX;
            ids[cnt++] = in + o + 0x40;
        }
    }
    if (!cnt) { snprintf(err, en, "AIF has no images"); return -1; }
    for (int i = 0; i < cnt; i++)
        for (int a = 0; a < na; a++)
            if (!memcmp(ids[i], ad[a].id, 16)) { im[i].off = base + ad[a].off; if (ad[a].size < im[i].size) im[i].size = ad[a].size; }
    return cnt;
}

/* tri-Ace AIF pixel format codes (low byte of the imgX word at +0x20). */
enum { AIF_R8 = 0x01, AIF_RGBA8 = 0x08, AIF_BC1 = 0x10, AIF_BC2 = 0x12, AIF_BC3 = 0x14, AIF_BC5 = 0x15, AIF_BC7 = 0x2e };
static const char *aif_fmt_name(uint32_t f)
{
    switch (f) {
    case AIF_R8: return "R8"; case AIF_RGBA8: return "RGBA8"; case AIF_BC1: return "BC1"; case AIF_BC2: return "BC2";
    case AIF_BC3: return "BC3"; case AIF_BC5: return "BC5"; case AIF_BC7: return "BC7"; default: return "?";
    }
}
static int aif_fmt_bpb(uint32_t f, uint32_t *px)
{
    switch (f) {
    case AIF_R8: *px = 1; return 1;
    case AIF_RGBA8: *px = 1; return 4;
    case AIF_BC1: *px = 4; return 8;
    case AIF_BC2: case AIF_BC3: case AIF_BC5: case AIF_BC7: *px = 4; return 16;
    default: return 0;
    }
}
/* Decode one PS4-tiled image whose pixel data starts at pix (n bytes available). */
uint8_t *aif_decode_pixels(const uint8_t *pix, size_t n, uint32_t fmt, uint32_t w, uint32_t h, uint32_t bpb, uint32_t wb, uint32_t hb, char *err, size_t en)
{
    uint32_t px = 1;
    int ebpb = aif_fmt_bpb(fmt, &px);
    if (!ebpb || (uint32_t)ebpb != bpb) { snprintf(err, en, "AIF pixel format 0x%02x (%u bytes/block) is not supported yet", fmt, bpb); return NULL; }
    if (!w || !h || w > 16384 || h > 16384 || wb != (w + px - 1) / px || hb != (h + px - 1) / px) {
        snprintf(err, en, "AIF image size %ux%u is not usable", w, h); return NULL;
    }
    uint32_t tx = (wb + 7) / 8, ty = (hb + 7) / 8;
    uint64_t need = (uint64_t)tx * ty * 64 * bpb;
    if (n < need) { snprintf(err, en, "AIF pixel data is cut off"); return NULL; }
    if ((uint64_t)w * h > IMG_MAXPX) { snprintf(err, en, "AIF image too large"); return NULL; }
    uint8_t *o = malloc((size_t)w * h * 4);
    if (!o) { snprintf(err, en, "out of memory"); return NULL; }
    const uint8_t *s = pix;
    for (uint32_t ty2 = 0; ty2 < ty; ty2++)
        for (uint32_t tx2 = 0; tx2 < tx; tx2++)
            for (uint32_t t = 0; t < 64; t++, s += bpb) {
                uint32_t x = 0, y = 0;
                for (int b = 0; b < 3; b++) { x |= (t >> (2 * b) & 1) << b; y |= (t >> (2 * b + 1) & 1) << b; }
                uint32_t bx = tx2 * 8 + x, by = ty2 * 8 + y;
                if (bx >= wb || by >= hb) continue;
                if (px == 1) {
                    uint8_t *d = o + ((size_t)by * w + bx) * 4;
                    if (fmt == AIF_RGBA8) memcpy(d, s, 4); else { d[0] = d[1] = d[2] = s[0]; d[3] = 255; }
                    continue;
                }
                uint8_t blk[16][4], a[16], b2[16];
                switch (fmt) {
                case AIF_BC7: bc7_block(s, blk); break;
                case AIF_BC1: bc1_block(s, blk, 0); break;
                case AIF_BC2: bc1_block(s + 8, blk, 1); for (int p = 0; p < 16; p++) blk[p][3] = (uint8_t)((s[p / 2] >> (4 * (p & 1)) & 15) * 17); break;
                case AIF_BC3: bc1_block(s + 8, blk, 1); bc4_block(s, a); for (int p = 0; p < 16; p++) blk[p][3] = a[p]; break;
                case AIF_BC5: bc4_block(s, a); bc4_block(s + 8, b2);
                    for (int p = 0; p < 16; p++) {
                        /* two-channel normal map: reconstruct z, show as tangent-space normal colour */
                        float nx = a[p] / 127.5f - 1.f, ny = b2[p] / 127.5f - 1.f, nz2 = 1.f - nx * nx - ny * ny;
                        float nz = nz2 > 0 ? sqrtf(nz2) : 0;
                        blk[p][0] = a[p]; blk[p][1] = b2[p]; blk[p][2] = (uint8_t)(nz * 127.5f + 127.5f); blk[p][3] = 255;
                    }
                    break;
                default: memset(blk, 0, sizeof blk);
                }
                for (int p = 0; p < 16; p++) {
                    uint32_t X = bx * 4 + (p & 3), Y = by * 4 + (p >> 2);
                    if (X < w && Y < h) memcpy(o + ((size_t)Y * w + X) * 4, blk[p], 4);
                }
            }
    return o;
}

static uint8_t *aif_decode(const uint8_t *in, size_t n, const AifImg *g, char *err, size_t en)
{
    if (g->off == UINT64_MAX || g->off > n) { snprintf(err, en, "AIF pixel data is cut off"); return NULL; }
    size_t avail = n - (size_t)g->off;
    if (g->size < avail) avail = (size_t)g->size;
    return aif_decode_pixels(in + g->off, avail, g->fmt, g->w, g->h, g->bpb, g->wb, g->hb, err, en);
}

int aif_count(const uint8_t *in, size_t n)
{
    AifImg im[AIF_MAXIMG];
    char err[8];
    return aif_parse(in, n, im, err, sizeof(err));
}

uint8_t *aif_to_rgba(const uint8_t *in, size_t n, int index, uint32_t *w, uint32_t *h, char *desc, size_t dn, char *err, size_t en)
{
    AifImg im[AIF_MAXIMG];
    int cnt = aif_parse(in, n, im, err, en);
    if (cnt < 0) return NULL;
    if (index < 0 || index >= cnt) { snprintf(err, en, "AIF has %d images", cnt); return NULL; }
    uint8_t *r = aif_decode(in, n, &im[index], err, en);
    if (!r) return NULL;
    *w = im[index].w; *h = im[index].h;
    if (desc) snprintf(desc, dn, "tri-Ace AIF %s %ux%u (image %d of %d)", aif_fmt_name(im[index].fmt), *w, *h, index + 1, cnt);
    return r;
}

/* Write every image of an AIF held in memory as PNG next to `stem`
 * (stem.png, stem_1.png, ...). Returns images written, -1 if none. */
static int aif_write_pngs(FmtJob *j, const uint8_t *in, size_t n, const char *stem)
{
    int cnt = aif_count(in, n), ok = 0;
    if (cnt <= 0) { logline(j, stem, n, "AIF not converted (header not understood)"); return -1; }
    for (int i = 0; i < cnt && !j->cancelled; i++) {
        uint32_t w, h;
        char err[128], png[2100];
        uint8_t *rgba = aif_to_rgba(in, n, i, &w, &h, NULL, 0, err, sizeof(err));
        if (i) snprintf(png, sizeof(png), "%s_%d.png", stem, i); else snprintf(png, sizeof(png), "%s.png", stem);
        if (!rgba) { logline(j, png, 0, err); continue; }
        if (png_write(png, rgba, w, h) == 0) { j->files++; j->bytes += (uint64_t)w * h * 4; ok++; logline(j, png, (uint64_t)w * h * 4, "OK (converted)"); }
        else { j->failed++; logline(j, png, 0, "cannot write"); }
        free(rgba);
        if (j->cb && j->cb(j->user)) j->cancelled = 1;
    }
    return ok ? ok : -1;
}

/* Every ATRAC9 sound of an AAC bank as stem.at9 (one sound) or stem_N.at9. Returns files written. */
static int aac_write_at9(FmtJob *j, const uint8_t *in, size_t n, const char *stem)
{
    static AacSound snd[1024];
    int cnt = aac_sounds(in, n, snd, 1024), ok = 0, unsup = 0;
    if (cnt <= 0) { logline(j, stem, n, "AAC: no sounds found"); return 0; }
    if (cnt > 1024) cnt = 1024;
    snprintf(j->kind, sizeof(j->kind), "tri-Ace AAC sound bank, %d sound%s", cnt, cnt == 1 ? "" : "s");
    for (int i = 0; i < cnt && !j->cancelled; i++) {
        char path[2200];
        if (cnt == 1) snprintf(path, sizeof(path), "%s.at9", stem); else snprintf(path, sizeof(path), "%s_%d.at9", stem, i);
        if (!snd[i].supported) { unsup++; logline(j, path, 0, "sound uses a codec that is not converted yet"); continue; }
        size_t on = 0;
        uint8_t *a = aac_make_at9(in, n, &snd[i], &on);
        if (!a) { j->failed++; logline(j, path, 0, "out of memory"); continue; }
        char part[2300];
        snprintf(part, sizeof(part), "%s.part", path);
        FILE *f = fopen(part, "wb");
        int bad = !f || fwrite(a, 1, on, f) != on;
        if (f) bad |= fclose(f) != 0;
        free(a);
        if (bad || rename(part, path) != 0) { unlink(part); j->failed++; logline(j, path, 0, "cannot write"); continue; }
        char res[160];
        snprintf(res, sizeof(res), "OK (ATRAC9 %u ch, %.1f s%s)", snd[i].channels, snd[i].rate ? (double)snd[i].samples / snd[i].rate : 0.0,
                 snd[i].loop_len ? ", loops" : "");
        j->files++; j->bytes += on; ok++;
        logline(j, path, on, res);
        tick(j);
    }
    return ok;
}

typedef struct { FILE *f; int n; } ExdCtx;
static void exd_cb(size_t off, const char *utf8, void *u) { ExdCtx *c = u; fprintf(c->f, "%06zx\t%s\n", off, utf8); c->n++; }

/* UTF-16 strings of an EXD table as UTF-8 text (offset <TAB> string). 0 ok, -1 failed. */
static int exd_write_txt(FmtJob *j, const uint8_t *in, size_t n, const char *txt)
{
    int k = u16_strings(in, n, NULL, NULL);
    if (!k) { logline(j, txt, 0, "EXD: no text (a data-only table)"); return 0; }
    char part[2300];
    snprintf(part, sizeof(part), "%s.part", txt);
    FILE *f = fopen(part, "wb");
    if (!f) { j->failed++; logline(j, txt, 0, "cannot write"); return -1; }
    static const uint8_t bom[3] = { 0xEF, 0xBB, 0xBF };
    fwrite(bom, 1, 3, f);
    fprintf(f, "# offset\ttext (UTF-16 strings found in this EXD table)\n");
    ExdCtx c = { f, 0 };
    u16_strings(in, n, exd_cb, &c);
    int bad = ferror(f);
    if (fclose(f) != 0 || bad || rename(part, txt) != 0) { unlink(part); j->failed++; logline(j, txt, 0, "cannot write"); return -1; }
    struct stat st;
    uint64_t sz = stat(txt, &st) == 0 ? (uint64_t)st.st_size : 0;
    char res[80];
    snprintf(res, sizeof(res), "OK (%d strings)", c.n);
    j->files++; j->bytes += sz;
    logline(j, txt, sz, res);
    snprintf(j->kind, sizeof(j->kind), "tri-Ace EXD table, %d strings", c.n);
    return 0;
}

/* Convert an ASF model held in memory to `glb` (full path). 0 ok, -1 failed (logged). */
static int asf_write_glb(FmtJob *j, const uint8_t *in, size_t n, const char *glb)
{
    AsfStats st; char err[256];
    j->current = glb;
    if (asf_to_glb(in, n, glb, &st, err, sizeof err) != 0) { j->failed++; logline(j, glb, 0, err); snprintf(j->error, sizeof(j->error), "%s", err); return -1; }
    j->files++; j->bytes += st.bytes;
    char res[200];
    snprintf(res, sizeof res, "OK (glTF: %u mesh%s, %llu triangles, %u texture%s%s)", st.meshes, st.meshes == 1 ? "" : "es",
             (unsigned long long)st.triangles, st.textures, st.textures == 1 ? "" : "s", st.skipped ? ", some meshes skipped" : "");
    logline(j, glb, st.bytes, res);
    snprintf(j->kind, sizeof(j->kind), "tri-Ace ASF model, %u mesh%s", st.meshes, st.meshes == 1 ? "" : "es");
    tick(j);
    return 0;
}

/* ------------------------------------------------------------------ */
/* images for the viewer: PNG, BMP, TGA (+ DDS above)                  */
/* ------------------------------------------------------------------ */

int img_is_image(const uint8_t *b, size_t n)
{
    if (n >= 4 && (!memcmp(b, "DDS ", 4) || !memcmp(b, "\x89PNG", 4) || !memcmp(b, " FIA", 4))) return 1;
    if (n >= 2 && b[0] == 'B' && b[1] == 'M') return 1;
    return 0;
}

static int paeth(int a, int b, int c)
{
    int p = a + b - c, pa = abs(p - a), pb = abs(p - b), pc = abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

static uint8_t *png_decode(const uint8_t *in, size_t n, uint32_t *pw, uint32_t *ph, char *desc, size_t dn, char *err, size_t en)
{
    if (n < 33 || memcmp(in, "\x89PNG\r\n\x1a\n", 8)) { snprintf(err, en, "not a PNG file"); return NULL; }
    uint32_t w = 0, h = 0;
    int depth = 0, ct = -1, il = 0;
    uint8_t pal[256][4];
    int npal = 0;
    int trns_g = -1, trns_r = -1, trns_gg = -1, trns_b = -1;
    for (int k = 0; k < 256; k++) { pal[k][0] = pal[k][1] = pal[k][2] = 0; pal[k][3] = 255; }
    uint8_t *z = NULL;
    size_t zn = 0, zc = 0, p = 8;
    while (p + 12 <= n) {
        uint32_t len = be32(in + p);
        const uint8_t *t = in + p + 4, *d = in + p + 8;
        if ((uint64_t)len + 12 > n - p) break;
        if (!memcmp(t, "IHDR", 4) && len >= 13) {
            w = be32(d); h = be32(d + 4); depth = d[8]; ct = d[9]; il = d[12];
            if (d[10] || d[11]) { free(z); snprintf(err, en, "unknown PNG compression"); return NULL; }
        } else if (!memcmp(t, "PLTE", 4)) {
            npal = (int)(len / 3 > 256 ? 256 : len / 3);
            for (int k = 0; k < npal; k++) { pal[k][0] = d[3 * k]; pal[k][1] = d[3 * k + 1]; pal[k][2] = d[3 * k + 2]; }
        } else if (!memcmp(t, "tRNS", 4)) {
            if (ct == 3) for (uint32_t k = 0; k < len && k < 256; k++) pal[k][3] = d[k];
            else if (ct == 0 && len >= 2) trns_g = (d[0] << 8) | d[1];
            else if (ct == 2 && len >= 6) { trns_r = (d[0] << 8) | d[1]; trns_gg = (d[2] << 8) | d[3]; trns_b = (d[4] << 8) | d[5]; }
        } else if (!memcmp(t, "IDAT", 4)) {
            if (zn + len > zc) {
                size_t nc = (zn + len) * 2;
                if (nc > MAXMEM) { free(z); snprintf(err, en, "PNG too large"); return NULL; }
                uint8_t *nz = realloc(z, nc);
                if (!nz) { free(z); snprintf(err, en, "out of memory"); return NULL; }
                z = nz; zc = nc;
            }
            if (len) { memcpy(z + zn, d, len); zn += len; }
        } else if (!memcmp(t, "IEND", 4)) break;
        p += 12 + (size_t)len;
    }
    int ch = ct == 0 ? 1 : ct == 2 ? 3 : ct == 3 ? 1 : ct == 4 ? 2 : ct == 6 ? 4 : 0;
    int okd = (ct == 0 && (depth == 1 || depth == 2 || depth == 4 || depth == 8 || depth == 16)) ||
              (ct == 3 && (depth == 1 || depth == 2 || depth == 4 || depth == 8)) ||
              ((ct == 2 || ct == 4 || ct == 6) && (depth == 8 || depth == 16));
    if (!ch || !okd || !w || !h || il > 1 || !z) { free(z); snprintf(err, en, "unsupported or damaged PNG"); return NULL; }
    if ((uint64_t)w * h > IMG_MAXPX) { free(z); snprintf(err, en, "image is too large to show (%ux%u)", w, h); return NULL; }
    int bpp_bits = ch * depth, bpp = (bpp_bits + 7) / 8;
    /* raw size for all passes */
    static const int ax[7] = { 0, 4, 0, 2, 0, 1, 0 }, ay[7] = { 0, 0, 4, 0, 2, 0, 1 }, dx[7] = { 8, 8, 4, 4, 2, 2, 1 }, dy[7] = { 8, 8, 8, 4, 4, 2, 2 };
    int passes = il ? 7 : 1;
    uint64_t rawn = 0;
    for (int ps = 0; ps < passes; ps++) {
        uint32_t pw2 = il ? (w + dx[ps] - 1 - ax[ps]) / dx[ps] : w, ph2 = il ? (h + dy[ps] - 1 - ay[ps]) / dy[ps] : h;
        if (w <= (uint32_t)ax[ps]) pw2 = 0;
        if (h <= (uint32_t)ay[ps]) ph2 = 0;
        if (pw2 && ph2) rawn += (uint64_t)ph2 * (1 + ((uint64_t)pw2 * bpp_bits + 7) / 8);
    }
    if (rawn > MAXMEM) { free(z); snprintf(err, en, "PNG too large"); return NULL; }
    uint8_t *raw = malloc((size_t)rawn + 1), *o = malloc((size_t)w * h * 4);
    uLongf rl = (uLongf)rawn;
    if (!raw || !o || uncompress(raw, &rl, z, (uLong)zn) != Z_OK || rl != rawn) {
        free(z); free(raw); free(o); snprintf(err, en, "PNG image data is damaged"); return NULL;
    }
    free(z);
    uint8_t *q = raw;
    for (int ps = 0; ps < passes; ps++) {
        uint32_t pw2 = il ? (w + dx[ps] - 1 - ax[ps]) / dx[ps] : w, ph2 = il ? (h + dy[ps] - 1 - ay[ps]) / dy[ps] : h;
        if (w <= (uint32_t)ax[ps]) pw2 = 0;
        if (h <= (uint32_t)ay[ps]) ph2 = 0;
        if (!pw2 || !ph2) continue;
        size_t stride = ((size_t)pw2 * bpp_bits + 7) / 8;
        uint8_t *prev = NULL;
        for (uint32_t y = 0; y < ph2; y++) {
            int f = *q++;
            uint8_t *row = q;
            for (size_t i = 0; i < stride; i++) {
                int a = i >= (size_t)bpp ? row[i - bpp] : 0, b = prev ? prev[i] : 0, c = (prev && i >= (size_t)bpp) ? prev[i - bpp] : 0;
                int v = row[i];
                switch (f) {
                case 0: break;
                case 1: v += a; break;
                case 2: v += b; break;
                case 3: v += (a + b) / 2; break;
                case 4: v += paeth(a, b, c); break;
                default: free(raw); free(o); snprintf(err, en, "PNG filter %d is invalid", f); return NULL;
                }
                row[i] = (uint8_t)v;
            }
            for (uint32_t x = 0; x < pw2; x++) {
                int s[4];
                for (int c = 0; c < ch; c++) {
                    if (depth == 16) s[c] = row[(x * ch + c) * 2];
                    else if (depth == 8) s[c] = row[x * ch + c];
                    else {
                        size_t bit = (size_t)x * depth;
                        int v = row[bit / 8] >> (8 - depth - (int)(bit % 8)) & ((1 << depth) - 1);
                        s[c] = ct == 3 ? v : v * 255 / ((1 << depth) - 1);
                    }
                }
                uint32_t X = il ? ax[ps] + x * dx[ps] : x, Y = il ? ay[ps] + y * dy[ps] : y;
                uint8_t *d = o + ((size_t)Y * w + X) * 4;
                int raw16 = depth == 16 ? (row[(x * ch) * 2] << 8 | row[(x * ch) * 2 + 1]) : -1;
                switch (ct) {
                case 0: d[0] = d[1] = d[2] = (uint8_t)s[0]; d[3] = (trns_g >= 0 && (depth == 16 ? raw16 : (depth == 8 ? s[0] : s[0] * ((1 << depth) - 1) / 255)) == trns_g) ? 0 : 255; break;
                case 2: d[0] = (uint8_t)s[0]; d[1] = (uint8_t)s[1]; d[2] = (uint8_t)s[2];
                    d[3] = (trns_r >= 0 && depth == 8 && s[0] == trns_r && s[1] == trns_gg && s[2] == trns_b) ? 0 : 255; break;
                case 3: memcpy(d, pal[s[0] & 255], 4); break;
                case 4: d[0] = d[1] = d[2] = (uint8_t)s[0]; d[3] = (uint8_t)s[1]; break;
                default: d[0] = (uint8_t)s[0]; d[1] = (uint8_t)s[1]; d[2] = (uint8_t)s[2]; d[3] = (uint8_t)s[3];
                }
            }
            prev = row;
            q += stride;
        }
    }
    free(raw);
    static const char *ctn[] = { "grey", "?", "RGB", "palette", "grey+alpha", "?", "RGBA" };
    snprintf(desc, dn, "PNG %s %d-bit%s", ctn[ct], depth, il ? " interlaced" : "");
    *pw = w; *ph = h;
    return o;
}

static uint8_t *bmp_decode(const uint8_t *in, size_t n, uint32_t *pw, uint32_t *ph, char *desc, size_t dn, char *err, size_t en)
{
    if (n < 54 || in[0] != 'B' || in[1] != 'M') { snprintf(err, en, "not a BMP file"); return NULL; }
    uint32_t off = le32(in + 10), hs = le32(in + 14);
    int32_t w = (int32_t)le32(in + 18), h = (int32_t)le32(in + 22);
    unsigned bits = le16(in + 28), comp = le32(in + 30), ncol = le32(in + 46);
    int flip = h > 0;
    if (h < 0) h = -h;
    if (w <= 0 || h <= 0 || (uint64_t)w * h > IMG_MAXPX || (comp != 0 && comp != 3) || (bits != 8 && bits != 24 && bits != 32)) {
        snprintf(err, en, "unsupported BMP (%u-bit, compression %u)", bits, comp); return NULL;
    }
    size_t stride = (((size_t)w * bits + 31) / 32) * 4;
    if ((uint64_t)off + stride * h > n) { snprintf(err, en, "BMP pixel data is cut off"); return NULL; }
    const uint8_t *pal = in + 14 + hs;
    if (bits == 8 && (!ncol || ncol > 256)) ncol = 256;
    if (bits == 8 && (size_t)(pal - in) + ncol * 4 > n) { snprintf(err, en, "BMP palette is cut off"); return NULL; }
    uint32_t mask[4] = { 0xFF0000, 0xFF00, 0xFF, 0 };
    if (comp == 3 && hs >= 40 && n >= 54 + 12) { mask[0] = le32(in + 54); mask[1] = le32(in + 58); mask[2] = le32(in + 62); if (hs >= 56) mask[3] = le32(in + 66); }
    uint8_t *o = malloc((size_t)w * h * 4);
    if (!o) { snprintf(err, en, "out of memory"); return NULL; }
    int any_alpha = 0;
    for (int y = 0; y < h; y++) {
        const uint8_t *r = in + off + stride * (size_t)(flip ? h - 1 - y : y);
        for (int x = 0; x < w; x++) {
            uint8_t *d = o + ((size_t)y * w + x) * 4;
            if (bits == 8) { const uint8_t *c = pal + r[x] * 4; d[0] = c[2]; d[1] = c[1]; d[2] = c[0]; d[3] = 255; }
            else if (bits == 24) { d[0] = r[x * 3 + 2]; d[1] = r[x * 3 + 1]; d[2] = r[x * 3]; d[3] = 255; }
            else {
                uint32_t v = le32(r + x * 4);
                for (int c = 0; c < 4; c++) {
                    uint32_t m = c < 3 ? mask[c] : (comp == 3 ? mask[3] : 0); /* BI_RGB: 4th byte is unused */
                    if (!m) { d[c] = 255; continue; }
                    unsigned sh = 0; while (!(m >> sh & 1)) sh++;
                    uint32_t mx = m >> sh;
                    d[c] = (uint8_t)(((v & m) >> sh) * 255 / mx);
                }
                if (d[3]) any_alpha = 1;
            }
        }
    }
    if (bits == 32 && !any_alpha) for (size_t k = 0; k < (size_t)w * h; k++) o[k * 4 + 3] = 255; /* alpha unused */
    snprintf(desc, dn, "BMP %u-bit", bits);
    *pw = (uint32_t)w; *ph = (uint32_t)h;
    return o;
}

static uint8_t *tga_decode(const uint8_t *in, size_t n, uint32_t *pw, uint32_t *ph, char *desc, size_t dn, char *err, size_t en)
{
    if (n < 18) { snprintf(err, en, "not a TGA file"); return NULL; }
    unsigned idl = in[0], cmt = in[1], it = in[2], cmf = le16(in + 3), cml = le16(in + 5), cmb = in[7];
    unsigned w = le16(in + 12), h = le16(in + 14), bits = in[16], dsc = in[17];
    int rle = it >= 9, base = it & 7;
    if (!w || !h || (uint64_t)w * h > IMG_MAXPX || (base != 1 && base != 2 && base != 3) ||
        (base == 2 && bits != 24 && bits != 32 && bits != 16) || (base == 3 && bits != 8) || (base == 1 && (bits != 8 || cmt != 1))) {
        snprintf(err, en, "unsupported TGA"); return NULL;
    }
    size_t p = 18 + idl;
    const uint8_t *cmap = in + p;
    unsigned cbytes = (cmb + 7) / 8;
    if (cmt == 1) { if (cmb != 24 && cmb != 32) { snprintf(err, en, "unsupported TGA palette"); return NULL; } p += (size_t)cml * cbytes; }
    if (p > n) { snprintf(err, en, "TGA is cut off"); return NULL; }
    unsigned pbytes = (bits + 7) / 8;
    uint8_t *o = malloc((size_t)w * h * 4);
    if (!o) { snprintf(err, en, "out of memory"); return NULL; }
    size_t total = (size_t)w * h, k = 0;
    while (k < total) {
        unsigned count = 1, raw = 1;
        if (rle) {
            if (p >= n) break;
            unsigned c = in[p++];
            count = (c & 0x7F) + 1;
            raw = !(c & 0x80);
        }
        for (unsigned i = 0; i < count && k < total; i++, k++) {
            if (raw || i == 0) { if (p + pbytes > n) { free(o); snprintf(err, en, "TGA pixel data is cut off"); return NULL; } }
            const uint8_t *s = in + p;
            uint8_t px[4];
            if (base == 3) { px[0] = px[1] = px[2] = s[0]; px[3] = 255; }
            else if (base == 1) {
                unsigned idx = s[0] - (s[0] >= cmf ? cmf : 0);
                if (idx >= cml) idx = 0;
                const uint8_t *c = cmap + idx * cbytes;
                px[0] = c[2]; px[1] = c[1]; px[2] = c[0]; px[3] = cbytes == 4 ? c[3] : 255;
            } else if (bits == 16) {
                unsigned v = le16(s);
                px[0] = (uint8_t)((v >> 10 & 31) * 255 / 31); px[1] = (uint8_t)((v >> 5 & 31) * 255 / 31); px[2] = (uint8_t)((v & 31) * 255 / 31); px[3] = 255;
            } else { px[0] = s[2]; px[1] = s[1]; px[2] = s[0]; px[3] = bits == 32 ? s[3] : 255; }
            size_t x = k % w, y = k / w;
            if (!(dsc & 0x20)) y = h - 1 - y;       /* bottom-up unless the top-left bit is set */
            if (dsc & 0x10) x = w - 1 - x;
            memcpy(o + (y * w + x) * 4, px, 4);
            if (raw) p += pbytes;
        }
        if (!raw) p += pbytes;
    }
    if (k < total) { free(o); snprintf(err, en, "TGA pixel data is cut off"); return NULL; }
    snprintf(desc, dn, "TGA %s %u-bit%s", base == 1 ? "palette" : base == 3 ? "grey" : "true-colour", bits, rle ? " RLE" : "");
    *pw = w; *ph = h;
    return o;
}

uint8_t *img_decode(const uint8_t *in, size_t n, uint32_t *w, uint32_t *h, char *desc, size_t dn, char *err, size_t en)
{
    snprintf(desc, dn, "image");
    if (n >= 4 && !memcmp(in, "DDS ", 4)) {
        uint8_t *r = dds_to_rgba(in, n, w, h, err, en);
        if (r) snprintf(desc, dn, "DDS %s", dds_last_fmt);
        return r;
    }
    if (n >= 4 && !memcmp(in, " FIA", 4)) return aif_to_rgba(in, n, 0, w, h, desc, dn, err, en);
    if (n >= 8 && !memcmp(in, "\x89PNG", 4)) return png_decode(in, n, w, h, desc, dn, err, en);
    if (n >= 2 && in[0] == 'B' && in[1] == 'M') return bmp_decode(in, n, w, h, desc, dn, err, en);
    /* TGA has no magic: accept only with a plausible header */
    if (n >= 18 && (in[1] <= 1) && ((in[2] & 7) >= 1 && (in[2] & 7) <= 3) && (in[2] & ~0xB) == 0 && le16(in + 12) && le16(in + 14) &&
        (in[16] == 8 || in[16] == 16 || in[16] == 24 || in[16] == 32))
        return tga_decode(in, n, w, h, desc, dn, err, en);
    snprintf(err, en, "not an image this viewer can show");
    return NULL;
}

/* ------------------------------------------------------------------ */
/* container readers                                                   */
/* ------------------------------------------------------------------ */
static int un_kcap(int fd, uint64_t off, uint64_t len, const char *out, FmtJob *j)
{
    uint8_t h[16];
    if (len < 16 || rd(fd, off, h, 16) != 0) { seterr(j, "KCAP header cut off%s", ""); return -1; }
    uint32_t cnt = le32(h + 8), psize = le32(h + 12);
    if (psize > len) psize = (uint32_t)(len > 0xFFFFFFFFu ? 0xFFFFFFFFu : len);
    if (cnt > 100000 || 16 + (uint64_t)cnt * 16 > psize) { seterr(j, "KCAP table is corrupt%s", ""); return -1; }
    uint8_t *p = load(fd, off, psize);
    if (!p) { seterr(j, "KCAP pack too large or unreadable%s", ""); return -1; }
    snprintf(j->kind, sizeof(j->kind), "tri-Ace KCAP pack, %u files", cnt);
    for (uint32_t i = 0; i < cnt && !j->cancelled; i++) {
        const uint8_t *e = p + 16 + 16 * i;
        uint32_t size = le32(e + 8), eo = le32(e + 12);
        char name[64], saved[2100], err[128] = "";
        if (eo > psize) { j->failed++; seterr(j, "KCAP member %s starts outside the pack", ""); continue; }
        const uint8_t *d = p + eo;
        size_t avail = psize - eo;
        if (avail >= 0x20 && !memcmp(d, "SLZ", 3)) {
            size_t ol = 0;
            uint8_t *u = slz_decompress(d, avail, &ol, err, sizeof(err));
            if (!u) {
                snprintf(name, sizeof(name), "%03u.slz", i);
                j->failed++;
                seterr(j, "SLZ member could not be unpacked (%s)", err);
                size_t zl = 0x20 + (size_t)le32(d + 8);
                write_buf(j, out, name, d, zl < avail ? zl : avail, saved, sizeof(saved)); /* keep raw */
                continue;
            }
            snprintf(name, sizeof(name), "%03u.%s", i, ext_for(u, ol));
            if (write_buf(j, out, name, u, ol, saved, sizeof(saved)) == 0) post_process(j, saved, u, ol);
            free(u);
        } else {
            size_t n = size < avail ? size : avail;
            snprintf(name, sizeof(name), "%03u.%s", i, ext_for(d, n));
            if (write_buf(j, out, name, d, n, saved, sizeof(saved)) == 0) post_process(j, saved, d, n);
        }
    }
    free(p);
    return 0;
}

static int un_mem(int fd, uint64_t off, uint64_t len, const char *hint, const char *out, FmtJob *j, int lz4)
{
    if (len > MAXMEM) { seterr(j, "file too large to decompress in memory%s", ""); return -1; }
    uint8_t *in = load(fd, off, len);
    if (!in) { seterr(j, "cannot read the file%s", ""); return -1; }
    char err[128] = "", name[300], saved[2100];
    size_t ol = 0;
    uint8_t *u = lz4 ? lz4f_decompress(in, (size_t)len, &ol, err, sizeof(err)) : slz_decompress(in, (size_t)len, &ol, err, sizeof(err));
    free(in);
    if (!u) { seterr(j, "%s", err); return -1; }
    snprintf(j->kind, sizeof(j->kind), lz4 ? "LZ4 compressed" : "tri-Ace SLZ compressed");
    snprintf(name, sizeof(name), "%s.%s", hint, ext_for(u, ol));
    int rc = write_buf(j, out, name, u, ol, saved, sizeof(saved));
    if (rc == 0) post_process(j, saved, u, ol);
    free(u);
    return rc;
}

static int un_dds(int fd, uint64_t off, uint64_t len, const char *hint, const char *out, FmtJob *j)
{
    if (len > MAXMEM) { seterr(j, "texture too large%s", ""); return -1; }
    uint8_t *in = load(fd, off, len);
    if (!in) { seterr(j, "cannot read the file%s", ""); return -1; }
    uint32_t w, h;
    char err[128];
    uint8_t *rgba = dds_to_rgba(in, (size_t)len, &w, &h, err, sizeof(err));
    free(in);
    if (!rgba) { seterr(j, "%s", err); return -1; }
    snprintf(j->kind, sizeof(j->kind), "DDS texture %ux%u", w, h);
    char full[2100];
    snprintf(full, sizeof(full), "%s/%s.png", out, hint);
    int rc = mkdirs(out) == 0 && png_write(full, rgba, w, h) == 0 ? 0 : -1;
    free(rgba);
    if (rc) { seterr(j, "cannot write %s", full); j->failed++; return -1; }
    j->files++;
    j->bytes += (uint64_t)w * h * 4;
    logline(j, full, (uint64_t)w * h * 4, "OK (converted)");
    return 0;
}

/* PSARC: big-endian header, TOC (MD5, block index, 40-bit size, 40-bit
 * offset), block size table, entry 0 = manifest of names. */
static int un_psarc(int fd, uint64_t off, uint64_t len, const char *out, FmtJob *j)
{
    uint8_t h[32];
    if (len < 32 || rd(fd, off, h, 32) != 0) { seterr(j, "PSARC header cut off%s", ""); return -1; }
    char comp[5] = { (char)h[8], (char)h[9], (char)h[10], (char)h[11], 0 };
    uint32_t toclen = be32(h + 12), esz = be32(h + 16), cnt = be32(h + 20), bsz = be32(h + 24), flags = be32(h + 28);
    if (flags & 4) { seterr(j, "this PSARC has an encrypted file table%s", ""); return -1; }
    if (strcmp(comp, "zlib") && strcmp(comp, "lzma")) { seterr(j, "unknown PSARC compression %s", comp); return -1; }
    if (esz < 30 || !cnt || cnt > 1000000 || !bsz || bsz > (64u << 20) || toclen > len || toclen < 32 + (uint64_t)cnt * esz) {
        seterr(j, "PSARC table is corrupt%s", ""); return -1;
    }
    uint8_t *toc = load(fd, off, toclen);
    if (!toc) { seterr(j, "cannot read the PSARC table%s", ""); return -1; }
    int zb = bsz <= 0x10000 ? 2 : bsz <= 0x1000000 ? 3 : 4;
    const uint8_t *zt = toc + 32 + (size_t)cnt * esz;
    uint32_t nz = (uint32_t)((toclen - 32 - (uint64_t)cnt * esz) / (uint32_t)zb);
    uint8_t *blk = malloc(bsz), *dec = malloc(bsz);
    char **names = calloc(cnt, sizeof(char *));
    char *manifest = NULL;
    int rc = 0;
    snprintf(j->kind, sizeof(j->kind), "PSARC archive (%s), %u files", comp, cnt - 1);
    if (!blk || !dec || !names) { seterr(j, "out of memory%s", ""); rc = -1; goto done; }
    for (uint32_t e = 0; e < cnt && !j->cancelled; e++) {
        const uint8_t *t = toc + 32 + (size_t)e * esz;
        uint32_t bi = be32(t + 16);
        uint64_t us = beN(t + 20, 5), eo = beN(t + 25, 5);
        char rel[1024], full[2100], part[2200];
        FILE *f = NULL;
        size_t mlen = 0;
        if (e == 0) {
            if (us > (16u << 20)) { seterr(j, "PSARC manifest too large%s", ""); rc = -1; goto done; }
            manifest = malloc((size_t)us + 1);
            if (!manifest) { rc = -1; goto done; }
        } else {
            const char *nm = names[e];
            char fallback[32];
            if (!nm) { snprintf(fallback, sizeof(fallback), "file_%05u.bin", e); nm = fallback; }
            safe_rel(nm, rel, sizeof(rel));
            join(full, sizeof(full), out, rel);
            j->current = rel;
            snprintf(part, sizeof(part), "%s.part", full);
            if (prep_parent(full) != 0 || !(f = fopen(part, "wb"))) { seterr(j, "cannot write %s", full); j->failed++; continue; }
        }
        uint64_t left = us, pos = off + eo;
        int bad = 0;
        while (left && !bad) {
            size_t want = left > bsz ? bsz : (size_t)left;
            if (bi >= nz) { bad = 1; break; }
            uint32_t zs = (uint32_t)beN(zt + (size_t)bi * zb, zb);
            if (zs == 0) zs = bsz;
            if (pos + zs > off + len) { bad = 1; break; }
            if (rd(fd, pos, blk, zs) != 0) { bad = 1; break; }
            const uint8_t *src = blk;
            size_t got = want;
            if (zs == want) src = blk;                         /* stored */
            else if (!strcmp(comp, "zlib") && blk[0] == 0x78) {
                uLongf dl = (uLongf)want;
                if (uncompress(dec, &dl, blk, zs) != Z_OK || dl != want) bad = 1;
                src = dec;
            } else if (!strcmp(comp, "lzma")) {
                lzma_stream s = LZMA_STREAM_INIT;
                if (lzma_alone_decoder(&s, UINT64_MAX) != LZMA_OK) { bad = 1; break; }
                s.next_in = blk; s.avail_in = zs; s.next_out = dec; s.avail_out = want;
                lzma_ret r = lzma_code(&s, LZMA_FINISH);
                if ((r != LZMA_OK && r != LZMA_STREAM_END) || s.avail_out) bad = 1;
                lzma_end(&s);
                src = dec;
            } else bad = 1;
            if (bad) break;
            if (e == 0) { memcpy(manifest + mlen, src, got); mlen += got; }
            else if (fwrite(src, 1, got, f) != got) { bad = 2; break; }
            left -= got; pos += zs; bi++;
            if (e) { j->bytes += got; if (tick(j)) bad = 3; }
        }
        if (e == 0) {
            if (bad) { seterr(j, "PSARC file name list is unreadable%s", ""); rc = -1; goto done; }
            manifest[mlen] = 0;
            char *s = manifest;
            for (uint32_t k = 1; k < cnt && s && *s; k++) {
                char *nl = strchr(s, '\n');
                if (nl) *nl = 0;
                names[k] = s;
                s = nl ? nl + 1 : NULL;
            }
            continue;
        }
        int closebad = fclose(f) != 0;
        if (bad || closebad || rename(part, full) != 0) {
            unlink(part);
            if (bad == 3) break;
            j->failed++;
            seterr(j, bad == 2 ? "destination full while writing %s" : "could not unpack %s", rel);
            logline(j, full, us, "ERROR");
        } else { j->files++; logline(j, full, us, "OK"); }
    }
done:
    free(blk); free(dec); free(names); free(manifest); free(toc);
    return j->cancelled ? -2 : rc;
}

/* Wwise file package (.pck). */
static int un_akpk(int fd, uint64_t off, uint64_t len, const char *out, FmtJob *j)
{
    uint8_t h[28];
    if (len < 28 || rd(fd, off, h, 28) != 0) { seterr(j, "Wwise package header cut off%s", ""); return -1; }
    uint32_t hs = le32(h + 4), L = le32(h + 12), B = le32(h + 16), S = le32(h + 20), E = le32(h + 24);
    int ext = 0;
    if ((uint64_t)hs == 4 + 16 + (uint64_t)L + B + S + E) ext = 1;
    else if ((uint64_t)hs != 4 + 12 + (uint64_t)L + B + S) { seterr(j, "Wwise package header sizes don't add up%s", ""); return -1; }
    if ((uint64_t)hs + 8 > len || hs > (64u << 20)) { seterr(j, "Wwise package table is corrupt%s", ""); return -1; }
    uint8_t *t = load(fd, off, (uint64_t)hs + 8);
    if (!t) { seterr(j, "cannot read the package table%s", ""); return -1; }
    size_t p = 8 + 4 + (ext ? 16 : 12) + L;
    struct { const char *dir, *ext; uint32_t size; int idsz; } sec[3] = { { "banks", "bnk", B, 4 }, { "sounds", "wem", S, 4 }, { "externals", "wem", ext ? E : 0, 8 } };
    uint32_t total = 0;
    for (int s = 0; s < 3 && !j->cancelled; s++) {
        size_t base = p;
        p += sec[s].size;
        if (sec[s].size < 4) continue;
        uint32_t n = le32(t + base);
        size_t es = (size_t)sec[s].idsz + 16;
        if ((uint64_t)n * es + 4 > sec[s].size) { j->failed++; seterr(j, "Wwise package %s table is corrupt", sec[s].dir); continue; }
        for (uint32_t i = 0; i < n && !j->cancelled; i++) {
            const uint8_t *e = t + base + 4 + (size_t)i * es;
            uint64_t id = sec[s].idsz == 8 ? le64(e) : le32(e);
            const uint8_t *q = e + sec[s].idsz;
            uint32_t align = le32(q), size = le32(q + 4), start = le32(q + 8), lang = le32(q + 12);
            uint64_t eo = (uint64_t)start * (align ? align : 1);
            char name[96];
            if (lang) snprintf(name, sizeof(name), "%s/lang%u/%llu.%s", sec[s].dir, lang, (unsigned long long)id, sec[s].ext);
            else snprintf(name, sizeof(name), "%s/%llu.%s", sec[s].dir, (unsigned long long)id, sec[s].ext);
            if (eo + size > len) { j->failed++; seterr(j, "a Wwise package entry lies outside the file%s", ""); continue; }
            write_range(j, out, name, fd, off + eo, size, NULL, 0);
            total++;
        }
    }
    snprintf(j->kind, sizeof(j->kind), "Wwise package (.pck), %u entries", total);
    free(t);
    return j->cancelled ? -2 : 0;
}

/* Wwise sound bank (.bnk): DIDX lists (id, offset, size) inside DATA. */
static int un_bkhd(int fd, uint64_t off, uint64_t len, const char *out, FmtJob *j)
{
    uint64_t p = 0, didx = 0, didx_n = 0, data = 0, data_n = 0;
    uint32_t bank = 0;
    while (p + 8 <= len) {
        uint8_t c[12];
        if (rd(fd, off + p, c, 8) != 0) break;
        uint32_t cs = le32(c + 4);
        if (!memcmp(c, "BKHD", 4) && cs >= 8 && rd(fd, off + p + 8, c + 8, 4) == 0) bank = le32(c + 8);
        if (!memcmp(c, "DIDX", 4)) { didx = p + 8; didx_n = cs; }
        if (!memcmp(c, "DATA", 4)) { data = p + 8; data_n = cs; }
        p += 8 + (uint64_t)cs;
    }
    (void)bank;
    if (!didx || !data || didx_n % 12 || didx + didx_n > len || data + data_n > len) {
        snprintf(j->kind, sizeof(j->kind), "Wwise sound bank (no embedded sounds)");
        seterr(j, "this sound bank has no embedded sounds (they live in a .pck or loose .wem files)%s", "");
        return -1;
    }
    uint8_t *ix = load(fd, off + didx, didx_n);
    if (!ix) { seterr(j, "cannot read the bank index%s", ""); return -1; }
    uint32_t n = (uint32_t)(didx_n / 12);
    snprintf(j->kind, sizeof(j->kind), "Wwise sound bank, %u sounds", n);
    for (uint32_t i = 0; i < n && !j->cancelled; i++) {
        uint32_t id = le32(ix + 12 * i), eo = le32(ix + 12 * i + 4), sz = le32(ix + 12 * i + 8);
        char name[48];
        snprintf(name, sizeof(name), "%u.wem", id);
        if ((uint64_t)eo + sz > data_n) { j->failed++; seterr(j, "a sound lies outside the bank data%s", ""); continue; }
        write_range(j, out, name, fd, off + data + eo, sz, NULL, 0);
    }
    free(ix);
    return j->cancelled ? -2 : 0;
}

static void sniff_ext(int fd, uint64_t off, uint64_t n, char *ext, size_t en)
{
    uint8_t b[16] = { 0 };
    size_t k = n < 16 ? (size_t)n : 16;
    if (k && rd(fd, off, b, k) == 0) snprintf(ext, en, "%s", ext_for(b, k));
    else snprintf(ext, en, "bin");
}

/* CRI AFS: "AFS\0", count, (offset, size) pairs, optional name table. */
static int un_afs(int fd, uint64_t off, uint64_t len, const char *out, FmtJob *j)
{
    uint8_t h[8];
    if (len < 8 || rd(fd, off, h, 8) != 0) return -1;
    uint32_t n = le32(h + 4);
    if (!n || n > 1000000 || 8 + (uint64_t)n * 8 + 8 > len) { seterr(j, "AFS table is corrupt%s", ""); return -1; }
    uint8_t *t = load(fd, off + 8, (uint64_t)n * 8 + 8);
    if (!t) { seterr(j, "cannot read the AFS table%s", ""); return -1; }
    uint32_t nto = le32(t + (size_t)n * 8), nts = le32(t + (size_t)n * 8 + 4);
    uint8_t *nt = NULL;
    if (nto && (uint64_t)nto + nts <= len && nts >= (uint64_t)n * 0x30 && nts < (64u << 20)) nt = load(fd, off + nto, nts);
    snprintf(j->kind, sizeof(j->kind), "CRI AFS archive, %u files", n);
    for (uint32_t i = 0; i < n && !j->cancelled; i++) {
        uint32_t eo = le32(t + 8 * i), sz = le32(t + 8 * i + 4);
        char name[96], ext[16];
        if (!eo && !sz) continue;
        if ((uint64_t)eo + sz > len) { j->failed++; seterr(j, "an AFS entry lies outside the file%s", ""); continue; }
        if (nt && nt[i * 0x30]) {
            char nm[33];
            memcpy(nm, nt + i * 0x30, 32); nm[32] = 0;
            snprintf(name, sizeof(name), "%05u_%s", i, nm);
        } else {
            sniff_ext(fd, off + eo, sz, ext, sizeof(ext));
            snprintf(name, sizeof(name), "%05u.%s", i, ext);
        }
        write_range(j, out, name, fd, off + eo, sz, NULL, 0);
    }
    free(nt); free(t);
    return j->cancelled ? -2 : 0;
}

/* CRI AFS2 (.awb): ids and offsets tables; entries aligned. */
static int un_afs2(int fd, uint64_t off, uint64_t len, const char *out, FmtJob *j)
{
    uint8_t h[16];
    if (len < 16 || rd(fd, off, h, 16) != 0) return -1;
    unsigned osz = h[5], isz = le16(h + 6);
    uint32_t n = le32(h + 8), al = le16(h + 12);
    if (!n || n > 1000000 || (osz != 2 && osz != 4 && osz != 8) || (isz != 2 && isz != 4)) { seterr(j, "AWB header is corrupt%s", ""); return -1; }
    uint64_t tl = (uint64_t)n * isz + (uint64_t)(n + 1) * osz;
    if (16 + tl > len) { seterr(j, "AWB table is corrupt%s", ""); return -1; }
    uint8_t *t = load(fd, off + 16, tl);
    if (!t) return -1;
    snprintf(j->kind, sizeof(j->kind), "CRI AWB audio bank, %u sounds", n);
    const uint8_t *ot = t + (size_t)n * isz;
    for (uint32_t i = 0; i < n && !j->cancelled; i++) {
        uint32_t id = isz == 2 ? le16(t + i * 2) : le32(t + i * 4);
        uint64_t a = osz == 2 ? le16(ot + i * 2) : osz == 4 ? le32(ot + i * 4) : le64(ot + i * 8);
        uint64_t b = osz == 2 ? le16(ot + (i + 1) * 2) : osz == 4 ? le32(ot + (i + 1) * 4) : le64(ot + (i + 1) * 8);
        if (al > 1 && a % al) a += al - a % al;
        if (b < a || b > len) { j->failed++; seterr(j, "an AWB entry lies outside the file%s", ""); continue; }
        char name[48], ext[16];
        sniff_ext(fd, off + a, b - a, ext, sizeof(ext));
        snprintf(name, sizeof(name), "%05u.%s", id, ext);
        write_range(j, out, name, fd, off + a, b - a, NULL, 0);
    }
    free(t);
    return j->cancelled ? -2 : 0;
}

/* ------------------------------------------------------------------ */
/* front door                                                          */
/* ------------------------------------------------------------------ */
int fmt_identify(int fd, uint64_t off, uint64_t len, char *desc, size_t n)
{
    uint8_t b[32] = { 0 };
    size_t k = len < 32 ? (size_t)len : 32;
    snprintf(desc, n, "unknown");
    if (k < 4 || rd(fd, off, b, k) != 0) return 0;
    if (!memcmp(b, "KCAP", 4)) { snprintf(desc, n, "tri-Ace KCAP pack (%u files)", k >= 12 ? le32(b + 8) : 0); return 1; }
    if (!memcmp(b, "SLZ", 3)) { snprintf(desc, n, "tri-Ace SLZ compressed (mode %u)", b[3]); return 1; }
    if (!memcmp(b, "PSAR", 4)) { snprintf(desc, n, "PSARC archive"); return 1; }
    if (!memcmp(b, "AKPK", 4)) { snprintf(desc, n, "Wwise audio package (.pck)"); return 1; }
    if (!memcmp(b, "BKHD", 4)) { snprintf(desc, n, "Wwise sound bank (.bnk)"); return 1; }
    if (!memcmp(b, "AFS2", 4)) { snprintf(desc, n, "CRI AWB audio bank"); return 1; }
    if (!memcmp(b, "AFS\0", 4)) { snprintf(desc, n, "CRI AFS archive"); return 1; }
    if (le32(b) == 0x184D2204 || le32(b) == 0x184C2102) { snprintf(desc, n, "LZ4 compressed"); return 1; }
    if (!memcmp(b, "DDS ", 4)) { snprintf(desc, n, "DDS texture (-> PNG)"); return 1; }
    if (!memcmp(b, " FIA", 4)) { snprintf(desc, n, "tri-Ace AIF texture (-> PNG)"); return 1; }
    if (!memcmp(b, " FSA", 4)) { snprintf(desc, n, "tri-Ace ASF model (-> glTF .glb)"); return 1; }
    if (!memcmp(b, " CAA", 4)) { snprintf(desc, n, "tri-Ace AAC sound bank (ATRAC9 -> .at9)"); return 1; }
    if (!memcmp(b, "EXD", 4)) { snprintf(desc, n, "tri-Ace EXD table (text -> .txt)"); return 1; }
    if (!memcmp(b, "CPK ", 4)) snprintf(desc, n, "CRI CPK archive (open it with Archive tools)");
    else if (!memcmp(b, "GNF ", 4)) snprintf(desc, n, "PS4 GNF texture (conversion planned)");
    else snprintf(desc, n, "unknown (%02X %02X %02X %02X)", b[0], b[1], b[2], b[3]);
    return 0;
}

int fmt_unpack(int fd, uint64_t off, uint64_t len, const char *hint, const char *out, FmtJob *j)
{
    uint8_t b[16] = { 0 };
    size_t k = len < 16 ? (size_t)len : 16;
    if (k < 4 || rd(fd, off, b, k) != 0) return 1;
    char stem[256];
    snprintf(stem, sizeof(stem), "%s", hint && *hint ? hint : "file");
    char *dot = strrchr(stem, '.');
    if (dot && dot != stem) *dot = 0;
    if (mkdirs(out) != 0) { seterr(j, "cannot create %s", out); return -1; }
    int rc;
    if (!memcmp(b, "KCAP", 4)) rc = un_kcap(fd, off, len, out, j);
    else if (!memcmp(b, "SLZ", 3)) rc = un_mem(fd, off, len, stem, out, j, 0);
    else if (le32(b) == 0x184D2204 || le32(b) == 0x184C2102) rc = un_mem(fd, off, len, stem, out, j, 1);
    else if (!memcmp(b, "PSAR", 4)) rc = un_psarc(fd, off, len, out, j);
    else if (!memcmp(b, "AKPK", 4)) rc = un_akpk(fd, off, len, out, j);
    else if (!memcmp(b, "BKHD", 4)) rc = un_bkhd(fd, off, len, out, j);
    else if (!memcmp(b, "AFS2", 4)) rc = un_afs2(fd, off, len, out, j);
    else if (!memcmp(b, "AFS\0", 4)) rc = un_afs(fd, off, len, out, j);
    else if (!memcmp(b, "DDS ", 4)) rc = un_dds(fd, off, len, stem, out, j);
    else if (!memcmp(b, " FIA", 4)) {
        if (len > MAXMEM) { seterr(j, "texture too large%s", ""); return -1; }
        uint8_t *in = load(fd, off, len);
        if (!in) { seterr(j, "cannot read the file%s", ""); return -1; }
        char full[2100];
        snprintf(full, sizeof(full), "%s/%s", out, stem);
        int cnt = aif_count(in, (size_t)len);
        snprintf(j->kind, sizeof(j->kind), "tri-Ace AIF texture set, %d image%s", cnt, cnt == 1 ? "" : "s");
        rc = aif_write_pngs(j, in, (size_t)len, full) > 0 ? 0 : -1;
        if (rc) seterr(j, "AIF could not be converted (see the log)%s", "");
        free(in);
    }
    else if (!memcmp(b, " CAA", 4) || !memcmp(b, "EXD", 4)) {
        if (len > MAXMEM) { seterr(j, "file too large%s", ""); return -1; }
        uint8_t *in = load(fd, off, len);
        if (!in) { seterr(j, "cannot read the file%s", ""); return -1; }
        char full[2100];
        if (b[0] == ' ') {
            snprintf(full, sizeof(full), "%s/%s", out, stem);
            rc = aac_write_at9(j, in, (size_t)len, full) > 0 ? 0 : -1;
        } else {
            snprintf(full, sizeof(full), "%s/%s.txt", out, stem);
            rc = exd_write_txt(j, in, (size_t)len, full);
        }
        if (rc && !j->error[0]) seterr(j, "nothing could be converted (see the log)%s", "");
        free(in);
    }
    else if (!memcmp(b, " FSA", 4)) {
        if (len > MAXMEM) { seterr(j, "model too large%s", ""); return -1; }
        uint8_t *in = load(fd, off, len);
        if (!in) { seterr(j, "cannot read the file%s", ""); return -1; }
        char full[2100];
        snprintf(full, sizeof(full), "%s/%s.glb", out, stem);
        rc = asf_write_glb(j, in, (size_t)len, full);
        if (rc) seterr(j, "ASF could not be converted: %s", j->error[0] ? j->error : "see the log");
        free(in);
    }
    else return 1;
    if (j->cancelled) return -2;
    return rc;
}

int fmt_unpack_path(const char *path, const char *out, FmtJob *j)
{
    int fd = open(path, O_RDONLY);
    if (fd < 0) { seterr(j, "cannot open %s", path); return -1; }
    off_t end = lseek(fd, 0, SEEK_END);
    if (end < 0) { close(fd); seterr(j, "cannot read %s", path); return -1; }
    const char *b = strrchr(path, '/');
    int rc = fmt_unpack(fd, 0, (uint64_t)end, b ? b + 1 : path, out, j);
    close(fd);
    return rc;
}
