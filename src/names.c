/* names.c - Star Ocean 4 pack surveys (read-only):
 *   nf_inner_headers  inner_headers.txt - one line per KCAP entry: type, size, SLZ mode,
 *                     first 32 bytes (hex + text), up to 3 readable text runs
 *   nf_find_names     names.txt / names_by_prefix.txt / pack_names.txt
 *   nf_search         search names.txt
 *   nf_label_*        display labels for packs and entries
 *
 * KCAP pack: "KCAP", +8 u32 entry count, +12 u32 pack size, then 16-byte entries:
 *   +0 u16 type, +2 u16 flags, +4 u32 extra, +8 u32 size, +12 u32 offset (from the pack start).
 * Entries usually start with "SLZ" (tri-Ace compression, 64 KiB chunks); others are raw.
 */
#include "names.h"
#include "cpk.h"
#include "formats.h"
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <dirent.h>
#include <strings.h>

#define NF_MAXREAD  (256u << 20)   /* largest single entry decompressed in memory */
#define NF_NAMEMAX  127

static uint16_t rd16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }
static uint32_t rd32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }

static int pread_all(int fd, uint64_t off, void *buf, size_t n)
{
    uint8_t *p = buf;
    while (n) {
        ssize_t r = pread(fd, p, n, (off_t)off);
        if (r < 0) { if (errno == EINTR) continue; return -1; }
        if (r == 0) return -1;
        p += r; n -= (size_t)r; off += (uint64_t)r;
    }
    return 0;
}

static int tick(NfJob *j)
{
    if (j->cancelled) return 1;
    if (j->cb && j->cb(j->user)) j->cancelled = 1;
    return j->cancelled;
}

/* ---------------------------------------------------------------- pack list */
typedef struct { uint32_t id; int arch; uint64_t off, size; } PackRef;

static int packref_cmp(const void *a, const void *b)
{
    const PackRef *x = a, *y = b;
    return x->id < y->id ? -1 : x->id > y->id;
}

/* Opens every archive and lists the used IDs (sorted, deduplicated). fds[] receives one fd per archive. */
static PackRef *list_packs(const char *const *archives, int n, int *fds, uint32_t *count, NfJob *j)
{
    PackRef *v = NULL;
    size_t k = 0, cap = 0;
    for (int a = 0; a < n; a++) fds[a] = -1;
    for (int a = 0; a < n; a++) {
        struct stat dst;
        if (stat(archives[a], &dst) == 0 && S_ISDIR(dst.st_mode)) {
            /* a folder of extracted packs: every NNNNN.bin (or NNNNN) file is pack NNNNN */
            DIR *dir = opendir(archives[a]);
            if (!dir) { snprintf(j->error, sizeof j->error, "cannot open %s", archives[a]); free(v); return NULL; }
            struct dirent *de;
            fds[a] = -2;   /* per-pack files: opened on demand */
            while ((de = readdir(dir))) {
                char *end;
                unsigned long id = strtoul(de->d_name, &end, 10);
                if (end == de->d_name || (*end && strcasecmp(end, ".bin"))) continue;
                if (j->skip_remaster && id >= 10000) continue;
                char fp[1100];
                snprintf(fp, sizeof fp, "%s/%s", archives[a], de->d_name);
                struct stat fs;
                if (stat(fp, &fs) != 0 || !S_ISREG(fs.st_mode) || !fs.st_size) continue;
                if (k == cap) {
                    size_t nc = cap ? cap * 2 : 4096;
                    PackRef *t = realloc(v, nc * sizeof *t);
                    if (!t) { closedir(dir); free(v); snprintf(j->error, sizeof j->error, "out of memory"); return NULL; }
                    v = t; cap = nc;
                }
                v[k].id = (uint32_t)id; v[k].arch = a; v[k].off = 0; v[k].size = (uint64_t)fs.st_size; k++;
            }
            closedir(dir);
            continue;
        }
        Cpk c;
        if (cpk_open(&c, archives[a]) != 0) {
            snprintf(j->error, sizeof j->error, "%s: %s", archives[a], c.error[0] ? c.error : "not a readable archive");
            cpk_close(&c);
            free(v);
            for (int b = 0; b < a; b++) if (fds[b] >= 0) close(fds[b]);
            return NULL;
        }
        fds[a] = open(archives[a], O_RDONLY);
        for (uint32_t i = 0; i < c.n; i++) {
            const CpkEntry *e = &c.e[i];
            if (e->beyond_end || !e->size) continue;
            if (j->skip_remaster && e->id >= 10000) continue;
            if (k == cap) {
                size_t nc = cap ? cap * 2 : 4096;
                PackRef *t = realloc(v, nc * sizeof *t);
                if (!t) { cpk_close(&c); free(v); snprintf(j->error, sizeof j->error, "out of memory"); return NULL; }
                v = t; cap = nc;
            }
            v[k].id = e->id; v[k].arch = a; v[k].off = e->offset; v[k].size = e->size; k++;
        }
        cpk_close(&c);
        if (fds[a] < 0) { snprintf(j->error, sizeof j->error, "cannot open %s", archives[a]); free(v); return NULL; }
    }
    if (k) qsort(v, k, sizeof *v, packref_cmp);
    size_t w = 0;
    for (size_t i = 0; i < k; i++) if (!w || v[w - 1].id != v[i].id) v[w++] = v[i];
    *count = (uint32_t)w;
    if (!v) v = malloc(1);
    return v;
}

