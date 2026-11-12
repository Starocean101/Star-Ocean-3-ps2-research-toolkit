/* gfx.h - minimal 2D framebuffer renderer for PS4 (sceVideoOut). */
#pragma once
#include <stdint.h>

#define SCREEN_W 1920
#define SCREEN_H 1080

/* Private glyph codes for PlayStation button symbols (see gen_font.py). */
#define GLYPH_CROSS    "\x01"
#define GLYPH_CIRCLE   "\x02"
#define GLYPH_TRIANGLE "\x03"
#define GLYPH_SQUARE   "\x04"

typedef uint32_t Color; /* 0x00RRGGBB */

#define RGB(r, g, b) (((uint32_t)(r) << 16) | ((uint32_t)(g) << 8) | (uint32_t)(b))

enum { FONT_SMALL = 0, FONT_LARGE = 1 };

int  gfx_init(void);
void gfx_begin_frame(void);           /* select back buffer */
void gfx_end_frame(void);             /* flip + wait vsync (bounded, never hangs) */
/* GPU renderer hand-over: close / reopen the software video output, and an optional
 * presenter that shows each finished frame instead of the normal flip. */
int  gfx_suspend(void);
int  gfx_resume(void);
void gfx_set_presenter(void (*fn)(const uint32_t *fb));
const uint32_t *gfx_pixels(void);
void gfx_flip_stats(unsigned *errors, unsigned *timeouts, int *last_error);
void gfx_clear(Color c);
/* Load a 1920x1080 raw-RGB background from disk into an internal buffer.
 * Returns 0 on success. If not loaded, gfx_draw_bg() falls back to a gradient. */
int  gfx_load_bg(const char *path);
void gfx_draw_bg(void);               /* blit background (or gradient) to back buffer */
void gfx_rect(int x, int y, int w, int h, Color c);
void gfx_rect_blend(int x, int y, int w, int h, Color c, int alpha);
/* Draws UTF-8 text; returns the x position after the last glyph. */
int  gfx_text(int font, int x, int y, Color c, const char *utf8);
/* Same, but clips to max_px width (adds "..." when clipped). */
int  gfx_text_clip(int font, int x, int y, Color c, const char *utf8, int max_px);
int  gfx_text_width(int font, const char *utf8);
/* Draw an RGBA image (alpha-blended over a background) into the screen rect
 * (dx,dy,dw,dh). Source pixel for screen column i is (sx0 + i*step) >> 16
 * (16.16 fixed point), same for rows. bg: 0 checkerboard, 1 black, 2 white. */
void gfx_image(int dx, int dy, int dw, int dh, const uint8_t *rgba, int iw, int ih,
               int64_t sx0, int64_t sy0, int64_t step, int bg);
int  gfx_char_w(int font);
int  gfx_char_h(int font);
