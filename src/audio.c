/* audio.c - looping ambient background music via sceAudioOut.
 *
 * Loads a mono S16 48 kHz clip, plays it on a dedicated thread as stereo,
 * looping forever. A soft gain ramp on enable/disable avoids clicks. */
#include "audio.h"

#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <orbis/libkernel.h>
#include <orbis/AudioOut.h>
#include <orbis/UserService.h> /* ORBIS_USER_SERVICE_USER_ID_SYSTEM */

#define GRAIN 1024          /* samples per sceAudioOutOutput call */
#define SAMPLE_RATE 48000

static int16_t *s_pcm;      /* mono source samples */
static uint32_t s_pcm_len;
static volatile int s_enabled = 1;
static volatile int s_run;
static int s_handle = -1;
static pthread_t s_thread;
static volatile int s_errors, s_failed;
static int s_init_rc, s_open_rc, s_open_rc2;

/* ---------------------------------------------------------------- sound player
 * A second output port for playing a decoded sound (the music keeps its own port and is
 * muted while a sound plays). Any channel count is mixed down to stereo; other sample
 * rates are resampled (nearest) to 48 kHz. */
static int16_t *p_pcm;
static uint32_t p_frames, p_ch, p_rate;
static volatile uint64_t p_pos_fx;     /* source position, 32.32 fixed point */
static volatile int p_run, p_paused, p_loop;
static int p_handle = -1, p_music_was;
static pthread_t p_thread;

/* v1.41: sounds play THROUGH THE MUSIC PORT. v1.40 opened a second port per sound and the
 * console ran out (PORT_FULL 0x80260005 after 4 plays). The music thread already outputs
 * continuously and is muted while a sound plays, so it simply outputs the sound instead.
 * Hand-off: the UI thread clears p_active, then waits while the audio thread is inside
 * sound_fill (p_busy), so the caller may free the samples as soon as audio_play_stop returns. */
static volatile int p_active;      /* music thread should output the sound */
static volatile int p_busy;        /* music thread is reading p_pcm right now */
static volatile int p_via_music;   /* current sound uses the music port */
static volatile int s_gain_reset;  /* fade music back in after a sound */
static int p_ports_opened;         /* dedicated fallback ports opened (should stay <= 1) */
static int p_last_open_rc, p_last_open_rc2, p_last_close_rc;

/* one grain of the current sound, mixed to stereo and resampled to 48 kHz */
static void sound_fill(int16_t *out)
{
    uint64_t step = ((uint64_t)p_rate << 32) / SAMPLE_RATE;
    for (int i = 0; i < GRAIN; i++) {
        int32_t l = 0, r = 0;
        uint64_t idx = p_pos_fx >> 32;
        if (!p_paused && idx < p_frames) {
            const int16_t *sp = p_pcm + idx * p_ch;
            if (p_ch == 1) l = r = sp[0];
            else if (p_ch == 2) { l = sp[0]; r = sp[1]; }
            else {  /* 4.0 / 5.1 / 7.1: fronts + rears (+ centre) */
                l = sp[0]; r = sp[1];
                if (p_ch >= 4) { l = (l + sp[p_ch == 4 ? 2 : 4]) / 2; r = (r + sp[p_ch == 4 ? 3 : 5]) / 2; }
                if (p_ch >= 6) { l += sp[2] / 2; r += sp[2] / 2; }
            }
            p_pos_fx += step;
            if ((p_pos_fx >> 32) >= p_frames && p_loop) p_pos_fx = 0;
        }
        if (l > 32767) l = 32767; if (l < -32768) l = -32768;
        if (r > 32767) r = 32767; if (r < -32768) r = -32768;
        out[i * 2] = (int16_t)l; out[i * 2 + 1] = (int16_t)r;
    }
}

void audio_diag(int *init_rc, int *open_rc, int *open_rc2)
{
    *init_rc = s_init_rc; *open_rc = s_open_rc; *open_rc2 = s_open_rc2;
}

