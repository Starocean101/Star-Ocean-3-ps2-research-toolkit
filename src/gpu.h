/* gpu.h - experimental GPU renderer (OpenGL ES 2 through the PS4's Piglet library). */
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "asf.h"
#include "r3d.h"

enum { GPU_TIER_NONE = 0, GPU_TIER_GLSL = 1, GPU_TIER_SYSTEM = 2 };

void gpu_set_log(void (*fn)(const char *line));
/* 0 = let gpu_start choose; GPU_TIER_SYSTEM = skip the GLSL compiler (testing). */
void gpu_force_tier(int tier);

/* Loads the libraries, takes the screen over from the software renderer, creates the GL
 * context and the shaders. 0 ok. On failure the software screen is restored and err says
 * which step failed; -2 means the screen could not be restored. */
int  gpu_start(char *err, size_t en);
int  gpu_active(void);
int  gpu_tier(void);
const char *gpu_info(void);            /* e.g. "GLSL shaders, depth 16" */

/* Shows a finished software frame (the normal UI) through GL. */
void gpu_present_fb(const uint32_t *fb);

/* Model: upload textures once, then draw each frame. hud_fb is the software frame whose
 * top `top_h` and bottom `bot_h` rows are drawn over the scene. *ms = draw time. */
int  gpu_model_upload(const AsfModel *m);
void gpu_model_free(void);
void gpu_model_draw(const AsfModel *m, const R3dView *v, const uint32_t *hud_fb, int top_h, int bot_h, double *ms,
                    uint32_t *draw_calls);

#ifdef GPU_HOST
/* Host tests: copy the last drawn frame (before the swap), bottom row first. */
void gpu_host_read(uint8_t *rgba);
#endif

/* Probe: tries Piglet set-ups from test `first` (1-based) onward and writes every step to
 * `file`. out gets each line as well. Returns the first working test number, 0 none,
 * -1 cannot run, -2 screen not restored. */
int  gpu_probe(int first, const char *file, void (*out)(const char *), char *summary, size_t sn);
int  gpu_probe_count(void);
int  gpu_probe_next(void);   /* test to continue at after a restart, 0 = finished */
