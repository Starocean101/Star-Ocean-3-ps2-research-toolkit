/* gpu.c - experimental GPU renderer: OpenGL ES 2 through the PS4's own Piglet library
 * (libScePigletv2VSH), following the OpenOrbis "piglet" sample (flat_z's ps4_gl_test).
 *
 * Nothing here is linked into the app: the libraries are loaded at run time and every
 * function is looked up by name, so the app starts the same whether or not they exist.
 *
 * Shaders, in order of preference:
 *   1. GLSL  - our own shaders (below), compiled on the console. Per-vertex UVs and
 *              normals, alpha cut-out, one draw call per mesh. Retail Piglet only compiles
 *              GLSL when its shader compiler is enabled, so this may be refused.
 *   2. SYSTEM - the precompiled "texmap" shader that ships in libScePrecompiledShaders
 *              (the web browser's layer shader). It only knows
 *                  position = P * MV * vec4(a.xy, 0, 1),  uv = (T * vec4(a.xy, 0, 1)).xy
 *              so each triangle is drawn as the unit triangle (0,0) (1,0) (0,1) with
 *              MV and T chosen to map it onto the triangle's corners and UVs - one draw
 *              call per triangle. Lighting is a per-triangle constant applied with the
 *              blend colour (textures are uploaded premultiplied).
 * Depth: a 16-bit depth buffer is requested; without one triangles are sorted far-to-near.
 */
#include "gpu.h"
#include "gfx.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>

/* ---- GL / EGL constants and types (no headers needed) ---- */
typedef unsigned int GLenum, GLuint, GLbitfield;
typedef int GLint, GLsizei;
typedef float GLfloat;
typedef unsigned char GLboolean;
#define GL_TRIANGLES 4
#define GL_DEPTH_BUFFER_BIT 0x100
#define GL_COLOR_BUFFER_BIT 0x4000
#define GL_ONE 1
#define GL_SRC_ALPHA 0x302
#define GL_ONE_MINUS_SRC_ALPHA 0x303
#define GL_CONSTANT_COLOR 0x8001
#define GL_LEQUAL 0x203
#define GL_DEPTH_TEST 0xB71
#define GL_BLEND 0xBE2
#define GL_TEXTURE_2D 0xDE1
#define GL_UNPACK_ALIGNMENT 0xCF5
#define GL_UNSIGNED_BYTE 0x1401
#define GL_UNSIGNED_SHORT 0x1403
#define GL_FLOAT 0x1406
#define GL_RGBA 0x1908
#define GL_VENDOR 0x1F00
#define GL_RENDERER 0x1F01
#define GL_VERSION 0x1F02
#define GL_LINEAR 0x2601
#define GL_TEXTURE_MAG_FILTER 0x2800
#define GL_TEXTURE_MIN_FILTER 0x2801
#define GL_TEXTURE_WRAP_S 0x2802
#define GL_TEXTURE_WRAP_T 0x2803
#define GL_REPEAT 0x2901
#define GL_CLAMP_TO_EDGE 0x812F
#define GL_TEXTURE0 0x84C0
#define GL_FRAGMENT_SHADER 0x8B30
#define GL_VERTEX_SHADER 0x8B31
#define GL_COMPILE_STATUS 0x8B81
#define GL_LINK_STATUS 0x8B82
#define GL_ACTIVE_UNIFORMS 0x8B86
#define GL_SAMPLER_2D 0x8B5E
#define EGL_ALPHA_SIZE 0x3021
#define EGL_BLUE_SIZE 0x3022
#define EGL_GREEN_SIZE 0x3023
#define EGL_RED_SIZE 0x3024
#define EGL_DEPTH_SIZE 0x3025
#define EGL_STENCIL_SIZE 0x3026
#define EGL_SAMPLES 0x3031
#define EGL_SAMPLE_BUFFERS 0x3032
#define EGL_SURFACE_TYPE 0x3033
#define EGL_NONE 0x3038
#define EGL_RENDERABLE_TYPE 0x3040
#define EGL_HEIGHT 0x3056
#define EGL_WIDTH 0x3057
#define EGL_BACK_BUFFER 0x3084
#define EGL_RENDER_BUFFER 0x3086
#define EGL_CONTEXT_CLIENT_VERSION 0x3098
#define EGL_OPENGL_ES_API 0x30A0
#define EGL_OPENGL_ES2_BIT 4
#define EGL_WINDOW_BIT 4
#define EGL_PBUFFER_BIT 1

static struct {
    /* EGL */
    void *(*eglGetDisplay)(void *);
    unsigned (*eglInitialize)(void *, int *, int *);
    unsigned (*eglBindAPI)(unsigned);
    unsigned (*eglSwapInterval)(void *, int);
    unsigned (*eglChooseConfig)(void *, const int *, void **, int, int *);
    unsigned (*eglGetConfigAttrib)(void *, void *, int, int *);
    void *(*eglCreateWindowSurface)(void *, void *, void *, const int *);
    void *(*eglCreatePbufferSurface)(void *, void *, const int *);
    void *(*eglCreateContext)(void *, void *, void *, const int *);
    unsigned (*eglMakeCurrent)(void *, void *, void *, void *);
    unsigned (*eglSwapBuffers)(void *, void *);
    int (*eglGetError)(void);
    unsigned (*eglDestroySurface)(void *, void *);
    unsigned (*eglDestroyContext)(void *, void *);
    unsigned (*eglTerminate)(void *);
    /* GL */
    GLenum (*glGetError)(void);
    const unsigned char *(*glGetString)(GLenum);
    void (*glViewport)(GLint, GLint, GLsizei, GLsizei);
    void (*glClearColor)(GLfloat, GLfloat, GLfloat, GLfloat);
    void (*glClear)(GLbitfield);
    void (*glEnable)(GLenum);
    void (*glDisable)(GLenum);
    void (*glBlendFunc)(GLenum, GLenum);
    void (*glBlendColor)(GLfloat, GLfloat, GLfloat, GLfloat);     /* optional */
    void (*glDepthFunc)(GLenum);
    void (*glDepthMask)(GLboolean);
    GLuint (*glCreateShader)(GLenum);
    void (*glShaderSource)(GLuint, GLsizei, const char *const *, const GLint *);
    void (*glCompileShader)(GLuint);
    void (*glGetShaderiv)(GLuint, GLenum, GLint *);
    void (*glGetShaderInfoLog)(GLuint, GLsizei, GLsizei *, char *);
    void (*glShaderBinary)(GLsizei, const GLuint *, GLenum, const void *, GLsizei);
    void (*glDeleteShader)(GLuint);
    GLuint (*glCreateProgram)(void);
    void (*glAttachShader)(GLuint, GLuint);
    void (*glLinkProgram)(GLuint);
    void (*glGetProgramiv)(GLuint, GLenum, GLint *);
    void (*glDeleteProgram)(GLuint);
    void (*glUseProgram)(GLuint);
    GLint (*glGetUniformLocation)(GLuint, const char *);
    GLint (*glGetAttribLocation)(GLuint, const char *);
    void (*glGetActiveUniform)(GLuint, GLuint, GLsizei, GLsizei *, GLint *, GLenum *, char *);
    void (*glUniform1f)(GLint, GLfloat);
    void (*glUniform1i)(GLint, GLint);
    void (*glUniform4f)(GLint, GLfloat, GLfloat, GLfloat, GLfloat);
    void (*glUniformMatrix4fv)(GLint, GLsizei, GLboolean, const GLfloat *);
    void (*glVertexAttribPointer)(GLuint, GLint, GLenum, GLboolean, GLsizei, const void *);
    void (*glEnableVertexAttribArray)(GLuint);
    void (*glDisableVertexAttribArray)(GLuint);
    void (*glVertexAttrib3f)(GLuint, GLfloat, GLfloat, GLfloat);
    void (*glVertexAttrib2f)(GLuint, GLfloat, GLfloat);
    void (*glActiveTexture)(GLenum);
    void (*glGenTextures)(GLsizei, GLuint *);
    void (*glBindTexture)(GLenum, GLuint);
    void (*glTexImage2D)(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void *);
    void (*glTexSubImage2D)(GLenum, GLint, GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, const void *);
    void (*glTexParameteri)(GLenum, GLenum, GLint);
    void (*glDeleteTextures)(GLsizei, const GLuint *);
    void (*glPixelStorei)(GLenum, GLint);
    void (*glDrawArrays)(GLenum, GLint, GLsizei);
    void (*glDrawElements)(GLenum, GLsizei, GLenum, const void *);
    void (*glReadPixels)(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void *);
    void (*glFinish)(void);
    unsigned char (*scePigletSetConfigurationVSH)(const void *);
} G;

static void (*g_logfn)(const char *);
static void glog(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
#include <stdarg.h>
static void glog(const char *fmt, ...)
{
    char b[700];
    va_list ap; va_start(ap, fmt);
    vsnprintf(b, sizeof b, fmt, ap);
    va_end(ap);
    if (g_logfn) g_logfn(b);
}
void gpu_set_log(void (*fn)(const char *)) { g_logfn = fn; }

static double now_ms(void)
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000.0 + t.tv_nsec / 1e6;
}

/* ---------------------------------------------------------------- platform: symbols */
typedef struct { char *ident; unsigned char hash[16]; uint64_t len; unsigned char *code; } ShaderBlob;
static ShaderBlob *g_blobs;       /* scePrecompiledShaderEntries, NULL if unavailable */

#ifdef GPU_HOST
#include <dlfcn.h>
static void *h_egl, *h_gl;
static void *sym(const char *n) { void *p = dlsym(h_egl, n); return p ? p : dlsym(h_gl, n); }
static int platform_load(char *err, size_t en)
{
    h_egl = dlopen("libEGL.so.1", RTLD_NOW | RTLD_GLOBAL);
    h_gl = dlopen("libGLESv2.so.2", RTLD_NOW | RTLD_GLOBAL);
    if (!h_egl || !h_gl) { snprintf(err, en, "host: libEGL / libGLESv2 not found"); return -1; }
    return 0;
}
static int screen_release(void) { return 0; }
static int screen_restore(void) { return 0; }
#else
#include <orbis/libkernel.h>
static int h_piglet = -1, h_shaders = -1;
static void *sym(const char *n)
{
    void *p = NULL;
    if (h_piglet >= 0 && sceKernelDlsym(h_piglet, n, &p) == 0 && p) return p;
    return NULL;
}
static int load_mod(const char *name)
{
    char path[256];
    const char *word = sceKernelGetFsSandboxRandomWord();
    int h = -1, mret = 0;
    if (word && word[0]) { snprintf(path, sizeof path, "/%s/common/lib/%s", word, name); h = (int)sceKernelLoadStartModule(path, 0, NULL, 0, NULL, &mret); }
    if (h < 0) { snprintf(path, sizeof path, "/system/common/lib/%s", name); h = (int)sceKernelLoadStartModule(path, 0, NULL, 0, NULL, &mret); }
    glog("GPU: load %s -> 0x%08x (module_start returned %d)", name, (unsigned)h, mret);
    return h;
}
/* v1.33: the Piglet that working PS4 homebrew uses is the 4.74 dev-kit build together with
 * the shader compiler libSceShaccVSH (the pair RetroArch and the SM64 port ship). Firmware
 * 6.72 has no shader compiler of its own. The pair is looked for in
 * /data/self/system/common/lib and /app0/sce_module BEFORE the console's own Piglet; the
 * console's copy is only used when the pair is not there. Same order as the SM64 port:
 * a few system libraries first, then Piglet, then the compiler. */
