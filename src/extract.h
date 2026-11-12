/*
 * extract.h - platform-independent archive extraction engine (libarchive).
 *
 * Streams every entry straight to disk in fixed-size blocks, so memory use
 * stays constant no matter how large the archive or its files are.
 */
#pragma once

#include <stdint.h>
#include <stddef.h>

#define EX_MAX_VOLUMES 512
#define EX_PATH_MAX    1024

typedef struct {
    /* Input */
    const char *volumes[EX_MAX_VOLUMES + 1]; /* NULL-terminated, in order  */
    int         volume_count;
    uint64_t    input_total;                  /* sum of all volume sizes    */

    /* Output */
    char        dest_dir[EX_PATH_MAX];
    int         overwrite;                    /* 1 = replace existing files */

    /* Live progress (read by the UI from the progress callback) */
    char        current_entry[EX_PATH_MAX];
    uint64_t    entry_size;      /* 0 if unknown                           */
    uint64_t    entry_done;
    uint64_t    input_done;      /* compressed bytes consumed               */
    uint64_t    bytes_written;   /* uncompressed bytes written in total     */
    uint32_t    files_done;
    uint32_t    files_skipped;
    uint32_t    dirs_created;
    uint32_t    warnings;
    char        last_warning[512];

    /* Result */
    int         cancelled;
    int         failed;
    char        error[512];
} ExJob;

/* Return non-zero from the callback to cancel the extraction. */
typedef int (*ExProgressFn)(ExJob *job, void *user);

/* Run the extraction. Returns 0 on success, -1 on failure/cancel. */
int ex_run(ExJob *job, ExProgressFn cb, void *user);

/* Fill job->volumes for the archive at `path`, detecting multi-part sets
 * (name.part1.rar, name.rar + name.r00.., name.7z.001, name.zip.001 ...).
 * Strings are heap-allocated; free with ex_free_volumes(). */
int  ex_collect_volumes(ExJob *job, const char *path);
void ex_free_volumes(ExJob *job);

/* Helpers shared with the UI */
int  ex_is_archive_name(const char *name);
/* Returns 1 if this file is a secondary volume that should be hidden from
 * the browser (e.g. name.part2.rar, name.r05, name.7z.003). */
int  ex_is_secondary_volume(const char *name);
/* Base name for the output folder ("Movie.part1.rar" -> "Movie"). */
void ex_archive_stem(const char *name, char *out, size_t outsz);
int  ex_mkdirs(const char *path);
