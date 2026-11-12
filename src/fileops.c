/* fileops.c - copy / move / delete files and folders with progress + cancel. */
#include "fileops.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

#define BUFSZ (1u << 20)

int fo_force_copy_move = 0;

int fo_lstat(const char *path, struct stat *st)
{
    if (lstat(path, st) == 0) return 0;
    if (errno == ENOSYS) return stat(path, st); /* lstat not available: never pretend "missing" */
    return -1;
}

int fo_exists(const char *path)
{
    struct stat st;
    if (fo_lstat(path, &st) == 0) return 1;
    int e = errno;
    return !(e == ENOENT || e == ENOTDIR); /* unknown state counts as "exists" */
}

static void note_failure(FoJob *j, const char *fmt, const char *path, int err)
{
    j->skipped++;
    j->warnings++;
    char msg[512];
    snprintf(msg, sizeof(msg), fmt, path);
    snprintf(j->last_warning, sizeof(j->last_warning), "%s (%s)", msg, strerror(err));
    if (!j->first_failure[0]) snprintf(j->first_failure, sizeof(j->first_failure), "%s", j->last_warning);
}

static void fail(FoJob *j, const char *msg, const char *detail)
{
    if (j->failed) return; /* keep the first (root-cause) error */
    j->failed = 1;
    if (detail && *detail) snprintf(j->error, sizeof(j->error), "%s: %s", msg, detail);
    else snprintf(j->error, sizeof(j->error), "%s", msg);
}

static void warn(FoJob *j, const char *fmt, const char *arg)
{
    j->warnings++;
    snprintf(j->last_warning, sizeof(j->last_warning), fmt, arg);
}

static const char *errtext(int e)
{
    switch (e) {
    case ENOSPC: return "Destination is full (no space left)";
    case EFBIG:  return "File too large for the destination (FAT32 limit is 4 GB - use exFAT or internal storage)";
    case EROFS:  return "Destination is read-only";
    case EACCES:
    case EPERM:  return "Permission denied";
    default:     return strerror(e);
    }
}

static int tick(FoJob *j, FoProgressFn cb, void *user)
{
    if (cb && cb(j, user)) { j->cancelled = 1; return 1; }
    return 0;
}

static void set_current(FoJob *j, const char *path)
{
    snprintf(j->current, sizeof(j->current), "%s", path);
}

/* ---------- scan ---------- */
void fo_reset(FoJob *job)
{
    memset(job, 0, sizeof(*job));
}

static void scan_one(FoJob *j, const char *path)
{
    struct stat st;
    if (fo_lstat(path, &st) != 0) return;
    j->total_items++;
    if (S_ISDIR(st.st_mode)) {
        DIR *d = opendir(path);
        if (!d) return;
        struct dirent *de;
        char child[1024];
        while ((de = readdir(d))) {
            if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
            snprintf(child, sizeof(child), "%s/%s", path, de->d_name);
            scan_one(j, child);
        }
        closedir(d);
    } else if (S_ISREG(st.st_mode)) {
        j->total_bytes += (uint64_t)st.st_size;
    }
}

void fo_scan(FoJob *job, const char *const *paths, int count)
{
    for (int i = 0; i < count; i++) scan_one(job, paths[i]);
}

static uint64_t tree_bytes(const char *path)
{
    FoJob t;
    memset(&t, 0, sizeof(t));
    scan_one(&t, path);
    return t.total_bytes;
}

static uint32_t tree_items(const char *path)
{
    FoJob t;
    memset(&t, 0, sizeof(t));
    scan_one(&t, path);
    return t.total_items;
}

/* ---------- delete ---------- */
/* Returns -1 on cancel, 0 otherwise (failures are counted as skipped). */
static int delete_tree(FoJob *j, const char *path, FoProgressFn cb, void *user, int count_progress)
{
    struct stat st;
    if (fo_lstat(path, &st) != 0) {
        if (errno == ENOENT || errno == ENOTDIR) return 0; /* genuinely already gone */
        note_failure(j, "Cannot inspect %s", path, errno);  /* never report this as deleted */
        return 0;
    }
    if (S_ISDIR(st.st_mode)) {
        DIR *d = opendir(path);
        if (d) {
            struct dirent *de;
            char child[1024];
            while ((de = readdir(d))) {
                if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
                snprintf(child, sizeof(child), "%s/%s", path, de->d_name);
                if (delete_tree(j, child, cb, user, count_progress) < 0) { closedir(d); return -1; }
            }
            closedir(d);
        }
        if (rmdir(path) != 0) note_failure(j, "Could not delete folder %s", path, errno);
    } else {
        set_current(j, path);
        if (unlink(path) != 0) note_failure(j, "Could not delete %s", path, errno);
        else if (count_progress && S_ISREG(st.st_mode)) j->done_bytes += (uint64_t)st.st_size;
    }
    if (count_progress) {
        j->items_done++;
        if (tick(j, cb, user)) return -1;
    }
    return 0;
}

int fo_delete(FoJob *job, const char *path, FoProgressFn cb, void *user)
{
    set_current(job, path);
    int rc = delete_tree(job, path, cb, user, 1);
    /* verify: success means the item is really gone */
    if (fo_exists(path)) {
        job->failed_items++;
        if (!job->first_failure[0])
            snprintf(job->first_failure, sizeof(job->first_failure), "%s is still there after deleting", path);
    }
    return rc;
}