static int h_shacc = -1;
static char g_pig_from[96] = "not loaded";
static void load_homebrew_pair(void (*lg)(const char *fmt, ...))
{
    if (h_piglet >= 0) return;
    static const char *dirs[] = { "/data/self/system/common/lib", "/app0/sce_module" };
    static const char *pre[] = { "libSceSysCore", "libSceMbus", "libSceIpmi" };
    char path[300];
    for (int d = 0; d < 2 && h_piglet < 0; d++) {
        snprintf(path, sizeof path, "%s/libScePigletv2VSH.sprx", dirs[d]);
        int fd = open(path, O_RDONLY);
        if (fd < 0) { lg("homebrew Piglet: %s is not there", path); continue; }
        close(fd);
        const char *word = sceKernelGetFsSandboxRandomWord();
        for (int i = 0; i < 3; i++) {
            char sp[200]; int mr = 0;
            snprintf(sp, sizeof sp, "/%s/common/lib/%s.sprx", word && word[0] ? word : "system", pre[i]);
            int h = (int)sceKernelLoadStartModule(sp, 0, NULL, 0, NULL, &mr);
            lg("homebrew Piglet: system library %s -> 0x%08x", pre[i], (unsigned)h);
        }
        int mr = 0;
        lg("-> load %s", path);
        int h = (int)sceKernelLoadStartModule(path, 0, NULL, 0, NULL, &mr);
        lg("<- handle 0x%08x, module_start returned %d", (unsigned)h, mr);
        if (h < 0) continue;
        h_piglet = h;
        snprintf(g_pig_from, sizeof g_pig_from, "%s (homebrew pair)", dirs[d]);
        snprintf(path, sizeof path, "%s/libSceShaccVSH.sprx", dirs[d]);
        mr = 0;
        lg("-> load %s", path);
        h_shacc = (int)sceKernelLoadStartModule(path, 0, NULL, 0, NULL, &mr);
        lg("<- shader compiler handle 0x%08x, module_start returned %d", (unsigned)h_shacc, mr);
    }
}
static int platform_load(char *err, size_t en)
{
    load_homebrew_pair(glog);
    if (h_piglet < 0) { h_piglet = load_mod("libScePigletv2VSH.sprx"); if (h_piglet >= 0) snprintf(g_pig_from, sizeof g_pig_from, "the console's own copy"); }
    glog("GPU: Piglet from %s, shader compiler %s", g_pig_from, h_shacc >= 0 ? "loaded" : "not loaded");
    if (h_piglet < 0) { snprintf(err, en, "the PS4 OpenGL library (Piglet) could not be loaded (0x%08x)", (unsigned)h_piglet); return -1; }
    if (h_shaders < 0) h_shaders = load_mod("libScePrecompiledShaders.sprx");
    void *p = NULL;
    if (h_shaders >= 0 && sceKernelDlsym(h_shaders, "scePrecompiledShaderEntries", &p) == 0) g_blobs = p;
    glog("GPU: precompiled shader table %s", g_blobs ? "found" : "not found");
    return 0;
}
static int screen_release(void) { return gfx_suspend(); }
static int screen_restore(void) { return gfx_resume(); }
#endif

static int load_symbols(char *err, size_t en)
{
    struct { const char *n; void **p; int optional; } t[] = {
#define S(x) { #x, (void **)&G.x, 0 }
#define SO(x) { #x, (void **)&G.x, 1 }
        S(eglGetDisplay), S(eglInitialize), S(eglBindAPI), SO(eglSwapInterval), S(eglChooseConfig), SO(eglGetConfigAttrib),
        SO(eglCreateWindowSurface), SO(eglCreatePbufferSurface), S(eglCreateContext), S(eglMakeCurrent), S(eglSwapBuffers), S(eglGetError),
        SO(eglDestroySurface), SO(eglDestroyContext), SO(eglTerminate),
        S(glGetError), SO(glGetString), S(glViewport), S(glClearColor), S(glClear), S(glEnable), S(glDisable), S(glBlendFunc), SO(glBlendColor),
        SO(glDepthFunc), SO(glDepthMask), S(glCreateShader), SO(glShaderSource), SO(glCompileShader), SO(glGetShaderiv), SO(glGetShaderInfoLog),
        SO(glShaderBinary), SO(glDeleteShader), S(glCreateProgram), S(glAttachShader), S(glLinkProgram), SO(glGetProgramiv), SO(glDeleteProgram),
        S(glUseProgram), S(glGetUniformLocation), S(glGetAttribLocation), SO(glGetActiveUniform), S(glUniform1f), S(glUniform1i), SO(glUniform4f),
        S(glUniformMatrix4fv), S(glVertexAttribPointer), S(glEnableVertexAttribArray), SO(glDisableVertexAttribArray), SO(glVertexAttrib3f),
        SO(glVertexAttrib2f), S(glActiveTexture), S(glGenTextures), S(glBindTexture), S(glTexImage2D), S(glTexSubImage2D), S(glTexParameteri),
        S(glDeleteTextures), SO(glPixelStorei), S(glDrawArrays), SO(glDrawElements), SO(glReadPixels), SO(glFinish),
#ifndef GPU_HOST
        S(scePigletSetConfigurationVSH),
#endif
#undef S
#undef SO
    };
    for (size_t i = 0; i < sizeof t / sizeof t[0]; i++) {
        *t[i].p = sym(t[i].n);
        if (!*t[i].p && !t[i].optional) { snprintf(err, en, "the OpenGL library has no %s", t[i].n); return -1; }
    }
    return 0;
}

/* ---------------------------------------------------------------- state */
#define SW 1920
#define SH 1080
static int g_on, g_tier, g_force, g_depth;
static void *g_dpy, *g_surf, *g_ctx;
static char g_info[200];

typedef struct { GLuint prog; GLint mv, proj, tex, sampler, opacity, a_vertex; } TexmapProg;
typedef struct { GLuint prog; GLint mvp, mv, sampler, base, textured, cutoff, a_pos, a_nrm, a_uv; } ModelProg;
static TexmapProg g_tm;
static ModelProg g_mp;
static GLuint g_fbtex, g_white;
static uint8_t *g_conv;                 /* RGBA copy of the software frame */

static GLuint *g_mtex;                  /* one GL texture per model texture */
static uint8_t *g_mtex_alpha;           /* 1 = has transparent texels */
static int g_nmtex;
static const AsfModel *g_model;

int gpu_active(void) { return g_on; }
int gpu_tier(void) { return g_tier; }
const char *gpu_info(void) { return g_info; }
void gpu_force_tier(int tier) { g_force = tier; }

/* ---------------------------------------------------------------- shaders */
static const char *VS_MODEL =
    "attribute vec3 a_pos;\nattribute vec3 a_nrm;\nattribute vec2 a_uv;\n"
    "uniform mat4 u_mvp;\nuniform mat4 u_mv;\n"
    "varying vec2 v_uv;\nvarying vec3 v_n;\n"
    "void main() {\n"
    "  v_uv = a_uv;\n"
    "  v_n = (u_mv * vec4(a_nrm, 0.0)).xyz;\n"
    "  gl_Position = u_mvp * vec4(a_pos, 1.0);\n"
    "}\n";
static const char *FS_MODEL =
    "precision mediump float;\n"
    "uniform sampler2D s_tex;\nuniform vec4 u_base;\nuniform float u_textured;\nuniform float u_cutoff;\n"
    "varying vec2 v_uv;\nvarying vec3 v_n;\n"
    "void main() {\n"
    "  vec4 c = u_base;\n"
    "  if (u_textured > 0.5) c = texture2D(s_tex, v_uv);\n"
    "  if (c.a < u_cutoff) discard;\n"
    "  float l = length(v_n);\n"
    "  float d = l > 0.001 ? abs(v_n.z) / l : 1.0;\n"      /* light at the camera */
    "  gl_FragColor = vec4(c.rgb * (0.30 + 0.70 * d), 1.0);\n"
    "}\n";
/* Same interface as the system "texmap" shader, so one code path serves both. */
static const char *VS_TEXMAP =
    "attribute vec4 a_vertex;\n"
    "uniform mat4 u_modelViewMatrix;\nuniform mat4 u_projectionMatrix;\nuniform mat4 u_textureSpaceMatrix;\n"
    "varying vec2 v_tc;\n"
    "void main() {\n"
    "  vec4 p = vec4(a_vertex.xy, 0.0, 1.0);\n"
    "  v_tc = (u_textureSpaceMatrix * p).xy;\n"
    "  gl_Position = u_projectionMatrix * u_modelViewMatrix * p;\n"
    "}\n";
static const char *FS_TEXMAP =
    "precision mediump float;\n"
    "uniform sampler2D s_sampler;\nuniform float u_opacity;\n"
    "varying vec2 v_tc;\n"
    "void main() { gl_FragColor = texture2D(s_sampler, v_tc) * u_opacity; }\n";

static GLuint compile_glsl(GLenum type, const char *src, const char *what)
{
    if (!G.glShaderSource || !G.glCompileShader || !G.glGetShaderiv) return 0;
    GLuint s = G.glCreateShader(type);
    if (!s) return 0;
    G.glShaderSource(s, 1, &src, NULL);
    GLenum e1 = G.glGetError();
    G.glCompileShader(s);
    GLenum e2 = G.glGetError();
    GLint ok = 0;
    G.glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (e1 || e2 || !ok) {
        char info[300] = "";
        if (G.glGetShaderInfoLog) G.glGetShaderInfoLog(s, sizeof info - 1, NULL, info);
        glog("GPU: GLSL %s not compiled (source 0x%x, compile 0x%x, status %d) %s", what, e1, e2, ok, info);
        if (G.glDeleteShader) G.glDeleteShader(s);
        while (G.glGetError()) {}
        return 0;
    }
    return s;
}

static GLuint link_prog(GLuint vs, GLuint fs, const char *what)
{
    GLuint p = G.glCreateProgram();
    if (!p) return 0;
    G.glAttachShader(p, vs);
    G.glAttachShader(p, fs);
    G.glLinkProgram(p);
    GLenum e = G.glGetError();
    GLint ok = 1;
    if (G.glGetProgramiv) G.glGetProgramiv(p, GL_LINK_STATUS, &ok);
    if (e || !ok) {
        glog("GPU: %s did not link (0x%x, status %d)", what, e, ok);
        if (G.glDeleteProgram) G.glDeleteProgram(p);
        while (G.glGetError()) {}
        return 0;
    }
    return p;
}

