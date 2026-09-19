// "Is this the frame the panel already shows?" — a 128-bit change detector,
// two FNV-1a 64 streams with different offset bases. Not cryptographic and
// not meant to be: the only adversary is a dithered photo that differs from
// the last one. Streaming, so the RP2040 path can hash a payload it never
// holds. Portable, header-only, host-tested (tests/test_pk_fosb.c).
#ifndef PK_HASH_H
#define PK_HASH_H

#include <stddef.h>
#include <stdint.h>

#define PK_HASH_LEN 16

typedef struct {
    uint64_t a;
    uint64_t b;
} pk_hash_t;

static inline void pk_hash_init(pk_hash_t *hash)
{
    hash->a = 0xCBF29CE484222325ull;
    hash->b = 0x84222325CBF29CE4ull;
}

static inline void pk_hash_update(pk_hash_t *hash, const uint8_t *data, size_t len)
{
    uint64_t a = hash->a;
    uint64_t b = hash->b;
    for (size_t i = 0; i < len; i++) {
        a = (a ^ data[i]) * 0x100000001B3ull;
        b = (b ^ (uint8_t)(data[i] + 0x5Au)) * 0x100000001B3ull;
    }
    hash->a = a;
    hash->b = b;
}

static inline void pk_hash_final(const pk_hash_t *hash, uint8_t out[PK_HASH_LEN])
{
    for (int i = 0; i < 8; i++) {
        out[i] = (uint8_t)(hash->a >> (8 * i));
        out[8 + i] = (uint8_t)(hash->b >> (8 * i));
    }
}

#endif // PK_HASH_H
