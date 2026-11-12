/* kbd.c - PS4 system on-screen keyboard (sceImeDialog), UTF-8 in/out.
 * Set up the same way as Apollo Save Tool: load the IME + common-dialog modules
 * once, then open the dialog with UTF-16 buffers and poll its status. */
#include "kbd.h"

#include <stdint.h>
#include <string.h>

#include <orbis/CommonDialog.h>
#include <orbis/ImeDialog.h>
#include <orbis/Sysmodule.h>
#include <orbis/UserService.h>
#include <orbis/libkernel.h>

#define KBD_MAX 255

static int s_ready = -1;   /* -1 not tried, 0 ok, >0 failed */
static int s_open;
static uint64_t s_open_time;
static int s_err;
static uint16_t s_text[KBD_MAX + 1];
static uint16_t s_title[128];
static uint16_t s_init[KBD_MAX + 1];
static int s_status = -1;
static unsigned s_open_ms;
static char s_cancel_text[KBD_MAX * 4 + 1];

int kbd_last_error(void) { return s_err; }
int kbd_last_status(void) { return s_status; }
unsigned kbd_last_open_ms(void) { return s_open_ms; }
const char *kbd_cancelled_text(void) { return s_cancel_text; }

int kbd_init(void)
{
    if (s_ready >= 0) return s_ready;
    int r1 = sceSysmoduleLoadModule(ORBIS_SYSMODULE_IME_DIALOG);
    int r2 = (int)sceSysmoduleLoadModuleInternal(ORBIS_SYSMODULE_INTERNAL_COMMON_DIALOG);
    int r3 = sceCommonDialogInitialize(); /* "already initialized" is fine */
    if (r1 < 0) s_err = r1;
    else if (r2 < 0) s_err = r2;
    s_ready = (r1 < 0 || r2 < 0) ? 1 : 0;
    (void)r3;
    return s_ready;
}

/* UTF-8 -> UTF-16 (with surrogates); returns units written (excl. NUL). */
static size_t to_utf16(const char *s, uint16_t *out, size_t cap)
{
    const unsigned char *p = (const unsigned char *)s;
    size_t o = 0;
    while (*p && o + 2 < cap) {
        uint32_t cp;
        if (p[0] < 0x80) cp = *p++;
        else if ((p[0] & 0xE0) == 0xC0 && (p[1] & 0xC0) == 0x80) { cp = ((p[0] & 0x1F) << 6) | (p[1] & 0x3F); p += 2; }
        else if ((p[0] & 0xF0) == 0xE0 && (p[1] & 0xC0) == 0x80 && (p[2] & 0xC0) == 0x80) {
            cp = ((p[0] & 0x0F) << 12) | ((p[1] & 0x3F) << 6) | (p[2] & 0x3F); p += 3; }
        else if ((p[0] & 0xF8) == 0xF0 && (p[1] & 0xC0) == 0x80 && (p[2] & 0xC0) == 0x80 && (p[3] & 0xC0) == 0x80) {
            cp = ((p[0] & 0x07) << 18) | ((p[1] & 0x3F) << 12) | ((p[2] & 0x3F) << 6) | (p[3] & 0x3F); p += 4; }
        else { cp = '?'; p++; }
        if (cp >= 0x10000) { cp -= 0x10000; out[o++] = 0xD800 | (cp >> 10); out[o++] = 0xDC00 | (cp & 0x3FF); }
        else out[o++] = (uint16_t)cp;
    }
    out[o] = 0;
    return o;
}

