/* r3d.c - software rasterizer for ASF models.
 *
 * Perspective camera looking at the model's bounding-box centre, Y up. Triangles are
 * double-sided, depth-tested, flat-lit by a light at the camera (plus ambient), and
 * optionally textured with perspective-correct, nearest-texel sampling and an alpha
 * test (the game's alphaMode is MASK). Edge functions are evaluated incrementally.
 */
#include "r3d.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

int r3d_target_init(R3dTarget *t, int w, int h)
{
    memset(t, 0, sizeof *t);
    t->w = w; t->h = h; t->cap_w = w; t->cap_h = h;
    t->rgba = malloc((size_t)w * h * 4);
    t->zbuf = malloc((size_t)w * h * sizeof(float));
    if (!t->rgba || !t->zbuf) { r3d_target_free(t); return -1; }
    return 0;
}

static void mips_free(R3dTarget *t)
{
    for (int i = 0; i < t->mip_n; i++)
        for (int l = 1; l < t->mip[i].levels; l++) free(t->mip[i].px[l]);      /* level 0 is the model's own */
    free(t->mip); t->mip = NULL; t->mip_n = 0; t->mip_model = NULL;
}

/* Box-filtered half-size copies, down to 1 pixel. A failed allocation just ends the chain. */
static void mips_build(R3dTarget *t, const AsfModel *m)
{
    if (t->mip_model == (const void *)m && t->mip_n == m->ntex) return;
    mips_free(t);
    if (m->ntex <= 0) { t->mip_model = m; return; }
    t->mip = calloc((size_t)m->ntex, sizeof *t->mip);
    if (!t->mip) return;
    t->mip_n = m->ntex; t->mip_model = m;
    for (int i = 0; i < m->ntex; i++) {
        struct R3dMip *M = &t->mip[i];
        M->w[0] = (int)m->tex[i].w; M->h[0] = (int)m->tex[i].h; M->px[0] = m->tex[i].rgba; M->levels = 1;
        if (M->w[0] < 1 || M->h[0] < 1 || !M->px[0]) { M->levels = 0; continue; }
        while (M->levels < 14 && (M->w[M->levels - 1] > 1 || M->h[M->levels - 1] > 1)) {
            int l = M->levels, pw = M->w[l - 1], ph = M->h[l - 1], w = pw > 1 ? pw / 2 : 1, h = ph > 1 ? ph / 2 : 1;
            uint8_t *d = malloc((size_t)w * h * 4);
            if (!d) break;
            const uint8_t *sp = M->px[l - 1];
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++) {
                    int x0 = x * 2 < pw ? x * 2 : pw - 1, x1 = x * 2 + 1 < pw ? x * 2 + 1 : pw - 1;
                    int y0 = y * 2 < ph ? y * 2 : ph - 1, y1 = y * 2 + 1 < ph ? y * 2 + 1 : ph - 1;
                    const uint8_t *a = sp + ((size_t)y0 * pw + x0) * 4, *b = sp + ((size_t)y0 * pw + x1) * 4,
                                  *c = sp + ((size_t)y1 * pw + x0) * 4, *e = sp + ((size_t)y1 * pw + x1) * 4;
                    uint8_t *o = d + ((size_t)y * w + x) * 4;
                    for (int k = 0; k < 4; k++) o[k] = (uint8_t)((a[k] + b[k] + c[k] + e[k] + 2) >> 2);
                }
            M->w[l] = w; M->h[l] = h; M->px[l] = d; M->levels++;
        }
    }
}

void r3d_forget_model(R3dTarget *t) { mips_free(t); }

void r3d_target_free(R3dTarget *t)
{
    mips_free(t);
    free(t->rgba); free(t->zbuf); free(t->tmp);
    memset(t, 0, sizeof *t);
}

/* per vertex: screen x, y, 1/w, view-space normal-free (lighting is per face) */
#define VS 7   /* sx, sy, iw, vx, vy, vz, shade */

static void bg_fill(R3dTarget *t)
{
    /* dark vertical gradient */
    for (int y = 0; y < t->h; y++) {
        int c = 18 + 22 * y / t->h;
        uint8_t *row = t->rgba + (size_t)y * t->w * 4;
        for (int x = 0; x < t->w; x++) { row[x * 4] = (uint8_t)(c * 0.55f); row[x * 4 + 1] = (uint8_t)(c * 0.65f); row[x * 4 + 2] = (uint8_t)c; row[x * 4 + 3] = 255; }
    }
    for (size_t i = 0; i < (size_t)t->w * t->h; i++) t->zbuf[i] = 0.f;   /* stores 1/w: 0 = far */
}

