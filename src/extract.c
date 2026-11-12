/*
 * extract.c - archive extraction engine built on libarchive.
 *
 * Supports ZIP (incl. ZIP64 / >4 GB entries), RAR4, RAR5 (incl. solid and
 * multi-volume sets), 7z (incl. .7z.001 splits), TAR/GZ/XZ, ISO, CAB, LHA.
 * Data is streamed block-by-block, so file size is limited only by the
 * destination filesystem.
 */
#include "extract.h"

#include <archive.h>
#include <archive_entry.h>

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <unistd.h>

#define READ_BLOCK (1u << 20) /* 1 MiB reads from the archive */

/* ------------------------------------------------------------------ */
/* Small string helpers                                                */
/* ------------------------------------------------------------------ */

static int ends_with_ci(const char *s, const char *suffix)
{
    size_t ls = strlen(s), lx = strlen(suffix);
    return ls >= lx && strcasecmp(s + ls - lx, suffix) == 0;
}

static int all_digits(const char *s, size_t n)
{
    if (n == 0) return 0;
    for (size_t i = 0; i < n; i++)
        if (!isdigit((unsigned char)s[i])) return 0;
    return 1;
}

static int file_size(const char *path, uint64_t *out)
{
    struct stat st;
    if (stat(path, &st) != 0 || !S_ISREG(st.st_mode)) return -1;
    if (out) *out = (uint64_t)st.st_size;
    return 0;
}

/* Find ".partN.rar" in name. On success returns pointer to the '.' before
 * "part" and sets *digits / *ndigits. */
static const char *find_part_rar(const char *name, const char **digits, size_t *ndigits)
{
    size_t len = strlen(name);
    if (len < 10 || !ends_with_ci(name, ".rar")) return NULL;
    const char *end = name + len - 4; /* points at ".rar" */
    const char *d = end;
    while (d > name && isdigit((unsigned char)d[-1])) d--;
    size_t nd = (size_t)(end - d);
    if (nd == 0 || d - name < 5) return NULL;
    if (strncasecmp(d - 5, ".part", 5) != 0) return NULL;
    *digits = d;
    *ndigits = nd;
    return d - 5;
}

/* ".r00"... ".r99" / ".s00"... */
static int is_old_rar_ext(const char *name)
{
    size_t len = strlen(name);
    if (len < 5) return 0;
    const char *e = name + len - 4;
    return e[0] == '.' && (e[1] == 'r' || e[1] == 'R' || e[1] == 's' || e[1] == 'S') &&
           all_digits(e + 2, 2);
}

/* ".001", ".002", ... */
static int numeric_ext(const char *name, long *value)
{
    size_t len = strlen(name);
    if (len < 5) return 0;
    const char *e = name + len - 4;
    if (e[0] != '.' || !all_digits(e + 1, 3)) return 0;
    if (value) *value = strtol(e + 1, NULL, 10);
    return 1;
}

int ex_is_archive_name(const char *name)
{
    static const char *exts[] = {
        ".zip", ".rar", ".7z", ".tar", ".tgz", ".gz", ".xz", ".txz", ".lzma",
        ".cab", ".lha", ".lzh", ".iso", ".cpio", ".cbz", ".cbr", ".cb7", NULL
    };
    for (int i = 0; exts[i]; i++)
        if (ends_with_ci(name, exts[i])) return 1;
    long v;
    if (numeric_ext(name, &v)) return 1;
    return 0;
}

int ex_is_secondary_volume(const char *name)
{
    const char *digits;
    size_t nd;
    long v;
    if (find_part_rar(name, &digits, &nd)) {
        return strtol(digits, NULL, 10) != 1;
    }
    if (is_old_rar_ext(name)) return 1;
    if (numeric_ext(name, &v)) return v != 1;
    /* Split zip pieces (.z01, .z02 ...) */
    size_t len = strlen(name);
    if (len >= 5) {
        const char *e = name + len - 4;
        if (e[0] == '.' && (e[1] == 'z' || e[1] == 'Z') && all_digits(e + 2, 2)) return 1;
    }
    return 0;
}

