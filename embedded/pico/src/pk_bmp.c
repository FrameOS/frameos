#include "pk_bmp.h"

#include <string.h>

#include "pk_fosb.h"

// RGB triples, the preview palettes of the ESP32 server (fos_http.c
// PREVIEW_PALETTE_*): what the inks actually look like, not pure primaries.
static const uint8_t PALETTE_BW[] = {0, 0, 0, 255, 255, 255};
static const uint8_t PALETTE_GRAY4[] = {0, 0, 0, 85, 85, 85, 170, 170, 170, 255, 255, 255};
static const uint8_t PALETTE_7COLOR[] = {
    57, 48, 57, 255, 255, 255, 58, 91, 70, 61, 59, 94, 156, 72, 75, 208, 190, 71, 177, 106, 73,
};
static const uint8_t PALETTE_SPECTRA6[] = {
    25, 20, 38, 178, 193, 192, 199, 187, 0, 107, 17, 25, 255, 255, 255, 24, 83, 154, 42, 85, 49,
};

static const uint8_t *palette_for(int format, size_t *colors, int *bits)
{
    switch (format) {
        case PK_PIXEL_1BPP:
            *colors = 2;
            *bits = 1;
            return PALETTE_BW;
        case PK_PIXEL_2BPP_GRAY:
            // BMP has no 2-bit depth; each pixel widens to a nibble.
            *colors = 4;
            *bits = 4;
            return PALETTE_GRAY4;
        case PK_PIXEL_4BPP_7COLOR:
            *colors = 7;
            *bits = 4;
            return PALETTE_7COLOR;
        case PK_PIXEL_4BPP_SPECTRA6:
            *colors = 7;
            *bits = 4;
            return PALETTE_SPECTRA6;
        default:
            return NULL;
    }
}

static void put_u32(uint8_t *dst, uint32_t value)
{
    dst[0] = (uint8_t)value;
    dst[1] = (uint8_t)(value >> 8);
    dst[2] = (uint8_t)(value >> 16);
    dst[3] = (uint8_t)(value >> 24);
}

size_t pk_bmp_row_bytes(int format, int width)
{
    size_t colors;
    int bits;
    if (palette_for(format, &colors, &bits) == NULL || width <= 0) return 0;
    return ((((size_t)width * (size_t)bits) + 31u) / 32u) * 4u;
}

size_t pk_bmp_header(int format, int width, int height, uint8_t dst[PK_BMP_HEADER_MAX])
{
    size_t colors;
    int bits;
    const uint8_t *palette = palette_for(format, &colors, &bits);
    if (palette == NULL || width <= 0 || height <= 0) return 0;
    size_t table = (bits == 1 ? 2u : 16u) * 4u;
    size_t offset = 54u + table;
    size_t pixels = pk_bmp_row_bytes(format, width) * (size_t)height;

    memset(dst, 0, PK_BMP_HEADER_MAX);
    dst[0] = 'B';
    dst[1] = 'M';
    put_u32(dst + 2, (uint32_t)(offset + pixels));
    put_u32(dst + 10, (uint32_t)offset);
    put_u32(dst + 14, 40); // BITMAPINFOHEADER
    put_u32(dst + 18, (uint32_t)width);
    put_u32(dst + 22, (uint32_t)(-(int32_t)height)); // top-down
    dst[26] = 1;                                     // planes
    dst[28] = (uint8_t)bits;
    put_u32(dst + 34, (uint32_t)pixels);
    put_u32(dst + 38, 2835); // 72 dpi
    put_u32(dst + 42, 2835);
    put_u32(dst + 46, (uint32_t)(table / 4u));
    for (size_t i = 0; i < colors; i++) {
        uint8_t *entry = dst + 54 + i * 4;
        entry[0] = palette[i * 3 + 2]; // BGRA
        entry[1] = palette[i * 3 + 1];
        entry[2] = palette[i * 3];
    }
    return offset;
}

void pk_bmp_row(int format, int width, const uint8_t *packed, uint8_t *dst)
{
    size_t row = pk_bmp_row_bytes(format, width);
    memset(dst, 0, row);
    if (format == PK_PIXEL_2BPP_GRAY) {
        for (int x = 0; x < width; x++) {
            uint8_t value = (uint8_t)((packed[x / 4] >> (6 - (x & 3) * 2)) & 0x03u);
            dst[x / 2] |= (uint8_t)(value << ((x & 1) == 0 ? 4 : 0));
        }
        return;
    }
    memcpy(dst, packed, pk_fosb_row_bytes(format, width));
}

size_t pk_bmp_total_bytes(int format, int width, int height)
{
    size_t colors;
    int bits;
    if (palette_for(format, &colors, &bits) == NULL || height <= 0) return 0;
    return 54u + (bits == 1 ? 2u : 16u) * 4u + pk_bmp_row_bytes(format, width) * (size_t)height;
}
