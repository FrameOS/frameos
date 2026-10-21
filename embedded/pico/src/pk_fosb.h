// The FOSB panel payload a thin client pulls from its control plane, and the
// packed pixel formats it carries. Portable: no pico-sdk includes, host-tested
// (tests/test_pk_fosb.c).
//
// Wire format (producer: backend/app/api/embedded_device.py `fosb_payload`,
// ESP32 consumer: embedded/esp32/main/fos_client.c):
//   magic "FOSB" | version u8 (=1) | format u8 | width u16le | height u16le |
//   reserved u16le | packed payload, rows top to bottom
#ifndef PK_FOSB_H
#define PK_FOSB_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PK_FOSB_HEADER_LEN 12

// Keep in sync with fos_pixel_format_t
// (embedded/esp32/components/frameos_display/include/frameos_display.h).
#define PK_PIXEL_1BPP 1
#define PK_PIXEL_2BPP_GRAY 4
#define PK_PIXEL_4BPP_7COLOR 6
#define PK_PIXEL_4BPP_SPECTRA6 7

typedef struct {
    int format;
    int width;
    int height;
} pk_fosb_header_t;

typedef enum {
    PK_FOSB_OK = 0,
    PK_FOSB_BAD_MAGIC,
    PK_FOSB_BAD_VERSION,
    PK_FOSB_BAD_FORMAT,
} pk_fosb_result_t;

// Bytes in one packed row / in the whole payload; 0 for an unknown format.
size_t pk_fosb_row_bytes(int format, int width);
size_t pk_fosb_payload_size(int format, int width, int height);

// The byte that paints a row white in `format` (palette index 1 on the colour
// panels, all-ones on the monochrome and grey ones).
uint8_t pk_fosb_white_fill(int format);

// Paint pixel x of a packed row black (palette index 0 in every format).
void pk_fosb_row_set_black(uint8_t *row, int format, int x);

pk_fosb_result_t pk_fosb_parse_header(const uint8_t header[PK_FOSB_HEADER_LEN],
                                      pk_fosb_header_t *out);

#endif // PK_FOSB_H
