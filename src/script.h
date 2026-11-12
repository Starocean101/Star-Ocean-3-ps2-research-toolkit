/*
 * script.h - batch runner for the tool's OWN file operations.
 *
 * A script is a plain-text file, one command per line, that automates the
 * same actions the menus do: list / extract / unpack / convert / dump / copy
 * / zip. It never runs console code or external programs - every line maps to
 * a function already in this app. Output is confined to the allowed storage
 * roots (/data, /mnt/usbN, /mnt/ext0); the system partitions are never touched.
 *
 * Commands (# starts a comment, also after a command; blank lines ignored):
 *   cd <dir>                 base folder for later relative paths
 *   dest <dir>               where output is written (must be writable storage)
 *   list <archive>           write listing_<stem>.txt for a CPK / Star Ocean 4 archive
 *   magic [archive...]       magic.txt: first 32 bytes of every file (default 0000.bin + 0001.bin)
 *   innerheaders [all] [archive|folder...]  inner_headers.txt: every KCAP entry's header (read-only)
 *   names [all] [archive|folder...]  names.txt, names_by_prefix.txt, pack_names.txt (read-only)
 *                            ("all" keeps IDs 10000+; a folder = extracted NNNNN.bin packs)
 *   extract <archive> <id|name|a-b>...   extract entries to <dest>/<stem>/
 *   extractall <archive>     extract every entry
 *   unpack <file|*.ext|*>    auto-detect unpack/convert into <dest>/<name>_unpacked/
 *   unpackid <archive> <id|a-b>...  unpack entries in place (e.g. KCAP packs in 0001.bin)
 *                            into <dest>/<stem>_unpacked/<ID>/
 *   convert <file|*.ext|*>   DDS/PNG/TGA/BMP -> PNG in <dest>
 *   dump <file> <off> <len>  copy a byte range (hex 0x.. or decimal) to <dest>
 *   copy <src> <dst>         copy a file
 *   zip <out.zip> <path>...  build a zip from files/folders
 *   mkdir <dir>
 *   echo <text>              write a line to the log
 *   stop-on-error on|off     default on
 */
#ifndef SCRIPT_H
#define SCRIPT_H

#include <stdint.h>
#include <stddef.h>

typedef struct {
    /* progress / cancel: cb returns non-zero to cancel */
    int  (*cb)(void *user);
    void *user;
    const char *current;     /* line being run (for a progress screen) */
    uint32_t line;           /* 1-based line number being run */
    uint32_t lines_total;
    uint32_t ok;             /* commands that succeeded */
    uint32_t failed;         /* commands that failed */
    uint32_t files;          /* output files written across all commands */
    int      cancelled;
    int      stopped;        /* stopped early on an error (stop-on-error) */
    char     error[256];     /* first error */
} ScriptJob;

/* Run the script at `path`. Returns 0 if every command succeeded, 1 if some
 * failed (details in job), -1 if the script file itself could not be read,
 * -2 if cancelled. A log is written to <dest>/script_log.txt once `dest` is
 * set (before that, lines are logged via the host logger only). */
int script_run(const char *path, ScriptJob *job);

/* Count runnable (non-blank, non-comment) lines, for a progress total. */
int script_count(const char *path);

#endif
