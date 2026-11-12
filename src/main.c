/*
 * Star Ocean Utility Tool - homebrew for jailbroken PS4 (GoldHEN).
 * Developer: Starocean 101
 *
 * File utility: browse internal storage and USB, extract ZIP/RAR/7z archives
 * (to any folder you choose), create ZIP archives from selected files, with a
 * progress bar, a cancel button, a configurable log file, saved settings and
 * toggleable ambient music.
 */
#include <dirent.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <time.h>
#include <unistd.h>

#include <orbis/libkernel.h>
#include <orbis/Pad.h>
#include <orbis/Rtc.h>
#include <orbis/SystemService.h>
#include <orbis/UserService.h>

#include "gfx.h"
#include "audio.h"
#include "log.h"
#include "extract.h"
#include "archive_create.h"
#include "fileops.h"
#include "kbd.h"
#include "cpk.h"
#include "formats.h"
#include "script.h"
#include "sha256.h"
#include "names.h"
#include "asf.h"
#include "aac.h"
#include "at9dec.h"
#include "r3d.h"
#include "text16.h"
#include "gpu.h"
#include <ctype.h>

#define APP_TITLE    "Star Ocean Utility Tool"
#define APP_DEV      "Starocean 101"
#define APP_VERSION  "1.37"
#define APP_DATA     "/data/StarOceanUtility"
#define DEF_LOG      APP_DATA "/log.txt"
#define DEF_EXTRACT  "/data/Extracted"
#define SETTINGS     APP_DATA "/settings.ini"
#define MAX_ENTRIES  4096
#define LIST_ROWS    18

/* ---------- colours ---------- */
#define C_TEXT    RGB(232, 240, 250)
#define C_DIM     RGB(150, 165, 185)
#define C_DIR     RGB(120, 200, 255)
#define C_ARCH    RGB(130, 230, 150)
#define C_IMAGE   RGB(240, 190, 120)
#define C_SEL     RGB(70, 130, 220)
#define C_MARK    RGB(255, 210, 90)
#define C_ACCENT  RGB(90, 180, 255)
#define C_WARN    RGB(255, 190, 70)
#define C_ERR     RGB(255, 95, 95)
#define C_OK      RGB(110, 230, 140)
#define C_PANEL   RGB(14, 20, 38)
#define C_BAR_BG  RGB(40, 50, 75)
#define C_BAR     RGB(70, 170, 255)

#define PANEL(x, y, w, h) gfx_rect_blend(x, y, w, h, C_PANEL, 165) /* nebula shows through */

typedef struct {
    char     name[256];
    int      is_dir;
    int      is_archive;
    int      is_image;   /* by extension: dds png tga bmp */
    uint64_t size;
    char     kind[12];   /* what the file is: Audio, Texture, Model ... ("" = unknown yet) */
    uint16_t rw, rh;     /* picture size, 0 = not known */
    uint8_t  probed;     /* header already looked at */
} Entry;

enum { TAB_FILES, TAB_TOOLS, TAB_CREDITS, TAB_COUNT };
enum { OV_NONE, OV_EXTRACT_MENU, OV_ACTIONS, OV_PROGRESS, OV_DONE, OV_MESSAGE, OV_CONFIRM, OV_KEYBOARD, OV_CPK, OV_CPK_CONFIRM, OV_CPK_VIEW, OV_IMAGE, OV_PORTS, OV_KBD_RESCUE, OV_NUMPAD, OV_NAMES, OV_MODEL, OV_SOUND, OV_TEXT, OV_QUIT };
enum { PK_EXTRACT, PK_ZIP, PK_COPY, PK_MOVE, PK_DELETE, PK_CPK, PK_UNPACK, PK_SCRIPT, PK_NAMES };
enum { PICK_NONE, PICK_LOG, PICK_EXTRACT_DEFAULT, PICK_EXTRACT_ONCE, PICK_CPK_DEST };

static const char *tab_names[TAB_COUNT] = { "FILES", "TOOLS", "CREDITS" };

/* browser */
static Entry    g_entries[MAX_ENTRIES];
static int      g_count, g_sel, g_scroll;
static char     g_cwd[EX_PATH_MAX];
static int      g_cwd_free_ok;
static uint64_t g_cwd_free;
static int      g_filter = 0;      /* 0 = all files; 1 = folders + archives only */
static int      g_tab = TAB_FILES;
static int      g_overlay = OV_NONE;
static int      g_pick = PICK_NONE;

/* selection set (absolute paths) for zip creation */
static char   g_mark[AC_MAX_ITEMS][AC_PATH_MAX];
static int    g_mark_count;

/* jailbreak + pad */
static int      g_jailbroken;
static char     g_jb_msg[128];
static int      g_pad = -1;
static uint32_t g_buttons, g_prev;
static uint64_t g_hold_start, g_last_rep, g_cancel_hold;

/* settings (saved to SETTINGS) */
static int    g_deflate = 1;
static int    g_opt_overwrite = 1;
static int    g_music = 1;
static char   g_extract_dir[EX_PATH_MAX] = DEF_EXTRACT;

/* jobs + menus */
static ExJob  g_ejob;
static AcJob  g_ajob;
static char   g_job_name[256];
static char   g_job_stem[256];
static int    g_menu_sel;     /* extract menu */
static int    g_actions_sel;  /* OPTIONS actions overlay */
static int    g_tools_sel;    /* TOOLS tab list (separate cursor) */
static char   g_dest_options[3][EX_PATH_MAX];
static int    g_progress_kind; /* PK_* */
static FoJob  g_fjob;
static const char *g_op_paths[AC_MAX_ITEMS];
static int    g_op_count;
static char   g_single_target[EX_PATH_MAX]; /* highlighted item when nothing is selected */
static char   g_confirm_text[EX_PATH_MAX + 200];

/* CPK archive tools */
#define CPK_MAX_ARCH 8
enum { KB_NEWDIR, KB_CPK_ONE, KB_CPK_RANGE, KB_PORT, KB_NAMESEARCH };
static int    g_kbd_purpose;
static char   g_cpk_paths[CPK_MAX_ARCH][EX_PATH_MAX];
static int    g_cpk_count, g_cpk_view, g_cpk_cur = -1, g_cpk_rc = -2;
static Cpk    g_cpk;
static int    g_cpk_active, g_cpk_sel, g_cpk_keep_raw, g_cpk_scope_all, g_return_view, g_return_image, g_return_sound, g_return_model;
/* Homebrew service ports (for a loader / debugger / ftp / klog you run while
 * jailbroken). Stored and shown here; editing them does not launch anything. */
static int    g_port_loader = 9020, g_port_debug = 744, g_port_ftp = 2121, g_port_klog = 3232;
static char   g_rescue_text[1024];  /* text typed before the keyboard was closed with Circle */
static int    g_rescue_purpose;
static char   g_np_text[256];       /* built-in number pad (Extract by ID / byte range) */
static char   g_np_last[2][256];
static char   g_np_title[128];
static int    g_np_purpose, g_np_sel;
static void   numpad_open(int purpose, const char *title, const char *initial);
static int    g_port_edit;     /* which port the keyboard is editing */
static ScriptJob g_sjob;
static char   g_script_path[EX_PATH_MAX];
static FmtJob g_ujob;
#define LV_ROWS 17
static int    g_lv_sel, g_lv_top;
static char   g_usrc[300], g_uout[EX_PATH_MAX];
static uint64_t g_udone, g_utotal;   /* entries done / total for "unpack all" */
static char   g_cpk_dest[EX_PATH_MAX] = "/data/so4_extract";
static uint64_t g_cpk_bytes_total;
static uint64_t g_cpk_need, g_cpk_free;
static uint32_t g_cpk_left, g_cpk_files_total;
static int    g_cpk_free_ok;
static CpkProgress g_cprog;
static char   g_cprog_arch[300];
static int    g_cprog_ai, g_cprog_an;
static uint64_t g_prog_start, g_prog_last_draw, g_prog_last_tick;
static char   g_message[640];
static char   g_done_head[64];
static NfJob  g_nfjob;                 /* inner headers / name finder */
static const char *g_nf_what = "";
static int    g_nf_skiprem = 1;        /* skip IDs 10000+ (remastered copies) */
#define NF_RES_MAX 2000
static char  *g_nf_res[NF_RES_MAX];    /* search results shown on screen */
static int    g_nf_nres, g_nf_sel, g_nf_top, g_nf_total;
static uint32_t g_nf_rpacks, g_nf_rentries;
static char   g_nf_word[128];
static char   g_lab_path[1100];       /* pack_names.txt currently loaded */

static int    g_done_ok;

static uint64_t now_us(void) { return sceKernelGetProcessTime(); }

/* ---------- small utils ---------- */
/* Decimal units (1 GB = 1,000,000,000 bytes), matching FTP clients, phones and
 * drive labels. (Binary units made a 39.07 GB file read "36.39 GB".) */
static void fmt_size(uint64_t b, char *out, size_t n)
{
    if (b >= 1000000000ull) snprintf(out, n, "%.2f GB", b / 1e9);
    else if (b >= 1000000ull) snprintf(out, n, "%.2f MB", b / 1e6);
    else if (b >= 1000ull) snprintf(out, n, "%.1f KB", b / 1e3);
    else snprintf(out, n, "%llu B", (unsigned long long)b);
}

static void fmt_time(uint64_t s, char *out, size_t n)
{
    if (s >= 3600) snprintf(out, n, "%lluh %02llum", (unsigned long long)(s / 3600), (unsigned long long)(s / 60 % 60));
    else snprintf(out, n, "%llum %02llus", (unsigned long long)(s / 60), (unsigned long long)(s % 60));
}

static int free_space(const char *path, uint64_t *out)
{
    /* v1.34: ask the kernel directly. The toolchain C library's statvfs() translates through
     * its own idea of the structure and reported nothing on the console. The kernel's
     * (FreeBSD) struct statfs has f_bsize at +16 and f_bavail at +48. */
    extern int _fstatfs(int, void *);
    uint64_t raw[160]; memset(raw, 0, sizeof raw);
    int sfd = open(path, O_RDONLY);
    if (sfd < 0) return -1;
    int src = _fstatfs(sfd, raw);
    close(sfd);
    if (src != 0) return -1;
    int64_t avail = (int64_t)raw[6];
    if (avail < 0) avail = 0;
    uint64_t v = (uint64_t)avail * raw[2];
    if (v > (100ull << 40)) return -1; /* implausible -> unknown */
    *out = v;
    return 0;
}

static void path_join(char *out, size_t n, const char *a, const char *b)
{
    size_t la = strlen(a);
    if (la && a[la - 1] == '/') snprintf(out, n, "%s%s", a, b);
    else snprintf(out, n, "%s/%s", a, b);
}

static const char *base_name(const char *p)
{
    const char *s = strrchr(p, '/');
    return (s && s[1]) ? s + 1 : p;
}

static void notify(const char *fmt, ...)
{
    OrbisNotificationRequest req;
    memset(&req, 0, sizeof(req));
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(req.message, sizeof(req.message), fmt, ap);
    va_end(ap);
    req.type = NotificationRequest;
    req.targetId = -1;
    sceKernelSendNotificationRequest(0, &req, sizeof(req), 0);
}

static void show_message(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(g_message, sizeof(g_message), fmt, ap);
    va_end(ap);
    g_overlay = OV_MESSAGE;
}

/* <dir>/<base><ext>, then <base>_1<ext>, ... until it doesn't exist */
static void unique_path(const char *dir, const char *base, const char *ext, char *out, size_t n)
{
    struct stat st;
    char tmp[EX_PATH_MAX];
    snprintf(tmp, sizeof(tmp), "%s%s", base, ext);
    path_join(out, n, dir, tmp);
    for (int i = 1; stat(out, &st) == 0 && i < 1000; i++) {
        snprintf(tmp, sizeof(tmp), "%s_%d%s", base, i, ext);
        path_join(out, n, dir, tmp);
    }
}

static int dir_writable(const char *dir) { return access(dir, W_OK) == 0; }

/* ---------- PS4 RTC local time for the log ---------- */
static int rtc_clock(int *y, int *mo, int *d, int *h, int *mi, int *s)
{
    /* The OpenOrbis header declares microsecond as 16-bit, but the real
     * SceRtcDateTime is 16 bytes (32-bit microsecond): give it room. */
    union { TimeTable t; uint8_t pad[32]; } u;
    memset(&u, 0, sizeof(u));
    if (sceRtcGetCurrentClockLocalTime(&u.t) < 0 || u.t.year < 2000) return -1;
    *y = u.t.year; *mo = u.t.month; *d = u.t.day;
    *h = u.t.hour; *mi = u.t.minute; *s = u.t.second;
    return 0;
}

/* ---------- settings ---------- */
static void settings_save(void)
{
    if (!g_jailbroken) return;
    mkdir(APP_DATA, 0777); /* in case the user deleted it */
    char tmp[] = SETTINGS ".tmp";
    FILE *f = fopen(tmp, "w");
    if (!f) { logx("Could not save settings: %s", strerror(errno)); return; }
    fprintf(f, "log_path=%s\nextract_dir=%s\ndeflate=%d\noverwrite=%d\nmusic=%d\ncpk_dest=%s\ncpk_keep_raw=%d\n"
               "port_loader=%d\nport_debug=%d\nport_ftp=%d\nport_klog=%d\nnames_skip_remaster=%d\n",
            logger_path(), g_extract_dir, g_deflate, g_opt_overwrite, g_music, g_cpk_dest, g_cpk_keep_raw,
            g_port_loader, g_port_debug, g_port_ftp, g_port_klog, g_nf_skiprem);
    fclose(f);
    rename(tmp, SETTINGS);
}

static void settings_load(char *log_path, size_t n)
{
    snprintf(log_path, n, "%s", DEF_LOG);
    FILE *f = fopen(SETTINGS, "r");
    if (!f) return;
    char line[EX_PATH_MAX + 32];
    while (fgets(line, sizeof(line), f)) {
        line[strcspn(line, "\r\n")] = 0;
        char *eq = strchr(line, '=');
        if (!eq) continue;
        *eq = 0;
        const char *k = line, *v = eq + 1;
        if (!strcmp(k, "log_path") && v[0] == '/') snprintf(log_path, n, "%s", v);
        else if (!strcmp(k, "extract_dir") && v[0] == '/') snprintf(g_extract_dir, sizeof(g_extract_dir), "%s", v);
        else if (!strcmp(k, "deflate")) g_deflate = atoi(v) != 0;
        else if (!strcmp(k, "overwrite")) g_opt_overwrite = atoi(v) != 0;
        else if (!strcmp(k, "music")) g_music = atoi(v) != 0;
        else if (!strcmp(k, "cpk_dest") && v[0] == '/') snprintf(g_cpk_dest, sizeof(g_cpk_dest), "%s", v);
        else if (!strcmp(k, "cpk_keep_raw")) g_cpk_keep_raw = atoi(v) != 0;
        else if (!strcmp(k, "names_skip_remaster")) g_nf_skiprem = atoi(v) != 0;
        else if (!strcmp(k, "port_loader")) { int x = atoi(v); if (x > 0 && x < 65536) g_port_loader = x; }
        else if (!strcmp(k, "port_debug")) { int x = atoi(v); if (x > 0 && x < 65536) g_port_debug = x; }
        else if (!strcmp(k, "port_ftp")) { int x = atoi(v); if (x > 0 && x < 65536) g_port_ftp = x; }
        else if (!strcmp(k, "port_klog")) { int x = atoi(v); if (x > 0 && x < 65536) g_port_klog = x; }
    }
    fclose(f);
}

/* ---------- storage guards ---------- */
static int is_device_root(const char *p);
#define is_device_root_fwd is_device_root

/* Root of the user-storage area containing p ("/data", "/mnt/usbN", "/mnt/ext0"),
 * or NULL if p is outside them (system partitions are never touched). */
static const char *storage_root(const char *p, char *buf, size_t n)
{
    if (ac_path_within(p, "/data")) return "/data";
    if (ac_path_within(p, "/mnt/ext0")) return "/mnt/ext0";
    if (!strncmp(p, "/mnt/usb", 8) && isdigit((unsigned char)p[8]) && (p[9] == 0 || p[9] == '/')) {
        snprintf(buf, n, "%.9s", p);
        return buf;
    }
    return NULL;
}

/* Sources (moved / deleted items) must be strictly INSIDE user storage. */
static int source_allowed(const char *p)
{
    char b[16];
    const char *r = storage_root(p, b, sizeof(b));
    return r && strlen(p) > strlen(r);
}

/* Destination folders may be a storage root itself (e.g. "/data"). */
static int dest_allowed(const char *p)
{
    char b[16];
    return storage_root(p, b, sizeof(b)) != NULL;
}

static void parent_dir(const char *p, char *out, size_t n)
{
    snprintf(out, n, "%s", p);
    char *s = strrchr(out, '/');
    if (s && s != out) *s = 0; else snprintf(out, n, "/");
}

/* <dir>/<name>; if taken: "name_1.ext", "name_2.ext" ... (folders: "name_1") */
static void unique_target(const char *dir, const char *name, int is_dir, char *out, size_t n)
{
    path_join(out, n, dir, name);
    if (!fo_exists(out)) return;
    char base[256], ext[64] = "";
    snprintf(base, sizeof(base), "%s", name);
    char *dot = is_dir ? NULL : strrchr(base, '.');
    if (dot && dot != base) { snprintf(ext, sizeof(ext), "%s", dot); *dot = 0; }
    for (int i = 1; i < 10000; i++) {
        char nm[EX_PATH_MAX];
        snprintf(nm, sizeof(nm), "%s_%d%s", base, i, ext);
        path_join(out, n, dir, nm);
        if (!fo_exists(out)) return;
    }
}

/* After a delete/move the folder being browsed may be gone: climb to one that exists. */
static void ensure_cwd_exists(void)
{
    struct stat st;
    while (g_cwd[0] && (stat(g_cwd, &st) != 0 || !S_ISDIR(st.st_mode))) {
        if (is_device_root_fwd(g_cwd)) { g_cwd[0] = 0; break; }
        char *s = strrchr(g_cwd, '/');
        if (!s || s == g_cwd) { g_cwd[0] = 0; break; }
        *s = 0;
    }
}

/* ---------- selection set ---------- */
static int mark_index(const char *path)
{
    for (int i = 0; i < g_mark_count; i++)
        if (strcmp(g_mark[i], path) == 0) return i;
    return -1;
}

static void mark_toggle(const char *path)
{
    int i = mark_index(path);
    if (i >= 0) {
        memmove(g_mark[i], g_mark[i + 1], (size_t)(g_mark_count - i - 1) * AC_PATH_MAX);
        g_mark_count--;
    } else if (g_mark_count < AC_MAX_ITEMS) {
        snprintf(g_mark[g_mark_count++], AC_PATH_MAX, "%s", path);
    } else {
        show_message("Selection limit reached (%d items).", AC_MAX_ITEMS);
    }
}

static void mark_clear(void) { g_mark_count = 0; }

/* ---------- GoldHEN jailbreak (sandbox escape for file access) ---------- */
/* Calling convention as in the GoldHEN Plugins SDK: indirect syscall 0 ->
 * GoldHEN syscall 500, command 2 = jailbreak. */
static long goldhen_cmd(long cmd, void *data)
{
    long ret;
    unsigned char err;
    register long r_num __asm__("rdi") = 500;
    register long r_cmd __asm__("rsi") = cmd;
    register void *r_data __asm__("rdx") = data;
    __asm__ volatile("xor %%eax, %%eax\n\tsyscall\n\tsetc %1"
                     : "=a"(ret), "=r"(err), "+r"(r_num), "+r"(r_cmd), "+r"(r_data)
                     :
                     : "rcx", "r8", "r9", "r10", "r11", "memory", "cc");
    return err ? -1 : ret;
}

/* Escaping the sandbox (the jailbreak) changes the root directory, after which
 * "/app0" no longer points at the installed app. So assets are read BEFORE the
 * jailbreak; if that ever fails these real locations are tried afterwards. */
#define TITLE_ID_STR "CUSA99901"
static const char *asset_dirs[] = {
    "/app0/assets",
    "/mnt/sandbox/" TITLE_ID_STR "_000/app0/assets",
    "/mnt/sandbox/pfsmnt/" TITLE_ID_STR "-app0/assets",
    NULL
};

static int load_bg_any(char *used, size_t n)
{
    int rc = -1;
    for (int i = 0; asset_dirs[i]; i++) {
        char p[256];
        snprintf(p, sizeof(p), "%s/bg.bin", asset_dirs[i]);
        if ((rc = gfx_load_bg(p)) == 0) { snprintf(used, n, "%s", p); return 0; }
    }
    return rc;
}

static int load_music_any(char *used, size_t n)
{
    int rc = -1;
    for (int i = 0; asset_dirs[i]; i++) {
        char p[256];
        snprintf(p, sizeof(p), "%s/music.pcm", asset_dirs[i]);
        if ((rc = audio_load(p)) == 0) { snprintf(used, n, "%s", p); return 0; }
    }
    return rc;
}

/* GoldHEN writes the original credentials into this buffer. The SDK struct is
 * 72 bytes; it is static and generously padded so a larger struct in another
 * GoldHEN version can never overwrite the stack. */
static union {
    struct { uint32_t uid, ruid, rgid, groups; uint64_t paid, caps[2];
             void *prison, *cdir, *jdir, *rdir; } b;
    uint8_t pad[1024];
} g_jb_backup;
static uint32_t g_jb_ver_buf[64];
static uint64_t g_jb_ms;

static void try_jailbreak(void)
{
    uint64_t t0 = now_us();
    signal(SIGSYS, SIG_IGN); /* in case GoldHEN is not loaded */
    memset(&g_jb_backup, 0, sizeof(g_jb_backup));
    long ver = goldhen_cmd(0, g_jb_ver_buf); /* valid buffer, never NULL */
    long rc = goldhen_cmd(2, &g_jb_backup);
    g_jb_ms = (now_us() - t0) / 1000;
    g_jailbroken = (rc == 0) && access("/data", R_OK | W_OK) == 0;
    if (g_jailbroken && ver > 0) snprintf(g_jb_msg, sizeof(g_jb_msg), "GoldHEN OK (SDK %lx)", ver);
    else if (g_jailbroken) snprintf(g_jb_msg, sizeof(g_jb_msg), "GoldHEN OK");
    else if (access("/data", R_OK) == 0) { g_jailbroken = 1; snprintf(g_jb_msg, sizeof(g_jb_msg), "Filesystem accessible"); }
    else snprintf(g_jb_msg, sizeof(g_jb_msg), "Jailbreak FAILED - load GoldHEN");
}

/* ---------- controller ---------- */
static int pad_init(void)
{
    OrbisUserServiceInitializeParams p;
    int user = -1;
    memset(&p, 0, sizeof(p));
    p.priority = ORBIS_KERNEL_PRIO_FIFO_LOWEST;
    sceUserServiceInitialize(&p);
    sceUserServiceGetInitialUser(&user);
    if (scePadInit() != 0) return -1;
    g_pad = scePadOpen(user, 0, 0, NULL);
    return g_pad < 0 ? -1 : 0;
}

static int g_swallow; /* ignore buttons until all are released (after the keyboard) */
static int g_lx = 128, g_ly = 128, g_rx = 128, g_ry = 128; /* analog sticks, 128 = centre */

static void pad_poll(void)
{
    OrbisPadData d;
    g_prev = g_buttons;
    if (g_pad >= 0 && scePadReadState(g_pad, &d) == 0 && d.connected) {
        g_buttons = d.buttons;
        g_lx = d.leftStick.x; g_ly = d.leftStick.y; g_rx = d.rightStick.x; g_ry = d.rightStick.y;
    } else { g_buttons = 0; g_lx = g_ly = g_rx = g_ry = 128; }
    if (g_swallow) {
        if (g_buttons) { g_buttons = g_prev = 0; }
        else g_swallow = 0;
    }
}

static int pressed(uint32_t b) { return (g_buttons & b) && !(g_prev & b); }

/* pressed, plus auto-repeat while held */
static int repeat(uint32_t b)
{
    uint64_t t = now_us();
    if (pressed(b)) { g_hold_start = g_last_rep = t; return 1; }
    if ((g_buttons & b) && t - g_hold_start > 400000 && t - g_last_rep > 55000) { g_last_rep = t; return 1; }
    return 0;
}

/* ---------- directory listing ---------- */
enum { SORT_NAME, SORT_SIZE, SORT_KIND, SORT_COUNT };
static int g_sort = SORT_NAME;
static const char *const k_sort_names[SORT_COUNT] = { "name", "size", "format" };

static int cmp_entry(const void *a, const void *b)
{
    const Entry *x = a, *y = b;
    if (x->is_dir != y->is_dir) return y->is_dir - x->is_dir;
    if (!x->is_dir && g_sort == SORT_SIZE && x->size != y->size) return x->size < y->size ? 1 : -1;   /* largest first */
    if (!x->is_dir && g_sort == SORT_KIND) {
        int c = strcmp(x->kind[0] ? x->kind : "~", y->kind[0] ? y->kind : "~");    /* unknown last */
        if (c) return c;
        const char *ex = strrchr(x->name, '.'), *ey = strrchr(y->name, '.');
        c = strcasecmp(ex ? ex : "", ey ? ey : "");
        if (c) return c;
    }
    return strcasecmp(x->name, y->name);
}

/* What a file is, from its extension alone (no disk access). "" when the extension says nothing. */
static const char *kind_from_name(const char *name)
{
    static const struct { const char *ext, *kind; } T[] = {
        { ".aac", "Audio" }, { ".at9", "Audio" }, { ".wav", "Audio" }, { ".pck", "Audio" }, { ".bnk", "Audio" }, { ".awb", "Audio" }, { ".afs", "Audio" },
        { ".aif", "Texture" }, { ".dds", "Texture" }, { ".png", "Image" }, { ".tga", "Image" }, { ".bmp", "Image" }, { ".jpg", "Image" },
        { ".asf", "Model" }, { ".glb", "Model" }, { ".aaf", "Animation" },
        { ".exd", "Text/data" }, { ".txt", "Text" }, { ".md", "Text" }, { ".log", "Text" },
        { ".zip", "Archive" }, { ".rar", "Archive" }, { ".7z", "Archive" }, { ".psarc", "Archive" }, { ".cpk", "Archive" },
        { ".pkg", "Package" }, { ".slz", "Compressed" }, { ".lz4", "Compressed" } };
    const char *x = strrchr(name, '.');
    if (!x) return "";
    for (size_t i = 0; i < sizeof T / sizeof T[0]; i++) if (!strcasecmp(x, T[i].ext)) return T[i].kind;
    return "";
}

/* Looks at the first bytes of a file once: picture size for images and textures, and the
 * kind of files whose extension says nothing (.bin and the like). */
static void entry_probe(Entry *e, const char *dir)
{
    e->probed = 1;
    if (e->is_dir) return;
    int want_res = !strcmp(e->kind, "Texture") || !strcmp(e->kind, "Image");
    if (!want_res && e->kind[0]) return;
    char full[EX_PATH_MAX];
    path_join(full, sizeof(full), dir, e->name);
    int fd = open(full, O_RDONLY);
    if (fd < 0) return;
    static uint8_t h[4096];
    ssize_t n = pread(fd, h, sizeof h, 0);
    close(fd);
    if (n < 8) return;
    uint32_t w = 0, hh = 0;
    const char *k = "";
    if (n >= 24 && !memcmp(h, "\x89PNG\r\n\x1a\n", 8)) { w = (uint32_t)h[16] << 24 | h[17] << 16 | h[18] << 8 | h[19]; hh = (uint32_t)h[20] << 24 | h[21] << 16 | h[22] << 8 | h[23]; k = "Image"; }
    else if (n >= 20 && !memcmp(h, "DDS ", 4)) { hh = h[12] | h[13] << 8 | h[14] << 16; w = h[16] | h[17] << 8 | h[18] << 16; k = "Texture"; }
    else if (n >= 26 && h[0] == 'B' && h[1] == 'M') { w = h[18] | h[19] << 8 | h[20] << 16; int32_t t = (int32_t)(h[22] | h[23] << 8 | h[24] << 16 | (uint32_t)h[25] << 24); hh = (uint32_t)(t < 0 ? -t : t); k = "Image"; }
    else if (!memcmp(h, "KCAP", 4)) k = "Pack";
    else if (!memcmp(h, " CAA", 4)) k = "Audio";
    else if (!memcmp(h, "RIFF", 4)) k = "Audio";
    else {
        /* tri-Ace texture: the first image record carries the size */
        for (ssize_t o = 0; o + 0x30 <= n; o += 16)
            if (!memcmp(h + o, "Xgmi", 4)) { w = h[o + 0x28] | h[o + 0x29] << 8; hh = h[o + 0x2a] | h[o + 0x2b] << 8; if (!want_res) k = "Texture"; break; }
        if (!w && want_res && n >= 18) {            /* TGA has no magic: trust the extension */
            const char *x = strrchr(e->name, '.');
            if (x && !strcasecmp(x, ".tga")) { w = h[12] | h[13] << 8; hh = h[14] | h[15] << 8; }
        }
    }
    if (!e->kind[0] && k[0]) snprintf(e->kind, sizeof(e->kind), "%s", k);
    if (w && hh && w <= 65535 && hh <= 65535) { e->rw = (uint16_t)w; e->rh = (uint16_t)hh; }
}

static void add_device(const char *path)
{
    struct stat st, parent;
    if (stat(path, &st) != 0 || !S_ISDIR(st.st_mode) || g_count >= MAX_ENTRIES) return;
    /* /mnt/usb0-7 and /mnt/ext0 always exist as empty folders; a drive is only
     * there if the folder is on a different filesystem than /mnt itself */
    if (!strncmp(path, "/mnt/", 5) && stat("/mnt", &parent) == 0 && parent.st_dev == st.st_dev) return;
    Entry *e = &g_entries[g_count++];
    snprintf(e->name, sizeof(e->name), "%s", path);
    e->is_dir = 1;
    e->is_archive = 0;
    if (free_space(path, &e->size) != 0) e->size = UINT64_MAX;
}

static void labels_ensure(int force);
static const char *file_label(const char *dir, const char *name, int is_dir);
static uint64_t g_live_frame_t0;
static int g_live_pending;            /* some rows still need a name: redraw soon */
static int g_anim;                    /* a viewer is animating: redraw every frame */
static long pack_of_name(const char *name);
static void live_clear(void);
static const char *cpk_row_label(const CpkEntry *e, int live);
static void load_dir(const char *select_name)
{
    labels_ensure(0);
    live_clear();
    char keep[256] = "";
    if (select_name) snprintf(keep, sizeof(keep), "%s", select_name); /* may point into g_entries */

    g_count = 0;
    g_sel = g_scroll = 0;
    g_cwd_free_ok = g_cwd[0] && free_space(g_cwd, &g_cwd_free) == 0; /* cached, not per frame */
    if (!g_cwd[0]) {
        add_device("/data");
        char p[32];
        for (int i = 0; i < 8; i++) { snprintf(p, sizeof(p), "/mnt/usb%d", i); add_device(p); }
        add_device("/mnt/ext0");
        add_device("/user");
        add_device("/");
    } else {
        DIR *d = opendir(g_cwd);
        if (!d) {
            logx("Cannot open %s: %s", g_cwd, strerror(errno));
            show_message("Cannot open %s: %s", g_cwd, strerror(errno));
            return;
        }
        struct dirent *de;
        char full[EX_PATH_MAX];
        while ((de = readdir(d)) && g_count < MAX_ENTRIES) {
            if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
            path_join(full, sizeof(full), g_cwd, de->d_name);
            struct stat st;
            if (stat(full, &st) != 0) continue;
            Entry *e = &g_entries[g_count];
            e->is_dir = S_ISDIR(st.st_mode);
            e->is_archive = !e->is_dir && ex_is_archive_name(de->d_name);
            {
                const char *x = strrchr(de->d_name, '.');
                e->is_image = !e->is_dir && x && (!strcasecmp(x, ".dds") || !strcasecmp(x, ".aif") || !strcasecmp(x, ".png") || !strcasecmp(x, ".tga") || !strcasecmp(x, ".bmp"));
            }
            if (g_pick != PICK_NONE && !e->is_dir) continue; /* picking a folder: folders only */
            if (g_filter && !e->is_dir && !e->is_image && (!e->is_archive || ex_is_secondary_volume(de->d_name)))
                continue;
            snprintf(e->name, sizeof(e->name), "%s", de->d_name);
            e->size = e->is_dir ? 0 : (uint64_t)st.st_size;
            e->rw = e->rh = 0; e->probed = 0;
            snprintf(e->kind, sizeof(e->kind), "%s", e->is_dir ? "" : kind_from_name(de->d_name));
            g_count++;
        }
        closedir(d);
        qsort(g_entries, g_count, sizeof(Entry), cmp_entry);
    }
    if (keep[0])
        for (int i = 0; i < g_count; i++)
            if (!strcmp(g_entries[i].name, keep)) { g_sel = i; break; }
    if (g_sel >= LIST_ROWS) g_scroll = g_sel - LIST_ROWS / 2;
}