/* ---------- copy ---------- */
static int write_all(int fd, const char *p, size_t n)
{
    while (n) {
        ssize_t w = write(fd, p, n);
        if (w < 0) { if (errno == EINTR) continue; return -1; }
        p += w;
        n -= (size_t)w;
    }
    return 0;
}

static int copy_file(FoJob *j, const char *src, const char *dst, const struct stat *st,
                     char *buf, FoProgressFn cb, void *user)
{
    set_current(j, src);
    if (tick(j, cb, user)) return -1;

    int in = open(src, O_RDONLY);
    if (in < 0) { fail(j, "Cannot read", src); return -1; }
    int out = open(dst, O_WRONLY | O_CREAT | O_EXCL, 0666); /* never overwrite an existing file */
    if (out < 0) { int e = errno; close(in); fail(j, errtext(e), dst); return -1; }

    uint64_t copied = 0;
    int rc = 0;
    for (;;) {
        ssize_t r = read(in, buf, BUFSZ);
        if (r < 0) { if (errno == EINTR) continue; fail(j, "Read error", src); rc = -1; break; }
        if (r == 0) break;
        if (write_all(out, buf, (size_t)r) != 0) { fail(j, errtext(errno), dst); rc = -1; break; }
        copied += (uint64_t)r;
        j->done_bytes += (uint64_t)r;
        if (tick(j, cb, user)) { rc = -1; break; }
    }
    if (close(out) != 0 && rc == 0) { fail(j, errtext(errno), dst); rc = -1; }
    close(in);

    if (rc == 0 && copied != (uint64_t)st->st_size) { fail(j, "Copy was incomplete (file changed?)", src); rc = -1; }
    if (rc != 0) { unlink(dst); return -1; }

    struct timeval tv[2];
    tv[0].tv_sec = tv[1].tv_sec = st->st_mtime;
    tv[0].tv_usec = tv[1].tv_usec = 0;
    utimes(dst, tv);
    j->items_done++;
    return 0;
}

static int copy_tree(FoJob *j, const char *src, const char *dst, char *buf, FoProgressFn cb, void *user)
{
    struct stat st;
    if (fo_lstat(src, &st) != 0) { fail(j, errno == ENOENT ? "Source disappeared" : "Cannot read source info", src); return -1; }

    if (S_ISDIR(st.st_mode)) {
        if (mkdir(dst, 0777) != 0 && errno != EEXIST) { fail(j, errtext(errno), dst); return -1; }
        j->items_done++;
        DIR *d = opendir(src);
        if (!d) { fail(j, "Cannot open folder", src); return -1; }
        struct dirent *de;
        char cs[1024], cd[1024];
        int rc = 0;
        while ((de = readdir(d))) {
            if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
            snprintf(cs, sizeof(cs), "%s/%s", src, de->d_name);
            snprintf(cd, sizeof(cd), "%s/%s", dst, de->d_name);
            if ((rc = copy_tree(j, cs, cd, buf, cb, user)) != 0) break;
        }
        closedir(d);
        return rc;
    }
    if (S_ISREG(st.st_mode)) return copy_file(j, src, dst, &st, buf, cb, user);

    warn(j, "Special file (link/device) skipped: %s", src);
    j->skipped++;
    j->items_done++;
    return 0;
}

int fo_copy(FoJob *job, const char *src, const char *dst, FoProgressFn cb, void *user)
{
    char *buf = malloc(BUFSZ);
    if (!buf) { fail(job, "Out of memory", NULL); return -1; }
    int rc = copy_tree(job, src, dst, buf, cb, user);
    free(buf);
    if (rc != 0) {
        /* remove the partial copy only - never the source */
        FoJob tmp;
        memset(&tmp, 0, sizeof(tmp));
        delete_tree(&tmp, dst, NULL, NULL, 0);
        return -1;
    }
    return 0;
}

/* ---------- move ---------- */
int fo_move(FoJob *job, const char *src, const char *dst, FoProgressFn cb, void *user)
{
    set_current(job, src);
    if (fo_exists(dst)) { fail(job, "Destination already exists (nothing was overwritten)", dst); return -1; }
    if (!fo_force_copy_move && rename(src, dst) == 0) {
        job->done_bytes += tree_bytes(dst);   /* same drive: instant */
        job->items_done += tree_items(dst);
        return tick(job, cb, user) ? -1 : 0;
    }
    if (!fo_force_copy_move && errno != EXDEV) { fail(job, errtext(errno), src); return -1; }

    /* different drive: copy, then remove the source only if the copy fully succeeded */
    uint32_t skipped_before = job->skipped;
    if (fo_copy(job, src, dst, cb, user) != 0) return -1;
    if (job->skipped != skipped_before) {
        /* something couldn't be copied: deleting the original would lose it */
        snprintf(job->last_warning, sizeof(job->last_warning),
                 "Copied, but the original was KEPT because some items could not be copied: %s", src);
        job->warnings++;
        return 0;
    }
    if (tree_bytes(dst) != tree_bytes(src)) {
        FoJob tmp;
        memset(&tmp, 0, sizeof(tmp));
        delete_tree(&tmp, dst, NULL, NULL, 0);
        fail(job, "Verification failed after copy; source kept", src);
        return -1;
    }
    FoJob del;
    memset(&del, 0, sizeof(del));
    delete_tree(&del, src, NULL, NULL, 0);
    if (del.skipped) {
        job->warnings += del.warnings;
        snprintf(job->last_warning, sizeof(job->last_warning),
                 "Copied, but some originals could not be removed: %s", src);
    }
    return 0;
}