static void log_uniforms(GLuint p, const char *what, int *samplers)
{
    char line[600];
    int o = snprintf(line, sizeof line, "GPU: %s uniforms:", what);
    GLint n = 0;
    *samplers = 0;
    if (G.glGetProgramiv && G.glGetActiveUniform) {
        G.glGetProgramiv(p, GL_ACTIVE_UNIFORMS, &n);
        for (GLint i = 0; i < n && i < 32; i++) {
            char name[64] = "";
            GLint size = 0; GLenum type = 0;
            G.glGetActiveUniform(p, (GLuint)i, sizeof name - 1, NULL, &size, &type, name);
            if (type == GL_SAMPLER_2D) (*samplers)++;
            if (o < (int)sizeof line - 80) o += snprintf(line + o, sizeof line - o, " %s", name);
        }
    } else *samplers = 1;
    while (G.glGetError()) {}
    glog("%s", line);
}

static int texmap_locate(TexmapProg *t, const char *what)
{
    int samplers = 0;
    log_uniforms(t->prog, what, &samplers);
    t->mv = G.glGetUniformLocation(t->prog, "u_modelViewMatrix");
    t->proj = G.glGetUniformLocation(t->prog, "u_projectionMatrix");
    t->tex = G.glGetUniformLocation(t->prog, "u_textureSpaceMatrix");
    t->sampler = G.glGetUniformLocation(t->prog, "s_sampler");
    t->opacity = G.glGetUniformLocation(t->prog, "u_opacity");
    t->a_vertex = G.glGetAttribLocation(t->prog, "a_vertex");
    while (G.glGetError()) {}
    return t->mv >= 0 && t->proj >= 0 && t->tex >= 0 && t->sampler >= 0 && t->a_vertex >= 0 && samplers == 1;
}

static const ShaderBlob *blob_find(const char *name)
{
    if (!g_blobs) return NULL;
    for (const ShaderBlob *b = g_blobs; b->ident; b++) if (!strcmp(b->ident, name)) return b;
    return NULL;
}

/* The system texmap shader: variant 2 is the plain "texture * opacity" one in the sample;
 * other variants are tried until one has exactly the uniforms we need. */
static int texmap_from_system(void)
{
    if (!g_blobs || !G.glShaderBinary) return 0;
    int count = 0;
    for (const ShaderBlob *b = g_blobs; b->ident; b++) count++;
    glog("GPU: %d precompiled system shaders", count);
    static const int order[] = { 2, 0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31 };
    for (size_t k = 0; k < sizeof order / sizeof order[0]; k++) {
        char vn[40], fn[40];
        snprintf(vn, sizeof vn, "texmap/v_%d.vert", order[k]);
        snprintf(fn, sizeof fn, "texmap/f_%d.frag", order[k]);
        const ShaderBlob *v = blob_find(vn), *f = blob_find(fn);
        if (!v || !f) continue;
        GLuint vs = G.glCreateShader(GL_VERTEX_SHADER), fs = G.glCreateShader(GL_FRAGMENT_SHADER);
        if (!vs || !fs) return 0;
        G.glShaderBinary(1, &vs, 0, v->code, (GLsizei)v->len);
        GLenum e1 = G.glGetError();
        G.glShaderBinary(1, &fs, 0, f->code, (GLsizei)f->len);
        GLenum e2 = G.glGetError();
        GLuint p = (e1 || e2) ? 0 : link_prog(vs, fs, vn);
        if (G.glDeleteShader) { G.glDeleteShader(vs); G.glDeleteShader(fs); }
        while (G.glGetError()) {}
        if (!p) { glog("GPU: %s / %s rejected (0x%x 0x%x)", vn, fn, e1, e2); continue; }
        TexmapProg t = { 0 };
        t.prog = p;
        if (texmap_locate(&t, vn)) { g_tm = t; glog("GPU: using system shader %s + %s", vn, fn); return 1; }
        if (G.glDeleteProgram) G.glDeleteProgram(p);
    }
    return 0;
}

static int build_shaders(void)
{
    g_tier = GPU_TIER_NONE;
    if (g_force != GPU_TIER_SYSTEM) {
        GLuint vs = compile_glsl(GL_VERTEX_SHADER, VS_MODEL, "model vertex shader");
        GLuint fs = vs ? compile_glsl(GL_FRAGMENT_SHADER, FS_MODEL, "model fragment shader") : 0;
        GLuint vt = fs ? compile_glsl(GL_VERTEX_SHADER, VS_TEXMAP, "screen vertex shader") : 0;
        GLuint ft = vt ? compile_glsl(GL_FRAGMENT_SHADER, FS_TEXMAP, "screen fragment shader") : 0;
        if (ft) {
            GLuint pm = link_prog(vs, fs, "model program"), pt = pm ? link_prog(vt, ft, "screen program") : 0;
            if (pt) {
                g_mp.prog = pm;
                g_mp.mvp = G.glGetUniformLocation(pm, "u_mvp"); g_mp.mv = G.glGetUniformLocation(pm, "u_mv");
                g_mp.sampler = G.glGetUniformLocation(pm, "s_tex"); g_mp.base = G.glGetUniformLocation(pm, "u_base");
                g_mp.textured = G.glGetUniformLocation(pm, "u_textured"); g_mp.cutoff = G.glGetUniformLocation(pm, "u_cutoff");
                g_mp.a_pos = G.glGetAttribLocation(pm, "a_pos"); g_mp.a_nrm = G.glGetAttribLocation(pm, "a_nrm"); g_mp.a_uv = G.glGetAttribLocation(pm, "a_uv");
                g_tm.prog = pt;
                if (texmap_locate(&g_tm, "screen program") && g_mp.mvp >= 0 && g_mp.a_pos >= 0 && G.glDrawElements && G.glUniform4f && G.glVertexAttrib3f) {
                    g_tier = GPU_TIER_GLSL;
                    glog("GPU: GLSL shaders compiled on the console");
                    return 0;
                }
            }
        }
        glog("GPU: GLSL shaders not available, trying the system shader");
    }
#ifdef GPU_HOST
    {   /* host stand-in for the precompiled binary: the same interface, compiled from source */
        GLuint vt = compile_glsl(GL_VERTEX_SHADER, VS_TEXMAP, "texmap vs"), ft = compile_glsl(GL_FRAGMENT_SHADER, FS_TEXMAP, "texmap fs");
        GLuint pt = vt && ft ? link_prog(vt, ft, "texmap") : 0;
        if (pt) { g_tm.prog = pt; if (texmap_locate(&g_tm, "texmap (host)")) { g_tier = GPU_TIER_SYSTEM; return 0; } }
    }
#else
    if (texmap_from_system()) { g_tier = GPU_TIER_SYSTEM; return 0; }
#endif
    return -1;
}

/* ---------------------------------------------------------------- matrices (column-major) */
typedef struct { float m[16]; } M4;
static M4 m4_identity(void) { M4 r = { { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 } }; return r; }
static M4 m4_mul(const M4 *a, const M4 *b)
{
    M4 r;
    for (int c = 0; c < 4; c++)
        for (int rr = 0; rr < 4; rr++)
            r.m[c * 4 + rr] = a->m[rr] * b->m[c * 4] + a->m[4 + rr] * b->m[c * 4 + 1] + a->m[8 + rr] * b->m[c * 4 + 2] + a->m[12 + rr] * b->m[c * 4 + 3];
    return r;
}

/* The same camera as r3d.c. *radius_out = bounding radius. */
static void camera(const AsfModel *m, const R3dView *v, M4 *mv, M4 *proj)
{
    float cx = (m->mn[0] + m->mx[0]) * .5f, cy = (m->mn[1] + m->mx[1]) * .5f, cz = (m->mn[2] + m->mx[2]) * .5f;
    float ex = m->mx[0] - m->mn[0], ey = m->mx[1] - m->mn[1], ez = m->mx[2] - m->mn[2];
    float radius = .5f * sqrtf(ex * ex + ey * ey + ez * ez);
    if (!(radius > 1e-6f)) radius = 1.f;
    float zoom = v->zoom > 0.05f ? v->zoom : 0.05f;
    const float fov = 0.75f;
    float dist = radius / sinf(fov * .5f) / zoom;
    float cyw = cosf(v->yaw), syw = sinf(v->yaw), cp = cosf(v->pitch), sp = sinf(v->pitch);
    /* rows of the rotation R = Rx(pitch) * Ry(yaw):  x1 = cyw x + syw z;  z1 = -syw x + cyw z;
     * y2 = cp y - sp z1;  z2 = sp y + cp z1 */
    float r00 = cyw, r01 = 0, r02 = syw;
    float r10 = sp * syw, r11 = cp, r12 = -sp * cyw;
    float r20 = -cp * syw, r21 = sp, r22 = cp * cyw;
    float tx = -(r00 * cx + r01 * cy + r02 * cz) - v->pan_x * radius;
    float ty = -(r10 * cx + r11 * cy + r12 * cz) - v->pan_y * radius;
    float tz = -(r20 * cx + r21 * cy + r22 * cz) - dist;
    M4 a = { { r00, r10, r20, 0, r01, r11, r21, 0, r02, r12, r22, 0, tx, ty, tz, 1 } };
    *mv = a;
    float nearp = dist - 1.5f * radius, farp = dist + 3.f * radius;
    if (nearp < radius * 0.02f) nearp = radius * 0.02f;
    float f = 1.f / tanf(fov * .5f), aspect = (float)SW / SH;
    M4 p = { { f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (farp + nearp) / (nearp - farp), -1, 0, 0, 2 * farp * nearp / (nearp - farp), 0 } };
    *proj = p;
}

/* ---------------------------------------------------------------- textures */
static GLuint tex_new(int w, int h, const uint8_t *rgba, int repeat)
{
    GLuint t = 0;
    G.glGenTextures(1, &t);
    G.glBindTexture(GL_TEXTURE_2D, t);
    G.glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, rgba);
    G.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    G.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    int pot = !(w & (w - 1)) && !(h & (h - 1));
    G.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, repeat && pot ? GL_REPEAT : GL_CLAMP_TO_EDGE);
    G.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, repeat && pot ? GL_REPEAT : GL_CLAMP_TO_EDGE);
    GLenum e = G.glGetError();
    if (e) { glog("GPU: texture %dx%d failed (0x%x)", w, h, e); while (G.glGetError()) {} }
    return t;
}

void gpu_model_free(void)
{
    if (g_on && g_nmtex) G.glDeleteTextures(g_nmtex, g_mtex);
    free(g_mtex); free(g_mtex_alpha);
    g_mtex = NULL; g_mtex_alpha = NULL; g_nmtex = 0; g_model = NULL;
}

