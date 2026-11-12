/* archive_create.c - create a .zip from files/folders using libarchive. */
#include "archive_create.h"

#include <archive.h>
#include <archive_entry.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define BUFSZ (1u << 20)

static void fail(AcJob *j, const char *msg, const char *detail)
{
    j->failed = 1;
    if (detail && *detail) snprintf(j->error, sizeof(j->error), "%s: %s", msg, detail);
    else snprintf(j->error, sizeof(j->error), "%s", msg);
}

static void warn(AcJob *j, const char *fmt, const char *arg)
{
    j->warnings++;
    snprintf(j->last_warning, sizeof(j->last_warning), fmt, arg);
}

/* True if `path` is `dir` itself or lies inside it (respects '/' boundaries,
 * so "/data/Files" does NOT contain "/data/FilesX"). */
int ac_path_within(const char *path, const char *dir)
{
    size_t dl = strlen(dir);
    while (dl > 1 && dir[dl - 1] == '/') dl--;
    if (dl == 1 && dir[0] == '/') return path[0] == '/';
    return strncmp(path, dir, dl) == 0 && (path[dl] == 0 || path[dl] == '/');
}

/* Entry name stored in the archive = path relative to base_dir. */
static const char *rel_name(AcJob *j, const char *path)
{
    if (j->base_dir[0] && ac_path_within(path, j->base_dir)) {
        const char *p = path + strlen(j->base_dir);
        while (*p == '/') p++;
        if (*p) return p;
    }
    const char *s = strrchr(path, '/');
    return s ? s + 1 : path;
}

/* stat for the top-level selected items (follows links), lstat below them
 * (so symlink loops can't recurse forever). */
static int get_stat(const char *path, int top, struct stat *st)
{
    if (top) return stat(path, st);
    if (lstat(path, st) == 0) return 0;
    return errno == ENOSYS ? stat(path, st) : -1; /* lstat unavailable: don't skip the file */
}

/* ---- scan pass (counts files + bytes) ---- */
static void scan_path(AcJob *j, const char *path, int top)
{
    struct stat st;
    if (strcmp(path, j->out_path) == 0) return;
    if (get_stat(path, top, &st) != 0) return;
    if (S_ISDIR(st.st_mode)) {
        DIR *d = opendir(path);
        if (!d) return;
        struct dirent *de;
        char child[AC_PATH_MAX];
        while ((de = readdir(d))) {
            if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
            snprintf(child, sizeof(child), "%s/%s", path, de->d_name);
            scan_path(j, child, 0);
        }
        closedir(d);
    } else if (S_ISREG(st.st_mode)) {
        j->total_files++;
        j->total_bytes += (uint64_t)st.st_size;
    }
}

void ac_scan(AcJob *job, const char *const *paths, int count)
{
    job->total_files = 0;
    job->total_bytes = 0;
    for (int i = 0; i < count; i++) scan_path(job, paths[i], 1);
}

/* ---- write pass ---- */
static int add_file(AcJob *j, struct archive *a, const char *path, const struct stat *st,
                    void *buf, AcProgressFn cb, void *user)
{
    snprintf(j->current, sizeof(j->current), "%s", rel_name(j, path));
    if (cb && cb(j, user)) { j->cancelled = 1; return -1; }

    /* open BEFORE writing the header: an unreadable file is skipped cleanly
     * instead of leaving a corrupt, zero-data entry in the zip */
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        warn(j, "Cannot read (skipped): %s", rel_name(j, path));
        j->skipped++;
        j->done_bytes += (uint64_t)st->st_size; /* keep the bar honest */
        return 0;
    }

    struct archive_entry *e = archive_entry_new();
    archive_entry_set_pathname(e, rel_name(j, path));
    archive_entry_set_size(e, st->st_size);
    archive_entry_set_filetype(e, AE_IFREG);
    archive_entry_set_perm(e, 0644);
    archive_entry_set_mtime(e, st->st_mtime, 0);
    if (archive_write_header(a, e) != ARCHIVE_OK) {
        fail(j, "Write header failed", archive_error_string(a));
        archive_entry_free(e);
        close(fd);
        return -1;
    }
    archive_entry_free(e);

    uint64_t got = 0, want = (uint64_t)st->st_size;
    while (got < want) {
        size_t chunk = (want - got) < BUFSZ ? (size_t)(want - got) : BUFSZ;
        ssize_t r = read(fd, buf, chunk);
        if (r < 0) {
            if (errno == EINTR) continue;
            fail(j, "Read error (zip would be incomplete)", rel_name(j, path));
            close(fd);
            return -1;
        }
        if (r == 0) break;
        if (archive_write_data(a, buf, (size_t)r) < 0) {
            fail(j, "Write failed (destination full?)", archive_error_string(a));
            close(fd);
            return -1;
        }
        got += (uint64_t)r;
        j->done_bytes += (uint64_t)r;
        if (cb && cb(j, user)) { close(fd); j->cancelled = 1; return -1; }
    }
    close(fd);
    if (got != want) { /* file shrank while zipping: entry would be short */
        fail(j, "File shrank while zipping", rel_name(j, path));
        return -1;
    }
    j->files_done++;
    return 0;
}

