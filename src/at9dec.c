/* at9dec.c - ATRAC9 decoding through libSceAjm (the PS4 audio co-processor).
 *
 * Sequence: sceAjmInitialize -> ModuleRegister(AT9) -> InstanceCreate -> one control job
 * (reset + initialize with the 4-byte ATRAC9 config) -> run jobs, each fed a run of whole
 * superframes, producing interleaved S16 PCM. Job/instance flag layout (from the libSceAjm
 * interface): instance = version:3 | channels:4 | format:3 | ... | codec flags << 32;
 * job = version:3 | codec FLAGS:8 (leave 0) | run:2 | control:3 | ... | sideband:3 << 45.
 * The "version" field must be non-zero; if the library rejects the value with
 * WRONG_REVISION (0x8093000B) the next value is tried, so a firmware difference does not
 * stop playback. Every return code is kept in at9_last_diag() for the log.
 */
#include "at9dec.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { int error_code; const void *job_addr; uint32_t cmd_offset; const void *job_ra; } AjmBatchError;
/* libSceAjm is loaded at run time (not linked), so the app still starts if the module is
 * missing; the player then reports that and offers the .at9 export instead. */
typedef int   (*fn_init)(int64_t, uint32_t *);
typedef int   (*fn_fini)(uint32_t);
typedef int   (*fn_reg)(uint32_t, uint32_t, int64_t);
typedef int   (*fn_icreate)(uint32_t, uint32_t, uint64_t, uint32_t *);
typedef int   (*fn_idestroy)(uint32_t, uint32_t);
typedef void *(*fn_ctrl)(void *, uint32_t, uint64_t, void *, size_t, void *, size_t, void *);
typedef void *(*fn_run)(void *, uint32_t, uint64_t, void *, size_t, void *, size_t, void *, size_t, void *);
typedef int   (*fn_start)(uint32_t, void *, uint32_t, int, AjmBatchError *, uint32_t *);
typedef int   (*fn_wait)(uint32_t, uint32_t, uint32_t, AjmBatchError *);
static struct {
    int loaded;
    fn_init Initialize; fn_fini Finalize; fn_reg ModuleRegister; fn_icreate InstanceCreate; fn_idestroy InstanceDestroy;
    fn_ctrl ControlRa; fn_run RunRa; fn_start Start; fn_wait Wait;
} A;