/* fd for a pack: the archive's, or (folder mode) the pack's own file. *own = 1 if the caller must close it. */
static int pack_fd(const char *const *archives, const int *fds, const PackRef *p, int *own)
{
    *own = 0;
    if (fds[p->arch] != -2) return fds[p->arch];
    char fp[1100];
    snprintf(fp, sizeof fp, "%s/%05u.bin", archives[p->arch], p->id);
    int fd = open(fp, O_RDONLY);
    if (fd < 0) { snprintf(fp, sizeof fp, "%s/%u", archives[p->arch], p->id); fd = open(fp, O_RDONLY); }
    if (fd < 0) { snprintf(fp, sizeof fp, "%s/%u.bin", archives[p->arch], p->id); fd = open(fp, O_RDONLY); }
    if (fd >= 0) *own = 1;
    return fd;
}

typedef struct { uint16_t type, flags; uint32_t extra, size, off; } KEnt;

/* Reads the KCAP table of a pack; returns entries (malloc) or NULL (not KCAP / damaged). */
static KEnt *kcap_table(int fd, const PackRef *p, uint32_t *cnt, uint64_t *psize)
{
    uint8_t h[16];
    if (p->size < 16 || pread_all(fd, p->off, h, 16) != 0 || memcmp(h, "KCAP", 4)) return NULL;
    uint32_t n = rd32(h + 8);
    uint64_t ps = rd32(h + 12);
    if (!ps || ps > p->size) ps = p->size;
    if (n > 100000 || 16 + (uint64_t)n * 16 > ps) return NULL;
    uint8_t *t = malloc((size_t)n * 16 + 1);
    KEnt *e = malloc(sizeof(KEnt) * (n ? n : 1));
    if (!t || !e || (n && pread_all(fd, p->off + 16, t, (size_t)n * 16) != 0)) { free(t); free(e); return NULL; }
    for (uint32_t i = 0; i < n; i++) {
        const uint8_t *q = t + 16 * i;
        e[i].type = rd16(q); e[i].flags = rd16(q + 2); e[i].extra = rd32(q + 4); e[i].size = rd32(q + 8); e[i].off = rd32(q + 12);
    }
    free(t);
    *cnt = n; *psize = ps;
    return e;
}

/* Data of one entry, decompressed. maxout 0 = everything. *mode = SLZ mode, or -1 if raw. */
static uint8_t *entry_data(int fd, const PackRef *p, uint64_t psize, const KEnt *e, size_t maxout, size_t *outn, int *mode, uint32_t *full, char *err, size_t en)
{
    *mode = -1; *full = 0;
    if (e->off >= psize) { snprintf(err, en, "entry starts outside the pack"); return NULL; }
    uint64_t avail = psize - e->off;
    uint8_t h[16];
    size_t hn = avail < 16 ? (size_t)avail : 16;
    if (pread_all(fd, p->off + e->off, h, hn) != 0) { snprintf(err, en, "read error"); return NULL; }
    if (hn >= 16 && !memcmp(h, "SLZ", 3)) {
        *mode = h[3];
        uint32_t zs = rd32(h + 8), us = rd32(h + 12);
        *full = us;
        uint64_t need = 0x20 + (uint64_t)zs;
        if (maxout) {
            uint64_t lim = 0x20 + 2 + 0x10000ull * ((maxout + 0xFFFF) / 0x10000) + 16 * ((maxout + 0xFFFF) / 0x10000);
            if (need > lim) need = lim;
        }
        if (need > avail) need = avail;
        if (need > NF_MAXREAD) { snprintf(err, en, "entry too large (%u bytes)", us); return NULL; }
        uint8_t *in = malloc((size_t)need);
        if (!in) { snprintf(err, en, "out of memory"); return NULL; }
        if (pread_all(fd, p->off + e->off, in, (size_t)need) != 0) { free(in); snprintf(err, en, "read error"); return NULL; }
        uint8_t *u;
        if (maxout) u = slz_decompress_prefix(in, (size_t)need, maxout, outn, err, en);
        else {
            if (us > NF_MAXREAD) { free(in); snprintf(err, en, "entry too large (%u bytes)", us); return NULL; }
            u = slz_decompress(in, (size_t)need, outn, err, en);
        }
        free(in);
        return u;
    }
    uint64_t n = e->size < avail ? e->size : avail;
    *full = (uint32_t)n;
    if (maxout && n > maxout) n = maxout;
    if (n > NF_MAXREAD) { snprintf(err, en, "entry too large"); return NULL; }
    uint8_t *d = malloc(n ? (size_t)n : 1);
    if (!d) { snprintf(err, en, "out of memory"); return NULL; }
    if (n && pread_all(fd, p->off + e->off, d, (size_t)n) != 0) { free(d); snprintf(err, en, "read error"); return NULL; }
    *outn = (size_t)n;
    return d;
}

static FILE *open_part(const char *path, char *part, size_t pn)
{
    snprintf(part, pn, "%s.part", path);
    return fopen(part, "w");
}

static int close_part(FILE *f, const char *part, const char *path, NfJob *j)
{
    int bad = ferror(f);
    if (fclose(f) != 0 || bad || rename(part, path) != 0) {
        unlink(part);
        snprintf(j->error, sizeof j->error, "write failed: %s", path);
        return -1;
    }
    return 0;
}

/* ---------------------------------------------------------------- text runs */
static int good_name(const char *s, int n);

/* A run is kept if it reads like a name (see good_name) or like words: two or more words
 * of 3+ letters and at least 80 % letters, digits, spaces and common punctuation. */
