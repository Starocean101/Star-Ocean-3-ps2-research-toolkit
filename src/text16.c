/* text16.c - UTF-16LE string finder used for the game's EXD text tables. */
#include "text16.h"
#include <stdio.h>

static size_t put_u8(uint32_t c, char *o)
{
    if (c < 0x80) { o[0] = (char)c; return 1; }
    if (c < 0x800) { o[0] = (char)(0xC0 | c >> 6); o[1] = (char)(0x80 | (c & 63)); return 2; }
    o[0] = (char)(0xE0 | c >> 12); o[1] = (char)(0x80 | ((c >> 6) & 63)); o[2] = (char)(0x80 | (c & 63)); return 3;
}

static int is_text(uint32_t c) { return (c >= 0x20 && c < 0x7F) || c == 0x0A || (c >= 0xA0 && c < 0xD800) || (c >= 0xE000 && c < 0xFFFE); }

int u16_strings(const uint8_t *d, size_t n, void (*fn)(size_t off, const char *utf8, void *u), void *u)
{
    int found = 0;
    char buf[1600];
    for (size_t i = 0; i + 4 <= n;) {
        size_t k = i;
        int ascii = 0, letters = 0, kana = 0, jp = 0, len = 0;
        while (k + 2 <= n) {
            uint32_t c = (uint32_t)d[k] | (uint32_t)d[k + 1] << 8;
            if (!is_text(c)) break;
            ascii += c < 0x80;
            letters += (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
            kana += c >= 0x3040 && c <= 0x30FF;
            jp += (c >= 0x3000 && c <= 0x30FF) || (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0xFF00 && c <= 0xFFEF);
            len++; k += 2;
        }
        int term = k + 2 <= n && !d[k] && !d[k + 1];
        /* real text: mostly ASCII with some letters, or Japanese with kana; tables of small
         * 16-bit numbers that happen to fall in printable ranges (IPA, Cyrillic ...) are not */
        int english = len >= 3 && ascii * 10 >= len * 6 && letters >= 2;
        int japanese = len >= 2 && kana >= 1 && (ascii + jp) * 10 >= len * 7;
        if (term && (english || japanese)) {
            size_t o = 0;
            for (size_t q = i; q < k && o < sizeof(buf) - 8; q += 2) {
                uint32_t c = (uint32_t)d[q] | (uint32_t)d[q + 1] << 8;
                if (c == 0x0A) { buf[o++] = ' '; buf[o++] = '|'; buf[o++] = ' '; continue; }
                o += put_u8(c, buf + o);
            }
            buf[o] = 0;
            if (fn) fn(i, buf, u);
            found++;
            i = k + 2;
        } else i = k > i ? k : i + 2;
    }
    return found;
}
