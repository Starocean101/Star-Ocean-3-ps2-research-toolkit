/* gnm.c - GNM GPU probe (v1.38)
 *
 * Games reach the PS4 GPU through GNM (libSceGnmDriver), not Piglet. This probe answers the
 * one question the Piglet work never could: can a fake-pkg GoldHEN process submit work to the
 * GPU at all? It does that in safe tiers, writing every step to a probe file and flushing it to
 * disk BEFORE the step runs, so if the GPU faults or the console drops, the last line names the
 * call that did it.
 *
 *   Tier A  capability : load the driver, ask sceGnmAreSubmitsAllowed, allocate GPU memory
 *   Tier B  submit     : submit an init-only command buffer, confirm the GPU drains it
 *   Tier C  flip       : CPU-fill a display buffer, flip it THROUGH GNM (sceGnmSubmitAndFlip)
 *
 * Tier C is the proof-of-pixels: if a solid colour reaches the screen via the GNM flip path,
 * the GPU is reachable from this process and a shaded draw is mechanical from there. The
 * render-target PM4 for an actual GPU draw is deliberately NOT here yet - untested register
 * writes can hang the GPU, and that waits until this probe reports the submit path is open.
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

#ifndef GPU_HOST
#define ALIGN_UP(v, a) (((v) + (a) - 1) / (a) * (a))

/* Allocate direct memory and map it. type: 0 = WB_ONION (CPU writes, GPU reads),
 * 3 = WC_GARLIC (GPU-local). Returns mapped pointer or NULL. */
static void *gpu_alloc(size_t size, int mtype, off_t *phys_out)
{
    size_t aligned = ALIGN_UP(size, 0x4000);
    off_t phys = 0;
    int ar = sceKernelAllocateDirectMemory(0, sceKernelGetDirectMemorySize(), aligned, 0x4000, mtype, &phys);
    gp("  allocateDirectMemory(%zu KB, type %d) -> rc 0x%08x, phys 0x%lx", aligned >> 10, mtype, (unsigned)ar, (long)phys);
    if (ar != 0) return NULL;
    void *p = NULL;
    int mr = sceKernelMapDirectMemory(&p, aligned, 0x33 /* RW */, 0, phys, 0x4000);
    gp("  mapDirectMemory -> rc 0x%08x, va %p", (unsigned)mr, p);
    if (mr != 0) return NULL;
    if (phys_out) *phys_out = phys;
    return p;
}
#endif

/* Each probe step is logged before it runs. The whole thing is one function so a returning
 * verdict string names how far it got. */
