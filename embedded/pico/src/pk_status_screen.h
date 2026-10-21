// The FrameOS status screen without a framebuffer.
//
// The ESP32 draws its setup screen into a full packed buffer
// (embedded/esp32/main/fos_status_screen.c). An RP2040 has no room for one
// (192 KB of its 264 KB for an 800x480 colour panel), so here the screen is a
// short list of text items and each packed row is produced on demand, which
// is exactly the order the panel wants its data in. Same layout, same 5x7
// font (fos_font5x7.h) and the same mark (fos_logo_bitmap.h).
//
// Portable, host-tested (tests/test_pk_status_screen.c).
#ifndef PK_STATUS_SCREEN_H
#define PK_STATUS_SCREEN_H

#include <stddef.h>
#include <stdint.h>

#define PK_STATUS_MAX_ITEMS 8
#define PK_STATUS_TEXT_MAX 72

typedef struct {
    char text[PK_STATUS_TEXT_MAX];
    int x;
    int y;
    int scale;
} pk_status_item_t;

typedef struct {
    int width;
    int height;
    int format; // PK_PIXEL_*
    int mark_x;
    int mark_y;
    int mark_scale; // 0 = no mark
    int item_count;
    pk_status_item_t items[PK_STATUS_MAX_ITEMS];
} pk_status_screen_t;

// "Join this network…" with the hotspot's name, passphrase and address.
void pk_status_screen_portal(pk_status_screen_t *screen, int width, int height, int format,
                             const char *ssid, const char *psk, const char *ip);

// The header plus up to four free-form lines (NULL/empty lines are skipped):
// "Connected — waiting for the first render", "Cannot reach the backend", …
void pk_status_screen_message(pk_status_screen_t *screen, int width, int height, int format,
                              const char *status, const char *const lines[], int line_count);

// Fills one packed row (pk_fosb_row_bytes(format, width) bytes).
void pk_status_screen_row(const pk_status_screen_t *screen, int y, uint8_t *row);

#endif // PK_STATUS_SCREEN_H
