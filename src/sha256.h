/* sha256.h - streaming SHA-256. */
#ifndef SHA256_H
#define SHA256_H
#include <stdint.h>
#include <stddef.h>
typedef struct { uint32_t h[8]; uint64_t len; uint8_t buf[64]; size_t n; } Sha256;
void sha256_init(Sha256 *c);
void sha256_update(Sha256 *c, const void *data, size_t len);
void sha256_final(Sha256 *c, uint8_t out[32]);
void sha256_hex(const uint8_t h[32], char out[65]);
#endif
