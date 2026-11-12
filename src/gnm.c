/* gnm.c - branching GNM GPU probe (v1.40)
 *
 * One run tries every route, keeps going past failures, and ends with a summary table and a
 * "what this means" section. Every line is written to gnm_probe.txt and flushed to disk BEFORE
 * the step it names runs, so if the console freezes the last line names the step.
 *
 *  Tier A  set-up       memory for command buffers (ONION and GARLIC), a label page, VideoOut
 *  Tier B  execution    does the GPU actually RUN our packets? Each variant ends with a packet
 *                       that makes the GPU write a known value into our label memory; we read
 *                       it back. (v1.38/1.39 only checked that the driver ACCEPTED the submit.)
 *             B1 default state + write-data label     B2 no default state (isolates it)
 *             B3 default state + end-of-pipe label    B4 command buffer in GARLIC memory
 *  Tier C  flip         how can we put a buffer on screen? Each variant paints the off-screen
 *                       buffer a different colour first; a flip only counts if the flip
 *                       counter moves AND our own flip argument comes back.
 *             C1 GNM submit+flip, prepareFlip          (GREEN)
 *             C2 GNM submit+flip, prepareFlip + label  (CYAN)
 *             C3 GNM submit, then VideoOut flip        (BLUE)  - only if C1 and C2 both fail
 *  Tier D  GPU pixels   the GPU itself writes the picture (no shaders, no render target yet)
 *             D1 GPU DMA-fills the whole screen        (YELLOW, on black)
 *             D2 GPU write-data stripe, top 16 rows    (RED stripe, on black) - only if D1 fails
 *
 * Packet layouts are taken from the shadPS4 emulator's PM4 definitions (pm4_cmds.h) and its
 * GNM driver (prepareFlip patching), so they match what the real driver expects.
 */
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdarg.h>
#include <stdio.h>
#include "gnm.h"
#include "gfx.h"

#ifndef GPU_HOST
#include <unistd.h>
#include <fcntl.h>
#include <orbis/libkernel.h>
#include <orbis/GnmDriver.h>
#include <orbis/VideoOut.h>
#endif

static FILE *g_f;
static void (*g_out)(const char *);
static int g_gnm_used;   /* set once this process has submitted GPU work */

