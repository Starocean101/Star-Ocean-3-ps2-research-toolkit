/* fileops.h - copy / move / delete files and folders with progress + cancel. */
#pragma once

#include <stdint.h>
#include <sys/stat.h>

typedef struct {
    char     current[1024];     /* item being processed (display) */
    uint64_t total_bytes;       /* filled by fo_scan */
    uint64_t done_bytes;
    uint32_t total_items;       /* files + folders, filled by fo_scan */
    uint32_t items_done;
    uint32_t skipped;
    uint32_t failed_items;      /* top-level items that could not be fully processed */
    char     first_failure[512];
    uint32_t warnings;
    char     last_warning[512];
    int      cancelled;
    int      failed;
    char     error[512];
} FoJob;

/* Return non-zero to cancel. */
typedef int (*FoProgressFn)(FoJob *job, void *user);

/* Reset counters and add up sizes/items of the given paths (no symlink following). */
void fo_reset(FoJob *job);
void fo_scan(FoJob *job, const char *const *paths, int count);

/* Copy `src` (file or folder, recursively) to the exact path `dst`.
 * On failure/cancel the partial `dst` is removed; `src` is never touched. */
int fo_copy(FoJob *job, const char *src, const char *dst, FoProgressFn cb, void *user);

/* Move `src` to `dst`. Same drive: instant rename. Different drive: copy,
 * verify, then delete the source. On failure/cancel the source is kept. */
int fo_move(FoJob *job, const char *src, const char *dst, FoProgressFn cb, void *user);

/* Delete `path` (recursively for folders). Returns -1 only on cancel. */
int fo_delete(FoJob *job, const char *path, FoProgressFn cb, void *user);

/* 1 if path exists (or its state can't be determined - treated as existing
 * so nothing is ever overwritten), 0 only if it definitely does not exist. */
int fo_exists(const char *path);

/* lstat() with a stat() fallback for C libraries where lstat is unavailable. */
int fo_lstat(const char *path, struct stat *st);

/* Test hook: force the cross-drive (copy + delete) path in fo_move. */
extern int fo_force_copy_move;