static int is_device_root(const char *p)
{
    return !strcmp(p, "/") || !strcmp(p, "/data") || !strcmp(p, "/user") ||
           !strcmp(p, "/mnt/ext0") || (!strncmp(p, "/mnt/usb", 8) && !strchr(p + 8, '/'));
}

static void go_up(void)
{
    char prev[256] = "";
    if (!g_cwd[0]) return;
    if (is_device_root(g_cwd)) {
        snprintf(prev, sizeof(prev), "%s", g_cwd);
        g_cwd[0] = 0;
    } else {
        char *s = strrchr(g_cwd, '/');
        snprintf(prev, sizeof(prev), "%s", s + 1);
        if (s == g_cwd) s[1] = 0; else *s = 0;
    }
    load_dir(prev);
}

static void start_pick(int mode)
{
    g_pick = mode;
    g_tab = TAB_FILES;
    g_overlay = OV_NONE;
    load_dir(NULL); /* re-list without plain files */
}

static void end_pick(void)
{
    g_pick = PICK_NONE;
    load_dir(g_count ? g_entries[g_sel].name : NULL);
}

/* ---------- drawing helpers ---------- */
/* Word-wrap text (monospace font) into at most max_lines lines; the last line
 * is clipped with "..." if needed. Returns the y below the last line. */
static int text_wrap(int font, int x, int y, Color c, const char *t, int max_px, int max_lines)
{
    int per = max_px / gfx_char_w(font), lh = gfx_char_h(font) + 6;
    char line[1024];
    for (int ln = 0; ln < max_lines && *t; ln++) {
        while (*t == ' ') t++;
        size_t len = strlen(t), take = len;
        if ((int)len > per && ln < max_lines - 1) {
            take = (size_t)per;
            size_t sp = take;
            while (sp > 0 && t[sp] != ' ') sp--;
            if (sp > (size_t)per / 3) take = sp;                                   /* break at a space */
            else while (take > 0 && ((unsigned char)t[take] & 0xC0) == 0x80) take--; /* don't split UTF-8 */
        }
        if (take >= sizeof(line)) take = sizeof(line) - 1;
        memcpy(line, t, take);
        line[take] = 0;
        gfx_text_clip(font, x, y, c, line, max_px);
        t += take;
        y += lh;
    }
    return y;
}

static void draw_header(void)
{
    gfx_rect_blend(0, 0, SCREEN_W, 150, C_PANEL, 175);
    gfx_text(FONT_LARGE, 60, 22, C_TEXT, APP_TITLE);
    char v[160];
    snprintf(v, sizeof(v), "v%s", APP_VERSION);
    gfx_text(FONT_SMALL, SCREEN_W - 60 - gfx_text_width(FONT_SMALL, v), 20, C_DIM, v);
    gfx_text(FONT_SMALL, SCREEN_W - 60 - gfx_text_width(FONT_SMALL, g_jb_msg), 56,
             g_jailbroken ? C_OK : C_ERR, g_jb_msg);
    int x = 60, y = 96;
    for (int i = 0; i < TAB_COUNT; i++) {
        int w = gfx_text_width(FONT_SMALL, tab_names[i]) + 44;
        if (i == g_tab) {
            gfx_rect_blend(x, y, w, 42, C_ACCENT, 230);
            gfx_text(FONT_SMALL, x + 22, y + 6, RGB(10, 20, 35), tab_names[i]);
        } else {
            gfx_rect_blend(x, y, w, 42, C_PANEL, 150);
            gfx_text(FONT_SMALL, x + 22, y + 6, C_DIM, tab_names[i]);
        }
        x += w + 12;
    }
    const char *mstate = !audio_available() ? "N/A" : audio_is_enabled() ? "ON" : "OFF";
    char m[32];
    snprintf(m, sizeof(m), "Music: %s", mstate);
    gfx_text(FONT_SMALL, SCREEN_W - 60 - gfx_text_width(FONT_SMALL, m), 100,
             (audio_available() && audio_is_enabled()) ? C_OK : C_DIM, m);
}

static void draw_footer(const char *hints)
{
    gfx_rect_blend(0, SCREEN_H - 64, SCREEN_W, 64, C_PANEL, 185);
    gfx_text_clip(FONT_SMALL, 60, SCREEN_H - 48, C_DIM, hints, SCREEN_W - 120);
}

static void draw_bar(int x, int y, int w, int h, double frac)
{
    if (frac < 0) frac = 0;
    if (frac > 1) frac = 1;
    gfx_rect_blend(x, y, w, h, C_BAR_BG, 220);
    gfx_rect(x, y, (int)(w * frac), h, C_BAR);
}

/* ---------- FILES tab ---------- */
static const char *pick_banner(void)
{
    switch (g_pick) {
    case PICK_LOG:             return "PICK LOG FOLDER: open a folder, then press OPTIONS.  " GLYPH_CIRCLE " at the device list cancels";
    case PICK_EXTRACT_DEFAULT: return "PICK DEFAULT EXTRACTION FOLDER: open it, then press OPTIONS.  " GLYPH_CIRCLE " at the device list cancels";
    case PICK_EXTRACT_ONCE:    return "PICK WHERE TO EXTRACT: open a folder, then press OPTIONS.  " GLYPH_CIRCLE " at the device list cancels";
    case PICK_CPK_DEST:        return "PICK THE CPK OUTPUT FOLDER: open it, then press OPTIONS.  " GLYPH_CIRCLE " at the device list goes back";
    default:                   return "";
    }
}

static void draw_files(void)
{
    g_live_frame_t0 = now_us();
    char sub[EX_PATH_MAX + 64], sz[32];
    int top = 210, row_h = 38;

    PANEL(40, 165, SCREEN_W - 80, 34);
    if (!g_cwd[0]) snprintf(sub, sizeof(sub), "Select a storage device");
    else if (g_cwd_free_ok) { fmt_size(g_cwd_free, sz, sizeof(sz)); snprintf(sub, sizeof(sub), "%s   (free: %s)", g_cwd, sz); }
    else snprintf(sub, sizeof(sub), "%s", g_cwd);
    gfx_text_clip(FONT_SMALL, 60, 168, C_TEXT, sub, SCREEN_W - 460);
    char cnt[64];
    snprintf(cnt, sizeof(cnt), "Sort: %s   Selected: %d", k_sort_names[g_sort], g_mark_count);
    gfx_text(FONT_SMALL, SCREEN_W - 60 - gfx_text_width(FONT_SMALL, cnt), 168, g_mark_count ? C_MARK : C_DIM, cnt);

    if (g_pick != PICK_NONE) {
        gfx_rect_blend(40, 204, SCREEN_W - 80, 34, RGB(60, 90, 30), 230);
        gfx_text_clip(FONT_SMALL, 60, 207, C_MARK, pick_banner(), SCREEN_W - 120);
        top = 250;
    }

    PANEL(40, top - 6, SCREEN_W - 80, LIST_ROWS * row_h + 12);
    if (g_count == 0)
        gfx_text(FONT_SMALL, 70, top + 8, C_DIM,
                 g_pick ? "(no sub-folders here - press OPTIONS to use this folder)" :
                 g_filter ? "(no folders, archives or images - press " GLYPH_TRIANGLE " to show all files)" : "(empty)");

    if (g_sel < g_scroll) g_scroll = g_sel;
    if (g_sel >= g_scroll + LIST_ROWS) g_scroll = g_sel - LIST_ROWS + 1;
    int probes = 0;
    for (int i = 0; i < LIST_ROWS && g_scroll + i < g_count; i++) {
        int idx = g_scroll + i;
        Entry *e = &g_entries[idx];
        int y = top + i * row_h;
        if (idx == g_sel) gfx_rect_blend(48, y - 3, SCREEN_W - 96, row_h, C_SEL, 180);
        Color c = e->is_dir ? C_DIR : e->is_archive ? C_ARCH : e->is_image ? C_IMAGE : C_TEXT;

        if (!g_cwd[0]) {
            const char *desc = !strcmp(e->name, "/data") ? "Internal storage" :
                               !strncmp(e->name, "/mnt/usb", 8) ? "USB drive" :
                               !strcmp(e->name, "/mnt/ext0") ? "Extended storage" :
                               !strcmp(e->name, "/user") ? "User partition" : "System root";
            char label[300];
            snprintf(label, sizeof(label), "%-13s %s", e->name, desc);
            gfx_text(FONT_SMALL, 72, y, c, label);
            if (e->size != UINT64_MAX) {
                char fr[48];
                fmt_size(e->size, sz, sizeof(sz));
                snprintf(fr, sizeof(fr), "free %s", sz);
                gfx_text(FONT_SMALL, SCREEN_W - 80 - gfx_text_width(FONT_SMALL, fr), y, C_DIM, fr);
            }
            continue;
        }
        char full[EX_PATH_MAX];
        path_join(full, sizeof(full), g_cwd, e->name);
        int marked = mark_index(full) >= 0;
        if (marked) gfx_text(FONT_SMALL, 72, y, C_MARK, GLYPH_SQUARE);
        char label[300];
        snprintf(label, sizeof(label), "%s%s", e->name, e->is_dir ? "/" : "");
        const char *nl = file_label(g_cwd, e->name, e->is_dir);
        int nw = gfx_text_width(FONT_SMALL, label);
        if (nl && nw > SCREEN_W - 1060) nw = SCREEN_W - 1060;
        gfx_text_clip(FONT_SMALL, 104, y, marked ? C_MARK : c, label, nl ? SCREEN_W - 1060 : SCREEN_W - 660);
        if (nl) { int lx = 104 + nw + 40 > 700 ? 104 + nw + 40 : 700; if (lx < 1360) gfx_text_clip(FONT_SMALL, lx, y, C_ACCENT, nl, 1360 - lx); }
        if (!e->probed && probes < 6) { entry_probe(e, g_cwd); probes++; }      /* a few per frame keeps scrolling smooth */
        if (!e->is_dir) {
            if (e->kind[0]) gfx_text_clip(FONT_SMALL, 1390, y, C_DIM, e->kind, 150);
            if (e->rw) { char rs[24]; snprintf(rs, sizeof(rs), "%ux%u", e->rw, e->rh); gfx_text_clip(FONT_SMALL, 1530, y, C_DIM, rs, 160); }
            fmt_size(e->size, sz, sizeof(sz));
            gfx_text(FONT_SMALL, SCREEN_W - 80 - gfx_text_width(FONT_SMALL, sz), y, C_DIM, sz);
        }
    }
    if (g_count > LIST_ROWS) {
        char pos[32];
        snprintf(pos, sizeof(pos), "%d / %d", g_sel + 1, g_count);
        gfx_text(FONT_SMALL, SCREEN_W - 80 - gfx_text_width(FONT_SMALL, pos), top + LIST_ROWS * row_h + 14, C_DIM, pos);
    }
    if (g_pick != PICK_NONE)
        draw_footer(GLYPH_CROSS " Open folder   " GLYPH_CIRCLE " Back / cancel   OPTIONS Use this folder   L2/R2 Page");
    else
        draw_footer(GLYPH_CROSS " Open/Extract   " GLYPH_SQUARE " Select   " GLYPH_CIRCLE " Back   " GLYPH_TRIANGLE
                    " Filter   R3 Sort   OPTIONS File menu   L2/R2 Page   L1/R1 Tab");
}

/* ---------- TOOLS tab ---------- */
static const char *tools_items[] = {
    "Create ZIP from selected files",
    "Clear selection",
    "ZIP compression",
    "Overwrite when extracting",
    "Background music",
    "Log file location",
    "Default extraction folder",
    "Star Ocean 4 data archives (CUSA09485)",
    "Homebrew service ports...",
    "Run a batch script (.txt)...",
    "GPU probe: test PS4 graphics set-ups (writes gpu_probe.txt)",
};
#define TOOLS_N 11
static int g_probe_first = 1;
static void probe_next_load(void);

static void draw_tools(void)
{
    /* Layout follows TOOLS_N so new rows never run under the log panel. */
    const int row0 = 236, pitch = 40;
    const int rows_end = row0 + TOOLS_N * pitch;
    PANEL(40, 170, SCREEN_W - 80, rows_end - 170 + 6);
    char v[EX_PATH_MAX + 32];
    snprintf(v, sizeof(v), "Selected files/folders: %d", g_mark_count);
    gfx_text(FONT_SMALL, 70, 192, g_mark_count ? C_MARK : C_DIM, v);

    for (int i = 0; i < TOOLS_N; i++) {
        int ry = row0 + i * pitch;
        if (i == g_tools_sel) gfx_rect_blend(56, ry - 4, SCREEN_W - 112, pitch - 2, C_SEL, 170);
        gfx_text(FONT_SMALL, 72, ry, C_TEXT, tools_items[i]);
        const char *val = "";
        switch (i) {
        case 2: val = g_deflate ? "Deflate (smaller)" : "Store (fastest)"; break;
        case 3: val = g_opt_overwrite ? "Yes" : "No, skip existing"; break;
        case 4: val = !audio_available() ? "Unavailable" : audio_is_enabled() ? "On" : "Off"; break;
        case 5: val = logger_path()[0] ? logger_path() : "(not set)"; break;
        case 6: val = g_extract_dir; break;
        case 7: val = "Open CPK tools"; break;
        case 8: val = "loader / debugger / ftp / klog"; break;
        case 9: val = "pick a .txt in FILES"; break;
        case 10: { static char pv[64]; probe_next_load(); snprintf(pv, sizeof pv, GLYPH_CROSS " run, start at test %d of %d  (left/right)", g_probe_first, gpu_probe_count()); val = pv; break; }
        }
        if (*val) gfx_text_clip(FONT_SMALL, 760, ry, C_ACCENT, val, SCREEN_W - 820);
    }

    int lv = rows_end + 16;
    gfx_text(FONT_SMALL, 70, lv, C_DIM, "Recent log:");
    int ph = SCREEN_H - (lv + 34) - 76;
    PANEL(40, lv + 34, SCREEN_W - 80, ph);
    int n = logger_ring_count(), show = (ph - 16) / 26;
    if (show < 1) show = 1;
    int from = n > show ? n - show : 0;
    for (int i = from; i < n; i++)
        gfx_text_clip(FONT_SMALL, 60, lv + 44 + (i - from) * 26, C_DIM, logger_ring_line(i), SCREEN_W - 120);

    draw_footer(GLYPH_CROSS " Run / Toggle / Change   L1/R1 Tab   (settings are saved automatically)");
}

/* ---------- CREDITS tab ---------- */
static void draw_credits(void)
{
    PANEL(40, 170, SCREEN_W - 80, SCREEN_H - 170 - 80);
    int x = 80, y = 200;
    gfx_text(FONT_LARGE, x, y, C_ACCENT, APP_TITLE); y += 70;
    gfx_text(FONT_SMALL, x, y, C_DIM, "Version " APP_VERSION "    Title ID CUSA99901"); y += 56;
    gfx_text(FONT_LARGE, x, y, C_MARK, "Developer: " APP_DEV); y += 80;

    gfx_text(FONT_SMALL, x, y, C_TEXT, "Features:"); y += 36;
    static const char *feat[] = {
        "- File explorer for internal storage and USB drives",
        "- Extract ZIP, RAR and 7z (multi-part and files > 4 GB) to any folder you choose",
        "- Create ZIP archives; new folder, copy, move and delete",
        "- Live progress bar with a hold-to-cancel button",
        "- Log file you can place anywhere, plus an on-screen log viewer",
        "- Toggleable soft ambient background music; settings are remembered",
    };
    for (int i = 0; i < 6; i++) { gfx_text(FONT_SMALL, x + 20, y, C_DIM, feat[i]); y += 32; }
    y += 20;
    gfx_text(FONT_SMALL, x, y, C_TEXT, "Built with:"); y += 36;
    gfx_text(FONT_SMALL, x + 20, y, C_DIM, "OpenOrbis PS4 Toolchain, libarchive, xz/liblzma, zlib, DejaVu Sans Mono."); y += 32;
    gfx_text(FONT_SMALL, x + 20, y, C_DIM, "Sandbox escape via the GoldHEN jailbreak. Background art: supplied nebula image."); y += 48;
    gfx_text(FONT_SMALL, x, y, C_DIM, "Controls: D-Pad move  " GLYPH_CROSS " confirm  " GLYPH_CIRCLE " back  "
             GLYPH_SQUARE " select  " GLYPH_TRIANGLE " filter  L2/R2 page  L1/R1 tabs  OPTIONS menu");
    draw_footer("L1/R1 switch tabs");
}

/* ---------- overlays ---------- */
#define EXTRACT_OPTS 4

static void draw_extract_menu(void)
{
    gfx_rect_blend(0, 0, SCREEN_W, SCREEN_H, RGB(0, 0, 0), 150);
    int bx = 340, by = 190, bw = SCREEN_W - 680;
    PANEL(bx, by, bw, 680);
    int x = bx + 40, y = by + 30;
    gfx_text(FONT_LARGE, x, y, C_ACCENT, "Extract archive"); y += 70;
    gfx_text_clip(FONT_SMALL, x, y, C_TEXT, g_job_name, bw - 80); y += 40;
    char tmp[64], info[160];
    fmt_size(g_ejob.input_total, tmp, sizeof(tmp));
    snprintf(info, sizeof(info), "%d volume%s, %s", g_ejob.volume_count, g_ejob.volume_count == 1 ? "" : "s", tmp);
    gfx_text(FONT_SMALL, x, y, C_DIM, info); y += 56;

    for (int i = 0; i < EXTRACT_OPTS; i++) {
        int ry = y + i * 92;
        if (i == g_menu_sel) gfx_rect_blend(x - 10, ry - 6, bw - 60, 82, C_SEL, 180);
        static const char *labels[EXTRACT_OPTS] = {
            "Extract here (new subfolder)", "Extract to default folder",
            "Extract into this folder", "Choose a folder...",
        };
        gfx_text(FONT_SMALL, x + 10, ry, C_TEXT, labels[i]);
        char d[EX_PATH_MAX + 80];
        if (i < 3) snprintf(d, sizeof(d), "-> %s/", g_dest_options[i]);
        else snprintf(d, sizeof(d), "-> browse to any folder; a \"%s\" subfolder is created there", g_job_stem);
        gfx_text_clip(FONT_SMALL, x + 30, ry + 36, C_DIM, d, bw - 100);
    }
    gfx_text(FONT_SMALL, x, by + 630, C_DIM, GLYPH_CROSS " Start   " GLYPH_CIRCLE " Cancel   (change the default folder in TOOLS)");
}

enum { ACT_ZIP, ACT_COPY, ACT_MOVE, ACT_DELETE, ACT_NEWDIR, ACT_UNPACK, ACT_CPK, ACT_SCRIPT, ACT_VERIFY, ACT_SELALL, ACT_CLEAR, ACT_LOG, ACT_EXIT, ACT_CLOSE, ACTIONS_N };
static void draw_actions_menu(void)
{
    gfx_rect_blend(0, 0, SCREEN_W, SCREEN_H, RGB(0, 0, 0), 150);
    int bx = 420, by = 150, bw = SCREEN_W - 840;
    char lbl[ACTIONS_N][96];
    snprintf(lbl[ACT_ZIP], 96, "Create ZIP from selected (%d)", g_mark_count);
    snprintf(lbl[ACT_COPY], 96, "Copy selected here (%d)", g_mark_count);
    snprintf(lbl[ACT_MOVE], 96, "Move selected here (%d)", g_mark_count);
    if (g_mark_count) snprintf(lbl[ACT_DELETE], 96, "Delete selected (%d)...", g_mark_count);
    else if (g_cwd[0] && g_count) snprintf(lbl[ACT_DELETE], 96, "Delete \"%.40s\"...", g_entries[g_sel].name);
    else snprintf(lbl[ACT_DELETE], 96, "Delete...");
    snprintf(lbl[ACT_NEWDIR], 96, "New folder here...");
    snprintf(lbl[ACT_UNPACK], 96, "Unpack / convert this file (auto-detect)...");
    snprintf(lbl[ACT_CPK], 96, "Open as game archive (CPK / Star Ocean 4)...");
    snprintf(lbl[ACT_SCRIPT], 96, "Run this batch script (.txt)");
    snprintf(lbl[ACT_VERIFY], 96, "Verify file: size + SHA-256 (no run)");
    snprintf(lbl[ACT_SELALL], 96, "Select ALL here");
    snprintf(lbl[ACT_CLEAR], 96, "Clear selection");
    snprintf(lbl[ACT_LOG], 96, "Set this folder as log folder");
    snprintf(lbl[ACT_EXIT], 96, "Close application...");
    snprintf(lbl[ACT_CLOSE], 96, "Close this menu");
    PANEL(bx, by, bw, 880);
    gfx_text(FONT_LARGE, bx + 36, by + 24, C_ACCENT, "Actions");
    for (int i = 0; i < ACTIONS_N; i++) {
        int ry = by + 100 + i * 58;
        if (i == g_actions_sel) gfx_rect_blend(bx + 20, ry - 6, bw - 40, 52, C_SEL, 180);
        gfx_text_clip(FONT_SMALL, bx + 40, ry, i == ACT_DELETE ? C_ERR : C_TEXT, lbl[i], bw - 80);
    }
    gfx_text_clip(FONT_SMALL, bx + 36, by + 840, C_DIM,
                  GLYPH_CROSS " Choose   " GLYPH_CIRCLE " Close    Copy/Move put items into the folder you are in",
                  bw - 72);
}

static void draw_keyboard_wait(void)
{
    gfx_rect_blend(0, 0, SCREEN_W, SCREEN_H, RGB(0, 0, 0), 120);
    PANEL(240, 120, SCREEN_W - 480, 110);
    gfx_text(FONT_SMALL, 280, 140, C_TEXT, "Type the new folder name on the keyboard, then confirm.");
    gfx_text(FONT_SMALL, 280, 180, C_DIM, "Created in:");
    gfx_text_clip(FONT_SMALL, 460, 180, C_ACCENT, g_cwd, SCREEN_W - 760);
}

static void draw_confirm(void)
{
    gfx_rect_blend(0, 0, SCREEN_W, SCREEN_H, RGB(0, 0, 0), 170);
    PANEL(240, 330, SCREEN_W - 480, 380);
    gfx_text(FONT_LARGE, 300, 370, C_ERR, "Delete permanently?");
    int cy = text_wrap(FONT_SMALL, 300, 460, C_TEXT, g_confirm_text, SCREEN_W - 600, 2);
    gfx_text(FONT_SMALL, 300, cy + 14, C_WARN, "This cannot be undone. Folders are deleted with everything inside.");
    gfx_text(FONT_SMALL, 300, 620, C_DIM, GLYPH_SQUARE " Delete      " GLYPH_CIRCLE " Cancel");
}

/* ---------------------------------------------------------------- v1.35: close from inside
 * Every step is written to the log AND forced to disk before the step runs, so if the console
 * goes down during shutdown the last "shutdown:" line names the step that did it. */