static int add_path(AcJob *j, struct archive *a, const char *path, int top, void *buf,
                    AcProgressFn cb, void *user)
{
    struct stat st;
    if (strcmp(path, j->out_path) == 0) return 0; /* never zip the zip itself */
    if (get_stat(path, top, &st) != 0) return 0;

    if (S_ISDIR(st.st_mode)) {
        const char *rn = rel_name(j, path);
        if (*rn) { /* explicit directory entry keeps empty folders */
            struct archive_entry *e = archive_entry_new();
            char named[AC_PATH_MAX];
            snprintf(named, sizeof(named), "%s/", rn);
            archive_entry_set_pathname(e, named);
            archive_entry_set_filetype(e, AE_IFDIR);
            archive_entry_set_perm(e, 0755);
            archive_entry_set_mtime(e, st.st_mtime, 0);
            if (archive_write_header(a, e) != ARCHIVE_OK) {
                fail(j, "Write header failed", archive_error_string(a));
                archive_entry_free(e);
                return -1;
            }
            archive_entry_free(e);
            j->dirs_done++;
        }
        DIR *d = opendir(path);
        if (!d) { warn(j, "Cannot open folder (skipped): %s", rn); return 0; }
        struct dirent *de;
        char child[AC_PATH_MAX];
        int rc = 0;
        while ((de = readdir(d))) {
            if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
            snprintf(child, sizeof(child), "%s/%s", path, de->d_name);
            rc = add_path(j, a, child, 0, buf, cb, user);
            if (rc != 0) break;
        }
        closedir(d);
        return rc;
    }
    if (S_ISREG(st.st_mode)) return add_file(j, a, path, &st, buf, cb, user);
    return 0; /* symlinks / devices skipped */
}

int ac_run(AcJob *job, const char *const *paths, int count, AcProgressFn cb, void *user)
{
    job->cancelled = job->failed = 0;
    job->done_bytes = 0;
    job->files_done = job->dirs_done = job->skipped = job->warnings = 0;
    job->error[0] = job->current[0] = job->last_warning[0] = 0;

    void *buf = malloc(BUFSZ);
    if (!buf) { fail(job, "Out of memory", NULL); return -1; }

    struct archive *a = archive_write_new();
    archive_write_set_format_zip(a);
    archive_write_set_options(a, job->deflate ? "zip:compression=deflate,zip:compression-level=6"
                                              : "zip:compression=store");
    archive_write_set_bytes_per_block(a, 1 << 20); /* big writes, far fewer syscalls */
    archive_write_set_bytes_in_last_block(a, 1);   /* no padding at the end */

    if (archive_write_open_filename(a, job->out_path) != ARCHIVE_OK) {
        fail(job, "Cannot create archive", archive_error_string(a));
        archive_write_free(a);
        free(buf);
        return -1;
    }

    int rc = 0;
    for (int i = 0; i < count && rc == 0; i++)
        rc = add_path(job, a, paths[i], 1, buf, cb, user);

    if (archive_write_close(a) != ARCHIVE_OK && !job->failed && !job->cancelled)
        fail(job, "Finishing the zip failed", archive_error_string(a));
    archive_write_free(a);
    free(buf);

    if (job->cancelled || job->failed) { unlink(job->out_path); return -1; }
    if (cb) cb(job, user);
    return 0;
}
