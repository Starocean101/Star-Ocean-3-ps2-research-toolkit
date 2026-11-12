/* Host mock of PS4 AudioOut with a hard port limit (2 open ports, like the console behaved):
 * 3rd simultaneous open -> PORT_FULL 0x80260005. Output blocks ~0.3 ms per grain. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <pthread.h>
#include <orbis/libkernel.h>
#include <orbis/AudioOut.h>
#include <orbis/UserService.h>
#include "audio.h"
static int open_now, opened_total, fail_music;
static volatile long frames_out; static volatile int16_t last_l, max_l;
__attribute__((weak)) const char *audio_play_route(void){ return "(v1.40 has no route info)"; }
int32_t sceAudioOutInit(void){return 0;}
int32_t sceAudioOutOpen(OrbisUserServiceUserId u, enum OrbisAudioOutPort p, int32_t i, uint32_t len, uint32_t sr, uint32_t pt){
  if (fail_music && opened_total<2){ opened_total++; return (int32_t)0x80260001; }   /* both music attempts fail */
  if (open_now>=2) return (int32_t)0x80260005; open_now++; opened_total++; return 0x20000000+opened_total; }
int32_t sceAudioOutClose(int32_t h){ open_now--; return 0; }
int32_t sceAudioOutOutput(int32_t h, const void *b){ const int16_t *s=b; last_l=s[0]; if(s[0]>max_l) max_l=s[0]; frames_out+=1024; usleep(300); return 0; }
int32_t sceAudioOutSetVolume(int32_t h, int32_t f, int32_t *v){return 0;}
int32_t sceUserServiceGetInitialUser(int32_t *u){*u=1;return 0;}
int32_t sceKernelUsleep(uint32_t us){ usleep(us); return 0; }
int main(int argc, char **argv){
  fail_music = argc>1 && !strcmp(argv[1],"nomusic");
  FILE *f=fopen("/tmp/audtest/m.pcm","wb"); for(int i=0;i<48000;i++){int16_t v=1000; fwrite(&v,2,1,f);} fclose(f);
  int mr=audio_start("/tmp/audtest/m.pcm"); printf("music start rc=%d (ports open %d)\n", mr, open_now);
  int fails=0;
  for (int k=0;k<60;k++){
    uint32_t n=4000+(k*997)%9000; int16_t *pcm=malloc(n*2*sizeof(int16_t));
    for(uint32_t i=0;i<n*2;i++) pcm[i]=12345;
    int rc=audio_play_pcm(pcm,n,2,48000);
    if(rc){ fails++; printf("play %d failed 0x%08x [%s]\n",k,(unsigned)rc,audio_play_route()); free(pcm); continue; }
    usleep((k%5)*700);                   /* stop at random points: mid-grain, early, late */
    audio_play_stop(); free(pcm);        /* caller frees immediately after stop: ASan catches any late read */
  }
  /* one full play to check the samples actually reach the port */
  uint32_t n=9600; int16_t *pcm=malloc(n*2*2); for(uint32_t i=0;i<n*2;i++) pcm[i]=22222;
  max_l=0; audio_play_pcm(pcm,n,2,48000); usleep(5000); int16_t seen=max_l; audio_play_stop(); free(pcm);
  printf("60 plays, failures %d, ports open now %d, total opened %d, loudest sample output during play %d (want 22222), route: %s\n",
         fails, open_now, opened_total, seen, audio_play_route());
  audio_stop(); printf("after audio_stop: ports open %d\n", open_now);
  return 0; }
