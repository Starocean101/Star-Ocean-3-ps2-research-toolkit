/* cpk.c - read-only CRI CPK archive reader / extractor.
 * Format notes follow the public CRI CPK / @UTF documentation (hcs utf_tab,
 * CriPakTools): @UTF fields are big-endian, the packet headers little-endian. */
#include "cpk.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

#define CHUNK        (8u << 20)          /* streaming copies: 8 MiB */
#define MAX_TABLE    (256u << 20)        /* sanity limit for a @UTF table */
#define MAX_INMEM    (320u << 20)        /* CRILAYLA members are decompressed in memory */

/* ------------------------------------------------------------------ */
/* small IO helpers                                                   */
/* ------------------------------------------------------------------ */
static uint32_t rd32le(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }

static int read_at(int fd, uint64_t off, void *buf, size_t len)
{
    uint8_t *p = buf;
    if (lseek(fd, (off_t)off, SEEK_SET) == (off_t)-1) return -1;
    while (len) {
        ssize_t r = read(fd, p, len);
        if (r < 0) { if (errno == EINTR) continue; return -1; }
        if (r == 0) return -1; /* short file */
        p += r;
        len -= (size_t)r;
    }
    return 0;
}

static int write_all(int fd, const void *buf, size_t len)
{
    const uint8_t *p = buf;
    while (len) {
        ssize_t w = write(fd, p, len);
        if (w < 0) { if (errno == EINTR) continue; return -1; }
        p += w;
        len -= (size_t)w;
    }
    return 0;
}