void ex_archive_stem(const char *name, char *out, size_t outsz)
{
    snprintf(out, outsz, "%s", name);
    const char *digits;
    size_t nd;
    const char *p = find_part_rar(out, &digits, &nd);
    if (p) { out[p - out] = 0; return; }

    long v;
    if (numeric_ext(out, &v)) out[strlen(out) - 4] = 0; /* strip .001 */

    static const char *multi[] = { ".tar.gz", ".tar.xz", ".tar.lzma", NULL };
    for (int i = 0; multi[i]; i++) {
        if (ends_with_ci(out, multi[i])) { out[strlen(out) - strlen(multi[i])] = 0; return; }
    }
    char *dot = strrchr(out, '.');
    if (dot && dot != out) *dot = 0;
}

int ex_mkdirs(const char *path)
{
    char tmp[EX_PATH_MAX];
    snprintf(tmp, sizeof(tmp), "%s", path);
    size_t len = strlen(tmp);
    while (len > 1 && tmp[len - 1] == '/') tmp[--len] = 0;
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = 0;
            if (mkdir(tmp, 0777) != 0 && errno != EEXIST) return -1;
            *p = '/';
        }
    }
    if (mkdir(tmp, 0777) != 0 && errno != EEXIST) return -1;
    return 0;
}

/* ------------------------------------------------------------------ */
/* Volume collection                                                   */
/* ------------------------------------------------------------------ */

static int add_volume(ExJob *job, const char *path)
{
    uint64_t sz;
    if (job->volume_count >= EX_MAX_VOLUMES) return -1;
    if (file_size(path, &sz) != 0) return -1;
    job->volumes[job->volume_count++] = strdup(path);
    job->volumes[job->volume_count] = NULL;
    job->input_total += sz;
    return 0;
}

void ex_free_volumes(ExJob *job)
{
    for (int i = 0; i < job->volume_count; i++) free((void *)job->volumes[i]);
    job->volume_count = 0;
    job->volumes[0] = NULL;
    job->input_total = 0;
}

int ex_collect_volumes(ExJob *job, const char *path)
{
    char buf[EX_PATH_MAX];
    const char *slash = strrchr(path, '/');
    const char *name = slash ? slash + 1 : path;
    size_t dirlen = (size_t)(name - path);
    const char *digits;
    size_t nd;
    long v;

    job->volume_count = 0;
    job->volumes[0] = NULL;
    job->input_total = 0;

    /* name.part1.rar, name.part2.rar ... (also part01 / part001) */
    if (find_part_rar(name, &digits, &nd)) {
        size_t prefix_len = (size_t)(digits - path);       /* up to the digits */
        const char *ext = digits + nd;                       /* ".rar" w/ case  */
        for (int n = 1; n <= EX_MAX_VOLUMES; n++) {
            snprintf(buf, sizeof(buf), "%.*s%0*d%s", (int)prefix_len, path, (int)nd, n, ext);
            if (add_volume(job, buf) != 0) break;
        }
        return job->volume_count > 0 ? 0 : -1;
    }

    /* name.rar + name.r00, name.r01 ... name.r99, name.s00 ... */
    if (ends_with_ci(name, ".rar")) {
        if (add_volume(job, path) != 0) return -1;
        size_t base_len = strlen(path) - 3; /* keep the '.' */
        char r = path[base_len];            /* 'r' or 'R' (match case) */
        char s = (r == 'R') ? 'S' : 's';
        for (int n = 0; n < 200; n++) {
            snprintf(buf, sizeof(buf), "%.*s%c%02d", (int)base_len, path, n < 100 ? r : s, n % 100);
            if (add_volume(job, buf) != 0) break;
        }
        return 0;
    }

    /* name.7z.001, name.zip.001 ... (raw byte splits) */
    if (numeric_ext(name, &v)) {
        size_t base_len = strlen(path) - 3;
        for (int n = (int)v; n <= 999; n++) {
            snprintf(buf, sizeof(buf), "%.*s%03d", (int)base_len, path, n);
            if (add_volume(job, buf) != 0) break;
        }
        return job->volume_count > 0 ? 0 : -1;
    }

    (void)dirlen;
    return add_volume(job, path);
}

