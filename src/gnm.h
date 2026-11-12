/* gnm.h - GNM GPU probe (v1.38) */
#pragma once
#include <stddef.h>

#define GNM_PROBE_VER "1.38"

/* Runs the tiered GNM probe. Writes a step-by-step report to `file` (flushed to disk before
 * each step) and also to `out` for the on-screen log. `verdict` gets a one-line summary.
 * Returns 0 if it ran to the end, >0 at the tier it stopped, <0 on a host build. */
int gnm_probe(const char *file, void (*out)(const char *), char *verdict, size_t vn);
