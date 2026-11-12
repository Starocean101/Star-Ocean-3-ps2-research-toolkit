#ifndef BC7_H
#define BC7_H
#include <stdint.h>
/* Decode one 16-byte BC7 block into 16 RGBA pixels (row-major 4x4). */
void bc7_block(const uint8_t *src, uint8_t out[16][4]);
#endif