static int readable(char *s, int *pn)
{
    int n = *pn, a = 0;
    while (a < n && !isalnum((unsigned char)s[a])) a++;
    while (n > a && !isalnum((unsigned char)s[n - 1]) && s[n - 1] != '.' && s[n - 1] != '!' && s[n - 1] != '?') n--;
    if (n - a < 6) return 0;
    memmove(s, s + a, (size_t)(n - a));
    n -= a;
    *pn = n;
    if (!memchr(s, ' ', (size_t)n)) {
        for (int i = 0; i < n; i++) if (!(isalnum((unsigned char)s[i]) || s[i] == '_' || s[i] == '.' || s[i] == '-')) return 0;
        return good_name(s, n);
    }
    int ok = 0, words = 0, wl = 0;
    for (int i = 0; i <= n; i++) {
        unsigned char c = i < n ? (unsigned char)s[i] : ' ';
        if (isalnum(c) || c == ' ' || strchr(".,'!?-:;()/", c)) ok++;
        if (isalpha(c)) wl++;
        else { if (wl >= 3) words++; wl = 0; }
        if (i >= 3 && i < n && c == s[i - 1] && c == s[i - 2] && c == s[i - 3] && c != ' ' && c != '-' && c != '=' && c != '.') return 0;
    }
    return words >= 2 && ok * 10 >= (n + 1) * 8;
}

/* Up to `max` readable runs (ASCII, then UTF-16LE marked "u:") -> out, " | " separated. */
static void text_runs(const uint8_t *d, size_t n, int max, char *out, size_t on)
{
    size_t o = 0;
    int got = 0;
    out[0] = 0;
    char seen[3][64];
    for (int pass = 0; pass < 2 && got < max; pass++) {
        size_t step = pass ? 2 : 1;
        for (size_t i = 0; i + step <= n && got < max;) {
            size_t k = i;
            char buf[64];
            int bl = 0;
            while (k + step <= n && d[k] >= 0x20 && d[k] < 0x7F && (!pass || d[k + 1] == 0)) {
                if (bl < 48) buf[bl++] = (char)d[k];
                k += step;
            }
            size_t len = (k - i) / step;
            if (len >= 6 && readable(buf, &bl)) {
                buf[bl] = 0;
                int dup = 0;
                for (int s = 0; s < got; s++) if (!strcmp(seen[s], buf)) dup = 1;
                if (!dup) {
                    snprintf(seen[got], sizeof seen[0], "%s", buf);
                    int w = snprintf(out + o, on - o, "%s%s%s%s", got ? " | " : "", pass ? "u:" : "", buf, len > 48 ? "..." : "");
                    if (w > 0 && (size_t)w < on - o) o += (size_t)w;
                    got++;
                }
            }
            i = k > i ? k : i + step;
        }
    }
}

int nf_inner_headers(const char *const *archives, int n, const char *out_txt, NfJob *j)
{
    int fds[8];
    if (n > 8) n = 8;
    uint32_t np = 0;
    PackRef *pk = list_packs(archives, n, fds, &np, j);
    if (!pk) return -1;
    char part[1100];
    FILE *f = open_part(out_txt, part, sizeof part);
    if (!f) { snprintf(j->error, sizeof j->error, "cannot write %s: %s", out_txt, strerror(errno)); free(pk); for (int a = 0; a < n; a++) if (fds[a] >= 0) close(fds[a]); return -1; }
    j->packs_total = np;
    fprintf(f, "# Star Ocean 4 inner headers: one line per KCAP entry (first 64 KiB decompressed)%s\n",
            j->skip_remaster ? ", IDs 10000+ skipped" : "");
    fprintf(f, "# pack\tentry\ttype\tflags\tsize\tslz\tunpacked\thex32\ttext32\ttext runs\n");
    fprintf(f, "# type/flags = u16 at +0/+2 of the KCAP entry; slz = mode 1-3 (0 = raw or stored); unpacked = full size\n");
    int rc = 0;
    for (uint32_t pi = 0; pi < np && rc == 0; pi++) {
        const PackRef *p = &pk[pi];
        int own, fd = pack_fd(archives, fds, p, &own);
        uint32_t cnt = 0;
        uint64_t psize = 0;
        KEnt *e = fd >= 0 ? kcap_table(fd, p, &cnt, &psize) : NULL;
        snprintf(j->current, sizeof j->current, "pack %05u", p->id);
        if (!e) {
            uint8_t h[32] = { 0 };
            size_t hn = p->size < 32 ? (size_t)p->size : 32;
            pread_all(fd, p->off, h, hn);
            char hex[80], asc[40];
            for (size_t k = 0; k < hn; k++) { snprintf(hex + 2 * k, 3, "%02X", h[k]); asc[k] = h[k] >= 0x20 && h[k] < 0x7F ? (char)h[k] : '.'; }
            hex[2 * hn] = 0; asc[hn] = 0;
            fprintf(f, "%05u\t-\t-\t-\t%llu\t-\t-\t%s\t%s\t(not a KCAP pack)\n", p->id, (unsigned long long)p->size, hex, asc);
            j->packs_done++;
            if (own) close(fd);
            if (tick(j)) rc = -2;
            continue;
        }
        j->packs_kcap++;
        for (uint32_t i = 0; i < cnt && rc == 0; i++) {
            snprintf(j->current, sizeof j->current, "pack %05u entry %u/%u", p->id, i, cnt);
            size_t dn = 0;
            int mode;
            uint32_t full;
            char err[128] = "";
            uint8_t *d = entry_data(fd, p, psize, &e[i], 0x10000, &dn, &mode, &full, err, sizeof err);
            char hex[80] = "", asc[40] = "", runs[400] = "";
            if (d) {
                size_t hn = dn < 32 ? dn : 32;
                for (size_t k = 0; k < hn; k++) { snprintf(hex + 2 * k, 3, "%02X", d[k]); asc[k] = d[k] >= 0x20 && d[k] < 0x7F ? (char)d[k] : '.'; }
                hex[2 * hn] = 0; asc[hn] = 0;
                text_runs(d, dn, 3, runs, sizeof runs);
                j->bytes_out += dn;
            } else { snprintf(runs, sizeof runs, "(error: %s)", err); j->errors++; }
            fprintf(f, "%05u\t%u\t%04X\t%04X\t%u\t%d\t%u\t%s\t%s\t%s\n", p->id, i, e[i].type, e[i].flags, e[i].size,
                    mode < 0 ? 0 : mode, full, hex, asc, runs);
            free(d);
            j->entries++;
            if (tick(j)) rc = -2;
        }
        free(e);
        if (own) close(fd);
        j->packs_done++;
    }
    if (rc == -2) { fclose(f); unlink(part); }
    else rc = close_part(f, part, out_txt, j);
    free(pk);
    for (int a = 0; a < n; a++) if (fds[a] >= 0) close(fds[a]);
    return rc;
}

