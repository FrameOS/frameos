#include "pk_fosb.h"

#include <string.h>

size_t pk_fosb_row_bytes(int format, int width)
{
    if (width <= 0) return 0;
    switch (format) {
        case PK_PIXEL_1BPP:
            return ((size_t)width + 7u) / 8u;
        case PK_PIXEL_2BPP_GRAY:
            return ((size_t)width + 3u) / 4u;
        case PK_PIXEL_4BPP_7COLOR:
        case PK_PIXEL_4BPP_SPECTRA6:
            return ((size_t)width + 1u) / 2u;
        default:
            return 0;
    }
}

size_t pk_fosb_payload_size(int format, int width, int height)
{
    if (height <= 0) return 0;
    return pk_fosb_row_bytes(format, width) * (size_t)height;
}

uint8_t pk_fosb_white_fill(int format)
{
    switch (format) {
        case PK_PIXEL_4BPP_7COLOR:
        case PK_PIXEL_4BPP_SPECTRA6:
            return 0x11;
        default:
            return 0xFF;
    }
}

void pk_fosb_row_set_black(uint8_t *row, int format, int x)
{
    if (row == NULL || x < 0) return;
    switch (format) {
        case PK_PIXEL_1BPP:
            row[x / 8] &= (uint8_t)~(0x80u >> (x & 7));
            break;
        case PK_PIXEL_2BPP_GRAY:
            row[x / 4] &= (uint8_t)~(0x03u << (6 - (x & 3) * 2));
            break;
        case PK_PIXEL_4BPP_7COLOR:
        case PK_PIXEL_4BPP_SPECTRA6:
            row[x / 2] &= (x & 1) == 0 ? 0x0Fu : 0xF0u;
            break;
        default:
            break;
    }
}

pk_fosb_result_t pk_fosb_parse_header(const uint8_t header[PK_FOSB_HEADER_LEN],
                                      pk_fosb_header_t *out)
{
    if (memcmp(header, "FOSB", 4) != 0) return PK_FOSB_BAD_MAGIC;
    if (header[4] != 1) return PK_FOSB_BAD_VERSION;
    out->format = header[5];
    out->width = header[6] | (header[7] << 8);
    out->height = header[8] | (header[9] << 8);
    if (pk_fosb_payload_size(out->format, out->width, out->height) == 0) {
        return PK_FOSB_BAD_FORMAT;
    }
    return PK_FOSB_OK;
}
