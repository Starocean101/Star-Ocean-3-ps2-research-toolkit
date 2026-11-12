/* log.c - file logger with an in-memory ring buffer for on-screen display. */
#include "log.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <errno.h>

static char s_path[1024];
static char s_ring[LOG_RING][LOG_LINE];
static int  s_head;   /* next write index */
static int  s_count;
static LogClockFn s_clock;

void logger_set_clock(LogClockFn fn) { s_clock = fn; }

static void mkdirs(const char *path)
{
    char tmp[1024];
    snprintf(tmp, sizeof(tmp), "%s", path);
    for (char *p = tmp + 1; *p; p++)
        if (*p == '/') { *p = 0; mkdir(tmp, 0777); *p = '/'; }
}

/* Returns the folder part of a file path into out. */
static void dirpart(const char *file, char *out, size_t n)
{
    snprintf(out, n, "%s", file);
    char *s = strrchr(out, '/');
    if (s) *s = 0;
}

void logger_init(const char *path)
{
    char dir[1024];
    snprintf(s_path, sizeof(s_path), "%s", path);
    dirpart(s_path, dir, sizeof(dir));
    mkdirs(dir);
}

int logger_set_path(const char *path)
{
    char dir[1024];
    dirpart(path, dir, sizeof(dir));
    mkdirs(dir);
    FILE *f = fopen(path, "a"); /* verify writable before committing */
    if (!f) return -1;
    fclose(f);
    snprintf(s_path, sizeof(s_path), "%s", path);
    logx("Log file set to: %s", path);
    return 0;
}

int logger_try_init(const char *path)
{
    char dir[1024];
    dirpart(path, dir, sizeof(dir));
    mkdirs(dir);
    FILE *f = fopen(path, "a");
    if (!f) return -1;
    fclose(f);
    snprintf(s_path, sizeof(s_path), "%s", path);
    return 0;
}

const char *logger_path(void) { return s_path; }

void logx(const char *fmt, ...)
{
    char line[4096]; /* full line for the file; the on-screen ring keeps a short copy */
    int y, mo, d, h, mi, sec;
    if (!s_clock || s_clock(&y, &mo, &d, &h, &mi, &sec) != 0) {
        time_t now = time(NULL);
        struct tm tmv;
        localtime_r(&now, &tmv);
        y = tmv.tm_year + 1900; mo = tmv.tm_mon + 1; d = tmv.tm_mday;
        h = tmv.tm_hour; mi = tmv.tm_min; sec = tmv.tm_sec;
    }
    int off = snprintf(line, sizeof(line), "[%04d-%02d-%02d %02d:%02d:%02d] ", y, mo, d, h, mi, sec);

    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line + off, sizeof(line) - off, fmt, ap);
    va_end(ap);

    snprintf(s_ring[s_head], LOG_LINE, "%s", line);
    s_head = (s_head + 1) % LOG_RING;
    if (s_count < LOG_RING) s_count++;

    if (s_path[0]) {
        FILE *f = fopen(s_path, "a");
        if (!f) { /* log folder was deleted/moved: recreate it */
            char dir[1024];
            dirpart(s_path, dir, sizeof(dir));
            mkdirs(dir);
            mkdir(dir, 0777);
            f = fopen(s_path, "a");
        }
        if (f) { fprintf(f, "%s\n", line); fclose(f); }
    }
}

int logger_ring_count(void) { return s_count; }

const char *logger_ring_line(int i)
{
    if (i < 0 || i >= s_count) return "";
    int start = (s_head - s_count + LOG_RING) % LOG_RING;
    return s_ring[(start + i) % LOG_RING];
}