/* ---------------------------------------------------------------- names */
static int namech(uint8_t c) { return isalnum(c) || c == '_' || c == '.' || c == '-'; }

/* Rules: >= 6 of A-Z a-z 0-9 _ - ., starts with a letter, has a lowercase letter, digit or _.
 * Plus noise filters for bytes in pixel/vertex data that happen to look like text:
 * a C string (control byte before, NUL after), no 4 equal characters in a row, at least
 * half the characters distinct, and either an _, three lowercase letters in a row or
 * the form CAPS+digits (LAUNCHER03). */
static int good_name(const char *s, int n)
{
    if (n < 6 || n > NF_NAMEMAX || !isalpha((unsigned char)s[0])) return 0;
    int has = 0, us = 0, low3 = 0, run = 0, cnt[128] = { 0 }, distinct = 0, mx = 0;
    for (int i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (islower(c) || isdigit(c) || c == '_') has = 1;
        if (c == '_') us = 1;
        run = islower(c) ? run + 1 : 0;
        if (run >= 3) low3 = 1;
        if (i >= 3 && c == s[i - 1] && c == s[i - 2] && c == s[i - 3]) return 0;
        if (!cnt[c]++) distinct++;
        if (cnt[c] > mx) mx = cnt[c];
    }
    if (!has || distinct * 2 < n || mx * 2 > n) return 0;
    if (us || low3) return 1;
    int i = 0;
    while (i < n && isupper((unsigned char)s[i])) i++;
    if (i < 4) return 0;
    while (i < n && isdigit((unsigned char)s[i])) i++;
    return i == n;
}

/* Calls fn for each name in d. */
static void scan_names(const uint8_t *d, size_t n, void (*fn)(const char *s, int len, void *u), void *u)
{
    size_t i = 0;
    while (i < n) {
        if (!namech(d[i])) { i++; continue; }
        size_t k = i;
        while (k < n && namech(d[k])) k++;
        int before_ok = i == 0 || d[i - 1] < 0x20;
        int after_ok = k < n && d[k] == 0;
        if (before_ok && after_ok && good_name((const char *)d + i, (int)(k - i))) fn((const char *)d + i, (int)(k - i), u);
        i = k;
    }
}

/* asset code: 1-4 lowercase letters, optional _, 2-4 digits, then end, _ or a letter ("cp005", "pc_01", "em016") */
static int asset_code(const char *s, int n)
{
    int i = 0;
    while (i < n && i < 5 && islower((unsigned char)s[i])) i++;
    if (i < 1 || i > 4) return 0;
    if (i < n && s[i] == '_') i++;
    int d0 = i;
    while (i < n && isdigit((unsigned char)s[i])) i++;
    int nd = i - d0;
    if (nd < 2 || nd > 4) return 0;
    if (i < n && !(s[i] == '_' || isalpha((unsigned char)s[i]))) return 0;
    return i;
}

/* Is a name a believable display label? Rejects bytes from pixel/vertex data that happen to
 * form a C string (VVUUU0, nqecvkqp, tEXtSoftware ...). Checked on 34,452 labels of the game:
 * keeps 99 % (cp005_face, LeftUpLeg, HIPctl_base, LAUNCHER03 ...), drops the noise. */
static int word_ok(const char *w, int n)
{
    if (n <= 2) return 1;
    int cons = 0, vow = 0;
    for (int i = 0; i < n; i++) {
        char c = (char)tolower((unsigned char)w[i]);
        if (i >= 2 && w[i] == w[i - 1] && w[i] == w[i - 2]) return 0;
        if (c == 'q' && (i + 1 >= n || tolower((unsigned char)w[i + 1]) != 'u')) return 0;
        int v = strchr("aeiouy", c) != NULL;
        vow += v;
        cons = v ? 0 : cons + 1;
        if (cons >= 5) return 0;
    }
    return !(n >= 5 && !vow);
}

