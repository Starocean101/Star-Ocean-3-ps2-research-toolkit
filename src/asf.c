/* tri-Ace ASKA ASF model (Star Ocean: The Last Hope, PS4) -> glTF 2.0 binary (.glb)
 *
 * Verified against the game executable: the index stream decoder is a port of the
 * routine at 0xf1320 in the SO4 PS4 eboot. Vertex layouts were validated against the
 * stated strides of 2,406 meshes; weights sum to 65535, normals are unit length.
 *
 * File layout (all little-endian, chunk headers 16-byte aligned, tags stored reversed):
 *   mbdy  +0x10 u32 vertex count, +0x14 u32 index count; followed by idxl, vlas, mess
 *   idxl  +0x20 16-byte id of the index data in the addr table
 *   vlas  +0x10 u32 vertex format descriptor, +0x18 u32 stride, +0x20 16-byte id
 *   mess  +0x14 s32 displacement to the mats (material) chunk
 *   mats  +0x18 u8 texture count, +0x2c u32 offset of the texture table (32-byte entries,
 *         first 8 bytes = texture key)
 *   imgX  +0x10 8-byte key, +0x20 u8 format, +0x28/+0x2a u16 w/h, +0x30 u16 bytes/block,
 *         +0x32/+0x34 u16 blocks w/h, +0x40 16-byte id
 *   buff  +0x18 u64 offset of the data, +0x2c u32 kind (2 texture, 5 vertex, 0xb index)
 *   addr  +0x10 16-byte id, +0x20 u64 size, +0x28 u64 offset into the buffer
 *
 * Index stream: u16 words. H = word 0. cur = H-1. For each word: v = cur - w;
 * cur = max(cur, v + H). Words are consumed in groups (a,b,c); if a < b a fourth word d
 * follows and the group is the quad (a,b,c),(a,d,b); else the triangle (a,b,c).
 * H == 0xffff: the words are raw indices in the same grouping. Front faces are clockwise.
 */
#include "asf.h"
#include "formats.h"
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>
#include <unistd.h>

static uint16_t le16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }
static uint32_t le32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static uint64_t le64(const uint8_t *p) { return (uint64_t)le32(p) | (uint64_t)le32(p + 4) << 32; }

int asf_is(const uint8_t *b, size_t n) { return n >= 0x20 && !memcmp(b, " FSA", 4); }

/* ---------------------------------------------------------------- index decoder */
size_t asf_decode_indices(const uint16_t *w, size_t nw, uint16_t *out, size_t cap)
{
    if (!nw) return 0;
    uint16_t H = w[0];
    size_t o = 0, i = 1;
    if (H == 0xffff) {
        while (i + 2 < nw) {
            uint16_t a = w[i], b = w[i + 1], c = w[i + 2];
            if (a < b) {
                if (i + 3 >= nw || o + 6 > cap) break;
                uint16_t d = w[i + 3];
                out[o++] = a; out[o++] = b; out[o++] = c; out[o++] = a; out[o++] = d; out[o++] = b; i += 4;
            } else {
                if (o + 3 > cap) break;
                out[o++] = a; out[o++] = b; out[o++] = c; i += 3;
            }
        }
        return o;
    }
    uint16_t cur = (uint16_t)(H - 1);
#define NEXT(v) do { v = (uint16_t)(cur - w[i++]); uint16_t t_ = (uint16_t)(v + H); if (cur <= t_) cur = t_; } while (0)
    while (i + 2 < nw) {
        uint16_t a, b, c;
        NEXT(a); NEXT(b); NEXT(c);
        if (a < b) {
            if (i >= nw || o + 6 > cap) break;
            uint16_t d; NEXT(d);
            out[o++] = a; out[o++] = b; out[o++] = c; out[o++] = a; out[o++] = d; out[o++] = b;
        } else {
            if (o + 3 > cap) break;
            out[o++] = a; out[o++] = b; out[o++] = c;
        }
    }
#undef NEXT
    return o;
}

/* ---------------------------------------------------------------- chunk scan */
typedef struct { uint32_t off; char tag[5]; } Chunk;

static int tagch(uint8_t c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == ' '; }

static Chunk *scan_chunks(const uint8_t *d, size_t n, size_t limit, int *count)
{
    size_t cap = 256, k = 0;
    Chunk *ch = malloc(cap * sizeof *ch);
    if (!ch) return NULL;
    if (limit > n) limit = n;
    for (size_t o = 0; o + 16 <= limit; o += 16) {
        if (!(tagch(d[o]) && tagch(d[o + 1]) && tagch(d[o + 2]) && tagch(d[o + 3]))) continue;
        if (k == cap) { cap *= 2; Chunk *t = realloc(ch, cap * sizeof *ch); if (!t) { free(ch); return NULL; } ch = t; }
        ch[k].off = (uint32_t)o;
        ch[k].tag[0] = d[o + 3]; ch[k].tag[1] = d[o + 2]; ch[k].tag[2] = d[o + 1]; ch[k].tag[3] = d[o]; ch[k].tag[4] = 0;
        k++;
    }
    *count = (int)k;
    return ch;
}

typedef struct { uint32_t off; uint64_t data, size; uint32_t kind; } Buff;
typedef struct { const uint8_t *id; uint64_t size, off; } Addr;

/* ---------------------------------------------------------------- vertex layout */
typedef struct { int pos, nrm, col, uv, uvk, bin, wgt, bone, size; int pk; } Layout;