#ifdef AT9_LINKED   /* host tests / simulator: functions are linked directly */
int   sceAjmInitialize(int64_t, uint32_t *); int sceAjmFinalize(uint32_t); int sceAjmModuleRegister(uint32_t, uint32_t, int64_t);
int   sceAjmInstanceCreate(uint32_t, uint32_t, uint64_t, uint32_t *); int sceAjmInstanceDestroy(uint32_t, uint32_t);
void *sceAjmBatchJobControlBufferRa(void *, uint32_t, uint64_t, void *, size_t, void *, size_t, void *);
void *sceAjmBatchJobRunBufferRa(void *, uint32_t, uint64_t, void *, size_t, void *, size_t, void *, size_t, void *);
int   sceAjmBatchStartBuffer(uint32_t, void *, uint32_t, int, AjmBatchError *, uint32_t *); int sceAjmBatchWait(uint32_t, uint32_t, uint32_t, AjmBatchError *);
static int ajm_load(char *err, size_t en)
{
    (void)err; (void)en;
    A.Initialize = sceAjmInitialize; A.Finalize = sceAjmFinalize; A.ModuleRegister = sceAjmModuleRegister;
    A.InstanceCreate = sceAjmInstanceCreate; A.InstanceDestroy = sceAjmInstanceDestroy; A.ControlRa = sceAjmBatchJobControlBufferRa;
    A.RunRa = sceAjmBatchJobRunBufferRa; A.Start = sceAjmBatchStartBuffer; A.Wait = sceAjmBatchWait;
    A.loaded = 1;
    return 0;
}
#else
#include <orbis/libkernel.h>
static int ajm_load(char *err, size_t en)
{
    if (A.loaded) return 0;
    int h = -1;
    const char *word = sceKernelGetFsSandboxRandomWord();
    if (word && word[0]) {
        char path[128];
        snprintf(path, sizeof path, "/%s/common/lib/libSceAjm.sprx", word);
        h = (int)sceKernelLoadStartModule(path, 0, NULL, 0, NULL, NULL);
    }
    if (h < 0) h = (int)sceKernelLoadStartModule("/system/common/lib/libSceAjm.sprx", 0, NULL, 0, NULL, NULL);
    if (h < 0) h = (int)sceKernelLoadStartModule("libSceAjm.sprx", 0, NULL, 0, NULL, NULL);
    if (h < 0) { snprintf(err, en, "the PS4 audio decoder library (libSceAjm) could not be loaded (0x%08x)", (unsigned)h); return -1; }
    struct { const char *n; void **p; } t[] = {
        { "sceAjmInitialize", (void **)&A.Initialize }, { "sceAjmFinalize", (void **)&A.Finalize },
        { "sceAjmModuleRegister", (void **)&A.ModuleRegister }, { "sceAjmInstanceCreate", (void **)&A.InstanceCreate },
        { "sceAjmInstanceDestroy", (void **)&A.InstanceDestroy }, { "sceAjmBatchJobControlBufferRa", (void **)&A.ControlRa },
        { "sceAjmBatchJobRunBufferRa", (void **)&A.RunRa }, { "sceAjmBatchStartBuffer", (void **)&A.Start },
        { "sceAjmBatchWait", (void **)&A.Wait } };
    for (size_t i = 0; i < sizeof(t) / sizeof(t[0]); i++)
        if (sceKernelDlsym(h, t[i].n, t[i].p) != 0 || !*t[i].p) { snprintf(err, en, "libSceAjm has no %s", t[i].n); return -1; }
    A.loaded = 1;
    return 0;
}
#endif

#define AJM_CODEC_AT9        1u
#define AJM_ERR_REVISION     ((int)0x8093000B)
#define JOB_CTRL_RESET       (1ull << 13)
#define JOB_CTRL_INIT        (2ull << 13)
#define JOB_RUN_MULTI        (2ull << 11)
#define JOB_SB_STREAM        (4ull << 45)

static char g_diag[512];

const char *at9_last_diag(void) { return g_diag; }

static void diag(const char *fmt, int v)
{
    size_t l = strlen(g_diag);
    if (l < sizeof(g_diag) - 40) snprintf(g_diag + l, sizeof(g_diag) - l, fmt, v);
}

typedef struct { int32_t result, internal; } SbResult;
typedef struct { SbResult r; int32_t in_used, out_written; uint64_t total; uint32_t frames, reserved; } SbRun;

static int g_prio, g_prio_found;

static int run_batch(uint32_t ctx, uint8_t *batch, uint8_t *end, char *err, size_t en)
{
    AjmBatchError be;
    memset(&be, 0, sizeof be);
    uint32_t id = 0;
    /* 0x8093000E from the start call is "bad priority" as far as is known: firmware 6.72
     * refused priority 0. Other values are tried once and the one that works is kept. */
    static const int prios[] = { 4, 3, 2, 1, 5, 6, 7, 8, 16, 32, 64, 127, 255, -1 };
    int rc = A.Start(ctx, batch, (uint32_t)(end - batch), g_prio, &be, &id);
    if (rc == (int)0x8093000E && !g_prio_found) {
        for (size_t i = 0; i < sizeof prios / sizeof prios[0] && rc == (int)0x8093000E; i++) {
            memset(&be, 0, sizeof be);
            rc = A.Start(ctx, batch, (uint32_t)(end - batch), prios[i], &be, &id);
            if (rc != (int)0x8093000E) g_prio = prios[i];
        }
        diag("prio=%d ", rc == (int)0x8093000E ? -999 : g_prio);
    }
    if (rc >= 0) g_prio_found = 1;
    if (rc < 0) { snprintf(err, en, "AJM batch start failed (0x%08x, job error 0x%08x)", (unsigned)rc, (unsigned)be.error_code); return rc; }
    rc = A.Wait(ctx, id, 5000000u, &be);
    if (rc < 0) { snprintf(err, en, "AJM batch wait failed (0x%08x, job error 0x%08x)", (unsigned)rc, (unsigned)be.error_code); return rc; }
    return 0;
}