int nf_plausible(const char *s)
{
    int n = (int)strlen(s);
    if (strstr(s, "tEXt") || strstr(s, "IDAT")) return 0;
    if (asset_code(s, n)) return 1;
    int letters = 0, vowels = 0, i = 0;
    while (i < n) {
        if (!isalpha((unsigned char)s[i])) { i++; continue; }
        /* one word: Capital? + lowercase run, or an upper-case run not followed by lowercase */
        int b = i;
        if (isupper((unsigned char)s[i]) && i + 1 < n && islower((unsigned char)s[i + 1])) { i++; while (i < n && islower((unsigned char)s[i])) i++; }
        else if (isupper((unsigned char)s[i])) {
            while (i < n && isupper((unsigned char)s[i])) i++;
            if (i < n && islower((unsigned char)s[i]) && i - b > 1) i--;   /* "HIPctl" -> "HI" + "Pctl" */
        } else while (i < n && islower((unsigned char)s[i])) i++;
        if (i == b) i++;
        if (!word_ok(s + b, i - b)) return 0;
        for (int k = b; k < i; k++) { letters++; if (strchr("aeiouyAEIOUY", s[k])) vowels++; }
    }
    if (letters < 3) return 0;
    return !(letters >= 6 && vowels * 8 < letters);
}

/* string set (open addressing) */
typedef struct { char **k; uint32_t *v; uint32_t cap, n; } SSet;
static uint32_t hstr(const char *s, int n) { uint32_t h = 2166136261u; for (int i = 0; i < n; i++) h = (h ^ (uint8_t)s[i]) * 16777619u; return h; }
static void sset_free(SSet *t) { for (uint32_t i = 0; i < t->cap; i++) free(t->k[i]); free(t->k); free(t->v); memset(t, 0, sizeof *t); }
static void sset_clear(SSet *t) { for (uint32_t i = 0; i < t->cap; i++) { free(t->k[i]); t->k[i] = NULL; } t->n = 0; }
/* returns slot index; *isnew = 1 if inserted. -1 out of memory */
static long sset_put(SSet *t, const char *s, int n, int *isnew)
{
    if ((t->n + 1) * 2 > t->cap) {
        uint32_t nc = t->cap ? t->cap * 2 : 1024;
        char **nk = calloc(nc, sizeof *nk);
        uint32_t *nv = calloc(nc, sizeof *nv);
        if (!nk || !nv) { free(nk); free(nv); return -1; }
        for (uint32_t i = 0; i < t->cap; i++) if (t->k[i]) {
            uint32_t h = hstr(t->k[i], (int)strlen(t->k[i])) & (nc - 1);
            while (nk[h]) h = (h + 1) & (nc - 1);
            nk[h] = t->k[i]; nv[h] = t->v[i];
        }
        free(t->k); free(t->v);
        t->k = nk; t->v = nv; t->cap = nc;
    }
    uint32_t h = hstr(s, n) & (t->cap - 1);
    while (t->k[h]) {
        if ((int)strlen(t->k[h]) == n && !memcmp(t->k[h], s, (size_t)n)) { *isnew = 0; return h; }
        h = (h + 1) & (t->cap - 1);
    }
    char *c = malloc((size_t)n + 1);
    if (!c) return -1;
    memcpy(c, s, (size_t)n); c[n] = 0;
    t->k[h] = c; t->v[h] = 0; t->n++;
    *isnew = 1;
    return h;
}

/* prefix statistics */
typedef struct { uint32_t count, npk, cappk; uint32_t *packs; } PfxInfo;

typedef struct {
    NfJob   *j;
    FILE    *names;
    SSet     pack;           /* names seen in this pack */
    SSet     pfx;            /* prefix -> index into info[] (stored in v) */
    PfxInfo *info;
    uint32_t ninfo, capinfo;
    SSet     codes;          /* asset codes in this pack -> count */
    uint32_t pack_id, entry, type;
    char     entry_label[NF_NAMEMAX + 1];
    int      entry_label_rank;  /* 3 code, 2 has _, 1 any */
    char     pack_first[NF_NAMEMAX + 1];
    int      oom;
} NameCtx;

static void name_hit(const char *s, int n, void *u)
{
    NameCtx *c = u;
    int code = asset_code(s, n);
    char tmp[NF_NAMEMAX + 1];
    snprintf(tmp, sizeof tmp, "%.*s", n, s);
    int ok = nf_plausible(tmp);
    int rank = !ok ? 0 : code ? 3 : memchr(s, '_', (size_t)n) ? 2 : 1;
    if (rank > c->entry_label_rank) { c->entry_label_rank = rank; snprintf(c->entry_label, sizeof c->entry_label, "%.*s", n, s); }
    int isnew = 0;
    if (sset_put(&c->pack, s, n, &isnew) < 0) { c->oom = 1; return; }
    if (!isnew) return;
    if (!c->pack_first[0] && ok) snprintf(c->pack_first, sizeof c->pack_first, "%.*s", n, s);
    fprintf(c->names, "%05u\t%u\t%04X\t%.*s\n", c->pack_id, c->entry, c->type, n, s);
    c->j->names++;
    if (code) {
        long k = sset_put(&c->codes, s, code, &isnew);
        if (k >= 0) c->codes.v[k]++;
    }
    /* prefix: up to the first _ or digit */
    int pl = 0;
    while (pl < n && s[pl] != '_' && !isdigit((unsigned char)s[pl])) pl++;
    if (!pl) pl = n;
    long k = sset_put(&c->pfx, s, pl, &isnew);
    if (k < 0) { c->oom = 1; return; }
    if (isnew) {
        if (c->ninfo == c->capinfo) {
            uint32_t nc = c->capinfo ? c->capinfo * 2 : 1024;
            PfxInfo *t = realloc(c->info, nc * sizeof *t);
            if (!t) { c->oom = 1; return; }
            c->info = t; c->capinfo = nc;
        }
        memset(&c->info[c->ninfo], 0, sizeof(PfxInfo));
        c->pfx.v[k] = c->ninfo++;
    }
    PfxInfo *pi = &c->info[c->pfx.v[k]];
    pi->count++;
    if (!pi->npk || pi->packs[pi->npk - 1] != c->pack_id) {
        if (pi->npk == pi->cappk) {
            uint32_t nc = pi->cappk ? pi->cappk * 2 : 4;
            uint32_t *t = realloc(pi->packs, nc * sizeof *t);
            if (!t) { c->oom = 1; return; }
            pi->packs = t; pi->cappk = nc;
        }
        pi->packs[pi->npk++] = c->pack_id;
    }
}