int gpu_model_upload(const AsfModel *m)
{
    gpu_model_free();
    if (!g_on) return -1;
    g_model = m;
    if (!m->ntex) return 0;
    g_mtex = calloc((size_t)m->ntex, sizeof *g_mtex);
    g_mtex_alpha = calloc((size_t)m->ntex, 1);
    if (!g_mtex || !g_mtex_alpha) { gpu_model_free(); return -1; }
    g_nmtex = m->ntex;
    for (int i = 0; i < m->ntex; i++) {
        const AsfTex *t = &m->tex[i];
        size_t n = (size_t)t->w * t->h, transp = 0;
        for (size_t k = 0; k < n; k++) transp += t->rgba[k * 4 + 3] < 250;
        g_mtex_alpha[i] = transp * 200 > n;
        if (g_tier == GPU_TIER_SYSTEM) {       /* premultiplied: the shade is applied by the blend colour */
            uint8_t *pm = malloc(n * 4);
            if (!pm) continue;
            for (size_t k = 0; k < n; k++) {
                unsigned a = t->rgba[k * 4 + 3];
                pm[k * 4] = (uint8_t)(t->rgba[k * 4] * a / 255); pm[k * 4 + 1] = (uint8_t)(t->rgba[k * 4 + 1] * a / 255);
                pm[k * 4 + 2] = (uint8_t)(t->rgba[k * 4 + 2] * a / 255); pm[k * 4 + 3] = (uint8_t)a;
            }
            g_mtex[i] = tex_new((int)t->w, (int)t->h, pm, 1);
            free(pm);
        } else g_mtex[i] = tex_new((int)t->w, (int)t->h, t->rgba, 1);
    }
    return 0;
}

/* ---------------------------------------------------------------- screen quads */
static const GLfloat UNIT_TRI[6] = { 0, 0, 1, 0, 0, 1 };
static const GLfloat UNIT_QUAD[12] = { 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1 };

static void texmap_begin(void)
{
    G.glUseProgram(g_tm.prog);
    G.glActiveTexture(GL_TEXTURE0);
    G.glUniform1i(g_tm.sampler, 0);
    if (g_tm.opacity >= 0) G.glUniform1f(g_tm.opacity, 1.f);
    G.glEnableVertexAttribArray((GLuint)g_tm.a_vertex);
}

/* rows [y0, y0+h) of the software frame -> the same place on screen */
static void draw_fb_rows(const uint32_t *fb, int y0, int h)
{
    const uint32_t *s = fb + (size_t)y0 * SW;
    uint8_t *d = g_conv;
    for (size_t i = 0; i < (size_t)SW * h; i++) { uint32_t p = s[i]; d[i * 4] = (uint8_t)(p >> 16); d[i * 4 + 1] = (uint8_t)(p >> 8); d[i * 4 + 2] = (uint8_t)p; d[i * 4 + 3] = 255; }
    G.glBindTexture(GL_TEXTURE_2D, g_fbtex);
    G.glTexSubImage2D(GL_TEXTURE_2D, 0, 0, y0, SW, h, GL_RGBA, GL_UNSIGNED_BYTE, g_conv);
    float fy = (float)y0 / SH, fh = (float)h / SH;
    /* unit square -> clip space: x in [-1,1], rows from the top */
    M4 mv = { { 2, 0, 0, 0, 0, -2 * fh, 0, 0, 0, 0, 1, 0, -1, 1 - 2 * fy, 0, 1 } };
    M4 id = m4_identity();
    M4 tm = { { 1, 0, 0, 0, 0, fh, 0, 0, 0, 0, 1, 0, 0, fy, 0, 1 } };
    G.glUniformMatrix4fv(g_tm.mv, 1, 0, mv.m);
    G.glUniformMatrix4fv(g_tm.proj, 1, 0, id.m);
    G.glUniformMatrix4fv(g_tm.tex, 1, 0, tm.m);
    G.glVertexAttribPointer((GLuint)g_tm.a_vertex, 2, GL_FLOAT, 0, 0, UNIT_QUAD);
    G.glDrawArrays(GL_TRIANGLES, 0, 6);
}

#ifdef GPU_HOST
void gpu_host_swapped(void) __attribute__((weak));
#endif
static unsigned g_swap_errors;
static void swap(void)
{
#ifdef GPU_HOST
    if (gpu_host_swapped) gpu_host_swapped();
#endif
    if (!G.eglSwapBuffers(g_dpy, g_surf) && g_swap_errors++ < 3) glog("GPU: eglSwapBuffers failed (0x%x)", G.eglGetError());
}

#ifdef GPU_HOST
static uint8_t *g_host_frame;
void gpu_host_read(uint8_t *rgba) { if (g_host_frame) memcpy(rgba, g_host_frame, (size_t)SW * SH * 4); }
static void host_grab(void)
{
    if (!g_host_frame) g_host_frame = malloc((size_t)SW * SH * 4);
    if (g_host_frame && G.glReadPixels) G.glReadPixels(0, 0, SW, SH, GL_RGBA, GL_UNSIGNED_BYTE, g_host_frame);
}
#else
static void host_grab(void) {}
#endif

void gpu_present_fb(const uint32_t *fb)
{
    if (!g_on) return;
    G.glViewport(0, 0, SW, SH);
    G.glDisable(GL_BLEND);
    G.glDisable(GL_DEPTH_TEST);
    texmap_begin();
    draw_fb_rows(fb, 0, SH);
    host_grab();
    swap();
}

/* ---------------------------------------------------------------- model */
typedef struct { float z; uint32_t mesh, tri; } SortTri;
static int sort_far_first(const void *a, const void *b)
{
    float x = ((const SortTri *)a)->z, y = ((const SortTri *)b)->z;
    return x < y ? -1 : x > y;        /* view z is negative in front: most negative (farthest) first */
}
static SortTri *g_sort;
static size_t g_sort_cap;
static uint16_t *g_runidx;
static size_t g_runidx_cap;

static float view_z(const M4 *mv, const float *p) { return mv->m[2] * p[0] + mv->m[6] * p[1] + mv->m[10] * p[2] + mv->m[14]; }

/* Collect triangles of the meshes selected by `want_alpha` (-1 = all), far first. */
static size_t collect_sorted(const AsfModel *m, const M4 *mv, int want_alpha)
{
    size_t n = 0, total = 0;
    for (int i = 0; i < m->nmesh; i++) total += m->mesh[i].ni / 3;
    if (total > g_sort_cap) {
        SortTri *t = realloc(g_sort, total * sizeof *t);
        if (!t) return 0;
        g_sort = t; g_sort_cap = total;
    }
    for (int i = 0; i < m->nmesh; i++) {
        const AsfMesh *me = &m->mesh[i];
        int alpha = me->tex >= 0 && me->tex < g_nmtex && g_mtex_alpha[me->tex];
        if (want_alpha >= 0 && alpha != want_alpha) continue;
        for (uint32_t k = 0; k + 2 < me->ni; k += 3) {
            float z = view_z(mv, me->pos + me->ind[k] * 3) + view_z(mv, me->pos + me->ind[k + 1] * 3) + view_z(mv, me->pos + me->ind[k + 2] * 3);
            g_sort[n].z = z; g_sort[n].mesh = (uint32_t)i; g_sort[n].tri = k; n++;
        }
    }
    qsort(g_sort, n, sizeof *g_sort, sort_far_first);
    return n;
}

static void bind_mesh_tex(const AsfMesh *me, int textured, int *has_tex)
{
    *has_tex = textured && me->uv && me->tex >= 0 && me->tex < g_nmtex && g_mtex[me->tex];
    G.glBindTexture(GL_TEXTURE_2D, *has_tex ? g_mtex[me->tex] : g_white);
}

/* --- GLSL tier: one draw per mesh (or per run of sorted triangles) --- */
static void glsl_mesh_setup(const AsfMesh *me, int textured)
{
    int has;
    bind_mesh_tex(me, textured, &has);
    G.glUniform1f(g_mp.textured, has ? 1.f : 0.f);
    G.glVertexAttribPointer((GLuint)g_mp.a_pos, 3, GL_FLOAT, 0, 0, me->pos);
    if (g_mp.a_nrm >= 0) {
        if (me->nrm) { G.glEnableVertexAttribArray((GLuint)g_mp.a_nrm); G.glVertexAttribPointer((GLuint)g_mp.a_nrm, 3, GL_FLOAT, 0, 0, me->nrm); }
        else { if (G.glDisableVertexAttribArray) G.glDisableVertexAttribArray((GLuint)g_mp.a_nrm); G.glVertexAttrib3f((GLuint)g_mp.a_nrm, 0, 0, 0); }
    }
    if (g_mp.a_uv >= 0) {
        if (me->uv) { G.glEnableVertexAttribArray((GLuint)g_mp.a_uv); G.glVertexAttribPointer((GLuint)g_mp.a_uv, 2, GL_FLOAT, 0, 0, me->uv); }
        else { if (G.glDisableVertexAttribArray) G.glDisableVertexAttribArray((GLuint)g_mp.a_uv); if (G.glVertexAttrib2f) G.glVertexAttrib2f((GLuint)g_mp.a_uv, 0, 0); }
    }
}

static uint32_t draw_glsl(const AsfModel *m, const R3dView *v, const M4 *mv, const M4 *proj)
{
    uint32_t calls = 0;
    M4 mvp = m4_mul(proj, mv);
    G.glUseProgram(g_mp.prog);
    G.glDisable(GL_BLEND);
    G.glActiveTexture(GL_TEXTURE0);
    if (g_mp.sampler >= 0) G.glUniform1i(g_mp.sampler, 0);
    G.glUniformMatrix4fv(g_mp.mvp, 1, 0, mvp.m);
    if (g_mp.mv >= 0) G.glUniformMatrix4fv(g_mp.mv, 1, 0, mv->m);
    if (g_mp.base >= 0) G.glUniform4f(g_mp.base, 0.78f, 0.70f, 0.59f, 1.f);
    if (g_mp.cutoff >= 0) G.glUniform1f(g_mp.cutoff, 0.5f);
    G.glEnableVertexAttribArray((GLuint)g_mp.a_pos);
    if (g_depth) {
        for (int i = 0; i < m->nmesh; i++) {
            const AsfMesh *me = &m->mesh[i];
            glsl_mesh_setup(me, v->textured);
            G.glDrawElements(GL_TRIANGLES, (GLsizei)me->ni, GL_UNSIGNED_SHORT, me->ind);
            calls++;
        }
    } else {            /* no depth buffer: far-to-near, in runs of the same mesh */
        size_t n = collect_sorted(m, mv, -1);
        if (n * 3 > g_runidx_cap) { uint16_t *t = realloc(g_runidx, n * 3 * 2); if (!t) return 0; g_runidx = t; g_runidx_cap = n * 3; }
        for (size_t a = 0; a < n;) {
            size_t b = a, o = 0;
            const AsfMesh *me = &m->mesh[g_sort[a].mesh];
            while (b < n && g_sort[b].mesh == g_sort[a].mesh) { memcpy(g_runidx + o, me->ind + g_sort[b].tri, 6); o += 3; b++; }
            glsl_mesh_setup(me, v->textured);
            G.glDrawElements(GL_TRIANGLES, (GLsizei)o, GL_UNSIGNED_SHORT, g_runidx);
            calls++;
            a = b;
        }
    }
    if (G.glDisableVertexAttribArray) {
        G.glDisableVertexAttribArray((GLuint)g_mp.a_pos);
        if (g_mp.a_nrm >= 0) G.glDisableVertexAttribArray((GLuint)g_mp.a_nrm);
        if (g_mp.a_uv >= 0) G.glDisableVertexAttribArray((GLuint)g_mp.a_uv);
    }
    return calls;
}

