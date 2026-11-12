/* r3d.h - small software renderer for ASF models (CPU only, no GPU needed). */
#pragma once
#include <stdint.h>
#include "asf.h"

typedef struct {
    float yaw, pitch;     /* radians */
    float zoom;           /* 1 = whole model fits */
    float pan_x, pan_y;   /* in model radii */
    int   textured;       /* 0 = shaded grey */
    int   wire;           /* draw triangle edges on top */
    int   quality;        /* 1 = smooth (bilinear) texture filtering, for a still picture */
} R3dView;

typedef struct {
    int       w, h;
    uint8_t  *rgba;       /* w*h*4 */
    float    *zbuf;       /* w*h */
    float    *tmp;        /* transformed vertices (grown as needed) */
    uint32_t  tmp_cap;
    uint64_t  tris_drawn, pixels;
    /* smaller copies of every texture, so far-away surfaces do not sparkle */
    const void *mip_model; int mip_n;
    struct R3dMip { int levels; int w[14], h[14]; uint8_t *px[14]; } *mip;
    int       cap_w, cap_h;   /* size the buffers were made for; w/h may be set lower */
} R3dTarget;

int  r3d_target_init(R3dTarget *t, int w, int h);
void r3d_target_free(R3dTarget *t);
/* Must be called before a model that was rendered is freed or changed. */
void r3d_forget_model(R3dTarget *t);
/* Clears and renders the whole model. Returns 0, or -1 out of memory. */
int  r3d_render(R3dTarget *t, const AsfModel *m, const R3dView *v);