typedef struct { const char *name; uint32_t idx; } PfxSort;
static const PfxInfo *g_sort_info;
static int pfx_cmp(const void *a, const void *b)
{
    const PfxSort *x = a, *y = b;
    uint32_t cx = g_sort_info[x->idx].count, cy = g_sort_info[y->idx].count;
    if (cx != cy) return cx > cy ? -1 : 1;
    return strcmp(x->name, y->name);
}

int nf_find_names(const char *const *archives, int n, const char *out_dir, NfJob *j)
{
    int fds[8];
    if (n > 8) n = 8;
    uint32_t np = 0;
    PackRef *pk = list_packs(archives, n, fds, &np, j);
    if (!pk) return -1;
    char p_names[1100], p_pfx[1100], p_lab[1100], part1[1100], part2[1100], part3[1100];
    snprintf(p_names, sizeof p_names, "%s/names.txt", out_dir);
    snprintf(p_pfx, sizeof p_pfx, "%s/names_by_prefix.txt", out_dir);
    snprintf(p_lab, sizeof p_lab, "%s/pack_names.txt", out_dir);
    NameCtx c;
    memset(&c, 0, sizeof c);
    c.j = j;
    c.names = open_part(p_names, part1, sizeof part1);
    FILE *lab = open_part(p_lab, part3, sizeof part3);
    if (!c.names || !lab) {
        if (c.names) { fclose(c.names); unlink(part1); }
        if (lab) { fclose(lab); unlink(part3); }
        snprintf(j->error, sizeof j->error, "cannot write in %s: %s", out_dir, strerror(errno));
        free(pk); for (int a = 0; a < n; a++) if (fds[a] >= 0) close(fds[a]);
        return -1;
    }
    j->packs_total = np;
    fprintf(c.names, "# Star Ocean 4 names: each distinct name once per pack%s\n# pack\tentry\ttype\tname\n",
            j->skip_remaster ? " (IDs 10000+ skipped)" : "");
    fprintf(lab, "# pack\tentry\tlabel   (entry '-' = label of the whole pack)\n");
    int rc = 0;
    for (uint32_t pi = 0; pi < np && rc == 0 && !c.oom; pi++) {
        const PackRef *p = &pk[pi];
        int own, fd = pack_fd(archives, fds, p, &own);
        uint32_t cnt = 0;
        uint64_t psize = 0;
        snprintf(j->current, sizeof j->current, "pack %05u", p->id);
        KEnt *e = fd >= 0 ? kcap_table(fd, p, &cnt, &psize) : NULL;
        j->packs_done++;
        if (!e) { if (own) close(fd); if (tick(j)) rc = -2; continue; }
        j->packs_kcap++;
        sset_clear(&c.pack);
        sset_clear(&c.codes);
        c.pack_id = p->id;
        c.pack_first[0] = 0;
        for (uint32_t i = 0; i < cnt && rc == 0; i++) {
            snprintf(j->current, sizeof j->current, "pack %05u entry %u/%u", p->id, i, cnt);
            size_t dn = 0;
            int mode;
            uint32_t full;
            char err[128];
            uint8_t *d = entry_data(fd, p, psize, &e[i], 0, &dn, &mode, &full, err, sizeof err);
            if (!d) j->errors++;
            else {
                c.entry = i; c.type = e[i].type;
                c.entry_label[0] = 0; c.entry_label_rank = 0;
                scan_names(d, dn, name_hit, &c);
                if (c.entry_label[0]) fprintf(lab, "%05u\t%u\t%s\n", p->id, i, c.entry_label);
                j->bytes_out += dn;
                free(d);
            }
            j->entries++;
            if (tick(j)) rc = -2;
        }
        /* pack label: most frequent asset code + its shortest longer name */
        const char *best = NULL;
        uint32_t bc = 0;
        for (uint32_t k = 0; k < c.codes.cap; k++)
            if (c.codes.k[k] && (c.codes.v[k] > bc || (c.codes.v[k] == bc && best && strcmp(c.codes.k[k], best) < 0))) { best = c.codes.k[k]; bc = c.codes.v[k]; }
        if (best) {
            const char *ex = NULL;
            size_t bl = strlen(best);
            for (uint32_t k = 0; k < c.pack.cap; k++) {
                const char *s = c.pack.k[k];
                if (s && !strncmp(s, best, bl) && strlen(s) > bl + 1 && (!ex || strlen(s) < strlen(ex) || (strlen(s) == strlen(ex) && strcmp(s, ex) < 0))) ex = s;
            }
            fprintf(lab, "%05u\t-\t%s%s%s\n", p->id, best, ex ? "  " : "", ex ? ex : "");
        } else if (c.pack_first[0]) fprintf(lab, "%05u\t-\t%s\n", p->id, c.pack_first);
        free(e);
        if (own) close(fd);
    }
    if (c.oom && rc == 0) { snprintf(j->error, sizeof j->error, "out of memory"); rc = -1; }
    if (rc != 0) { fclose(c.names); unlink(part1); fclose(lab); unlink(part3); }
    else {
        rc = close_part(c.names, part1, p_names, j);
        if (close_part(lab, part3, p_lab, j) != 0) rc = -1;
    }
    if (rc == 0) {
        FILE *f = open_part(p_pfx, part2, sizeof part2);
        if (!f) { snprintf(j->error, sizeof j->error, "cannot write %s", p_pfx); rc = -1; }
        else {
            PfxSort *s = malloc(sizeof(PfxSort) * (c.ninfo ? c.ninfo : 1));
            uint32_t ns = 0;
            if (s) for (uint32_t k = 0; k < c.pfx.cap; k++) if (c.pfx.k[k]) { s[ns].name = c.pfx.k[k]; s[ns].idx = c.pfx.v[k]; ns++; }
            g_sort_info = c.info;
            if (s) qsort(s, ns, sizeof *s, pfx_cmp);
            fprintf(f, "# names grouped by the prefix before the first _ or digit\n# prefix\tnames\tpacks\tpack IDs\n");
            for (uint32_t k = 0; s && k < ns; k++) {
                const PfxInfo *pi = &c.info[s[k].idx];
                fprintf(f, "%s\t%u\t%u\t", s[k].name, pi->count, pi->npk);
                for (uint32_t q = 0; q < pi->npk; q++) fprintf(f, "%s%05u", q ? "," : "", pi->packs[q]);
                fputc('\n', f);
            }
            j->prefixes = ns;
            free(s);
            rc = close_part(f, part2, p_pfx, j);
        }
    }
    for (uint32_t k = 0; k < c.ninfo; k++) free(c.info[k].packs);
    free(c.info);
    sset_free(&c.pack); sset_free(&c.pfx); sset_free(&c.codes);
    free(pk);
    for (int a = 0; a < n; a++) if (fds[a] >= 0) close(fds[a]);
    return rc;
}