static int layout(uint32_t fmt, uint32_t fmt2, Layout *L)
{
    int s0 = fmt & 15, s1 = fmt >> 4 & 15, s2 = fmt >> 8 & 15, s3 = fmt >> 12 & 15, s4 = fmt >> 16 & 15, s7 = fmt >> 28 & 15;
    memset(L, -1, sizeof *L);
    int off = 0;
    L->pk = s0;
    if (s0 == 1) { L->pos = 0; off = 12; } else if (s0 == 4) { L->pos = 0; off = 16; } else if (s0 == 8) { L->pos = 0; off = 8; } else return -1;
    if (s1) { L->nrm = off; off += 8; }
    if (s7 & 1) { L->col = off; off += 4; }
    if (fmt2 & 0x10) off += 4;                 /* second colour set */
    if (s2) {
        L->uv = off; L->uvk = s2;
        if (s2 == 0xb) off += 4; else if (s2 == 1) off += 8; else if (s2 == 2) off += 16; else if (s2 == 0xd) off += 8; else return -1;
    }
    if (s3) off += 8;
    if (s4) { L->bin = off; off += 8; }
    if (s7 & 4) { L->wgt = off; off += 8; L->bone = off; off += 4; }
    L->size = off;
    return 0;
}

static float half2f(uint16_t h)
{
    uint32_t s = (h >> 15) & 1, e = (h >> 10) & 31, m = h & 1023, f;
    if (e == 0) {
        if (!m) f = s << 31;
        else { e = 1; while (!(m & 1024)) { m <<= 1; e--; } m &= 1023; f = s << 31 | (e + 112) << 23 | m << 13; }
    } else if (e == 31) f = s << 31 | 0x7f800000 | m << 13;
    else f = s << 31 | (e + 112) << 23 | m << 13;
    float r; memcpy(&r, &f, 4); return r;
}

/* ---------------------------------------------------------------- growable buffers */
typedef struct { uint8_t *p; size_t n, cap; } Buf;
static int bput(Buf *b, const void *d, size_t n)
{
    if (b->n + n > b->cap) {
        size_t c = b->cap ? b->cap : 65536;
        while (c < b->n + n) c *= 2;
        uint8_t *t = realloc(b->p, c);
        if (!t) return -1;
        b->p = t; b->cap = c;
    }
    if (n) memcpy(b->p + b->n, d, n);
    b->n += n;
    return 0;
}
static int bprintf(Buf *b, const char *fmt, ...)
{
    char tmp[512];
    va_list ap; va_start(ap, fmt);
    int k = vsnprintf(tmp, sizeof tmp, fmt, ap);
    va_end(ap);
    if (k < 0) return -1;
    if ((size_t)k >= sizeof tmp) k = sizeof tmp - 1;
    return bput(b, tmp, (size_t)k);
}
static int bpad4(Buf *b) { static const uint8_t z[4] = { 0 }; return bput(b, z, (4 - b->n % 4) % 4); }

/* PNG encoder into memory (RGBA8, no filtering). */
static int png_encode(const uint8_t *rgba, uint32_t w, uint32_t h, Buf *out)
{
    size_t row = (size_t)w * 4 + 1, rawn = row * h;
    uint8_t *raw = malloc(rawn);
    if (!raw) return -1;
    for (uint32_t y = 0; y < h; y++) { raw[y * row] = 0; memcpy(raw + y * row + 1, rgba + (size_t)y * w * 4, (size_t)w * 4); }
    uLongf zn = compressBound((uLong)rawn);
    uint8_t *z = malloc(zn);
    if (!z || compress2(z, &zn, raw, (uLong)rawn, 6) != Z_OK) { free(raw); free(z); return -1; }
    free(raw);
    static const uint8_t sig[8] = { 0x89, 'P', 'N', 'G', 13, 10, 26, 10 };
    uint8_t ihdr[13] = { (uint8_t)(w >> 24), (uint8_t)(w >> 16), (uint8_t)(w >> 8), (uint8_t)w,
                         (uint8_t)(h >> 24), (uint8_t)(h >> 16), (uint8_t)(h >> 8), (uint8_t)h, 8, 6, 0, 0, 0 };
    struct { const char *t; const uint8_t *d; size_t n; } ch[3] = { { "IHDR", ihdr, 13 }, { "IDAT", z, zn }, { "IEND", NULL, 0 } };
    int rc = bput(out, sig, 8);
    for (int k = 0; k < 3 && rc == 0; k++) {
        uint8_t hd[8] = { (uint8_t)(ch[k].n >> 24), (uint8_t)(ch[k].n >> 16), (uint8_t)(ch[k].n >> 8), (uint8_t)ch[k].n,
                          (uint8_t)ch[k].t[0], (uint8_t)ch[k].t[1], (uint8_t)ch[k].t[2], (uint8_t)ch[k].t[3] };
        rc |= bput(out, hd, 8);
        if (ch[k].n) rc |= bput(out, ch[k].d, ch[k].n);
        uLong c = crc32(0, hd + 4, 4);
        if (ch[k].n) c = crc32(c, ch[k].d, (uInt)ch[k].n);
        uint8_t cb[4] = { (uint8_t)(c >> 24), (uint8_t)(c >> 16), (uint8_t)(c >> 8), (uint8_t)c };
        rc |= bput(out, cb, 4);
    }
    free(z);
    return rc;
}

/* ---------------------------------------------------------------- loading */
#define MAXMESH 4096
#define MAXTEX  256