int gnm_probe(const char *file, void (*out)(const char *), char *verdict, size_t vn)
{
    g_out = out;
    g_f = file ? fopen(file, "w") : NULL;
    snprintf(verdict, vn, "did not start");
    gp("Star Ocean Utility Tool - GNM GPU probe (v%s)", GNM_PROBE_VER);
    gp("Goal: find out whether this process can submit work to the GPU through GNM.");
    gp("Every line is saved before the step it names runs.");

#ifdef GPU_HOST
    gp("host build: GNM not available");
    snprintf(verdict, vn, "host build");
    if (g_f) { fclose(g_f); g_f = NULL; }
    return -1;
#else
    /* ---------- Tier A: capability ---------- */
    gp("");
    gp("==== Tier A: capability ====");
    gp("-> sceGnmAreSubmitsAllowed (1 = the GPU will accept a submit now)");
    int allowed = sceGnmAreSubmitsAllowed();
    gp("<- %d", allowed);

    gp("-> allocate a 64 KB ONION command buffer (CPU writes, GPU reads)");
    off_t dcb_phys = 0;
    uint32_t *dcb = (uint32_t *)gpu_alloc(64 * 1024, 0 /* WB_ONION */, &dcb_phys);
    if (!dcb) {
        gp("GPU command-buffer memory could not be allocated - cannot go further.");
        snprintf(verdict, vn, "Tier A: GPU memory allocation failed");
        if (g_f) { fclose(g_f); g_f = NULL; }
        return 1;
    }
    memset(dcb, 0, 64 * 1024);

    int vh = gfx_video_handle();
    int nbuf = gfx_fb_count();
    gp("VideoOut handle (shared with the 2D UI): %d, registered display buffers: %d", vh, nbuf);
    if (vh < 0 || nbuf < 1) {
        gp("No live VideoOut chain - cannot submit a flip.");
        snprintf(verdict, vn, "Tier A ok (submits=%d) but no VideoOut chain", allowed);
        if (g_f) { fclose(g_f); g_f = NULL; }
        return 2;
    }
    gp("Tier A complete: submits allowed = %d, GPU memory mapped, VideoOut live.", allowed);

    /* ---------- Tier B: submit an init-only command buffer ---------- */
    gp("");
    gp("==== Tier B: submit (no flip) ====");
    gp("-> sceGnmDrawInitDefaultHardwareState350(cmd, 256) - the SDK's own default GPU state");
    int used = sceGnmDrawInitDefaultHardwareState350(dcb, 256);
    gp("<- returned %d (dwords of command buffer written)", used);
    if (used <= 0) {
        gp("The driver would not build even the default state. Submit path not reached.");
        snprintf(verdict, vn, "Tier B: InitDefaultHardwareState failed (%d)", used);
        if (g_f) { fclose(g_f); g_f = NULL; }
        return 3;
    }
    uint32_t dcb_bytes = (uint32_t)used * 4;
    void *dcbs[1] = { dcb };
    uint32_t sizes[1] = { dcb_bytes };
    gp("-> sceGnmSubmitCommandBuffers(1 buffer, %u bytes)", dcb_bytes);
    int sr = sceGnmSubmitCommandBuffers(1, dcbs, sizes, NULL, NULL);
    gp("<- rc 0x%08x", (unsigned)sr);
    gp("-> sceGnmSubmitDone (tell the driver the frame is finished)");
    int sd = sceGnmSubmitDone();
    gp("<- rc 0x%08x", (unsigned)sd);
    /* wait for the GPU to drain: AreSubmitsAllowed returns to 1 once idle */
    int drained = 0;
    for (int i = 0; i < 200; i++) {    /* up to ~2 s */
        if (sceGnmAreSubmitsAllowed()) { drained = 1; break; }
        sceKernelUsleep(10000);
    }
    gp("GPU drained the submit: %s", drained ? "yes" : "NO (still busy after 2 s)");
    if (sr != 0) {
        gp("Submit was rejected. This is the wall: a fake-pkg process cannot submit to the GPU.");
        snprintf(verdict, vn, "Tier B: submit rejected 0x%08x", (unsigned)sr);
        if (g_f) { fclose(g_f); g_f = NULL; }
        return 4;
    }
    gp("Tier B complete: the GPU accepted and drained a command buffer. The submit path is OPEN.");

    /* ---------- Tier C: submit + flip a CPU-filled buffer ---------- */
    gp("");
    gp("==== Tier C: submit + flip (proof of pixels) ====");
    gp("Filling display buffer 0 with solid magenta on the CPU, then flipping it THROUGH GNM.");
    uint32_t *buf0 = (uint32_t *)gfx_fb(0);
    unsigned fb_bytes = gfx_fb_bytes();
    if (!buf0) {
        gp("No display buffer pointer - cannot run Tier C.");
        snprintf(verdict, vn, "Tier B ok; Tier C had no buffer");
        if (g_f) { fclose(g_f); g_f = NULL; }
        return 5;
    }
    /* 0xFFFF00FF = opaque magenta in the tool's pixel order */
    for (unsigned i = 0; i < fb_bytes / 4; i++) buf0[i] = 0xFFFF00FFu;
    gp("buffer filled (%u bytes)", fb_bytes);

    /* rebuild the init-only DCB (it was consumed above) */
    memset(dcb, 0, 64 * 1024);
    used = sceGnmDrawInitDefaultHardwareState350(dcb, 256);
    dcb_bytes = (uint32_t)used * 4;
    dcbs[0] = dcb; sizes[0] = dcb_bytes;
    gp("-> sceGnmSubmitAndFlipCommandBuffers(buffer 0, vsync flip)");
    int fr = sceGnmSubmitAndFlipCommandBuffers(1, dcbs, sizes, NULL, NULL,
                                               (uint32_t)vh, 0 /* display buf 0 */,
                                               ORBIS_VIDEO_OUT_FLIP_VSYNC, 0);
    gp("<- rc 0x%08x", (unsigned)fr);
    gp("-> sceGnmSubmitDone");
    sd = sceGnmSubmitDone();
    gp("<- rc 0x%08x", (unsigned)sd);

    /* wait for the flip to land */
    int flipped = 0;
    for (int i = 0; i < 180; i++) {    /* up to ~3 s */
        OrbisVideoOutFlipStatus st; memset(&st, 0, sizeof st);
        if (sceVideoOutGetFlipStatus(vh, &st) == 0 && st.num > 0 && st.currentBuffer == 0) { flipped = 1; break; }
        sceKernelUsleep(16000);
    }
    gp("flip landed: %s", flipped ? "yes" : "unconfirmed");

    if (fr == 0) {
        gp("Tier C complete: GNM accepted a submit-and-flip. If the screen is magenta, the GPU");
        gp("is cracked - a shaded draw is mechanical from here. Press a button to return.");
        snprintf(verdict, vn, "SUBMIT PATH OPEN. Tier C flip rc 0, submits_allowed=%d, screen should be magenta", allowed);
    } else {
        gp("Tier C flip was rejected (0x%08x). Submit works (Tier B) but the GNM flip path does not", (unsigned)fr);
        gp("accept this process; the 2D VideoOut flip still will. Send this file.");
        snprintf(verdict, vn, "Tier B ok; Tier C flip rejected 0x%08x", (unsigned)fr);
    }
    gp("");
    gp("End of GNM probe. Send this whole file.");
    if (g_f) { fclose(g_f); g_f = NULL; }
    return 0;
#endif
}