/* ------------------------------------------------------------------ */
/* Path sanitising                                                     */
/* ------------------------------------------------------------------ */

/* Length of a valid UTF-8 sequence starting at s, or 0 if invalid. */
static int utf8_seq_len(const unsigned char *s)
{
    if (s[0] < 0x80) return 1;
    int n;
    if ((s[0] & 0xE0) == 0xC0) n = 2;
    else if ((s[0] & 0xF0) == 0xE0) n = 3;
    else if ((s[0] & 0xF8) == 0xF0) n = 4;
    else return 0;
    for (int i = 1; i < n; i++)
        if ((s[i] & 0xC0) != 0x80) return 0;
    if (n == 2 && s[0] < 0xC2) return 0; /* overlong */
    return n;
}

/* Turn an archive path into a safe relative path. Returns 0 if OK,
 * -1 if the entry must be skipped (empty or tries to escape with ".."). */
static int sanitize_path(const char *in, char *out, size_t outsz)
{
    char tmp[EX_PATH_MAX];
    size_t o = 0;
    snprintf(tmp, sizeof(tmp), "%s", in);
    for (char *p = tmp; *p; p++)
        if (*p == '\\') *p = '/';

    out[0] = 0;
    char *save = NULL;
    for (char *comp = strtok_r(tmp, "/", &save); comp; comp = strtok_r(NULL, "/", &save)) {
        if (strcmp(comp, ".") == 0 || comp[0] == 0) continue;
        if (strcmp(comp, "..") == 0) return -1;
        /* Drive letters like "C:" at the start */
        if (o == 0 && strlen(comp) == 2 && comp[1] == ':') continue;

        if (o) { if (o + 1 >= outsz) return -1; out[o++] = '/'; }
        size_t clen = 0;
        const unsigned char *s = (const unsigned char *)comp;
        while (*s) {
            int n = utf8_seq_len(s);
            if (n == 0) { n = 1; if (o + 1 >= outsz) return -1; out[o++] = '_'; s++; clen++; continue; }
            if (clen + n > 255) break; /* filesystem name limit */
            if (o + n >= outsz) return -1;
            if (n == 1 && (*s < 0x20 || strchr(":*?\"<>|", *s))) out[o++] = '_';
            else memcpy(out + o, s, n), o += n;
            s += n;
            clen += n;
        }
    }
    out[o] = 0;
    return o ? 0 : -1;
}

/* ------------------------------------------------------------------ */
/* Extraction                                                          */
/* ------------------------------------------------------------------ */

static void warn(ExJob *job, const char *fmt, const char *arg)
{
    job->warnings++;
    snprintf(job->last_warning, sizeof(job->last_warning), fmt, arg);
}

static void fail(ExJob *job, const char *msg, const char *detail)
{
    job->failed = 1;
    if (detail && *detail)
        snprintf(job->error, sizeof(job->error), "%s: %s", msg, detail);
    else
        snprintf(job->error, sizeof(job->error), "%s", msg);
}

static const char *write_error_text(int err)
{
    switch (err) {
    case ENOSPC: return "Destination is full (no space left)";
    case EFBIG:  return "File too large for destination filesystem (FAT32 limit is 4 GB - use exFAT or internal storage)";
    case EROFS:  return "Destination is read-only";
    case EACCES:
    case EPERM:  return "Permission denied (is the app jailbroken? see log)";
    default:     return strerror(err);
    }
}

