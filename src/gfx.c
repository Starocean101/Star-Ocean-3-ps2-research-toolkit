/* gfx.c - minimal 2D framebuffer renderer for PS4 (sceVideoOut). */
#include "gfx.h"
#include "font_data.h"
#include "icons_data.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <orbis/libkernel.h>
#include <orbis/VideoOut.h>

#define NUM_FB 2
#define FB_SIZE (SCREEN_W * SCREEN_H * 4)
#define ALIGN_2MB 0x200000

static int       s_video = -1;
static uint32_t *s_fb[NUM_FB];
static int       s_cur;
static int64_t   s_frame;
static OrbisKernelEqueue s_flipq;
static unsigned s_flip_errors, s_flip_timeouts;
static int      s_last_flip_error;
static uint32_t *s_px;     /* where drawing goes: the cached shadow buffer */
static uint32_t *s_shadow; /* normal (cached) RAM. Video memory is write-combined:
                              reading it back for blending is extremely slow, so we
                              compose here and copy the finished frame out once. */

int gfx_init(void)
{
    s_video = sceVideoOutOpen(ORBIS_VIDEO_USER_MAIN, ORBIS_VIDEO_OUT_BUS_MAIN, 0, 0);
    if (s_video < 0) return -1;
    if (sceKernelCreateEqueue(&s_flipq, "extractor flip") < 0) return -2;
    sceVideoOutAddFlipEvent(s_flipq, s_video, 0);

    size_t total = ((size_t)FB_SIZE * NUM_FB + ALIGN_2MB - 1) / ALIGN_2MB * ALIGN_2MB;
    off_t phys = 0;
    void *mem = NULL;
    if (sceKernelAllocateDirectMemory(0, sceKernelGetDirectMemorySize(), total, ALIGN_2MB, 3, &phys) < 0) return -3;
    if (sceKernelMapDirectMemory(&mem, total, 0x33, 0, phys, ALIGN_2MB) < 0) return -4;

    for (int i = 0; i < NUM_FB; i++) s_fb[i] = (uint32_t *)((char *)mem + (size_t)FB_SIZE * i);

    OrbisVideoOutBufferAttribute attr;
    memset(&attr, 0, sizeof(attr));
    sceVideoOutSetBufferAttribute(&attr, 0x80000000, 1, 0, SCREEN_W, SCREEN_H, SCREEN_W);
    if (sceVideoOutRegisterBuffers(s_video, 0, (void **)s_fb, NUM_FB, &attr) != 0) return -5;
    sceVideoOutSetFlipRate(s_video, 0);
    s_shadow = aligned_alloc(64, FB_SIZE);
    if (!s_shadow) return -6;
    memset(s_shadow, 0, FB_SIZE);
    s_cur = 0;
    s_px = s_shadow;
    return 0;
}

/* ---- handing the screen to the GPU renderer (gpu.c) and back ---- */
static void (*s_presenter)(const uint32_t *fb);
void gfx_set_presenter(void (*fn)(const uint32_t *fb)) { s_presenter = fn; }
const uint32_t *gfx_pixels(void) { return s_shadow; }

int gfx_suspend(void)
{
    if (s_video < 0) return 0;
    int rc = sceVideoOutClose(s_video);
    s_video = -1;
    return rc < 0 ? rc : 0;
}

int gfx_resume(void)
{
    if (s_video >= 0) return 0;
    s_video = sceVideoOutOpen(ORBIS_VIDEO_USER_MAIN, ORBIS_VIDEO_OUT_BUS_MAIN, 0, 0);
    if (s_video < 0) return s_video;
    sceVideoOutAddFlipEvent(s_flipq, s_video, 0);
    OrbisVideoOutBufferAttribute attr;
    memset(&attr, 0, sizeof(attr));
    sceVideoOutSetBufferAttribute(&attr, 0x80000000, 1, 0, SCREEN_W, SCREEN_H, SCREEN_W);
    int rc = sceVideoOutRegisterBuffers(s_video, 0, (void **)s_fb, NUM_FB, &attr);
    if (rc != 0) return rc < 0 ? rc : -5;
    sceVideoOutSetFlipRate(s_video, 0);
    s_cur = 0;
    return 0;
}