static void sd_log(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void sd_log(const char *fmt, ...)
{
    char b[300];
    va_list ap; va_start(ap, fmt);
    vsnprintf(b, sizeof b, fmt, ap);
    va_end(ap);
    logx("shutdown: %s", b);
    const char *lp = logger_path();
    if (lp && lp[0]) { int fd = open(lp, O_WRONLY | O_APPEND); if (fd >= 0) { fsync(fd); close(fd); } }
}
static int g_sd_started;
static void sd_atexit(void) { sd_log("atexit handlers running (process is leaving normally)"); }
static void app_shutdown(void)
{
    g_sd_started = 1;
    sd_log("==== requested from the menu (v%s) ====", APP_VERSION);
    unsigned fe = 0, ft = 0; int le = 0;
    gfx_flip_stats(&fe, &ft, &le);
    sd_log("state: overlay %d, tab %d, GPU renderer %s, flip errors %u, timeouts %u", g_overlay, g_tab, gpu_active() ? "ON" : "off", fe, ft);
    sd_log("step 1/6 -> stop sound playback");
    audio_play_stop();
    sd_log("step 1/6 <- done");
    sd_log("step 2/6 -> stop background music thread and close its audio port");
    audio_stop();
    sd_log("step 2/6 <- done");
    sd_log("step 3/6 -> save settings");
    settings_save();
    sd_log("step 3/6 <- done");
    sd_log("step 4/6 -> wait 100 ms for the last frame");
    sceKernelUsleep(100000);
    sd_log("step 4/6 <- done");
    sd_log("step 5/6 -> close the video output (sceVideoOutClose)");
    int vr = gfx_suspend();
    sd_log("step 5/6 <- 0x%08x", (unsigned)vr);
    sd_log("step 6/6 -> sceSystemServiceLoadExec(\"exit\") - if this is the last line, the system took over here");
    int er = sceSystemServiceLoadExec("exit", NULL);
    sd_log("step 6/6 <- returned 0x%08x (unexpected: the call normally does not return); calling exit(0)", (unsigned)er);
    exit(0);
}
static void draw_quit(void)
{
    gfx_rect_blend(0, 0, SCREEN_W, SCREEN_H, RGB(0, 0, 0), 170);
    PANEL(240, 360, SCREEN_W - 480, 300);
    gfx_text(FONT_LARGE, 300, 400, C_ACCENT, "Close Star Ocean Utility Tool?");
    gfx_text(FONT_SMALL, 300, 490, C_TEXT, "Each shutdown step is written to the log file first.");
    gfx_text(FONT_SMALL, 300, 580, C_DIM, GLYPH_CROSS " Close application      " GLYPH_CIRCLE " Cancel");
}

static void draw_progress(void)
{
    char a[64], b[64], line[EX_PATH_MAX + 160];
    gfx_rect_blend(0, 0, SCREEN_W, SCREEN_H, RGB(0, 0, 0), 120);
    PANEL(100, 200, SCREEN_W - 200, SCREEN_H - 400);
    int x = 150, w = SCREEN_W - 300, y = 250;
    static const char *titles[] = { "Extracting", "Creating ZIP", "Copying", "Moving", "Deleting", "Extracting CPK", "Unpacking", "Running script", "Reading packs" };
    gfx_text(FONT_LARGE, x, y, g_progress_kind == PK_DELETE ? C_ERR : C_ACCENT, g_progress_kind == PK_NAMES ? g_nf_what : titles[g_progress_kind]);
    y += 80;

    double overall;
    const char *cur;
    uint64_t done, totb, entry_done = 0, entry_size = 0;
    uint32_t files, warns;
    const char *lastw;
    if (g_progress_kind == PK_NAMES) {
        snprintf(line, sizeof(line), "Packs %u / %u  -  %u entries read, %u names so far  ->  %s/   (read-only)",
                 g_nfjob.packs_done, g_nfjob.packs_total, g_nfjob.entries, g_nfjob.names, g_cpk_dest);
        overall = g_nfjob.packs_total ? (double)g_nfjob.packs_done / g_nfjob.packs_total : 0;
        cur = g_nfjob.current;
        done = g_nfjob.bytes_out; totb = 0;
        files = g_nfjob.entries; warns = g_nfjob.errors; lastw = g_nfjob.error;
    } else if (g_progress_kind == PK_SCRIPT) {
        snprintf(line, sizeof(line), "%s", g_script_path);
        overall = g_sjob.lines_total ? (double)g_sjob.line / g_sjob.lines_total : 0;
        cur = g_sjob.current ? g_sjob.current : "";
        done = 0; totb = 0;
        files = g_sjob.files; warns = g_sjob.failed; lastw = g_sjob.error;
    } else if (g_progress_kind == PK_UNPACK) {
        snprintf(line, sizeof(line), "%s  ->  %s/", g_usrc, g_uout);
        overall = g_utotal ? (double)g_udone / g_utotal : 0;
        cur = g_ujob.current ? g_ujob.current : "";
        done = g_ujob.bytes; totb = 0;
        files = g_ujob.files; warns = g_ujob.failed; lastw = g_ujob.error;
    } else if (g_progress_kind == PK_CPK) {
        if (g_cprog_an > 1) snprintf(line, sizeof(line), "Archive %d of %d: %s  ->  %s/", g_cprog_ai, g_cprog_an, g_cprog_arch, g_cpk_dest);
        else snprintf(line, sizeof(line), "Archive: %s  ->  %s/", g_cprog_arch, g_cpk_dest);
        overall = g_cprog.bytes_total ? (double)g_cprog.bytes_done / g_cprog.bytes_total : 0;
        cur = g_cprog.current ? g_cprog.current : "";
        done = g_cprog.bytes_done; totb = g_cprog.bytes_total;
        files = g_cprog.files_done; warns = g_cprog.files_failed; lastw = g_cprog.error;
    } else if (g_progress_kind >= PK_COPY) {
        if (g_progress_kind == PK_DELETE) snprintf(line, sizeof(line), "Items: %u / %u", g_fjob.items_done, g_fjob.total_items);
        else snprintf(line, sizeof(line), "Into: %s/", g_cwd);
        overall = g_progress_kind == PK_DELETE ?
            (g_fjob.total_items ? (double)g_fjob.items_done / g_fjob.total_items : 0) :
            (g_fjob.total_bytes ? (double)g_fjob.done_bytes / g_fjob.total_bytes :
             g_fjob.total_items ? (double)g_fjob.items_done / g_fjob.total_items : 0);
        cur = g_fjob.current; done = g_fjob.done_bytes; totb = g_fjob.total_bytes;
        files = g_fjob.items_done; warns = g_fjob.warnings; lastw = g_fjob.last_warning;
    } else if (g_progress_kind == PK_ZIP) {
        snprintf(line, sizeof(line), "Output: %s", g_ajob.out_path);
        overall = g_ajob.total_bytes ? (double)g_ajob.done_bytes / g_ajob.total_bytes : 0;
        cur = g_ajob.current; done = g_ajob.done_bytes; totb = g_ajob.total_bytes;
        files = g_ajob.files_done; warns = g_ajob.warnings; lastw = g_ajob.last_warning;
    } else {
        snprintf(line, sizeof(line), "Destination: %s/", g_ejob.dest_dir);
        overall = g_ejob.input_total ? (double)g_ejob.input_done / g_ejob.input_total : 0;
        cur = g_ejob.current_entry; done = g_ejob.bytes_written; totb = 0;
        files = g_ejob.files_done; warns = g_ejob.warnings; lastw = g_ejob.last_warning;
        entry_done = g_ejob.entry_done; entry_size = g_ejob.entry_size;
    }
    gfx_text_clip(FONT_SMALL, x, y, C_DIM, line, w);
    y += 60;

    gfx_text(FONT_SMALL, x, y, C_TEXT, "Overall");
    snprintf(line, sizeof(line), "%.1f%%", overall > 1 ? 100.0 : overall * 100);
    gfx_text(FONT_SMALL, x + w - gfx_text_width(FONT_SMALL, line), y, C_TEXT, line);
    draw_bar(x, y + 40, w, 34, overall);
    y += 110;

    snprintf(line, sizeof(line), "File: %s", cur);
    gfx_text_clip(FONT_SMALL, x, y, C_TEXT, line, w);
    y += 44;
    if (g_progress_kind == PK_EXTRACT && entry_size) {
        fmt_size(entry_done, a, sizeof(a));
        fmt_size(entry_size, b, sizeof(b));
        snprintf(line, sizeof(line), "%s / %s", a, b);
        draw_bar(x, y, w, 22, (double)entry_done / entry_size);
        gfx_text(FONT_SMALL, x, y + 32, C_DIM, line);
        y += 80;
    }

    uint64_t el = (now_us() - g_prog_start) / 1000000;
    char elapsed[32], eta[32] = "--";
    fmt_time(el, elapsed, sizeof(elapsed));
    if (el > 2 && overall > 0.001 && overall < 1) fmt_time((uint64_t)(el * (1 - overall) / overall), eta, sizeof(eta));
    fmt_size(done, a, sizeof(a));
    if (totb) { fmt_size(totb, b, sizeof(b)); snprintf(line, sizeof(line), "%s / %s   Items: %u   Elapsed: %s   Remaining: ~%s", a, b, files, elapsed, eta); }
    else if (g_progress_kind == PK_NAMES)
        snprintf(line, sizeof(line), "Scanned in memory (not saved): %s   Entries: %u   Elapsed: %s   Remaining: ~%s", a, files, elapsed, eta);
    else snprintf(line, sizeof(line), "Written: %s   Files: %u   Elapsed: %s   Remaining: ~%s", a, files, elapsed, eta);
    gfx_text(FONT_SMALL, x, y, C_TEXT, line);
    y += 44;
    if (g_progress_kind == PK_CPK) {
        snprintf(line, sizeof(line), "Files %u of %u:  OK %u   failed %u   skipped %u (already extracted)   written %.2f GB",
                 g_cprog.files_done, g_cprog.files_total, g_cprog.files_ok, g_cprog.files_failed, g_cprog.files_skipped,
                 g_cprog.bytes_written / 1e9);
        gfx_text_clip(FONT_SMALL, x, y, C_DIM, line, w);
        y += 44;
    }
    if (warns) {
        snprintf(line, sizeof(line), g_progress_kind >= PK_CPK ? "Errors: %u  (first: %s)" : "Warnings: %u  (last: %s)", warns, lastw);
        gfx_text_clip(FONT_SMALL, x, y, C_WARN, line, w);
    }
    y += 50;

    if (g_cancel_hold) {
        double h = (now_us() - g_cancel_hold) / 1500000.0;
        gfx_text(FONT_SMALL, x, y, C_ERR, "Keep holding " GLYPH_CIRCLE " to cancel...");
        draw_bar(x + 470, y + 4, 360, 20, h);
    }
    draw_footer(g_progress_kind == PK_DELETE ? "Hold " GLYPH_CIRCLE " to stop (items already deleted stay deleted)"
                                             : "Hold " GLYPH_CIRCLE " to cancel   Keep the app in the foreground");
}

static void draw_done(void)
{
    gfx_rect_blend(0, 0, SCREEN_W, SCREEN_H, RGB(0, 0, 0), 150);
    PANEL(200, 300, SCREEN_W - 400, 440);
    int x = 260, y = 350, w = SCREEN_W - 520;
    gfx_text(FONT_LARGE, x, y, g_done_ok ? C_OK : C_ERR, g_done_head);
    y += 90;
    y = text_wrap(FONT_SMALL, x, y, C_TEXT, g_message, w, 3) + 24;
    gfx_text(FONT_SMALL, x, y, C_DIM, "Log file:");
    gfx_text_clip(FONT_SMALL, x + 170, y, C_DIM, logger_path()[0] ? logger_path() : "(not available)", w - 170);
    gfx_text(FONT_SMALL, x, 680, C_DIM, GLYPH_CROSS " Continue");
}

static void draw_message(void)
{
    gfx_rect_blend(0, 0, SCREEN_W, SCREEN_H, RGB(0, 0, 0), 150);
    PANEL(240, 340, SCREEN_W - 480, 360);
    gfx_text(FONT_LARGE, 300, 380, C_WARN, "Notice");
    text_wrap(FONT_SMALL, 300, 470, C_TEXT, g_message, SCREEN_W - 600, 4);
    gfx_text(FONT_SMALL, 300, 640, C_DIM, GLYPH_CROSS " OK");
}

/* ---------- progress callback (shared by extract + zip) ---------- */
static int on_progress_common(void)
{
    uint64_t t = now_us();
    if (t - g_prog_last_tick > 5000000) { sceSystemServicePowerTick(); g_prog_last_tick = t; } /* stay awake */
    if (t - g_prog_last_draw < 100000) return 0; /* ~10 fps redraw */
    g_prog_last_draw = t;
    pad_poll();
    int cancel = 0;
    if (g_buttons & ORBIS_PAD_BUTTON_CIRCLE) {
        if (!g_cancel_hold) g_cancel_hold = t;
        else if (t - g_cancel_hold > 1500000) cancel = 1;
    } else g_cancel_hold = 0;
    gfx_begin_frame();
    gfx_draw_bg();
    draw_progress();
    gfx_end_frame();
    return cancel;
}
static int ex_cb(ExJob *j, void *u) { (void)j; (void)u; return on_progress_common(); }
static int ac_cb(AcJob *j, void *u) { (void)j; (void)u; return on_progress_common(); }
static int fo_cb(FoJob *j, void *u) { (void)j; (void)u; return on_progress_common(); }

/* ---------- extraction ---------- */
static void start_extract(const char *name)
{
    char path[EX_PATH_MAX];
    path_join(path, sizeof(path), g_cwd, name);
    ex_free_volumes(&g_ejob);
    if (ex_collect_volumes(&g_ejob, path) != 0) {
        logx("Cannot read archive %s", path);
        show_message("Cannot read %s", path);
        return;
    }
    snprintf(g_job_name, sizeof(g_job_name), "%s", name);
    ex_archive_stem(name, g_job_stem, sizeof(g_job_stem));
    path_join(g_dest_options[0], EX_PATH_MAX, g_cwd, g_job_stem);
    path_join(g_dest_options[1], EX_PATH_MAX, g_extract_dir, g_job_stem);
    snprintf(g_dest_options[2], EX_PATH_MAX, "%s", g_cwd);
    g_menu_sel = 0;
    g_overlay = OV_EXTRACT_MENU;
}

static void run_extract_to(const char *dest)
{
    snprintf(g_ejob.dest_dir, sizeof(g_ejob.dest_dir), "%s", dest);
    g_ejob.overwrite = g_opt_overwrite;
    g_prog_start = g_prog_last_draw = now_us();
    g_prog_last_tick = 0;
    g_cancel_hold = 0;
    g_progress_kind = PK_EXTRACT;
    g_overlay = OV_PROGRESS;
    logx("Extract start: %s -> %s (%d vol, %llu bytes, overwrite=%d)", g_job_name, g_ejob.dest_dir,
         g_ejob.volume_count, (unsigned long long)g_ejob.input_total, g_opt_overwrite);

    int rc = ex_run(&g_ejob, ex_cb, NULL);

    logx("Extract end: rc=%d files=%u dirs=%u skipped=%u warnings=%u written=%llu%s%s", rc,
         g_ejob.files_done, g_ejob.dirs_created, g_ejob.files_skipped, g_ejob.warnings,
         (unsigned long long)g_ejob.bytes_written, g_ejob.failed ? " error=" : "", g_ejob.failed ? g_ejob.error : "");
    if (g_ejob.warnings) logx("  last warning: %s", g_ejob.last_warning);

    char w[64];
    fmt_size(g_ejob.bytes_written, w, sizeof(w));
    g_done_ok = (rc == 0);
    snprintf(g_done_head, sizeof(g_done_head), "%s",
             g_ejob.cancelled ? "Cancelled" : rc == 0 ? "Extraction complete" : "Extraction failed");
    if (rc == 0)
        snprintf(g_message, sizeof(g_message), "%u files, %u folders, %s -> %s/%s", g_ejob.files_done,
                 g_ejob.dirs_created, w, g_ejob.dest_dir, g_ejob.warnings ? "  (see log for warnings)" : "");
    else if (g_ejob.cancelled)
        snprintf(g_message, sizeof(g_message), "Cancelled after %u files. Already-extracted files were kept in %s/",
                 g_ejob.files_done, g_ejob.dest_dir);
    else
        snprintf(g_message, sizeof(g_message), "%s", g_ejob.error);
    notify("%s: %s", g_done_head, g_job_name);
    g_overlay = OV_DONE;
}

/* ---------- zip creation ---------- */
/* Deepest folder that contains every marked item (boundary-safe). */
static void common_base(char *out, size_t n)
{
    snprintf(out, n, "%s", g_mark[0]);
    char *s = strrchr(out, '/');
    if (s && s != out) *s = 0; else snprintf(out, n, "/");
    for (int i = 1; i < g_mark_count; i++) {
        while (!ac_path_within(g_mark[i], out)) {
            char *d = strrchr(out, '/');
            if (!d || d == out) { snprintf(out, n, "/"); break; }
            *d = 0;
        }
    }
}

static void run_zip(void)
{
    if (g_mark_count == 0) {
        show_message("Nothing selected. In FILES, press " GLYPH_SQUARE " on the files/folders to include.");
        return;
    }
    memset(&g_ajob, 0, sizeof(g_ajob));
    common_base(g_ajob.base_dir, sizeof(g_ajob.base_dir));
    g_ajob.deflate = g_deflate;

    /* drop items that live inside another selected folder (avoids duplicates) */
    static const char *paths[AC_MAX_ITEMS];
    int np = 0;
    for (int i = 0; i < g_mark_count; i++) {
        int nested = 0;
        for (int k = 0; k < g_mark_count && !nested; k++)
            if (k != i && strcmp(g_mark[i], g_mark[k]) != 0 && ac_path_within(g_mark[i], g_mark[k])) nested = 1;
        if (!nested) paths[np++] = g_mark[i];
    }

    /* name: single item -> its name; several -> their folder's name */
    char base[200];
    if (np == 1) {
        snprintf(base, sizeof(base), "%s", base_name(paths[0]));
        struct stat st;
        char *dot = strrchr(base, '.');
        if (stat(paths[0], &st) == 0 && !S_ISDIR(st.st_mode) && dot && dot != base) *dot = 0;
    } else {
        snprintf(base, sizeof(base), "%s", base_name(g_ajob.base_dir));
    }
    if (!base[0] || !strcmp(base, "/") || (is_device_root(g_ajob.base_dir) && np > 1))
        snprintf(base, sizeof(base), "StarOcean_Archive");

    /* save next to the selected items (never inside them); fall back to /data */
    const char *outdir = dir_writable(g_ajob.base_dir) ? g_ajob.base_dir : "/data";
    unique_path(outdir, base, ".zip", g_ajob.out_path, sizeof(g_ajob.out_path));

    ac_scan(&g_ajob, paths, np);
    uint64_t fs;
    if (!g_deflate && free_space(outdir, &fs) == 0 && fs < g_ajob.total_bytes + (1 << 20)) {
        char need[32], have[32];
        fmt_size(g_ajob.total_bytes, need, sizeof(need));
        fmt_size(fs, have, sizeof(have));
        logx("Zip refused: not enough space in %s (need %s, free %s)", outdir, need, have);
        show_message("Not enough free space in %s (need %s, free %s).", outdir, need, have);
        return;
    }

    g_prog_start = g_prog_last_draw = now_us();
    g_prog_last_tick = 0;
    g_cancel_hold = 0;
    g_progress_kind = PK_ZIP;
    g_overlay = OV_PROGRESS;
    logx("Zip start: %d items -> %s (%u files, %llu bytes, %s)", np, g_ajob.out_path,
         g_ajob.total_files, (unsigned long long)g_ajob.total_bytes, g_deflate ? "deflate" : "store");

    int rc = ac_run(&g_ajob, paths, np, ac_cb, NULL);

    logx("Zip end: rc=%d files=%u dirs=%u skipped=%u%s%s", rc, g_ajob.files_done, g_ajob.dirs_done,
         g_ajob.skipped, g_ajob.failed ? " error=" : "", g_ajob.failed ? g_ajob.error : "");
    if (g_ajob.warnings) logx("  last warning: %s", g_ajob.last_warning);

    g_done_ok = (rc == 0);
    snprintf(g_done_head, sizeof(g_done_head), "%s",
             g_ajob.cancelled ? "Cancelled" : rc == 0 ? "ZIP created" : "ZIP failed");
    if (rc == 0) {
        struct stat st;
        char a[64];
        fmt_size(stat(g_ajob.out_path, &st) == 0 ? (uint64_t)st.st_size : 0, a, sizeof(a));
        snprintf(g_message, sizeof(g_message), "%u files -> %s (%s)%s", g_ajob.files_done, g_ajob.out_path, a,
                 g_ajob.skipped ? "  - some unreadable files were skipped, see log" : "");
        mark_clear(); /* fresh start for the next zip */
    } else if (g_ajob.cancelled) {
        snprintf(g_message, sizeof(g_message), "ZIP creation was cancelled; the partial zip was removed.");
    } else {
        snprintf(g_message, sizeof(g_message), "%s", g_ajob.error);
    }
    notify("%s", g_done_head);
    g_overlay = OV_DONE;
}

/* ---------- copy / move / delete ---------- */
/* Build g_op_paths from the selection (or the highlighted item), dropping
 * entries nested inside another selected folder. Returns count or 0. */
static int gather_targets(int allow_highlight)
{
    g_op_count = 0;
    if (g_mark_count == 0) {
        if (!allow_highlight || !g_cwd[0] || !g_count) return 0;
        path_join(g_single_target, sizeof(g_single_target), g_cwd, g_entries[g_sel].name);
        g_op_paths[g_op_count++] = g_single_target;
        return g_op_count;
    }
    for (int i = 0; i < g_mark_count; i++) {
        int nested = 0;
        for (int k = 0; k < g_mark_count && !nested; k++)
            if (k != i && strcmp(g_mark[i], g_mark[k]) != 0 && ac_path_within(g_mark[i], g_mark[k])) nested = 1;
        if (!nested) g_op_paths[g_op_count++] = g_mark[i];
    }
    return g_op_count;
}

static const char *op_name(int kind) { return kind == PK_COPY ? "Copy" : kind == PK_MOVE ? "Move" : "Delete"; }

static void begin_delete(void)
{
    if (!g_cwd[0]) { show_message("Open a folder first."); return; }
    if (!gather_targets(1)) { show_message("Nothing to delete."); return; }
    for (int i = 0; i < g_op_count; i++)
        if (!source_allowed(g_op_paths[i])) {
            show_message("Refusing to delete %s - only files inside /data, USB drives and extended storage can be deleted.",
                         g_op_paths[i]);
            return;
        }
    fo_reset(&g_fjob);
    fo_scan(&g_fjob, g_op_paths, g_op_count);
    char sz[32];
    fmt_size(g_fjob.total_bytes, sz, sizeof(sz));
    if (g_op_count == 1)
        snprintf(g_confirm_text, sizeof(g_confirm_text), "%s   (%u item%s, %s)", g_op_paths[0],
                 g_fjob.total_items, g_fjob.total_items == 1 ? "" : "s", sz);
    else
        snprintf(g_confirm_text, sizeof(g_confirm_text), "%d selected items: %u files/folders in total, %s",
                 g_op_count, g_fjob.total_items, sz);
    g_overlay = OV_CONFIRM;
}

static void run_fileop(int kind)
{
    if (kind != PK_DELETE) {
        if (!g_cwd[0]) { show_message("Open the destination folder first, then choose %s.", op_name(kind)); return; }
        if (!gather_targets(0)) {
            show_message("Nothing selected. Press " GLYPH_SQUARE " on items, open the destination folder, then OPTIONS > %s.", op_name(kind));
            return;
        }
        if (!dest_allowed(g_cwd) || !dir_writable(g_cwd)) {
            show_message("Can't %s into %s (only /data, USB drives and extended storage are allowed, and it must be writable).",
                         kind == PK_COPY ? "copy" : "move", g_cwd);
            return;
        }
        for (int i = 0; i < g_op_count; i++) {
            if (kind == PK_MOVE && !source_allowed(g_op_paths[i])) {
                show_message("Refusing to move %s - it is outside user storage.", g_op_paths[i]);
                return;
            }
            if (ac_path_within(g_cwd, g_op_paths[i])) {
                show_message("Can't %s \"%s\" into itself. Open a folder outside it first.",
                             kind == PK_COPY ? "copy" : "move", base_name(g_op_paths[i]));
                return;
            }
        }
        /* space check: copies need everything, moves only what crosses drives */
        fo_reset(&g_fjob);
        struct stat dst_st;
        stat(g_cwd, &dst_st);
        uint64_t need = 0;
        for (int i = 0; i < g_op_count; i++) {
            FoJob t;
            fo_reset(&t);
            fo_scan(&t, &g_op_paths[i], 1);
            struct stat st;
            if (kind == PK_COPY || (fo_lstat(g_op_paths[i], &st) == 0 && st.st_dev != dst_st.st_dev)) need += t.total_bytes;
        }
        uint64_t fs;
        if (need && free_space(g_cwd, &fs) == 0 && fs < need + (1 << 20)) {
            char a[32], b[32];
            fmt_size(need, a, sizeof(a));
            fmt_size(fs, b, sizeof(b));
            logx("%s refused: not enough space in %s (need %s, free %s)", op_name(kind), g_cwd, a, b);
            show_message("Not enough free space in %s (need %s, free %s).", g_cwd, a, b);
            return;
        }
        fo_scan(&g_fjob, g_op_paths, g_op_count);
    } /* delete: g_fjob was scanned by begin_delete */

    g_prog_start = g_prog_last_draw = now_us();
    g_prog_last_tick = 0;
    g_cancel_hold = 0;
    g_progress_kind = kind;
    g_overlay = OV_PROGRESS;
    logx("%s start: %d item(s), %u files/folders, %llu bytes%s%s", op_name(kind), g_op_count, g_fjob.total_items,
         (unsigned long long)g_fjob.total_bytes, kind == PK_DELETE ? "" : " -> ", kind == PK_DELETE ? "" : g_cwd);

    int done = 0, same_place = 0;
    for (int i = 0; i < g_op_count; i++) {
        const char *src = g_op_paths[i];
        int rc;
        if (kind == PK_DELETE) {
            rc = fo_delete(&g_fjob, src, fo_cb, NULL);
            logx("  deleted %s%s", src, rc ? " (stopped)" : "");
        } else {
            char parent[EX_PATH_MAX], dst[EX_PATH_MAX];
            struct stat st;
            parent_dir(src, parent, sizeof(parent));
            if (kind == PK_MOVE && strcmp(parent, g_cwd) == 0) { same_place++; continue; } /* already here */
            int is_dir = fo_lstat(src, &st) == 0 && S_ISDIR(st.st_mode);
            unique_target(g_cwd, base_name(src), is_dir, dst, sizeof(dst));
            rc = kind == PK_COPY ? fo_copy(&g_fjob, src, dst, fo_cb, NULL) : fo_move(&g_fjob, src, dst, fo_cb, NULL);
            logx("  %s %s -> %s%s", kind == PK_COPY ? "copied" : "moved", src, dst,
                 rc ? (g_fjob.cancelled ? " (cancelled)" : " (FAILED)") : "");
        }
        if (rc != 0) break;
        done++;
    }
    if (g_fjob.warnings) logx("  %u warning(s), last: %s", g_fjob.warnings, g_fjob.last_warning);
    if (g_fjob.failed) logx("  error: %s", g_fjob.error);

    if (g_fjob.first_failure[0]) logx("  first problem: %s", g_fjob.first_failure);
    int not_deleted = kind == PK_DELETE ? (int)g_fjob.failed_items : 0;
    int ok = !g_fjob.failed && !g_fjob.cancelled && not_deleted == 0;
    g_done_ok = ok && !(kind == PK_DELETE && g_fjob.skipped);
    static const char *verb_done[] = { "", "", "Copy complete", "Move complete", "Delete complete" };
    snprintf(g_done_head, sizeof(g_done_head), "%s",
             g_fjob.cancelled ? (kind == PK_DELETE ? "Stopped" : "Cancelled") :
             g_fjob.failed ? (kind == PK_COPY ? "Copy failed" : kind == PK_MOVE ? "Move failed" : "Delete failed") :
             not_deleted ? (not_deleted == done ? "Delete failed" : "Delete incomplete") :
             verb_done[kind]);
    char sz[32];
    fmt_size(g_fjob.done_bytes, sz, sizeof(sz));
    if (g_fjob.failed)
        snprintf(g_message, sizeof(g_message), "%s  (%d of %d items done; the item in progress was left unchanged)",
                 g_fjob.error, done, g_op_count);
    else if (g_fjob.cancelled)
        snprintf(g_message, sizeof(g_message), kind == PK_DELETE ?
                 "Stopped after %d of %d items. Already-deleted files are gone." :
                 "Cancelled after %d of %d items. The item in progress was left untouched.", done, g_op_count);
    else if (kind == PK_DELETE && not_deleted)
        snprintf(g_message, sizeof(g_message), "%d of %d item(s) could NOT be deleted. Reason: %s",
                 not_deleted, done, g_fjob.first_failure[0] ? g_fjob.first_failure : "unknown (see log)");
    else if (kind == PK_DELETE)
        snprintf(g_message, sizeof(g_message), "Deleted %d item(s), %s.%s", done, sz,
                 g_fjob.skipped ? "  Some files inside could not be deleted - see log." : "");
    else
        snprintf(g_message, sizeof(g_message), "%s %d item(s), %s, into %s/%s%s", kind == PK_COPY ? "Copied" : "Moved",
                 done, sz, g_cwd, same_place ? "  (items already in this folder were skipped)" : "",
                 g_fjob.warnings ? "  See log for warnings." : "");
    logx("%s end: %s", op_name(kind), g_done_head);
    notify("%s", g_done_head);

    if (kind != PK_COPY || ok) mark_clear(); /* moved/deleted paths are no longer valid */
    ensure_cwd_exists();
    /* refresh the list now, so what's behind the result dialog is already current */
    char keep[256] = "";
    if (g_count && g_sel < g_count) snprintf(keep, sizeof(keep), "%s", g_entries[g_sel].name);
    load_dir(keep[0] ? keep : NULL);
    g_overlay = OV_DONE;
}

/* ---------- new folder ---------- */
/* Make a name safe for exFAT/FAT32 and UFS: no path separators or reserved
 * characters, no leading/trailing spaces or trailing dots. */
static int clean_folder_name(const char *in, char *out, size_t n)
{
    size_t o = 0;
    const char *p = in;
    while (*p == ' ') p++;
    for (; *p && o + 1 < n && o < 200; p++) {
        unsigned char c = (unsigned char)*p;
        out[o++] = (c < 0x20 || strchr("/\\:*?\"<>|", c)) ? '_' : (char)c;
    }
    out[o] = 0;
    while (o && (out[o - 1] == ' ' || out[o - 1] == '.')) out[--o] = 0;
    return (o == 0 || !strcmp(out, ".") || !strcmp(out, "..")) ? -1 : 0;
}

static void create_folder(const char *typed, int fallback_unique)
{
    char name[256], path[EX_PATH_MAX];
    if (clean_folder_name(typed, name, sizeof(name)) != 0) {
        show_message("\"%s\" can't be used as a folder name.", typed);
        return;
    }
    if (fallback_unique) unique_target(g_cwd, name, 1, path, sizeof(path));
    else path_join(path, sizeof(path), g_cwd, name);
    if (mkdir(path, 0777) != 0) {
        int e = errno;
        logx("New folder failed: %s (%s)", path, strerror(e));
        if (e == EEXIST) show_message("A file or folder named \"%s\" already exists here.", name);
        else show_message("Could not create the folder: %s", strerror(e));
        return;
    }
    logx("New folder: %s", path);
    load_dir(base_name(path)); /* highlight the new folder */
    if (strcmp(base_name(path), typed) != 0)
        show_message("Created folder \"%s\"", base_name(path));
}

static void begin_new_folder(void)
{
    if (!g_cwd[0]) { show_message("Open a folder (or drive) first, then choose New folder."); return; }
    if (!dest_allowed(g_cwd) || !dir_writable(g_cwd)) {
        show_message("Can't create folders in %s (only /data, USB drives and extended storage, and it must be writable).", g_cwd);
        return;
    }
    g_kbd_purpose = KB_NEWDIR;
    if (kbd_open("New folder name   (R2 = Done)", "New folder", 100) == 0) {
        g_overlay = OV_KEYBOARD;
        return;
    }
    /* keyboard unavailable: still make a folder, with a numbered default name */
    logx("Keyboard unavailable (0x%08x) - creating a default-named folder", (unsigned)kbd_last_error());
    create_folder("New folder", 1);
    if (g_overlay == OV_NONE) show_message("The on-screen keyboard couldn't open, so a folder named \"%s\" was created.",
                                           g_count ? g_entries[g_sel].name : "New folder");
}

/* ---------- CPK archive tools (CRI File System game data) ---------- */
#define SO4_TITLE "CUSA09485"
static const char *so4_dirs[] = {
    "/mnt/sandbox/" SO4_TITLE "_000/app0",
    "/mnt/sandbox/pfsmnt/" SO4_TITLE "-app0",
    NULL
};

enum { CI_HEAD, CI_LIST, CI_MAGIC, CI_VIEW, CI_INNER, CI_NAMES, CI_SEARCH, CI_SKIPREM, CI_ONE, CI_ALL, CI_ALLSET, CI_UNPACKALL, CI_RANGE, CI_DEST, CI_RAW, CI_CLOSE, CI_N };

static int cpk_parsed(void) { return g_cpk_cur == g_cpk_view && g_cpk_rc == 0; }

static void cpk_busy_frame(const char *msg)
{
    gfx_begin_frame();
    gfx_draw_bg();
    draw_header();
    PANEL(240, 440, SCREEN_W - 480, 120);
    gfx_text(FONT_SMALL, 300, 480, C_TEXT, msg);
    gfx_end_frame();
}

/* Free space of the nearest existing folder at or above path. */
static int free_space_near(const char *path, uint64_t *out)
{
    char p[EX_PATH_MAX];
    snprintf(p, sizeof(p), "%s", path);
    for (;;) {
        struct stat st;
        if (stat(p, &st) == 0 && S_ISDIR(st.st_mode)) return free_space(p, out);
        char *s = strrchr(p, '/');
        if (!s || s == p) return free_space("/", out);
        *s = 0;
    }
}

static void hex_line(const uint8_t *b, int n, int off, char *out, size_t on)
{
    int o = snprintf(out, on, "%04X:", off);
    for (int i = 0; i < 16; i++) {
        if (i < n) o += snprintf(out + o, on - o, " %02X", b[i]);
        else o += snprintf(out + o, on - o, "   ");
    }
    o += snprintf(out + o, on - o, "   ");
    for (int i = 0; i < n && o + 2 < (int)on; i++) out[o++] = (b[i] >= 0x20 && b[i] < 0x7F) ? (char)b[i] : '.';
    out[o] = 0;
}

/* Open archive idx (closing the previous one). Logs the STEP 1 facts. */
static void cpk_select(int idx)
{
    if (idx < 0 || idx >= g_cpk_count) return;
    g_cpk_view = idx;
    if (g_cpk_cur == idx) return;
    if (g_cpk_cur >= 0) cpk_close(&g_cpk);
    char msg[EX_PATH_MAX + 40];
    snprintf(msg, sizeof(msg), "Reading archive tables: %s ...", base_name(g_cpk_paths[idx]));
    cpk_busy_frame(msg);
    g_cpk_rc = cpk_open(&g_cpk, g_cpk_paths[idx]);
    g_cpk_cur = idx;
    logx("CPK: %s  size=%llu bytes", g_cpk.path, (unsigned long long)g_cpk.file_size);
    for (int r = 0; r < 4 && r * 16 < g_cpk.head_len; r++) {
        char hl[160];
        int n = g_cpk.head_len - r * 16;
        hex_line(g_cpk.head + r * 16, n > 16 ? 16 : n, r * 16, hl, sizeof(hl));
        logx("CPK:   %s", hl);
    }
    if (g_cpk_rc == 0 && g_cpk.so4)
        logx("CPK:   Star Ocean 4 archive: index in 0000.bin unscrambled and checked; %u files in %s (%u used IDs in total)",
             g_cpk.n, base_name(g_cpk.path), g_cpk.so4_used_all);
    else if (g_cpk_rc == 0)
        logx("CPK:   CPK archive, %u files (%s), TocOffset=0x%llx ItocOffset=0x%llx ContentOffset=0x%llx Align=%llu",
             g_cpk.n, g_cpk.n && g_cpk.e[0].name[0] ? "TOC" : "ITOC", (unsigned long long)g_cpk.toc_off,
             (unsigned long long)g_cpk.itoc_off, (unsigned long long)g_cpk.content_off, (unsigned long long)g_cpk.align);
    else logx("CPK:   %s", g_cpk.error[0] ? g_cpk.error : "could not open");
}

static void open_cpk_set(char paths[][EX_PATH_MAX], int count, int start)
{
    g_cpk_count = count > CPK_MAX_ARCH ? CPK_MAX_ARCH : count;
    for (int i = 0; i < g_cpk_count; i++) snprintf(g_cpk_paths[i], EX_PATH_MAX, "%s", paths[i]);
    if (g_cpk_cur >= 0) { cpk_close(&g_cpk); g_cpk_cur = -1; }
    g_cpk_active = 1;
    g_cpk_sel = 0;
    cpk_select(start);
    g_overlay = OV_CPK;
}

static void close_cpk_screen(void)
{
    if (g_cpk_cur >= 0) cpk_close(&g_cpk);
    g_cpk_cur = -1;
    g_cpk_active = 0;
    g_overlay = OV_NONE;
    if (g_cwd[0]) load_dir(g_count ? g_entries[g_sel].name : NULL); /* show folders/files created meanwhile */
}

/* OPTIONS > Open as CPK: the highlighted file plus sibling CPKs with the same extension. */
static void open_cpk_from_highlight(void)
{
    if (!g_cwd[0] || !g_count || g_entries[g_sel].is_dir) { show_message("Highlight a file first (e.g. 0000.bin), then choose Open as CPK."); return; }
    static char set[CPK_MAX_ARCH][EX_PATH_MAX];
    const char *hn = g_entries[g_sel].name, *hext = strrchr(hn, '.');
    int n = 0, start = 0;
    for (int i = 0; i < g_count && n < CPK_MAX_ARCH; i++) {
        const Entry *e = &g_entries[i];
        if (e->is_dir) continue;
        const char *ext = strrchr(e->name, '.');
        int same_ext = (ext && hext && !strcasecmp(ext, hext)) || (!ext && !hext);
        char full[EX_PATH_MAX];
        path_join(full, sizeof(full), g_cwd, e->name);
        if (i == g_sel) { start = n; snprintf(set[n++], EX_PATH_MAX, "%s", full); }
        else if (same_ext && cpk_probe(full)) snprintf(set[n++], EX_PATH_MAX, "%s", full);
    }
    open_cpk_set(set, n, start);
}

/* Search a drive for a folder holding a CPK 0000.bin (e.g. a game dump copied
 * to USB). Breadth is bounded so a huge drive can't stall the app. A folder
 * whose path mentions CUSA09485 wins over any other match. */
#define SO4_SCAN_DEPTH  4
#define SO4_SCAN_BUDGET 6000
typedef struct { char any[EX_PATH_MAX]; char best[EX_PATH_MAX]; int budget, scanned; } So4Scan;

static int so4_skip_name(const char *n)
{
    return n[0] == '.' || !strcmp(n, "$RECYCLE.BIN") || !strcmp(n, "System Volume Information") ||
           !strcmp(n, "LOST.DIR") || !strncmp(n, "FOUND.", 6);
}

static void so4_scan(const char *dir, int depth, So4Scan *sc)
{
    if (sc->best[0] || sc->budget <= 0) return;
    char p[EX_PATH_MAX];
    snprintf(p, sizeof(p), "%s/0000.bin", dir);
    if (cpk_probe(p)) {
        if (strstr(dir, SO4_TITLE)) { snprintf(sc->best, sizeof(sc->best), "%s", dir); return; }
        if (!sc->any[0]) snprintf(sc->any, sizeof(sc->any), "%s", dir);
    }
    if (depth >= SO4_SCAN_DEPTH) return;
    DIR *d = opendir(dir);
    if (!d) return;
    struct dirent *de;
    while ((de = readdir(d)) && !sc->best[0] && sc->budget > 0) {
        sc->budget--;
        sc->scanned++;
        if (so4_skip_name(de->d_name)) continue;
        if (de->d_type != DT_DIR && de->d_type != DT_UNKNOWN) continue;
        char sub[EX_PATH_MAX];
        if (snprintf(sub, sizeof(sub), "%s/%s", dir, de->d_name) >= (int)sizeof(sub)) continue;
        struct stat st;
        if (stat(sub, &st) != 0 || !S_ISDIR(st.st_mode)) continue;
        so4_scan(sub, depth + 1, sc);
    }
    closedir(d);
}

/* Adds <dir>/0000.bin and 0001.bin (whichever exist) to set. */
static int so4_collect(const char *dir, char set[][EX_PATH_MAX], int n)
{
    for (int k = 0; k < 2 && n < CPK_MAX_ARCH; k++) {
        char p[EX_PATH_MAX];
        struct stat st;
        snprintf(p, sizeof(p), "%s/%04d.bin", dir, k);
        if (stat(p, &st) == 0 && S_ISREG(st.st_mode)) {
            logx("SO4:     %s  %llu bytes", p, (unsigned long long)st.st_size);
            snprintf(set[n++], EX_PATH_MAX, "%s", p);
        } else logx("SO4:     %s not found", p);
    }
    return n;
}

/* TOOLS > Star Ocean 4: the running game's sandbox first, then USB drives / extended storage. */
static void open_so4(void)
{
    static char set[CPK_MAX_ARCH][EX_PATH_MAX];
    int n = 0;
    logx("SO4: looking for " SO4_TITLE " data archives");
    for (int d = 0; so4_dirs[d] && !n; d++) {
        struct stat st;
        int dir_ok = stat(so4_dirs[d], &st) == 0;
        logx("SO4:   %s %s", so4_dirs[d], dir_ok ? "exists" : "not found");
        if (dir_ok) n = so4_collect(so4_dirs[d], set, n);
    }
    if (!n) {
        cpk_busy_frame("Searching USB drives for 0000.bin / 0001.bin ...");
        So4Scan sc;
        for (int u = 0; u <= 8 && !n; u++) {
            char root[32];
            if (u < 8) snprintf(root, sizeof(root), "/mnt/usb%d", u);
            else snprintf(root, sizeof(root), "/mnt/ext0");
            struct stat st;
            if (stat(root, &st) != 0 || !S_ISDIR(st.st_mode)) continue;
            memset(&sc, 0, sizeof(sc));
            sc.budget = SO4_SCAN_BUDGET;
            so4_scan(root, 0, &sc);
            const char *hit = sc.best[0] ? sc.best : sc.any;
            logx("SO4:   %s searched (%d entries%s) - %s", root, sc.scanned, sc.budget <= 0 ? ", search limit reached" : "",
                 hit[0] ? hit : "no CPK 0000.bin found");
            if (hit[0]) n = so4_collect(hit, set, n);
        }
    }
    if (!n) {
        show_message("Star Ocean 4's 0000.bin / 0001.bin were not found. The game's own folder is only there while the game is "
                     "running, and no USB drive had a folder with a CPK 0000.bin (searched 4 folders deep). If your copies are "
                     "elsewhere, highlight 0000.bin and use OPTIONS > Open as CPK archive. (Details in the log.)");
        return;
    }
    open_cpk_set(set, n, 0);
}

static int cpk_dest_ok(void)
{
    if (!dest_allowed(g_cpk_dest)) {
        show_message("Output folder %s is not allowed (use /data, a USB drive or extended storage).", g_cpk_dest);
        return 0;
    }
    if (ex_mkdirs(g_cpk_dest) != 0 || !dir_writable(g_cpk_dest)) {
        show_message("Cannot write to %s: %s", g_cpk_dest, strerror(errno));
        return 0;
    }
    return 1;
}

static int cpk_cb(CpkProgress *p, void *u) { (void)p; (void)u; return on_progress_common(); }

static void cpk_begin_progress(const char *arch, int ai, int an)
{
    snprintf(g_cprog_arch, sizeof(g_cprog_arch), "%s", arch);
    g_cprog_ai = ai;
    g_cprog_an = an;
    g_prog_start = g_prog_last_draw = now_us();
    g_prog_last_tick = 0;
    g_cancel_hold = 0;
    g_progress_kind = PK_CPK;
    g_overlay = OV_PROGRESS;
}


/* ---------- image viewer (DDS / AIF / PNG / BMP / TGA) ---------- */
#define IMG_MAXFILE (256ull << 20)
static uint8_t *g_img;
static uint32_t g_img_w, g_img_h;
static char     g_img_name[300], g_img_desc[80], g_img_dir[EX_PATH_MAX];
static int      g_img_prev_ov, g_img_fit = 1, g_img_bg, g_img_from_files;
static double   g_img_zoom = 1, g_img_cx, g_img_cy;   /* zoom (screen px per image px), view centre */

static void img_close(void)
{
    free(g_img);
    g_img = NULL;
    g_overlay = g_img_prev_ov;
}

static double img_fit_zoom(void)
{
    double zx = (double)SCREEN_W / g_img_w, zy = (double)(SCREEN_H - 130) / g_img_h, z = zx < zy ? zx : zy;
    return z > 8 ? 8 : z;
}

/* Show an image held in memory (takes no ownership of buf). */
static int img_show(const uint8_t *buf, size_t n, const char *name)
{
    uint32_t w, h;
    char desc[80], err[160];
    uint8_t *px = img_decode(buf, n, &w, &h, desc, sizeof(desc), err, sizeof(err));
    if (!px) { show_message("%s: %s", name, err); return -1; }
    free(g_img);
    g_img = px; g_img_w = w; g_img_h = h;
    snprintf(g_img_desc, sizeof(g_img_desc), "%s", desc);
    snprintf(g_img_name, sizeof(g_img_name), "%s", name);
    g_img_fit = 1;
    g_img_zoom = img_fit_zoom();
    g_img_cx = w / 2.0; g_img_cy = h / 2.0;
    if (g_overlay != OV_IMAGE) g_img_prev_ov = g_overlay;
    g_overlay = OV_IMAGE;
    logx("VIEW: %s  %ux%u  %s", name, w, h, desc);
    return 0;
}

static int img_show_fd(int fd, uint64_t off, uint64_t len, const char *name)
{
    if (len > IMG_MAXFILE) { show_message("%s is too large to view (%llu MB).", name, (unsigned long long)(len >> 20)); return -1; }
    uint8_t *b = malloc(len ? (size_t)len : 1);
    if (!b) { show_message("Not enough memory to view %s.", name); return -1; }
    int rc = -1;
    if (pread(fd, b, (size_t)len, (off_t)off) == (ssize_t)len) rc = img_show(b, (size_t)len, name);
    else show_message("Could not read %s.", name);
    free(b);
    return rc;
}

static int file_head(const char *path, uint8_t *b, size_t n)
{
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -1;
    ssize_t r = read(fd, b, n);
    close(fd);
    return r < 0 ? -1 : (int)r;
}

static int ends_ci(const char *s, const char *suf)
{
    size_t a = strlen(s), b = strlen(suf);
    return a >= b && !strcasecmp(s + a - b, suf);
}

/* Is this explorer file something the viewer can show? */
static int file_is_image(const char *path)
{
    uint8_t b[32];
    int n = file_head(path, b, sizeof(b));
    if (n > 0 && img_is_image(b, (size_t)n)) return 1;
    return ends_ci(path, ".tga");
}

static int img_open_path(const char *path)
{
    int fd = open(path, O_RDONLY);
    if (fd < 0) { show_message("Cannot open %s: %s", path, strerror(errno)); return -1; }
    off_t end = lseek(fd, 0, SEEK_END);
    int rc = img_show_fd(fd, 0, end > 0 ? (uint64_t)end : 0, base_name(path));
    close(fd);
    return rc;
}

/* Explorer: open the highlighted image; L1/R1 then step through the folder. */
static void img_open_highlighted(void)
{
    char full[EX_PATH_MAX];
    path_join(full, sizeof(full), g_cwd, g_entries[g_sel].name);
    g_img_from_files = 1;
    snprintf(g_img_dir, sizeof(g_img_dir), "%s", g_cwd);
    img_open_path(full);
}

static void img_step(int dir)
{
    if (!g_img_from_files || !g_count) return;
    for (int k = 1; k < g_count; k++) {
        int i = ((g_sel + dir * k) % g_count + g_count) % g_count;
        if (g_entries[i].is_dir) continue;
        char full[EX_PATH_MAX];
        path_join(full, sizeof(full), g_cwd, g_entries[i].name);
        if (!file_is_image(full)) continue;
        g_sel = i;
        if (img_open_path(full) != 0 && g_img) g_return_image = 1; /* stay in the viewer */
        return;
    }
}

static void img_save_png(void)
{
    if (!g_img) return;
    if (!dest_allowed(g_extract_dir) || ex_mkdirs(g_extract_dir) != 0) { show_message("Cannot write to %s.", g_extract_dir); return; }
    char nm[300], out[EX_PATH_MAX + 320];
    snprintf(nm, sizeof(nm), "%s", g_img_name);
    char *dot = strrchr(nm, '.');
    if (dot && dot != nm) *dot = 0;
    for (char *c = nm; *c; c++) if (*c == '/' || *c == ':') *c = '_';
    snprintf(out, sizeof(out), "%s/%s.png", g_extract_dir, nm);
    int rc = png_write(out, g_img, g_img_w, g_img_h);
    logx("VIEW: saved %s as %s (%s)", g_img_name, out, rc == 0 ? "OK" : "FAILED");
    if (rc == 0) show_message("Saved %s (%ux%u PNG).", out, g_img_w, g_img_h);
    else show_message("Could not write %s.", out);
}

static void draw_image_view(void)
{
    gfx_clear(RGB(0, 0, 0));
    int top = 70, area_h = SCREEN_H - 130;
    double z = g_img_zoom;
    int64_t step = (int64_t)(65536.0 / z);
    if (step < 1) step = 1;
    /* screen centre of the image area shows (cx, cy) */
    double sx0 = g_img_cx - (SCREEN_W / 2.0) / z, sy0 = g_img_cy - (area_h / 2.0) / z;
    int dw = (int)(g_img_w * z + 0.5), dh = (int)(g_img_h * z + 0.5);
    int dx = (int)((0 - sx0) * z), dy = top + (int)((0 - sy0) * z);
    if (g_img) gfx_image(dx, dy, dw, dh, g_img, (int)g_img_w, (int)g_img_h, 0, 0, step, g_img_bg);
    gfx_rect_blend(0, 0, SCREEN_W, top, RGB(8, 14, 30), 230);
    char line[600];
    snprintf(line, sizeof(line), "%s   %ux%u   %s   %d%%%s", g_img_name, g_img_w, g_img_h, g_img_desc, (int)(z * 100 + 0.5),
             g_img_fit ? " (fit)" : "");
    gfx_text_clip(FONT_SMALL, 30, 20, C_TEXT, line, SCREEN_W - 60);
    gfx_rect_blend(0, SCREEN_H - 60, SCREEN_W, 60, RGB(8, 14, 30), 230);
    gfx_text_clip(FONT_SMALL, 30, SCREEN_H - 46, C_DIM,
                  g_img_from_files ? GLYPH_CIRCLE " Back  " GLYPH_CROSS " Fit/100%  L2/R2 zoom  D-pad pan  " GLYPH_TRIANGLE " Background  "
                                     GLYPH_SQUARE " Save PNG  L1/R1 prev/next image"
                                   : GLYPH_CIRCLE " Back  " GLYPH_CROSS " Fit/100%  L2/R2 zoom  D-pad pan  " GLYPH_TRIANGLE " Background  "
                                     GLYPH_SQUARE " Save PNG",
                  SCREEN_W - 60);
}

static void update_image_view(void)
{
    if (pressed(ORBIS_PAD_BUTTON_CIRCLE)) { img_close(); return; }
    if (pressed(ORBIS_PAD_BUTTON_CROSS)) {
        g_img_fit = !g_img_fit;
        g_img_zoom = g_img_fit ? img_fit_zoom() : 1.0;
        if (g_img_fit) { g_img_cx = g_img_w / 2.0; g_img_cy = g_img_h / 2.0; }
    }
    if (repeat(ORBIS_PAD_BUTTON_R2) && g_img_zoom < 32) { g_img_zoom *= 2; g_img_fit = 0; }
    if (repeat(ORBIS_PAD_BUTTON_L2) && g_img_zoom > img_fit_zoom() / 8) { g_img_zoom /= 2; g_img_fit = 0; }
    double stepx = SCREEN_W / 8.0 / g_img_zoom, stepy = SCREEN_H / 8.0 / g_img_zoom;
    if (repeat(ORBIS_PAD_BUTTON_LEFT)) g_img_cx -= stepx;
    if (repeat(ORBIS_PAD_BUTTON_RIGHT)) g_img_cx += stepx;
    if (repeat(ORBIS_PAD_BUTTON_UP)) g_img_cy -= stepy;
    if (repeat(ORBIS_PAD_BUTTON_DOWN)) g_img_cy += stepy;
    if (g_img_cx < 0) g_img_cx = 0;
    if (g_img_cy < 0) g_img_cy = 0;
    if (g_img_cx > g_img_w) g_img_cx = g_img_w;
    if (g_img_cy > g_img_h) g_img_cy = g_img_h;
    if (pressed(ORBIS_PAD_BUTTON_TRIANGLE)) g_img_bg = (g_img_bg + 1) % 3;
    if (pressed(ORBIS_PAD_BUTTON_SQUARE)) { img_save_png(); if (g_overlay == OV_MESSAGE) g_return_image = 1; }
    if (pressed(ORBIS_PAD_BUTTON_R1)) img_step(1);
    if (pressed(ORBIS_PAD_BUTTON_L1)) img_step(-1);
}

/* ---------- unpack / convert engine (formats.c) ---------- */
static const char *UNPACK_SUPPORTED =
    "Supported: tri-Ace KCAP/SLZ, AIF textures (-> PNG), ASF models (-> glTF), AAC sounds (-> .at9), EXD text (-> .txt), PSARC, Wwise .pck/.bnk, CRI AFS/AWB, LZ4, DDS (-> PNG).";

static int ujob_cb(void *u) { (void)u; return on_progress_common(); }

static void unpack_begin(const char *src, const char *out)
{
    memset(&g_ujob, 0, sizeof(g_ujob));
    g_ujob.cb = ujob_cb;
    snprintf(g_usrc, sizeof(g_usrc), "%s", src);
    snprintf(g_uout, sizeof(g_uout), "%s", out);
    g_udone = g_utotal = 0;
    g_prog_start = g_prog_last_draw = now_us();
    g_prog_last_tick = 0;
    g_cancel_hold = 0;
    g_progress_kind = PK_UNPACK;
    g_overlay = OV_PROGRESS;
}

static FILE *unpack_log_open(const char *out)
{
    if (ex_mkdirs(out) != 0) return NULL;
    char p[EX_PATH_MAX + 32];
    snprintf(p, sizeof(p), "%s/_unpack_log.txt", out);
    FILE *f = fopen(p, "a");
    if (f) fprintf(f, "# ---- %s ----\n# output\tbytes\tresult\n", g_usrc);
    return f;
}

static void unpack_finish(int rc, const char *what)
{
    char w[32];
    fmt_size(g_ujob.bytes, w, sizeof(w));
    if (g_ujob.log) {
        fprintf(g_ujob.log, "# summary: %s - %u files written (%llu bytes), %u failed%s%s%s\n", what, g_ujob.files,
                (unsigned long long)g_ujob.bytes, g_ujob.failed, rc == -2 ? ", CANCELLED" : "",
                g_ujob.error[0] ? ", first error: " : "", g_ujob.error);
        fclose(g_ujob.log);
        g_ujob.log = NULL;
    }
    logx("UNPACK: %s -> %s: %s, %u files, %u failed%s%s", g_usrc, g_uout, what, g_ujob.files, g_ujob.failed,
         g_ujob.error[0] ? " - " : "", g_ujob.error);
    g_done_ok = rc == 0 && !g_ujob.failed;
    snprintf(g_done_head, sizeof(g_done_head), "%s", rc == -2 ? "Cancelled" : !g_ujob.files ? "Nothing unpacked" :
             g_ujob.failed ? "Finished with errors" : "Unpacked");
    snprintf(g_message, sizeof(g_message), "%s: %u file(s), %s written to %s/  (list: _unpack_log.txt)", what, g_ujob.files, w, g_uout);
    if (g_ujob.failed || g_ujob.error[0]) {
        size_t l = strlen(g_message);
        snprintf(g_message + l, sizeof(g_message) - l, ". %u item%s failed - first: %s", g_ujob.failed, g_ujob.failed == 1 ? "" : "s", g_ujob.error);
    }
    g_overlay = OV_DONE;
}

/* Unpack/convert the data at (fd, off, len). Returns 0 if a job ran. */
static int unpack_at(int fd, uint64_t off, uint64_t len, const char *hint, const char *srcname, const char *out)
{
    char desc[160];
    if (!fmt_identify(fd, off, len, desc, sizeof(desc))) {
        show_message("%s: %s - not a format this tool unpacks yet. %s (ZIP/RAR/7z: highlight it and press X.)",
                     srcname, desc, UNPACK_SUPPORTED);
        return -1;
    }
    unpack_begin(srcname, out);
    g_ujob.log = unpack_log_open(out);
    int rc = fmt_unpack(fd, off, len, hint, out, &g_ujob);
    unpack_finish(rc, g_ujob.kind[0] ? g_ujob.kind : desc);
    return 0;
}

static int unpack_dest_ok(const char *dir)
{
    if (!dest_allowed(dir)) { show_message("Output folder %s is not allowed (use /data, a USB drive or extended storage).", dir); return 0; }
    if (ex_mkdirs(dir) != 0 || !dir_writable(dir)) { show_message("Cannot write to %s: %s", dir, strerror(errno)); return 0; }
    return 1;
}

/* FILES > OPTIONS > Unpack / convert */
static void unpack_highlighted(void)
{
    if (!g_cwd[0] || !g_count || g_entries[g_sel].is_dir) { show_message("Highlight a file first. %s", UNPACK_SUPPORTED); return; }
    char src[EX_PATH_MAX], out[EX_PATH_MAX + 16], nm[300];
    path_join(src, sizeof(src), g_cwd, g_entries[g_sel].name);
    if (cpk_probe(src)) { open_cpk_from_highlight(); return; }   /* CPK / Star Ocean 4 archives: Archive tools */
    if (!unpack_dest_ok(g_extract_dir)) return;
    snprintf(nm, sizeof(nm), "%s_unpacked", g_entries[g_sel].name);
    path_join(out, sizeof(out), g_extract_dir, nm);
    int fd = open(src, O_RDONLY);
    if (fd < 0) { show_message("Cannot open %s: %s", src, strerror(errno)); return; }
    off_t end = lseek(fd, 0, SEEK_END);
    if (end > 0) unpack_at(fd, 0, (uint64_t)end, g_entries[g_sel].name, g_entries[g_sel].name, out);
    else show_message("%s is empty.", src);
    close(fd);
}

static void cpk_entry_label(const CpkEntry *e, char *o, size_t n)
{
    if (g_cpk.so4 || !e->name[0]) snprintf(o, n, "%05u", e->id);
    else snprintf(o, n, "%s%s%s", e->dir, e->dir[0] ? "/" : "", e->name);
}

/* Archive list viewer: triangle on an entry, read straight from the archive. */
static void unpack_viewer_entry(void)
{
    if (!cpk_parsed() || !g_cpk.n) return;
    const CpkEntry *e = &g_cpk.e[g_lv_sel];
    if (e->beyond_end) { show_message("This entry lies beyond the end of the archive file."); g_return_view = 1; return; }
    if (e->xsize > e->size) { show_message("This entry is CRILAYLA-compressed: use Extract first (it unpacks CRILAYLA), then unpack the result."); g_return_view = 1; return; }
    if (!unpack_dest_ok(g_cpk_dest)) { g_return_view = 1; return; }
    char stem[256], lab[300], out[EX_PATH_MAX + 64], src[400];
    cpk_stem(g_cpk.path, stem, sizeof(stem));
    cpk_entry_label(e, lab, sizeof(lab));
    for (char *c = lab; *c; c++) if (*c == '/') *c = '_';
    snprintf(out, sizeof(out), "%s/%s_unpacked/%s", g_cpk_dest, stem, lab);
    snprintf(src, sizeof(src), "%s : %s", base_name(g_cpk.path), lab);
    unpack_at(g_cpk.fd, e->offset, e->size, lab, src, out);
    g_return_view = 1;
}

/* Archive tools: unpack/convert every recognised entry of the shown archive.
 * Each entry goes to <dest>/<archive>_unpacked/<ID>/ via a .part folder, so a
 * stopped run continues where it left off. */
static void unpack_all_entries(void)
{
    if (!cpk_parsed()) { show_message("This file is not a readable archive."); return; }
    if (!unpack_dest_ok(g_cpk_dest)) return;
    char stem[256], root[EX_PATH_MAX + 32];
    cpk_stem(g_cpk.path, stem, sizeof(stem));
    snprintf(root, sizeof(root), "%s/%s_unpacked", g_cpk_dest, stem);
    unpack_begin(base_name(g_cpk.path), root);
    g_ujob.log = unpack_log_open(root);
    g_utotal = g_cpk.n;
    uint32_t done_before = 0, unsupported = 0, units = 0;
    int rc = 0;
    for (uint32_t i = 0; i < g_cpk.n && !g_ujob.cancelled; i++, g_udone++) {
        const CpkEntry *e = &g_cpk.e[i];
        char desc[160], lab[300], fin[EX_PATH_MAX + 400], part[EX_PATH_MAX + 420];
        if (e->beyond_end || e->xsize > e->size || !fmt_identify(g_cpk.fd, e->offset, e->size, desc, sizeof(desc))) { unsupported++; continue; }
        cpk_entry_label(e, lab, sizeof(lab));
        for (char *c = lab; *c; c++) if (*c == '/') *c = '_';
        snprintf(fin, sizeof(fin), "%s/%s", root, lab);
        struct stat st;
        if (stat(fin, &st) == 0) { done_before++; continue; }
        snprintf(part, sizeof(part), "%s.part", fin);
        g_ujob.depth = 0;
        int r = fmt_unpack(g_cpk.fd, e->offset, e->size, lab, part, &g_ujob);
        if (r == -2) { rc = -2; break; }
        units++;
        if (rename(part, fin) != 0) { g_ujob.failed++; if (!g_ujob.error[0]) snprintf(g_ujob.error, sizeof(g_ujob.error), "cannot finish %s", fin); }
        if (on_progress_common()) { g_ujob.cancelled = 1; rc = -2; }
    }
    char what[200];
    snprintf(what, sizeof(what), "%s: %u entries unpacked now, %u done earlier, %u not a known format", base_name(g_cpk.path),
             units, done_before, unsupported);
    unpack_finish(g_ujob.cancelled ? -2 : rc, what);
}

static void cpk_header_dump(void)
{
    if (!cpk_dest_ok()) return;
    char stem[256], out[EX_PATH_MAX], err[256] = "";
    cpk_stem(g_cpk_paths[g_cpk_view], stem, sizeof(stem));
    snprintf(out, sizeof(out), "%s/%s_head.bin", g_cpk_dest, stem);
    memset(&g_cprog, 0, sizeof(g_cprog));
    cpk_begin_progress(base_name(g_cpk_paths[g_cpk_view]), 1, 1);
    int rc = cpk_dump_range(g_cpk_paths[g_cpk_view], 0, 0x100000, out, &g_cprog, cpk_cb, NULL, err, sizeof(err));
    logx("CPK: header dump %s -> %s (%s)", g_cpk_paths[g_cpk_view], out, rc == 0 ? "OK" : err);
    if (rc == 0) show_message("Saved the first 1 MiB to %s. The first 64 bytes are also in the log.", out);
    else show_message("Header dump failed: %s", err);
}

static void cpk_save_listing(void)
{
    if (!cpk_parsed()) { show_message("This file is not a readable CPK archive, so there is no file list."); return; }
    if (!cpk_dest_ok()) return;
    if (g_cpk.so4) { /* one list per archive, written together, whichever tab is shown */
        char done[600] = "";
        int fails = 0;
        for (int a = 0; a < g_cpk_count; a++) {
            Cpk t, *c = &t;
            int rc;
            if (a == g_cpk_cur) { c = &g_cpk; rc = g_cpk_rc; }
            else rc = cpk_open(&t, g_cpk_paths[a]);
            char stem[256], out[EX_PATH_MAX], msg[EX_PATH_MAX + 40];
            cpk_stem(g_cpk_paths[a], stem, sizeof(stem));
            snprintf(out, sizeof(out), "%s/listing_%s.txt", g_cpk_dest, stem);
            snprintf(msg, sizeof(msg), "Writing %s (reading each file's first bytes)...", base_name(out));
            cpk_busy_frame(msg);
            int w = rc == 0 && c->so4 ? cpk_write_listing(c, out) : -1;
            logx("CPK: listing %s -> %s (%s)", g_cpk_paths[a], out, w == 0 ? "OK" : "FAILED");
            if (w == 0) {
                size_t l = strlen(done);
                snprintf(done + l, sizeof(done) - l, "%s%s (%u files)", l ? " and " : "", base_name(out), c->n);
            } else fails++;
            if (c == &t) cpk_close(&t);
        }
        if (fails) show_message("Saved %s to %s. %d list(s) could not be written (see log).", done[0] ? done : "nothing", g_cpk_dest, fails);
        else show_message("Saved %s to %s. Each line: ID, archive, offset, size, readable size, format.", done, g_cpk_dest);
        return;
    }
    char stem[256], out[EX_PATH_MAX];
    cpk_stem(g_cpk.path, stem, sizeof(stem));
    snprintf(out, sizeof(out), "%s/listing_%s.txt", g_cpk_dest, stem);
    int rc = cpk_write_listing(&g_cpk, out);
    logx("CPK: listing %s -> %s (%s)", g_cpk.path, out, rc == 0 ? "OK" : strerror(errno));
    if (rc == 0) show_message("Saved the list of %u files to %s", g_cpk.n, out);
    else show_message("Could not write %s: %s", out, strerror(errno));
}

/* Find q (name, Dir/File or ID) in the open archive or, for Star Ocean 4, in the
 * other archive (switching to it), then extract it. Returns 0 OK, -2 not found. */
static int cpk_extract_query(const char *q, char *saved, size_t sn, char *err, size_t en, int *crila)
{
    int idx = cpk_find(&g_cpk, q);
    for (int a = 0; idx < 0 && g_cpk.so4 && a < g_cpk_count; a++) { /* SO4: an ID may live in the other archive */
        if (a == g_cpk_view) continue;
        Cpk t;
        int found = cpk_open(&t, g_cpk_paths[a]) == 0 && cpk_find(&t, q) >= 0;
        cpk_close(&t);
        if (found) { cpk_select(a); idx = cpk_find(&g_cpk, q); }
    }
    if (idx < 0) { snprintf(err, en, "not found"); saved[0] = 0; return -2; }
    char od[EX_PATH_MAX];
    if (g_cpk.so4) { /* <dest>/<archive>/<ID>.bin, same place Extract ALL uses */
        char stem[256];
        cpk_stem(g_cpk.path, stem, sizeof(stem));
        snprintf(od, sizeof(od), "%s/%s", g_cpk_dest, stem);
    } else snprintf(od, sizeof(od), "%s", g_cpk_dest);
    int rc = cpk_extract_one(&g_cpk, (uint32_t)idx, od, saved, sn, err, en);
    const CpkEntry *e = &g_cpk.e[idx];
    if (crila) *crila = e->xsize > e->size;
    logx("CPK: extract one '%s' (ID %u, %s%s%s) -> %s (%s)", q, e->id, e->dir, e->dir[0] ? "/" : "", e->name, saved, rc == 0 ? "OK" : err);
    return rc;
}

/* Typed text: one name/ID, or several IDs and ranges, e.g. "0-3 10 100 656 657". */
static void cpk_extract_one_named(const char *typed)
{
    if (!cpk_parsed()) return;
    char q[512];
    snprintf(q, sizeof(q), "%s", typed);
    char *s0 = q;
    while (*s0 == ' ' || *s0 == '\t') s0++;
    for (size_t l = strlen(s0); l && (s0[l - 1] == ' ' || s0[l - 1] == '\t' || s0[l - 1] == '\r' || s0[l - 1] == '\n'); l--) s0[l - 1] = 0;
    logx("CPK: extract request \"%s\"", s0);
    if (!*s0) { show_message("Nothing was typed. Enter a name or ID, or several IDs like  0-3 10 100 656 657"); return; }
    if (!cpk_dest_ok()) return;

    /* list of IDs? only digits, spaces, commas and '-' */
    int is_list = 1, has_sep = 0;
    for (const char *c = s0; *c; c++) {
        if (*c == ' ' || *c == ',' || *c == '-') has_sep = 1;
        else if (*c < '0' || *c > '9') is_list = 0;
    }
    char saved[EX_PATH_MAX], err[256] = "";
    if (!is_list || !has_sep) {
        cpk_busy_frame("Extracting...");
        int crila = 0, rc = cpk_extract_query(s0, saved, sizeof(saved), err, sizeof(err), &crila);
        if (rc == -2) { show_message("No file named or numbered \"%s\". Use View file list to see the IDs.", s0); return; }
        if (rc == 0) {
            struct stat st;
            char sz[32];
            fmt_size(stat(saved, &st) == 0 ? (uint64_t)st.st_size : 0, sz, sizeof(sz));
            show_message("Saved %s (%s%s)", saved, sz, crila ? ", unpacked from CRILAYLA" : "");
        } else show_message("Extract failed: %s", err);
        return;
    }
    static char report[1400];
    int ok = 0, bad = 0, missing = 0, total = 0;
    report[0] = 0;
    char *save = NULL;
    for (char *tok = strtok_r(s0, " ,", &save); tok; tok = strtok_r(NULL, " ,", &save)) {
        unsigned long a = strtoul(tok, NULL, 10), b = a;
        char *dash = strchr(tok, '-');
        if (dash) b = strtoul(dash + 1, NULL, 10);
        if (b < a) { unsigned long t = a; a = b; b = t; }
        if (b - a > 199) b = a + 199;
        for (unsigned long id = a; id <= b && total < 200; id++) {
            char one[16], msg[64];
            snprintf(one, sizeof(one), "%lu", id);
            snprintf(msg, sizeof(msg), "Extracting ID %lu ...", id);
            cpk_busy_frame(msg);
            total++;
            int rc = cpk_extract_query(one, saved, sizeof(saved), err, sizeof(err), NULL);
            size_t l = strlen(report);
            if (rc == 0) { ok++; snprintf(report + l, sizeof(report) - l, "%s%s", ok + bad > 1 ? ", " : "", base_name(saved)); }
            else if (rc == -2) missing++;
            else { bad++; snprintf(report + l, sizeof(report) - l, "%sID %lu FAILED (%s)", ok + bad > 1 ? ", " : "", id, err); }
        }
    }
    char miss[48] = "";
    if (missing) snprintf(miss, sizeof(miss), ". %d unused ID%s skipped", missing, missing == 1 ? "" : "s");
    show_message("%d of %d saved in %s (subfolders 0000 / 0001): %s%s", ok, total, g_cpk_dest, report[0] ? report : "-", miss);
}

static void cpk_dump_typed_range(const char *t)
{
    char *end;
    uint64_t off = strtoull(t, &end, 0);
    while (*end == ' ' || *end == ',' || *end == '\t') end++;
    char *end2;
    uint64_t len = strtoull(end, &end2, 0);
    if (end == t || end2 == end || len == 0) { show_message("Type the offset and length, e.g.  0x1000 0x100000"); return; }
    if (!cpk_dest_ok()) return;
    char stem[256], out[EX_PATH_MAX], err[256] = "";
    cpk_stem(g_cpk_paths[g_cpk_view], stem, sizeof(stem));
    snprintf(out, sizeof(out), "%s/%s_%llx_%llx.bin", g_cpk_dest, stem, (unsigned long long)off, (unsigned long long)len);
    memset(&g_cprog, 0, sizeof(g_cprog));
    cpk_begin_progress(base_name(g_cpk_paths[g_cpk_view]), 1, 1);
    int rc = cpk_dump_range(g_cpk_paths[g_cpk_view], off, len, out, &g_cprog, cpk_cb, NULL, err, sizeof(err));
    logx("CPK: dump range 0x%llx+0x%llx of %s -> %s (%s)", (unsigned long long)off, (unsigned long long)len,
         g_cpk_paths[g_cpk_view], out, rc == 0 ? "OK" : err);
    if (rc == 0) show_message("Saved %s", out);
    else show_message("Dump failed: %s", err);
}

/* Prepare "extract all": sizes still to write vs free space, then confirm. */
static void cpk_prepare_all(int all)
{
    if (!all && !cpk_parsed()) { show_message("This file is not a CPK archive, so Extract all is disabled for it."); return; }
    if (!dest_allowed(g_cpk_dest)) { show_message("Output folder %s is not allowed (use /data, a USB drive or extended storage).", g_cpk_dest); return; }
    cpk_busy_frame("Checking what still needs extracting...");
    CpkOptions o = { g_cpk_keep_raw, 1 };
    g_cpk_scope_all = all;
    g_cpk_need = 0;
    g_cpk_left = 0;
    g_cpk_files_total = 0;
    g_cpk_bytes_total = 0;
    int usable = 0;
    for (int i = 0; i < g_cpk_count; i++) {
        if (!all && i != g_cpk_view) continue;
        Cpk tmp, *c = &tmp;
        int rc;
        if (i == g_cpk_cur) { c = &g_cpk; rc = g_cpk_rc; }
        else rc = cpk_open(&tmp, g_cpk_paths[i]);
        if (rc == 0) {
            char stem[256], od[EX_PATH_MAX];
            cpk_stem(c->path, stem, sizeof(stem));
            snprintf(od, sizeof(od), "%s/%s", g_cpk_dest, stem);
            uint32_t left = 0;
            g_cpk_need += cpk_bytes_needed(c, od, &o, &left);
            g_cpk_left += left;
            g_cpk_files_total += c->n;
            for (uint32_t k = 0; k < c->n; k++) g_cpk_bytes_total += c->e[k].size;
            usable++;
        }
        if (c == &tmp) cpk_close(&tmp);
    }
    if (!usable) { show_message("None of these files is a readable CPK archive."); return; }
    g_cpk_free_ok = free_space_near(g_cpk_dest, &g_cpk_free) == 0;
    if (g_cpk_free_ok && g_cpk_free < g_cpk_need + (64u << 20)) {
        char a[32], b[32];
        fmt_size(g_cpk_need, a, sizeof(a));
        fmt_size(g_cpk_free, b, sizeof(b));
        logx("CPK: extract all refused - needs %s, free %s at %s", a, b, g_cpk_dest);
        show_message("Not enough space at %s: the remaining files need %s, but only %s is free. Pick another output folder.",
                     g_cpk_dest, a, b);
        return;
    }
    g_overlay = OV_CPK_CONFIRM;
}

static void cpk_run_all(void)
{
    if (!cpk_dest_ok()) return;
    char logpath[EX_PATH_MAX];
    snprintf(logpath, sizeof(logpath), "%s/extract_log.txt", g_cpk_dest);
    FILE *log = fopen(logpath, "a");
    if (log) fprintf(log, "# ---- extract all, keep_raw=%d, resume=on ----\n# archive\tID\tpath\toffset\tsize\textract_size\tresult\n", g_cpk_keep_raw);
    memset(&g_cprog, 0, sizeof(g_cprog));
    g_cprog.files_total = g_cpk_files_total;
    g_cprog.bytes_total = g_cpk_bytes_total;
    CpkOptions o = { g_cpk_keep_raw, 1 };

    int an = 0;
    for (int i = 0; i < g_cpk_count; i++) if (g_cpk_scope_all || i == g_cpk_view) an++;
    int ai = 0;
    for (int i = 0; i < g_cpk_count && !g_cprog.cancelled && !g_cprog.failed; i++) {
        if (!g_cpk_scope_all && i != g_cpk_view) continue;
        ai++;
        Cpk tmp, *c = &tmp;
        int rc;
        if (i == g_cpk_cur) { c = &g_cpk; rc = g_cpk_rc; }
        else rc = cpk_open(&tmp, g_cpk_paths[i]);
        char stem[256], od[EX_PATH_MAX], lst[EX_PATH_MAX];
        cpk_stem(g_cpk_paths[i], stem, sizeof(stem));
        if (rc != 0) {
            if (log) fprintf(log, "%s\t-\t-\t-\t-\t-\tSKIPPED ARCHIVE: %s\n", stem, c->error[0] ? c->error : "not a CPK");
            logx("CPK: %s skipped (%s)", g_cpk_paths[i], c->error);
            if (c == &tmp) cpk_close(&tmp);
            continue;
        }
        snprintf(lst, sizeof(lst), "%s/listing_%s.txt", g_cpk_dest, stem);
        cpk_write_listing(c, lst);
        snprintf(od, sizeof(od), "%s/%s", g_cpk_dest, stem);
        cpk_begin_progress(base_name(g_cpk_paths[i]), ai, an);
        logx("CPK: extract all %s -> %s (%u files)", g_cpk_paths[i], od, c->n);
        cpk_extract_all(c, od, &o, log, &g_cprog, cpk_cb, NULL);
        if (c == &tmp) cpk_close(&tmp);
    }
    char w[32];
    fmt_size(g_cprog.bytes_written, w, sizeof(w));
    if (log) {
        fprintf(log, "# summary: files OK %u, failed %u, skipped (already extracted) %u, bytes written %llu%s\n",
                g_cprog.files_ok, g_cprog.files_failed, g_cprog.files_skipped, (unsigned long long)g_cprog.bytes_written,
                g_cprog.cancelled ? ", CANCELLED" : g_cprog.failed ? ", STOPPED" : "");
        fclose(log);
    }
    logx("CPK: extract all done - OK %u, failed %u, skipped %u, written %s%s", g_cprog.files_ok, g_cprog.files_failed,
         g_cprog.files_skipped, w, g_cprog.cancelled ? " (cancelled)" : "");
    g_done_ok = !g_cprog.cancelled && !g_cprog.files_failed && !g_cprog.failed;
    snprintf(g_done_head, sizeof(g_done_head), "%s", g_cprog.cancelled ? "Cancelled" :
             (g_cprog.files_failed || g_cprog.failed) ? "Finished with errors" : "Extraction complete");
    snprintf(g_message, sizeof(g_message), "OK %u, failed %u, already done %u. Written %s to %s/. %s%s%s",
             g_cprog.files_ok, g_cprog.files_failed, g_cprog.files_skipped, w, g_cpk_dest,
             g_cprog.cancelled ? "Run it again to continue where it stopped. " : "",
             g_cprog.error[0] ? "First error: " : "", g_cprog.error);
    size_t ml = strlen(g_message);
    snprintf(g_message + ml, sizeof(g_message) - ml, "  Per-file log: %s", logpath);
    notify("CPK: %s", g_done_head);
    g_overlay = OV_DONE;
}

static void cpk_keyboard(int purpose, const char *title, const char *initial)
{
    g_kbd_purpose = purpose;
    if (kbd_open(title, initial, 120) == 0) { g_overlay = OV_KEYBOARD; return; }
    show_message("The on-screen keyboard could not be opened (0x%08x).", (unsigned)kbd_last_error());
}

static void draw_cpk(void)
{
    gfx_rect_blend(0, 0, SCREEN_W, SCREEN_H, RGB(0, 0, 0), 210);
    PANEL(60, 160, SCREEN_W - 120, 850);
    int x = 100, w = SCREEN_W - 200, y = 176;
    gfx_text(FONT_LARGE, x, y, C_ACCENT, "Archive tools");
    gfx_text(FONT_SMALL, x + 520, y + 10, C_DIM, "read-only: the archive itself is never changed");
    y += 62;
    if (g_cpk_count > 1) { /* archive tabs */
        int tx = x;
        for (int i = 0; i < g_cpk_count; i++) {
            const char *nm = base_name(g_cpk_paths[i]);
            int tw = gfx_text_width(FONT_SMALL, nm) + 30;
            gfx_rect_blend(tx, y - 4, tw, 38, i == g_cpk_view ? C_ACCENT : C_PANEL, i == g_cpk_view ? 230 : 160);
            gfx_text(FONT_SMALL, tx + 15, y, i == g_cpk_view ? RGB(10, 20, 35) : C_DIM, nm);
            tx += tw + 10;
        }
        gfx_text(FONT_SMALL, tx + 20, y, C_DIM, "Left / Right: switch archive");
        y += 50;
    }
    char line[EX_PATH_MAX + 64], a[32];
    gfx_text_clip(FONT_SMALL, x, y, C_TEXT, g_cpk_paths[g_cpk_view], w);
    y += 36;
    if (g_cpk_cur == g_cpk_view && g_cpk.fd >= 0) {
        fmt_size(g_cpk.file_size, a, sizeof(a));
        snprintf(line, sizeof(line), "Size: %s  (%llu bytes)", a, (unsigned long long)g_cpk.file_size);
        gfx_text(FONT_SMALL, x, y, C_DIM, line);
        y += 38;
        for (int r = 0; r < 2 && r * 16 < g_cpk.head_len; r++) {
            int n = g_cpk.head_len - r * 16;
            hex_line(g_cpk.head + r * 16, n > 16 ? 16 : n, r * 16, line, sizeof(line));
            gfx_text(FONT_SMALL, x + 20, y, RGB(170, 210, 255), line);
            y += 30;
        }
        y += 8;
    }
    Color sc = C_OK;
    if (g_cpk_rc == 0 && g_cpk.so4) {
        uint64_t tot = 0;
        for (uint32_t i = 0; i < g_cpk.n; i++) tot += g_cpk.e[i].size;
        fmt_size(tot, a, sizeof(a));
        snprintf(line, sizeof(line), "Star Ocean 4 archive: %u files (%s) by ID - index read from 0000.bin (%u IDs in both archives)",
                 g_cpk.n, a, g_cpk.so4_used_all);
    } else if (g_cpk_rc == 0) {
        uint32_t comp = 0;
        for (uint32_t i = 0; i < g_cpk.n; i++) comp += g_cpk.e[i].xsize > g_cpk.e[i].size;
        snprintf(line, sizeof(line), "CPK archive: %u files (%s), %u compressed (CRILAYLA)", g_cpk.n,
                 g_cpk.n && g_cpk.e[0].name[0] ? "named" : "ID numbers only", comp);
    } else if (g_cpk_rc == 1) {
        sc = C_WARN;
        snprintf(line, sizeof(line), "Not a CPK archive (starts with %02X %02X %02X %02X) - extraction is disabled; the header dump still works",
                 g_cpk.head[0], g_cpk.head[1], g_cpk.head[2], g_cpk.head[3]);
    } else {
        sc = C_ERR;
        snprintf(line, sizeof(line), "Cannot read: %s", g_cpk.error[0] ? g_cpk.error : "unknown error");
    }
    gfx_text_clip(FONT_SMALL, x, y, sc, line, w);
    y += 44;

    char lbl[CI_N][EX_PATH_MAX + 64];
    char stem[256];
    cpk_stem(g_cpk_paths[g_cpk_view], stem, sizeof(stem));
    snprintf(lbl[CI_HEAD], sizeof(lbl[0]), "Save header dump (first 1 MiB) as %s_head.bin", stem);
    if (g_cpk_rc == 0 && g_cpk.so4 && g_cpk_count > 1)
        snprintf(lbl[CI_LIST], sizeof(lbl[0]), "Save file lists of all %d archives (listing_0000.txt, listing_0001.txt)", g_cpk_count);
    else snprintf(lbl[CI_LIST], sizeof(lbl[0]), "Save file list (listing_%s.txt)", stem);
    snprintf(lbl[CI_VIEW], sizeof(lbl[0]), "View file list on screen (ID, size, format)...");
    snprintf(lbl[CI_MAGIC], sizeof(lbl[0]), "Magic survey of all %d archive(s): format counts + scrambled? (do this before Extract ALL)", g_cpk_count);
    snprintf(lbl[CI_INNER], sizeof(lbl[0]), "Inner header list of every pack (inner_headers.txt + .zip, read-only)");
    snprintf(lbl[CI_NAMES], sizeof(lbl[0]), "Name finder: every name in every pack (names.txt, names_by_prefix.txt + .zip, read-only)");
    snprintf(lbl[CI_SEARCH], sizeof(lbl[0]), "Search names... (needs the Name finder once)%s%s", g_nf_word[0] ? "   last: " : "", g_nf_word);
    snprintf(lbl[CI_SKIPREM], sizeof(lbl[0]), "Skip IDs 10000 and up (remastered copies) in the two lists above:  %s", g_nf_skiprem ? "On" : "Off");
    snprintf(lbl[CI_ONE], sizeof(lbl[0]), "Extract by ID or name (several: 0-3 10 656)...");
    snprintf(lbl[CI_ALL], sizeof(lbl[0]), "Extract ALL from %s", base_name(g_cpk_paths[g_cpk_view]));
    snprintf(lbl[CI_ALLSET], sizeof(lbl[0]), "Extract ALL from all %d archives", g_cpk_count);
    snprintf(lbl[CI_UNPACKALL], sizeof(lbl[0]), "Unpack / convert every recognised file in %s (KCAP, DDS, banks...)", base_name(g_cpk_paths[g_cpk_view]));
    snprintf(lbl[CI_RANGE], sizeof(lbl[0]), "Dump a byte range (offset + length)...");
    snprintf(lbl[CI_DEST], sizeof(lbl[0]), "Output folder:  %s", g_cpk_dest);
    snprintf(lbl[CI_RAW], sizeof(lbl[0]), "Also keep compressed copies (.crilayla, CPK only):  %s", g_cpk_keep_raw ? "On" : "Off");
    snprintf(lbl[CI_CLOSE], sizeof(lbl[0]), "Close");
    for (int i = 0; i < CI_N; i++) {
        int disabled = ((i == CI_LIST || i == CI_MAGIC || i == CI_VIEW || i == CI_ONE || i == CI_ALL || i == CI_UNPACKALL) && g_cpk_rc != 0) ||
                       ((i == CI_INNER || i == CI_NAMES) && (g_cpk_rc != 0 || !g_cpk.so4)) || (i == CI_ALLSET && g_cpk_count < 2);
        if (i == g_cpk_sel) gfx_rect_blend(x - 14, y - 3, w + 28, 31, C_SEL, 175);
        gfx_text_clip(FONT_SMALL, x, y, disabled ? RGB(95, 105, 125) : (i == CI_DEST || i == CI_RAW || i == CI_SKIPREM) ? C_ACCENT : C_TEXT, lbl[i], w);
        y += 31;
    }
    draw_footer(GLYPH_CROSS " Choose   " GLYPH_CIRCLE " Close   Left/Right archive   Up/Down select   (Step-1 details are written to the log)");
}

static void draw_cpk_confirm(void)
{
    gfx_rect_blend(0, 0, SCREEN_W, SCREEN_H, RGB(0, 0, 0), 170);
    PANEL(240, 300, SCREEN_W - 480, 440);
    char line[EX_PATH_MAX + 128], a[32], b[32];
    gfx_text(FONT_LARGE, 300, 340, C_ACCENT, g_cpk_scope_all ? "Extract all archives?" : "Extract all files?");
    fmt_size(g_cpk_need, a, sizeof(a));
    snprintf(line, sizeof(line), "%u of %u files still to extract, about %s.", g_cpk_left, g_cpk_files_total, a);
    gfx_text_clip(FONT_SMALL, 300, 430, C_TEXT, line, SCREEN_W - 600);
    if (g_cpk_free_ok) { fmt_size(g_cpk_free, b, sizeof(b)); snprintf(line, sizeof(line), "Free space at the output folder: %s", b); }
    else snprintf(line, sizeof(line), "Free space at the output folder: unknown");
    gfx_text_clip(FONT_SMALL, 300, 470, C_TEXT, line, SCREEN_W - 600);
    snprintf(line, sizeof(line), "Into: %s/<archive>/<folder>/<file>", g_cpk_dest);
    gfx_text_clip(FONT_SMALL, 300, 510, C_DIM, line, SCREEN_W - 600);
    gfx_text(FONT_SMALL, 300, 550, C_DIM, "Files already extracted are skipped, so a stopped run continues where it left off.");
    gfx_text(FONT_SMALL, 300, 590, C_DIM, "Hold " GLYPH_CIRCLE " during extraction to stop.");
    gfx_text(FONT_SMALL, 300, 670, C_TEXT, GLYPH_CROSS " Start      " GLYPH_CIRCLE " Back");
}


/* ---------- on-screen file list viewer ---------- */
static char (*g_vfmt)[48];
static const void *g_vfmt_key;
static uint32_t g_vfmt_n;

static const char *viewer_fmt(uint32_t i)
{
    if (g_vfmt_key != (const void *)g_cpk.e || g_vfmt_n != g_cpk.n) {
        free(g_vfmt);
        g_vfmt = calloc(g_cpk.n ? g_cpk.n : 1, sizeof(*g_vfmt));
        g_vfmt_key = g_cpk.e;
        g_vfmt_n = g_cpk.n;
    }
    if (!g_vfmt || i >= g_cpk.n) return "?";
    if (!g_vfmt[i][0]) cpk_sniff(&g_cpk, i, g_vfmt[i], sizeof(g_vfmt[i]));
    return g_vfmt[i];
}

static void draw_cpk_view(void)
{
    g_live_frame_t0 = now_us();
    gfx_rect_blend(0, 0, SCREEN_W, SCREEN_H, RGB(0, 0, 0), 215);
    PANEL(60, 150, SCREEN_W - 120, 870);
    int x = 100, y = 166;
    char line[EX_PATH_MAX + 64], a[32];
    uint64_t tot = 0;
    for (uint32_t i = 0; i < g_cpk.n; i++) tot += g_cpk.e[i].size;
    fmt_size(tot, a, sizeof(a));
    snprintf(line, sizeof(line), "%s  -  %u files, %s", base_name(g_cpk.path), g_cpk.n, a);
    gfx_text(FONT_LARGE, x, y, C_ACCENT, line);
    if (g_cpk_count > 1) gfx_text(FONT_SMALL, SCREEN_W - 560, y + 12, C_DIM, "Left / Right: other archive");
    y += 64;
    gfx_text(FONT_SMALL, x, y, C_DIM, "ID");
    gfx_text(FONT_SMALL, x + 130, y, C_DIM, "Offset");
    gfx_text(FONT_SMALL, x + 430, y, C_DIM, "Size");
    gfx_text(FONT_SMALL, x + 640, y, C_DIM, "Bytes");
    gfx_text(FONT_SMALL, x + 860, y, C_DIM, g_cpk.so4 ? "Format" : "Format (from the first bytes)");
    gfx_text(FONT_SMALL, x + 1260, y, C_DIM, "Name");
    y += 40;
    for (int r = 0; r < LV_ROWS; r++) {
        int i = g_lv_top + r;
        if (i >= (int)g_cpk.n) break;
        const CpkEntry *e = &g_cpk.e[i];
        if (i == g_lv_sel) gfx_rect_blend(x - 14, y - 5, SCREEN_W - 172, 40, C_SEL, 175);
        Color c = e->beyond_end ? C_ERR : C_TEXT;
        if (g_cpk.so4) snprintf(line, sizeof(line), "%05u", e->id);
        else snprintf(line, sizeof(line), "%u", e->id);
        gfx_text(FONT_SMALL, x, y, c, line);
        snprintf(line, sizeof(line), "0x%llx", (unsigned long long)e->offset);
        gfx_text(FONT_SMALL, x + 130, y, c, line);
        fmt_size(e->xsize > e->size ? e->xsize : e->size, a, sizeof(a));
        gfx_text(FONT_SMALL, x + 430, y, c, a);
        snprintf(line, sizeof(line), "%llu", (unsigned long long)e->size);
        gfx_text(FONT_SMALL, x + 640, y, C_DIM, line);
        if (!g_cpk.so4 && e->name[0]) snprintf(line, sizeof(line), "%s%s%s  -  %s", e->dir, e->dir[0] ? "/" : "", e->name, viewer_fmt((uint32_t)i));
        else snprintf(line, sizeof(line), "%s", viewer_fmt((uint32_t)i));
        gfx_text_clip(FONT_SMALL, x + 860, y, c, line, g_cpk.so4 ? 380 : SCREEN_W - x - 1000);
        const char *nl = cpk_row_label(e, i == g_lv_sel);
        if (nl) gfx_text_clip(FONT_SMALL, x + 1260, y, C_ACCENT, nl, SCREEN_W - x - 1320);
        y += 42;
    }
    snprintf(line, sizeof(line), "%d / %u", g_cpk.n ? g_lv_sel + 1 : 0, g_cpk.n);
    gfx_text(FONT_SMALL, SCREEN_W - 300, 975, C_DIM, line);
    draw_footer(GLYPH_CROSS " Extract   " GLYPH_TRIANGLE " Unpack/convert   " GLYPH_SQUARE " View image   " GLYPH_CIRCLE " Back   L2/R2 page   Left/Right archive");
}

static void update_cpk_view(void)
{
    int n = (int)g_cpk.n;
    if (repeat(ORBIS_PAD_BUTTON_DOWN) && g_lv_sel < n - 1) g_lv_sel++;
    if (repeat(ORBIS_PAD_BUTTON_UP) && g_lv_sel > 0) g_lv_sel--;
    if (repeat(ORBIS_PAD_BUTTON_R2)) { g_lv_sel += LV_ROWS; if (g_lv_sel > n - 1) g_lv_sel = n - 1; }
    if (repeat(ORBIS_PAD_BUTTON_L2)) { g_lv_sel -= LV_ROWS; if (g_lv_sel < 0) g_lv_sel = 0; }
    if (g_cpk_count > 1 && (pressed(ORBIS_PAD_BUTTON_RIGHT) || pressed(ORBIS_PAD_BUTTON_LEFT))) {
        int d = pressed(ORBIS_PAD_BUTTON_RIGHT) ? 1 : g_cpk_count - 1;
        cpk_select((g_cpk_view + d) % g_cpk_count);
        g_lv_sel = g_lv_top = 0;
        if (!cpk_parsed()) { g_overlay = OV_CPK; return; }
        n = (int)g_cpk.n;
    }
    if (g_lv_sel < 0) g_lv_sel = 0;
    if (g_lv_sel < g_lv_top) g_lv_top = g_lv_sel;
    if (g_lv_sel >= g_lv_top + LV_ROWS) g_lv_top = g_lv_sel - LV_ROWS + 1;
    if (pressed(ORBIS_PAD_BUTTON_CIRCLE)) { g_overlay = OV_CPK; return; }
    if (pressed(ORBIS_PAD_BUTTON_TRIANGLE) && n) { unpack_viewer_entry(); return; }
    if (pressed(ORBIS_PAD_BUTTON_SQUARE) && n) {
        const CpkEntry *e = &g_cpk.e[g_lv_sel];
        uint8_t hb[32] = { 0 };
        size_t k = e->size < 32 ? (size_t)e->size : 32;
        char lab[300];
        cpk_entry_label(e, lab, sizeof(lab));
        if (e->beyond_end || e->xsize > e->size || pread(g_cpk.fd, hb, k, (off_t)e->offset) != (ssize_t)k || !img_is_image(hb, k)) {
            show_message("%s is not a DDS/PNG/BMP image. Textures inside KCAP packs: press triangle to unpack, then open the PNGs in FILES.", lab);
            g_return_view = 1;
            return;
        }
        g_img_from_files = 0;
        if (img_show_fd(g_cpk.fd, e->offset, e->size, lab) != 0) g_return_view = 1;
        return;
    }
    if (pressed(ORBIS_PAD_BUTTON_CROSS) && n) {
        char q[32];
        snprintf(q, sizeof(q), "%u", g_cpk.e[g_lv_sel].id);
        cpk_extract_one_named(q);
        if (g_overlay == OV_MESSAGE) g_return_view = 1;
    }
}


/* =================================================================== viewers
 * ✕ on a file in FILES opens the viewer that fits its first bytes:
 *   ASF model -> 3D viewer, AAC sound -> player, anything else -> text / string / hex viewer. */
static uint8_t *load_whole(const char *path, size_t max, size_t *n)
{
    int fd = open(path, O_RDONLY);
    if (fd < 0) return NULL;
    struct stat st;
    uint8_t *d = NULL;
    if (fstat(fd, &st) == 0 && st.st_size > 0 && (uint64_t)st.st_size <= max && (d = malloc((size_t)st.st_size))) {
        size_t got = 0;
        while (got < (size_t)st.st_size) {
            ssize_t r = pread(fd, d + got, (size_t)st.st_size - got, (off_t)got);
            if (r <= 0) { free(d); d = NULL; break; }
            got += (size_t)r;
        }
        if (d) *n = got;
    }
    close(fd);
    return d;
}

/* ---- 3D model viewer ---- */
static AsfModel *g_mdl;
static R3dTarget g_r3d;
static R3dView   g_view;
static int       g_mdl_dirty, g_mdl_auto;
static int       g_mdl_hq, g_mdl_idle;   /* still picture: one slower, sharper full-size render */
static int       g_gpu_view;          /* model viewer draws with the GPU */
static uint32_t  g_gpu_calls;
static void gpu_logline(const char *l) { logx("%s", l); }
static char      g_mdl_name[300], g_mdl_label[120];
static double    g_mdl_ms;

static void model_close(void)
{
    gpu_model_free();
    (r3d_forget_model(&g_r3d), asf_free(g_mdl)); g_mdl = NULL;
    r3d_target_free(&g_r3d);
    g_anim = 0;
    g_overlay = OV_NONE;
}

static void model_reset_view(void)
{
    g_view.yaw = 0.f; g_view.pitch = 0.15f; g_view.zoom = 1.35f; g_view.pan_x = g_view.pan_y = 0.f;
    g_view.textured = 1; g_view.wire = 0;
    g_mdl_dirty = 1;
}

static int model_open_path(const char *path)
{
    char busy[400];
    snprintf(busy, sizeof(busy), "Loading model %s ...", base_name(path));
    cpk_busy_frame(busy);
    size_t n = 0;
    uint8_t *d = load_whole(path, 256u << 20, &n);
    if (!d) { show_message("Cannot read %s.", path); return -1; }
    char err[256];
    uint64_t t0 = now_us();
    AsfModel *m = asf_load(d, n, 1, err, sizeof(err));
    free(d);
    if (!m) { show_message("%s: %s", base_name(path), err); logx("Model: %s: %s", path, err); return -1; }
    int hid = asf_view_prepare(m);
    logx("Model: %s: %d meshes shown, %d hidden (hulls/sky), %u skipped, %d textures", base_name(path), m->nmesh, hid, m->st.skipped, m->ntex);
    gpu_model_free();
    (r3d_forget_model(&g_r3d), asf_free(g_mdl));
    g_mdl = m;
    if (gpu_active()) gpu_model_upload(g_mdl);
    if (!g_r3d.rgba && r3d_target_init(&g_r3d, 1920, 1080) != 0) { (r3d_forget_model(&g_r3d), asf_free(g_mdl)); g_mdl = NULL; show_message("Out of memory for the model viewer."); return -1; }
    snprintf(g_mdl_name, sizeof(g_mdl_name), "%s", base_name(path));
    char dir[EX_PATH_MAX];
    snprintf(dir, sizeof(dir), "%s", path);
    char *sl = strrchr(dir, '/');
    if (sl) *sl = 0;
    const char *lab = file_label(dir, g_mdl_name, 0);
    snprintf(g_mdl_label, sizeof(g_mdl_label), "%s", lab ? lab : "");
    logx("Model: %s - %u meshes, %llu triangles, %u textures (%llu ms)", path, m->st.meshes, (unsigned long long)m->st.triangles,
         m->st.textures, (unsigned long long)((now_us() - t0) / 1000));
    model_reset_view();
    g_overlay = OV_MODEL;
    return 0;
}

static int file_is_model(const char *path)
{
    uint8_t h[4];
    int fd = open(path, O_RDONLY);
    if (fd < 0) return 0;
    int ok = pread(fd, h, 4, 0) == 4 && !memcmp(h, " FSA", 4);
    close(fd);
    return ok;
}

static void model_step(int dir)
{
    if (!g_count) return;
    for (int k = 1; k < g_count; k++) {
        int i = ((g_sel + dir * k) % g_count + g_count) % g_count;
        if (g_entries[i].is_dir) continue;
        char full[EX_PATH_MAX];
        path_join(full, sizeof(full), g_cwd, g_entries[i].name);
        if (!file_is_model(full)) continue;
        g_sel = i;
        if (model_open_path(full) != 0 && g_mdl) g_overlay = OV_MODEL;
        return;
    }
}

/* L3 in the model viewer: start the GPU renderer (first time) or switch CPU <-> GPU. */
static void model_toggle_gpu(void)
{
    if (gpu_active()) { g_gpu_view = !g_gpu_view; g_mdl_dirty = 1; return; }
    cpk_busy_frame("Starting the GPU renderer (experimental)...");
    gpu_set_log(gpu_logline);
    char err[300];
    logx("GPU: start requested");
    int rc = gpu_start(err, sizeof(err));
    if (rc != 0) {
        g_gpu_view = 0;
        g_return_model = 1;
        show_message("The GPU renderer could not start, so the CPU renderer stays in use. %s%s Details are in the log (lines starting with GPU:).",
                     err, rc == -2 ? " The screen could not be handed back - if it stays black, close the app with the PS button." : "");
        return;
    }
    gpu_model_upload(g_mdl);
    g_gpu_view = 1;
    g_mdl_dirty = 1;
}

/* Returns 1 if the frame was already shown (GPU), 0 if the caller must flip. */
static int draw_model_view(void)
{
    int gpu = g_gpu_view && gpu_active();
    if (!gpu) {
        if (g_mdl_dirty || g_mdl_auto) {
            uint64_t t0 = now_us();
            g_r3d.w = 1280; g_r3d.h = 720; g_view.quality = 0;      /* moving: fast */
            r3d_render(&g_r3d, g_mdl, &g_view);
            g_mdl_ms = (now_us() - t0) / 1000.0;
            g_mdl_dirty = 0; g_mdl_hq = 0; g_mdl_idle = 0;
        } else if (!g_mdl_hq && ++g_mdl_idle >= 4) {
            g_r3d.w = 1920; g_r3d.h = 1080; g_view.quality = 1;     /* at rest: full size, filtered */
            r3d_render(&g_r3d, g_mdl, &g_view);
            g_mdl_hq = 1;
        }
        gfx_image(0, 0, SCREEN_W, SCREEN_H, g_r3d.rgba, g_r3d.w, g_r3d.h, 0, 0, (int64_t)g_r3d.w * 65536 / SCREEN_W, 1);
    }
    if (gpu) { gfx_rect(0, 0, SCREEN_W, 64, RGB(8, 14, 30)); gfx_rect(0, SCREEN_H - 60, SCREEN_W, 60, RGB(8, 14, 30)); }
    else { gfx_rect_blend(0, 0, SCREEN_W, 64, RGB(8, 14, 30), 200); gfx_rect_blend(0, SCREEN_H - 60, SCREEN_W, 60, RGB(8, 14, 30), 200); }
    char line[800], how[260];
    if (gpu) snprintf(how, sizeof(how), "GPU: %s, %u draw calls", gpu_info(), g_gpu_calls);
    else snprintf(how, sizeof(how), "CPU renderer");
    snprintf(line, sizeof(line), "%s%s%s   %u meshes, %llu triangles, %u textures   %.0f ms/frame   %s", g_mdl_name,
             g_mdl_label[0] ? "  -  " : "", g_mdl_label, g_mdl->st.meshes, (unsigned long long)g_mdl->st.triangles, g_mdl->st.textures, g_mdl_ms, how);
    gfx_text_clip(FONT_SMALL, 30, 16, C_TEXT, line, SCREEN_W - 60);
    gfx_text_clip(FONT_SMALL, 30, SCREEN_H - 46, C_DIM,
                  "Stick / D-pad rotate   R-stick pan   L2/R2 zoom   " GLYPH_CROSS " spin   " GLYPH_TRIANGLE " texture   "
                  GLYPH_SQUARE " reset   L3 GPU on/off   R3 wireframe (CPU)   L1/R1 prev/next   " GLYPH_CIRCLE " back", SCREEN_W - 60);
    if (!gpu) return 0;
    gpu_model_draw(g_mdl, &g_view, gfx_pixels(), 64, 60, &g_mdl_ms, &g_gpu_calls);
    g_mdl_dirty = 0;
    return 1;
}

static void update_model_view(void)
{
    if (pressed(ORBIS_PAD_BUTTON_CIRCLE)) { model_close(); return; }
    if (pressed(ORBIS_PAD_BUTTON_CROSS)) { g_mdl_auto = !g_mdl_auto; }
    if (pressed(ORBIS_PAD_BUTTON_TRIANGLE)) { g_view.textured = !g_view.textured; g_mdl_dirty = 1; }
    if (pressed(ORBIS_PAD_BUTTON_SQUARE)) model_reset_view();
    if (pressed(ORBIS_PAD_BUTTON_R3)) { g_view.wire = !g_view.wire; g_mdl_dirty = 1; }
    if (pressed(ORBIS_PAD_BUTTON_L3)) { model_toggle_gpu(); return; }
    if (pressed(ORBIS_PAD_BUTTON_R1)) { model_step(1); return; }
    if (pressed(ORBIS_PAD_BUTTON_L1)) { model_step(-1); return; }
    float dy = 0, dp = 0, dz = 0, px = 0, py = 0;
    if (g_buttons & ORBIS_PAD_BUTTON_LEFT) dy -= 0.05f;
    if (g_buttons & ORBIS_PAD_BUTTON_RIGHT) dy += 0.05f;
    if (g_buttons & ORBIS_PAD_BUTTON_UP) dp -= 0.04f;
    if (g_buttons & ORBIS_PAD_BUTTON_DOWN) dp += 0.04f;
    if (g_buttons & ORBIS_PAD_BUTTON_R2) dz += 0.03f;
    if (g_buttons & ORBIS_PAD_BUTTON_L2) dz -= 0.03f;
    int ax = g_lx - 128, ay = g_ly - 128, bx = g_rx - 128, by = g_ry - 128;
    if (abs(ax) > 24) dy += ax / 128.f * 0.06f;
    if (abs(ay) > 24) dp += ay / 128.f * 0.05f;
    if (abs(bx) > 24) px -= bx / 128.f * 0.03f;
    if (abs(by) > 24) py += by / 128.f * 0.03f;
    if (g_mdl_auto) dy += 0.02f;
    if (dy || dp || dz || px || py) {
        g_view.yaw += dy;
        g_view.pitch += dp;
        if (g_view.pitch > 1.55f) g_view.pitch = 1.55f;
        if (g_view.pitch < -1.55f) g_view.pitch = -1.55f;
        g_view.zoom *= 1.f + dz;
        if (g_view.zoom < 0.2f) g_view.zoom = 0.2f;
        if (g_view.zoom > 40.f) g_view.zoom = 40.f;
        g_view.pan_x += px / g_view.zoom; g_view.pan_y += py / g_view.zoom;
        g_mdl_dirty = 1;
    }
    g_anim = g_mdl_auto || g_mdl_dirty || (!g_mdl_hq && !(g_gpu_view && gpu_active())) || (g_buttons & (ORBIS_PAD_BUTTON_LEFT | ORBIS_PAD_BUTTON_RIGHT | ORBIS_PAD_BUTTON_UP | ORBIS_PAD_BUTTON_DOWN |
                                                       ORBIS_PAD_BUTTON_L2 | ORBIS_PAD_BUTTON_R2)) ||
             abs(ax) > 24 || abs(ay) > 24 || abs(bx) > 24 || abs(by) > 24;
}

/* ---- sound player (AAC / ATRAC9) ---- */
#define SND_MAX 512
static AacSound g_snd[SND_MAX];
static int      g_snd_n, g_snd_i;
static uint8_t *g_snd_file;
static size_t   g_snd_len;
static int16_t *g_snd_pcm;
static uint32_t g_snd_frames;
static char     g_snd_name[300], g_snd_label[120], g_snd_err[300], g_snd_path[EX_PATH_MAX];

static int snd_progress(void *u, double done)
{
    (void)u;
    static uint64_t last;
    if (now_us() - last > 150000) {
        last = now_us();
        char m[200];
        snprintf(m, sizeof(m), "Decoding with the PS4 audio hardware... %d%%", (int)(done * 100));
        cpk_busy_frame(m);
    }
    return 0;
}

static void snd_free_pcm(void)
{
    audio_play_stop();
    free(g_snd_pcm); g_snd_pcm = NULL; g_snd_frames = 0;
}

static void snd_decode_current(void)
{
    snd_free_pcm();
    g_snd_err[0] = 0;
    if (g_snd_i < 0 || g_snd_i >= g_snd_n || g_snd_i >= SND_MAX) return;
    const AacSound *s = &g_snd[g_snd_i];
    if (!s->supported) { snprintf(g_snd_err, sizeof(g_snd_err), "This sound uses a codec the player does not handle yet."); return; }
    cpk_busy_frame("Decoding with the PS4 audio hardware...");
    char err[256] = "";
    uint64_t t0 = now_us();
    g_snd_pcm = at9_decode(g_snd_file + s->off, (size_t)s->len, s->config, (int)s->channels, s->block, s->samples_per_block, s->samples,
                           &g_snd_frames, snd_progress, NULL, err, sizeof(err));
    logx("Sound: %s #%d: %s (%llu ms) [%s]", g_snd_path, g_snd_i, g_snd_pcm ? "decoded" : err,
         (unsigned long long)((now_us() - t0) / 1000), at9_last_diag());
    if (!g_snd_pcm) { snprintf(g_snd_err, sizeof(g_snd_err), "%s   [codes: %s]", err, at9_last_diag()); return; }
    int rc = audio_play_pcm(g_snd_pcm, g_snd_frames, s->channels, s->rate ? s->rate : 48000);
    if (rc != 0) { snprintf(g_snd_err, sizeof(g_snd_err), "Audio output could not open (0x%08x).", (unsigned)rc); logx("Sound: output failed 0x%08x", (unsigned)rc); }
}

static void snd_close(void)
{
    snd_free_pcm();
    free(g_snd_file); g_snd_file = NULL; g_snd_n = 0;
    g_anim = 0;
    g_overlay = OV_NONE;
}

static int file_is_sound(const char *path)
{
    uint8_t h[12];
    int fd = open(path, O_RDONLY);
    if (fd < 0) return 0;
    ssize_t got = pread(fd, h, 12, 0);
    int ok = got >= 4 && !memcmp(h, " CAA", 4);
    if (!ok && got == 12 && !memcmp(h, "RIFF", 4) && !memcmp(h + 8, "WAVE", 4)) {      /* an exported .at9 */
        const char *e = strrchr(path, '.');
        ok = e && !strcasecmp(e, ".at9");
    }
    close(fd);
    return ok;
}

static int snd_open_path(const char *path)
{
    size_t n = 0;
    uint8_t *d = load_whole(path, 256u << 20, &n);
    if (!d) { show_message("Cannot read %s.", path); return -1; }
    int cnt = aac_sounds(d, n, g_snd, SND_MAX);
    if (cnt <= 0 && at9_riff_sound(d, n, &g_snd[0])) cnt = 1;
    if (cnt <= 0) { free(d); show_message("%s: no sounds found in this file.", base_name(path)); logx("Sound: %s: no sounds found", path); return -1; }
    logx("Sound: opened %s, %d sound(s)", path, cnt);
    snd_free_pcm();
    free(g_snd_file);
    g_snd_file = d; g_snd_len = n; g_snd_n = cnt > SND_MAX ? SND_MAX : cnt; g_snd_i = 0;
    snprintf(g_snd_path, sizeof(g_snd_path), "%s", path);
    snprintf(g_snd_name, sizeof(g_snd_name), "%s", base_name(path));
    char dir[EX_PATH_MAX];
    snprintf(dir, sizeof(dir), "%s", path);
    char *sl = strrchr(dir, '/');
    if (sl) *sl = 0;
    const char *lab = file_label(dir, g_snd_name, 0);
    snprintf(g_snd_label, sizeof(g_snd_label), "%s", lab ? lab : "");
    g_overlay = OV_SOUND;
    snd_decode_current();
    return 0;
}

static void snd_step_file(int dir)
{
    if (!g_count) return;
    for (int k = 1; k < g_count; k++) {
        int i = ((g_sel + dir * k) % g_count + g_count) % g_count;
        if (g_entries[i].is_dir) continue;
        char full[EX_PATH_MAX];
        path_join(full, sizeof(full), g_cwd, g_entries[i].name);
        if (!file_is_sound(full)) continue;
        g_sel = i;
        snd_open_path(full);
        return;
    }
}

static void snd_save(int wav)
{
    if (!dest_allowed(g_extract_dir) || ex_mkdirs(g_extract_dir) != 0) { show_message("Cannot write to %s.", g_extract_dir); g_return_view = 0; return; }
    const AacSound *s = &g_snd[g_snd_i];
    char stem[300], out[EX_PATH_MAX + 340];
    snprintf(stem, sizeof(stem), "%s", g_snd_name);
    char *dot = strrchr(stem, '.');
    if (dot) *dot = 0;
    if (g_snd_n > 1) { size_t l = strlen(stem); snprintf(stem + l, sizeof(stem) - l, "_%d", g_snd_i); }
    snprintf(out, sizeof(out), "%s/%s.%s", g_extract_dir, stem, wav ? "wav" : "at9");
    FILE *f = fopen(out, "wb");
    if (!f) { show_message("Cannot write %s.", out); return; }
    int bad = 0;
    if (wav) {
        if (!g_snd_pcm) { fclose(f); unlink(out); show_message("Nothing decoded to save - save the .at9 instead (△)."); return; }
        uint32_t ch = s->channels, rate = s->rate ? s->rate : 48000, bytes = g_snd_frames * ch * 2;
        uint8_t h[44];
        memcpy(h, "RIFF", 4); uint32_t v = 36 + bytes; memcpy(h + 4, &v, 4); memcpy(h + 8, "WAVEfmt ", 8);
        v = 16; memcpy(h + 16, &v, 4); uint16_t w = 1; memcpy(h + 20, &w, 2); w = (uint16_t)ch; memcpy(h + 22, &w, 2);
        memcpy(h + 24, &rate, 4); v = rate * ch * 2; memcpy(h + 28, &v, 4); w = (uint16_t)(ch * 2); memcpy(h + 32, &w, 2); w = 16; memcpy(h + 34, &w, 2);
        memcpy(h + 36, "data", 4); memcpy(h + 40, &bytes, 4);
        bad = fwrite(h, 1, 44, f) != 44 || fwrite(g_snd_pcm, 1, bytes, f) != bytes;
    } else {
        size_t on = 0;
        uint8_t *a = aac_make_at9(g_snd_file, g_snd_len, s, &on);
        bad = !a || fwrite(a, 1, on, f) != on;
        free(a);
    }
    bad |= fclose(f) != 0;
    if (bad) { unlink(out); show_message("Writing %s failed.", out); return; }
    logx("Sound: saved %s", out);
    show_message("Saved %s", out);
}

static void draw_sound_view(void)
{
    gfx_rect_blend(0, 0, SCREEN_W, SCREEN_H, RGB(0, 0, 0), 200);
    PANEL(160, 220, SCREEN_W - 320, 640);
    int x = 220, y = 250, w = SCREEN_W - 440;
    char line[700], a[32], b[32];
    snprintf(line, sizeof(line), "%s%s%s", g_snd_name, g_snd_label[0] ? "  -  " : "", g_snd_label);
    gfx_text_clip(FONT_LARGE, x, y, C_ACCENT, line, w);
    y += 80;
    const AacSound *s = &g_snd[g_snd_i];
    snprintf(line, sizeof(line), "Sound %d of %d   ATRAC9, %u channel%s, %u Hz, %u bytes/s   config %02X %02X %02X %02X%s", g_snd_i + 1, g_snd_n,
             s->channels, s->channels == 1 ? "" : "s", s->rate, s->bytes_per_sec, s->config[0], s->config[1], s->config[2], s->config[3],
             s->loop_len ? "   (loops)" : "");
    if (!s->supported) snprintf(line, sizeof(line), "Sound %d of %d   (codec not handled)", g_snd_i + 1, g_snd_n);
    gfx_text_clip(FONT_SMALL, x, y, C_TEXT, line, w);
    y += 60;
    uint32_t rate = s->rate ? s->rate : 48000, pos = audio_play_active() ? audio_play_pos() : 0;
    double tot = (double)(g_snd_frames ? g_snd_frames : s->samples) / rate, cur = (double)pos / rate;
    snprintf(a, sizeof(a), "%d:%02d", (int)cur / 60, (int)cur % 60);
    snprintf(b, sizeof(b), "%d:%02d", (int)tot / 60, (int)tot % 60);
    gfx_rect(x, y, w, 24, C_BAR_BG);
    if (tot > 0) gfx_rect(x, y, (int)(w * (cur / tot > 1 ? 1 : cur / tot)), 24, C_ACCENT);
    y += 40;
    snprintf(line, sizeof(line), "%s / %s", a, b);
    gfx_text(FONT_SMALL, x, y, C_DIM, line);
    y += 70;
    if (g_snd_err[0]) {
        gfx_text(FONT_SMALL, x, y, C_WARN, "Could not play here:");
        text_wrap(FONT_SMALL, x, y + 40, C_TEXT, g_snd_err, w, 3);
        text_wrap(FONT_SMALL, x, y + 160, C_DIM, "Save it with " GLYPH_TRIANGLE " as .at9 and play it on a PC (foobar2000 + vgmstream, "
                  "or ffmpeg / VLC). Unpacking a pack also writes .at9 files next to each .aac.", w, 2);
    } else if (g_snd_pcm) gfx_text(FONT_SMALL, x, y, C_OK, audio_play_active() ? "Playing" : "Stopped");
    draw_footer(GLYPH_CROSS " Play / pause   " GLYPH_SQUARE " Restart   Left/Right sound in this file   L1/R1 prev/next file   "
                GLYPH_TRIANGLE " Save .at9   OPTIONS save .wav   " GLYPH_CIRCLE " Back");
}

static int g_snd_paused;
static void update_sound_view(void)
{
    g_anim = audio_play_active() && !g_snd_paused;
    if (pressed(ORBIS_PAD_BUTTON_CIRCLE)) { snd_close(); return; }
    if (pressed(ORBIS_PAD_BUTTON_CROSS) && g_snd_pcm) {
        if (!audio_play_active()) { audio_play_pcm(g_snd_pcm, g_snd_frames, g_snd[g_snd_i].channels, g_snd[g_snd_i].rate ? g_snd[g_snd_i].rate : 48000); g_snd_paused = 0; }
        else { g_snd_paused = !g_snd_paused; audio_play_pause(g_snd_paused); }
    }
    if (pressed(ORBIS_PAD_BUTTON_SQUARE) && g_snd_pcm) {
        if (!audio_play_active()) audio_play_pcm(g_snd_pcm, g_snd_frames, g_snd[g_snd_i].channels, g_snd[g_snd_i].rate ? g_snd[g_snd_i].rate : 48000);
        audio_play_seek(0); g_snd_paused = 0; audio_play_pause(0);
    }
    if (pressed(ORBIS_PAD_BUTTON_RIGHT) && g_snd_n > 1) { g_snd_i = (g_snd_i + 1) % g_snd_n; snd_decode_current(); }
    if (pressed(ORBIS_PAD_BUTTON_LEFT) && g_snd_n > 1) { g_snd_i = (g_snd_i + g_snd_n - 1) % g_snd_n; snd_decode_current(); }
    if (pressed(ORBIS_PAD_BUTTON_R1)) { snd_step_file(1); return; }
    if (pressed(ORBIS_PAD_BUTTON_L1)) { snd_step_file(-1); return; }
    if (pressed(ORBIS_PAD_BUTTON_TRIANGLE)) { snd_save(0); g_return_sound = 1; return; }
    if (pressed(ORBIS_PAD_BUTTON_OPTIONS)) { snd_save(1); g_return_sound = 1; return; }
    if (audio_play_active() && audio_play_pos() >= g_snd_frames) audio_play_stop();
}

/* ---- text / string / hex viewer ---- */
static char  **g_tv_lines;
static int     g_tv_n, g_tv_top, g_tv_cap, g_tv_hex;
static char    g_tv_title[400];
static int     g_tv_fd = -1;
static uint64_t g_tv_size;
#define TV_ROWS 23

static void tv_free(void)
{
    for (int i = 0; i < g_tv_n; i++) free(g_tv_lines[i]);
    free(g_tv_lines); g_tv_lines = NULL; g_tv_n = g_tv_cap = g_tv_top = 0;
    if (g_tv_fd >= 0) { close(g_tv_fd); g_tv_fd = -1; }
}

static void tv_add(const char *s, size_t n)
{
    if (g_tv_n >= 200000) return;
    if (g_tv_n == g_tv_cap) {
        int nc = g_tv_cap ? g_tv_cap * 2 : 1024;
        char **t = realloc(g_tv_lines, sizeof(char *) * (size_t)nc);
        if (!t) return;
        g_tv_lines = t; g_tv_cap = nc;
    }
    size_t tabs = 0;
    for (size_t i = 0; i < n; i++) tabs += s[i] == '\t';
    char *c = malloc(n + tabs * 3 + 1);
    if (!c) return;
    size_t o = 0;
    for (size_t i = 0; i < n; i++) {          /* tabs -> spaces (the font has no tab glyph) */
        if (s[i] == '\t') { do c[o++] = ' '; while (o % 4); }
        else c[o++] = s[i];
        if (o > n + tabs * 3 - 1) break;
    }
    c[o] = 0;
    g_tv_lines[g_tv_n++] = c;
}

static void tv_str_cb(size_t off, const char *utf8, void *u)
{
    (void)u;
    char buf[1700];
    int chars = 0, wide = 0;
    for (const unsigned char *c = (const unsigned char *)utf8; *c; c++) {
        if ((*c & 0xC0) != 0x80) chars++;
        if (*c >= 0xE0 && *c < 0xF0) wide++;
    }
    int o;
    if (wide * 2 > chars)   /* the console font has no Japanese glyphs */
        o = snprintf(buf, sizeof(buf), "%06zx  [Japanese, %d characters - readable in the .txt that Unpack writes]", off, chars);
    else o = snprintf(buf, sizeof(buf), "%06zx  %s", off, utf8);
    tv_add(buf, (size_t)(o < (int)sizeof(buf) ? o : (int)sizeof(buf) - 1));
}
static int tv_strings(const uint8_t *d, size_t n) { return u16_strings(d, n, tv_str_cb, NULL); }

static int text_like(const uint8_t *d, size_t n)
{
    size_t k = n < 4096 ? n : 4096, good = 0;
    for (size_t i = 0; i < k; i++) good += d[i] == '\n' || d[i] == '\r' || d[i] == '\t' || (d[i] >= 0x20 && d[i] < 0x7F) || d[i] >= 0x80;
    return k && good * 100 >= k * 97;
}

static int tv_open_path(const char *path)
{
    tv_free();
    g_tv_fd = open(path, O_RDONLY);
    if (g_tv_fd < 0) { show_message("Cannot open %s.", path); return -1; }
    struct stat st;
    fstat(g_tv_fd, &st);
    g_tv_size = (uint64_t)st.st_size;
    uint8_t head[4096];
    ssize_t hn = pread(g_tv_fd, head, sizeof(head), 0);
    if (hn < 0) hn = 0;
    const char *kind = "hex";
    g_tv_hex = 1;
    if (hn >= 4 && !memcmp(head, "EXD", 4) && g_tv_size <= (64u << 20)) {
        size_t n = 0;
        uint8_t *d = load_whole(path, 64u << 20, &n);
        if (d) {
            int k = tv_strings(d, n);
            free(d);
            if (k) { g_tv_hex = 0; kind = "game text (UTF-16 strings)"; }
        }
    } else if (text_like(head, (size_t)hn) && g_tv_size <= (32u << 20)) {
        size_t n = 0;
        uint8_t *d = load_whole(path, 32u << 20, &n);
        if (d) {
            size_t b = 0;
            for (size_t i = 0; i <= n; i++)
                if (i == n || d[i] == '\n') { size_t e = i; if (e > b && d[e - 1] == '\r') e--; tv_add((char *)d + b, e - b); b = i + 1; }
            free(d);
            g_tv_hex = 0; kind = "text";
        }
    }
    if (g_tv_hex) { for (int i = 0; i < g_tv_n; i++) free(g_tv_lines[i]); g_tv_n = 0; }
    char sz[32];
    fmt_size(g_tv_size, sz, sizeof(sz));
    const char *lab = file_label(g_cwd, base_name(path), 0);
    snprintf(g_tv_title, sizeof(g_tv_title), "%s%s%s   %s, %s%s", base_name(path), lab ? "  -  " : "", lab ? lab : "", sz, kind,
             !g_tv_hex ? "" : "");
    g_overlay = OV_TEXT;
    return 0;
}

static void draw_text_view(void)
{
    gfx_rect_blend(0, 0, SCREEN_W, SCREEN_H, RGB(0, 0, 0), 225);
    PANEL(50, 140, SCREEN_W - 100, 880);
    int x = 80, y = 156;
    gfx_text_clip(FONT_SMALL, x, y, C_ACCENT, g_tv_title, SCREEN_W - 160);
    y += 44;
    char line[2000];
    int total;
    if (g_tv_hex) {
        total = (int)((g_tv_size + 15) / 16);
        for (int r = 0; r < TV_ROWS; r++) {
            uint64_t off = (uint64_t)(g_tv_top + r) * 16;
            if (off >= g_tv_size) break;
            uint8_t b[16];
            ssize_t k = pread(g_tv_fd, b, 16, (off_t)off);
            if (k <= 0) break;
            int o = snprintf(line, sizeof(line), "%08llx  ", (unsigned long long)off);
            for (int i = 0; i < 16; i++) o += i < k ? snprintf(line + o, sizeof(line) - o, "%02X ", b[i]) : snprintf(line + o, sizeof(line) - o, "   ");
            o += snprintf(line + o, sizeof(line) - o, " ");
            for (int i = 0; i < k; i++) line[o++] = b[i] >= 0x20 && b[i] < 0x7F ? (char)b[i] : '.';
            line[o] = 0;
            gfx_text(FONT_SMALL, x, y + r * 34, C_TEXT, line);
        }
    } else {
        total = g_tv_n;
        for (int r = 0; r < TV_ROWS && g_tv_top + r < g_tv_n; r++)
            gfx_text_clip(FONT_SMALL, x, y + r * 34, C_TEXT, g_tv_lines[g_tv_top + r], SCREEN_W - 160);
    }
    snprintf(line, sizeof(line), "%s %d-%d of %d", g_tv_hex ? "rows" : "lines", total ? g_tv_top + 1 : 0,
             g_tv_top + TV_ROWS < total ? g_tv_top + TV_ROWS : total, total);
    gfx_text(FONT_SMALL, SCREEN_W - 420, 985, C_DIM, line);
    draw_footer("D-pad scroll   L2/R2 page   L1/R1 top/end   " GLYPH_CIRCLE " Back");
}

static void update_text_view(void)
{
    int total = g_tv_hex ? (int)((g_tv_size + 15) / 16) : g_tv_n;
    if (pressed(ORBIS_PAD_BUTTON_CIRCLE)) { tv_free(); g_overlay = OV_NONE; return; }
    if (repeat(ORBIS_PAD_BUTTON_DOWN)) g_tv_top++;
    if (repeat(ORBIS_PAD_BUTTON_UP)) g_tv_top--;
    if (repeat(ORBIS_PAD_BUTTON_R2)) g_tv_top += TV_ROWS;
    if (repeat(ORBIS_PAD_BUTTON_L2)) g_tv_top -= TV_ROWS;
    if (pressed(ORBIS_PAD_BUTTON_R1)) g_tv_top = total - TV_ROWS;
    if (pressed(ORBIS_PAD_BUTTON_L1)) g_tv_top = 0;
    int ay = g_ly - 128;
    if (abs(ay) > 40) { g_tv_top += ay / 40; g_anim = 1; } else g_anim = 0;
    if (g_tv_top > total - TV_ROWS) g_tv_top = total - TV_ROWS;
    if (g_tv_top < 0) g_tv_top = 0;
}

/* ✕ on a file that is neither an archive nor an image */
static void open_viewer_for(const char *full)
{
    if (file_is_model(full)) model_open_path(full);
    else if (file_is_sound(full)) snd_open_path(full);
    else tv_open_path(full);
}

/* ---------- names: inner headers, name finder, search, labels ---------- */
static int nf_cb(void *u) { (void)u; return on_progress_common(); }
static int ac_nf_cb(AcJob *j, void *u) { (void)j; (void)u; return on_progress_common(); }

/* Load pack_names.txt (output folder first, then the app folder) if not loaded yet. */
static void labels_ensure(int force)
{
    char a[EX_PATH_MAX + 32], b[] = APP_DATA "/pack_names.txt";
    snprintf(a, sizeof(a), "%s/pack_names.txt", g_cpk_dest);
    const char *pick = NULL;
    struct stat st;
    if (g_cpk_dest[0] && stat(a, &st) == 0) pick = a;
    else if (stat(b, &st) == 0) pick = b;
    if (!pick) return;
    if (!force && nf_labels_loaded() && !strcmp(g_lab_path, pick)) return;
    if (nf_labels_load(pick) == 0) { snprintf(g_lab_path, sizeof(g_lab_path), "%s", pick); logx("Names: labels loaded from %s", pick); }
}

/* names.txt for searching: output folder, then the app folder. */
static int names_txt_path(char *out, size_t n)
{
    struct stat st;
    snprintf(out, n, "%s/names.txt", g_cpk_dest);
    if (g_cpk_dest[0] && stat(out, &st) == 0) return 0;
    snprintf(out, n, "%s/names.txt", APP_DATA);
    return stat(out, &st) == 0 ? 0 : -1;
}

/* ---- labels shown next to files ----
 * From the index (pack_names.txt) when there is one:
 *   NNNNN.bin / NNNNN_unpacked/ / NNNNN/                 -> pack NNNNN
 *   files EEE.ext inside NNNNN_unpacked/ or .../NNNNN/   -> entry EEE of pack NNNNN
 * Otherwise (and for files the index has no name for) the name is read from the data and
 * cached; a few rows are filled in per frame so scrolling stays smooth. */
#define LIVE_N 512
typedef struct { char key[300]; char lab[100]; uint8_t used; } LiveLab;
static LiveLab g_live[LIVE_N];
static uint32_t g_live_next;
#define LIVE_BUDGET_US 6000

static int five_digits(const char *s, const char **rest)
{
    int k = 0;
    while (k < 6 && s[k] >= '0' && s[k] <= '9') k++;
    if (k != 5) return 0;
    *rest = s + 5;
    return 1;
}

/* pack ID of a folder name "NNNNN" or "NNNNN_unpacked"; -1 if none */
static long pack_of_name(const char *name)
{
    const char *r;
    if (!five_digits(name, &r)) return -1;
    if (*r && strcmp(r, "_unpacked") && strcasecmp(r, ".bin")) return -1;
    return strtol(name, NULL, 10);
}

static LiveLab *live_find(const char *key)
{
    uint32_t h = 2166136261u;
    for (const char *c = key; *c; c++) h = (h ^ (uint8_t)*c) * 16777619u;
    for (uint32_t k = 0; k < 8; k++) {
        LiveLab *l = &g_live[(h + k) & (LIVE_N - 1)];
        if (l->used && !strcmp(l->key, key)) return l;
    }
    return NULL;
}

static LiveLab *live_put(const char *key)
{
    uint32_t h = 2166136261u;
    for (const char *c = key; *c; c++) h = (h ^ (uint8_t)*c) * 16777619u;
    LiveLab *slot = NULL;
    for (uint32_t k = 0; k < 8 && !slot; k++) { LiveLab *l = &g_live[(h + k) & (LIVE_N - 1)]; if (!l->used) slot = l; }
    if (!slot) slot = &g_live[(h + (g_live_next++ & 7)) & (LIVE_N - 1)];
    snprintf(slot->key, sizeof(slot->key), "%s", key);
    slot->lab[0] = 0;
    slot->used = 1;
    return slot;
}

static void live_clear(void) { memset(g_live, 0, sizeof(g_live)); }
static int live_budget_left(void)
{
    if (now_us() - g_live_frame_t0 < LIVE_BUDGET_US) return 1;
    g_live_pending = 1;
    return 0;
}

static const char *file_label(const char *dir, const char *name, int is_dir)
{
    const char *bs = strrchr(dir, '/');
    bs = bs ? bs + 1 : dir;
    long dpk = pack_of_name(bs);
    if (nf_labels_loaded()) {
        long pk = pack_of_name(name);
        if (pk >= 0 && (is_dir || strstr(name, ".bin") || !strchr(name, '.'))) {
            const char *l = nf_label_pack((uint32_t)pk);
            if (l) return l;
        }
        if (dpk >= 0 && !is_dir) {
            char *end;
            unsigned long en = strtoul(name, &end, 10);
            if (end != name && *end == '.') {
                const char *l = nf_label_entry((uint32_t)dpk, (uint32_t)en);
                if (l) return l;
            }
        }
    }
    if (is_dir) return NULL;
    char full[EX_PATH_MAX];
    path_join(full, sizeof(full), dir, name);
    LiveLab *l = live_find(full);
    if (l) return l->lab[0] ? l->lab : NULL;
    if (g_overlay != OV_NONE) return NULL;         /* list is covered: don't spend time on it */
    if (!live_budget_left()) return NULL;          /* filled in on a later frame */
    l = live_put(full);
    uint8_t h[4] = { 0 };
    int fd = open(full, O_RDONLY);
    if (fd >= 0) {
        int ok = pread(fd, h, 4, 0) == 4;
        close(fd);
        int tag = ok;
        for (int k = 0; k < 4 && ok; k++) if (!((h[k] >= 'A' && h[k] <= 'Z') || (h[k] >= 'a' && h[k] <= 'z') || h[k] == ' ' || h[k] == '-')) tag = 0;
        if (ok && (tag || !memcmp(h, "SLZ", 3))) nf_label_file(full, l->lab, sizeof(l->lab));
    }
    return l->lab[0] ? l->lab : NULL;
}

static const char *cpk_row_label(const CpkEntry *e, int live)
{
    (void)live;
    if (!g_cpk.so4) return NULL;
    const char *l = nf_labels_loaded() ? nf_label_pack(e->id) : NULL;
    if (l || e->beyond_end) return l;
    char key[64];
    snprintf(key, sizeof(key), "cpk:%s:%u", base_name(g_cpk.path), e->id);
    LiveLab *c = live_find(key);
    if (c) return c->lab[0] ? c->lab : NULL;
    if (!live_budget_left()) return NULL;
    c = live_put(key);
    nf_label_range(g_cpk.fd, e->offset, e->size, c->lab, sizeof(c->lab));
    return c->lab[0] ? c->lab : NULL;
}

/* Zip `files` (names inside g_cpk_dest) into zip_name. 0 ok. */
static int nf_zip(const char *zip_name, const char *const *files, int n)
{
    static AcJob aj;
    memset(&aj, 0, sizeof(aj));
    snprintf(aj.base_dir, sizeof(aj.base_dir), "%s", g_cpk_dest);
    snprintf(aj.out_path, sizeof(aj.out_path), "%s/%s", g_cpk_dest, zip_name);
    aj.deflate = 1;
    char paths[4][EX_PATH_MAX + 64];
    const char *pv[4];
    for (int i = 0; i < n && i < 4; i++) { snprintf(paths[i], sizeof(paths[i]), "%s/%s", g_cpk_dest, files[i]); pv[i] = paths[i]; }
    snprintf(g_nfjob.current, sizeof(g_nfjob.current), "zipping %s", zip_name);
    unlink(aj.out_path);
    ac_scan(&aj, pv, n);
    int rc = ac_run(&aj, pv, n, ac_nf_cb, NULL);
    if (rc != 0 || aj.failed) { logx("Names: zip %s failed: %s", aj.out_path, aj.error); return -1; }
    return 0;
}

static void copy_small_file(const char *src, const char *dst)
{
    FILE *a = fopen(src, "rb");
    if (!a) return;
    char part[EX_PATH_MAX + 16];
    snprintf(part, sizeof(part), "%s.part", dst);
    FILE *b = fopen(part, "wb");
    if (!b) { fclose(a); return; }
    char buf[65536];
    size_t k;
    int bad = 0;
    while ((k = fread(buf, 1, sizeof(buf), a)) > 0) if (fwrite(buf, 1, k, b) != k) { bad = 1; break; }
    fclose(a);
    if (fclose(b) != 0 || bad || rename(part, dst) != 0) unlink(part);
}

static void nf_begin(const char *what)
{
    memset(&g_nfjob, 0, sizeof(g_nfjob));
    g_nfjob.cb = nf_cb;
    g_nfjob.skip_remaster = g_nf_skiprem;
    g_nf_what = what;
    g_progress_kind = PK_NAMES;
    g_overlay = OV_PROGRESS;
    g_prog_last_draw = 0;
    g_cancel_hold = 0;
}

static void nf_run(int names)
{
    if (!cpk_parsed() || !g_cpk.so4) { show_message("Open the Star Ocean 4 archives (0000.bin / 0001.bin) first."); return; }
    if (!cpk_dest_ok()) return;
    const char *pv[CPK_MAX_ARCH];
    int pn = 0;
    for (int a = 0; a < g_cpk_count; a++) pv[pn++] = g_cpk_paths[a];
    nf_begin(names ? "Name finder" : "Inner header list");
    uint64_t t0 = now_us();
    char out[EX_PATH_MAX + 32];
    int rc;
    if (names) rc = nf_find_names(pv, pn, g_cpk_dest, &g_nfjob);
    else { snprintf(out, sizeof(out), "%s/inner_headers.txt", g_cpk_dest); rc = nf_inner_headers(pv, pn, out, &g_nfjob); }
    unsigned secs = (unsigned)((now_us() - t0) / 1000000);
    const char *zipn = names ? "names.zip" : "inner_headers.zip";
    int zrc = -1;
    if (rc == 0) {
        static const char *nfiles[] = { "names.txt", "names_by_prefix.txt", "pack_names.txt" };
        static const char *hfiles[] = { "inner_headers.txt" };
        zrc = names ? nf_zip(zipn, nfiles, 3) : nf_zip(zipn, hfiles, 1);
        if (names) {
            char a[EX_PATH_MAX + 32], b[EX_PATH_MAX + 32];
            mkdir(APP_DATA, 0777);
            snprintf(a, sizeof(a), "%s/pack_names.txt", g_cpk_dest); copy_small_file(a, APP_DATA "/pack_names.txt");
            snprintf(a, sizeof(a), "%s/names.txt", g_cpk_dest); snprintf(b, sizeof(b), "%s/names.txt", APP_DATA); copy_small_file(a, b);
            labels_ensure(1);
        }
    }
    logx("Names: %s -> %s rc=%d, packs %u (%u KCAP), entries %u, names %u, prefixes %u, errors %u, %us%s%s",
         g_nf_what, g_cpk_dest, rc, g_nfjob.packs_done, g_nfjob.packs_kcap, g_nfjob.entries, g_nfjob.names, g_nfjob.prefixes,
         g_nfjob.errors, secs, g_nfjob.error[0] ? " - " : "", g_nfjob.error);
    g_done_ok = rc == 0 && zrc == 0;
    snprintf(g_done_head, sizeof(g_done_head), "%s", rc == -2 ? "Cancelled" : rc ? "Failed" : names ? "Name finder done" : "Inner header list done");
    if (rc == -2) snprintf(g_message, sizeof(g_message), "Stopped after %u of %u packs. Nothing was saved (run it again to start over).", g_nfjob.packs_done, g_nfjob.packs_total);
    else if (rc) snprintf(g_message, sizeof(g_message), "%s", g_nfjob.error[0] ? g_nfjob.error : "unknown error");
    else if (names)
        snprintf(g_message, sizeof(g_message), "%u packs, %u entries, %u names (%u prefixes), %u s%s. Saved names.txt, names_by_prefix.txt, "
                 "pack_names.txt + %s in %s. Names now show in FILES and the file list.",
                 g_nfjob.packs_kcap, g_nfjob.entries, g_nfjob.names, g_nfjob.prefixes, secs,
                 g_nfjob.errors ? " (some entries unreadable, see the log)" : "", zrc == 0 ? zipn : "(zip FAILED)", g_cpk_dest);
    else
        snprintf(g_message, sizeof(g_message), "%u packs, %u entries in %u s%s. Saved inner_headers.txt and %s in %s.",
                 g_nfjob.packs_kcap, g_nfjob.entries, secs, g_nfjob.errors ? " (some entries unreadable, see the log)" : "",
                 zrc == 0 ? zipn : "(zip FAILED)", g_cpk_dest);
    g_overlay = OV_DONE;
}

static void nf_res_clear(void)
{
    for (int i = 0; i < g_nf_nres; i++) free(g_nf_res[i]);
    g_nf_nres = g_nf_sel = g_nf_top = 0;
}
static void nf_res_add(const char *line, void *u) { (void)u; if (g_nf_nres < NF_RES_MAX) g_nf_res[g_nf_nres++] = strdup(line); }
static void nf_res_file(const char *line, void *u) { fprintf((FILE *)u, "%s\n", line); }

static void nf_do_search(const char *word)
{
    char nt[EX_PATH_MAX + 32];
    if (names_txt_path(nt, sizeof(nt)) != 0) { show_message("No names.txt yet - run the Name finder first (it is saved in the output folder)."); return; }
    snprintf(g_nf_word, sizeof(g_nf_word), "%s", word);
    while (g_nf_word[0] == ' ') memmove(g_nf_word, g_nf_word + 1, strlen(g_nf_word));
    if (!g_nf_word[0]) { show_message("Type a word to search for (for example Fire or pc01)."); return; }
    cpk_busy_frame("Searching names...");
    nf_res_clear();
    g_nf_total = nf_search(nt, g_nf_word, NF_RES_MAX, nf_res_add, NULL, &g_nf_rpacks, &g_nf_rentries);
    if (g_nf_total < 0) { show_message("Cannot read %s", nt); return; }
    /* save every match */
    char safe[64], out[EX_PATH_MAX + 96];
    int k = 0;
    for (const char *c = g_nf_word; *c && k < 40; c++) safe[k++] = isalnum((unsigned char)*c) ? *c : '_';
    safe[k] = 0;
    snprintf(out, sizeof(out), "%s/search_%s.txt", g_cpk_dest, safe);
    FILE *f = g_cpk_dest[0] ? fopen(out, "w") : NULL;
    if (f) {
        fprintf(f, "# search \"%s\" in %s\n# pack\tentry\ttype\tname\n", g_nf_word, nt);
        nf_search(nt, g_nf_word, 1 << 30, nf_res_file, f, NULL, NULL);
        fclose(f);
    }
    logx("Names: search \"%s\": %d matches in %u packs / %u entries%s%s", g_nf_word, g_nf_total, g_nf_rpacks, g_nf_rentries, f ? " -> " : "", f ? out : "");
    g_overlay = OV_NAMES;
}

#define NF_ROWS 17
static void draw_names(void)
{
    gfx_rect_blend(0, 0, SCREEN_W, SCREEN_H, RGB(0, 0, 0), 215);
    PANEL(60, 150, SCREEN_W - 120, 870);
    int x = 100, y = 166;
    char line[600];
    snprintf(line, sizeof(line), "Names containing \"%s\"", g_nf_word);
    gfx_text(FONT_LARGE, x, y, C_ACCENT, line);
    y += 60;
    snprintf(line, sizeof(line), "%d match%s in %u pack%s / %u entr%s%s   (underscores and case are ignored: pc01 finds pc_01_eye1)",
             g_nf_total, g_nf_total == 1 ? "" : "es", g_nf_rpacks, g_nf_rpacks == 1 ? "" : "s", g_nf_rentries, g_nf_rentries == 1 ? "y" : "ies",
             g_nf_total > g_nf_nres ? "  - first 2000 shown, all saved to search_*.txt" : "");
    gfx_text_clip(FONT_SMALL, x, y, C_DIM, line, SCREEN_W - 220);
    y += 44;
    gfx_text(FONT_SMALL, x, y, C_DIM, "Pack");
    gfx_text(FONT_SMALL, x + 140, y, C_DIM, "Entry");
    gfx_text(FONT_SMALL, x + 260, y, C_DIM, "Type");
    gfx_text(FONT_SMALL, x + 380, y, C_DIM, "Name");
    gfx_text(FONT_SMALL, x + 1100, y, C_DIM, "Pack name");
    y += 40;
    if (g_nf_sel < g_nf_top) g_nf_top = g_nf_sel;
    if (g_nf_sel >= g_nf_top + NF_ROWS) g_nf_top = g_nf_sel - NF_ROWS + 1;
    for (int r = 0; r < NF_ROWS && g_nf_top + r < g_nf_nres; r++) {
        int i = g_nf_top + r;
        if (i == g_nf_sel) gfx_rect_blend(x - 14, y - 5, SCREEN_W - 172, 40, C_SEL, 175);
        char tmp[300], *f[4] = { 0 };
        snprintf(tmp, sizeof(tmp), "%s", g_nf_res[i] ? g_nf_res[i] : "");
        int nf = 0;
        for (char *t = tmp, *q; nf < 4 && t; t = q) { q = strchr(t, '\t'); if (q) *q++ = 0; f[nf++] = t; }
        if (nf < 4) continue;
        gfx_text(FONT_SMALL, x, y, C_TEXT, f[0]);
        gfx_text(FONT_SMALL, x + 140, y, C_TEXT, f[1]);
        gfx_text(FONT_SMALL, x + 260, y, C_DIM, f[2]);
        gfx_text_clip(FONT_SMALL, x + 380, y, C_ACCENT, f[3], 700);
        const char *pl = nf_labels_loaded() ? nf_label_pack((uint32_t)strtoul(f[0], NULL, 10)) : NULL;
        if (pl) gfx_text_clip(FONT_SMALL, x + 1100, y, C_DIM, pl, SCREEN_W - x - 1240);
        y += 42;
    }
    snprintf(line, sizeof(line), "%d / %d", g_nf_nres ? g_nf_sel + 1 : 0, g_nf_nres);
    gfx_text(FONT_SMALL, SCREEN_W - 300, 975, C_DIM, line);
    draw_footer(GLYPH_CROSS " Show this pack in the file list   " GLYPH_TRIANGLE " New search   " GLYPH_CIRCLE " Back   L2/R2 page");
}

static void cpk_keyboard(int purpose, const char *title, const char *initial);
static void numpad_open_mode(int purpose, const char *title, const char *initial, int mode);
static void update_names(void)
{
    if (repeat(ORBIS_PAD_BUTTON_DOWN) && g_nf_sel < g_nf_nres - 1) g_nf_sel++;
    if (repeat(ORBIS_PAD_BUTTON_UP) && g_nf_sel > 0) g_nf_sel--;
    if (repeat(ORBIS_PAD_BUTTON_R2)) { g_nf_sel += NF_ROWS; if (g_nf_sel > g_nf_nres - 1) g_nf_sel = g_nf_nres - 1; }
    if (repeat(ORBIS_PAD_BUTTON_L2)) { g_nf_sel -= NF_ROWS; if (g_nf_sel < 0) g_nf_sel = 0; }
    if (g_nf_sel < 0) g_nf_sel = 0;
    if (pressed(ORBIS_PAD_BUTTON_CIRCLE)) { g_overlay = OV_CPK; return; }
    if (pressed(ORBIS_PAD_BUTTON_TRIANGLE)) { numpad_open_mode(KB_NAMESEARCH, "Search names", g_nf_word, 1); return; }
    if (pressed(ORBIS_PAD_BUTTON_CROSS) && g_nf_nres) {
        uint32_t id = (uint32_t)strtoul(g_nf_res[g_nf_sel], NULL, 10);
        for (int pass = 0; pass < g_cpk_count; pass++) {
            if (cpk_parsed())
                for (uint32_t i = 0; i < g_cpk.n; i++)
                    if (g_cpk.e[i].id == id) { g_lv_sel = (int)i; g_lv_top = g_lv_sel > 8 ? g_lv_sel - 8 : 0; g_overlay = OV_CPK_VIEW; return; }
            if (g_cpk_count < 2) break;
            cpk_select((g_cpk_view + 1) % g_cpk_count);
        }
        show_message("Pack %05u is not in the open archives.", id);
    }
}

static void update_cpk(void)
{
    if (repeat(ORBIS_PAD_BUTTON_DOWN)) g_cpk_sel = (g_cpk_sel + 1) % CI_N;
    if (repeat(ORBIS_PAD_BUTTON_UP)) g_cpk_sel = (g_cpk_sel + CI_N - 1) % CI_N;
    if (pressed(ORBIS_PAD_BUTTON_RIGHT) && g_cpk_count > 1) cpk_select((g_cpk_view + 1) % g_cpk_count);
    if (pressed(ORBIS_PAD_BUTTON_LEFT) && g_cpk_count > 1) cpk_select((g_cpk_view + g_cpk_count - 1) % g_cpk_count);
    if (pressed(ORBIS_PAD_BUTTON_CIRCLE)) { close_cpk_screen(); return; }
    if (!pressed(ORBIS_PAD_BUTTON_CROSS)) return;
    switch (g_cpk_sel) {
    case CI_HEAD: cpk_header_dump(); break;
    case CI_LIST: cpk_save_listing(); break;
    case CI_MAGIC: {
        if (!cpk_parsed()) { show_message("This file is not a readable archive."); break; }
        if (!cpk_dest_ok()) break;
        char out[EX_PATH_MAX + 16], err[256] = "";
        snprintf(out, sizeof(out), "%s/magic.txt", g_cpk_dest);
        const char *pv[CPK_MAX_ARCH];
        int pn = 0;
        for (int a = 0; a < g_cpk_count; a++) pv[pn++] = g_cpk_paths[a];
        cpk_busy_frame("Reading the first 32 bytes of every file...");
        uint32_t lines = 0;
        int rc = cpk_write_magic(pv, pn, out, &lines, err, sizeof(err));
        logx("CPK: magic survey -> %s (%s, %u lines)", out, rc == 0 ? "OK" : err, lines);
        if (rc == 0) {
            char sum[EX_PATH_MAX + 32], verdict[600] = "";
            snprintf(sum, sizeof(sum), "%s/magic_summary.txt", g_cpk_dest);
            cpk_busy_frame("Tallying formats...");
            cpk_write_magic_summary(pv, pn, sum, verdict, sizeof(verdict), err, sizeof(err));
            logx("CPK: magic summary -> %s: %s", sum, verdict);
            show_message("%s.  Saved magic_summary.txt (format counts, tiny) and magic.txt (%u files, 32 bytes each) in %s. "
                         "Send both to Claude before Extract ALL.", verdict, lines, g_cpk_dest);
        } else show_message("Magic survey failed: %s", err);
        break;
    }
    case CI_VIEW:
        if (!cpk_parsed()) { show_message("This file is not a readable archive, so there is no file list."); break; }
        g_lv_sel = g_lv_top = 0;
        labels_ensure(0);
        g_overlay = OV_CPK_VIEW;
        break;
    case CI_INNER: nf_run(0); break;
    case CI_NAMES: nf_run(1); break;
    case CI_SEARCH: numpad_open_mode(KB_NAMESEARCH, "Search names", g_nf_word, 1); break;
    case CI_SKIPREM: g_nf_skiprem = !g_nf_skiprem; settings_save(); break;
    case CI_ONE:
        if (!cpk_parsed()) { show_message("This file is not a readable CPK archive."); break; }
        numpad_open(KB_CPK_ONE, "Extract by ID", "");
        break;
    case CI_ALL: cpk_prepare_all(0); break;
    case CI_UNPACKALL: unpack_all_entries(); break;
    case CI_ALLSET:
        if (g_cpk_count < 2) show_message("Only one archive is open.");
        else cpk_prepare_all(1);
        break;
    case CI_RANGE: numpad_open(KB_CPK_RANGE, "Dump a byte range: offset length", "0x0 0x100000"); break;
    case CI_DEST: g_cwd[0] = 0; start_pick(PICK_CPK_DEST); break;
    case CI_RAW: g_cpk_keep_raw = !g_cpk_keep_raw; settings_save(); break;
    case CI_CLOSE: close_cpk_screen(); break;
    }
}

/* ---------- input handling ---------- */
static void files_select_all(void)
{
    if (!g_cwd[0]) { show_message("Open a folder first."); return; }
    char full[EX_PATH_MAX];
    int added = 0;
    for (int i = 0; i < g_count && g_mark_count < AC_MAX_ITEMS; i++) {
        path_join(full, sizeof(full), g_cwd, g_entries[i].name);
        if (mark_index(full) < 0) { snprintf(g_mark[g_mark_count++], AC_PATH_MAX, "%s", full); added++; }
    }
    logx("Selected %d items in %s (%d total)", added, g_cwd, g_mark_count);
}

static void set_log_folder(const char *dir)
{
    char lp[EX_PATH_MAX];
    path_join(lp, sizeof(lp), dir, "log.txt");
    if (logger_set_path(lp) == 0) {
        settings_save();
        show_message("Log file is now: %s", lp);
    } else {
        show_message("Cannot write a log file in %s (read-only or full?)", dir);
    }
}

static void confirm_pick(void)
{
    if (!g_cwd[0]) { show_message("Open a folder first, then press OPTIONS."); return; }
    int mode = g_pick;
    char dir[EX_PATH_MAX];
    snprintf(dir, sizeof(dir), "%s", g_cwd);
    if (!dir_writable(dir)) { show_message("%s is read-only. Pick another folder.", dir); return; }
    end_pick();
    if (mode == PICK_LOG) {
        set_log_folder(dir);
    } else if (mode == PICK_EXTRACT_DEFAULT) {
        snprintf(g_extract_dir, sizeof(g_extract_dir), "%s", dir);
        settings_save();
        logx("Default extraction folder set to %s", dir);
        show_message("Default extraction folder: %s", dir);
    } else if (mode == PICK_EXTRACT_ONCE) {
        char dest[EX_PATH_MAX];
        path_join(dest, sizeof(dest), dir, g_job_stem);
        run_extract_to(dest);
    } else if (mode == PICK_CPK_DEST) {
        g_overlay = OV_CPK;
        if (!dest_allowed(dir)) {
            show_message("%s can't be used for output (pick /data, a USB drive or extended storage).", dir);
            return;
        }
        snprintf(g_cpk_dest, sizeof(g_cpk_dest), "%s", dir);
        settings_save();
        uint64_t fs = 0;
        char a[32] = "unknown";
        if (free_space(dir, &fs) == 0) fmt_size(fs, a, sizeof(a));
        logx("CPK output folder set to %s (free %s)", dir, a);
    }
}

static void update_files(void)
{
    if (repeat(ORBIS_PAD_BUTTON_DOWN) && g_count) g_sel = (g_sel + 1) % g_count;
    if (repeat(ORBIS_PAD_BUTTON_UP) && g_count) g_sel = (g_sel + g_count - 1) % g_count;
    if (repeat(ORBIS_PAD_BUTTON_R2) && g_count) { g_sel += LIST_ROWS; if (g_sel >= g_count) g_sel = g_count - 1; }
    if (repeat(ORBIS_PAD_BUTTON_L2) && g_count) { g_sel -= LIST_ROWS; if (g_sel < 0) g_sel = 0; }

    if (pressed(ORBIS_PAD_BUTTON_OPTIONS)) {
        if (g_pick != PICK_NONE) confirm_pick();
        else { g_actions_sel = 0; g_overlay = OV_ACTIONS; }
        return;
    }
    if (pressed(ORBIS_PAD_BUTTON_CIRCLE)) {
        if (g_pick != PICK_NONE && !g_cwd[0]) { /* cancel picking from the device list */
            int was = g_pick;
            end_pick();
            if (was == PICK_EXTRACT_ONCE) logx("Extraction cancelled (no folder chosen)");
            if (was == PICK_CPK_DEST) g_overlay = OV_CPK;
            return;
        }
        go_up();
        return;
    }
    if (pressed(ORBIS_PAD_BUTTON_R3) && g_cwd[0]) {          /* sort: name -> size -> format */
        char keep[256] = "";
        if (g_count && g_sel < g_count) snprintf(keep, sizeof(keep), "%s", g_entries[g_sel].name);
        g_sort = (g_sort + 1) % SORT_COUNT;
        qsort(g_entries, g_count, sizeof(Entry), cmp_entry);
        for (int i = 0; i < g_count; i++) if (!strcmp(g_entries[i].name, keep)) { g_sel = i; break; }
        g_scroll = g_sel >= LIST_ROWS ? g_sel - LIST_ROWS / 2 : 0;
    }
    if (pressed(ORBIS_PAD_BUTTON_TRIANGLE) && g_pick == PICK_NONE) {
        g_filter = !g_filter;
        load_dir(g_count ? g_entries[g_sel].name : NULL);
    }
    if (pressed(ORBIS_PAD_BUTTON_SQUARE) && g_pick == PICK_NONE && g_cwd[0] && g_count) {
        char full[EX_PATH_MAX];
        path_join(full, sizeof(full), g_cwd, g_entries[g_sel].name);
        mark_toggle(full);
        if (g_sel < g_count - 1) g_sel++;
    }
    if (pressed(ORBIS_PAD_BUTTON_CROSS) && g_count) {
        Entry *e = &g_entries[g_sel];
        if (e->is_dir) {
            char next[EX_PATH_MAX];
            if (!g_cwd[0]) snprintf(next, sizeof(next), "%s", e->name);
            else path_join(next, sizeof(next), g_cwd, e->name);
            snprintf(g_cwd, sizeof(g_cwd), "%s", next);
            load_dir(NULL);
        } else if (g_pick != PICK_NONE) {
            /* picking a folder: files do nothing */
        } else if (e->is_archive) {
            start_extract(e->name);
        } else {
            char full[EX_PATH_MAX];
            path_join(full, sizeof(full), g_cwd, e->name);
            if (file_is_image(full)) img_open_highlighted();
            else open_viewer_for(full);
        }
    }
}

static int g_ports_sel;

/* ---------- batch script runner (automates this app's own operations) ---------- */
static void write_sample_script(void)
{
    if (!dest_allowed(g_extract_dir) || ex_mkdirs(g_extract_dir) != 0) return;
    char path[EX_PATH_MAX + 32];
    snprintf(path, sizeof(path), "%s/sample_script.txt", g_extract_dir);
    FILE *f = fopen(path, "w");
    if (!f) { show_message("Could not write the sample to %s.", g_extract_dir); return; }
    fprintf(f,
        "# Sample batch script for Star Ocean Utility Tool.\n"
        "# One command per line. Lines starting with # are comments.\n"
        "# It only drives this app's own file operations - never console code.\n"
        "#\n"
        "# cd sets the folder that later relative names are based on.\n"
        "cd /mnt/usb0/CUSA09485\n"
        "# dest is where output goes (must be /data, a USB drive or extended storage).\n"
        "dest /mnt/usb0/so4_out\n"
        "#\n"
        "list 0000.bin               # write listing_0000.txt\n"
        "list 0001.bin\n"
        "magic                       # format survey: magic.txt + magic_summary.txt (send to Claude)\n"
        "extract 0001.bin 656 657    # extract a few files by ID\n"
        "extract 0000.bin 0-3        # a range of IDs\n"
        "unpackid 0001.bin 656       # unpack an entry in place (KCAP/SLZ, banks, DDS...)\n"
        "convert *.dds               # every DDS in the cd folder -> PNG\n"
        "dump 0000.bin 0x1000 0x200  # save a byte range\n"
        "zip textures.zip *.png      # (paths are relative to cd)\n"
        "echo All done\n");
    fclose(f);
    logx("Wrote sample script to %s", path);
}

static int script_cb(void *u) { (void)u; return on_progress_common(); }

static void run_script_file(const char *path)
{
    snprintf(g_script_path, sizeof(g_script_path), "%s", path);
    memset(&g_sjob, 0, sizeof(g_sjob));
    g_sjob.cb = script_cb;
    g_prog_start = g_prog_last_draw = now_us();
    g_prog_last_tick = 0;
    g_cancel_hold = 0;
    g_progress_kind = PK_SCRIPT;
    g_overlay = OV_PROGRESS;
    logx("SCRIPT: running %s", path);
    int rc = script_run(path, &g_sjob);
    g_done_ok = rc == 0;
    snprintf(g_done_head, sizeof(g_done_head), "%s", rc == -2 ? "Script cancelled" : rc == -1 ? "Script not read" :
             g_sjob.failed ? "Script finished with errors" : "Script finished");
    if (rc == -1)
        snprintf(g_message, sizeof(g_message), "%s", g_sjob.error);
    else
        snprintf(g_message, sizeof(g_message), "%u command(s) ok, %u failed, %u file(s) written.%s%s%s",
                 g_sjob.ok, g_sjob.failed, g_sjob.files, g_sjob.stopped ? " Stopped early." : "",
                 g_sjob.failed ? " First error: " : "", g_sjob.failed ? g_sjob.error : "");
    notify("Script: %s", g_done_head);
    g_overlay = OV_DONE;
}

static void run_highlighted_script(void)
{
    if (!g_cwd[0] || !g_count || g_entries[g_sel].is_dir) { show_message("Highlight a .txt script first."); return; }
    const char *nm = g_entries[g_sel].name, *ext = strrchr(nm, '.');
    if (!ext || strcasecmp(ext, ".txt")) { show_message("A script must be a .txt file. (TOOLS can write a sample for you.)"); return; }
    char full[EX_PATH_MAX];
    path_join(full, sizeof(full), g_cwd, nm);
    run_script_file(full);
}

/* ---------- payload verify (SHA-256, never runs the file) ---------- */
static void verify_highlighted(void)
{
    if (!g_cwd[0] || !g_count || g_entries[g_sel].is_dir) { show_message("Highlight a file first."); return; }
    char full[EX_PATH_MAX];
    path_join(full, sizeof(full), g_cwd, g_entries[g_sel].name);
    int fd = open(full, O_RDONLY);
    if (fd < 0) { show_message("Cannot open %s: %s", g_entries[g_sel].name, strerror(errno)); return; }
    Sha256 c;
    sha256_init(&c);
    uint8_t *buf = malloc(1 << 20);
    uint64_t total = 0;
    if (buf) {
        cpk_busy_frame("Hashing (SHA-256)...");
        for (;;) {
            ssize_t r = read(fd, buf, 1 << 20);
            if (r <= 0) break;
            sha256_update(&c, buf, (size_t)r);
            total += (uint64_t)r;
        }
    }
    free(buf);
    close(fd);
    uint8_t h[32];
    char hex[65], sz[32];
    sha256_final(&c, h);
    sha256_hex(h, hex);
    fmt_size(total, sz, sizeof(sz));
    logx("VERIFY: %s  %llu bytes  SHA-256 %s", g_entries[g_sel].name, (unsigned long long)total, hex);
    show_message("%s  -  %s (%llu bytes).  SHA-256: %s   Compare it with the official release hash. "
                 "This only reads the file; it never runs it. (Also written to the log.)",
                 g_entries[g_sel].name, sz, (unsigned long long)total, hex);
}

/* ---------- homebrew service ports ---------- */
#define PORTS_N 5
static void draw_ports(void)
{
    gfx_rect_blend(0, 0, SCREEN_W, SCREEN_H, RGB(0, 0, 0), 190);
    int bx = 300, by = 200, bw = SCREEN_W - 600;
    PANEL(bx, by, bw, 620);
    int x = bx + 40, y = by + 34;
    gfx_text(FONT_LARGE, x, y, C_ACCENT, "Homebrew service ports"); y += 64;
    gfx_text_clip(FONT_SMALL, x, y, C_DIM,
                  "Ports the homebrew services listen on while jailbroken. Editing them only saves the number.", bw - 80); y += 50;
    struct { const char *name, *what; int val; } rows[PORTS_N - 1] = {
        { "Payload loader", "send a .bin/.elf here to load it", g_port_loader },
        { "Debugger (RPC)", "memory read/write, breakpoints", g_port_debug },
        { "FTP", "move files on/off the console", g_port_ftp },
        { "Kernel log (klog)", "read-only system messages", g_port_klog },
    };
    for (int i = 0; i < PORTS_N; i++) {
        int ry = y + i * 72;
        if (i == g_ports_sel) gfx_rect_blend(x - 14, ry - 6, bw - 52, 64, C_SEL, 170);
        if (i < PORTS_N - 1) {
            gfx_text(FONT_SMALL, x, ry, C_TEXT, rows[i].name);
            gfx_text_clip(FONT_SMALL, x + 20, ry + 32, C_DIM, rows[i].what, bw - 260);
            char v[16];
            snprintf(v, sizeof(v), "%d", rows[i].val);
            gfx_text(FONT_SMALL, x + bw - 180, ry + 12, C_ACCENT, v);
        } else {
            gfx_text(FONT_SMALL, x, ry, C_TEXT, "Reset to defaults (9020 / 744 / 2121 / 3232)");
        }
    }
    gfx_text(FONT_SMALL, x, by + 560, C_DIM, GLYPH_CROSS " Edit   " GLYPH_CIRCLE " Back");
}

static void cpk_apply_typed(int purpose, const char *typed);
static void cpk_keyboard(int purpose, const char *title, const char *initial);

/* ---------- built-in keypads: no system keyboard needed ----------
 * Mode 0: number pad for IDs / byte ranges.  Mode 1: letters for Search names. */
#define NP_COLS 6
#define NP_N    24
static const char *np_keys[NP_N] = {
    "1", "2", "3", "A", "B", "-",
    "4", "5", "6", "C", "D", "Space",
    "7", "8", "9", "E", "F", "Delete",
    "0", "x", "Clear", "PS4 keyboard", "Cancel", "Done" };
#define TK_COLS 10
#define TK_N    50
static const char *tk_keys[TK_N] = {
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
    "Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P",
    "A", "S", "D", "F", "G", "H", "J", "K", "L", "_",
    "Z", "X", "C", "V", "B", "N", "M", "-", ".", "Space",
    "Delete", "Delete", "Clear", "Clear", "PS4 keyboard", "PS4 keyboard", "Cancel", "Cancel", "Done", "Done" };
static int g_np_mode, g_np_return;

static int np_cols(void) { return g_np_mode ? TK_COLS : NP_COLS; }
static int np_n(void) { return g_np_mode ? TK_N : NP_N; }
static const char *np_key(int i) { return g_np_mode ? tk_keys[i] : np_keys[i]; }

static void numpad_open_mode(int purpose, const char *title, const char *initial, int mode)
{
    g_np_purpose = purpose;
    g_np_mode = mode;
    g_np_return = g_overlay == OV_NAMES ? OV_NAMES : OV_CPK;
    snprintf(g_np_title, sizeof(g_np_title), "%s", title);
    int slot = purpose == KB_CPK_RANGE;
    if (mode) snprintf(g_np_text, sizeof(g_np_text), "%s", initial);
    else snprintf(g_np_text, sizeof(g_np_text), "%s", g_np_last[slot][0] ? g_np_last[slot] : initial);
    g_np_sel = mode ? 10 : 0;
    g_overlay = OV_NUMPAD;
}
static void numpad_open(int purpose, const char *title, const char *initial) { numpad_open_mode(purpose, title, initial, 0); }

static void numpad_add(const char *t)
{
    size_t l = strlen(g_np_text);
    if (l + strlen(t) < sizeof(g_np_text)) strcat(g_np_text, t);
}

static void numpad_del(void)
{
    size_t l = strlen(g_np_text);
    if (l) g_np_text[l - 1] = 0;
}

static void numpad_cancel(void)
{
    g_overlay = g_np_return;
    logx("Keypad cancelled");
}

static void numpad_done(void)
{
    char *t = g_np_text;
    while (*t == ' ') t++;
    if (!*t) {
        show_message(g_np_mode ? "Nothing typed yet - type a word (e.g. FIRE or PC01), then choose Done."
                               : "Nothing typed yet - enter at least one ID (e.g. 53 or 80-86), then choose Done.");
        return;
    }
    if (!g_np_mode) snprintf(g_np_last[g_np_purpose == KB_CPK_RANGE], sizeof(g_np_last[0]), "%s", g_np_text);
    char typed[256];
    snprintf(typed, sizeof(typed), "%s", t);
    g_overlay = OV_CPK;
    logx("Keypad entry: %s", typed);
    cpk_apply_typed(g_np_purpose, typed);
}

static void draw_numpad(void)
{
    gfx_rect_blend(0, 0, SCREEN_W, SCREEN_H, RGB(0, 0, 0), 150);
    int bx = 200, by = 180, bw = SCREEN_W - 400;
    int cols = np_cols(), n = np_n(), ch = g_np_mode ? 70 : 78;
    int boxh = g_np_mode ? 760 : 700;
    gfx_rect_blend(bx, by, bw, boxh, C_PANEL, 240);   /* nearly solid: keep the keys readable */
    gfx_text(FONT_LARGE, bx + 50, by + 30, C_ACCENT, g_np_title);
    /* text box: show the end of the text if it is too long */
    int tx = bx + 50, ty = by + 120, tw = bw - 100;
    gfx_rect_blend(tx - 10, ty - 10, tw + 20, 56, RGB(0, 0, 0), 170);
    char shown[300];
    snprintf(shown, sizeof(shown), "%s_", g_np_text);
    const char *p = shown;
    while (*p && gfx_text_width(FONT_SMALL, p) > tw) p++;
    gfx_text(FONT_SMALL, tx, ty, C_TEXT, p);
    int cw = (bw - 100) / cols, gx = bx + 50, gy = by + 210;
    const char *selk = np_key(g_np_sel);
    for (int i = 0; i < n; i++) {
        if (i % cols && !strcmp(np_key(i), np_key(i - 1))) continue;     /* wide key: drawn with its left half */
        int span = 1;
        while ((i % cols) + span < cols && !strcmp(np_key(i + span), np_key(i))) span++;
        int x = gx + (i % cols) * cw, y = gy + (i / cols) * ch;
        int sel = !strcmp(np_key(i), selk) && i / cols == g_np_sel / cols;
        gfx_rect_blend(x + 4, y + 4, cw * span - 8, ch - 8, sel ? C_SEL : C_BAR_BG, sel ? 230 : 170);
        const char *k = np_key(i);
        Color c = !strcmp(k, "Done") ? C_OK : !strcmp(k, "Cancel") ? C_ERR : strlen(k) > 1 ? C_DIM : C_TEXT;
        if (sel) c = C_TEXT;
        int w = gfx_text_width(FONT_SMALL, k);
        gfx_text(FONT_SMALL, x + (cw * span - w) / 2, y + (ch - 30) / 2, c, k);
    }
    int hy = gy + (n / cols) * ch + 20;
    gfx_text(FONT_SMALL, bx + 50, hy, C_DIM, g_np_mode ? "Case and _ - . are ignored when searching: PC01 finds pc_01_eye1"
                                                    : "Example: 53 531 80-86 321 1411   (IDs and ranges, separated by spaces)");
    gfx_text(FONT_SMALL, bx + 50, hy + 50, C_TEXT, "D-Pad move  " GLYPH_CROSS " press key  " GLYPH_SQUARE " delete  "
             GLYPH_TRIANGLE " space  R2 Done  " GLYPH_CIRCLE " cancel");
}

static void update_numpad(void)
{
    int cols = np_cols(), n = np_n(), rows = n / cols;
    int r = g_np_sel / cols, c = g_np_sel % cols;
    if (repeat(ORBIS_PAD_BUTTON_RIGHT)) {          /* skip the other half of a wide key */
        const char *k = np_key(g_np_sel);
        do c = (c + 1) % cols; while (c && !strcmp(np_key(r * cols + c), k));
    }
    if (repeat(ORBIS_PAD_BUTTON_LEFT)) {
        c = (c + cols - 1) % cols;
        while (c && !strcmp(np_key(r * cols + c), np_key(r * cols + c - 1))) c--;
    }
    if (repeat(ORBIS_PAD_BUTTON_DOWN)) r = (r + 1) % rows;
    if (repeat(ORBIS_PAD_BUTTON_UP)) r = (r + rows - 1) % rows;
    g_np_sel = r * cols + c;
    if (repeat(ORBIS_PAD_BUTTON_SQUARE)) numpad_del();
    if (pressed(ORBIS_PAD_BUTTON_TRIANGLE)) numpad_add(" ");
    if (pressed(ORBIS_PAD_BUTTON_CIRCLE)) { numpad_cancel(); return; }
    if (pressed(ORBIS_PAD_BUTTON_R2)) { numpad_done(); return; }
    if (!repeat(ORBIS_PAD_BUTTON_CROSS)) return;
    const char *k = np_key(g_np_sel);
    if (!strcmp(k, "Space")) numpad_add(" ");
    else if (!strcmp(k, "Delete")) numpad_del();
    else if (!strcmp(k, "Clear")) g_np_text[0] = 0;
    else if (!strcmp(k, "Cancel")) numpad_cancel();
    else if (!strcmp(k, "Done")) numpad_done();
    else if (!strcmp(k, "PS4 keyboard")) {
        char init[256];
        snprintf(init, sizeof(init), "%s", g_np_text);
        cpk_keyboard(g_np_purpose, g_np_title, init);
    } else numpad_add(k);
}
static void draw_kbd_rescue(void)
{
    gfx_rect_blend(0, 0, SCREEN_W, SCREEN_H, RGB(0, 0, 0), 150);
    PANEL(240, 320, SCREEN_W - 480, 420);
    gfx_text(FONT_LARGE, 300, 360, C_WARN, "Keyboard closed with " GLYPH_CIRCLE);
    gfx_text(FONT_SMALL, 300, 440, C_TEXT, "You had typed:");
    text_wrap(FONT_SMALL, 300, 480, C_ACCENT, g_rescue_text, SCREEN_W - 600, 3);
    gfx_text(FONT_SMALL, 300, 590, C_DIM, "Next time confirm with R2 (Done) on the keyboard; " GLYPH_CIRCLE " closes it.");
    gfx_text(FONT_SMALL, 300, 660, C_TEXT, GLYPH_CROSS " Use this text     " GLYPH_CIRCLE " Discard");
}

static void update_kbd_rescue(void)
{
    if (pressed(ORBIS_PAD_BUTTON_CROSS)) {
        g_overlay = OV_CPK;
        logx("CPK: using text typed before Circle: %s", g_rescue_text);
        cpk_apply_typed(g_rescue_purpose, g_rescue_text);
    } else if (pressed(ORBIS_PAD_BUTTON_CIRCLE)) {
        g_overlay = OV_CPK;
        logx("CPK: typed text discarded");
    }
}

static void cpk_apply_typed(int purpose, const char *typed)
{
    if (purpose == KB_CPK_ONE) cpk_extract_one_named(typed);
    else if (purpose == KB_NAMESEARCH) nf_do_search(typed);
    else if (purpose == KB_CPK_RANGE) cpk_dump_typed_range(typed);
}

static void update_ports(void)
{
    if (repeat(ORBIS_PAD_BUTTON_DOWN)) g_ports_sel = (g_ports_sel + 1) % PORTS_N;
    if (repeat(ORBIS_PAD_BUTTON_UP)) g_ports_sel = (g_ports_sel + PORTS_N - 1) % PORTS_N;
    if (pressed(ORBIS_PAD_BUTTON_CIRCLE)) { g_overlay = OV_NONE; return; }
    if (!pressed(ORBIS_PAD_BUTTON_CROSS)) return;
    if (g_ports_sel == PORTS_N - 1) {
        g_port_loader = 9020; g_port_debug = 744; g_port_ftp = 2121; g_port_klog = 3232;
        settings_save();
        logx("Ports reset to defaults");
        return;
    }
    g_port_edit = g_ports_sel;
    int cur = g_port_edit == 0 ? g_port_loader : g_port_edit == 1 ? g_port_debug : g_port_edit == 2 ? g_port_ftp : g_port_klog;
    char init[16];
    snprintf(init, sizeof(init), "%d", cur);
    g_kbd_purpose = KB_PORT;
    if (kbd_open("Port number 1-65535   (R2 = Done)", init, 5) == 0) g_overlay = OV_KEYBOARD;
    else show_message("The on-screen keyboard could not open.");
}

static void probe_line(const char *l) { logx("GPU probe: %s", l); }

#define PROBE_NEXT_FILE APP_DATA "/gpu_probe_next2.txt"   /* new name in v1.33: the test list changed, start at 1 again */
/* the probe continues where it stopped after the app is restarted */
static void probe_next_load(void)
{
    static int done;
    if (done) return;
    done = 1;
    FILE *f = fopen(PROBE_NEXT_FILE, "r");
    if (!f) return;
    int n = 0;
    if (fscanf(f, "%d", &n) == 1 && n >= 1 && n <= gpu_probe_count()) g_probe_first = n;
    fclose(f);
}

static void run_gpu_probe(void)
{
    if (gpu_active()) { show_message("The GPU renderer is already running. Restart the app to probe again."); return; }
    mkdir(APP_DATA, 0777);
    char sum[1200];
    logx("GPU probe starting at test %d", g_probe_first);
    /* written before the run: if the app dies inside a test, the next start skips it */
    { FILE *f = fopen(PROBE_NEXT_FILE, "w"); if (f) { fprintf(f, "%d\n", g_probe_first % gpu_probe_count() + 1); fclose(f); } }
    int r = gpu_probe(g_probe_first, APP_DATA "/gpu_probe.txt", probe_line, sum, sizeof sum);
    int nx = gpu_probe_next();
    logx("GPU probe finished: %d (continue at %d)", r, nx);
    if (nx > 0) { FILE *f = fopen(PROBE_NEXT_FILE, "w"); if (f) { fprintf(f, "%d\n", nx); fclose(f); } g_probe_first = nx; }
    else { remove(PROBE_NEXT_FILE); g_probe_first = 1; }
    if (r == -2) { show_message("The probe stopped and the screen could not be restored. Restart the app and run the probe again (it continues at test %d).", nx); return; }
    if (tv_open_path(APP_DATA "/gpu_probe.txt") != 0)
        show_message("GPU probe finished (%d). Results are in %s", r, APP_DATA "/gpu_probe.txt");
}

static void update_tools(void)
{
    if (repeat(ORBIS_PAD_BUTTON_DOWN)) g_tools_sel = (g_tools_sel + 1) % TOOLS_N;
    if (repeat(ORBIS_PAD_BUTTON_UP)) g_tools_sel = (g_tools_sel + TOOLS_N - 1) % TOOLS_N;
    if (g_tools_sel == 10) {
        if (pressed(ORBIS_PAD_BUTTON_RIGHT)) g_probe_first = g_probe_first % gpu_probe_count() + 1;
        if (pressed(ORBIS_PAD_BUTTON_LEFT)) g_probe_first = (g_probe_first + gpu_probe_count() - 2) % gpu_probe_count() + 1;
    }
    if (!pressed(ORBIS_PAD_BUTTON_CROSS)) return;
    switch (g_tools_sel) {
    case 0: run_zip(); break;
    case 1: mark_clear(); logx("Selection cleared"); break;
    case 2: g_deflate = !g_deflate; settings_save(); break;
    case 3: g_opt_overwrite = !g_opt_overwrite; settings_save(); break;
    case 4:
        if (!audio_available()) { show_message("Music is unavailable (audio could not be opened - see log)."); break; }
        g_music = !g_music;
        audio_set_enabled(g_music);
        settings_save();
        logx("Music %s", g_music ? "on" : "off");
        break;
    case 5: g_cwd[0] = 0; start_pick(PICK_LOG); break;
    case 6: g_cwd[0] = 0; start_pick(PICK_EXTRACT_DEFAULT); break;
    case 7: open_so4(); break;
    case 8: g_port_edit = -1; g_ports_sel = 0; g_overlay = OV_PORTS; break;
    case 9: show_message("To run a script: open FILES, highlight a .txt script, press OPTIONS and choose "
                         "\"Run this batch script\". A sample is written to %s/sample_script.txt.", g_extract_dir);
            write_sample_script(); break;
    case 10: run_gpu_probe(); break;
    }
}

static void update_overlay(void)
{
    switch (g_overlay) {
    case OV_EXTRACT_MENU:
        if (repeat(ORBIS_PAD_BUTTON_DOWN)) g_menu_sel = (g_menu_sel + 1) % EXTRACT_OPTS;
        if (repeat(ORBIS_PAD_BUTTON_UP)) g_menu_sel = (g_menu_sel + EXTRACT_OPTS - 1) % EXTRACT_OPTS;
        if (pressed(ORBIS_PAD_BUTTON_CIRCLE)) g_overlay = OV_NONE;
        if (pressed(ORBIS_PAD_BUTTON_CROSS)) {
            if (g_menu_sel == 3) start_pick(PICK_EXTRACT_ONCE); /* browse from the current folder */
            else run_extract_to(g_dest_options[g_menu_sel]);
        }
        break;
    case OV_ACTIONS:
        if (repeat(ORBIS_PAD_BUTTON_DOWN)) g_actions_sel = (g_actions_sel + 1) % ACTIONS_N;
        if (repeat(ORBIS_PAD_BUTTON_UP)) g_actions_sel = (g_actions_sel + ACTIONS_N - 1) % ACTIONS_N;
        if (pressed(ORBIS_PAD_BUTTON_CIRCLE)) { g_overlay = OV_NONE; break; }
        if (pressed(ORBIS_PAD_BUTTON_CROSS)) {
            int s = g_actions_sel;
            g_overlay = OV_NONE;
            switch (s) {
            case ACT_ZIP: run_zip(); break;
            case ACT_COPY: run_fileop(PK_COPY); break;
            case ACT_MOVE: run_fileop(PK_MOVE); break;
            case ACT_DELETE: begin_delete(); break;
            case ACT_NEWDIR: begin_new_folder(); break;
            case ACT_CPK: open_cpk_from_highlight(); break;
            case ACT_UNPACK: unpack_highlighted(); break;
            case ACT_SCRIPT: run_highlighted_script(); break;
            case ACT_VERIFY: verify_highlighted(); break;
            case ACT_SELALL: files_select_all(); break;
            case ACT_CLEAR: mark_clear(); logx("Selection cleared"); break;
            case ACT_EXIT: g_overlay = OV_QUIT; break;
            case ACT_LOG:
                if (!g_cwd[0]) show_message("Open a folder first, then set it as the log folder.");
                else if (!dir_writable(g_cwd)) show_message("%s is read-only.", g_cwd);
                else set_log_folder(g_cwd);
                break;
            }
        }
        break;
    case OV_KEYBOARD: {
        char typed[512];
        int r = kbd_poll(typed, sizeof(typed));
        if (r == 0) break;               /* still typing: the system keyboard owns the controller */
        g_overlay = OV_NONE;
        g_swallow = 1;                   /* the confirm press must not also hit the file list */
        if (g_kbd_purpose == KB_NEWDIR) {
            if (r == 1) create_folder(typed, 0);
            else logx("New folder cancelled");
            break;
        }
        if (g_kbd_purpose == KB_PORT) {
            g_overlay = OV_PORTS;
            if (r == 1) {
                int v = atoi(typed);
                if (v < 1 || v > 65535) show_message("A port must be between 1 and 65535.");
                else {
                    int *pp = g_port_edit == 0 ? &g_port_loader : g_port_edit == 1 ? &g_port_debug : g_port_edit == 2 ? &g_port_ftp : &g_port_klog;
                    *pp = v; settings_save();
                    logx("Port %d set to %d", g_port_edit, v);
                }
            }
            break;
        }
        g_overlay = OV_CPK;              /* CPK prompts return to the CPK screen */
        if (r != 1) {
            logx("CPK: keyboard closed without a value (end status %d, open %u ms, 0x%08x)",
                 kbd_last_status(), kbd_last_open_ms(), (unsigned)kbd_last_error());
            if (kbd_cancelled_text()[0]) {
                snprintf(g_rescue_text, sizeof(g_rescue_text), "%s", kbd_cancelled_text());
                g_rescue_purpose = g_kbd_purpose;
                g_overlay = OV_KBD_RESCUE;
            } else if (kbd_last_status() == 1)
                show_message("The keyboard was closed with " GLYPH_CIRCLE ", so nothing was extracted. Type the value, then "
                             "press R2 (Done) to confirm. Tip: View file list on screen lets you pick a file and press X.");
            else
                show_message("The keyboard closed without a value, so nothing was extracted. Type the value, then press "
                             "R2 (Done). Tip: View file list on screen lets you pick a file and press X.");
            break;
        }
        cpk_apply_typed(g_kbd_purpose, typed);
        break;
    }
    case OV_QUIT:
        if (pressed(ORBIS_PAD_BUTTON_CIRCLE)) g_overlay = OV_NONE;
        else if (pressed(ORBIS_PAD_BUTTON_CROSS)) app_shutdown();
        break;
    case OV_CONFIRM:
        if (pressed(ORBIS_PAD_BUTTON_CIRCLE) || pressed(ORBIS_PAD_BUTTON_CROSS)) {
            g_overlay = OV_NONE;
            logx("Delete cancelled");
        } else if (pressed(ORBIS_PAD_BUTTON_SQUARE)) {
            run_fileop(PK_DELETE);
        }
        break;
    case OV_DONE:
        if (pressed(ORBIS_PAD_BUTTON_CROSS) || pressed(ORBIS_PAD_BUTTON_CIRCLE)) {
            g_overlay = OV_NONE;
            load_dir(g_count ? g_entries[g_sel].name : NULL); /* load_dir copies the name first */
            if (g_cpk_active && g_pick == PICK_NONE) g_overlay = g_return_view ? OV_CPK_VIEW : OV_CPK;
            g_return_view = 0;
        }
        break;
    case OV_MESSAGE:
        if (pressed(ORBIS_PAD_BUTTON_CROSS) || pressed(ORBIS_PAD_BUTTON_CIRCLE)) {
            g_overlay = OV_NONE;
            if (!g_count && !g_cwd[0]) load_dir(NULL);
            if (g_cpk_active && g_pick == PICK_NONE) g_overlay = g_return_view ? OV_CPK_VIEW : OV_CPK;
            if (g_return_image && g_img) g_overlay = OV_IMAGE;
            if (g_return_sound && g_snd_file) g_overlay = OV_SOUND;
            if (g_return_model && g_mdl) { g_overlay = OV_MODEL; g_mdl_dirty = 1; }
            g_return_model = 0;
            g_return_view = 0;
            g_return_image = 0;
            g_return_sound = 0;
        }
        break;
    case OV_IMAGE: update_image_view(); break;
    case OV_CPK: update_cpk(); break;
    case OV_CPK_VIEW: update_cpk_view(); break;
    case OV_PORTS: update_ports(); break;
    case OV_KBD_RESCUE: update_kbd_rescue(); break;
    case OV_NUMPAD: update_numpad(); break;
    case OV_NAMES: update_names(); break;
    case OV_MODEL: update_model_view(); break;
    case OV_SOUND: update_sound_view(); break;
    case OV_TEXT: update_text_view(); break;
    case OV_CPK_CONFIRM:
        if (pressed(ORBIS_PAD_BUTTON_CIRCLE)) g_overlay = OV_CPK;
        else if (pressed(ORBIS_PAD_BUTTON_CROSS)) cpk_run_all();
        break;
    }
}

/* Startup self-test: compare stat() size with the real size from lseek(), and
 * log free space, so a size/space problem on hardware shows up in the log. */
static void boot_selftest(void)
{
    uint64_t fs;
    char sz[32];
    if (free_space("/data", &fs) == 0) { fmt_size(fs, sz, sizeof(sz)); logx("boot: /data free space %s", sz); }
    else logx("boot: /data free space unavailable");
}

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    uint64_t t_boot = now_us();

    /* 1) read app assets while /app0 is still visible (see asset_dirs) */
    char bg_used[256] = "", mus_used[256] = "";
    uint64_t t_bg = now_us();
    int brc = load_bg_any(bg_used, sizeof(bg_used));
    uint64_t bg_ms = (now_us() - t_bg) / 1000;
    int mrc = load_music_any(mus_used, sizeof(mus_used));
    long long pre_stat = -1, pre_real = -1;
    {
        int fd = open("/app0/eboot.bin", O_RDONLY);
        if (fd >= 0) { pre_real = lseek(fd, 0, SEEK_END); close(fd); }
        struct stat st;
        if (stat("/app0/eboot.bin", &st) == 0) pre_stat = st.st_size;
    }

    /* 2) escape the sandbox for full file access */
    try_jailbreak();
    logger_set_clock(rtc_clock);

    if (g_jailbroken) {
        char lp[EX_PATH_MAX];
        mkdir(APP_DATA, 0777);
        settings_load(lp, sizeof(lp));
        if (logger_try_init(lp) != 0) {           /* saved folder gone (USB removed?) */
            logger_init(DEF_LOG);
            logx("Saved log location %s not writable - using %s", lp, DEF_LOG);
        }
        logx("%s v%s started (%s)", APP_TITLE, APP_VERSION, g_jb_msg);
        logx("boot: sandbox escape took %llu ms", (unsigned long long)g_jb_ms);
        if (pre_real >= 0)
            logx("boot: size check %s (stat=%lld, actual=%lld)", pre_stat == pre_real ? "OK" : "MISMATCH", pre_stat, pre_real);
        boot_selftest();
    }
    /* assets that couldn't be read before the jailbreak get a second try now */
    if (brc != 0) { t_bg = now_us(); brc = load_bg_any(bg_used, sizeof(bg_used)); bg_ms = (now_us() - t_bg) / 1000; }
    if (mrc != 0) mrc = load_music_any(mus_used, sizeof(mus_used));

    int grc = gfx_init();
    if (grc != 0) {
        logx("boot: FAILED video init (code %d)", grc);
        notify("Star Ocean Utility: video init failed (%d)", grc);
        for (;;) sceKernelUsleep(1000000);
    }
    logx("boot: video ok");
    /* first frame right away, before any loading, so a stall is never just black */
    gfx_begin_frame();
    gfx_draw_bg();
    gfx_text(FONT_LARGE, 60, 60, C_TEXT, APP_TITLE);
    gfx_text(FONT_SMALL, 60, 130, C_DIM, "Starting...");
    gfx_end_frame();
    {
        unsigned fe, ft;
        int le;
        gfx_flip_stats(&fe, &ft, &le);
        if (fe || ft) logx("boot: first frame had trouble (errors=%u timeouts=%u last=0x%08x)", fe, ft, (unsigned)le);
        else logx("boot: first frame shown");
    }
    if (brc != 0) logx("boot: background NOT found (code %d) in any asset folder - using gradient", brc);
    else logx("boot: background loaded from %s (%llu ms)", bg_used, (unsigned long long)bg_ms);
    if (pad_init() != 0) logx("boot: controller init FAILED");
    else logx("boot: controller ok");

    int arc = mrc;
    if (mrc != 0) logx("boot: music file NOT found (code %d) in any asset folder", mrc);
    else if ((arc = audio_open()) != 0) {
        int ir, o1, o2;
        audio_diag(&ir, &o1, &o2);
        logx("boot: music unavailable - audio port failed (code %d; init=0x%08x open=0x%08x retry=0x%08x)",
             arc, (unsigned)ir, (unsigned)o1, (unsigned)o2);
    } else {
        audio_set_enabled(g_music);
        logx("boot: music ready from %s (%s)", mus_used, g_music ? "on" : "off");
    }

    if (!g_jailbroken)
        show_message("Could not access storage. Load GoldHEN first, then restart this app.");
    g_cwd[0] = 0;
    load_dir(NULL);
    atexit(sd_atexit);
    logx("boot: ready in %llu ms", (unsigned long long)((now_us() - t_boot) / 1000));

    uint64_t last_draw = 0, last_health = now_us();
    int last_overlay = -1, last_tab = -1;
    unsigned logged_fe = 0, logged_ft = 0;
    int logged_audio_fail = 0;
    for (;;) {
        pad_poll();
        if (now_us() - last_health > 5000000) { /* every 5 s: report new display/audio trouble */
            last_health = now_us();
            unsigned fe, ft;
            int le;
            gfx_flip_stats(&fe, &ft, &le);
            if (fe != logged_fe || ft != logged_ft) {
                logx("display: flip errors=%u timeouts=%u (last 0x%08x)", fe, ft, (unsigned)le);
                logged_fe = fe;
                logged_ft = ft;
            }
            if (audio_failed() && !logged_audio_fail) {
                logx("music stopped: audio output kept failing");
                logged_audio_fail = 1;
            }
        }
        if (g_overlay != OV_NONE) {
            update_overlay();
        } else {
            if (g_pick == PICK_NONE) { /* no tab hopping while choosing a folder */
                if (pressed(ORBIS_PAD_BUTTON_R1)) g_tab = (g_tab + 1) % TAB_COUNT;
                if (pressed(ORBIS_PAD_BUTTON_L1)) g_tab = (g_tab + TAB_COUNT - 1) % TAB_COUNT;
            }
            if (g_tab != TAB_FILES && pressed(ORBIS_PAD_BUTTON_OPTIONS)) g_overlay = OV_QUIT;   /* FILES: OPTIONS menu has "Close application" */
            else if (g_tab == TAB_FILES) update_files();
            else if (g_tab == TAB_TOOLS) update_tools();
        }

        /* Redraw only when something can have changed: input, a held button
         * (auto-repeat), a screen switch, or at least 4x a second. Repainting an
         * unchanged 1080p screen every frame just wastes the CPU. */
        uint64_t tnow = now_us();
        if (g_buttons == g_prev && !g_buttons && g_overlay == last_overlay && g_tab == last_tab &&
            tnow - last_draw < (g_anim ? 0u : g_live_pending ? 30000u : 250000u)) {
            sceKernelUsleep(8000);
            continue;
        }
        last_draw = tnow;
        last_overlay = g_overlay;
        last_tab = g_tab;
        g_live_pending = 0;

        gfx_begin_frame();
        if (g_overlay == OV_MODEL && g_mdl) {
            if (!draw_model_view()) gfx_end_frame();
            continue;
        }
        if (g_overlay == OV_IMAGE || (g_overlay == OV_MESSAGE && g_return_image && g_img)) {
            draw_image_view();
            if (g_overlay == OV_MESSAGE) draw_message();
            gfx_end_frame();
            continue;
        }
        gfx_draw_bg();
        draw_header();
        if (g_tab == TAB_FILES) draw_files();
        else if (g_tab == TAB_TOOLS) draw_tools();
        else draw_credits();
        switch (g_overlay) {
        case OV_EXTRACT_MENU: draw_extract_menu(); break;
        case OV_ACTIONS: draw_actions_menu(); break;
        case OV_PROGRESS: draw_progress(); break;
        case OV_DONE: draw_done(); break;
        case OV_MESSAGE: draw_message(); break;
        case OV_CONFIRM: draw_confirm(); break;
        case OV_QUIT: draw_quit(); break;
        case OV_KEYBOARD: draw_keyboard_wait(); break;
        case OV_CPK: draw_cpk(); break;
        case OV_CPK_VIEW: draw_cpk_view(); break;
        case OV_PORTS: draw_ports(); break;
        case OV_KBD_RESCUE: draw_kbd_rescue(); break;
        case OV_NUMPAD: draw_numpad(); break;
        case OV_NAMES: draw_names(); break;
        case OV_SOUND: draw_sound_view(); break;
        case OV_TEXT: draw_text_view(); break;
        case OV_CPK_CONFIRM: draw_cpk(); draw_cpk_confirm(); break;
        }
        gfx_end_frame();
    }
    return 0;
}
