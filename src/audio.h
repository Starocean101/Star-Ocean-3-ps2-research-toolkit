/* audio.h - looping ambient background music via sceAudioOut. */
#pragma once

/* Load a mono signed-16 48 kHz PCM file and start a background thread that
 * loops it. Returns 0 on success. Safe to call once at startup. */
int  audio_start(const char *pcm_path);  /* = audio_load + audio_open */
int  audio_load(const char *pcm_path);   /* read the clip into memory (do this BEFORE the jailbreak) */
int  audio_open(void);                   /* open the output port and start the music thread */
void audio_diag(int *init_rc, int *open_rc, int *open_rc2);

/* Toggle playback on/off (music keeps looping; this mutes/unmutes output). */
void audio_set_enabled(int on);
int  audio_is_enabled(void);
int  audio_available(void);
int  audio_failed(void);     /* 1 if the music thread stopped itself after errors */  /* 1 if the music thread is actually running */
void audio_stop(void);

/* Sound player (second output port; the music is muted while it plays). pcm stays owned by
 * the caller and must stay valid until audio_play_stop(). Returns 0 or a negative code. */
#include <stdint.h>
int      audio_play_pcm(int16_t *pcm, uint32_t frames, uint32_t channels, uint32_t rate);
void     audio_play_stop(void);
void     audio_play_pause(int paused);
void     audio_play_loop(int on);
void     audio_play_seek(uint32_t frame);
int      audio_play_active(void);
uint32_t audio_play_pos(void);
const char *audio_play_route(void);   /* v1.41: which port sounds use, for the log */