static void gp(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void gp(const char *fmt, ...)
{
    char b[400];
    va_list ap; va_start(ap, fmt);
    vsnprintf(b, sizeof b, fmt, ap);
    va_end(ap);
    if (g_f) { fprintf(g_f, "%s\n", b); fflush(g_f); fsync(fileno(g_f)); }
    if (g_out) g_out(b);
}

/* ---------------------------------------------------------------- results table */
enum { R_NOTRUN = 0, R_PASS, R_FAIL, R_SKIP };
typedef struct { const char *id; const char *what; int st; char note[120]; } Res;
#define MAXRES 16
static Res g_res[MAXRES];
static int g_nres;
static Res *res_add(const char *id, const char *what)
{
    if (g_nres >= MAXRES) return &g_res[MAXRES - 1];
    Res *r = &g_res[g_nres++];
    r->id = id; r->what = what; r->st = R_NOTRUN; r->note[0] = 0;
    return r;
}
static void res_set(Res *r, int st, const char *fmt, ...) __attribute__((format(printf, 3, 4)));
static void res_set(Res *r, int st, const char *fmt, ...)
{
    r->st = st;
    va_list ap; va_start(ap, fmt);
    vsnprintf(r->note, sizeof r->note, fmt, ap);
    va_end(ap);
    gp("RESULT %s: %s - %s", r->id, st == R_PASS ? "PASS" : st == R_FAIL ? "FAIL" : st == R_SKIP ? "SKIPPED" : "not run", r->note);
}

#ifndef GPU_HOST
/* ---------------------------------------------------------------- memory */
static void *gpu_alloc(size_t size, int mtype, const char *name)
{
    size_t aligned = (size + 0xFFFF) & ~(size_t)0xFFFF;
    off_t phys = 0;
    gp("-> allocate %s: %zu KB, memory type %d", name, aligned >> 10, mtype);
    int ar = sceKernelAllocateDirectMemory(0, sceKernelGetDirectMemorySize(), aligned, 0x10000, mtype, &phys);
    if (ar != 0) { gp("<- allocate failed 0x%08x", (unsigned)ar); return NULL; }
    void *p = NULL;
    int mr = sceKernelMapDirectMemory(&p, aligned, 0x33 /* CPU rw + GPU rw */, 0, phys, 0x10000);
    if (mr != 0) { gp("<- map failed 0x%08x", (unsigned)mr); return NULL; }
    gp("<- ok: phys 0x%lx, address %p", (long)phys, p);
    memset(p, 0, aligned);
    return p;
}

/* ---------------------------------------------------------------- PM4 packets
 * type-3 header: [31:30]=3, [29:16]=body dwords-1, [15:8]=opcode */
#define PM4_T3(op, body) (0xC0000000u | (((uint32_t)(body) - 1u) << 16) | ((uint32_t)(op) << 8))
#define OP_NOP        0x10
#define OP_WRITE_DATA 0x37
#define OP_EOP        0x47
#define OP_DMA_DATA   0x50

static uint32_t *pk_nop(uint32_t *c)
{
    c[0] = PM4_T3(OP_NOP, 1); c[1] = 0;
    return c + 2;
}
/* GPU writes `n` dwords from `vals` to `addr` (dst_sel 5 = memory, as the real driver's flip patch) */
static uint32_t *pk_write_data_n(uint32_t *c, volatile void *addr, const uint32_t *vals, uint32_t n, uint32_t fill)
{
    uint64_t a = (uint64_t)(uintptr_t)addr;
    c[0] = PM4_T3(OP_WRITE_DATA, 3 + n);
    c[1] = 0x500u;
    c[2] = (uint32_t)a & ~3u;
    c[3] = (uint32_t)(a >> 32);
    for (uint32_t i = 0; i < n; i++) c[4 + i] = vals ? vals[i] : fill;
    return c + 4 + n;
}
static uint32_t *pk_write_data(uint32_t *c, volatile uint32_t *addr, uint32_t v)
{
    return pk_write_data_n(c, addr, NULL, 1, v);
}
/* end-of-pipe: after all earlier work drains, flush caches and write v to addr (how games fence) */
static uint32_t *pk_eop(uint32_t *c, volatile uint32_t *addr, uint32_t v)
{
    uint64_t a = (uint64_t)(uintptr_t)addr;
    c[0] = PM4_T3(OP_EOP, 5);
    c[1] = 20u /* CACHE_FLUSH_AND_INV_TS_EVENT */ | (5u << 8) /* event index */;
    c[2] = (uint32_t)a & ~3u;
    c[3] = ((uint32_t)(a >> 32) & 0xFFFFu) | (1u << 29) /* data_sel: 32-bit low */;
    c[4] = v;
    c[5] = 0;
    return c + 6;
}
/* CP DMA fill: write `value` over `bytes` at `dst` (src_sel = DATA, dst_sel = memory, cp_sync) */
static uint32_t *pk_dma_fill(uint32_t *c, void *dst, uint32_t bytes, uint32_t value)
{
    uint64_t a = (uint64_t)(uintptr_t)dst;
    c[0] = PM4_T3(OP_DMA_DATA, 6);
    c[1] = (2u << 29) /* src_sel DATA */ | (1u << 31) /* cp_sync */;
    c[2] = value;
    c[3] = 0;
    c[4] = (uint32_t)a;
    c[5] = (uint32_t)(a >> 32);
    c[6] = bytes & 0x1FFFFFu;
    return c + 7;
}
/* prepareFlip: must be the LAST 64 dwords of the command buffer; the driver rewrites it */
#define RG(base, k) ((base) + (k) * 0x400)   /* 4 KB slice per variant */
#define PF_PLAIN 0x68750777u
#define PF_LABEL 0x68750778u
static uint32_t *pk_prepare_flip(uint32_t *c, uint32_t marker, volatile uint32_t *label, uint32_t v)
{
    memset(c, 0, 64 * 4);
    c[0] = PM4_T3(OP_NOP, 63);   /* = 0xC03E1000 */
    c[1] = marker;
    if (marker == PF_LABEL && label) {
        uint64_t a = (uint64_t)(uintptr_t)label;
        c[2] = (uint32_t)a & ~3u;
        c[3] = (uint32_t)(a >> 32);
        c[4] = v;
    }
    return c + 64;
}

/* ---------------------------------------------------------------- helpers */
static int g_use_init = 1;
static uint32_t *put_init(uint32_t *c)
{
    if (!g_use_init) return c;
    int n = sceGnmDrawInitDefaultHardwareState350(c, 256);
    return n > 0 ? c + n : c;
}

static int wait_label(volatile uint32_t *l, uint32_t v, int ms)
{
    for (int t = 0; t < ms; t += 5) {
        if (*l == v) return 1;
        sceKernelUsleep(5000);
    }
    return *l == v;
}

static int submit_plain(uint32_t *dcb, uint32_t *end)
{
    void *a[1] = { dcb };
    uint32_t sz[1] = { (uint32_t)((end - dcb) * 4) };
    gp("-> sceGnmSubmitCommandBuffers (%u bytes)", sz[0]);
    int r = sceGnmSubmitCommandBuffers(1, a, sz, NULL, NULL);
    g_gnm_used = 1;
    int d = sceGnmSubmitDone();
    gp("<- submit 0x%08x, submitDone 0x%08x", (unsigned)r, (unsigned)d);
    return r;
}

static int submit_flip(uint32_t *dcb, uint32_t *end, int vh, int buf, int64_t arg)
{
    void *a[1] = { dcb };
    uint32_t sz[1] = { (uint32_t)((end - dcb) * 4) };
    gp("-> sceGnmSubmitAndFlipCommandBuffers (%u bytes, buffer %d, arg 0x%llx)", sz[0], buf, (unsigned long long)arg);
    int r = sceGnmSubmitAndFlipCommandBuffers(1, a, sz, NULL, NULL, (uint32_t)vh, (uint32_t)buf,
                                              ORBIS_VIDEO_OUT_FLIP_VSYNC, arg);
    g_gnm_used = 1;
    int d = sceGnmSubmitDone();
    gp("<- submit+flip 0x%08x, submitDone 0x%08x", (unsigned)r, (unsigned)d);
    return r;
}

/* Waits until buffer `buf` is on screen with our flip argument. */
static int wait_flip(int vh, int buf, int64_t arg, uint64_t num_before, int ms)
{
    OrbisVideoOutFlipStatus st;
    for (int t = 0; t < ms; t += 16) {
        memset(&st, 0, sizeof st);
        if (sceVideoOutGetFlipStatus(vh, &st) == 0 && st.num > num_before && st.flipArg == arg && st.currentBuffer == buf)
            return 1;
        sceKernelUsleep(16000);
    }
    memset(&st, 0, sizeof st);
    sceVideoOutGetFlipStatus(vh, &st);
    gp("   flip status now: flips %llu, on screen %d, last arg 0x%llx, pending gpu %d / total %d",
       (unsigned long long)st.num, st.currentBuffer, (unsigned long long)st.flipArg,
       st.numGpuFlipPending, st.numFlipPending);
    return 0;
}

static int off_screen(int vh, int nbuf, uint64_t *num)
{
    OrbisVideoOutFlipStatus st; memset(&st, 0, sizeof st);
    sceVideoOutGetFlipStatus(vh, &st);
    if (num) *num = st.num;
    return (st.currentBuffer == 0 && nbuf > 1) ? 1 : 0;
}

static void paint(int buf, uint32_t argb)
{
    uint32_t *p = (uint32_t *)gfx_fb(buf);
    unsigned n = gfx_fb_bytes() / 4;
    if (p) for (unsigned i = 0; i < n; i++) p[i] = argb;
}
#endif /* !GPU_HOST */

void gnm_frame_tick(void)
{
#ifndef GPU_HOST
    /* Once a process has used GNM, games call sceGnmSubmitDone every frame. Do the same. */
    if (g_gnm_used) sceGnmSubmitDone();
#endif
}

/* ================================================================ the probe */
int gnm_probe(const char *file, void (*out)(const char *), char *verdict, size_t vn)
{
    g_out = out;
    g_f = file ? fopen(file, "w") : NULL;
    g_nres = 0;
    g_use_init = 1;
    snprintf(verdict, vn, "did not start");
    gp("Star Ocean Utility Tool - GNM GPU probe (v%s)", GNM_PROBE_VER);
    gp("One run tries every route and keeps going past failures. Every line is saved before");
    gp("the step it names runs. Colours you may see, in order:");
    gp("  GREEN = C1 works   CYAN = C2 works   BLUE = C3 works   YELLOW = D1 (GPU drew the screen)");
    gp("  RED stripe at top = D2 (GPU drew a stripe). Black during D = the GPU drew nothing.");

#ifdef GPU_HOST
    gp("host build: GNM not available");
    snprintf(verdict, vn, "host build");
    if (g_f) { fclose(g_f); g_f = NULL; }
    return -1;
#else
    int gpu_exec = 0, flip_way = 0, gpu_pixels = 0;   /* 1 = C1, 2 = C2, 3 = C3 */
    int b_rejected = 0;                               /* any Tier B submit refused by the driver */
    uint32_t *dcb = NULL;
    /* ======================= Tier A: set-up ======================= */
    gp("");
    gp("==== Tier A: set-up ====");
    Res *ra = res_add("A", "GPU memory + VideoOut chain");
    gp("-> sceGnmAreSubmitsAllowed (driver accepts submits now; NOT a GPU-idle signal)");
    int allowed = sceGnmAreSubmitsAllowed();
    gp("<- %d", allowed);
    uint32_t *dcbO = (uint32_t *)gpu_alloc(1 << 20, 0 /* WB_ONION */, "command buffer (ONION)");
    uint32_t *dcbG = (uint32_t *)gpu_alloc(256 << 10, 3 /* WC_GARLIC */, "command buffer (GARLIC)");
    volatile uint32_t *lab = (volatile uint32_t *)gpu_alloc(64 << 10, 0, "label page (ONION)");
    int vh = gfx_video_handle(), nbuf = gfx_fb_count();
    unsigned fbb = gfx_fb_bytes();
    gp("VideoOut handle %d, %d display buffers of %u bytes (1920x1080, 32-bit ARGB, linear)", vh, nbuf, fbb);
    for (int i = 0; i < nbuf; i++) gp("  display buffer %d at %p", i, gfx_fb(i));
    if ((!dcbO && !dcbG) || !lab || vh < 0 || nbuf < 1) {
        res_set(ra, R_FAIL, "missing: %s%s%s", (!dcbO && !dcbG) ? "command buffer memory " : "",
                !lab ? "label memory " : "", (vh < 0 || nbuf < 1) ? "VideoOut chain" : "");
        snprintf(verdict, vn, "Tier A failed: %s", ra->note);
        goto summary;
    }
    res_set(ra, R_PASS, "submits allowed %d, ONION %s, GARLIC %s, labels ok, VideoOut ok",
            allowed, dcbO ? "ok" : "FAILED", dcbG ? "ok" : "FAILED");
    dcb = dcbO ? dcbO : dcbG;

    /* ======================= Tier B: does the GPU execute? ======================= */
    gp("");
    gp("==== Tier B: does the GPU actually run our packets? ====");
    int b1 = 0, b2 = 0;
    {
        Res *r = res_add("B1", "default state + write-data label");
        if (!dcbO) res_set(r, R_SKIP, "no ONION command buffer");
        else {
            lab[0] = 0;
            uint32_t *d = RG(dcbO, 0), *c = put_init(d);
            c = pk_write_data(c, &lab[0], 0xB1B1B1B1u);
            int rc = submit_plain(d, c);
            b1 = rc == 0 && wait_label(&lab[0], 0xB1B1B1B1u, 2000);
            if (rc) b_rejected = 1;
            if (b1) res_set(r, R_PASS, "GPU wrote the label (executed)");
            else res_set(r, R_FAIL, rc ? "submit rejected 0x%08x" : "accepted, but GPU never wrote the label (label 0x%08x)", rc ? (unsigned)rc : lab[0]);
        }
    }
    {
        Res *r = res_add("B2", "NO default state + write-data label");
        if (!dcbO) res_set(r, R_SKIP, "no ONION command buffer");
        else {
            lab[1] = 0;
            uint32_t *d = RG(dcbO, 1), *c = pk_nop(d);
            c = pk_write_data(c, &lab[1], 0xB2B2B2B2u);
            int rc = submit_plain(d, c);
            b2 = rc == 0 && wait_label(&lab[1], 0xB2B2B2B2u, 2000);
            if (rc) b_rejected = 1;
            if (b2) res_set(r, R_PASS, "GPU wrote the label");
            else res_set(r, R_FAIL, rc ? "submit rejected 0x%08x" : "accepted, label never written (0x%08x)", rc ? (unsigned)rc : lab[1]);
        }
    }
    if (!b1 && b2) { g_use_init = 0; gp("NOTE: works only WITHOUT the default state - later tiers leave it out."); }
    {
        Res *r = res_add("B3", "end-of-pipe label (how games fence)");
        if (!dcbO) res_set(r, R_SKIP, "no ONION command buffer");
        else {
            lab[2] = 0;
            uint32_t *d = RG(dcbO, 2), *c = put_init(d);
            c = pk_eop(c, &lab[2], 0xB3B3B3B3u);
            int rc = submit_plain(d, c);
            int ok = rc == 0 && wait_label(&lab[2], 0xB3B3B3B3u, 2000);
            if (rc) b_rejected = 1;
            if (ok) res_set(r, R_PASS, "end-of-pipe label written");
            else res_set(r, R_FAIL, rc ? "submit rejected 0x%08x" : "label never written (0x%08x)", rc ? (unsigned)rc : lab[2]);
            if (ok) gpu_exec = 1;
        }
    }
    {
        Res *r = res_add("B4", "command buffer in GARLIC memory");
        if (!dcbG) res_set(r, R_SKIP, "GARLIC allocation failed");
        else {
            lab[3] = 0;
            uint32_t *d = RG(dcbG, 3), *c = put_init(d);
            c = pk_write_data(c, &lab[3], 0xB4B4B4B4u);
            int rc = submit_plain(d, c);
            int ok = rc == 0 && wait_label(&lab[3], 0xB4B4B4B4u, 2000);
            if (rc) b_rejected = 1;
            if (ok) res_set(r, R_PASS, "GPU ran a GARLIC command buffer");
            else res_set(r, R_FAIL, rc ? "submit rejected 0x%08x" : "label never written (0x%08x)", rc ? (unsigned)rc : lab[3]);
            if (ok && !b1 && !b2) { dcb = dcbG; gp("NOTE: only GARLIC works - later tiers use it."); }
            if (ok) gpu_exec = 1;
        }
    }
    if (b1 || b2) gpu_exec = 1;
    gp("Tier B: the GPU %s our packets.", gpu_exec ? "EXECUTES" : "did NOT execute");

    /* ======================= Tier C: flip ======================= */
    gp("");
    gp("==== Tier C: flipping a buffer to the screen ====");
    {
        Res *r = res_add("C1", "GNM submit+flip, prepareFlip (GREEN)");
        uint64_t n0; int bk = off_screen(vh, nbuf, &n0);
        paint(bk, 0xFF00FF00u);
        gp("painted off-screen buffer %d GREEN (flips so far %llu)", bk, (unsigned long long)n0);
        lab[4] = 0;
        uint32_t *d = RG(dcb, 4), *c = put_init(d);
        c = pk_write_data(c, &lab[4], 0xC1C1C1C1u);
        c = pk_prepare_flip(c, PF_PLAIN, NULL, 0);
        const int64_t arg = 0x5A5A00C1;
        int rc = submit_flip(d, c, vh, bk, arg);
        int ok = rc == 0 && wait_flip(vh, bk, arg, n0, 3000);
        int ran = wait_label(&lab[4], 0xC1C1C1C1u, 200);
        if (ok) { res_set(r, R_PASS, "flip confirmed (packets ran: %s) - screen GREEN", ran ? "yes" : "no"); flip_way = 1; sceKernelUsleep(1500000); }
        else if (rc) res_set(r, R_FAIL, "rejected 0x%08x", (unsigned)rc);
        else res_set(r, R_FAIL, "accepted, flip not seen (packets ran: %s)", ran ? "yes" : "no");
    }
    {
        Res *r = res_add("C2", "GNM submit+flip, prepareFlip + label (CYAN)");
        uint64_t n0; int bk = off_screen(vh, nbuf, &n0);
        paint(bk, 0xFF00FFFFu);
        gp("painted off-screen buffer %d CYAN", bk);
        lab[5] = 0;
        uint32_t *d = RG(dcb, 5), *c = put_init(d);
        c = pk_prepare_flip(c, PF_LABEL, &lab[5], 0xC2C2C2C2u);
        const int64_t arg = 0x5A5A00C2;
        int rc = submit_flip(d, c, vh, bk, arg);
        int ok = rc == 0 && wait_flip(vh, bk, arg, n0, 3000);
        int lbl = wait_label(&lab[5], 0xC2C2C2C2u, 500);
        if (ok) { res_set(r, R_PASS, "flip confirmed, completion label %s - screen CYAN", lbl ? "written" : "NOT written"); if (!flip_way) flip_way = 2; sceKernelUsleep(1500000); }
        else if (rc) res_set(r, R_FAIL, "rejected 0x%08x", (unsigned)rc);
        else res_set(r, R_FAIL, "accepted, flip not seen (label %s)", lbl ? "written" : "not written");
    }
    {
        Res *r = res_add("C3", "GNM submit, then VideoOut flip (BLUE)");
        if (flip_way) res_set(r, R_SKIP, "not needed: C%d already flips through GNM", flip_way);
        else {
            uint64_t n0; int bk = off_screen(vh, nbuf, &n0);
            paint(bk, 0xFF0000FFu);
            gp("painted off-screen buffer %d BLUE", bk);
            lab[6] = 0;
            uint32_t *d = RG(dcb, 6), *c = put_init(d);
            c = pk_write_data(c, &lab[6], 0xC3C3C3C3u);
            int rc = submit_plain(d, c);
            int ran = rc == 0 && wait_label(&lab[6], 0xC3C3C3C3u, 2000);
            const int64_t arg = 0x5A5A00C3;
            gp("-> sceVideoOutSubmitFlip(buffer %d)", bk);
            int fr = sceVideoOutSubmitFlip(vh, bk, ORBIS_VIDEO_OUT_FLIP_VSYNC, arg);
            gp("<- 0x%08x", (unsigned)fr);
            int ok = fr == 0 && wait_flip(vh, bk, arg, n0, 3000);
            if (ok) { res_set(r, R_PASS, "VideoOut flip after GNM submit works (packets ran: %s) - screen BLUE", ran ? "yes" : "no"); flip_way = 3; sceKernelUsleep(1500000); }
            else res_set(r, R_FAIL, "submit 0x%08x, packets ran %s, VideoOut flip 0x%08x", (unsigned)rc, ran ? "yes" : "no", (unsigned)fr);
        }
    }

    /* ======================= Tier D: GPU-made pixels ======================= */
    gp("");
    gp("==== Tier D: the GPU writes the picture itself ====");
    for (int variant = 1; variant <= 2; variant++) {
        Res *r = res_add(variant == 1 ? "D1" : "D2", variant == 1 ? "GPU DMA-fills whole screen (YELLOW)" : "GPU write-data stripe, top 16 rows (RED)");
        if (!gpu_exec) { res_set(r, R_SKIP, "Tier B: the GPU does not execute our packets"); continue; }
        if (variant == 2 && gpu_pixels) { res_set(r, R_SKIP, "not needed: D1 worked"); continue; }
        uint64_t n0; int bk = off_screen(vh, nbuf, &n0);
        paint(bk, 0xFF000000u);
        uint32_t *fb = (uint32_t *)gfx_fb(bk);
        gp("painted off-screen buffer %d BLACK on the CPU; now the GPU paints it", bk);
        lab[7 + variant] = 0;
        uint32_t want = variant == 1 ? 0xFFFFFF00u : 0xFFFF0000u;
        uint32_t *d = dcb + 0x4000, *c = put_init(d);
        if (variant == 1) {
            const uint32_t chunk = 0x100000;   /* 1 MB per DMA packet */
            for (uint32_t off = 0; off < fbb; off += chunk) {
                uint32_t n = fbb - off < chunk ? fbb - off : chunk;
                c = pk_dma_fill(c, (char *)fb + off, n, want);
            }
        } else {
            const uint32_t per = 1920 * 8;      /* 8 rows per packet, two packets */
            c = pk_write_data_n(c, fb, NULL, per, want);
            c = pk_write_data_n(c, fb + per, NULL, per, want);
        }
        c = pk_eop(c, &lab[7 + variant], 0xD0D0D000u + (uint32_t)variant);
        int rc = submit_plain(d, c);
        int done = rc == 0 && wait_label(&lab[7 + variant], 0xD0D0D000u + (uint32_t)variant, 3000);
        uint32_t s0 = fb[0], s1 = fb[1920 * 4 + 960], s2 = fb[(fbb / 4) - 1];
        gp("GPU finished: %s. Pixels read back: top-left 0x%08x, row 4 middle 0x%08x, bottom-right 0x%08x",
           done ? "yes" : "NO", s0, s1, s2);
        int drew = (s0 == want) && (variant == 2 || s2 == want);
        /* show it with whichever flip works (plain VideoOut flip if none of the GNM ways did) */
        const int64_t arg = 0x5A5A00D0 + variant;
        int fr;
        if ((flip_way == 1 || flip_way == 2) && (done || rc)) {
            uint32_t *fd = dcb + 0xC000 + (variant - 1) * 0x400, *f = put_init(fd);
            f = pk_prepare_flip(f, PF_PLAIN, NULL, 0);
            fr = submit_flip(fd, f, vh, bk, arg);
        } else {
            gp("-> sceVideoOutSubmitFlip(buffer %d)", bk);
            fr = sceVideoOutSubmitFlip(vh, bk, ORBIS_VIDEO_OUT_FLIP_VSYNC, arg);
            gp("<- 0x%08x", (unsigned)fr);
        }
        int shown = fr == 0 && wait_flip(vh, bk, arg, n0, 3000);
        if (shown) sceKernelUsleep(3000000);
        if (drew) { gpu_pixels = variant; res_set(r, R_PASS, "the GPU wrote the pixels (shown on screen: %s)", shown ? "yes" : "no"); }
        else res_set(r, R_FAIL, "%s; pixels 0x%08x (wanted 0x%08x), shown %s",
                     rc ? "submit rejected" : done ? "GPU finished but pixels unchanged" : "GPU never finished", s0, want, shown ? "yes" : "no");
    }

summary:
    gp("");
    gp("==================== SUMMARY ====================");
    for (int i = 0; i < g_nres; i++) {
        Res *r = &g_res[i];
        gp("%-3s %-8s %-44s %s", r->id, r->st == R_PASS ? "PASS" : r->st == R_FAIL ? "FAIL" : r->st == R_SKIP ? "SKIPPED" : "-", r->what, r->note);
    }
    gp("");
    gp("==================== WHAT THIS MEANS ====================");
    {
        int A = g_nres > 0 && g_res[0].st == R_PASS;
        if (!A) {
            gp("Set-up failed before the GPU was touched. Send this file.");
        } else if (!gpu_exec && b_rejected) {
            gp("The driver REFUSES our command buffers (see the codes in Tier B). This process is not");
            gp("allowed to submit, or the buffers are malformed. Send this file.");
            snprintf(verdict, vn, "GPU submits rejected by the driver");
        } else if (!gpu_exec) {
            gp("The driver takes our command buffers but the GPU never runs them. GNM is reachable");
            gp("but something (memory permissions or the queue) blocks execution. Send this file.");
            snprintf(verdict, vn, "GPU accepts but does not execute");
        } else if (gpu_pixels && flip_way) {
            gp("CRACKED: the GPU runs our packets, writes our pixels, and we can flip them to the");
            gp("screen (way C%d: %s). Next build: shaders + a render target, i.e. real drawing.", flip_way,
               flip_way == 3 ? "VideoOut flip after a GNM submit" : "GNM submit-and-flip, like games");
            snprintf(verdict, vn, "GPU CRACKED: executes, draws (D%d), flips (C%d%s)", gpu_pixels, flip_way, flip_way == 3 ? " VideoOut" : "");
        } else if (gpu_pixels) {
            gp("The GPU runs our packets and writes pixels; flipping through GNM did not work, but the");
            gp("normal VideoOut flip shows GPU-made frames, which is enough to build on.");
            snprintf(verdict, vn, "GPU executes + draws (D%d); flip via VideoOut", gpu_pixels);
        } else {
            gp("The GPU runs our packets but did not write to the screen buffers. Next: check");
            gp("memory permissions of the display buffers. Send this file.");
            snprintf(verdict, vn, "GPU executes, no pixels; flip way %d", flip_way);
        }
        if (A && gpu_exec && !g_use_init)
            gp("NOTE: the GPU only ran our packets WITHOUT the SDK default-state block (B1 failed, B2 passed).");
        if (!verdict[0] || !strcmp(verdict, "did not start")) snprintf(verdict, vn, "see gnm_probe.txt");
    }
    gp("End of GNM probe. Send this whole file.");
    if (g_f) { fclose(g_f); g_f = NULL; }
    return 0;
#endif
}