/* --- system-shader tier: one draw per triangle --- */
static void sys_triangle(const AsfMesh *me, uint32_t k, const M4 *mv, int has_tex)
{
    const float *A = me->pos + me->ind[k] * 3, *B = me->pos + me->ind[k + 1] * 3, *C = me->pos + me->ind[k + 2] * 3;
    float ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], wx = C[0] - A[0], wy = C[1] - A[1], wz = C[2] - A[2];
    float nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    M4 tri = { { ux, uy, uz, 0, wx, wy, wz, 0, nx, ny, nz, 0, A[0], A[1], A[2], 1 } };
    M4 mvt = m4_mul(mv, &tri);
    /* shade: view-space face normal against the direction to the eye (as r3d.c) */
    float vnx = mvt.m[8], vny = mvt.m[9], vnz = mvt.m[10];
    float ex = -(mvt.m[12] + (mvt.m[0] + mvt.m[4]) / 3), ey = -(mvt.m[13] + (mvt.m[1] + mvt.m[5]) / 3), ez = -(mvt.m[14] + (mvt.m[2] + mvt.m[6]) / 3);
    float nl = sqrtf(vnx * vnx + vny * vny + vnz * vnz), el = sqrtf(ex * ex + ey * ey + ez * ez);
    if (nl <= 0) return;                                    /* degenerate */
    float shade = el > 0 ? 0.30f + 0.70f * fabsf(vnx * ex + vny * ey + vnz * ez) / (nl * el) : 1.f;
    M4 tm = { { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0.5f, 0.5f, 0, 1 } };
    if (has_tex) {
        const float *ta = me->uv + me->ind[k] * 2, *tb = me->uv + me->ind[k + 1] * 2, *tc = me->uv + me->ind[k + 2] * 2;
        tm.m[0] = tb[0] - ta[0]; tm.m[1] = tb[1] - ta[1]; tm.m[4] = tc[0] - ta[0]; tm.m[5] = tc[1] - ta[1]; tm.m[12] = ta[0]; tm.m[13] = ta[1];
    }
    G.glUniformMatrix4fv(g_tm.mv, 1, 0, mvt.m);
    G.glUniformMatrix4fv(g_tm.tex, 1, 0, tm.m);
    if (G.glBlendColor) G.glBlendColor(shade, shade, shade, 1.f);
    else if (g_tm.opacity >= 0) G.glUniform1f(g_tm.opacity, shade);
    G.glDrawArrays(GL_TRIANGLES, 0, 3);
}

static uint32_t draw_system(const AsfModel *m, const R3dView *v, const M4 *mv, const M4 *proj)
{
    uint32_t calls = 0;
    texmap_begin();
    G.glUniformMatrix4fv(g_tm.proj, 1, 0, proj->m);
    G.glVertexAttribPointer((GLuint)g_tm.a_vertex, 2, GL_FLOAT, 0, 0, UNIT_TRI);
    if (G.glBlendColor) { G.glEnable(GL_BLEND); G.glBlendFunc(GL_CONSTANT_COLOR, GL_ONE_MINUS_SRC_ALPHA); }
    else G.glDisable(GL_BLEND);
    if (g_depth) {
        /* solid meshes first (depth written), then cut-out / transparent ones far-to-near */
        for (int i = 0; i < m->nmesh; i++) {
            const AsfMesh *me = &m->mesh[i];
            int has;
            if (me->tex >= 0 && me->tex < g_nmtex && g_mtex_alpha[me->tex] && G.glBlendColor) continue;
            bind_mesh_tex(me, v->textured, &has);
            for (uint32_t k = 0; k + 2 < me->ni; k += 3) { sys_triangle(me, k, mv, has); calls++; }
        }
        if (G.glBlendColor) {
            size_t n = collect_sorted(m, mv, 1);
            if (G.glDepthMask) G.glDepthMask(0);
            uint32_t last = 0xFFFFFFFFu;
            int has = 0;
            for (size_t a = 0; a < n; a++) {
                const AsfMesh *me = &m->mesh[g_sort[a].mesh];
                if (g_sort[a].mesh != last) { bind_mesh_tex(me, v->textured, &has); last = g_sort[a].mesh; }
                sys_triangle(me, g_sort[a].tri, mv, has); calls++;
            }
            if (G.glDepthMask) G.glDepthMask(1);
        }
    } else {
        size_t n = collect_sorted(m, mv, -1);
        uint32_t last = 0xFFFFFFFFu;
        int has = 0;
        for (size_t a = 0; a < n; a++) {
            const AsfMesh *me = &m->mesh[g_sort[a].mesh];
            if (g_sort[a].mesh != last) { bind_mesh_tex(me, v->textured, &has); last = g_sort[a].mesh; }
            sys_triangle(me, g_sort[a].tri, mv, has); calls++;
        }
    }
    return calls;
}

void gpu_model_draw(const AsfModel *m, const R3dView *v, const uint32_t *hud_fb, int top_h, int bot_h, double *ms, uint32_t *draw_calls)
{
    if (!g_on) return;
    double t0 = now_ms();
    M4 mv, proj;
    camera(m, v, &mv, &proj);
    G.glViewport(0, 0, SW, SH);
    G.glClearColor(0.045f, 0.06f, 0.10f, 1.f);
    if (g_depth) { G.glEnable(GL_DEPTH_TEST); if (G.glDepthFunc) G.glDepthFunc(GL_LEQUAL); if (G.glDepthMask) G.glDepthMask(1); }
    G.glClear(GL_COLOR_BUFFER_BIT | (g_depth ? GL_DEPTH_BUFFER_BIT : 0));
    uint32_t calls = g_tier == GPU_TIER_GLSL ? draw_glsl(m, v, &mv, &proj) : draw_system(m, v, &mv, &proj);
    /* HUD strips from the software frame */
    G.glDisable(GL_DEPTH_TEST);
    G.glDisable(GL_BLEND);
    texmap_begin();
    if (hud_fb && top_h > 0) draw_fb_rows(hud_fb, 0, top_h);
    if (hud_fb && bot_h > 0) draw_fb_rows(hud_fb, SH - bot_h, bot_h);
    if (G.glFinish && ms) G.glFinish();
    if (ms) *ms = now_ms() - t0;
    if (draw_calls) *draw_calls = calls;
    GLenum e = G.glGetError();
    static unsigned logged;
    if (e && logged++ < 5) glog("GPU: GL error 0x%x while drawing", e);
    host_grab();
    swap();
}

/* ---------------------------------------------------------------- start */
static void teardown(void)
{
    if (g_dpy) {
        G.eglMakeCurrent(g_dpy, NULL, NULL, NULL);
        if (g_surf && G.eglDestroySurface) G.eglDestroySurface(g_dpy, g_surf);
        if (g_ctx && G.eglDestroyContext) G.eglDestroyContext(g_dpy, g_ctx);
        if (G.eglTerminate) G.eglTerminate(g_dpy);
    }
    g_dpy = g_surf = g_ctx = NULL;
}