static inline uint32_t enc(Color c);
static uint32_t *s_bg; /* pre-encoded 1920x1080 background, or NULL */

int gfx_load_bg(const char *path)
{
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    size_t npx = (size_t)SCREEN_W * SCREEN_H;
    unsigned char *rgb = malloc(npx * 3);
    uint32_t *enc = malloc(npx * 4);
    if (!rgb || !enc) { free(rgb); free(enc); fclose(f); return -2; }
    size_t got = fread(rgb, 1, npx * 3, f);
    fclose(f);
    if (got != npx * 3) { free(rgb); free(enc); return -3; }
    for (size_t i = 0; i < npx; i++)
        enc[i] = 0x80000000u | (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2];
    free(rgb);
    free(s_bg);
    s_bg = enc;
    return 0;
}

void gfx_draw_bg(void)
{
    if (s_bg) {
        memcpy(s_px, s_bg, (size_t)SCREEN_W * SCREEN_H * 4);
        return;
    }
    /* fallback: deep-space vertical gradient */
    for (int y = 0; y < SCREEN_H; y++) {
        int r = 8 + y * 10 / SCREEN_H;
        int g = 12 + y * 18 / SCREEN_H;
        int b = 30 + y * 60 / SCREEN_H;
        uint32_t v = enc(RGB(r, g, b));
        uint32_t *row = s_px + y * SCREEN_W;
        for (int x = 0; x < SCREEN_W; x++) row[x] = v;
    }
}

void gfx_begin_frame(void) { s_px = s_shadow; }

void gfx_flip_stats(unsigned *errors, unsigned *timeouts, int *last_error)
{
    *errors = s_flip_errors;
    *timeouts = s_flip_timeouts;
    *last_error = s_last_flip_error;
}

void gfx_end_frame(void)
{
    if (s_presenter) { s_presenter(s_shadow); return; }   /* the GPU renderer owns the screen */
    if (s_video < 0) { sceKernelUsleep(16000); return; }
    memcpy(s_fb[s_cur], s_shadow, FB_SIZE); /* one sequential write into video memory */
    s_frame++;
    int rc = sceVideoOutSubmitFlip(s_video, s_cur, ORBIS_VIDEO_OUT_FLIP_VSYNC, s_frame);
    if (rc < 0) {
        /* flip rejected (e.g. video not ready yet): don't wait for an event that
         * will never come - that was a way to hang forever on a black screen */
        s_flip_errors++;
        s_last_flip_error = rc;
        sceKernelUsleep(16000);
        return;
    }
    for (int tries = 0; tries < 3; tries++) { /* at most ~0.3 s, never forever */
        OrbisVideoOutFlipStatus st;
        OrbisKernelEvent ev;
        int n = 0;
        OrbisKernelUseconds timeout = 100000;
        sceVideoOutGetFlipStatus(s_video, &st);
        if (st.flipArg >= s_frame) break;
        int w = sceKernelWaitEqueue(s_flipq, &ev, 1, &n, &timeout);
        if (w != 0 && w != (int)0x8002003C /* ETIMEDOUT */) { s_flip_errors++; s_last_flip_error = w; break; }
        if (tries == 2) s_flip_timeouts++;
    }
    s_cur = (s_cur + 1) % NUM_FB;
}

static inline uint32_t enc(Color c) { return 0x80000000u | (c & 0xFFFFFF); }

void gfx_clear(Color c)
{
    uint32_t v = enc(c);
    for (int i = 0; i < SCREEN_W * SCREEN_H; i++) s_px[i] = v;
}

void gfx_rect(int x, int y, int w, int h, Color c)
{
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > SCREEN_W) w = SCREEN_W - x;
    if (y + h > SCREEN_H) h = SCREEN_H - y;
    if (w <= 0 || h <= 0) return;
    uint32_t v = enc(c);
    for (int yy = y; yy < y + h; yy++) {
        uint32_t *row = s_px + yy * SCREEN_W + x;
        for (int xx = 0; xx < w; xx++) row[xx] = v;
    }
}

