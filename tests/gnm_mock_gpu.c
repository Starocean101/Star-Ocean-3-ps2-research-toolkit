/* Host mock of the PS4 GPU path: executes the PM4 packets the probe writes. MODE env:
 *  ok        everything works
 *  noexec    driver accepts submits, GPU never runs them
 *  reject    every submit rejected
 *  flipbad   GNM submit+flip rejected (VideoOut flip still works)
 *  nodma     DMA_DATA ignored (write-data still works)
 *  nogarlic  GARLIC allocation fails
 *  noinit    GPU hangs on the default-state block */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <orbis/libkernel.h>
#include <orbis/GnmDriver.h>
#include <orbis/VideoOut.h>
static const char *M(void){ const char *m=getenv("MODE"); return m?m:"ok"; }
static int is(const char *x){ return !strcmp(M(),x); }
#define NB 2
static uint32_t *fbs[NB]; static unsigned FBB=1920*1080*4;
static OrbisVideoOutFlipStatus st;
int gfx_video_handle(void){return 7;} int gfx_fb_count(void){return NB;}
void *gfx_fb(int i){ if(!fbs[0]) for(int k=0;k<NB;k++) fbs[k]=calloc(1,FBB); return (i>=0&&i<NB)?fbs[i]:NULL;}
unsigned gfx_fb_bytes(void){return FBB;}
int32_t sceKernelAllocateDirectMemory(off_t a, off_t b, size_t len, size_t al, int32_t t, off_t *p){ if(t==3&&is("nogarlic")) return 0x80020001; *p=(off_t)len; return 0;}
int32_t sceKernelMapDirectMemory(void **p, size_t len, int32_t pr, int32_t f, off_t ph, size_t al){ *p=aligned_alloc(0x10000,len); return 0;}
size_t sceKernelGetDirectMemorySize(){return (size_t)5<<30;}
int32_t sceKernelUsleep(uint32_t us){(void)us;return 0;}
int32_t sceGnmAreSubmitsAllowed(void){return 1;}
int32_t sceGnmDrawInitDefaultHardwareState350(uint32_t *c, uint32_t n){ memset(c,0,n*4); c[0]=0xC0000000u|((n-2)<<16)|(0x10<<8); c[1]=0x1D1D1D1D; return (int)n; }
static int exec(uint32_t *c, uint32_t dw){
  if(is("noexec")) return 0;
  uint32_t i=0; while(i<dw){ uint32_t h=c[i]; if((h>>30)!=3){fprintf(stderr,"bad header %08x at %u\n",h,i);return -1;}
    uint32_t body=((h>>16)&0x3fff)+1, op=(h>>8)&0xff; uint32_t *b=c+i+1;
    if(op==0x10 && b[0]==0x1D1D1D1D && is("noinit")) return -2; /* hang */
    if(op==0x37){ uint64_t a=((uint64_t)b[2]<<32)|b[1]; uint32_t n=body-3; memcpy((void*)(uintptr_t)a,b+3,n*4);} 
    else if(op==0x47){ uint64_t a=((uint64_t)(b[2]&0xffff)<<32)|b[1]; if(((b[2]>>29)&7)==1) *(uint32_t*)(uintptr_t)a=b[3]; }
    else if(op==0x50){ if(!is("nodma")){ uint64_t a=((uint64_t)b[4]<<32)|b[3]; uint32_t n=b[5]&0x1fffff; if(((b[0]>>29)&3)==2){uint32_t *d=(uint32_t*)(uintptr_t)a; for(uint32_t k=0;k<n/4;k++) d[k]=b[1];} } }
    else if(op!=0x10){ fprintf(stderr,"unknown opcode %x\n",op); return -1; }
    i+=1+body; }
  return 0; }
int32_t sceGnmSubmitCommandBuffers(uint32_t n, void *d[], uint32_t *s, void *cc[], uint32_t *cs){ if(is("reject")) return 0x80d11000; return exec(d[0], s[0]/4)<0 && !is("noinit") ? 0x80d110ff : 0; }
int32_t sceGnmSubmitDone(void){return 0;}
int32_t sceGnmSubmitAndFlipCommandBuffers(uint32_t n, void *d[], uint32_t *s, void *cc[], uint32_t *cs, uint32_t vh, uint32_t buf, uint32_t mode, uint64_t arg){
  if(is("reject")) return 0x80d11000;
  uint32_t *c=d[0], dw=s[0]/4; uint32_t *pf=c+dw-64;
  if(dw<64 || pf[0]!=0xC03E1000u){ return 0x80D11080; }   /* same check as the real driver */
  if(is("flipbad")) return 0x80D11082;
  uint32_t marker=pf[1], la=pf[2], lh=pf[3], lv=pf[4];
  memset(pf,0,64*4); pf[0]=0xC03E1000u; pf[1]=0x68750776u;   /* driver patches it */
  if(exec(c,dw)<0) return 0;   /* hung: flip never happens */
  st.num++; st.currentBuffer=buf; st.flipArg=arg;
  if(marker==0x68750778u) *(uint32_t*)(uintptr_t)(((uint64_t)lh<<32)|la)=lv;
  return 0; }
int32_t sceVideoOutGetFlipStatus(int32_t h, OrbisVideoOutFlipStatus *s){ *s=st; return 0; }
int32_t sceVideoOutSubmitFlip(int32_t h, int32_t buf, uint32_t mode, int64_t arg){ st.num++; st.currentBuffer=buf; st.flipArg=arg; return 0; }
static void out(const char *l){(void)l;}
#include "gnm.h"
int main(void){ char v[200]; int r=gnm_probe("/tmp/gnmtest/out.txt", out, v, sizeof v); printf("[%s] rc=%d verdict: %s\n", M(), r, v); return 0; }
