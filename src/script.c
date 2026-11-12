/*
 * script.c - batch runner (see script.h). Each command calls straight into the
 * already-tested engines; nothing here executes code or spawns processes.
 */
#include "script.h"
#include "names.h"
#include "cpk.h"
#include "formats.h"
#include "archive_create.h"
#include "fileops.h"

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

#define SMAX 1024

/* host logger (provided by the app; a weak stub lets tests link standalone) */
void logx(const char *fmt, ...);
#if defined(SCRIPT_TEST_STUB)
__attribute__((weak)) void logx(const char *fmt, ...) { (void)fmt; }
#endif

typedef struct {
    char base[SMAX];     /* cd */
    char dest[SMAX];     /* dest */
    int  stop_on_error;
    FILE *log;
    ScriptJob *job;
} Ctx;

static void slog(Ctx *c, const char *fmt, ...)
{
    char line[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    logx("SCRIPT: %s", line);
    if (c->log) { fprintf(c->log, "%s\n", line); fflush(c->log); }
}

static void seterr(Ctx *c, const char *fmt, ...)
{
    c->job->failed++;
    char line[256];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    if (!c->job->error[0]) snprintf(c->job->error, sizeof(c->job->error), "%s", line);
    slog(c, "ERROR: %s", line);
}

/* Output may only go to /data, /mnt/usbN or /mnt/ext0 - never system folders. */
static int dest_ok(const char *p)
{
    if (ac_path_within(p, "/data") || ac_path_within(p, "/mnt/ext0")) return 1;
    if (!strncmp(p, "/mnt/usb", 8) && isdigit((unsigned char)p[8]) && (p[9] == 0 || p[9] == '/')) return 1;
    return 0;
}

static int smkdirs(const char *path)
{
    char t[SMAX];
    snprintf(t, sizeof(t), "%s", path);
    for (char *p = t + 1; *p; p++)
        if (*p == '/') { *p = 0; if (mkdir(t, 0777) && errno != EEXIST) return -1; *p = '/'; }
    return mkdir(t, 0777) && errno != EEXIST ? -1 : 0;
}

/* Resolve a path argument against `base` unless it is already absolute. */
static void resolve(Ctx *c, const char *arg, char *out, size_t n)
{
    if (arg[0] == '/') snprintf(out, n, "%s", arg);
    else if (c->base[0]) snprintf(out, n, "%s/%s", c->base, arg);
    else snprintf(out, n, "%s", arg);
}

static void stem_of(const char *path, char *out, size_t n)
{
    const char *b = strrchr(path, '/');
    b = b ? b + 1 : path;
    snprintf(out, n, "%s", b);
    char *d = strrchr(out, '.');
    if (d && d != out) *d = 0;
}

/* progress bridge for the engines */
static int cpk_cb(CpkProgress *p, void *u) { (void)p; Ctx *c = u; return c->job->cb ? c->job->cb(c->job->user) : 0; }
static int fmt_cb(void *u) { Ctx *c = u; return c->job->cb ? c->job->cb(c->job->user) : 0; }
static int ac_cb(AcJob *j, void *u) { (void)j; Ctx *c = u; return c->job->cb ? c->job->cb(c->job->user) : 0; }
static int fo_cb(FoJob *j, void *u) { (void)j; Ctx *c = u; return c->job->cb ? c->job->cb(c->job->user) : 0; }

/* Split a line into argv (whitespace), honouring simple "double quotes". */
static int tokenize(char *s, char **argv, int max)
{
    int n = 0;
    while (*s && n < max) {
        while (*s == ' ' || *s == '\t') s++;
        if (!*s) break;
        if (*s == '#') break;                     /* rest of the line is a comment */
        if (*s == '"') { argv[n++] = ++s; while (*s && *s != '"') s++; if (*s) *s++ = 0; }
        else { argv[n++] = s; while (*s && *s != ' ' && *s != '\t') s++; if (*s) *s++ = 0; }
    }
    return n;
}

static int need_dest(Ctx *c)
{
    if (!c->dest[0]) { seterr(c, "no 'dest' set yet"); return 0; }
    if (!dest_ok(c->dest)) { seterr(c, "dest %s is not writable storage", c->dest); return 0; }
    if (smkdirs(c->dest) != 0) { seterr(c, "cannot create dest %s", c->dest); return 0; }
    return 1;
}

/* Expand a possibly-globbed arg (*.ext or *) in c->base into matches. For a
 * non-glob arg, returns the single resolved path. cb is called per match. */
static int for_each(Ctx *c, const char *arg, void (*fn)(Ctx *, const char *))
{
    const char *star = strchr(arg, '*');
    if (!star) { char p[SMAX]; resolve(c, arg, p, sizeof(p)); fn(c, p); return 1; }
    const char *suffix = star + 1;           /* e.g. ".dds" or "" */
    const char *dir = c->base[0] ? c->base : ".";
    DIR *d = opendir(dir);
    if (!d) { seterr(c, "cannot open folder %s", dir); return 0; }
    struct dirent *de;
    int count = 0;
    while ((de = readdir(d))) {
        if (de->d_name[0] == '.') continue;
        size_t ln = strlen(de->d_name), ls = strlen(suffix);
        if (ls && (ln < ls || strcasecmp(de->d_name + ln - ls, suffix))) continue;
        char p[SMAX];
        snprintf(p, sizeof(p), "%s/%s", dir, de->d_name);
        struct stat st;
        if (stat(p, &st) == 0 && S_ISREG(st.st_mode)) { fn(c, p); count++; }
    }
    closedir(d);
    if (!count) slog(c, "note: nothing matched %s", arg);
    return 1;
}

/* ---- individual commands ---- */
static void do_unpack_one(Ctx *c, const char *path)
{
    char stem[256], out[SMAX];
    stem_of(path, stem, sizeof(stem));
    snprintf(out, sizeof(out), "%s/%s_unpacked", c->dest, stem);
    FmtJob fj;
    memset(&fj, 0, sizeof(fj));
    fj.cb = fmt_cb;
    fj.user = c;
    int rc = fmt_unpack_path(path, out, &fj);
    c->job->files += fj.files;
    if (rc == 0 && !fj.failed) { c->job->ok++; slog(c, "unpack %s -> %s (%u files, %s)", path, out, fj.files, fj.kind[0] ? fj.kind : "ok"); }
    else if (rc == 1) seterr(c, "unpack %s: not a format the tool unpacks", path);
    else seterr(c, "unpack %s: %s", path, fj.error[0] ? fj.error : "failed");
}

static void do_convert_one(Ctx *c, const char *path)
{
    int fd = open(path, O_RDONLY);
    if (fd < 0) { seterr(c, "convert %s: cannot open", path); return; }
    off_t end = lseek(fd, 0, SEEK_END);
    uint8_t head[32] = { 0 };
    int n = pread(fd, head, sizeof(head), 0);
    close(fd);
    if (n <= 0 || !img_is_image(head, (size_t)n)) { slog(c, "convert %s: not an image, skipped", path); return; }
    if (end <= 0 || end > (256 << 20)) { seterr(c, "convert %s: too large", path); return; }
    uint8_t *buf = malloc((size_t)end);
    if (!buf) { seterr(c, "convert %s: out of memory", path); return; }
    fd = open(path, O_RDONLY);
    int ok = fd >= 0 && pread(fd, buf, (size_t)end, 0) == end;
    if (fd >= 0) close(fd);
    uint32_t w, h;
    char desc[64], err[128], stem[256], out[SMAX];
    uint8_t *rgba = ok ? img_decode(buf, (size_t)end, &w, &h, desc, sizeof(desc), err, sizeof(err)) : NULL;
    free(buf);
    if (!rgba) { seterr(c, "convert %s: %s", path, ok ? err : "read error"); return; }
    stem_of(path, stem, sizeof(stem));
    snprintf(out, sizeof(out), "%s/%s.png", c->dest, stem);
    int rc = png_write(out, rgba, w, h);
    free(rgba);
    if (rc == 0) { c->job->ok++; c->job->files++; slog(c, "convert %s -> %s (%ux%u, %s)", path, out, w, h, desc); }
    else seterr(c, "convert %s: cannot write %s", path, out);
}

static void cmd_list(Ctx *c, const char *arg)
{
    char path[SMAX];
    resolve(c, arg, path, sizeof(path));
    Cpk k;
    if (cpk_open(&k, path) != 0) { seterr(c, "list %s: not a readable archive (%s)", path, k.error); cpk_close(&k); return; }
    char stem[256], out[SMAX];
    cpk_stem(path, stem, sizeof(stem));
    snprintf(out, sizeof(out), "%s/listing_%s.txt", c->dest, stem);
    int rc = cpk_write_listing(&k, out);
    if (rc == 0) { c->job->ok++; c->job->files++; slog(c, "list %s -> %s (%u files)", path, out, k.n); }
    else seterr(c, "list %s: cannot write %s", path, out);
    cpk_close(&k);
}

static void cmd_extract(Ctx *c, char **argv, int argc, int all)
{
    char path[SMAX];
    resolve(c, argv[1], path, sizeof(path));
    Cpk k;
    if (cpk_open(&k, path) != 0) { seterr(c, "extract %s: not a readable archive (%s)", path, k.error); cpk_close(&k); return; }
    char stem[256], out[SMAX];
    cpk_stem(path, stem, sizeof(stem));
    snprintf(out, sizeof(out), "%s/%s", c->dest, stem);
    if (smkdirs(out) != 0) { seterr(c, "extract: cannot create %s", out); cpk_close(&k); return; }
    if (all) {
        CpkOptions o = { 0, 1 };
        CpkProgress pr;
        memset(&pr, 0, sizeof(pr));
        int rc = cpk_extract_all(&k, out, &o, NULL, &pr, cpk_cb, c);
        c->job->files += pr.files_ok;
        if (rc == 0 && !pr.files_failed) { c->job->ok++; slog(c, "extractall %s -> %s (%u files, %u skipped)", path, out, pr.files_ok, pr.files_skipped); }
        else if (rc == -2) { c->job->cancelled = 1; }
        else seterr(c, "extractall %s: %u failed (%s)", path, pr.files_failed, pr.error);
        cpk_close(&k);
        return;
    }
    int saved_any = 0;
    for (int a = 2; a < argc; a++) {
        /* ranges like 0-3, else a single id/name */
        unsigned lo, hi;
        char dash;
        if (sscanf(argv[a], "%u%c%u", &lo, &dash, &hi) == 3 && dash == '-') {
            if (hi < lo) { unsigned t = lo; lo = hi; hi = t; }
            if (hi - lo > 4095) hi = lo + 4095;
        } else { lo = hi = 0; }
        int is_range = (lo != hi || (argv[a][0] >= '0' && argv[a][0] <= '9' && strchr(argv[a], '-')));
        if (is_range) {
            for (unsigned id = lo; id <= hi; id++) {
                char q[16];
                snprintf(q, sizeof(q), "%u", id);
                int idx = cpk_find(&k, q);
                if (idx < 0) continue;
                char saved[SMAX], err[128];
                if (cpk_extract_one(&k, (uint32_t)idx, out, saved, sizeof(saved), err, sizeof(err)) == 0) { c->job->files++; saved_any++; }
                else seterr(c, "extract id %u: %s", id, err);
                if (c->job->cb && c->job->cb(c->job->user)) { c->job->cancelled = 1; break; }
            }
        } else {
            int idx = cpk_find(&k, argv[a]);
            if (idx < 0) { seterr(c, "extract %s: no entry \"%s\"", stem, argv[a]); continue; }
            char saved[SMAX], err[128];
            if (cpk_extract_one(&k, (uint32_t)idx, out, saved, sizeof(saved), err, sizeof(err)) == 0) { c->job->files++; saved_any++; }
            else seterr(c, "extract %s: %s", argv[a], err);
        }
    }
    if (saved_any) { c->job->ok++; slog(c, "extract %s -> %s (%d files)", path, out, saved_any); }
    cpk_close(&k);
}

static void cmd_dump(Ctx *c, char **argv, int argc)
{
    if (argc < 4) { seterr(c, "dump needs: dump <file> <offset> <length>"); return; }
    char path[SMAX];
    resolve(c, argv[1], path, sizeof(path));
    uint64_t off = strtoull(argv[2], NULL, 0), len = strtoull(argv[3], NULL, 0);
    if (!len) { seterr(c, "dump: length must be > 0"); return; }
    char stem[256], out[SMAX], err[128];
    stem_of(path, stem, sizeof(stem));
    snprintf(out, sizeof(out), "%s/%s_%llx_%llx.bin", c->dest, stem, (unsigned long long)off, (unsigned long long)len);
    CpkProgress pr;
    memset(&pr, 0, sizeof(pr));
    int rc = cpk_dump_range(path, off, len, out, &pr, cpk_cb, c, err, sizeof(err));
    if (rc == 0) { c->job->ok++; c->job->files++; slog(c, "dump %s 0x%llx+0x%llx -> %s", path, (unsigned long long)off, (unsigned long long)len, out); }
    else seterr(c, "dump %s: %s", path, err);
}

static void cmd_copy(Ctx *c, char **argv, int argc)
{
    if (argc < 3) { seterr(c, "copy needs: copy <src> <dst>"); return; }
    char src[SMAX], dst[SMAX];
    resolve(c, argv[1], src, sizeof(src));
    resolve(c, argv[2], dst, sizeof(dst));
    if (!dest_ok(dst)) { seterr(c, "copy: destination %s is not writable storage", dst); return; }
    FoJob fj;
    fo_reset(&fj);
    if (fo_copy(&fj, src, dst, fo_cb, c) == 0 && !fj.failed) { c->job->ok++; c->job->files++; slog(c, "copy %s -> %s", src, dst); }
    else seterr(c, "copy %s -> %s failed", src, dst);
}

static void cmd_zip(Ctx *c, char **argv, int argc)
{
    if (argc < 3) { seterr(c, "zip needs: zip <out.zip> <path>..."); return; }
    char out[SMAX];
    resolve(c, argv[1], out, sizeof(out));
    if (!dest_ok(out)) { seterr(c, "zip: output %s is not writable storage", out); return; }
    static char paths[AC_MAX_ITEMS][SMAX];
    const char *pv[AC_MAX_ITEMS];
    int n = 0;
    for (int a = 2; a < argc && n < AC_MAX_ITEMS; a++) {
        const char *star = strchr(argv[a], '*');
        if (!star) { resolve(c, argv[a], paths[n], sizeof(paths[n])); pv[n] = paths[n]; n++; continue; }
        const char *suffix = star + 1, *dir = c->base[0] ? c->base : ".";
        DIR *d = opendir(dir);
        if (!d) continue;
        struct dirent *de;
        while ((de = readdir(d)) && n < AC_MAX_ITEMS) {
            if (de->d_name[0] == '.') continue;
            size_t ln = strlen(de->d_name), ls = strlen(suffix);
            if (ls && (ln < ls || strcasecmp(de->d_name + ln - ls, suffix))) continue;
            snprintf(paths[n], sizeof(paths[n]), "%s/%s", dir, de->d_name);
            struct stat st;
            if (stat(paths[n], &st) == 0 && S_ISREG(st.st_mode)) { pv[n] = paths[n]; n++; }
        }
        closedir(d);
    }
    if (!n) { seterr(c, "zip %s: nothing matched", out); return; }
    AcJob j;
    memset(&j, 0, sizeof(j));
    snprintf(j.out_path, sizeof(j.out_path), "%s", out);
    if (c->base[0]) snprintf(j.base_dir, sizeof(j.base_dir), "%s", c->base);
    j.deflate = 1;
    ac_scan(&j, pv, n);
    if (ac_run(&j, pv, n, ac_cb, c) == 0 && !j.failed) { c->job->ok++; c->job->files++; slog(c, "zip %s (%u files)", out, j.files_done); }
    else seterr(c, "zip %s failed: %s", out, j.error);
}

/* Execute one already-tokenised line. */
static void run_line(Ctx *c, char **argv, int argc)
{
    const char *cmd = argv[0];
    if (!strcmp(cmd, "cd")) { if (argc < 2) { seterr(c, "cd needs a folder"); return; } resolve(c, argv[1], c->base, sizeof(c->base)); slog(c, "cd %s", c->base); c->job->ok++; }
    else if (!strcmp(cmd, "dest")) {
        if (argc < 2) { seterr(c, "dest needs a folder"); return; }
        char d[SMAX];
        resolve(c, argv[1], d, sizeof(d));
        if (!dest_ok(d)) { seterr(c, "dest %s is not writable storage (/data, /mnt/usbN, /mnt/ext0)", d); return; }
        if (smkdirs(d) != 0) { seterr(c, "cannot create dest %s", d); return; }
        snprintf(c->dest, sizeof(c->dest), "%s", d);
        /* (re)open the per-run log inside dest */
        if (!c->log) {
            char lp[SMAX + 16];
            snprintf(lp, sizeof(lp), "%s/script_log.txt", c->dest);
            c->log = fopen(lp, "a");
            if (c->log) fprintf(c->log, "# ---- script run ----\n");
        }
        slog(c, "dest %s", c->dest);
        c->job->ok++;
    }
    else if (!strcmp(cmd, "mkdir")) { if (argc < 2) { seterr(c, "mkdir needs a folder"); return; } char d[SMAX]; resolve(c, argv[1], d, sizeof(d)); if (dest_ok(d) && smkdirs(d) == 0) { c->job->ok++; slog(c, "mkdir %s", d); } else seterr(c, "mkdir %s failed", d); }
    else if (!strcmp(cmd, "echo")) { char b[800] = ""; for (int a = 1; a < argc; a++) { strncat(b, argv[a], sizeof(b) - strlen(b) - 2); strncat(b, " ", sizeof(b) - strlen(b) - 1); } slog(c, "%s", b); c->job->ok++; }
    else if (!strcmp(cmd, "stop-on-error")) { c->stop_on_error = argc > 1 && !strcmp(argv[1], "off") ? 0 : 1; c->job->ok++; }
    else if (!need_dest(c)) { /* remaining commands all write output */ return; }
    else if (!strcmp(cmd, "list")) { if (argc < 2) { seterr(c, "list needs an archive"); return; } cmd_list(c, argv[1]); }
    else if (!strcmp(cmd, "extract")) { if (argc < 3) { seterr(c, "extract needs: extract <archive> <id|name|a-b>..."); return; } cmd_extract(c, argv, argc, 0); }
    else if (!strcmp(cmd, "extractall")) { if (argc < 2) { seterr(c, "extractall needs an archive"); return; } cmd_extract(c, argv, argc, 1); }
    else if (!strcmp(cmd, "unpackid")) {
        if (argc < 3) { seterr(c, "unpackid needs: unpackid <archive> <id|a-b>..."); return; }
        char path[SMAX];
        resolve(c, argv[1], path, sizeof(path));
        Cpk k;
        if (cpk_open(&k, path) != 0) { seterr(c, "unpackid %s: not a readable archive (%s)", path, k.error); cpk_close(&k); return; }
        char stem[256];
        cpk_stem(path, stem, sizeof(stem));
        int done = 0;
        for (int a = 2; a < argc && !c->job->cancelled; a++) {
            unsigned lo = 0, hi = 0;
            char dash = 0;
            int nr = sscanf(argv[a], "%u%c%u", &lo, &dash, &hi);
            if (nr != 3 || dash != '-') { if (sscanf(argv[a], "%u", &lo) != 1) { seterr(c, "unpackid: '%s' is not an ID", argv[a]); continue; } hi = lo; }
            if (hi < lo) { unsigned t = lo; lo = hi; hi = t; }
            if (hi - lo > 4095) hi = lo + 4095;
            for (unsigned id = lo; id <= hi && !c->job->cancelled; id++) {
                char q[16];
                snprintf(q, sizeof(q), "%u", id);
                int idx = cpk_find(&k, q);
                if (idx < 0) { if (lo == hi) seterr(c, "unpackid %s: no entry %u", stem, id); continue; }
                const CpkEntry *e = &k.e[idx];
                char lab[16], out[SMAX], desc[128];
                snprintf(lab, sizeof(lab), "%05u", e->id);
                if (e->beyond_end || !fmt_identify(k.fd, e->offset, e->size, desc, sizeof(desc))) { slog(c, "unpackid %s/%s: %s, skipped", stem, lab, desc); continue; }
                snprintf(out, sizeof(out), "%s/%s_unpacked/%s", c->dest, stem, lab);
                FmtJob fj;
                memset(&fj, 0, sizeof(fj));
                fj.cb = fmt_cb; fj.user = c;
                int rc = fmt_unpack(k.fd, e->offset, e->size, lab, out, &fj);
                c->job->files += fj.files;
                if (rc == -2) { c->job->cancelled = 1; break; }
                if (rc == 0 && !fj.failed) { done++; slog(c, "unpackid %s/%s -> %s (%u files, %s)", stem, lab, out, fj.files, fj.kind); }
                else seterr(c, "unpackid %s/%s: %s", stem, lab, fj.error[0] ? fj.error : "failed");
            }
        }
        if (done) c->job->ok++;
        cpk_close(&k);
    }
    else if (!strcmp(cmd, "unpack")) { if (argc < 2) { seterr(c, "unpack needs a file"); return; } for_each(c, argv[1], do_unpack_one); }
    else if (!strcmp(cmd, "convert")) { if (argc < 2) { seterr(c, "convert needs a file"); return; } for_each(c, argv[1], do_convert_one); }
    else if (!strcmp(cmd, "magic")) {
        /* magic [archive...]  - default: 0000.bin and 0001.bin in the cd folder */
        char ps[8][SMAX];
        const char *pv[8];
        int pn = 0;
        if (argc < 2) { resolve(c, "0000.bin", ps[0], SMAX); resolve(c, "0001.bin", ps[1], SMAX); pn = 2; }
        else for (int a = 1; a < argc && pn < 8; a++) { resolve(c, argv[a], ps[pn], SMAX); pn++; }
        for (int k = 0; k < pn; k++) pv[k] = ps[k];
        char out[SMAX + 16], err[256] = "";
        snprintf(out, sizeof(out), "%s/magic.txt", c->dest);
        uint32_t lines = 0;
        if (cpk_write_magic(pv, pn, out, &lines, err, sizeof(err)) == 0) {
            char sum[SMAX + 32], verdict[400] = "";
            snprintf(sum, sizeof(sum), "%s/magic_summary.txt", c->dest);
            cpk_write_magic_summary(pv, pn, sum, verdict, sizeof(verdict), err, sizeof(err));
            c->job->ok++; c->job->files += 2;
            slog(c, "magic -> %s (%u files) + %s: %s", out, lines, sum, verdict);
        } else seterr(c, "magic: %s", err);
    }
    else if (!strcmp(cmd, "innerheaders") || !strcmp(cmd, "names")) {
        /* innerheaders|names [all] [archive|folder...] - default: 0000.bin and 0001.bin in the cd folder */
        int names = !strcmp(cmd, "names"), all = 0, a0 = 1;
        if (argc > 1 && !strcmp(argv[1], "all")) { all = 1; a0 = 2; }
        char ps[8][SMAX];
        const char *pv[8];
        int pn = 0;
        if (argc <= a0) { resolve(c, "0000.bin", ps[0], SMAX); resolve(c, "0001.bin", ps[1], SMAX); pn = 2; }
        else for (int a = a0; a < argc && pn < 8; a++) { resolve(c, argv[a], ps[pn], SMAX); pn++; }
        for (int k = 0; k < pn; k++) pv[k] = ps[k];
        NfJob nj;
        memset(&nj, 0, sizeof(nj));
        nj.cb = fmt_cb; nj.user = c; nj.skip_remaster = !all;
        char out[SMAX + 32];
        snprintf(out, sizeof(out), "%s/inner_headers.txt", c->dest);
        int rc = names ? nf_find_names(pv, pn, c->dest, &nj) : nf_inner_headers(pv, pn, out, &nj);
        if (rc == -2) { c->job->cancelled = 1; seterr(c, "%s cancelled", cmd); }
        else if (rc) seterr(c, "%s: %s", cmd, nj.error);
        else {
            c->job->ok++; c->job->files += names ? 3 : 1;
            slog(c, "%s -> %s: %u packs (%u KCAP), %u entries, %u names, %u unreadable%s", cmd, c->dest, nj.packs_done, nj.packs_kcap,
                 nj.entries, nj.names, nj.errors, all ? "" : ", IDs 10000+ skipped");
        }
    }
    else if (!strcmp(cmd, "dump")) { cmd_dump(c, argv, argc); }
    else if (!strcmp(cmd, "copy")) { cmd_copy(c, argv, argc); }
    else if (!strcmp(cmd, "zip")) { cmd_zip(c, argv, argc); }
    else seterr(c, "unknown command '%s'", cmd);
}

int script_count(const char *path)
{
    FILE *f = fopen(path, "r");
    if (!f) return -1;
    char line[2048];
    int n = 0;
    while (fgets(line, sizeof(line), f)) {
        char *s = line;
        while (*s == ' ' || *s == '\t') s++;
        if (*s && *s != '#' && *s != '\r' && *s != '\n') n++;
    }
    fclose(f);
    return n;
}

int script_run(const char *path, ScriptJob *job)
{
    FILE *f = fopen(path, "r");
    if (!f) { snprintf(job->error, sizeof(job->error), "cannot open script %s", path); return -1; }
    Ctx c;
    memset(&c, 0, sizeof(c));
    c.stop_on_error = 1;
    c.job = job;
    /* default base = the script's own folder */
    const char *b = strrchr(path, '/');
    if (b) snprintf(c.base, sizeof(c.base), "%.*s", (int)(b - path), path);
    int total = script_count(path);
    job->lines_total = total < 0 ? 0 : (uint32_t)total;

    char line[2048];
    uint32_t lineno = 0;
    while (fgets(line, sizeof(line), f)) {
        char *s = line;
        while (*s == ' ' || *s == '\t') s++;
        if (!*s || *s == '#' || *s == '\r' || *s == '\n') continue;
        line[strcspn(line, "\r\n")] = 0;
        lineno++;
        job->line = lineno;
        job->current = s;
        char *argv[64];
        char work[2048];
        snprintf(work, sizeof(work), "%s", s);
        int argc = tokenize(work, argv, 64);
        if (argc <= 0) continue;
        slog(&c, "[%u/%u] %s", lineno, job->lines_total, s);
        uint32_t fails_before = job->failed;
        run_line(&c, argv, argc);
        if (job->cancelled) { job->stopped = 1; break; }
        if (c.stop_on_error && job->failed > fails_before) { job->stopped = 1; slog(&c, "stopped (stop-on-error is on)"); break; }
        if (job->cb && job->cb(job->user)) { job->cancelled = 1; job->stopped = 1; break; }
    }
    fclose(f);
    if (c.log) {
        fprintf(c.log, "# summary: %u ok, %u failed, %u files%s\n", job->ok, job->failed, job->files,
                job->cancelled ? ", CANCELLED" : job->stopped ? ", STOPPED" : "");
        fclose(c.log);
    }
    return job->cancelled ? -2 : job->failed ? 1 : 0;
}