/* a: 0..255. Red+blue are blended together in one multiply, green in another. */
static inline uint32_t blend(uint32_t dst, Color c, int a)
{
    uint32_t a256 = (uint32_t)a + ((uint32_t)a >> 7); /* 0..256 */
    uint32_t ia = 256 - a256;
    uint32_t rb = (((c & 0xFF00FF) * a256 + (dst & 0xFF00FF) * ia) >> 8) & 0xFF00FF;
    uint32_t g  = (((c & 0x00FF00) * a256 + (dst & 0x00FF00) * ia) >> 8) & 0x00FF00;
    return 0x80000000u | rb | g;
}

void gfx_rect_blend(int x, int y, int w, int h, Color c, int alpha)
{
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > SCREEN_W) w = SCREEN_W - x;
    if (y + h > SCREEN_H) h = SCREEN_H - y;
    if (w <= 0 || h <= 0 || alpha <= 0) return;
    if (alpha >= 255) { gfx_rect(x, y, w, h, c); return; }
    uint32_t a256 = (uint32_t)alpha + ((uint32_t)alpha >> 7), ia = 256 - a256;
    uint32_t crb = (c & 0xFF00FF) * a256, cg = (c & 0x00FF00) * a256; /* hoisted */
    for (int yy = y; yy < y + h; yy++) {
        uint32_t *row = s_px + yy * SCREEN_W + x;
        for (int xx = 0; xx < w; xx++) {
            uint32_t d = row[xx];
            row[xx] = 0x80000000u | (((crb + (d & 0xFF00FF) * ia) >> 8) & 0xFF00FF)
                                  | (((cg  + (d & 0x00FF00) * ia) >> 8) & 0x00FF00);
        }
    }
}

int gfx_char_w(int font) { return font == FONT_LARGE ? FONT_L_W : FONT_S_W; }
int gfx_char_h(int font) { return font == FONT_LARGE ? FONT_L_H : FONT_S_H; }

/* Decode one UTF-8 codepoint; advances *s. Invalid bytes yield '?'. */
static uint32_t next_cp(const unsigned char **s)
{
    const unsigned char *p = *s;
    uint32_t cp;
    int n;
    if (p[0] < 0x80) { *s = p + 1; return p[0]; }
    if ((p[0] & 0xE0) == 0xC0) { cp = p[0] & 0x1F; n = 1; }
    else if ((p[0] & 0xF0) == 0xE0) { cp = p[0] & 0x0F; n = 2; }
    else if ((p[0] & 0xF8) == 0xF0) { cp = p[0] & 0x07; n = 3; }
    else { *s = p + 1; return '?'; }
    for (int i = 1; i <= n; i++) {
        if ((p[i] & 0xC0) != 0x80) { *s = p + 1; return '?'; }
        cp = (cp << 6) | (p[i] & 0x3F);
    }
    *s = p + n + 1;
    return cp;
}

static int glyph_index(uint32_t cp)
{
    if (cp >= 1 && cp <= 4) return 224 + (int)cp - 1;
    if (cp >= 0x20 && cp <= 0xFF) return (int)cp - 0x20;
    return '?' - 0x20;
}

static void draw_glyph(int font, int x, int y, Color c, int gi)
{
    int w = gfx_char_w(font), h = gfx_char_h(font);
    const unsigned char *g = font == FONT_LARGE ? &FONT_L_DATA[gi][0][0] : &FONT_S_DATA[gi][0][0];
    for (int yy = 0; yy < h; yy++) {
        int py = y + yy;
        if (py < 0 || py >= SCREEN_H) continue;
        uint32_t *row = s_px + py * SCREEN_W;
        for (int xx = 0; xx < w; xx++) {
            int px = x + xx;
            int a = g[yy * w + xx];
            if (!a || px < 0 || px >= SCREEN_W) continue;
            row[px] = a == 255 ? enc(c) : blend(row[px], c, a);
        }
    }
}

/* Button icons (\x01 cross, \x02 circle, \x03 triangle, \x04 square) are
 * drawn from the RGBA sprites and are wider than a character cell. */
static int icon_px(int font) { return font == FONT_LARGE ? ICON_L : ICON_S; }

static int advance(int font, uint32_t cp)
{
    return (cp >= 1 && cp <= 4) ? icon_px(font) + 6 : gfx_char_w(font);
}