static const Addr *find_addr(const Addr *ad, int na, const uint8_t *id)
{
    for (int i = 0; i < na; i++) if (!memcmp(ad[i].id, id, 16)) return &ad[i];
    return NULL;
}

void asf_free(AsfModel *m)
{
    if (!m) return;
    for (int i = 0; i < m->nmesh; i++) { free(m->mesh[i].pos); free(m->mesh[i].nrm); free(m->mesh[i].uv); free(m->mesh[i].ind); }
    for (int i = 0; i < m->ntex; i++) free(m->tex[i].rgba);
    free(m->mesh); free(m->tex); free(m);
}

static int fcmp(const void *a, const void *b) { float x = *(const float *)a, y = *(const float *)b; return (x > y) - (x < y); }

/* The box the viewers frame: a sky dome or a marker parked two million units away
 * must not shrink everything else to a dot, so far outliers are left out of it. */
static void frame_box(AsfModel *M)
{
    uint64_t tot = 0;
    for (int i = 0; i < M->nmesh; i++) tot += M->mesh[i].nv;
    if (tot < 16) return;
    size_t step = (size_t)(tot / 60000 + 1), cap = (size_t)(tot / step + (size_t)M->nmesh + 1), k = 0;
    float *s = malloc(cap * sizeof(float));
    if (!s) return;
    for (int c = 0; c < 3; c++) {
        k = 0;
        for (int i = 0; i < M->nmesh; i++)
            for (uint32_t v = 0; v < M->mesh[i].nv && k < cap; v += (uint32_t)step) s[k++] = M->mesh[i].pos[v * 3 + c];
        if (k < 8) continue;
        qsort(s, k, sizeof(float), fcmp);
        float lo = s[k / 40], hi = s[k - 1 - k / 40], span = hi - lo;
        if (!(span > 0)) continue;
        if (M->mx[c] - M->mn[c] <= span * 2.5f) continue;      /* nothing far out: keep it all */
        lo -= span * .25f; hi += span * .25f;
        if (lo > M->mn[c]) M->mn[c] = lo;
        if (hi < M->mx[c]) M->mx[c] = hi;
    }
    free(s);
}

static void mesh_free(AsfMesh *me) { free(me->pos); free(me->nrm); free(me->uv); free(me->ind); }

/* For looking at a model: leave out what the game never shows as a surface (shadow
 * and collision hulls, which carry no texture coordinates) and the sky dome that
 * wraps a whole scene, so the scene inside can be seen. Returns how many were hidden. */
int asf_view_prepare(AsfModel *M)
{
    uint64_t tex_tris = 0, all = 0;
    for (int i = 0; i < M->nmesh; i++) { all += M->mesh[i].ni / 3; if (M->mesh[i].uv && M->mesh[i].tex >= 0) tex_tris += M->mesh[i].ni / 3; }
    if (M->nmesh < 2 || !all) return 0;
    int hidden = 0, w = 0;
    for (int i = 0; i < M->nmesh; i++) {
        AsfMesh *me = &M->mesh[i];
        int drop = 0;
        if (tex_tris * 2 >= all && (!me->uv || me->tex < 0)) drop = 1;
        else if (M->nmesh >= 4 && (uint64_t)(me->ni / 3) * 2 < all) {
            int wide = 1;
            for (int c = 0; c < 3; c++) if (me->mx[c] - me->mn[c] < 0.85f * (M->mx[c] - M->mn[c])) wide = 0;
            if (wide) {             /* faces looking at the middle: a dome seen from inside */
                float ce[3] = { (me->mn[0] + me->mx[0]) * .5f, (me->mn[1] + me->mx[1]) * .5f, (me->mn[2] + me->mx[2]) * .5f };
                uint32_t in = 0, out = 0;
                for (uint32_t k = 0; k + 2 < me->ni; k += 3) {
                    const float *A = me->pos + me->ind[k] * 3, *B = me->pos + me->ind[k + 1] * 3, *C = me->pos + me->ind[k + 2] * 3;
                    float ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], wx = C[0] - A[0], wy = C[1] - A[1], wz = C[2] - A[2];
                    float nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
                    float dd = nx * (A[0] - ce[0]) + ny * (A[1] - ce[1]) + nz * (A[2] - ce[2]);
                    if (dd < 0) in++; else if (dd > 0) out++;
                }
                if (in > out * 4) drop = 1;
            }
        }
        if (drop) { mesh_free(me); hidden++; }
        else M->mesh[w++] = *me;
    }
    if (!w) return 0;       /* cannot happen: drops need other meshes to exist */
    M->nmesh = w;
    for (int c = 0; c < 3; c++) { M->mn[c] = 1e30f; M->mx[c] = -1e30f; }
    for (int i = 0; i < w; i++)
        for (int c = 0; c < 3; c++) { if (M->mesh[i].mn[c] < M->mn[c]) M->mn[c] = M->mesh[i].mn[c]; if (M->mesh[i].mx[c] > M->mx[c]) M->mx[c] = M->mesh[i].mx[c]; }
    frame_box(M);
    return hidden;
}

