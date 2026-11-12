/* log.h - file logger + in-memory ring for on-screen viewing. */
#pragma once

#define LOG_RING 64
#define LOG_LINE 160

/* Optional clock provider (e.g. the PS4 RTC for local time). Fills
 * y/mo/d/h/mi/s and returns 0; if unset or failing, libc localtime is used. */
typedef int (*LogClockFn)(int *y, int *mo, int *d, int *h, int *mi, int *s);
void logger_set_clock(LogClockFn fn);

void logger_init(const char *path);     /* set log file path (creates folders) */
int  logger_set_path(const char *path); /* change path at runtime (logs it); 0 on success */
int  logger_try_init(const char *path); /* silent: use path if writable; 0 on success */
const char *logger_path(void);
void logx(const char *fmt, ...);         /* append a timestamped line */

int  logger_ring_count(void);
const char *logger_ring_line(int i);    /* 0 = oldest kept line */