static void draw_icon(int font, int x, int y, int idx)
{
    int sz = icon_px(font);
    const unsigned char *px = font == FONT_LARGE ? &ICON_L_DATA[idx][0][0][0] : &ICON_S_DATA[idx][0][0][0];
    y += (gfx_char_h(font) - sz) / 2; /* centre on the text line */
    for (int yy = 0; yy < sz; yy++) {
        int py = y + yy;
        if (py < 0 || py >= SCREEN_H) continue;
        uint32_t *row = s_px + py * SCREEN_W;
        for (int xx = 0; xx < sz; xx++) {
            const unsigned char *p = px + (yy * sz + xx) * 4;
            int a = p[3], qx = x + 2 + xx;
            if (!a || qx < 0 || qx >= SCREEN_W) continue;
            Color c = RGB(p[0], p[1], p[2]);
            row[qx] = a == 255 ? enc(c) : blend(row[qx], c, a);
        }
    }
}

int gfx_text_clip(int font, int x, int y, Color c, const char *utf8, int max_px)
{
    const unsigned char *s = (const unsigned char *)utf8;
    int cw = gfx_char_w(font);
    int limit = max_px > 0 ? x + max_px : SCREEN_W;
    int total = gfx_text_width(font, utf8);
    int clip = max_px > 0 && total > max_px;
    while (*s) {
        uint32_t cp = next_cp(&s);
        if (clip && x + advance(font, cp) + cw * 3 > limit) {
            for (int i = 0; i < 3; i++, x += cw) draw_glyph(font, x, y, c, '.' - 0x20);
            break;
        }
        if (cp >= 1 && cp <= 4) draw_icon(font, x, y, (int)cp - 1);
        else draw_glyph(font, x, y, c, glyph_index(cp));
        x += advance(font, cp);
    }
    return x;
}

int gfx_text(int font, int x, int y, Color c, const char *utf8)
{
    return gfx_text_clip(font, x, y, c, utf8, 0);
}

int gfx_text_width(int font, const char *utf8)
{
    const unsigned char *s = (const unsigned char *)utf8;
    int w = 0;
    while (*s) w += advance(font, next_cp(&s));
    return w;
}

void gfx_image(int dx, int dy, int dw, int dh, const uint8_t *rgba, int iw, int ih,
               int64_t sx0, int64_t sy0, int64_t step, int bg)
{
    static int col[SCREEN_W];
    if (dx < 0) { sx0 += -dx * step; dw += dx; dx = 0; }
    if (dy < 0) { sy0 += -dy * step; dh += dy; dy = 0; }
    if (dx + dw > SCREEN_W) dw = SCREEN_W - dx;
    if (dy + dh > SCREEN_H) dh = SCREEN_H - dy;
    if (dw <= 0 || dh <= 0 || !rgba || step <= 0) return;
    for (int i = 0; i < dw; i++) {
        int64_t sx = (sx0 + i * step) >> 16;
        col[i] = (sx >= 0 && sx < iw) ? (int)sx : -1;
    }
    for (int j = 0; j < dh; j++) {
        int64_t sy = (sy0 + j * step) >> 16;
        uint32_t *row = s_px + (dy + j) * SCREEN_W + dx;
        if (sy < 0 || sy >= ih) continue;
        const uint8_t *src = rgba + (size_t)sy * iw * 4;
        int yy = dy + j;
        for (int i = 0; i < dw; i++) {
            if (col[i] < 0) continue;
            const uint8_t *p = src + (size_t)col[i] * 4;
            uint32_t a = p[3], r = p[0], g = p[1], b = p[2];
            if (a != 255) {
                uint32_t bgc = bg == 1 ? 0 : bg == 2 ? 255 : ((((dx + i) >> 4) ^ (yy >> 4)) & 1) ? 0x99 : 0x66;
                r = (r * a + bgc * (255 - a)) / 255;
                g = (g * a + bgc * (255 - a)) / 255;
                b = (b * a + bgc * (255 - a)) / 255;
            }
            row[i] = 0x80000000u | r << 16 | g << 8 | b;
        }
    }
}