AsfModel *asf_load(const uint8_t *d, size_t n, int want_tex, char *err, size_t en)
{
    if (!asf_is(d, n)) { snprintf(err, en, "not an ASF model"); return NULL; }
    int nch = 0;
    Chunk *ch = scan_chunks(d, n, n, &nch);
    if (!ch) { snprintf(err, en, "out of memory"); return NULL; }
    Buff bf[16]; int nb = 0; size_t first_data = n;
    for (int i = 0; i < nch; i++) {
        if (strcmp(ch[i].tag, "buff") || nb == 16 || ch[i].off + 0x30 > n) continue;
        uint32_t o = ch[i].off;
        bf[nb].off = o; bf[nb].size = le64(d + o + 0x10); bf[nb].data = o + le64(d + o + 0x18); bf[nb].kind = le32(d + o + 0x2c);
        if (bf[nb].data <= n && bf[nb].size <= n - bf[nb].data) { if (bf[nb].data < first_data) first_data = bf[nb].data; nb++; }
    }
    free(ch);
    if (!nb) { snprintf(err, en, "ASF has no data buffers"); return NULL; }
    /* re-scan only the header area (avoids false tags inside pixel/vertex data) */
    ch = scan_chunks(d, n, first_data, &nch);
    if (!ch) { snprintf(err, en, "out of memory"); return NULL; }
    Addr *ad = malloc(sizeof(Addr) * (size_t)(nch + 1)); int na = 0;
    AsfModel *M = calloc(1, sizeof *M);
    if (!ad || !M) { free(ch); free(ad); free(M); snprintf(err, en, "out of memory"); return NULL; }
    M->mn[0] = M->mn[1] = M->mn[2] = 1e30f; M->mx[0] = M->mx[1] = M->mx[2] = -1e30f;
    for (int i = 0; i < nch; i++) {
        if (strcmp(ch[i].tag, "addr") || ch[i].off + 0x30 > n) continue;
        uint32_t o = ch[i].off;
        ad[na].id = d + o + 0x10; ad[na].size = le64(d + o + 0x20); ad[na].off = le64(d + o + 0x28); na++;
    }
    const Buff *vb = NULL, *ib = NULL, *tb = NULL;
    for (int i = 0; i < nb; i++) { if (bf[i].kind == 5 && !vb) vb = &bf[i]; if (bf[i].kind == 0xb && !ib) ib = &bf[i]; if (bf[i].kind == 2 && !tb) tb = &bf[i]; }
    if (!vb || !ib) { free(ch); free(ad); free(M); snprintf(err, en, "ASF has no vertex/index buffers"); return NULL; }
    int capm = 0, capt = 0, oom = 0;
    uint32_t texmats[MAXTEX]; int teximg[MAXTEX]; int ntexcache = 0;
    uint32_t imgoff[MAXTEX]; int imgtex[MAXTEX]; int nimg = 0;

    /* ---- scene nodes: world matrix for every object (ao__) a node places */
    typedef struct { uint32_t ao; float m[12]; } Place;
    Place *pl = NULL; int npl = 0;
    for (int i = 0; i < nch; i++) {
        if (strcmp(ch[i].tag, "tree")) continue;
        uint32_t to = ch[i].off;
        if ((uint64_t)to + 0x120 > first_data) break;
        uint32_t cnt = le32(d + to + 0x10);
        if (!cnt || cnt > 20000) break;
        float *wm = malloc(sizeof(float) * 12 * (size_t)cnt);
        pl = malloc(sizeof(Place) * (size_t)cnt);
        if (!wm || !pl) { free(wm); free(pl); pl = NULL; break; }
        uint64_t p = (uint64_t)to + 0x120;
        for (uint32_t k = 0; k < cnt; k++) {
            if (p + 0x100 > first_data || memcmp(d + p, "rtta", 4)) break;
            uint32_t sz = le32(d + p + 4), par = le32(d + p + 0x3c), ao = le32(d + p + 0x34);
            if (sz < 0x100 || sz > 0x10000) break;
            float f[12];
            for (int c = 0; c < 12; c++) { uint32_t u = le32(d + p + 0x80 + 4 * (c + c / 3)); memcpy(&f[c], &u, 4); if (!(f[c] == f[c]) || f[c] > 1e9f || f[c] < -1e9f) f[c] = 0; }
            /* f[0..2] translation, then the quaternion x y z (w read apart), scale */
            float qx, qy, qz, qw, sx, sy, sz3; uint32_t u;
            u = le32(d + p + 0x90); memcpy(&qx, &u, 4); u = le32(d + p + 0x94); memcpy(&qy, &u, 4);
            u = le32(d + p + 0x98); memcpy(&qz, &u, 4); u = le32(d + p + 0x9c); memcpy(&qw, &u, 4);
            u = le32(d + p + 0xa0); memcpy(&sx, &u, 4); u = le32(d + p + 0xa4); memcpy(&sy, &u, 4); u = le32(d + p + 0xa8); memcpy(&sz3, &u, 4);
            float ql = sqrtf(qx * qx + qy * qy + qz * qz + qw * qw);
            if (!(ql > 1e-6f) || ql > 1e6f) { qx = qy = qz = 0; qw = 1; ql = 1; }
            qx /= ql; qy /= ql; qz /= ql; qw /= ql;
            /* helpers the game hides by scaling them to nothing are shown at full size */
            if (!(sx == sx) || fabsf(sx) > 1e6f || fabsf(sx) < 1e-5f) sx = 1;
            if (!(sy == sy) || fabsf(sy) > 1e6f || fabsf(sy) < 1e-5f) sy = 1;
            if (!(sz3 == sz3) || fabsf(sz3) > 1e6f || fabsf(sz3) < 1e-5f) sz3 = 1;
            float L[12] = {
                (1 - 2 * (qy * qy + qz * qz)) * sx, (2 * (qx * qy - qz * qw)) * sy, (2 * (qx * qz + qy * qw)) * sz3, f[0],
                (2 * (qx * qy + qz * qw)) * sx, (1 - 2 * (qx * qx + qz * qz)) * sy, (2 * (qy * qz - qx * qw)) * sz3, f[1],
                (2 * (qx * qz - qy * qw)) * sx, (2 * (qy * qz + qx * qw)) * sy, (1 - 2 * (qx * qx + qy * qy)) * sz3, f[2] };
            float *W = wm + 12 * (size_t)k;
            if (k && par < k) {
                const float *P = wm + 12 * (size_t)par;
                for (int r = 0; r < 3; r++) {
                    for (int c = 0; c < 4; c++)
                        W[r * 4 + c] = P[r * 4] * L[c] + P[r * 4 + 1] * L[4 + c] + P[r * 4 + 2] * L[8 + c] + (c == 3 ? P[r * 4 + 3] : 0);
                }
            } else memcpy(W, L, sizeof L);
            if (ao && (uint64_t)ao + 0x10 <= first_data && !memcmp(d + ao, "__oa", 4)) { pl[npl].ao = ao; memcpy(pl[npl].m, W, sizeof L); npl++; }
            p += sz;
        }
        free(wm);
        break;
    }

    for (int i = 0; i < nch && M->nmesh < MAXMESH && !oom; i++) {
        if (strcmp(ch[i].tag, "mess")) continue;
        const Chunk *ms = &ch[i];
        if (ms->off + 0x18 > n) continue;
        int64_t mb = (int64_t)ms->off + (int32_t)le32(d + ms->off + 0x10);
        if (mb < 0 || mb + 0x90 > (int64_t)first_data || memcmp(d + mb, "ydbm", 4)) continue;
        uint32_t o = (uint32_t)mb, io_ = o + 0x20, vo = o + 0x60;
        if (memcmp(d + io_, "lxdi", 4) || memcmp(d + vo, "salv", 4)) { M->st.skipped++; continue; }
        uint32_t nv = le32(d + o + 0x10), ni = le32(d + o + 0x14);
        const Addr *ia = find_addr(ad, na, d + io_ + 0x20), *va = find_addr(ad, na, d + vo + 0x20);
        if (!ia || !va) { M->st.skipped++; continue; }
        uint32_t fmt = le32(d + vo + 0x10), fmt2 = le32(d + vo + 0x14), stride = le32(d + vo + 0x18);
        Layout L;
        if (layout(fmt, fmt2, &L) != 0 || (uint32_t)L.size != stride || !nv || nv > 1000000 || !ni || ni % 3) { M->st.skipped++; continue; }
        if (va->off > vb->size || (uint64_t)nv * stride > vb->size - va->off) { M->st.skipped++; continue; }
        if (ia->off > ib->size || ia->size > ib->size - ia->off || ia->size < 2) { M->st.skipped++; continue; }
        const uint8_t *vd = d + vb->data + va->off;
        const uint8_t *idata = d + ib->data + ia->off;
        size_t nw = (size_t)ia->size / 2;
        if ((uint64_t)ni > (uint64_t)nw * 2) { M->st.skipped++; continue; }   /* more triangles than the stream can hold */
        uint16_t *words = malloc(nw * 2), *ind0 = malloc((size_t)ni * 2 + 12);
        if (!words || !ind0) { free(words); free(ind0); oom = 1; break; }
        for (size_t k = 0; k < nw; k++) words[k] = le16(idata + 2 * k);
        size_t got = asf_decode_indices(words, nw, ind0, ni + 6);
        free(words);
        if (got < ni) { free(ind0); M->st.skipped++; continue; }
        int bad = 0;
        for (uint32_t t = 0; t + 2 < ni; t += 3) { uint16_t tmp = ind0[t + 1]; ind0[t + 1] = ind0[t + 2]; ind0[t + 2] = tmp; if (ind0[t] >= nv || ind0[t + 1] >= nv || ind0[t + 2] >= nv) bad = 1; }
        if (bad) { free(ind0); M->st.skipped++; continue; }

        /* material: the first colour texture of the mats this mesh points at */
        int mtex = -1;
        if (want_tex && tb) {
            int64_t mo = (int64_t)ms->off + (int32_t)le32(d + ms->off + 0x14);
            if (mo >= 0 && mo + 0x30 <= (int64_t)first_data && !memcmp(d + mo, "stam", 4)) {
                int hit = -1;
                for (int k = 0; k < ntexcache; k++) if (texmats[k] == (uint32_t)mo) { hit = k; break; }
                if (hit >= 0) mtex = teximg[hit];
                else {
                    uint32_t toff = le32(d + mo + 0x2c); uint8_t ntex = d[mo + 0x18];
                    int pick = -1;
                    for (int pass = 0; pass < 2 && pick < 0 && toff; pass++)
                        for (int r = 0; r < ntex && pick < 0; r++) {
                            if ((uint64_t)mo + toff + 32 * (uint64_t)r + 8 > first_data) break;
                            const uint8_t *key = d + mo + toff + 32 * r;
                            for (int k = 0; k < nch; k++) {
                                if (strcmp(ch[k].tag, "imgX") || ch[k].off + 0x50 > n || memcmp(d + ch[k].off + 0x10, key, 8)) continue;
                                if (pass == 0 && (d[ch[k].off + 0x20] == 0x15 || d[ch[k].off + 0x20] == 0x01)) break;   /* normal / mask maps */
                                pick = k; break;
                            }
                        }
                    if (pick >= 0) {
                        uint32_t io = ch[pick].off;
                        for (int k = 0; k < nimg; k++) if (imgoff[k] == io) { mtex = imgtex[k]; break; }
                        const Addr *ta = mtex < 0 ? find_addr(ad, na, d + io + 0x40) : NULL;
                        if (ta && ta->off <= tb->size && ta->size <= tb->size - ta->off) {
                            uint32_t w = le16(d + io + 0x28), h = le16(d + io + 0x2a);
                            char terr[128];
                            uint8_t *rgba = aif_decode_pixels(d + tb->data + ta->off, (size_t)ta->size, d[io + 0x20], w, h,
                                                              le16(d + io + 0x30), le16(d + io + 0x32), le16(d + io + 0x34), terr, sizeof terr);
                            if (rgba && M->ntex == capt) {
                                int nc = capt ? capt * 2 : 8;
                                AsfTex *t = realloc(M->tex, sizeof(AsfTex) * (size_t)nc);
                                if (!t) { free(rgba); rgba = NULL; oom = 1; }
                                else { M->tex = t; capt = nc; }
                            }
                            if (rgba) {
                                /* alpha is only kept when it is a real cut-out mask: most
                                 * textures use the channel for gloss, not for opacity */
                                size_t np = (size_t)w * h, lo = 0, hi = 0;
                                for (size_t q = 0; q < np; q++) { uint8_t a = rgba[q * 4 + 3]; if (a < 24) lo++; else if (a > 232) hi++; }
                                int cut = np && lo + hi >= np - np / 10 && hi >= np / 4 && lo >= np / 100;
                                if (!cut) for (size_t q = 0; q < np; q++) rgba[q * 4 + 3] = 255;
                                M->tex[M->ntex].w = w; M->tex[M->ntex].h = h; M->tex[M->ntex].rgba = rgba;
                                mtex = M->ntex++;
                                if (nimg < MAXTEX) { imgoff[nimg] = io; imgtex[nimg] = mtex; nimg++; }
                            }
                        }
                    }
                    if (ntexcache < MAXTEX) { texmats[ntexcache] = (uint32_t)mo; teximg[ntexcache] = mtex; ntexcache++; }
                }
            }
        }
        if (oom) { free(ind0); break; }

        /* every node that places the object this mesh belongs to gets its own copy */
        int first = -1, copies = 0;
        for (int k = 0; k < npl; k++) {
            uint32_t ao = pl[k].ao;
            if (o > ao && (uint64_t)o < (uint64_t)ao + le32(d + ao + 4) + 0x10) { if (first < 0) first = k; copies++; }
        }
        static const float ident[12] = { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0 };
        int done = 0;
        for (int k = first < 0 ? -1 : first; k < npl && done < 64 && M->nmesh < MAXMESH && !oom; k++) {
            const float *W = ident;
            if (k >= 0) {
                uint32_t ao = pl[k].ao;
                if (!(o > ao && (uint64_t)o < (uint64_t)ao + le32(d + ao + 4) + 0x10)) continue;
                W = pl[k].m;
            }
            done++;
            uint16_t *ind = malloc((size_t)ni * 2);
            float *pos = malloc((size_t)nv * 12), *nrm = L.nrm >= 0 ? malloc((size_t)nv * 12) : NULL, *uv = L.uv >= 0 ? malloc((size_t)nv * 8) : NULL;
            if (!ind || !pos || (L.nrm >= 0 && !nrm) || (L.uv >= 0 && !uv)) { free(ind); free(pos); free(nrm); free(uv); oom = 1; break; }
            memcpy(ind, ind0, (size_t)ni * 2);
            /* a mirroring node flips the winding */
            float det = W[0] * (W[5] * W[10] - W[6] * W[9]) - W[1] * (W[4] * W[10] - W[6] * W[8]) + W[2] * (W[4] * W[9] - W[5] * W[8]);
            if (det < 0) for (uint32_t t = 0; t + 2 < ni; t += 3) { uint16_t tmp = ind[t + 1]; ind[t + 1] = ind[t + 2]; ind[t + 2] = tmp; }
            AsfMesh me;
            memset(&me, 0, sizeof me);
            me.mn[0] = me.mn[1] = me.mn[2] = 1e30f; me.mx[0] = me.mx[1] = me.mx[2] = -1e30f;
            for (uint32_t v = 0; v < nv; v++) {
                const uint8_t *p = vd + (size_t)v * stride;
                float q[3];
                for (int c = 0; c < 3; c++) {
                    float f;
                    if (L.pk == 8) f = half2f(le16(p + 2 * c)); else { uint32_t u = le32(p + 4 * c); memcpy(&f, &u, 4); }
                    if (!(f == f) || f > 1e30f || f < -1e30f) f = 0;
                    q[c] = f;
                }
                for (int c = 0; c < 3; c++) {
                    float f = W[c * 4] * q[0] + W[c * 4 + 1] * q[1] + W[c * 4 + 2] * q[2] + W[c * 4 + 3];
                    if (!(f == f) || f > 1e30f || f < -1e30f) f = 0;
                    pos[v * 3 + c] = f;
                    if (f < me.mn[c]) me.mn[c] = f;
                    if (f > me.mx[c]) me.mx[c] = f;
                }
                if (nrm) {
                    float x0 = (int16_t)le16(p + L.nrm) / 32767.f, y0 = (int16_t)le16(p + L.nrm + 2) / 32767.f, z0 = (int16_t)le16(p + L.nrm + 4) / 32767.f;
                    float x = W[0] * x0 + W[1] * y0 + W[2] * z0, y = W[4] * x0 + W[5] * y0 + W[6] * z0, z = W[8] * x0 + W[9] * y0 + W[10] * z0;
                    float l = sqrtf(x * x + y * y + z * z);
                    if (!(l > 1e-6f) || l > 1e30f) { x = 0; y = 1; z = 0; l = 1; }
                    nrm[v * 3] = x / l; nrm[v * 3 + 1] = y / l; nrm[v * 3 + 2] = z / l;
                }
                if (uv) {
                    if (L.uvk == 0xb || L.uvk == 0xd) { uv[v * 2] = (int16_t)le16(p + L.uv) / 32767.f; uv[v * 2 + 1] = (int16_t)le16(p + L.uv + 2) / 32767.f; }
                    else { uint32_t a = le32(p + L.uv), b = le32(p + L.uv + 4); memcpy(&uv[v * 2], &a, 4); memcpy(&uv[v * 2 + 1], &b, 4);
                           if (!(uv[v * 2] == uv[v * 2])) uv[v * 2] = 0; if (!(uv[v * 2 + 1] == uv[v * 2 + 1])) uv[v * 2 + 1] = 0; }
                }
            }
            me.nv = nv; me.ni = ni; me.pos = pos; me.nrm = nrm; me.uv = uv; me.ind = ind; me.tex = mtex;
            if (M->nmesh == capm) {
                int nc = capm ? capm * 2 : 16;
                AsfMesh *t = realloc(M->mesh, sizeof(AsfMesh) * (size_t)nc);
                if (!t) { free(pos); free(nrm); free(uv); free(ind); oom = 1; break; }
                M->mesh = t; capm = nc;
            }
            M->mesh[M->nmesh++] = me;
            for (int c = 0; c < 3; c++) { if (me.mn[c] < M->mn[c]) M->mn[c] = me.mn[c]; if (me.mx[c] > M->mx[c]) M->mx[c] = me.mx[c]; }
            M->st.meshes++; M->st.vertices += nv; M->st.triangles += ni / 3;
            if (k < 0) break;
        }
        (void)copies;
        free(ind0);
    }
    free(pl);
    free(ch); free(ad);
    M->st.textures = (uint32_t)M->ntex;
    if (oom) { asf_free(M); snprintf(err, en, "out of memory"); return NULL; }
    if (!M->nmesh) { asf_free(M); snprintf(err, en, "no usable meshes in this ASF"); return NULL; }
    frame_box(M);
    return M;
}

