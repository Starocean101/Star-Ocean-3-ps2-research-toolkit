/* at9dec.h - ATRAC9 decoding with the PS4's audio hardware (libSceAjm). */
#pragma once
#include <stddef.h>
#include <stdint.h>

/* Decodes a raw ATRAC9 stream (whole superframes) to interleaved signed 16-bit PCM.
 * channels: from the config. Returns malloc'd PCM and *frames (samples per channel), or NULL
 * with err filled (the AJM return codes are included for the log). progress may be NULL;
 * returning nonzero from it cancels. */
int16_t *at9_decode(const uint8_t *stream, size_t len, const uint8_t config[4], int channels,
                    uint32_t block, uint32_t samples_per_block, uint32_t total_samples,
                    uint32_t *frames, int (*progress)(void *u, double done), void *u,
                    char *err, size_t en);
/* Text describing what the last decode tried (for the log). */
const char *at9_last_diag(void);
