/* aac.c - tri-Ace ASKA audio container (Star Ocean 4, PS4).
 *
 * Layout (little-endian on PS4):
 *   +0x00 " CAA" (reversed "AAC "), +0x04 u32 total size
 *   +0x20 section table: 16-byte rows (offset, 0x80, size, alignment) until a zero row:
 *         "BOAA" objects (holds the "EVAW" sound records), "BCRV", "BVAW" (wave data)
 *   EVAW record:
 *     +0x10 u32 1, +0x14 u32 (u8 codec 0x18 = ATRAC9, u8 ?, u8 channels), +0x18 u32 rate
 *     +0x30 u32 data offset (from the file start), +0x34 u32 data size,
 *     +0x38/+0x3c loop start / length in samples (also at +0x40/+0x44 on some)
 *     +0x50 u32 bytes per second, u16 superframe bytes, u16 samples per superframe,
 *           u32 total samples, u32 ATRAC9 config (stored byte-reversed: FE is the high byte)
 * Verified: 659 of 660 containers decode with ffmpeg's ATRAC9 decoder to plausible audio.
 * The channel count must come from the ATRAC9 config, not the record (music is 4-channel).
 */
#include "aac.h"
#include <stdlib.h>
#include <string.h>

static uint16_t rd16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }
static uint32_t rd32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static void wr16(uint8_t *p, uint32_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
static void wr32(uint8_t *p, uint32_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24); }

int aac_is(const uint8_t *b, size_t n) { return n >= 0x50 && !memcmp(b, " CAA", 4); }

int aac_channels_from_config(const uint8_t cfg[4])
{
    static const int ch[8] = { 1, 2, 2, 6, 8, 4, 0, 0 };
    if (cfg[0] != 0xFE) return 0;
    return ch[(cfg[1] >> 1) & 7];
}

static uint32_t at9_rate(const uint8_t cfg[4])
{
    static const uint32_t r[16] = { 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000,
                                    44100, 48000, 64000, 88200, 96000, 128000, 176400, 192000 };
    return r[cfg[1] >> 4];
}

int aac_sounds(const uint8_t *d, size_t n, AacSound *out, int max)
{
    if (!aac_is(d, n)) return -1;
    size_t lo = 0, hi = n;
    for (size_t o = 0x20; o + 16 <= 0x50; o += 16) {
        uint32_t so = rd32(d + o), sz = rd32(d + o + 8);
        if (!so) break;
        if ((size_t)so + 4 <= n && !memcmp(d + so, "BOAA", 4)) { lo = so; hi = (size_t)so + sz < n ? (size_t)so + sz : n; }
    }
    int cnt = 0;
    for (size_t p = lo & ~(size_t)15; p + 0x70 <= n && p < hi; p += 16) {
        if (memcmp(d + p, "EVAW", 4)) continue;
        AacSound s;
        memset(&s, 0, sizeof s);
        uint32_t fmt = rd32(d + p + 0x10), kind = rd32(d + p + 0x14);
        s.rate = rd32(d + p + 0x18);
        s.off = rd32(d + p + 0x30); s.len = rd32(d + p + 0x34);
        s.loop_start = rd32(d + p + 0x40); s.loop_len = rd32(d + p + 0x44);
        s.bytes_per_sec = rd32(d + p + 0x50);
        s.block = rd16(d + p + 0x54); s.samples_per_block = rd16(d + p + 0x56);
        s.samples = rd32(d + p + 0x58);
        uint32_t cfg = rd32(d + p + 0x5c);
        s.config[0] = (uint8_t)(cfg >> 24); s.config[1] = (uint8_t)(cfg >> 16); s.config[2] = (uint8_t)(cfg >> 8); s.config[3] = (uint8_t)cfg;
        s.channels = (uint32_t)aac_channels_from_config(s.config);
        s.supported = fmt == 1 && (kind & 0xff) == 0x18 && s.channels && s.block && s.samples_per_block &&
                      s.off < n && s.len <= n - s.off && s.len >= s.block;
        if (s.supported && !s.rate) s.rate = at9_rate(s.config);
        if (s.supported) {   /* drop the zero padding after the last superframe (decoders reject it) */
            uint64_t need = ((uint64_t)s.samples + s.samples_per_block - 1) / s.samples_per_block * s.block;
            if (need && need < s.len) s.len = need;
        }
        if (s.loop_start + (uint64_t)s.loop_len > s.samples) s.loop_start = s.loop_len = 0;
        if (cnt < max) out[cnt] = s;
        cnt++;
    }
    return cnt;
}

