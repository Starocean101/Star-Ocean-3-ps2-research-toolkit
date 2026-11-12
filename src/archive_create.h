/* archive_create.h - create a .zip from selected files/folders (libarchive). */
#pragma once

#include <stdint.h>
#include <stddef.h>

#define AC_PATH_MAX 1024
#define AC_MAX_ITEMS 2048

typedef struct {
    char      base_dir[AC_PATH_MAX];      /* names are stored relative to this */
    char      out_path[AC_PATH_MAX];      /* .zip to create (never added to itself) */
    int       deflate;                    /* 1 = compress, 0 = store */

    /* Progress */
    char      current[AC_PATH_MAX];
    uint64_t  total_bytes;
    uint64_t  done_bytes;
    uint32_t  total_files;
    uint32_t  files_done;
    uint32_t  dirs_done;
    uint32_t  skipped;
    uint32_t  warnings;
    char      last_warning[512];

    int       cancelled;
    int       failed;
    char      error[512];
} AcJob;

typedef int (*AcProgressFn)(AcJob *job, void *user); /* non-zero cancels */

/* Pre-scan to fill total_files / total_bytes for the progress bar. */
void ac_scan(AcJob *job, const char *const *paths, int count);

/* Build the zip from `count` absolute paths (files or folders). */
int  ac_run(AcJob *job, const char *const *paths, int count, AcProgressFn cb, void *user);

/* True if path is dir or inside it (boundary-safe prefix test). */
int  ac_path_within(const char *path, const char *dir);