static int write_all(int fd, const void *buf, size_t len)
{
    const char *p = buf;
    while (len) {
        ssize_t w = write(fd, p, len);
        if (w < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        p += w;
        len -= (size_t)w;
    }
    return 0;
}

static int extract_file(ExJob *job, struct archive *a, struct archive_entry *e,
                        const char *full, ExProgressFn cb, void *user)
{
    int fd = open(full, O_WRONLY | O_CREAT | O_TRUNC, 0666);
    if (fd < 0) {
        int err = errno;
        if (err == ENOSPC || err == EROFS) { fail(job, write_error_text(err), full); return -1; }
        warn(job, "Cannot create %s", full);
        archive_read_data_skip(a);
        return 0;
    }

    int64_t pos = 0;
    int rc = 0;
    for (;;) {
        const void *buf;
        size_t size;
        la_int64_t offset;
        int r = archive_read_data_block(a, &buf, &size, &offset);
        if (r == ARCHIVE_EOF) break;
        if (r < ARCHIVE_WARN) {
            const char *msg = archive_error_string(a);
            if (r == ARCHIVE_FATAL) { fail(job, "Archive error", msg); rc = -1; }
            else { warn(job, "Damaged entry skipped: %s", job->current_entry); rc = 1; }
            break;
        }
        if (offset > pos) { /* sparse hole */
            if (lseek(fd, offset, SEEK_SET) < 0) { fail(job, "Seek failed", strerror(errno)); rc = -1; break; }
            pos = offset;
        }
        if (size && write_all(fd, buf, size) != 0) {
            fail(job, write_error_text(errno), job->current_entry);
            rc = -1;
            break;
        }
        pos += (int64_t)size;
        job->entry_done = (uint64_t)pos;
        job->bytes_written += size;
        job->input_done = (uint64_t)archive_filter_bytes(a, -1);
        if (cb && cb(job, user)) { job->cancelled = 1; rc = -1; break; }
    }

    if (rc == 0 && archive_entry_size_is_set(e) && pos < archive_entry_size(e)) {
        if (ftruncate(fd, archive_entry_size(e)) != 0) { /* trailing hole */ }
    }
    close(fd);

    if (rc != 0) { unlink(full); return rc < 0 ? -1 : 0; }

    if (archive_entry_mtime_is_set(e)) {
        struct timeval tv[2];
        tv[0].tv_sec = tv[1].tv_sec = archive_entry_mtime(e);
        tv[0].tv_usec = tv[1].tv_usec = 0;
        utimes(full, tv);
    }
    job->files_done++;
    return 0;
}

int ex_run(ExJob *job, ExProgressFn cb, void *user)
{
    char rel[EX_PATH_MAX], full[EX_PATH_MAX * 2], parent[EX_PATH_MAX * 2], stem[256];
    struct archive *a;
    struct archive_entry *e;

    job->cancelled = job->failed = 0;
    job->error[0] = job->last_warning[0] = job->current_entry[0] = 0;
    job->input_done = job->bytes_written = job->entry_size = job->entry_done = 0;
    job->files_done = job->files_skipped = job->dirs_created = job->warnings = 0;

    if (job->volume_count == 0) { fail(job, "No input files", NULL); return -1; }
    {
        const char *n = strrchr(job->volumes[0], '/');
        ex_archive_stem(n ? n + 1 : job->volumes[0], stem, sizeof(stem));
        /* split zip (.z01 + .zip) is not readable as a stream */
        if (ends_with_ci(job->volumes[0], ".zip")) {
            char z01[EX_PATH_MAX];
            snprintf(z01, sizeof(z01), "%.*sz01", (int)strlen(job->volumes[0]) - 3, job->volumes[0]);
            if (file_size(z01, NULL) == 0) {
                fail(job, "Split ZIP (.z01/.z02...) is not supported",
                     "re-create it as one .zip, or as .zip.001/.002 parts");
                return -1;
            }
        }
    }

    if (ex_mkdirs(job->dest_dir) != 0) { fail(job, "Cannot create destination", strerror(errno)); return -1; }

    a = archive_read_new();
    archive_read_support_filter_all(a);
    archive_read_support_format_all(a);
    archive_read_support_format_raw(a); /* plain .gz / .xz files */

    if (archive_read_open_filenames(a, job->volumes, READ_BLOCK) != ARCHIVE_OK) {
        fail(job, "Cannot open archive", archive_error_string(a));
        archive_read_free(a);
        return -1;
    }

    for (;;) {
        int r = archive_read_next_header(a, &e);
        if (r == ARCHIVE_EOF) break;
        if (r == ARCHIVE_RETRY) continue;
        if (r == ARCHIVE_WARN) warn(job, "%s", archive_error_string(a));
        else if (r == ARCHIVE_FAILED) { warn(job, "Bad header: %s", archive_error_string(a)); continue; }
        else if (r == ARCHIVE_FATAL) { fail(job, "Archive error", archive_error_string(a)); break; }

        const char *name;
        if (archive_format(a) == ARCHIVE_FORMAT_RAW &&
            (archive_filter_count(a) <= 1 || archive_filter_code(a, 0) == ARCHIVE_FILTER_NONE)) {
            /* "raw" with no compression = libarchive didn't recognise the file at all;
             * don't silently copy it as if it were extracted */
            fail(job, "Not a recognized archive", "the file may be damaged or an unsupported format");
            break;
        }
        if (archive_format(a) == ARCHIVE_FORMAT_RAW) name = stem;
        else {
            name = archive_entry_pathname_utf8(e);
            if (!name) name = archive_entry_pathname(e);
        }
        if (!name || sanitize_path(name, rel, sizeof(rel)) != 0) {
            warn(job, "Unsafe or empty path skipped: %s", name ? name : "(null)");
            archive_read_data_skip(a);
            continue;
        }

        snprintf(job->current_entry, sizeof(job->current_entry), "%s", rel);
        job->entry_size = archive_entry_size_is_set(e) ? (uint64_t)archive_entry_size(e) : 0;
        job->entry_done = 0;
        job->input_done = (uint64_t)archive_filter_bytes(a, -1);
        if (cb && cb(job, user)) { job->cancelled = 1; break; }

        snprintf(full, sizeof(full), "%s/%s", job->dest_dir, rel);
        snprintf(parent, sizeof(parent), "%s", full);
        char *ls = strrchr(parent, '/');
        if (ls) { *ls = 0; ex_mkdirs(parent); }

        if (archive_entry_is_encrypted(e)) {
            warn(job, "Encrypted (password) entry skipped: %s", rel);
            job->files_skipped++;
            archive_read_data_skip(a);
            continue;
        }

        const char *hardlink = archive_entry_hardlink(e);
        mode_t type = archive_entry_filetype(e);

        if (hardlink) {
            char target_rel[EX_PATH_MAX], target[EX_PATH_MAX * 2];
            if (sanitize_path(hardlink, target_rel, sizeof(target_rel)) == 0) {
                snprintf(target, sizeof(target), "%s/%s", job->dest_dir, target_rel);
                unlink(full);
                if (link(target, full) == 0) { job->files_done++; continue; }
            }
            warn(job, "Hard link skipped: %s", rel);
            archive_read_data_skip(a);
            continue;
        }

        if (type == AE_IFDIR) {
            if (ex_mkdirs(full) == 0) job->dirs_created++;
            else warn(job, "Cannot create folder %s", rel);
            continue;
        }
        if (type != AE_IFREG && type != 0) {
            warn(job, "Special file (link/device) skipped: %s", rel);
            job->files_skipped++;
            archive_read_data_skip(a);
            continue;
        }

        if (!job->overwrite && file_size(full, NULL) == 0) {
            job->files_skipped++;
            archive_read_data_skip(a);
            continue;
        }

        if (extract_file(job, a, e, full, cb, user) != 0) break;
    }

    job->input_done = (uint64_t)archive_filter_bytes(a, -1);
    archive_read_free(a);
    if (cb) cb(job, user);
    return (job->failed || job->cancelled) ? -1 : 0;
}