/* ---------------------------------------------------------------- glTF writer */
int asf_model_to_glb(const AsfModel *M, const char *out_path, AsfStats *st, char *err, size_t en)
{
    Buf js = { 0 }, bin = { 0 };
    Buf acc = { 0 }, views = { 0 }, prims = { 0 }, mats = { 0 }, imgs = { 0 }, texs = { 0 };
    int nacc = 0, nview = 0, nmat = 0, nimg = 0, rc = 0;
    int *img_of_tex = malloc(sizeof(int) * (size_t)(M->ntex + 1));
    if (!img_of_tex) { snprintf(err, en, "out of memory"); return -1; }
    for (int i = 0; i < M->ntex; i++) img_of_tex[i] = -1;
    *st = M->st;
    st->textures = 0;

#define VIEW(ptr, len, target) ( bpad4(&bin), \
    bprintf(&views, "%s{\"buffer\":0,\"byteOffset\":%zu,\"byteLength\":%zu%s}", nview ? "," : "", bin.n, (size_t)(len), (target) ? (target) == 34963 ? ",\"target\":34963" : ",\"target\":34962" : ""), \
    bput(&bin, (ptr), (len)), nview++ )

    for (int mi = 0; mi < M->nmesh && rc == 0; mi++) {
        const AsfMesh *me = &M->mesh[mi];
        int a_pos = nacc, a_nrm = -1, a_uv = -1, a_idx;
        int vw = VIEW(me->pos, (size_t)me->nv * 12, 34962);
        rc |= bprintf(&acc, "%s{\"bufferView\":%d,\"componentType\":5126,\"count\":%u,\"type\":\"VEC3\",\"min\":[%g,%g,%g],\"max\":[%g,%g,%g]}",
                      nacc ? "," : "", vw, me->nv, me->mn[0], me->mn[1], me->mn[2], me->mx[0], me->mx[1], me->mx[2]); nacc++;
        if (me->nrm) { a_nrm = nacc; vw = VIEW(me->nrm, (size_t)me->nv * 12, 34962); rc |= bprintf(&acc, ",{\"bufferView\":%d,\"componentType\":5126,\"count\":%u,\"type\":\"VEC3\"}", vw, me->nv); nacc++; }
        if (me->uv) { a_uv = nacc; vw = VIEW(me->uv, (size_t)me->nv * 8, 34962); rc |= bprintf(&acc, ",{\"bufferView\":%d,\"componentType\":5126,\"count\":%u,\"type\":\"VEC2\"}", vw, me->nv); nacc++; }
        a_idx = nacc; vw = VIEW(me->ind, (size_t)me->ni * 2, 34963);
        rc |= bprintf(&acc, ",{\"bufferView\":%d,\"componentType\":5123,\"count\":%u,\"type\":\"SCALAR\"}", vw, me->ni); nacc++;
        int img = -1;
        if (me->tex >= 0 && me->tex < M->ntex) {
            if (img_of_tex[me->tex] < 0) {
                const AsfTex *t = &M->tex[me->tex];
                Buf png = { 0 };
                if (png_encode(t->rgba, t->w, t->h, &png) == 0) {
                    int pv = VIEW(png.p, png.n, 0);
                    rc |= bprintf(&imgs, "%s{\"bufferView\":%d,\"mimeType\":\"image/png\"}", nimg ? "," : "", pv);
                    rc |= bprintf(&texs, "%s{\"source\":%d,\"sampler\":0}", nimg ? "," : "", nimg);
                    img_of_tex[me->tex] = nimg++;
                    st->textures++;
                }
                free(png.p);
            }
            img = img_of_tex[me->tex];
        }
        if (img >= 0)
            rc |= bprintf(&mats, "%s{\"name\":\"mesh%d\",\"doubleSided\":true,\"alphaMode\":\"MASK\",\"pbrMetallicRoughness\":{\"baseColorTexture\":{\"index\":%d},\"metallicFactor\":0,\"roughnessFactor\":0.9}}", nmat ? "," : "", mi, img);
        else
            rc |= bprintf(&mats, "%s{\"name\":\"mesh%d\",\"doubleSided\":true,\"pbrMetallicRoughness\":{\"baseColorFactor\":[0.8,0.8,0.8,1],\"metallicFactor\":0,\"roughnessFactor\":0.9}}", nmat ? "," : "", mi);
        rc |= bprintf(&prims, "%s{\"attributes\":{\"POSITION\":%d", mi ? "," : "", a_pos);
        if (a_nrm >= 0) rc |= bprintf(&prims, ",\"NORMAL\":%d", a_nrm);
        if (a_uv >= 0) rc |= bprintf(&prims, ",\"TEXCOORD_0\":%d", a_uv);
        rc |= bprintf(&prims, "},\"indices\":%d,\"material\":%d}", a_idx, nmat);
        nmat++;
    }
    free(img_of_tex);
    if (rc == 0) {
        bpad4(&bin);
        rc |= bprintf(&js, "{\"asset\":{\"version\":\"2.0\",\"generator\":\"Star Ocean Utility Tool\"},\"scene\":0,\"scenes\":[{\"nodes\":[0]}],\"nodes\":[{\"mesh\":0,\"name\":\"ASF\"}],\"meshes\":[{\"primitives\":[");
        rc |= bput(&js, prims.p, prims.n);
        rc |= bprintf(&js, "]}],\"materials\":[");
        rc |= bput(&js, mats.p, mats.n);
        rc |= bprintf(&js, "],\"accessors\":[");
        rc |= bput(&js, acc.p, acc.n);
        rc |= bprintf(&js, "],\"bufferViews\":[");
        rc |= bput(&js, views.p, views.n);
        rc |= bprintf(&js, "],\"buffers\":[{\"byteLength\":%zu}]", bin.n);
        if (nimg) {
            rc |= bprintf(&js, ",\"images\":[");
            rc |= bput(&js, imgs.p, imgs.n);
            rc |= bprintf(&js, "],\"textures\":[");
            rc |= bput(&js, texs.p, texs.n);
            rc |= bprintf(&js, "],\"samplers\":[{\"magFilter\":9729,\"minFilter\":9987,\"wrapS\":10497,\"wrapT\":10497}]");
        }
        rc |= bprintf(&js, "}");
        while (rc == 0 && js.n % 4) rc |= bput(&js, " ", 1);
        if (rc) snprintf(err, en, "out of memory");
    }
    if (rc == 0) {
        char part[2100];
        snprintf(part, sizeof part, "%s.part", out_path);
        FILE *f = fopen(part, "wb");
        if (!f) { snprintf(err, en, "cannot write %s", out_path); rc = -1; }
        else {
            uint32_t total = (uint32_t)(12 + 8 + js.n + 8 + bin.n);
            uint8_t hd[12] = { 'g', 'l', 'T', 'F', 2, 0, 0, 0, (uint8_t)total, (uint8_t)(total >> 8), (uint8_t)(total >> 16), (uint8_t)(total >> 24) };
            uint8_t ch1[8] = { (uint8_t)js.n, (uint8_t)(js.n >> 8), (uint8_t)(js.n >> 16), (uint8_t)(js.n >> 24), 'J', 'S', 'O', 'N' };
            uint8_t ch2[8] = { (uint8_t)bin.n, (uint8_t)(bin.n >> 8), (uint8_t)(bin.n >> 16), (uint8_t)(bin.n >> 24), 'B', 'I', 'N', 0 };
            int bad = fwrite(hd, 1, 12, f) != 12 || fwrite(ch1, 1, 8, f) != 8 || fwrite(js.p, 1, js.n, f) != js.n ||
                      fwrite(ch2, 1, 8, f) != 8 || fwrite(bin.p, 1, bin.n, f) != bin.n;
            bad |= fclose(f) != 0;
            if (bad || rename(part, out_path) != 0) { unlink(part); snprintf(err, en, "write failed: %s", out_path); rc = -1; }
            else st->bytes = total;
        }
    }
    free(js.p); free(bin.p); free(acc.p); free(views.p); free(prims.p); free(mats.p); free(imgs.p); free(texs.p);
    return rc;
}

int asf_to_glb(const uint8_t *d, size_t n, const char *out_path, AsfStats *st, char *err, size_t en)
{
    memset(st, 0, sizeof *st);
    AsfModel *M = asf_load(d, n, 1, err, en);
    if (!M) return -1;
    int rc = asf_model_to_glb(M, out_path, st, err, en);
    asf_free(M);
    return rc;
}
