/* kbd.h - PS4 system on-screen keyboard (sceImeDialog), UTF-8 in/out. */
#pragma once
#include <stddef.h>

int  kbd_init(void);                       /* load the dialog modules once; 0 = available */
int  kbd_open(const char *title, const char *initial, int max_chars); /* 0 = keyboard is up */
/* Call every frame while open: 0 = still open, 1 = confirmed (text in out), -1 = cancelled/failed */
int  kbd_poll(char *out, size_t n);
int  kbd_last_error(void);
/* After kbd_poll() returned -1: the dialog's end status (0 ok, 1 cancel, 2 abort, -1 none)
 * and how long it was open in ms. */
int  kbd_last_status(void);
unsigned kbd_last_open_ms(void);
/* After a cancel: what was in the text box, if it differs from the initial text and
 * is not empty (so a typed value closed with Circle is not lost); "" otherwise. */
const char *kbd_cancelled_text(void);