int16_t *at9_decode(const uint8_t *stream, size_t len, const uint8_t config[4], int channels,
                    uint32_t block, uint32_t spb, uint32_t total, uint32_t *frames,
                    int (*progress)(void *u, double done), void *u, char *err, size_t en)
{
    g_diag[0] = 0;
    *frames = 0;
    if (ajm_load(err, en) != 0) return NULL;
    if (channels < 1 || channels > 8 || !block || !spb || len < block) { snprintf(err, en, "unsupported ATRAC9 parameters"); return NULL; }
    uint32_t nblocks = (uint32_t)(len / block);
    uint64_t cap_frames = (uint64_t)nblocks * spb;
    if (total && total < cap_frames) cap_frames = total;
    if (cap_frames > 48000ull * 60 * 30) { snprintf(err, en, "sound too long to decode in memory"); return NULL; }
    int16_t *pcm = malloc((size_t)((uint64_t)nblocks * spb * channels * 2 + 4096));
    uint8_t *batch = malloc(4096);
    if (!pcm || !batch) { free(pcm); free(batch); snprintf(err, en, "out of memory"); return NULL; }

    uint32_t ctx = 0, inst = 0;
    int rc = A.Initialize(0, &ctx);
    diag("init=0x%08x ", rc);
    if (rc < 0) { snprintf(err, en, "the audio decoder (AJM) could not start (0x%08x)", (unsigned)rc); free(pcm); free(batch); return NULL; }
    rc = A.ModuleRegister(ctx, AJM_CODEC_AT9, 0);
    diag("reg=0x%08x ", rc);
    if (rc < 0 && rc != (int)0x80930011 /* already registered */) {
        snprintf(err, en, "ATRAC9 decoder not available (0x%08x)", (unsigned)rc);
        A.Finalize(ctx); free(pcm); free(batch); return NULL;
    }
    uint64_t ver = 0;
    for (uint64_t v = 1; v <= 7; v++) {
        uint64_t iflags = v | ((uint64_t)(channels & 15) << 3) | (0ull << 7) /* S16 */;
        rc = A.InstanceCreate(ctx, AJM_CODEC_AT9, iflags, &inst);
        diag("create(v%d)=", (int)v);
        diag("0x%08x ", rc);
        if (rc != AJM_ERR_REVISION) { ver = v; break; }
    }
    if (rc < 0) { snprintf(err, en, "ATRAC9 decoder instance failed (0x%08x)", (unsigned)rc); A.Finalize(ctx); free(pcm); free(batch); return NULL; }

    /* initialize with the config data.
     * v1.31: bits 3..10 of a JOB flags word are codec-specific FLAGS, not the codec type.
     * v1.30 wrote AJM_CODEC_AT9 << 3 (0x8) there and the decoder answered
     * UNSUPPORTED_FLAG | FATAL (0x80000080). The field is now left at zero. In case this
     * firmware still objects, two more shapes are tried and every answer is logged:
     *   A = version | reset | init     B = version | init     C = reset | init (no version) */
    struct { uint8_t cfg[4]; uint32_t reserved; } initp;
    memcpy(initp.cfg, config, 4); initp.reserved = 0;
    SbResult ires;
    int ok = 0;
    uint64_t jbase = ver;              /* version bits used in job words once one works */
    memset(&ires, 0, sizeof ires);
    for (int shape = 0; shape < 3 && !ok; shape++) {
        for (uint64_t v = ver; v <= 7 && !ok; v++) {
            uint64_t jf = shape == 0 ? (v | JOB_CTRL_RESET | JOB_CTRL_INIT)
                        : shape == 1 ? (v | JOB_CTRL_INIT)
                        :              (JOB_CTRL_RESET | JOB_CTRL_INIT);
            memset(&ires, 0, sizeof ires);
            uint8_t *end = A.ControlRa(batch, inst, jf, &initp, sizeof initp, &ires, sizeof ires, NULL);
            if (!end || end <= batch || end > batch + 4096) { snprintf(err, en, "AJM job buffer error"); shape = 3; break; }
            err[0] = 0;
            rc = run_batch(ctx, batch, end, err, en);
            diag(shape == 0 ? "initA(v%d)=" : shape == 1 ? "initB(v%d)=" : "initC(v%d)=", shape == 2 ? 0 : (int)v);
            diag("0x%08x/", rc);
            diag("0x%08x ", ires.result);
            if (rc == 0 && ires.result >= 0) { ok = 1; jbase = shape == 2 ? 0 : v; if (shape != 2) ver = v; }
            else if (shape == 2 || (rc != AJM_ERR_REVISION && ires.result != AJM_ERR_REVISION)) break;
        }
    }
    if (!ok) {
        if (!err[0]) snprintf(err, en, "ATRAC9 decoder rejected the stream settings (0x%08x)", (unsigned)ires.result);
        A.InstanceDestroy(ctx, inst); A.Finalize(ctx); free(pcm); free(batch); return NULL;
    }

    /* decode: up to 16 superframes per job */
    size_t pos = 0;
    uint64_t out_frames = 0;
    const uint32_t per = 16;
    int16_t *tmp = malloc((size_t)per * spb * channels * 2);
    if (!tmp) { snprintf(err, en, "out of memory"); ok = 0; }
    while (ok && pos + block <= len) {
        uint32_t nb = (uint32_t)((len - pos) / block);
        if (nb > per) nb = per;
        SbRun sb;
        memset(&sb, 0, sizeof sb);
        uint64_t jf = jbase | JOB_RUN_MULTI | JOB_SB_STREAM;   /* no codec bits, see the init job */
        size_t outsz = (size_t)nb * spb * channels * 2;
        uint8_t *end = A.RunRa(batch, inst, jf, (void *)(stream + pos), (size_t)nb * block, tmp, outsz, &sb, sizeof sb, NULL);
        if (!end || end <= batch || end > batch + 4096) { snprintf(err, en, "AJM job buffer error"); ok = 0; break; }
        rc = run_batch(ctx, batch, end, err, en);
        if (rc < 0 || sb.r.result < 0) {
            if (!err[0] || rc == 0) snprintf(err, en, "ATRAC9 decode error at byte %zu (0x%08x / 0x%08x)", pos, (unsigned)sb.r.result, (unsigned)sb.r.internal);
            diag("run=0x%08x ", rc < 0 ? rc : sb.r.result);
            /* keep what was decoded so far if it is a real amount */
            if (out_frames < spb * 4) ok = 0;
            break;
        }
        int32_t used = sb.in_used > 0 ? sb.in_used : (int32_t)(nb * block);
        int32_t wrote = sb.out_written > 0 ? sb.out_written : (int32_t)outsz;
        if (wrote > (int32_t)outsz) wrote = (int32_t)outsz;
        if (used <= 0) { snprintf(err, en, "ATRAC9 decoder made no progress"); ok = out_frames > 0; break; }
        uint32_t f = (uint32_t)(wrote / (channels * 2));
        if (out_frames + f > (uint64_t)nblocks * spb) f = (uint32_t)((uint64_t)nblocks * spb - out_frames);
        memcpy(pcm + out_frames * channels, tmp, (size_t)f * channels * 2);
        out_frames += f;
        pos += (size_t)used;
        if (progress && progress(u, (double)pos / len)) { snprintf(err, en, "cancelled"); ok = 0; break; }
    }
    free(tmp);
    diag("frames=%d", (int)out_frames);
    A.InstanceDestroy(ctx, inst);
    A.Finalize(ctx);
    free(batch);
    if (!ok || !out_frames) { free(pcm); if (!err[0]) snprintf(err, en, "nothing decoded"); return NULL; }
    if (total && out_frames > total) out_frames = total;
    *frames = (uint32_t)out_frames;
    err[0] = 0;
    return pcm;
}