static void *audio_loop(void *arg)
{
    (void)arg;
    int16_t out[GRAIN * 2]; /* stereo interleaved */
    uint32_t pos = 0;
    float gain = 0.f;       /* ramps toward target to avoid clicks */

    while (s_run) {
        int sound = 0;
        if (p_active) {
            p_busy = 1;
            __sync_synchronize();
            if (p_active) { sound_fill(out); sound = 1; }
            __sync_synchronize();
            p_busy = 0;
        }
        if (s_gain_reset) { gain = 0.f; s_gain_reset = 0; }
        float target = s_enabled ? 0.6f : 0.f;   /* v1.41: music level set here, port at full volume */
        for (int i = 0; i < GRAIN && !sound; i++) {
            gain += (target - gain) * 0.0005f;
            int16_t s = s_pcm[pos];
            int v = (int)(s * gain);
            out[i * 2] = (int16_t)v;
            out[i * 2 + 1] = (int16_t)v;
            if (++pos >= s_pcm_len) pos = 0;
        }
        if (sceAudioOutOutput(s_handle, out) < 0) { /* normally blocks ~21 ms */
            /* an error returns instantly: without this pause the loop would spin
             * at 100% CPU and could starve the UI thread */
            s_errors++;
            sceKernelUsleep(21000);
            if (s_errors > 100) { s_failed = 1; break; } /* ~2 s of errors: stop music */
        } else {
            s_errors = 0;
        }
    }
    if (!s_failed) { /* flush silence so the port closes cleanly */
        memset(out, 0, sizeof(out));
        sceAudioOutOutput(s_handle, out);
    }
    s_run = 0;
    return NULL;
}

int audio_load(const char *pcm_path)
{
    if (s_pcm) return 0; /* already loaded */
    FILE *f = fopen(pcm_path, "rb");
    if (!f) return -1;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0) { fclose(f); return -2; }
    s_pcm = malloc(sz);
    if (!s_pcm) { fclose(f); return -3; }
    if (fread(s_pcm, 1, sz, f) != (size_t)sz) { fclose(f); free(s_pcm); s_pcm = NULL; return -4; }
    fclose(f);
    s_pcm_len = (uint32_t)(sz / 2);
    if (s_pcm_len < GRAIN) { free(s_pcm); s_pcm = NULL; return -6; } /* too short / corrupt */
    return 0;
}

int audio_open(void)
{
    if (!s_pcm) return -1;
    int irc = sceAudioOutInit();
    s_init_rc = irc;
    /* the main BGM port must be opened as the SYSTEM user (as the OpenOrbis
     * audio sample and Apollo do); the logged-in user's id can be rejected */
    s_handle = sceAudioOutOpen(ORBIS_USER_SERVICE_USER_ID_SYSTEM, ORBIS_AUDIO_OUT_PORT_TYPE_MAIN, 0,
                               GRAIN, SAMPLE_RATE, ORBIS_AUDIO_OUT_PARAM_FORMAT_S16_STEREO);
    s_open_rc = s_handle;
    if (s_handle <= 0) { /* fall back to the logged-in user's id */
        int user = -1;
        sceUserServiceGetInitialUser(&user);
        s_handle = sceAudioOutOpen(user, ORBIS_AUDIO_OUT_PORT_TYPE_MAIN, 0, GRAIN, SAMPLE_RATE,
                                   ORBIS_AUDIO_OUT_PARAM_FORMAT_S16_STEREO);
        s_open_rc2 = s_handle;
    }
    if (s_handle <= 0) { s_handle = -1; return -7; }
    {
        int vol[2] = { 32768, 32768 }; /* v1.41: full; music is scaled to 60% in software so sounds play at 100% */
        sceAudioOutSetVolume(s_handle, 0x1 | 0x2, vol);
    }
    s_run = 1;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 64 * 1024);
    int prc = pthread_create(&s_thread, &attr, audio_loop, NULL);
    pthread_attr_destroy(&attr);
    if (prc != 0) {
        s_run = 0;
        sceAudioOutClose(s_handle);
        s_handle = -1;
        return -5;
    }
    return 0;
}

int audio_start(const char *pcm_path)
{
    int rc = audio_load(pcm_path);
    return rc ? rc : audio_open();
}

void audio_set_enabled(int on) { s_enabled = on ? 1 : 0; }
int  audio_is_enabled(void) { return s_enabled; }
int  audio_available(void) { return s_run && !s_failed; }
int  audio_failed(void) { return s_failed; }