uint8_t *aac_make_at9(const uint8_t *d, size_t n, const AacSound *s, size_t *outn)
{
    if (!s->supported || s->off > n || s->len > n - s->off) return NULL;
    static const uint8_t guid[16] = { 0xD2, 0x42, 0xE1, 0x47, 0xBA, 0x36, 0x8D, 0x4D, 0x88, 0xFC, 0x61, 0x65, 0x4F, 0x8C, 0x83, 0x6C };
    uint32_t mask = s->channels == 1 ? 0x4 : s->channels == 2 ? 0x3 : s->channels == 4 ? 0x33 : s->channels == 6 ? 0x3F : s->channels == 8 ? 0x63F : 0;
    size_t fmt_n = 52, fact_n = 12, smpl_n = s->loop_len ? 60 : 0;
    size_t total = 12 + 8 + fmt_n + 8 + fact_n + (smpl_n ? 8 + smpl_n : 0) + 8 + (size_t)s->len;
    uint8_t *o = malloc(total);
    if (!o) return NULL;
    uint8_t *p = o;
    memcpy(p, "RIFF", 4); wr32(p + 4, (uint32_t)(total - 8)); memcpy(p + 8, "WAVE", 4); p += 12;
    memcpy(p, "fmt ", 4); wr32(p + 4, (uint32_t)fmt_n); p += 8;
    wr16(p, 0xFFFE); wr16(p + 2, s->channels); wr32(p + 4, s->rate); wr32(p + 8, s->bytes_per_sec);
    wr16(p + 12, s->block); wr16(p + 14, 0); wr16(p + 16, 34); wr16(p + 18, s->samples_per_block);
    wr32(p + 20, mask); memcpy(p + 24, guid, 16); wr32(p + 40, 2); memcpy(p + 44, s->config, 4); wr32(p + 48, 0);
    p += fmt_n;
    memcpy(p, "fact", 4); wr32(p + 4, (uint32_t)fact_n); wr32(p + 8, s->samples); wr32(p + 12, 0); wr32(p + 16, 0); p += 8 + fact_n;
    if (smpl_n) {   /* standard smpl chunk with one forward loop */
        memset(p, 0, 8 + smpl_n);
        memcpy(p, "smpl", 4); wr32(p + 4, (uint32_t)smpl_n);
        wr32(p + 8 + 12, 1000000000u / (s->rate ? s->rate : 48000));
        wr32(p + 8 + 28, 1);
        wr32(p + 8 + 36 + 8, s->loop_start);
        wr32(p + 8 + 36 + 12, s->loop_start + s->loop_len - 1);
        p += 8 + smpl_n;
    }
    memcpy(p, "data", 4); wr32(p + 4, (uint32_t)s->len); memcpy(p + 8, d + s->off, (size_t)s->len);
    *outn = total;
    return o;
}

/* A RIFF ATRAC9 file (.at9), such as the ones this tool exports. Returns 1 and fills *s. */
int at9_riff_sound(const uint8_t *d, size_t n, AacSound *s)
{
    static const uint8_t guid[16] = { 0xD2, 0x42, 0xE1, 0x47, 0xBA, 0x36, 0x8D, 0x4D, 0x88, 0xFC, 0x61, 0x65, 0x4F, 0x8C, 0x83, 0x6C };
    if (n < 12 || memcmp(d, "RIFF", 4) || memcmp(d + 8, "WAVE", 4)) return 0;
    memset(s, 0, sizeof *s);
    int have_fmt = 0, have_data = 0;
    size_t p = 12;
    while (p + 8 <= n) {
        uint32_t sz = (uint32_t)d[p + 4] | (uint32_t)d[p + 5] << 8 | (uint32_t)d[p + 6] << 16 | (uint32_t)d[p + 7] << 24;
        size_t body = p + 8, left = n - body;
        if (!memcmp(d + p, "fmt ", 4) && sz >= 52 && left >= 52) {
            const uint8_t *f = d + body;
            if ((f[0] | f[1] << 8) != 0xFFFE || memcmp(f + 24, guid, 16)) return 0;
            s->rate = (uint32_t)f[4] | (uint32_t)f[5] << 8 | (uint32_t)f[6] << 16 | (uint32_t)f[7] << 24;
            s->bytes_per_sec = (uint32_t)f[8] | (uint32_t)f[9] << 8 | (uint32_t)f[10] << 16 | (uint32_t)f[11] << 24;
            s->block = (uint32_t)f[12] | (uint32_t)f[13] << 8;
            s->samples_per_block = (uint32_t)f[18] | (uint32_t)f[19] << 8;
            memcpy(s->config, f + 44, 4);
            int ch = aac_channels_from_config(s->config);
            s->channels = ch > 0 ? (uint32_t)ch : (uint32_t)(f[2] | f[3] << 8);
            have_fmt = 1;
        } else if (!memcmp(d + p, "fact", 4) && sz >= 4 && left >= 4) {
            s->samples = (uint32_t)d[body] | (uint32_t)d[body + 1] << 8 | (uint32_t)d[body + 2] << 16 | (uint32_t)d[body + 3] << 24;
        } else if (!memcmp(d + p, "data", 4)) {
            s->off = body; s->len = sz <= left ? sz : left;
            have_data = 1;
            break;
        }
        if (sz > left) break;
        p = body + sz + (sz & 1);
    }
    if (!have_fmt || !have_data || !s->block || !s->samples_per_block || !s->channels || s->channels > 8) return 0;
    s->len -= s->len % s->block;                 /* whole superframes only */
    if (!s->len) return 0;
    if (!s->samples) s->samples = (uint32_t)(s->len / s->block) * s->samples_per_block;
    s->supported = 1;
    return 1;
}
