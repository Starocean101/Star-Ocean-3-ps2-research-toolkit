/* names.h - Star Ocean 4 pack surveys: inner headers and the name finder.
 * Everything here only reads the archives; nothing is extracted. */
#pragma once
#include <stddef.h>
#include <stdint.h>

typedef struct {
    int      (*cb)(void *user);   /* progress; return nonzero to cancel */
    void     *user;
    int       skip_remaster;      /* skip IDs 10000 and up (remastered copies) */
    /* progress / results */
    uint32_t  packs_total, packs_done, packs_kcap, entries, names, prefixes, errors;
    uint64_t  bytes_out;          /* decompressed bytes scanned */
    char      current[64];        /* "pack 00713 entry 12" */
    int       cancelled;
    char      error[256];
} NfJob;

/* inner_headers.txt: one line per KCAP entry (first 64 KiB decompressed at most). */
int nf_inner_headers(const char *const *archives, int n, const char *out_txt, NfJob *j);

/* names.txt, names_by_prefix.txt and pack_names.txt in out_dir (every entry decompressed in memory). */
int nf_find_names(const char *const *archives, int n, const char *out_dir, NfJob *j);

/* Case-insensitive search of names.txt for `word`. Calls fn(line, user) for each matching
 * line (up to max calls); returns total matches, -1 if names.txt cannot be read.
 * packs/entries: distinct packs and pack+entry pairs among all matches. */
int nf_search(const char *names_txt, const char *word, int max, void (*fn)(const char *line, void *u), void *u,
              uint32_t *packs, uint32_t *entries);

/* 1 if a name is a believable label (not bytes of pixel data that happen to look like text). */
int nf_plausible(const char *name);

/* Best display label for a buffer (asset code + name, e.g. "cp005  cp005_face"). 0 if found. */
int nf_label_buf(const uint8_t *d, size_t n, char *out, size_t on);

/* Labels from pack_names.txt (loaded lazily, kept in memory). */
int         nf_labels_load(const char *pack_names_txt);   /* 0 ok */
void        nf_labels_free(void);
int         nf_labels_loaded(void);
const char *nf_label_pack(uint32_t pack);                 /* NULL if none */
const char *nf_label_entry(uint32_t pack, uint32_t entry);

/* Label computed on the fly from the data (KCAP: first entries' first 64 KiB; SLZ/raw: first 256 KiB). */
int nf_label_range(int fd, uint64_t off, uint64_t size, char *out, size_t on);
int nf_label_file(const char *path, char *out, size_t on);