/* ---------------------------------------------------------------- search */
/* lowercase, without _ - . (so "pc01" finds "pc_01_eye1") */
static void squash(const char *s, char *o, size_t on)
{
    size_t k = 0;
    for (; *s && k + 1 < on; s++) if (*s != '_' && *s != '-' && *s != '.' && *s != ' ') o[k++] = (char)tolower((unsigned char)*s);
    o[k] = 0;
}

int nf_search(const char *names_txt, const char *word, int max, void (*fn)(const char *line, void *u), void *u,
              uint32_t *packs, uint32_t *entries)
{
    FILE *f = fopen(names_txt, "r");
    if (!f) return -1;
    char w[128];
    squash(word, w, sizeof w);
    int total = 0, shown = 0;
    uint32_t lastp = 0xFFFFFFFFu, laste = 0xFFFFFFFFu, np = 0, ne = 0;
    /* packs are written in ascending order, so distinct counting by "changed since last" is exact */
    char line[512];
    while (fgets(line, sizeof line, f)) {
        if (line[0] == '#') continue;
        size_t l = strlen(line);
        while (l && (line[l - 1] == '\n' || line[l - 1] == '\r')) line[--l] = 0;
        char *t = strrchr(line, '\t');
        if (!t) continue;
        char nm[160];
        squash(t + 1, nm, sizeof nm);
        if (w[0] && !strstr(nm, w)) continue;
        total++;
        uint32_t p = (uint32_t)strtoul(line, NULL, 10);
        const char *t1 = strchr(line, '\t');
        uint32_t e = t1 ? (uint32_t)strtoul(t1 + 1, NULL, 10) : 0;
        if (p != lastp) { np++; ne++; lastp = p; laste = e; }
        else if (e != laste) { ne++; laste = e; }
        if (shown < max && fn) { fn(line, u); shown++; }
    }
    fclose(f);
    if (packs) *packs = np;
    if (entries) *entries = ne;
    return total;
}

/* ---------------------------------------------------------------- labels */
typedef struct { char best[NF_NAMEMAX + 1]; int rank; char first[NF_NAMEMAX + 1]; } LabCtx;
static void lab_hit(const char *s, int n, void *u)
{
    LabCtx *c = u;
    char tmp[NF_NAMEMAX + 1];
    snprintf(tmp, sizeof tmp, "%.*s", n, s);
    if (!nf_plausible(tmp)) return;
    int code = asset_code(s, n);
    int rank = code ? 3 : memchr(s, '_', (size_t)n) ? 2 : 1;
    if (rank > c->rank) { c->rank = rank; snprintf(c->best, sizeof c->best, "%.*s", n, s); }
    if (!c->first[0]) snprintf(c->first, sizeof c->first, "%.*s", n, s);
}

int nf_label_buf(const uint8_t *d, size_t n, char *out, size_t on)
{
    LabCtx c;
    memset(&c, 0, sizeof c);
    scan_names(d, n, lab_hit, &c);
    if (!c.best[0]) { if (on) out[0] = 0; return -1; }
    snprintf(out, on, "%s", c.best);
    return 0;
}

typedef struct { uint32_t pack, entry; char *label; } LabRow;
static LabRow *g_lab;
static uint32_t g_nlab;
static int g_lab_loaded;

static int labrow_cmp(const void *a, const void *b)
{
    const LabRow *x = a, *y = b;
    if (x->pack != y->pack) return x->pack < y->pack ? -1 : 1;
    return x->entry < y->entry ? -1 : x->entry > y->entry;
}

void nf_labels_free(void)
{
    for (uint32_t i = 0; i < g_nlab; i++) free(g_lab[i].label);
    free(g_lab);
    g_lab = NULL; g_nlab = 0; g_lab_loaded = 0;
}

int nf_labels_loaded(void) { return g_lab_loaded; }