int gpu_start(char *err, size_t en)
{
    if (g_on) return 0;
    err[0] = 0;
    if (platform_load(err, en) != 0 || load_symbols(err, en) != 0) { glog("GPU: %s", err); return -1; }
    if (!g_conv) g_conv = malloc((size_t)SW * SH * 4);
    if (!g_conv) { snprintf(err, en, "out of memory"); return -1; }

    int rel = screen_release();
    if (rel != 0) { snprintf(err, en, "could not hand the screen over (0x%08x)", (unsigned)rel); glog("GPU: %s", err); return -1; }
    const char *step = "";
#ifndef GPU_HOST
    /* Piglet memory budgets: first the small set other PS4 homebrew uses (RetroArch,
     * liborbis), then the large set from the OpenOrbis sample. v1.22 only tried the
     * large one and eglGetDisplay returned nothing on firmware 6.72. */
    static const uint64_t sets[3][5] = {
        { 0x1000000ull, 0x3000000ull, 0xFFFFFFFFull, 0x100000u, 0x1000000u },   /* SM64 port (4.74 pair) */
        { 0x200000ull, 0x2400000ull, 0xAA00000ull, 0xC0000u, 0x10000u },
        { 250ull << 20, 512ull << 20, 170ull << 20, 1u << 20, 1u << 20 } };
    g_dpy = NULL;
    for (int a = 0; a < 3 && !g_dpy; a++) {
        uint8_t cfg[0x88];
        memset(cfg, 0, sizeof cfg);
        uint32_t u32; uint64_t u64;
#define P32(off, v) (u32 = (v), memcpy(cfg + (off), &u32, 4))
#define P64(off, v) (u64 = (v), memcpy(cfg + (off), &u64, 8))
        P32(0x00, 0x88); P32(0x04, 0x8 | 0x80 | 0x60); cfg[0x08] = 1;
        P64(0x18, sets[a][0]); P64(0x28, sets[a][1]); P64(0x30, sets[a][2]);
        P32(0x40, SW); P32(0x44, SH); P32(0x48, 0); P32(0x4C, 0);
        P32(0x54, (uint32_t)sets[a][3]); P32(0x58, (uint32_t)sets[a][4]); P32(0x5C, 2);
#undef P32
#undef P64
        unsigned ok = G.scePigletSetConfigurationVSH(cfg);
        g_dpy = ok ? G.eglGetDisplay(NULL) : NULL;
        glog("GPU: memory set %d (video %llu MB): configure %s, display %s (EGL 0x%04x)", a + 1,
             (unsigned long long)(sets[a][1] >> 20), ok ? "ok" : "refused", g_dpy ? "ok" : "none", G.eglGetError ? (unsigned)G.eglGetError() : 0u);
    }
#else
    g_dpy = G.eglGetDisplay(NULL);
#endif
    if (!g_dpy) { step = "eglGetDisplay"; goto fail; }
    int major = 0, minor = 0;
    if (!G.eglInitialize(g_dpy, &major, &minor)) { step = "eglInitialize"; goto fail; }
    if (!G.eglBindAPI(EGL_OPENGL_ES_API)) { step = "eglBindAPI"; goto fail; }
    void *config = NULL;
    int ncfg = 0;
    g_depth = 0;
    int first_depth = 16;
#ifdef GPU_HOST
    if (getenv("GPU_NODEPTH")) first_depth = 0;
#endif
    for (int depth = first_depth; depth >= 0 && !ncfg; depth -= 16) {
        const int attribs[] = { EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_DEPTH_SIZE, depth, EGL_STENCIL_SIZE, 0,
                                EGL_SAMPLE_BUFFERS, 0, EGL_SAMPLES, 0, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_SURFACE_TYPE,
#ifdef GPU_HOST
                                EGL_PBUFFER_BIT,
#else
                                EGL_WINDOW_BIT,
#endif
                                EGL_NONE };
        if (!G.eglChooseConfig(g_dpy, attribs, &config, 1, &ncfg)) ncfg = 0;
        if (ncfg) g_depth = depth;
    }
    if (!ncfg) { step = "eglChooseConfig"; goto fail; }
    if (G.eglGetConfigAttrib && first_depth) { int d = 0; if (G.eglGetConfigAttrib(g_dpy, config, EGL_DEPTH_SIZE, &d)) g_depth = d; }
#ifdef GPU_HOST
    {
        const int pb[] = { EGL_WIDTH, SW, EGL_HEIGHT, SH, EGL_NONE };
        g_surf = G.eglCreatePbufferSurface ? G.eglCreatePbufferSurface(g_dpy, config, pb) : NULL;
    }
#else
    {
        static uint32_t window[4] = { 0, SW, SH, 0 };
        const int wa[] = { EGL_RENDER_BUFFER, EGL_BACK_BUFFER, EGL_NONE };
        g_surf = G.eglCreateWindowSurface ? G.eglCreateWindowSurface(g_dpy, config, window, wa) : NULL;
    }
#endif
    if (!g_surf) { step = "eglCreateWindowSurface"; goto fail; }
    {
        const int ca[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
        g_ctx = G.eglCreateContext(g_dpy, config, NULL, ca);
    }
    if (!g_ctx) { step = "eglCreateContext"; goto fail; }
    if (!G.eglMakeCurrent(g_dpy, g_surf, g_surf, g_ctx)) { step = "eglMakeCurrent"; goto fail; }
    if (G.eglSwapInterval && !G.eglSwapInterval(g_dpy, 1)) G.eglSwapInterval(g_dpy, 0);
    glog("GPU: EGL %d.%d, depth %d, %s / %s / %s", major, minor, g_depth,
         G.glGetString ? (const char *)G.glGetString(GL_VERSION) : "?", G.glGetString ? (const char *)G.glGetString(GL_VENDOR) : "?",
         G.glGetString ? (const char *)G.glGetString(GL_RENDERER) : "?");
    while (G.glGetError()) {}
    if (build_shaders() != 0) { step = "shaders (neither GLSL nor a usable system shader)"; goto fail; }
    if (G.glPixelStorei) G.glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    memset(g_conv, 0, (size_t)SW * SH * 4);
    g_fbtex = tex_new(SW, SH, g_conv, 0);
    {
        static const uint8_t grey[4] = { 199, 178, 150, 255 };
        g_white = tex_new(1, 1, grey, 0);
    }
    if (G.glGetError()) { step = "screen texture"; goto fail; }
    g_on = 1;
    snprintf(g_info, sizeof g_info, "%s, %s", g_tier == GPU_TIER_GLSL ? "GLSL shaders" : "system shader (1 draw per triangle)",
             g_depth ? "depth buffer" : "no depth buffer (sorted)");
    glog("GPU: started - %s", g_info);
    gfx_set_presenter(gpu_present_fb);
    return 0;
fail:
    {
        int ee = G.eglGetError ? G.eglGetError() : 0;
        snprintf(err, en, "GPU start failed at: %s (EGL 0x%x)", step, ee);
        glog("GPU: %s", err);
    }
    teardown();
    {
        int rr = screen_restore();
        if (rr != 0) { glog("GPU: the software screen could not be restored (0x%08x)", (unsigned)rr); return -2; }
    }
    return -1;
}


/* ================================================================ GPU probe
 * Finds out which Piglet set-up the console accepts. Every step is written to the probe
 * file (and flushed to disk) BEFORE it runs, so if the app dies the last line names the
 * call that did it. Variants are tried in order until one gets a working GL context. */
#ifndef GPU_HOST
#include <orbis/Sysmodule.h>
#include <orbis/SystemService.h>
#endif

static FILE *g_pf;
static void (*g_pout)(const char *);
static void pr(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void pr(const char *fmt, ...)
{
    char b[600];
    va_list ap; va_start(ap, fmt);
    vsnprintf(b, sizeof b, fmt, ap);
    va_end(ap);
    if (g_pf) { fprintf(g_pf, "%s\n", b); fflush(g_pf); fsync(fileno(g_pf)); }
    if (g_pout) g_pout(b);
}

/* v1.29: the v1.28 probe showed that an EMPTY configuration gets a display while every
 * filled-in one does not, and that a failed eglGetDisplay leaves nothing behind (later tests
 * in the same run can still succeed). So each test now adds ONE field to the empty
 * configuration. Tests that get no display keep going; the first test that does get a
 * display then tries every way of making a context, and the run stops there (Piglet keeps
 * that display for the rest of the process, so later tests would prove nothing). */
enum { F_SYS = 1, F_VID = 2, F_FLEX = 4, F_DCB = 8, F_LCUE = 16, F_POS = 32, F_U5C = 64, F_FLAGS = 128, F_PORT = 256 };
typedef struct { const char *name; unsigned fields; } PVar;
#define PV_N 10
static const PVar k_var[PV_N] = {
    { "v1.33 homebrew recipe: every field as the SM64 port sets it", F_PORT },
    { "only system shared memory 2 MB (+0x18)", F_SYS },
    { "only video shared memory 36 MB (+0x28)", F_VID },
    { "only flexible-memory flag 0x100 and 170 MB limit (+0x30)", F_FLEX },
    { "only draw command buffer 768 KB (+0x54)", F_DCB },
    { "only LCUE resource buffer 64 KB (+0x58)", F_LCUE },
    { "only screen size 1920x1080 (+0x40/+0x44)", F_POS },
    { "only field +0x5C = 2", F_U5C },
    { "only flags 0x68 and process order 1", F_FLAGS },
    { "empty configuration (control)", 0 },
};
static int g_probe_stop;   /* a display was made: later tests in this process are meaningless */

static void hexline(const char *tag, const uint8_t *p, size_t n)
{
    for (size_t o = 0; o < n; o += 32) {
        char b[120]; int k = 0;
        for (size_t i = o; i < o + 32 && i < n; i++) k += snprintf(b + k, sizeof b - (size_t)k, "%02x%s", p[i], (i & 3) == 3 ? " " : "");
        pr("  %s+%02x: %s", tag, (unsigned)o, b);
    }
}

static void probe_system(void)
{
#ifndef GPU_HOST
    OrbisKernelSwVersion sw; memset(&sw, 0, sizeof sw); sw.Size = sizeof sw;
    pr("-> sceKernelGetSystemSwVersion");
    int r = sceKernelGetSystemSwVersion(&sw);
    pr("system: firmware %s (0x%08x) rc=0x%08x", sw.VersionString, (unsigned)sw.Version, (unsigned)r);
    pr("-> sceKernelIsNeoMode / IsDevKit / GetCpumode");
    pr("system: neo mode (PS4 Pro) = %d, dev kit = %d, cpu mode = %d", sceKernelIsNeoMode(), sceKernelIsDevKit(), sceKernelGetCpumode());
    size_t fl = 0;
    pr("-> sceKernelAvailableFlexibleMemorySize / GetDirectMemorySize");
    r = sceKernelAvailableFlexibleMemorySize(&fl);
    pr("system: flexible memory available %zu MB (rc=0x%08x), direct memory total %zu MB", fl >> 20, (unsigned)r, sceKernelGetDirectMemorySize() >> 20);
    OrbisKernelModule mods[160]; size_t nm = 0;
    pr("-> sceKernelGetModuleList");
    r = sceKernelGetModuleList(mods, 160, &nm);
    pr("modules loaded in this process: %zu (rc=0x%08x)", nm, (unsigned)r);
    for (size_t i = 0; i < nm && i < 160; i++) {
        OrbisKernelModuleInfo mi; memset(&mi, 0, sizeof mi); mi.size = sizeof mi;
        if (sceKernelGetModuleInfo(mods[i], &mi) == 0) pr("  module %2zu: %s", i, mi.name);
    }
#else
    pr("system: host test build");
#endif
}

#ifndef GPU_HOST
static int probe_load(const char *lib, int *mret_out)
{
    const char *word = sceKernelGetFsSandboxRandomWord();
    char path[300];
    const char *fmt[] = { "/%s/common/lib/%s", "/system/common/lib/%s", "/data/self/system/common/lib/%s", "/app0/sce_module/%s" };
    int h = -1;
    for (int i = 0; i < 4 && h < 0; i++) {
        if (i == 0) { if (!word || !word[0]) continue; snprintf(path, sizeof path, fmt[0], word, lib); }
        else snprintf(path, sizeof path, fmt[i], lib);
        int mret = 0;
        pr("-> load %s", path);
        h = (int)sceKernelLoadStartModule(path, 0, NULL, 0, NULL, &mret);
        pr("<- handle 0x%08x, module_start returned %d", (unsigned)h, mret);
        if (mret_out) *mret_out = mret;
    }
    return h;
}
#endif

static int probe_variant(int vi, char *verdict, size_t vn)
{
    const PVar *v = &k_var[vi];
    pr("");
    pr("==== test %d of %d: %s ====", vi + 1, PV_N, v->name);
    snprintf(verdict, vn, "test %d: not run", vi + 1);

    /* function pointers that gpu_start does not need */
    typedef unsigned char (*GetCfg)(void *);
    typedef unsigned char (*GetInt)(int, int *);
    typedef const char *(*QStr)(void *, int);
    typedef unsigned (*GetConfigs)(void *, void **, int, int *);
    typedef void (*GetIv)(unsigned, int *);
    GetCfg get_cfg = (GetCfg)sym("scePigletGetConfigurationVSH");
    GetInt get_int = (GetInt)sym("scePigletGetInteger");
    QStr qstr = (QStr)sym("eglQueryString");
    GetConfigs get_cfgs = (GetConfigs)sym("eglGetConfigs");
    GetIv getiv = (GetIv)sym("glGetIntegerv");
    pr("symbols: GetConfigurationVSH %s, GetInteger %s, eglQueryString %s, eglGetConfigs %s, glGetIntegerv %s",
       get_cfg ? "yes" : "NO", get_int ? "yes" : "NO", qstr ? "yes" : "NO", get_cfgs ? "yes" : "NO", getiv ? "yes" : "NO");

#ifndef GPU_HOST
    size_t fl = 0; sceKernelAvailableFlexibleMemorySize(&fl);
    pr("flexible memory free before this test: %zu MB", fl >> 20);
    {
        int rel = screen_release();
        pr("screen hand-over: 0x%08x", (unsigned)rel);
        if (rel != 0) { snprintf(verdict, vn, "test %d: screen hand-over failed 0x%08x", vi + 1, (unsigned)rel); return -1; }
    }

    uint8_t cfg[0x88]; memset(cfg, 0, sizeof cfg);
    uint32_t u32; uint64_t u64;
#define P32(off, val) (u32 = (val), memcpy(cfg + (off), &u32, 4))
#define P64(off, val) (u64 = (val), memcpy(cfg + (off), &u64, 8))
    P32(0x00, 0x88);
    if (v->fields & F_SYS) P64(0x18, 0x200000ull);
    if (v->fields & F_VID) P64(0x28, 0x2400000ull);
    if (v->fields & F_FLEX) { P32(0x04, 0x100); P64(0x30, 0xAA00000ull); }
    if (v->fields & F_DCB) P32(0x54, 0xC0000);
    if (v->fields & F_LCUE) P32(0x58, 0x10000);
    if (v->fields & F_POS) { P32(0x40, SW); P32(0x44, SH); }
    if (v->fields & F_U5C) P32(0x5C, 2);
    if (v->fields & F_FLAGS) { u32 = 0; memcpy(&u32, cfg + 4, 4); P32(0x04, u32 | 0x68); cfg[0x08] = 1; }
    if (v->fields & F_PORT) {
        P32(0x04, 0x8 | 0x80 | 0x60); cfg[0x08] = 1;
        P64(0x18, 0x1000000ull); P64(0x28, 0x3000000ull); P64(0x30, 0xFFFFFFFFull);
        P32(0x40, SW); P32(0x44, SH); P32(0x48, 0); P32(0x4C, 0);
        P32(0x54, 0x100000); P32(0x58, 0x1000000); P32(0x5C, 2);
    }
#undef P32
#undef P64
    hexline("config sent", cfg, sizeof cfg);
    pr("-> scePigletSetConfigurationVSH");
    unsigned okc = G.scePigletSetConfigurationVSH(cfg);
    pr("<- returned %u (%s)", okc, okc ? "accepted" : "REFUSED");
    if (get_cfg) {
        uint8_t back[0x88]; memset(back, 0, sizeof back); back[0] = 0x88;
        pr("-> scePigletGetConfigurationVSH (size field filled in)");
        unsigned rb = get_cfg(back);
        pr("<- returned %u", rb);
        hexline("config read back", back, sizeof back);
        if (memcmp(back, cfg, sizeof cfg)) pr("  (read-back differs from what was sent: the library changed or ignored values)");
    }
#endif

    pr("-> eglGetDisplay(default)");
    g_dpy = G.eglGetDisplay(NULL);
#ifdef GPU_HOST
    if (getenv("GPU_PROBE_NODISPLAY") && vi < atoi(getenv("GPU_PROBE_NODISPLAY"))) { g_dpy = NULL; pr("(host test: display forced to none)"); }
#endif
    pr("<- display %p, eglGetError 0x%04x", g_dpy, (unsigned)G.eglGetError());
    if (!g_dpy) {
        pr("-> wait 400 ms and ask again");
        usleep(400000);
        g_dpy = G.eglGetDisplay(NULL);
#ifdef GPU_HOST
        if (getenv("GPU_PROBE_NODISPLAY") && vi < atoi(getenv("GPU_PROBE_NODISPLAY"))) g_dpy = NULL;
#endif
        pr("<- display %p, eglGetError 0x%04x", g_dpy, (unsigned)G.eglGetError());
    }
    if (!g_dpy) {
        pr("-> eglGetDisplay((void*)1)");
        g_dpy = G.eglGetDisplay((void *)1);
#ifdef GPU_HOST
        if (getenv("GPU_PROBE_NODISPLAY") && vi < atoi(getenv("GPU_PROBE_NODISPLAY"))) g_dpy = NULL;
#endif
        pr("<- display %p, eglGetError 0x%04x", g_dpy, (unsigned)G.eglGetError());
    }
    if (qstr) {          /* client strings work without a display on most EGL libraries */
        pr("-> eglQueryString(no display)");
        const char *cv = qstr(NULL, 0x3054), *ce = qstr(NULL, 0x3055);
        pr("<- client version \"%s\", client extensions \"%.200s\"", cv ? cv : "(null)", ce ? ce : "(null)");
    }
    if (!g_dpy) {
        snprintf(verdict, vn, "test %d (%s): no display, config %s", vi + 1, v->name,
#ifndef GPU_HOST
                 okc ? "accepted" : "refused"
#else
                 "n/a"
#endif
                 );
        goto done;
    }

    g_probe_stop = 1;
    pr("A DISPLAY WAS MADE. Piglet keeps it for the rest of this run, so this is the last test of the run.");
    int major = 0, minor = 0;
    pr("-> eglInitialize");
    int ie = G.eglInitialize(g_dpy, &major, &minor);
    pr("<- %d, EGL %d.%d, eglGetError 0x%04x", ie, major, minor, (unsigned)G.eglGetError());
    if (!ie) { snprintf(verdict, vn, "test %d (%s): display ok, eglInitialize failed", vi + 1, v->name); goto done; }
    if (qstr) {
        const char *a = qstr(g_dpy, 0x3053), *b = qstr(g_dpy, 0x3054), *c = qstr(g_dpy, 0x3052), *d = qstr(g_dpy, 0x3055);
        pr("EGL vendor \"%s\", version \"%s\", client apis \"%s\"", a ? a : "?", b ? b : "?", c ? c : "?");
        pr("EGL extensions: %.400s", d ? d : "?");
    }
#ifndef GPU_HOST
    if (get_int) for (int q = 0; q <= 6; q++) { int iv = -1; pr("-> scePigletGetInteger(%d)", q); unsigned r = get_int(q, &iv); pr("<- %u, value %d (0x%x)", r, iv, (unsigned)iv); }
#endif
    if (get_cfgs) {
        void *cl[16]; int nc = 0;
        unsigned r = get_cfgs(g_dpy, cl, 16, &nc);
        pr("eglGetConfigs: %u, %d configurations", r, nc);
        for (int i = 0; i < nc && i < 8 && G.eglGetConfigAttrib; i++) {
            int a[8] = { 0 };
            const int id[8] = { EGL_RED_SIZE, EGL_GREEN_SIZE, EGL_BLUE_SIZE, EGL_ALPHA_SIZE, EGL_DEPTH_SIZE, EGL_STENCIL_SIZE, EGL_RENDERABLE_TYPE, EGL_SURFACE_TYPE };
            for (int k = 0; k < 8; k++) G.eglGetConfigAttrib(g_dpy, cl[i], id[k], &a[k]);
            pr("  config %d: rgba %d%d%d%d depth %d stencil %d renderable 0x%x surface 0x%x", i, a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]);
        }
    }

    pr("-> eglBindAPI(OpenGL ES)");
    int ba = G.eglBindAPI(EGL_OPENGL_ES_API);
    pr("<- %d, eglGetError 0x%04x", ba, (unsigned)G.eglGetError());

    void *config = NULL; int ncfg = 0;
    const int attribs[] = { EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_DEPTH_SIZE, 0, EGL_STENCIL_SIZE, 0,
                            EGL_SAMPLE_BUFFERS, 0, EGL_SAMPLES, 0, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_SURFACE_TYPE,
#ifdef GPU_HOST
                            EGL_PBUFFER_BIT,
#else
                            EGL_WINDOW_BIT,
#endif
                            EGL_NONE };
    pr("-> eglChooseConfig (rgba8888, no depth, ES2, window)");
    int cc = G.eglChooseConfig(g_dpy, attribs, &config, 1, &ncfg);
    pr("<- %d, %d configurations, eglGetError 0x%04x", cc, ncfg, (unsigned)G.eglGetError());
    if (!cc || !ncfg) { snprintf(verdict, vn, "test %d (%s): initialize OK, no matching config", vi + 1, v->name); goto done; }

    { const int ca[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
      pr("-> eglCreateContext (ES 2) BEFORE the surface, as RetroArch does");
      g_ctx = G.eglCreateContext(g_dpy, config, NULL, ca);
      pr("<- context %p, eglGetError 0x%04x", g_ctx, (unsigned)G.eglGetError());
      if (!g_ctx) {
          pr("-> eglCreateContext (no attribute list)");
          g_ctx = G.eglCreateContext(g_dpy, config, NULL, NULL);
          pr("<- context %p, eglGetError 0x%04x", g_ctx, (unsigned)G.eglGetError());
      }
    }
    pr("-> eglCreateWindowSurface");
#ifdef GPU_HOST
    { const int pb[] = { EGL_WIDTH, SW, EGL_HEIGHT, SH, EGL_NONE }; g_surf = G.eglCreatePbufferSurface ? G.eglCreatePbufferSurface(g_dpy, config, pb) : NULL; }
#else
    { static uint32_t window[4] = { 0, SW, SH, 0 }; const int wa[] = { EGL_RENDER_BUFFER, EGL_BACK_BUFFER, EGL_NONE };
      g_surf = G.eglCreateWindowSurface ? G.eglCreateWindowSurface(g_dpy, config, window, wa) : NULL; }
#endif
    pr("<- surface %p, eglGetError 0x%04x", g_surf, (unsigned)G.eglGetError());
    if (!g_surf) { snprintf(verdict, vn, "test %d (%s): config ok, window surface failed", vi + 1, v->name); goto done; }

    if (!g_ctx) {
        pr("-> eglCreateContext (ES 2) after the surface");
        const int ca[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE }; g_ctx = G.eglCreateContext(g_dpy, config, NULL, ca);
        pr("<- context %p, eglGetError 0x%04x", g_ctx, (unsigned)G.eglGetError());
    }
    if (!g_ctx) { snprintf(verdict, vn, "test %d (%s): surface ok, context failed", vi + 1, v->name); goto done; }

    pr("-> eglMakeCurrent");
    int mc = G.eglMakeCurrent(g_dpy, g_surf, g_surf, g_ctx);
    pr("<- %d, eglGetError 0x%04x", mc, (unsigned)G.eglGetError());
    if (!mc) { snprintf(verdict, vn, "test %d (%s): context ok, eglMakeCurrent failed", vi + 1, v->name); goto done; }

    if (G.glGetString) {
        const char *gv = (const char *)G.glGetString(GL_VERSION), *gn = (const char *)G.glGetString(GL_VENDOR), *gr = (const char *)G.glGetString(GL_RENDERER);
        const char *gs = (const char *)G.glGetString(0x8B8C), *ge = (const char *)G.glGetString(0x1F03);
        pr("GL version \"%s\", vendor \"%s\", renderer \"%s\"", gv ? gv : "?", gn ? gn : "?", gr ? gr : "?");
        pr("GLSL version \"%s\"", gs ? gs : "(none)");
        pr("GL extensions: %.600s", ge ? ge : "?");
    }
    if (getiv) {
        int mt = 0, mv = 0, mu = 0, mtu = 0, mva = 0;
        getiv(0x0D33, &mt); getiv(0x8DFB, &mv); getiv(0x8DFD, &mu); getiv(0x8872, &mtu); getiv(0x8869, &mva);
        pr("GL limits: texture %d, vertex uniform vectors %d, fragment uniform vectors %d, texture units %d, vertex attributes %d", mt, mv, mu, mtu, mva);
    }
    pr("-> clear to green and swap");
    G.glViewport(0, 0, SW, SH); G.glClearColor(0.f, 0.6f, 0.1f, 1.f); G.glClear(GL_COLOR_BUFFER_BIT);
    int sw = G.eglSwapBuffers(g_dpy, g_surf);
    pr("<- swap %d, eglGetError 0x%04x, glGetError 0x%04x", sw, (unsigned)G.eglGetError(), (unsigned)G.glGetError());
    usleep(1200000);
    snprintf(verdict, vn, "test %d (%s): WORKS - GL context created and a green frame was swapped", vi + 1, v->name);
    pr("RESULT: this set-up works.");
    pr("-> shader check");
    {
        const char *vs = "attribute vec4 p; void main(){ gl_Position = p; }";
        const char *fs = "precision mediump float; void main(){ gl_FragColor = vec4(1.0); }";
        GLuint a = G.glCreateShader(GL_VERTEX_SHADER);
        if (G.glShaderSource && G.glCompileShader && G.glGetShaderiv) {
            G.glShaderSource(a, 1, &vs, NULL); G.glCompileShader(a);
            GLint ok = 0; G.glGetShaderiv(a, GL_COMPILE_STATUS, &ok);
            char lg[300] = "";
            if (G.glGetShaderInfoLog) G.glGetShaderInfoLog(a, sizeof lg - 1, NULL, lg);
            pr("<- GLSL vertex shader compile: %s %.200s", ok ? "OK" : "FAILED", lg);
            GLuint b = G.glCreateShader(GL_FRAGMENT_SHADER);
            G.glShaderSource(b, 1, &fs, NULL); G.glCompileShader(b);
            ok = 0; G.glGetShaderiv(b, GL_COMPILE_STATUS, &ok);
            pr("<- GLSL fragment shader compile: %s", ok ? "OK" : "FAILED");
        } else pr("<- no GLSL compile functions");
    }
    pr("-> precompiled shader table: %s", g_blobs ? "found" : "not found");

done:
    /* v1.28 crashed inside EGL clean-up every time a display existed, so it is skipped:
     * the objects stay alive until the app is restarted. */
    pr("(EGL clean-up skipped on purpose)");
    g_ctx = NULL; g_surf = NULL; g_dpy = NULL;
    int working = strstr(verdict, "WORKS") != NULL;
#ifndef GPU_HOST
    {
        int rr = screen_restore();
        pr("screen restore: 0x%08x", (unsigned)rr);
        if (rr != 0) { pr("THE SOFTWARE SCREEN COULD NOT BE RESTORED - restart the app."); return -2; }
    }
#endif
    return working ? 1 : 0;
}

/* Runs tests first..last in order and stops at the first that works. out gets every line.
 * Returns the number of the working test (1-based), 0 if none, -1 on a setup problem,
 * -2 if the screen could not be restored. summary receives one line per test run. */
static int next_out;
int gpu_probe_next(void) { return next_out; }

#ifndef GPU_HOST
/* What memory this process can get by itself, so a Piglet failure can be compared with it. */
static void probe_memory(void)
{
    typedef int (*AvailDM)(off_t, off_t, size_t, off_t *, size_t *);
    typedef int (*MapSysFlex)(void **, size_t, int, int, const char *);
    pr("");
    pr("---- memory this app can get ----");
    size_t total = sceKernelGetDirectMemorySize(), fl = 0;
    off_t st = 0; size_t sz = 0;
    pr("-> sceKernelAvailableDirectMemorySize");
    int r = ((AvailDM)(void *)sceKernelAvailableDirectMemorySize)(0, (off_t)total, 0, &st, &sz);
    pr("<- 0x%08x: largest free direct block %zu MB at 0x%llx", (unsigned)r, sz >> 20, (unsigned long long)st);
    sceKernelAvailableFlexibleMemorySize(&fl);
    pr("flexible memory free: %zu MB", fl >> 20);
    static const size_t dsz[] = { 2u << 20, 36u << 20, 128u << 20 };
    for (int i = 0; i < 3; i++) {
        off_t ph = 0; void *m = NULL;
        pr("-> sceKernelAllocateDirectMemory %zu MB + map for GPU", dsz[i] >> 20);
        r = sceKernelAllocateDirectMemory(0, (off_t)total, dsz[i], 0x200000, 3, &ph);
        int rm = r < 0 ? r : sceKernelMapDirectMemory(&m, dsz[i], 0x33, 0, ph, 0x200000);
        pr("<- allocate 0x%08x, map 0x%08x", (unsigned)r, (unsigned)rm);
        if (rm == 0 && m) sceKernelMunmap(m, dsz[i]);
        if (r == 0) sceKernelReleaseDirectMemory(ph, dsz[i]);
    }
    {
        off_t ph = 0;
        pr("-> sceKernelAllocateMainDirectMemory 36 MB");
        r = sceKernelAllocateMainDirectMemory(36u << 20, 0x200000, 3, &ph);
        pr("<- 0x%08x", (unsigned)r);
        if (r == 0) sceKernelReleaseDirectMemory(ph, 36u << 20);
    }
    {
        void *m = NULL;
        pr("-> sceKernelMapNamedFlexibleMemory 170 MB");
        r = sceKernelMapNamedFlexibleMemory(&m, 0xAA00000, 3, 0, "probe flex");
        pr("<- 0x%08x", (unsigned)r);
        if (r == 0 && m) sceKernelMunmap(m, 0xAA00000);
    }
    {
        void *m = NULL;
        pr("-> sceKernelMapNamedSystemFlexibleMemory 2 MB");
        r = ((MapSysFlex)(void *)sceKernelMapNamedSystemFlexibleMemory)(&m, 0x200000, 3, 0, "probe sysflex");
        pr("<- 0x%08x", (unsigned)r);
        if (r == 0 && m) sceKernelMunmap(m, 0x200000);
    }
    sceKernelAvailableFlexibleMemorySize(&fl);
    pr("flexible memory free afterwards: %zu MB", fl >> 20);
}
#endif

int gpu_probe(int first, const char *file, void (*out)(const char *), char *summary, size_t sn)
{
    g_pout = out;
    if (first < 1 || first > PV_N) first = 1;
    /* test 1 starts a new file; a later start (the run after a restart) adds to it */
    g_pf = file ? fopen(file, first == 1 ? "w" : "a") : NULL;
    if (first > 1) pr("\n#################### continued after a restart ####################");
    g_probe_stop = 0;
    summary[0] = 0;
    pr("Star Ocean Utility Tool GPU probe");
    pr("Piglet / EGL start-up test. Every line below was saved before the step it names ran.");
    if (g_on) { pr("The GPU renderer is already running - nothing to probe."); if (g_pf) fclose(g_pf); g_pf = NULL; return -1; }
    char err[200] = "";
#ifndef GPU_HOST
    probe_system();
    pr("");
    pr("---- libraries ----");
    int mr = 0;
    load_homebrew_pair(pr);
    int hp = h_piglet >= 0 ? h_piglet : probe_load("libScePigletv2VSH.sprx", &mr);
    if (h_piglet < 0) { h_piglet = hp; if (hp >= 0) snprintf(g_pig_from, sizeof g_pig_from, "the console's own copy"); }
    pr("Piglet handle: 0x%08x", (unsigned)hp);
    pr("PIGLET IN USE: %s. Shader compiler (libSceShaccVSH): %s", g_pig_from, h_shacc >= 0 ? "loaded" : "NOT loaded");
    if (h_shacc < 0) pr("  To use the homebrew pair, put the 4.74 libScePigletv2VSH.sprx (744208 bytes) and libSceShaccVSH.sprx (10394272 bytes) in /data/self/system/common/lib/");
    if (h_shaders < 0) { h_shaders = probe_load("libScePrecompiledShaders.sprx", NULL); void *p = NULL; if (h_shaders >= 0 && sceKernelDlsym(h_shaders, "scePrecompiledShaderEntries", &p) == 0) g_blobs = p; }
    pr("PrecompiledShaders handle: 0x%08x, shader table %s", (unsigned)h_shaders, g_blobs ? "found" : "not found");
    pr("-> sceSysmoduleLoadModuleInternal(SYSTEM_SERVICE)");
    uint32_t sm = sceSysmoduleLoadModuleInternal(ORBIS_SYSMODULE_INTERNAL_SYSTEM_SERVICE);
    pr("<- 0x%08x", (unsigned)sm);
    pr("-> sceSystemServiceHideSplashScreen");
    int hs = sceSystemServiceHideSplashScreen();
    pr("<- 0x%08x", (unsigned)hs);
    if (hp < 0) { pr("The Piglet library could not be loaded, so nothing else can be tested."); if (g_pf) fclose(g_pf); g_pf = NULL; return -1; }
#else
    if (platform_load(err, sizeof err) != 0) { pr("%s", err); if (g_pf) fclose(g_pf); g_pf = NULL; return -1; }
#endif
    if (load_symbols(err, sizeof err) != 0) { pr("symbols: %s", err); if (g_pf) fclose(g_pf); g_pf = NULL; return -1; }
    pr("all required GL/EGL symbols resolved");
#ifndef GPU_HOST
    probe_memory();
#endif

    int result = 0, k = 0;
    next_out = 0;
    for (int i = first - 1; i < PV_N; i++) {
        char vd[240];
        int r = probe_variant(i, vd, sizeof vd);
        if ((size_t)k + 1 < sn) { int w = snprintf(summary + k, sn - (size_t)k, "%s\n", vd); k = (size_t)(k + w) < sn ? k + w : (int)sn - 1; }
        pr("VERDICT: %s", vd);
        if (r == -2) { result = -2; next_out = i + 2; break; }
        if (r == 1) { result = i + 1; break; }
        if (g_probe_stop) { next_out = i + 2; break; }
    }
    if (next_out > PV_N) next_out = 0;
    pr("");
    pr("---- summary ----");
    for (const char *p = summary; *p;) {
        const char *e = strchr(p, '\n');
        int n = e ? (int)(e - p) : (int)strlen(p);
        pr("%.*s", n, p);
        p += n + (e ? 1 : 0);
    }
    pr(result > 0 ? "A working set-up was found: test %d." : "No set-up produced a working GL context in this run.", result);
    if (result <= 0 && next_out) pr("NEXT: restart the app and run the GPU probe again. It will continue at test %d by itself.", next_out);
    else if (result <= 0) pr("All tests have now run. Send this whole file.");
    pr("End of probe.");
    if (g_pf) { fclose(g_pf); g_pf = NULL; }
    return result;
}
int gpu_probe_count(void) { return PV_N; }
