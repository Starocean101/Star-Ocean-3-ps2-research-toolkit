#ifndef AAC_H
#define AAC_H
#include <stddef.h>
#include <stdint.h>

/* tri-Ace ASKA audio container ("AAC ", not MPEG AAC). On PS4 the sounds are ATRAC9. */
typedef struct {
    int      supported;      /* 1 = ATRAC9 */
    uint32_t channels;       /* from the ATRAC9 config (1, 2, 4, 6, 8) */
    uint32_t rate;           /* Hz */
    uint32_t bytes_per_sec;
    uint32_t block;          /* superframe size in bytes */
    uint32_t samples_per_block;
    uint32_t samples;        /* total */
    uint32_t loop_start, loop_len; /* samples, 0 = none */
    uint8_t  config[4];      /* ATRAC9 config data (FE ..) */
    uint64_t off, len;       /* stream bytes inside the container */
} AacSound;

int  aac_is(const uint8_t *b, size_t n);
/* Lists up to max sounds; returns the count (may exceed max), -1 if not an AAC. */
int  aac_sounds(const uint8_t *d, size_t n, AacSound *out, int max);
/* RIFF ATRAC9 (.at9, playable with vgmstream / foobar2000 / ffmpeg). malloc'd; *outn = size. */
uint8_t *aac_make_at9(const uint8_t *d, size_t n, const AacSound *s, size_t *outn);
int  aac_channels_from_config(const uint8_t cfg[4]);
/* RIFF ATRAC9 (.at9) file: fills *s (off/len point into d). Returns 1 if it is one. */
int  at9_riff_sound(const uint8_t *d, size_t n, AacSound *s);

#endif