/* UTF-16 -> UTF-8; returns bytes written (excl. NUL). */
static size_t to_utf8(const uint16_t *in, char *out, size_t cap)
{
    size_t o = 0;
    for (size_t i = 0; in[i]; i++) {
        uint32_t cp = in[i];
        if (cp >= 0xD800 && cp <= 0xDBFF && in[i + 1] >= 0xDC00 && in[i + 1] <= 0xDFFF) {
            cp = 0x10000 + ((cp - 0xD800) << 10) + (in[i + 1] - 0xDC00);
            i++;
        }
        char b[4];
        int n;
        if (cp < 0x80) { b[0] = (char)cp; n = 1; }
        else if (cp < 0x800) { b[0] = (char)(0xC0 | (cp >> 6)); b[1] = (char)(0x80 | (cp & 0x3F)); n = 2; }
        else if (cp < 0x10000) { b[0] = (char)(0xE0 | (cp >> 12)); b[1] = (char)(0x80 | ((cp >> 6) & 0x3F)); b[2] = (char)(0x80 | (cp & 0x3F)); n = 3; }
        else { b[0] = (char)(0xF0 | (cp >> 18)); b[1] = (char)(0x80 | ((cp >> 12) & 0x3F)); b[2] = (char)(0x80 | ((cp >> 6) & 0x3F)); b[3] = (char)(0x80 | (cp & 0x3F)); n = 4; }
        if (o + n >= cap) break;
        memcpy(out + o, b, n);
        o += n;
    }
    out[o] = 0;
    return o;
}

int kbd_open(const char *title, const char *initial, int max_chars)
{
    if (s_open) return 0;
    if (kbd_init() != 0) return -1;
    if (max_chars <= 0 || max_chars > KBD_MAX) max_chars = KBD_MAX;

    memset(s_text, 0, sizeof(s_text));
    memset(s_title, 0, sizeof(s_title));
    to_utf16(initial ? initial : "", s_text, sizeof(s_text) / 2);
    memcpy(s_init, s_text, sizeof(s_init));
    s_status = -1; s_open_ms = 0; s_err = 0; s_cancel_text[0] = 0;
    to_utf16(title ? title : "", s_title, sizeof(s_title) / 2);

    int user = -1;
    sceUserServiceGetInitialUser(&user);

    OrbisImeDialogSetting p;
    memset(&p, 0, sizeof(p));
    p.userId = (uint32_t)user;
    p.type = ORBIS_TYPE_DEFAULT;
    p.supportedLanguages = 0;
    p.enterLabel = ORBIS_BUTTON_LABEL_DEFAULT;
    p.maxTextLength = (uint32_t)max_chars;
    p.inputTextBuffer = (wchar_t *)s_text;   /* the PS4 uses UTF-16 here */
    p.title = (const wchar_t *)s_title;
    p.posx = 1920 / 2;
    p.posy = 1080 / 2;
    p.horizontalAlignment = ORBIS_H_CENTER;
    p.verticalAlignment = ORBIS_V_CENTER;

    int rc = sceImeDialogInit(&p, NULL);
    if (rc < 0) { s_err = rc; return -1; }
    s_open = 1;
    s_open_time = sceKernelGetProcessTime();
    return 0;
}

int kbd_poll(char *out, size_t n)
{
    if (!s_open) return -1;
    OrbisDialogStatus st = sceImeDialogGetStatus();
    if (st == ORBIS_DIALOG_STATUS_RUNNING) return 0;
    if (st != ORBIS_DIALOG_STATUS_STOPPED) {
        /* never got to RUNNING within 5 s: give up instead of waiting forever */
        if (sceKernelGetProcessTime() - s_open_time > 5000000) {
            sceImeDialogTerm();
            s_open = 0;
            s_err = (int)st;
            return -1;
        }
        return 0;
    }

    OrbisDialogResult res;
    memset(&res, 0, sizeof(res));
    int grc = sceImeDialogGetResult(&res);
    sceImeDialogTerm();
    s_open = 0;
    s_open_ms = (unsigned)((sceKernelGetProcessTime() - s_open_time) / 1000);
    s_status = (int)res.endstatus;
    if (grc < 0) s_err = grc;
    if (res.endstatus != ORBIS_DIALOG_OK) {
        s_text[KBD_MAX] = 0;
        if (s_text[0] && memcmp(s_text, s_init, sizeof(s_text)) != 0)
            to_utf8(s_text, s_cancel_text, sizeof(s_cancel_text));
        return -1;
    }
    to_utf8(s_text, out, n);
    return 1;
}