void audio_stop(void)
{
    audio_play_stop();
    if (p_handle >= 0) { p_last_close_rc = sceAudioOutClose(p_handle); p_handle = -1; }
    if (!s_run) return;
    s_run = 0;
    pthread_join(s_thread, NULL);
    if (s_handle >= 0) { sceAudioOutClose(s_handle); s_handle = -1; }
    free(s_pcm);
    s_pcm = NULL;
}

static void *play_loop(void *arg)
{
    (void)arg;
    int16_t out[GRAIN * 2];
    while (p_run) {
        sound_fill(out);
        if (sceAudioOutOutput(p_handle, out) < 0) sceKernelUsleep(21000);
    }
    memset(out, 0, sizeof(out));
    sceAudioOutOutput(p_handle, out);
    return NULL;
}

int audio_play_pcm(int16_t *pcm, uint32_t frames, uint32_t channels, uint32_t rate)
{
    audio_play_stop();
    if (!pcm || !frames || !channels || channels > 8 || !rate) return -1;
    p_pcm = pcm; p_frames = frames; p_ch = channels; p_rate = rate;
    p_pos_fx = 0; p_paused = 0; p_loop = 0;
    p_music_was = s_enabled;

    if (s_run && !s_failed) {          /* the normal path: borrow the music port */
        s_enabled = 0;                 /* music silent while the sound plays */
        p_via_music = 1;
        p_run = 1;
        __sync_synchronize();
        p_active = 1;
        return 0;
    }

    /* fallback (music could not start): one dedicated port, opened once and kept */
    p_via_music = 0;
    if (p_handle < 0) {
        if (s_handle < 0) sceAudioOutInit();
        p_handle = sceAudioOutOpen(ORBIS_USER_SERVICE_USER_ID_SYSTEM, ORBIS_AUDIO_OUT_PORT_TYPE_MAIN, 0, GRAIN, SAMPLE_RATE,
                                   ORBIS_AUDIO_OUT_PARAM_FORMAT_S16_STEREO);
        p_last_open_rc = p_handle;
        if (p_handle <= 0) {
            int user = -1;
            sceUserServiceGetInitialUser(&user);
            p_handle = sceAudioOutOpen(user, ORBIS_AUDIO_OUT_PORT_TYPE_MAIN, 0, GRAIN, SAMPLE_RATE, ORBIS_AUDIO_OUT_PARAM_FORMAT_S16_STEREO);
            p_last_open_rc2 = p_handle;
        }
        if (p_handle <= 0) { int rc = p_handle; p_handle = -1; p_pcm = NULL; return rc ? rc : -7; }
        p_ports_opened++;
        int vol[2] = { 32768, 32768 };
        sceAudioOutSetVolume(p_handle, 0x1 | 0x2, vol);
    }
    p_run = 1;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 64 * 1024);
    int prc = pthread_create(&p_thread, &attr, play_loop, NULL);
    pthread_attr_destroy(&attr);
    if (prc != 0) { p_run = 0; p_pcm = NULL; return -5; }
    return 0;
}

void audio_play_stop(void)
{
    if (!p_run) return;
    p_run = 0;
    if (p_via_music) {
        p_active = 0;
        __sync_synchronize();
        while (p_busy) sceKernelUsleep(500);     /* at most one grain (~21 ms) */
        s_gain_reset = 1;
    } else {
        pthread_join(p_thread, NULL);            /* the dedicated port stays open for the next sound */
    }
    p_pcm = NULL;                /* owned by the caller */
    s_enabled = p_music_was;
}

const char *audio_play_route(void)
{
    static char b[160];
    snprintf(b, sizeof b, "%s, fallback ports opened %d, last open 0x%08x/0x%08x, last close 0x%08x",
             p_via_music ? "music port" : (p_handle >= 0 ? "own port" : "none"),
             p_ports_opened, (unsigned)p_last_open_rc, (unsigned)p_last_open_rc2, (unsigned)p_last_close_rc);
    return b;
}

void audio_play_pause(int paused) { p_paused = paused; }
void audio_play_loop(int on) { p_loop = on; }
void audio_play_seek(uint32_t frame) { if (frame < p_frames) p_pos_fx = (uint64_t)frame << 32; }
int  audio_play_active(void) { return p_run; }
uint32_t audio_play_pos(void) { uint64_t i = p_pos_fx >> 32; return i > p_frames ? p_frames : (uint32_t)i; }
