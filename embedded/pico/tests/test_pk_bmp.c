// GET /image: the BMP header and row mapping for each packed format.
#include "pk_bmp.h"
#include "pk_fosb.h"
#include "pk_test.h"

static uint32_t u32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

int main(void)
{
    uint8_t header[PK_BMP_HEADER_MAX];

    // 800x480 Spectra 6: 4bpp, 16-entry palette, rows already 4-byte aligned.
    size_t len = pk_bmp_header(PK_PIXEL_4BPP_SPECTRA6, 800, 480, header);
    CHECK(len == 54 + 64);
    CHECK(header[0] == 'B' && header[1] == 'M');
    CHECK(u32(header + 2) == 118 + 400 * 480);
    CHECK(u32(header + 2) == pk_bmp_total_bytes(PK_PIXEL_4BPP_SPECTRA6, 800, 480));
    CHECK(u32(header + 10) == 118);             // pixel data offset
    CHECK(u32(header + 14) == 40);              // BITMAPINFOHEADER
    CHECK(u32(header + 18) == 800);
    CHECK((int32_t)u32(header + 22) == -480);   // top-down: rows stream in panel order
    CHECK(header[26] == 1 && header[28] == 4);  // planes, bits per pixel
    CHECK(u32(header + 30) == 0);               // BI_RGB
    CHECK(u32(header + 46) == 16);
    // Palette index 1 is white, index 0 the panel's near-black (BGRA order).
    CHECK(header[54 + 4] == 192 && header[54 + 5] == 193 && header[54 + 6] == 178);
    CHECK(header[54] == 38 && header[54 + 1] == 20 && header[54 + 2] == 25);
    CHECK(pk_bmp_row_bytes(PK_PIXEL_4BPP_SPECTRA6, 800) == 400);

    // 4bpp rows pass through untouched.
    uint8_t packed[400], out[400];
    for (int i = 0; i < 400; i++) packed[i] = (uint8_t)(i * 7);
    pk_bmp_row(PK_PIXEL_4BPP_SPECTRA6, 800, packed, out);
    CHECK(memcmp(packed, out, 400) == 0);

    // 600px at 4bpp is 300 bytes: already a multiple of 4. 1bpp 600px = 75 → 76.
    CHECK(pk_bmp_row_bytes(PK_PIXEL_4BPP_7COLOR, 600) == 300);
    CHECK(pk_bmp_row_bytes(PK_PIXEL_1BPP, 600) == 76);
    len = pk_bmp_header(PK_PIXEL_1BPP, 600, 448, header);
    CHECK(len == 54 + 8 && header[28] == 1 && u32(header + 46) == 2);
    uint8_t mono[75], mono_out[76];
    memset(mono, 0xF0, sizeof(mono));
    memset(mono_out, 0xEE, sizeof(mono_out));
    pk_bmp_row(PK_PIXEL_1BPP, 600, mono, mono_out);
    CHECK(mono_out[0] == 0xF0 && mono_out[74] == 0xF0 && mono_out[75] == 0x00); // padding zeroed

    // 2bpp grey has no BMP depth: each pixel widens to a nibble.
    uint8_t grey[2] = {0x1B, 0xC0}; // pixels 0,1,2,3 | 3,0,0,0
    uint8_t grey_out[4];
    CHECK(pk_bmp_row_bytes(PK_PIXEL_2BPP_GRAY, 5) == 4);
    pk_bmp_row(PK_PIXEL_2BPP_GRAY, 5, grey, grey_out);
    CHECK(grey_out[0] == 0x01 && grey_out[1] == 0x23 && grey_out[2] == 0x30 && grey_out[3] == 0x00);
    len = pk_bmp_header(PK_PIXEL_2BPP_GRAY, 5, 1, header);
    CHECK(len == 118 && header[28] == 4);
    CHECK(header[54 + 3 * 4] == 255); // level 3 = white

    // Formats with no mapping, and nonsense sizes, produce nothing.
    CHECK(pk_bmp_header(99, 800, 480, header) == 0);
    CHECK(pk_bmp_header(PK_PIXEL_1BPP, 0, 480, header) == 0);
    CHECK(pk_bmp_total_bytes(99, 800, 480) == 0);
    CHECK(pk_bmp_row_bytes(99, 800) == 0);

    return pk_test_result("test_pk_bmp");
}