int nf_labels_load(const char *path)
{
    FILE *f = fopen(path, "r");
    if (!f) return -1;
    nf_labels_free();
    uint32_t cap = 0;
    char line[512];
    while (fgets(line, sizeof line, f)) {
        if (line[0] == '#') continue;
        size_t l = strlen(line);
        while (l && (line[l - 1] == '\n' || line[l - 1] == '\r')) line[--l] = 0;
        char *t1 = strchr(line, '\t');
        if (!t1) continue;
        char *t2 = strchr(t1 + 1, '\t');
        if (!t2) continue;
        if (g_nlab == cap) {
            uint32_t nc = cap ? cap * 2 : 4096;
            LabRow *t = realloc(g_lab, nc * sizeof *t);
            if (!t) break;
            g_lab = t; cap = nc;
        }
        LabRow *r = &g_lab[g_nlab];
        r->pack = (uint32_t)strtoul(line, NULL, 10);
        r->entry = t1[1] == '-' ? 0xFFFFFFFFu : (uint32_t)strtoul(t1 + 1, NULL, 10);
        char first[NF_NAMEMAX + 1];
        snprintf(first, sizeof first, "%s", t2 + 1);
        char *sp = strchr(first, ' ');
        if (sp) *sp = 0;
        if (!nf_plausible(first)) continue;     /* index from an older version: skip noisy labels */
        r->label = strdup(t2 + 1);
        if (!r->label) break;
        g_nlab++;
    }
    fclose(f);
    if (g_nlab) qsort(g_lab, g_nlab, sizeof *g_lab, labrow_cmp);
    g_lab_loaded = 1;
    return 0;
}

static const char *lab_find(uint32_t pack, uint32_t entry)
{
    uint32_t lo = 0, hi = g_nlab;
    while (lo < hi) {
        uint32_t m = (lo + hi) / 2;
        if (g_lab[m].pack < pack || (g_lab[m].pack == pack && g_lab[m].entry < entry)) lo = m + 1;
        else hi = m;
    }
    return lo < g_nlab && g_lab[lo].pack == pack && g_lab[lo].entry == entry ? g_lab[lo].label : NULL;
}

const char *nf_label_pack(uint32_t pack) { return lab_find(pack, 0xFFFFFFFFu); }
const char *nf_label_entry(uint32_t pack, uint32_t entry) { return lab_find(pack, entry); }

/* ---------------------------------------------------------------- live labels */
typedef struct { char best[NF_NAMEMAX + 1]; int rank; char code[16]; uint32_t codecnt[32]; char codes[32][16]; int ncodes; } LiveCtx;
static void live_hit(const char *s, int n, void *u)
{
    LiveCtx *c = u;
    int code = asset_code(s, n);
    char tmp[NF_NAMEMAX + 1];
    snprintf(tmp, sizeof tmp, "%.*s", n, s);
    if (!nf_plausible(tmp)) return;
    int rank = code ? 3 : memchr(s, '_', (size_t)n) ? 2 : 1;
    if (rank > c->rank) { c->rank = rank; snprintf(c->best, sizeof c->best, "%.*s", n, s); }
    if (code && code < 16) {
        int k;
        for (k = 0; k < c->ncodes; k++) if ((int)strlen(c->codes[k]) == code && !memcmp(c->codes[k], s, (size_t)code)) break;
        if (k == c->ncodes && k < 32) { snprintf(c->codes[k], 16, "%.*s", code, s); c->codecnt[k] = 0; c->ncodes++; }
        if (k < 32) c->codecnt[k]++;
    }
}

static void live_finish(LiveCtx *c, char *out, size_t on)
{
    int bi = -1;
    for (int k = 0; k < c->ncodes; k++) if (bi < 0 || c->codecnt[k] > c->codecnt[bi]) bi = k;
    if (bi >= 0 && strncmp(c->best, c->codes[bi], strlen(c->codes[bi]))) snprintf(out, on, "%s  %s", c->codes[bi], c->best);
    else snprintf(out, on, "%s", c->best);
}

int nf_label_range(int fd, uint64_t off, uint64_t size, char *out, size_t on)
{
    if (on) out[0] = 0;
    LiveCtx c;
    memset(&c, 0, sizeof c);
    PackRef p = { 0, 0, off, size };
    uint32_t cnt = 0;
    uint64_t psize = 0;
    KEnt *e = kcap_table(fd, &p, &cnt, &psize);
    if (e) {
        for (uint32_t i = 0; i < cnt && i < 12; i++) {
            size_t dn = 0; int mode; uint32_t full; char err[96];
            uint8_t *d = entry_data(fd, &p, psize, &e[i], 0x10000, &dn, &mode, &full, err, sizeof err);
            if (d) { scan_names(d, dn, live_hit, &c); free(d); }
            if (c.ncodes >= 3) break;
        }
        free(e);
    } else {
        KEnt one = { 0, 0, 0, (uint32_t)(size > 0xFFFFFFFFu ? 0xFFFFFFFFu : size), 0 };
        size_t dn = 0; int mode; uint32_t full; char err[96];
        uint8_t *d = entry_data(fd, &p, size, &one, 0x40000, &dn, &mode, &full, err, sizeof err);
        if (d) { scan_names(d, dn, live_hit, &c); free(d); }
    }
    if (!c.best[0]) return -1;
    live_finish(&c, out, on);
    return 0;
}

int nf_label_file(const char *path, char *out, size_t on)
{
    if (on) out[0] = 0;
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -1;
    struct stat st;
    int rc = -1;
    if (fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_size > 0) rc = nf_label_range(fd, 0, (uint64_t)st.st_size, out, on);
    close(fd);
    return rc;
}
