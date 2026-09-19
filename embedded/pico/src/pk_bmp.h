// What the panel shows, as a BMP — `GET /image` on the device's own server.
// A packed panel row already is a palettized bitmap row (MSB-first, same
// nibble order), so the conversion is a header, a palette and the rows as
// they are; nothing the size of the image is ever allocated. Top-down
// (negative height), so rows stream in the order they are stored.
// Portable, host-tested (tests/test_pk_bmp.c).
#ifndef PK_BMP_H
#define PK_BMP_H

#include <stddef.h>
#include <stdint.h>

#define PK_BMP_HEADER_MAX (54u + 16u * 4u)

// Header + palette for a panel of `format`; returns its length (0 for a
// format with no BMP mapping).
size_t pk_bmp_header(int format, int width, int height, uint8_t dst[PK_BMP_HEADER_MAX]);
// Bytes in one BMP row (4-byte aligned).
size_t pk_bmp_row_bytes(int format, int width);
// One packed panel row → one BMP row.
void pk_bmp_row(int format, int width, const uint8_t *packed, uint8_t *dst);
size_t pk_bmp_total_bytes(int format, int width, int height);

#endif // PK_BMP_H