static uint32_t be32(const uint8_t *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }
static uint16_t be16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static uint64_t be64(const uint8_t *p) { return ((uint64_t)be32(p) << 32) | be32(p + 4); }
static uint32_t le32(const uint8_t *p) { return p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
static uint64_t le64(const uint8_t *p) { return le32(p) | ((uint64_t)le32(p + 4) << 32); }

static int mkdirs(const char *path)
{
    char tmp[2048];
    snprintf(tmp, sizeof(tmp), "%s", path);
    for (char *p = tmp + 1; *p; p++)
        if (*p == '/') { *p = 0; if (mkdir(tmp, 0777) != 0 && errno != EEXIST) return -1; *p = '/'; }
    if (mkdir(tmp, 0777) != 0 && errno != EEXIST) return -1;
    return 0;
}

void cpk_stem(const char *path, char *out, size_t n)
{
    const char *b = strrchr(path, '/');
    snprintf(out, n, "%s", b ? b + 1 : path);
    char *dot = strrchr(out, '.');
    if (dot && dot != out) *dot = 0;
}

/* ------------------------------------------------------------------ */
/* @UTF tables                                                        */
/* ------------------------------------------------------------------ */
enum { ST_MASK = 0xF0, ST_ZERO = 0x10, ST_CONST = 0x30, ST_ROW = 0x50 };
enum { T_U8, T_S8, T_U16, T_S16, T_U32, T_S32, T_U64, T_S64, T_F32, T_F64, T_STR, T_DATA };

#define UTF_MAXCOL 64
typedef struct {
    const uint8_t *t;      /* table start ("@UTF") */
    uint32_t len;          /* bytes available from t */
    uint32_t rows, strs, data;  /* absolute offsets from t */
    uint16_t ncol, rowlen;
    uint32_t nrows;
    struct { uint8_t flags; const char *name; uint32_t cpos; uint32_t rpos; } col[UTF_MAXCOL];
} Utf;

typedef struct { int present; uint64_t u; double f; const char *s; uint32_t doff, dlen; int type; } UVal;

static int type_size(int t)
{
    switch (t) {
    case T_U8: case T_S8: return 1;
    case T_U16: case T_S16: return 2;
    case T_U32: case T_S32: case T_F32: case T_STR: return 4;
    case T_U64: case T_S64: case T_F64: case T_DATA: return 8;
    default: return -1;
    }
}

static void utf_deobfuscate(uint8_t *b, uint32_t n)
{
    uint32_t m = 0x0000655F, t = 0x00004115;
    for (uint32_t i = 0; i < n; i++) { b[i] ^= (uint8_t)(m & 0xFF); m *= t; }
}

static const char *utf_str(const Utf *u, uint32_t off)
{
    uint64_t p = (uint64_t)u->strs + off;
    if (p >= u->len) return "";
    const char *s = (const char *)u->t + p;
    if (!memchr(s, 0, u->len - p)) return ""; /* unterminated */
    return s;
}

/* Parse a table in buf (decrypting in place if needed). 0 on success. */
static int utf_parse(Utf *u, uint8_t *buf, uint32_t len)
{
    memset(u, 0, sizeof(*u));
    if (len < 0x20) return -1;
    if (memcmp(buf, "@UTF", 4) != 0) {
        utf_deobfuscate(buf, len);
        if (memcmp(buf, "@UTF", 4) != 0) return -1;
    }
    uint32_t tsize = be32(buf + 4);
    if ((uint64_t)tsize + 8 < len) len = tsize + 8;
    u->t = buf;
    u->len = len;
    u->rows = be32(buf + 8) + 8;
    u->strs = be32(buf + 12) + 8;
    u->data = be32(buf + 16) + 8;
    u->ncol = be16(buf + 24);
    u->rowlen = be16(buf + 26);
    u->nrows = be32(buf + 28);
    if (u->ncol > UTF_MAXCOL || u->rows > len || u->strs > len || u->data > len) return -1;
    if ((uint64_t)u->rows + (uint64_t)u->rowlen * u->nrows > len) return -1;

    uint32_t pos = 0x20, rpos = 0;
    for (int i = 0; i < u->ncol; i++) {
        if (pos + 5 > len) return -1;
        uint8_t fl = buf[pos];
        if (fl == 0) { pos += 3; if (pos + 5 > len) return -1; fl = buf[pos]; } /* padded descriptor quirk */
        u->col[i].flags = fl;
        u->col[i].name = utf_str(u, be32(buf + pos + 1));
        pos += 5;
        int ts = type_size(fl & 0x0F);
        if (ts < 0) return -1;
        if ((fl & ST_MASK) == ST_CONST) { u->col[i].cpos = pos; pos += (uint32_t)ts; if (pos > len) return -1; }
        if ((fl & ST_MASK) == ST_ROW) { u->col[i].rpos = rpos; rpos += (uint32_t)ts; }
    }
    if (rpos > u->rowlen) return -1;
    return 0;
}

static int utf_col(const Utf *u, const char *name)
{
    for (int i = 0; i < u->ncol; i++)
        if (!strcmp(u->col[i].name, name)) return i;
    return -1;
}

static UVal utf_get(const Utf *u, uint32_t row, int ci)
{
    UVal v;
    memset(&v, 0, sizeof(v));
    v.s = "";
    if (ci < 0 || row >= u->nrows) return v;
    uint8_t fl = u->col[ci].flags;
    int type = fl & 0x0F, st = fl & ST_MASK;
    v.type = type;
    const uint8_t *p;
    if (st == ST_CONST) p = u->t + u->col[ci].cpos;
    else if (st == ST_ROW) p = u->t + u->rows + (uint64_t)row * u->rowlen + u->col[ci].rpos;
    else return v; /* zero / none */
    v.present = 1;
    switch (type) {
    case T_U8: case T_S8: v.u = p[0]; break;
    case T_U16: case T_S16: v.u = be16(p); break;
    case T_U32: case T_S32: v.u = be32(p); break;
    case T_U64: case T_S64: v.u = be64(p); break;
    case T_F32: { uint32_t b = be32(p); float f; memcpy(&f, &b, 4); v.f = f; v.u = (uint64_t)f; break; }
    case T_F64: { uint64_t b = be64(p); double d; memcpy(&d, &b, 8); v.f = d; v.u = (uint64_t)d; break; }
    case T_STR: v.s = utf_str(u, be32(p)); break;
    case T_DATA: v.doff = be32(p); v.dlen = be32(p + 4);
        if ((uint64_t)u->data + v.doff + v.dlen > u->len) { v.present = 0; v.dlen = 0; }
        break;
    }
    return v;
}

static uint64_t utf_u64(const Utf *u, uint32_t row, const char *name)
{
    UVal v = utf_get(u, row, utf_col(u, name));
    return v.present ? v.u : 0;
}

/* Read a "TOC "/"ITOC"/"CPK " packet at off: 16-byte header, then the table. */
static uint8_t *read_packet(Cpk *c, uint64_t off, const char *magic, uint32_t *len_out)
{
    uint8_t h[16];
    if ((off == 0 && memcmp(magic, "CPK ", 4) != 0) || off + 16 > c->file_size || read_at(c->fd, off, h, 16) != 0) return NULL;
    if (memcmp(h, magic, 4) != 0) { snprintf(c->error, sizeof(c->error), "%.4s table missing at 0x%llx", magic, (unsigned long long)off); return NULL; }
    uint64_t sz = le64(h + 8);
    if (sz < 0x20 || sz > MAX_TABLE || off + 16 + sz > c->file_size) { snprintf(c->error, sizeof(c->error), "%.4s table size invalid", magic); return NULL; }
    uint8_t *b = malloc((size_t)sz);
    if (!b) { snprintf(c->error, sizeof(c->error), "out of memory for %.4s", magic); return NULL; }
    if (read_at(c->fd, off + 16, b, (size_t)sz) != 0) { free(b); snprintf(c->error, sizeof(c->error), "read error in %.4s", magic); return NULL; }
    *len_out = (uint32_t)sz;
    return b;
}

static int cmp_id(const void *a, const void *b)
{
    const CpkEntry *x = a, *y = b;
    return x->id < y->id ? -1 : x->id > y->id;
}

static int load_itoc(Cpk *c)
{
    uint32_t len;
    uint8_t *b = read_packet(c, c->itoc_off, "ITOC", &len);
    if (!b) return -1;
    Utf u;
    if (utf_parse(&u, b, len) != 0) { free(b); snprintf(c->error, sizeof(c->error), "ITOC table unreadable"); return -1; }
    /* DataL (16-bit sizes) and DataH (32-bit sizes) are embedded @UTF tables */
    const char *parts[2] = { "DataL", "DataH" };
    Utf sub[2];
    int have[2] = { 0, 0 };
    uint32_t total = 0;
    for (int k = 0; k < 2; k++) {
        UVal v = utf_get(&u, 0, utf_col(&u, parts[k]));
        if (v.present && v.dlen >= 0x20 && utf_parse(&sub[k], (uint8_t *)u.t + u.data + v.doff, v.dlen) == 0) {
            have[k] = 1;
            total += sub[k].nrows;
        }
    }
    if (!total) { free(b); snprintf(c->error, sizeof(c->error), "ITOC lists no files"); return -1; }
    c->e = calloc(total, sizeof(CpkEntry));
    if (!c->e) { free(b); return -1; }
    uint32_t n = 0;
    for (int k = 0; k < 2; k++) {
        if (!have[k]) continue;
        int cid = utf_col(&sub[k], "ID"), cfs = utf_col(&sub[k], "FileSize"), cxs = utf_col(&sub[k], "ExtractSize");
        for (uint32_t r = 0; r < sub[k].nrows; r++) {
            CpkEntry *e = &c->e[n++];
            e->id = (uint32_t)utf_get(&sub[k], r, cid).u;
            e->size = utf_get(&sub[k], r, cfs).u;
            UVal xv = utf_get(&sub[k], r, cxs);
            e->xsize = xv.present ? xv.u : e->size;
            e->dir = e->name = "";
        }
    }
    qsort(c->e, n, sizeof(CpkEntry), cmp_id);
    uint64_t off = c->content_off, al = c->align ? c->align : 1;
    for (uint32_t i = 0; i < n; i++) {
        c->e[i].offset = off;
        off += c->e[i].size;
        if (off % al) off += al - off % al;
    }
    c->n = n;
    c->toc_buf = b;
    return 0;
}

static int load_toc(Cpk *c)
{
    uint32_t len;
    uint8_t *b = read_packet(c, c->toc_off, "TOC ", &len);
    if (!b) return -1;
    Utf u;
    if (utf_parse(&u, b, len) != 0) { free(b); snprintf(c->error, sizeof(c->error), "TOC table unreadable"); return -1; }
    if (!u.nrows) { free(b); snprintf(c->error, sizeof(c->error), "TOC lists no files"); return -1; }
    c->e = calloc(u.nrows, sizeof(CpkEntry));
    if (!c->e) { free(b); return -1; }
    int cdir = utf_col(&u, "DirName"), cname = utf_col(&u, "FileName"), cfs = utf_col(&u, "FileSize"),
        cxs = utf_col(&u, "ExtractSize"), coff = utf_col(&u, "FileOffset"), cid = utf_col(&u, "ID");
    uint64_t base = c->toc_off;
    if (c->content_off && c->content_off < base) base = c->content_off;
    for (uint32_t r = 0; r < u.nrows; r++) {
        CpkEntry *e = &c->e[r];
        e->dir = utf_get(&u, r, cdir).s;
        e->name = utf_get(&u, r, cname).s;
        e->size = utf_get(&u, r, cfs).u;
        UVal xv = utf_get(&u, r, cxs);
        e->xsize = xv.present ? xv.u : e->size;
        e->offset = utf_get(&u, r, coff).u + base;
        UVal iv = utf_get(&u, r, cid);
        e->id = iv.present ? (uint32_t)iv.u : r;
    }
    c->n = u.nrows;
    c->toc_buf = b;
    return 0;
}

/* ------------------------------------------------------------------ */
/* Star Ocean 4 (tri-Ace) archives: 0000.bin + 0001.bin                */
/* ------------------------------------------------------------------ */
/* 0000.bin begins with a file index of 0x6C header bytes + 65,527 entries of
 * 12 bytes (u32 sectors, u32 bytes, u32 start), XOR-scrambled with a key that
 * repeats every 192 bytes from offset 0. Unused entries are all zero, so the
 * key is the most common byte at each of the 192 positions; the result must
 * pass the header and per-entry checks below or the file is rejected.
 * start bit 28 selects 0001.bin; (start & 0x0FFFFFFF) * 2048 is the offset. */
#define SO4_INDEX_LEN   0xC0000u
#define SO4_ENTRIES     65527u
#define SO4_KEYLEN      192u
#define SO4_SECTOR      2048u

static int so4_arch_of(const char *path)
{
    const char *b = strrchr(path, '/');
    b = b ? b + 1 : path;
    if (!strcasecmp(b, "0000.bin")) return 0;
    if (!strcasecmp(b, "0001.bin")) return 1;
    return -1;
}

static void so4_index_path(const char *path, char *out, size_t n)
{
    const char *b = strrchr(path, '/');
    if (b) snprintf(out, n, "%.*s/0000.bin", (int)(b - path), path);
    else snprintf(out, n, "0000.bin");
}

/* Reads and unscrambles the index. Returns malloc'd plain index or NULL. */
static uint8_t *so4_read_index(const char *index_path, uint64_t *size0, char *err, size_t errn, uint8_t *key_out)
{
    int fd = open(index_path, O_RDONLY);
    if (fd < 0) { snprintf(err, errn, "cannot open %s: %s", index_path, strerror(errno)); return NULL; }
    off_t end = lseek(fd, 0, SEEK_END);
    if (end < (off_t)SO4_INDEX_LEN) { close(fd); snprintf(err, errn, "0000.bin is too small for an index"); return NULL; }
    if (size0) *size0 = (uint64_t)end;
    uint8_t *b = malloc(SO4_INDEX_LEN);
    if (!b) { close(fd); snprintf(err, errn, "out of memory"); return NULL; }
    if (read_at(fd, 0, b, SO4_INDEX_LEN) != 0) { free(b); close(fd); snprintf(err, errn, "cannot read the index"); return NULL; }
    close(fd);
    uint8_t key[SO4_KEYLEN];
    static uint32_t cnt[SO4_KEYLEN][256];
    memset(cnt, 0, sizeof(cnt));
    for (uint32_t i = 0; i < SO4_INDEX_LEN; i++) cnt[i % SO4_KEYLEN][b[i]]++;
    for (uint32_t j = 0; j < SO4_KEYLEN; j++) {
        uint32_t best = 0;
        for (uint32_t v = 1; v < 256; v++) if (cnt[j][v] > cnt[j][best]) best = v;
        key[j] = (uint8_t)best;
    }
    for (uint32_t i = 0; i < SO4_INDEX_LEN; i++) b[i] ^= key[i % SO4_KEYLEN];
    if (key_out) memcpy(key_out, key, SO4_KEYLEN);
    if (rd32le(b + 0x18) != 0x1E998 || rd32le(b + 0x1C) != 0x0F4CC000 || rd32le(b + 0x2C) != 0x1EB98) {
        free(b);
        snprintf(err, errn, "not a Star Ocean 4 index (header check failed)");
        return NULL;
    }
    uint32_t used = 0;
    for (uint32_t k = 0; k < SO4_ENTRIES; k++) {
        const uint8_t *q = b + 0x6C + 12 * k;
        uint32_t sec = rd32le(q), bytes = rd32le(q + 4);
        if (!bytes) continue;
        used++;
        if ((uint64_t)sec * SO4_SECTOR < bytes || (uint64_t)(sec - 1) * SO4_SECTOR >= bytes) {
            free(b);
            snprintf(err, errn, "index entry %u is inconsistent - index not decoded correctly", k);
            return NULL;
        }
    }
    if (!used) { free(b); snprintf(err, errn, "index has no files"); return NULL; }
    return b;
}

static int so4_load(Cpk *c)
{
    int arch = so4_arch_of(c->path);
    if (arch < 0) return 1;
    char ip[1024], err[200] = "";
    so4_index_path(c->path, ip, sizeof(ip));
    uint8_t *ix = so4_read_index(ip, NULL, err, sizeof(err), c->so4_key);
    if (!ix) { snprintf(c->error, sizeof(c->error), "Not a CPK archive; Star Ocean 4 index: %s", err); return 1; }
    uint32_t n = 0, all = 0;
    for (uint32_t k = 0; k < SO4_ENTRIES; k++) {
        const uint8_t *q = ix + 0x6C + 12 * k;
        if (!rd32le(q + 4)) continue;
        all++;
        if (((rd32le(q + 8) & 0x10000000) ? 1 : 0) == arch) n++;
    }
    c->e = calloc(n ? n : 1, sizeof(CpkEntry));
    char *names = malloc((size_t)(n ? n : 1) * 10);
    if (!c->e || !names) { free(ix); free(names); snprintf(c->error, sizeof(c->error), "out of memory"); return -1; }
    c->toc_buf = (uint8_t *)names;
    uint32_t j = 0;
    for (uint32_t k = 0; k < SO4_ENTRIES; k++) {
        const uint8_t *q = ix + 0x6C + 12 * k;
        uint32_t bytes = rd32le(q + 4), start = rd32le(q + 8);
        if (!bytes || ((start & 0x10000000) ? 1 : 0) != arch) continue;
        CpkEntry *e = &c->e[j];
        char *nm = names + (size_t)j * 10;
        snprintf(nm, 10, "%05u.bin", k);
        e->id = k;
        e->dir = "";
        e->name = nm;
        e->offset = (uint64_t)(start & 0x0FFFFFFF) * SO4_SECTOR;
        e->size = e->xsize = bytes;
        if (e->offset > c->file_size || e->size > c->file_size - e->offset) e->beyond_end = 1;
        j++;
    }
    free(ix);
    c->n = n;
    c->so4 = 1;
    c->so4_arch = arch;
    c->so4_used_all = all;
    c->parsed = 1;
    c->error[0] = 0;
    return 0;
}

int cpk_probe(const char *path)
{
    int fd = open(path, O_RDONLY);
    if (fd < 0) return 0;
    char m[4] = { 0 };
    int ok = read(fd, m, 4) == 4 && !memcmp(m, "CPK ", 4);
    close(fd);
    if (ok) return 1;
    if (so4_arch_of(path) < 0) return 0;
    char ip[1024], err[256];
    so4_index_path(path, ip, sizeof(ip));
    uint8_t *ix = so4_read_index(ip, NULL, err, sizeof(err), NULL);
    free(ix);
    return ix != NULL;
}

int cpk_open(Cpk *c, const char *path)
{
    memset(c, 0, sizeof(*c));
    c->fd = -1;
    snprintf(c->path, sizeof(c->path), "%s", path);
    c->fd = open(path, O_RDONLY);
    if (c->fd < 0) { snprintf(c->error, sizeof(c->error), "Cannot open: %s", strerror(errno)); return -1; }
    off_t end = lseek(c->fd, 0, SEEK_END);
    if (end < 0) { snprintf(c->error, sizeof(c->error), "Cannot get size"); return -1; }
    c->file_size = (uint64_t)end;
    c->head_len = c->file_size < 64 ? (int)c->file_size : 64;
    if (c->head_len && read_at(c->fd, 0, c->head, (size_t)c->head_len) != 0) { snprintf(c->error, sizeof(c->error), "Cannot read header"); return -1; }
    if (c->head_len < 16 || memcmp(c->head, "CPK ", 4) != 0) {
        snprintf(c->error, sizeof(c->error), "Not a CPK archive");
        return so4_load(c);
    }
    c->is_cpk = 1;

    uint32_t hl;
    uint8_t *hb = read_packet(c, 0, "CPK ", &hl);
    if (!hb) return -1;
    Utf h;
    if (utf_parse(&h, hb, hl) != 0) { free(hb); snprintf(c->error, sizeof(c->error), "CpkHeader table unreadable"); return -1; }
    c->toc_off = utf_u64(&h, 0, "TocOffset");
    c->itoc_off = utf_u64(&h, 0, "ItocOffset");
    c->content_off = utf_u64(&h, 0, "ContentOffset");
    c->align = utf_u64(&h, 0, "Align");
    c->hdr_files = utf_u64(&h, 0, "Files");
    free(hb);

    int rc = -1;
    if (c->toc_off) { c->has_toc = 1; rc = load_toc(c); }
    if (rc != 0 && c->itoc_off) { c->has_itoc = 1; rc = load_itoc(c); }
    if (rc != 0 && !c->error[0]) snprintf(c->error, sizeof(c->error), "No TOC or ITOC table");
    if (rc != 0) return -1;
    /* entries whose data lies outside the file are flagged, never silently emptied */
    for (uint32_t i = 0; i < c->n; i++)
        if (c->e[i].offset > c->file_size || c->e[i].size > c->file_size - c->e[i].offset) c->e[i].beyond_end = 1;
    c->parsed = 1;
    return 0;
}

void cpk_close(Cpk *c)
{
    if (c->fd >= 0) close(c->fd);
    free(c->e);
    free(c->toc_buf);
    memset(c, 0, sizeof(*c));
    c->fd = -1;
}

/* ------------------------------------------------------------------ */
/* CRILAYLA                                                           */
/* ------------------------------------------------------------------ */
typedef struct { const uint8_t *in; int64_t pos; uint8_t pool; int left; int bad; } Bits;

static uint32_t getbits(Bits *b, int n)
{
    uint32_t r = 0;
    int got = 0;
    while (got < n) {
        if (b->left == 0) {
            if (b->pos < 0) { b->bad = 1; return 0; }
            b->pool = b->in[b->pos--];
            b->left = 8;
        }
        int k = b->left < n - got ? b->left : n - got;
        r = (r << k) | ((b->pool >> (b->left - k)) & ((1u << k) - 1));
        b->left -= k;
        got += k;
    }
    return r;
}

uint8_t *crilayla_decompress(const uint8_t *in, size_t len, size_t *out_len)
{
    if (len < 0x10 + 0x100 || memcmp(in, "CRILAYLA", 8) != 0) return NULL;
    uint32_t usize = le32(in + 8), hoff = le32(in + 12);
    if ((uint64_t)hoff + 0x10 + 0x100 > len || usize > MAX_INMEM) return NULL;
    uint8_t *out = malloc((size_t)usize + 0x100);
    if (!out) return NULL;
    memcpy(out, in + hoff + 0x10, 0x100);              /* stored uncompressed prefix */
    Bits b = { in, (int64_t)len - 0x100 - 1, 0, 0, 0 };
    int64_t out_end = 0x100 + (int64_t)usize - 1;
    uint64_t written = 0;
    static const int lens[4] = { 2, 3, 5, 8 };
    while (written < usize && !b.bad) {
        if (getbits(&b, 1)) {
            int64_t src = out_end - (int64_t)written + getbits(&b, 13) + 3;
            uint64_t length = 3;
            int lvl;
            for (lvl = 0; lvl < 4; lvl++) {
                uint32_t v = getbits(&b, lens[lvl]);
                length += v;
                if (v != (1u << lens[lvl]) - 1) break;
            }
            if (lvl == 4) {
                uint32_t v;
                do { v = getbits(&b, 8); length += v; } while (v == 255 && !b.bad);
            }
            for (uint64_t i = 0; i < length && written < usize; i++) {
                int64_t dst = out_end - (int64_t)written;
                if (src < 0 || src > out_end || dst < 0x100) { b.bad = 1; break; }
                out[dst] = out[src--];
                written++;
            }
        } else {
            out[out_end - (int64_t)written] = (uint8_t)getbits(&b, 8);
            written++;
        }
    }
    if (b.bad || written != usize) { free(out); return NULL; }
    *out_len = (size_t)usize + 0x100;
    return out;
}

/* ------------------------------------------------------------------ */
/* extraction                                                         */
/* ------------------------------------------------------------------ */
/* Safe relative path for an entry: <dir>/<name>, or _id/<ID>.bin. */
static void entry_relpath(const CpkEntry *e, char *out, size_t n)
{
    char raw[1024];
    if (e->name[0]) snprintf(raw, sizeof(raw), "%s%s%s", e->dir, e->dir[0] ? "/" : "", e->name);
    else snprintf(raw, sizeof(raw), "_id/%u.bin", e->id);
    size_t o = 0;
    const char *p = raw;
    while (*p && o + 2 < n) {
        while (*p == '/' || *p == '\\') p++;
        const char *s = p;
        while (*p && *p != '/' && *p != '\\') p++;
        size_t cl = (size_t)(p - s);
        if (!cl || (cl == 1 && s[0] == '.') || (cl == 2 && s[0] == '.' && s[1] == '.')) continue; /* no traversal */
        if (o) out[o++] = '/';
        for (size_t i = 0; i < cl && o + 1 < n; i++) {
            unsigned char ch = (unsigned char)s[i];
            out[o++] = (ch < 0x20 || strchr(":*?\"<>|", ch)) ? '_' : (char)ch;
        }
    }
    if (!o) o = (size_t)snprintf(out, n, "_id/%u.bin", e->id);
    out[o < n ? o : n - 1] = 0;
}

static uint64_t expected_out(const CpkEntry *e) { return e->xsize > e->size ? e->xsize : e->size; }

static int file_has_size(const char *path, uint64_t want)
{
    struct stat st;
    return stat(path, &st) == 0 && S_ISREG(st.st_mode) && (uint64_t)st.st_size == want;
}

/* Resume test: the output exists with the expected size, and so does the
 * .crilayla copy when that option is on (so turning it on later fills them in). */
static int entry_done(const CpkEntry *e, const char *full, const CpkOptions *o)
{
    if (!file_has_size(full, expected_out(e))) return 0;
    if (o->keep_raw && e->xsize > e->size) {
        char raw[2100];
        snprintf(raw, sizeof(raw), "%s.crilayla", full);
        if (!file_has_size(raw, e->size)) return 0;
    }
    return 1;
}

uint64_t cpk_bytes_needed(Cpk *c, const char *out_dir, const CpkOptions *o, uint32_t *files_left)
{
    uint64_t need = 0;
    uint32_t left = 0;
    char rel[1024], full[2048];
    for (uint32_t i = 0; i < c->n; i++) {
        entry_relpath(&c->e[i], rel, sizeof(rel));
        snprintf(full, sizeof(full), "%s/%s", out_dir, rel);
        if (c->e[i].beyond_end) continue;
        if (o->resume && entry_done(&c->e[i], full, o)) continue;
        need += expected_out(&c->e[i]);
        if (o->keep_raw && c->e[i].xsize > c->e[i].size) need += c->e[i].size;
        left++;
    }
    if (files_left) *files_left = left;
    return need;
}

static const char *errtext(int e)
{
    switch (e) {
    case ENOSPC: return "destination full";
    case EFBIG:  return "file too large for destination (FAT32 4 GB limit)";
    case EROFS:  return "destination read-only";
    default:     return strerror(e);
    }
}

/* Write `len` bytes from the archive at `off` into path (via .part + rename). */
static int stream_copy(int fd, uint64_t off, uint64_t len, const char *path, uint8_t *buf,
                       CpkProgress *p, CpkProgressFn cb, void *user, char *err, size_t errn)
{
    char part[2100];
    snprintf(part, sizeof(part), "%s.part", path);
    int out = open(part, O_WRONLY | O_CREAT | O_TRUNC, 0666);
    if (out < 0) { snprintf(err, errn, "create failed: %s", errtext(errno)); return -1; }
    uint64_t done = 0;
    while (done < len) {
        size_t n = (len - done) < CHUNK ? (size_t)(len - done) : CHUNK;
        if (read_at(fd, off + done, buf, n) != 0) { snprintf(err, errn, "read error at 0x%llx", (unsigned long long)(off + done)); goto fail; }
        if (write_all(out, buf, n) != 0) { snprintf(err, errn, "write failed: %s", errtext(errno)); goto fail; }
        done += n;
        p->bytes_done += n;
        p->bytes_written += n;
        if (cb && cb(p, user)) { p->cancelled = 1; snprintf(err, errn, "cancelled"); goto fail; }
    }
    if (close(out) != 0) { out = -1; snprintf(err, errn, "write failed: %s", errtext(errno)); goto fail; }
    if (rename(part, path) != 0) { snprintf(err, errn, "rename failed: %s", strerror(errno)); unlink(part); return -1; }
    return 0;
fail:
    if (out >= 0) close(out);
    unlink(part);
    return -1;
}

static int write_buf(const char *path, const uint8_t *data, size_t len, char *err, size_t errn)
{
    char part[2100];
    snprintf(part, sizeof(part), "%s.part", path);
    int out = open(part, O_WRONLY | O_CREAT | O_TRUNC, 0666);
    if (out < 0) { snprintf(err, errn, "create failed: %s", errtext(errno)); return -1; }
    int rc = write_all(out, data, len);
    int e = errno;
    if (close(out) != 0 && rc == 0) { rc = -1; e = errno; }
    if (rc != 0) { unlink(part); snprintf(err, errn, "write failed: %s", errtext(e)); return -1; }
    if (rename(part, path) != 0) { unlink(part); snprintf(err, errn, "rename failed: %s", strerror(errno)); return -1; }
    return 0;
}

/* Extract entry i to full path. Returns 0 ok, -1 error (err filled). */
static int extract_entry(Cpk *c, uint32_t i, const char *full, const CpkOptions *o, uint8_t *buf,
                         CpkProgress *p, CpkProgressFn cb, void *user, char *err, size_t errn, int *was_compressed)
{
    const CpkEntry *e = &c->e[i];
    if (e->beyond_end) {
        snprintf(err, errn, "data lies beyond the end of the archive (file truncated or corrupt)");
        return -1;
    }
    char parent[2048];
    snprintf(parent, sizeof(parent), "%s", full);
    char *sl = strrchr(parent, '/');
    if (sl) { *sl = 0; if (mkdirs(parent) != 0) { snprintf(err, errn, "cannot create folder: %s", errtext(errno)); return -1; } }
    *was_compressed = 0;

    uint8_t magic[8] = { 0 };
    if (e->size >= 8 && read_at(c->fd, e->offset, magic, 8) != 0) { snprintf(err, errn, "read error at 0x%llx", (unsigned long long)e->offset); return -1; }
    int crilayla = e->xsize > e->size && !memcmp(magic, "CRILAYLA", 8);
    if (!crilayla) return stream_copy(c->fd, e->offset, e->size, full, buf, p, cb, user, err, errn);

    *was_compressed = 1;
    if (e->size > MAX_INMEM || e->xsize > MAX_INMEM) { snprintf(err, errn, "compressed file too large to unpack in memory"); return -1; }
    uint8_t *in = malloc((size_t)e->size);
    if (!in) { snprintf(err, errn, "out of memory"); return -1; }
    if (read_at(c->fd, e->offset, in, (size_t)e->size) != 0) { free(in); snprintf(err, errn, "read error"); return -1; }
    p->bytes_done += e->size;
    int rc = 0;
    if (o->keep_raw) {
        char raw[2100];
        snprintf(raw, sizeof(raw), "%s.crilayla", full);
        if (write_buf(raw, in, (size_t)e->size, err, errn) != 0) rc = -1;
    }
    size_t ol = 0;
    uint8_t *out = rc == 0 ? crilayla_decompress(in, (size_t)e->size, &ol) : NULL;
    free(in);
    if (rc == 0 && !out) { snprintf(err, errn, "CRILAYLA data is corrupt"); rc = -1; }
    if (rc == 0) {
        rc = write_buf(full, out, ol, err, errn);
        if (rc == 0) p->bytes_written += ol;
    }
    free(out);
    if (cb && cb(p, user)) { p->cancelled = 1; if (rc == 0) snprintf(err, errn, "cancelled"); }
    return rc;
}

int cpk_extract_all(Cpk *c, const char *out_dir, const CpkOptions *o, FILE *log,
                    CpkProgress *p, CpkProgressFn cb, void *user)
{
    uint8_t *buf = malloc(CHUNK);
    if (!buf) { snprintf(p->error, sizeof(p->error), "out of memory"); p->failed = 1; return -1; }
    if (mkdirs(out_dir) != 0) { free(buf); snprintf(p->error, sizeof(p->error), "cannot create %s: %s", out_dir, errtext(errno)); p->failed = 1; return -1; }
    char stem[256], rel[1024], full[2048], err[256];
    cpk_stem(c->path, stem, sizeof(stem));
    for (uint32_t i = 0; i < c->n && !p->cancelled; i++) {
        const CpkEntry *e = &c->e[i];
        entry_relpath(e, rel, sizeof(rel));
        snprintf(full, sizeof(full), "%s/%s", out_dir, rel);
        p->current = rel;
        if (o->resume && entry_done(e, full, o)) {
            p->files_skipped++;
            p->files_done++;
            p->bytes_done += e->size;
            if (log) fprintf(log, "%s\t%u\t%s\t0x%llx\t%llu\t%llu\tSKIPPED (already extracted)\n", stem, e->id, rel,
                             (unsigned long long)e->offset, (unsigned long long)e->size, (unsigned long long)e->xsize);
            if (cb && cb(p, user)) p->cancelled = 1;
            continue;
        }
        int comp = 0;
        err[0] = 0;
        int rc = extract_entry(c, i, full, o, buf, p, cb, user, err, sizeof(err), &comp);
        if (p->cancelled) {
            if (log) fprintf(log, "%s\t%u\t%s\t0x%llx\t%llu\t%llu\tCANCELLED\n", stem, e->id, rel,
                             (unsigned long long)e->offset, (unsigned long long)e->size, (unsigned long long)e->xsize);
            break;
        }
        p->files_done++;
        if (rc == 0) p->files_ok++;
        else {
            p->files_failed++;
            if (!p->error[0]) snprintf(p->error, sizeof(p->error), "%.160s: %.90s", rel, err);
        }
        if (log) {
            fprintf(log, "%s\t%u\t%s\t0x%llx\t%llu\t%llu\t%s%s%s\n", stem, e->id, rel, (unsigned long long)e->offset,
                    (unsigned long long)e->size, (unsigned long long)e->xsize, rc == 0 ? "OK" : "ERROR ",
                    rc == 0 ? (comp ? " (CRILAYLA unpacked)" : "") : err, "");
            fflush(log);
        }
        /* a full destination won't get better: stop instead of failing every file */
        if (rc != 0 && (strstr(err, "full") || strstr(err, "read-only"))) { p->failed = 1; break; }
    }
    free(buf);
    if (p->cancelled) return -1;
    return p->files_failed ? -1 : 0;
}

int cpk_find(Cpk *c, const char *q)
{
    while (*q == ' ' || *q == '\t') q++;
    char qq[1024];
    snprintf(qq, sizeof(qq), "%s", q);
    for (size_t l = strlen(qq); l && (qq[l - 1] == ' ' || qq[l - 1] == '\t' || qq[l - 1] == '\r' || qq[l - 1] == '\n'); l--) qq[l - 1] = 0;
    q = qq;
    char *end;
    /* IDs are decimal (leading zeros allowed, "00010" = 10); "0x" means hex */
    int hex = (q[0] == '0' && (q[1] == 'x' || q[1] == 'X'));
    unsigned long long id = strtoull(hex ? q + 2 : q, &end, hex ? 16 : 10);
    int numeric = *q && end != (hex ? q + 2 : q) && *end == 0;
    char rel[1024];
    for (uint32_t i = 0; i < c->n; i++) {
        if (numeric && c->e[i].id == id) return (int)i;
        snprintf(rel, sizeof(rel), "%s%s%s", c->e[i].dir, c->e[i].dir[0] ? "/" : "", c->e[i].name);
        if (c->e[i].name[0] && (!strcasecmp(rel, q) || !strcasecmp(c->e[i].name, q))) return (int)i;
    }
    return -1;
}

int cpk_extract_one(Cpk *c, uint32_t i, const char *out_dir, char *saved, size_t n, char *err, size_t errn)
{
    if (i >= c->n) { snprintf(err, errn, "no such entry"); return -1; }
    if (mkdirs(out_dir) != 0) { snprintf(err, errn, "cannot create %s", out_dir); return -1; }
    char name[300];
    if (c->e[i].name[0]) {
        snprintf(name, sizeof(name), "%s", c->e[i].name);
        for (char *s = name; *s; s++) if (*s == '/' || *s == '\\' || (unsigned char)*s < 0x20 || strchr(":*?\"<>|", *s)) *s = '_';
    } else snprintf(name, sizeof(name), "%u.bin", c->e[i].id);
    snprintf(saved, n, "%s/%s", out_dir, name);
    struct stat st;
    if (file_has_size(saved, expected_out(&c->e[i]))) return 0; /* already extracted, same size */
    for (int k = 1; stat(saved, &st) == 0 && k < 1000; k++) snprintf(saved, n, "%s/%d_%s", out_dir, k, name);
    uint8_t *buf = malloc(CHUNK);
    if (!buf) { snprintf(err, errn, "out of memory"); return -1; }
    CpkProgress p;
    memset(&p, 0, sizeof(p));
    CpkOptions o = { 0, 0 };
    int comp;
    int rc = extract_entry(c, i, saved, &o, buf, &p, NULL, NULL, err, errn, &comp);
    free(buf);
    return rc;
}

int cpk_dump_range(const char *src, uint64_t offset, uint64_t len, const char *out_path,
                   CpkProgress *p, CpkProgressFn cb, void *user, char *err, size_t errn)
{
    int fd = open(src, O_RDONLY);
    if (fd < 0) { snprintf(err, errn, "cannot open source: %s", strerror(errno)); return -1; }
    off_t end = lseek(fd, 0, SEEK_END);
    if (end < 0 || offset >= (uint64_t)end) { close(fd); snprintf(err, errn, "offset is beyond the end of the file (size %lld)", (long long)end); return -1; }
    if (len > (uint64_t)end - offset) len = (uint64_t)end - offset;
    uint8_t *buf = malloc(CHUNK);
    if (!buf) { close(fd); snprintf(err, errn, "out of memory"); return -1; }
    p->bytes_total = len;
    int rc = stream_copy(fd, offset, len, out_path, buf, p, cb, user, err, errn);
    free(buf);
    close(fd);
    return rc;
}

static void human(uint64_t v, char *o, size_t n)
{
    if (v >= 1000000000ull) snprintf(o, n, "%.2f GB", v / 1e9);
    else if (v >= 1000000ull) snprintf(o, n, "%.2f MB", v / 1e6);
    else if (v >= 1000ull) snprintf(o, n, "%.1f KB", v / 1e3);
    else snprintf(o, n, "%llu B", (unsigned long long)v);
}

static int classify(const uint8_t *b, size_t len, char *out, size_t n)
{
    if (len < 4) { snprintf(out, n, "tiny (%u bytes)", (unsigned)len); return 0; }
    #define M(s) (!memcmp(b, s, 4))
    if (M("KCAP")) { snprintf(out, n, "KCAP pack, %u files", len >= 12 ? rd32le(b + 8) : 0); return 1; }
    if (!memcmp(b, "SLZ", 3)) { snprintf(out, n, "SLZ compressed (mode %u)", b[3]); return 1; }
    if (!memcmp(b, "CRILAYLA", len >= 8 ? 8 : 4)) { snprintf(out, n, "CRILAYLA compressed"); return 1; }
    if (M("CPK ")) { snprintf(out, n, "CPK archive"); return 1; }
    if (M("@UTF")) { snprintf(out, n, "CRI @UTF table"); return 1; }
    if (M("RIFF")) { snprintf(out, n, len >= 12 && !memcmp(b + 8, "WAVE", 4) ? "RIFF WAVE audio (wav/at9)" : "RIFF data"); return 1; }
    if (M("OggS")) { snprintf(out, n, "Ogg audio"); return 1; }
    if (M("DDS ")) { snprintf(out, n, "DDS texture"); return 1; }
    if (M("GNF ")) { snprintf(out, n, "GNF texture (PS4)"); return 1; }
    if (M("\x89PNG")) { snprintf(out, n, "PNG image"); return 1; }
    if (M("BKHD")) { snprintf(out, n, "Wwise sound bank (.bnk)"); return 1; }
    if (M("PSAR")) { snprintf(out, n, "PSARC archive"); return 1; }
    if (M("AFS2")) { snprintf(out, n, "CRI AWB audio bank"); return 1; }
    if (M("AFS\0")) { snprintf(out, n, "CRI AFS archive"); return 1; }
    if (rd32le(b) == 0x184D2204 || rd32le(b) == 0x184C2102) { snprintf(out, n, "LZ4 compressed"); return 1; }
    if ((b[0] & 0x7F) == 'H' && (b[1] & 0x7F) == 'C' && (b[2] & 0x7F) == 'A' && (b[3] & 0x7F) == 0) { snprintf(out, n, "CRI HCA audio"); return 1; }
    if (b[0] == 0x80 && b[1] == 0x00 && len >= 6 && b[4] >= 2 && b[4] <= 4) { snprintf(out, n, "CRI ADX audio"); return 1; }
    if (M("AKPK")) { snprintf(out, n, "Wwise audio package (.pck)"); return 1; }
    if (M("FSB5")) { snprintf(out, n, "FMOD sound bank"); return 1; }
    if (M("\x7f" "ELF")) { snprintf(out, n, "ELF program"); return 1; }
    if (M("PSMF") || M("PAMF")) { snprintf(out, n, "PlayStation movie"); return 1; }
    if (b[0] == 0 && b[1] == 0 && b[2] == 1 && b[3] == 0xBA) { snprintf(out, n, "MPEG-PS video"); return 1; }
    if (len >= 8 && !memcmp(b + 4, "ftyp", 4)) { snprintf(out, n, "MP4 video"); return 1; }
    #undef M
    int pr = 1;
    for (int k = 0; k < 4; k++) if (b[k] < 0x20 || b[k] > 0x7E) pr = 0;
    if (pr && b[0] == ' ') { snprintf(out, n, "tri-Ace '%c%c%c' data", b[3], b[2], b[1]); return 1; } /* stored reversed */
    if (pr) { snprintf(out, n, "'%c%c%c%c' data", b[0], b[1], b[2], b[3]); return 1; }
    snprintf(out, n, "unknown (%02X %02X %02X %02X)", b[0], b[1], b[2], b[3]);
    return 0;
}

void cpk_sniff(Cpk *c, uint32_t i, char *out, size_t n)
{
    snprintf(out, n, "?");
    if (i >= c->n) return;
    const CpkEntry *e = &c->e[i];
    if (e->beyond_end) { snprintf(out, n, "beyond end of file"); return; }
    uint8_t b[16] = { 0 };
    size_t len = e->size < 16 ? (size_t)e->size : 16;
    if (!len) { snprintf(out, n, "empty"); return; }
    if (read_at(c->fd, e->offset, b, len) != 0) { snprintf(out, n, "read error"); return; }
    classify(b, len, out, n);
}

/* ---- magic survey ---- */
/* 0 nothing readable, 1 plain, 2 scrambled with the index key, 3 inconclusive */
static int survey_verdict(uint32_t kr, uint32_t kx, uint32_t readable)
{
    if (!readable) return 0;
    if (kx > kr * 2 && kx >= readable / 4 && kx) return 2;
    if (kr > kx * 2 && kr >= readable / 4 && kr) return 1;
    return 3;
}
static const char *verdict_text[4] = {
    "no file data could be read (archive truncated or not the full file?)",
    "file data looks PLAIN (starts are recognisable as stored)",
    "file data looks SCRAMBLED with the index key (starts become recognisable after XOR)",
    "inconclusive - neither form is clearly recognisable (could be compressed/encrypted another way)",
};
typedef struct { uint8_t m[4]; uint32_t count; uint64_t bytes; uint32_t ex[3]; int nex; char desc[64]; int known; } MStat;

static MStat *mstat_add(MStat *t, int *n, int cap, const uint8_t *m, const uint8_t *full, size_t len, uint64_t size, uint32_t id)
{
    for (int i = 0; i < *n; i++)
        if (!memcmp(t[i].m, m, 4)) {
            t[i].count++; t[i].bytes += size;
            if (t[i].nex < 3) t[i].ex[t[i].nex++] = id;
            return &t[i];
        }
    MStat *e = &t[*n < cap ? (*n)++ : cap - 1];     /* last slot collects the rest */
    if (e == &t[cap - 1] && *n == cap && e->count) { e->count++; e->bytes += size; return e; }
    memset(e, 0, sizeof(*e));
    memcpy(e->m, m, 4);
    e->count = 1; e->bytes = size; e->ex[0] = id; e->nex = 1;
    e->known = classify(full, len, e->desc, sizeof(e->desc));
    return e;
}

static int mcmp(const void *a, const void *b)
{
    const MStat *x = a, *y = b;
    return x->count < y->count ? 1 : x->count > y->count ? -1 : 0;
}

static void mreport(FILE *f, const char *title, MStat *t, int n, uint32_t total)
{
    qsort(t, (size_t)n, sizeof(MStat), mcmp);
    fprintf(f, "\n## %s  (%d distinct starts)\n# count\tshare\tbytes\tfirst 4 bytes\tlooks like\texample IDs\n", title, n);
    for (int i = 0; i < n; i++) {
        char asc[5];
        for (int k = 0; k < 4; k++) asc[k] = (t[i].m[k] >= 0x20 && t[i].m[k] < 0x7F) ? (char)t[i].m[k] : '.';
        asc[4] = 0;
        fprintf(f, "%u\t%.1f%%\t%llu\t%02X %02X %02X %02X  %s\t%s\t", t[i].count, total ? 100.0 * t[i].count / total : 0,
                (unsigned long long)t[i].bytes, t[i].m[0], t[i].m[1], t[i].m[2], t[i].m[3], asc, t[i].desc);
        for (int k = 0; k < t[i].nex; k++) fprintf(f, "%s%05u", k ? "," : "", t[i].ex[k]);
        fprintf(f, "\n");
        if (i >= 39 && n > 41) { fprintf(f, "... %d more distinct starts (mostly single files)\n", n - 40); break; }
    }
}

int cpk_survey(Cpk *c, FILE *out, int (*cb)(void *), void *user, uint32_t *known_raw, uint32_t *known_xor, uint32_t *readable_out)
{
    enum { CAP = 4096 };
    MStat *raw = calloc(CAP, sizeof(MStat)), *xr = c->so4 ? calloc(CAP, sizeof(MStat)) : NULL;
    if (!raw || (c->so4 && !xr)) { free(raw); free(xr); return -1; }
    int nr = 0, nx = 0, rc = 0;
    uint32_t kr = 0, kx = 0, unread = 0;
    for (uint32_t i = 0; i < c->n; i++) {
        const CpkEntry *e = &c->e[i];
        uint8_t b[16] = { 0 };
        size_t len = e->size < 16 ? (size_t)e->size : 16;
        if (e->beyond_end || !len || read_at(c->fd, e->offset, b, len) != 0) { unread++; continue; }
        MStat *s = mstat_add(raw, &nr, CAP, b, b, len, e->size, e->id);
        if (s->known) kr++;
        if (xr) {
            uint8_t d[16];
            for (size_t k = 0; k < len; k++) d[k] = b[k] ^ c->so4_key[(e->offset + k) % 192];
            MStat *t = mstat_add(xr, &nx, CAP, d, d, len, e->size, e->id);
            if (t->known) kx++;
        }
        if (cb && (i & 31) == 0 && cb(user)) { rc = -2; break; }
    }
    fprintf(out, "# Magic survey of %s\n# %u entries, %u could not be read%s\n", c->path, c->n, unread, rc == -2 ? ", CANCELLED" : "");
    fprintf(out, "# recognised format at the start: %u of %u as stored", kr, c->n - unread);
    if (xr) fprintf(out, ", %u of %u if XOR'd with the index key", kx, c->n - unread);
    fprintf(out, "\n");
    if (xr) fprintf(out, "# verdict: %s\n", verdict_text[survey_verdict(kr, kx, c->n - unread)]);
    else if (!(c->n - unread)) fprintf(out, "# verdict: %s\n", verdict_text[0]);
    if (readable_out) *readable_out = c->n - unread;
    mreport(out, "as stored", raw, nr, c->n - unread);
    if (xr) mreport(out, "XOR'd with the index key (only meaningful if the verdict says scrambled)", xr, nx, c->n - unread);
    if (known_raw) *known_raw = kr;
    if (known_xor) *known_xor = kx;
    free(raw); free(xr);
    return ferror(out) ? -1 : rc;
}

int cpk_write_listing(Cpk *c, const char *out_path)
{
    FILE *f = fopen(out_path, "w");
    if (!f) return -1;
    if (c->so4) {
        fprintf(f, "# %s\n# Star Ocean 4 archive: %u files here (%u used IDs in the index), archive size %llu\n"
                   "# ID\tArchive\tOffset\tSize\tSize (readable)\tFormat (from the first bytes)\n",
                c->path, c->n, c->so4_used_all, (unsigned long long)c->file_size);
        for (uint32_t i = 0; i < c->n; i++) {
            char h[32], fm[64];
            human(c->e[i].size, h, sizeof(h));
            cpk_sniff(c, i, fm, sizeof(fm));
            fprintf(f, "%05u\t%04d.bin\t0x%llx\t%llu\t%s\t%s\n", c->e[i].id, c->so4_arch, (unsigned long long)c->e[i].offset,
                    (unsigned long long)c->e[i].size, h, fm);
        }
        int rc = ferror(f) ? -1 : 0;
        if (fclose(f) != 0) rc = -1;
        return rc;
    }
    fprintf(f, "# %s\n# %u files, archive size %llu, %s\n# ID\tPath\tOffset\tFileSize\tExtractSize\n", c->path, c->n,
            (unsigned long long)c->file_size, c->has_toc && c->n && c->e[0].name[0] ? "TOC (named)" : "ITOC (ID only)");
    char rel[1024];
    for (uint32_t i = 0; i < c->n; i++) {
        entry_relpath(&c->e[i], rel, sizeof(rel));
        fprintf(f, "%u\t%s\t0x%llx\t%llu\t%llu%s\n", c->e[i].id, rel, (unsigned long long)c->e[i].offset,
                (unsigned long long)c->e[i].size, (unsigned long long)c->e[i].xsize,
                c->e[i].beyond_end ? "\tBEYOND END OF FILE" : c->e[i].xsize > c->e[i].size ? "\tcompressed" : "");
    }
    int rc = ferror(f) ? -1 : 0;
    if (fclose(f) != 0) rc = -1;
    return rc;
}

typedef struct { uint32_t id; int arch; uint64_t size; uint8_t b[32]; uint8_t n; } MagicRow;

static int magic_cmp(const void *a, const void *b)
{
    const MagicRow *x = a, *y = b;
    if (x->id != y->id) return x->id < y->id ? -1 : 1;
    return x->arch - y->arch;
}

int cpk_write_magic(const char *const *paths, int n, const char *out_path, uint32_t *lines, char *err, size_t errn)
{
    MagicRow *rows = NULL;
    size_t cnt = 0, cap = 0;
    for (int a = 0; a < n; a++) {
        Cpk c;
        if (cpk_open(&c, paths[a]) != 0) { snprintf(err, errn, "%s: %s", paths[a], c.error); cpk_close(&c); free(rows); return -1; }
        for (uint32_t i = 0; i < c.n; i++) {
            if (cnt == cap) {
                size_t nc = cap ? cap * 2 : 4096;
                MagicRow *t = realloc(rows, nc * sizeof(*t));
                if (!t) { cpk_close(&c); free(rows); snprintf(err, errn, "out of memory"); return -1; }
                rows = t; cap = nc;
            }
            MagicRow *r = &rows[cnt++];
            memset(r, 0, sizeof(*r));
            r->id = c.e[i].id;
            r->arch = c.so4 ? c.so4_arch : a;
            r->size = c.e[i].size;
            size_t k = c.e[i].size < 32 ? (size_t)c.e[i].size : 32;
            if (c.e[i].offset < c.file_size && k > c.file_size - c.e[i].offset) k = (size_t)(c.file_size - c.e[i].offset);
            if (c.e[i].offset < c.file_size && k && read_at(c.fd, c.e[i].offset, r->b, k) == 0) r->n = (uint8_t)k;
        }
        cpk_close(&c);
    }
    qsort(rows, cnt, sizeof(*rows), magic_cmp);
    char part[1100];
    snprintf(part, sizeof(part), "%s.part", out_path);
    FILE *f = fopen(part, "w");
    if (!f) { free(rows); snprintf(err, errn, "cannot write %s: %s", out_path, strerror(errno)); return -1; }
    fprintf(f, "# magic survey: first 32 bytes of every file (%zu files)\n# ID\tArchive\tSize\tHex\tASCII\n", cnt);
    for (size_t i = 0; i < cnt; i++) {
        const MagicRow *r = &rows[i];
        char hex[100], asc[40];
        int o = 0;
        for (int k = 0; k < r->n; k++) o += snprintf(hex + o, sizeof(hex) - o, "%02X", r->b[k]);
        hex[o] = 0;
        for (int k = 0; k < r->n; k++) asc[k] = (r->b[k] >= 0x20 && r->b[k] < 0x7F) ? (char)r->b[k] : '.';
        asc[r->n] = 0;
        fprintf(f, "%05u\t%04d.bin\t%llu\t%s\t%s\n", r->id, r->arch, (unsigned long long)r->size, r->n ? hex : "(unreadable)", asc);
    }
    int bad = ferror(f);
    if (fclose(f) != 0 || bad || rename(part, out_path) != 0) { unlink(part); free(rows); snprintf(err, errn, "write failed: %s", out_path); return -1; }
    if (lines) *lines = (uint32_t)cnt;
    free(rows);
    return 0;
}

int cpk_write_magic_summary(const char *const *paths, int n, const char *out_path, char *verdict, size_t vn, char *err, size_t errn)
{
    char part[1100];
    snprintf(part, sizeof(part), "%s.part", out_path);
    FILE *f = fopen(part, "w");
    if (!f) { snprintf(err, errn, "cannot write %s: %s", out_path, strerror(errno)); return -1; }
    if (verdict && vn) verdict[0] = 0;
    for (int a = 0; a < n; a++) {
        Cpk c;
        if (cpk_open(&c, paths[a]) != 0) { fprintf(f, "# %s: not a readable archive (%s)\n\n", paths[a], c.error); cpk_close(&c); continue; }
        uint32_t kr = 0, kx = 0, rd = 0;
        cpk_survey(&c, f, NULL, NULL, &kr, &kx, &rd);
        fprintf(f, "\n");
        if (verdict && vn) {
            const char *b = strrchr(paths[a], '/');
            size_t l = strlen(verdict);
            static const char *shortv[4] = { "NO DATA READABLE", "PLAIN", "SCRAMBLED", "INCONCLUSIVE" };
            if (c.so4)
                snprintf(verdict + l, vn - l, "%s%s: %u files (%u readable), %u recognisable as stored, %u if XOR'd -> %s", l ? "; " : "",
                         b ? b + 1 : paths[a], c.n, rd, kr, kx, shortv[survey_verdict(kr, kx, rd)]);
            else snprintf(verdict + l, vn - l, "%s%s: %u files, %u recognisable", l ? "; " : "", b ? b + 1 : paths[a], c.n, kr);
        }
        cpk_close(&c);
    }
    int bad = ferror(f);
    if (fclose(f) != 0 || bad || rename(part, out_path) != 0) { unlink(part); snprintf(err, errn, "write failed: %s", out_path); return -1; }
    return 0;
}
