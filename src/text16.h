/* text16.h - find UTF-16LE strings (the game's text tables, EXD files). */
#pragma once
#include <stddef.h>
#include <stdint.h>
/* Calls fn(offset, utf8, user) for every NUL-terminated UTF-16LE run of 2+ characters that
 * reads as text (newlines shown as " | "). Returns the count. */
int u16_strings(const uint8_t *d, size_t n, void (*fn)(size_t off, const char *utf8, void *u), void *u);