static void put_line(R3dTarget *t, float x0, float y0, float x1, float y1)
{
    float dx = x1 - x0, dy = y1 - y0;
    int n = (int)(fabsf(dx) > fabsf(dy) ? fabsf(dx) : fabsf(dy)) + 1;
    if (n > 4096) return;
    for (int i = 0; i <= n; i++) {
        int x = (int)(x0 + dx * i / n), y = (int)(y0 + dy * i / n);
        if (x < 0 || y < 0 || x >= t->w || y >= t->h) continue;
        uint8_t *p = t->rgba + ((size_t)y * t->w + x) * 4;
        p[0] = 120; p[1] = 220; p[2] = 255;
    }
}

int r3d_render(R3dTarget *t, const AsfModel *m, const R3dView *v)
{
    if (t->w > t->cap_w) t->w = t->cap_w;
    if (t->h > t->cap_h) t->h = t->cap_h;
    mips_build(t, m);
    bg_fill(t);
    t->tris_drawn = t->pixels = 0;
    float cx = (m->mn[0] + m->mx[0]) * .5f, cy = (m->mn[1] + m->mx[1]) * .5f, cz = (m->mn[2] + m->mx[2]) * .5f;
    float ex = m->mx[0] - m->mn[0], ey = m->mx[1] - m->mn[1], ez = m->mx[2] - m->mn[2];
    float radius = .5f * sqrtf(ex * ex + ey * ey + ez * ez);
    if (!(radius > 1e-6f)) radius = 1.f;
    float zoom = v->zoom > 0.05f ? v->zoom : 0.05f;
    const float fov = 0.75f;                          /* ~43 degrees vertical */
    float focal = (t->h * .5f) / tanf(fov * .5f);
    float dist = radius / sinf(fov * .5f) / zoom;     /* camera distance so the bounding sphere fits */
    float cyw = cosf(v->yaw), syw = sinf(v->yaw), cp = cosf(v->pitch), sp = sinf(v->pitch);
    float near = radius * 0.01f;
    float px = v->pan_x * radius, py = v->pan_y * radius;

    for (int mi = 0; mi < m->nmesh; mi++) {
        const AsfMesh *me = &m->mesh[mi];
        if (me->nv > t->tmp_cap) {
            float *nt = realloc(t->tmp, sizeof(float) * VS * me->nv);
            if (!nt) return -1;
            t->tmp = nt; t->tmp_cap = me->nv;
        }
        for (uint32_t i = 0; i < me->nv; i++) {
            float x = me->pos[i * 3] - cx, y = me->pos[i * 3 + 1] - cy, z = me->pos[i * 3 + 2] - cz;
            float x1 = cyw * x + syw * z, z1 = -syw * x + cyw * z;          /* yaw around Y */
            float y2 = cp * y - sp * z1, z2 = sp * y + cp * z1;              /* pitch around X */
            x1 -= px; y2 -= py;
            float zc = dist - z2;                                             /* camera looks down -Z */
            float *o = t->tmp + (size_t)i * VS;
            o[3] = x1; o[4] = y2; o[5] = zc;
            o[6] = 1.f;
            if (me->nrm) {          /* smooth lighting: the vertex normal against the direction to the eye */
                float nx = me->nrm[i * 3], ny = me->nrm[i * 3 + 1], nz = me->nrm[i * 3 + 2];
                float nx1 = cyw * nx + syw * nz, nz1 = -syw * nx + cyw * nz;
                float ny2 = cp * ny - sp * nz1, nz2 = sp * ny + cp * nz1;
                float ll = sqrtf(x1 * x1 + y2 * y2 + zc * zc);
                float dd = ll > 0 ? fabsf(-nx1 * x1 - ny2 * y2 + nz2 * zc) / ll : 1.f;
                if (dd > 1.f) dd = 1.f;
                o[6] = 0.34f + 0.66f * dd;
            }
            if (zc < near) { o[2] = -1.f; continue; }
            float iw = 1.f / zc;
            o[0] = t->w * .5f + x1 * focal * iw;
            o[1] = t->h * .5f - y2 * focal * iw;
            o[2] = iw;
        }
        const struct R3dMip *mp = v->textured && me->tex >= 0 && me->tex < t->mip_n && me->uv && t->mip[me->tex].levels > 0 ? &t->mip[me->tex] : NULL;
        int smooth = me->nrm != NULL;
        for (uint32_t k = 0; k + 2 < me->ni; k += 3) {
            const float *A = t->tmp + (size_t)me->ind[k] * VS, *B = t->tmp + (size_t)me->ind[k + 1] * VS, *C = t->tmp + (size_t)me->ind[k + 2] * VS;
            if (A[2] <= 0 || B[2] <= 0 || C[2] <= 0) continue;               /* behind the camera: skip */
            float area = (B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]);
            if (fabsf(area) < 1e-6f) continue;
            /* flat lighting: face normal in view space vs. direction to the camera */
            float ux = B[3] - A[3], uy = B[4] - A[4], uz = B[5] - A[5], wx = C[3] - A[3], wy = C[4] - A[4], wz = C[5] - A[5];
            float nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
            float nl = sqrtf(nx * nx + ny * ny + nz * nz);
            float shade = 1.f;
            if (nl > 0) {
                float lx = -(A[3] + B[3] + C[3]), ly = -(A[4] + B[4] + C[4]), lz = -(A[5] + B[5] + C[5]);   /* to the eye */
                float ll = sqrtf(lx * lx + ly * ly + lz * lz);
                float d = ll > 0 ? fabsf(nx * lx + ny * ly + nz * lz) / (nl * ll) : 1.f;
                shade = 0.30f + 0.70f * d;
            }
            int minx = (int)floorf(fminf(A[0], fminf(B[0], C[0]))), maxx = (int)ceilf(fmaxf(A[0], fmaxf(B[0], C[0])));
            int miny = (int)floorf(fminf(A[1], fminf(B[1], C[1]))), maxy = (int)ceilf(fmaxf(A[1], fmaxf(B[1], C[1])));
            if (minx < 0) minx = 0;
            if (miny < 0) miny = 0;
            if (maxx > t->w - 1) maxx = t->w - 1;
            if (maxy > t->h - 1) maxy = t->h - 1;
            if (minx > maxx || miny > maxy) continue;
            if ((maxx - minx) > 4 * t->w || (maxy - miny) > 4 * t->h) continue;
            t->tris_drawn++;
            float ia = 1.f / area;
            /* barycentric weights w0 (for A), w1 (B), w2 (C) as edge functions, stepped per pixel */
            float e0x = (B[1] - C[1]) * ia, e0y = (C[0] - B[0]) * ia;   /* w0 changes by e0x per +x, e0y per +y */
            float e1x = (C[1] - A[1]) * ia, e1y = (A[0] - C[0]) * ia;
            float sx = minx + .5f, sy = miny + .5f;
            float w0r = ((B[0] - sx) * (C[1] - sy) - (C[0] - sx) * (B[1] - sy)) * ia;
            float w1r = ((C[0] - sx) * (A[1] - sy) - (A[0] - sx) * (C[1] - sy)) * ia;
            float uA = 0, vA = 0, uB = 0, vB = 0, uC = 0, vC = 0;
            const uint8_t *tpx = NULL; int tw = 1, th = 1;
            if (mp) {
                const float *ua = me->uv + me->ind[k] * 2, *ub = me->uv + me->ind[k + 1] * 2, *uc = me->uv + me->ind[k + 2] * 2;
                /* pick the copy whose texels are about one pixel big on this triangle */
                float ta = fabsf((ub[0] - ua[0]) * (uc[1] - ua[1]) - (uc[0] - ua[0]) * (ub[1] - ua[1])) * (float)mp->w[0] * (float)mp->h[0];
                float ratio = ta / fabsf(area);
                int lv = 0;
                while (ratio > 2.0f && lv + 1 < mp->levels) { ratio *= 0.25f; lv++; }
                tpx = mp->px[lv]; tw = mp->w[lv]; th = mp->h[lv];
                uA = ua[0] * A[2]; vA = ua[1] * A[2];
                uB = ub[0] * B[2]; vB = ub[1] * B[2];
                uC = uc[0] * C[2]; vC = uc[1] * C[2];
            }
            float sA = smooth ? A[6] : shade, sB = smooth ? B[6] : shade, sC = smooth ? C[6] : shade;
            for (int y = miny; y <= maxy; y++, w0r += e0y, w1r += e1y) {
                float w0 = w0r, w1 = w1r;
                float *zrow = t->zbuf + (size_t)y * t->w;
                uint8_t *prow = t->rgba + (size_t)y * t->w * 4;
                for (int x = minx; x <= maxx; x++, w0 += e0x, w1 += e1x) {
                    float w2 = 1.f - w0 - w1;
                    if (w0 < -1e-5f || w1 < -1e-5f || w2 < -1e-5f) continue;
                    float iw = w0 * A[2] + w1 * B[2] + w2 * C[2];
                    if (iw <= zrow[x]) continue;
                    uint8_t r, gg, b;
                    float sh = w0 * sA + w1 * sB + w2 * sC;
                    if (tpx) {
                        float zz = 1.f / iw;
                        float u = (w0 * uA + w1 * uB + w2 * uC) * zz, vv = (w0 * vA + w1 * vB + w2 * vC) * zz;
                        u -= floorf(u); vv -= floorf(vv);
                        if (!(u >= 0 && u < 1)) u = 0;
                        if (!(vv >= 0 && vv < 1)) vv = 0;
                        if (v->quality) {                   /* bilinear, wrapping at the edges */
                            float fx = u * tw - .5f, fy = vv * th - .5f;
                            if (fx < 0) fx += tw;
                            if (fy < 0) fy += th;
                            int x0 = (int)fx, y0 = (int)fy;
                            int ax = (int)((fx - x0) * 256), ay = (int)((fy - y0) * 256);
                            if (x0 >= tw) x0 = tw - 1;
                            if (y0 >= th) y0 = th - 1;
                            int x1 = x0 + 1 < tw ? x0 + 1 : 0, y1 = y0 + 1 < th ? y0 + 1 : 0;
                            const uint8_t *p00 = tpx + ((size_t)y0 * tw + x0) * 4, *p10 = tpx + ((size_t)y0 * tw + x1) * 4,
                                          *p01 = tpx + ((size_t)y1 * tw + x0) * 4, *p11 = tpx + ((size_t)y1 * tw + x1) * 4;
                            int c4[4];
                            for (int q = 0; q < 4; q++) {
                                int top = p00[q] * (256 - ax) + p10[q] * ax, bot = p01[q] * (256 - ax) + p11[q] * ax;
                                c4[q] = (top * (256 - ay) + bot * ay) >> 16;
                            }
                            if (c4[3] < 128) continue;                    /* alpha test */
                            r = (uint8_t)(c4[0] * sh); gg = (uint8_t)(c4[1] * sh); b = (uint8_t)(c4[2] * sh);
                        } else {
                            int tx = (int)(u * tw), ty = (int)(vv * th);
                            if (tx >= tw) tx = tw - 1;
                            if (ty >= th) ty = th - 1;
                            const uint8_t *sp = tpx + ((size_t)ty * tw + tx) * 4;
                            if (sp[3] < 128) continue;                    /* alpha test */
                            r = (uint8_t)(sp[0] * sh); gg = (uint8_t)(sp[1] * sh); b = (uint8_t)(sp[2] * sh);
                        }
                    } else { float g = 200 * sh; r = (uint8_t)(g * 0.95f); gg = (uint8_t)(g * 0.85f); b = (uint8_t)(g * 0.72f); }
                    zrow[x] = iw;
                    uint8_t *p = prow + x * 4;
                    p[0] = r; p[1] = gg; p[2] = b; p[3] = 255;
                    t->pixels++;
                }
            }
        }
        if (v->wire)
            for (uint32_t k = 0; k + 2 < me->ni; k += 3) {
                const float *A = t->tmp + (size_t)me->ind[k] * VS, *B = t->tmp + (size_t)me->ind[k + 1] * VS, *C = t->tmp + (size_t)me->ind[k + 2] * VS;
                if (A[2] <= 0 || B[2] <= 0 || C[2] <= 0) continue;
                put_line(t, A[0], A[1], B[0], B[1]); put_line(t, B[0], B[1], C[0], C[1]); put_line(t, C[0], C[1], A[0], A[1]);
            }
    }
    return 0;
}
