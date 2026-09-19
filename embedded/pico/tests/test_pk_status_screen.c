// The scanline status screen: renders the setup screen for the 7.3" Spectra
// panel row by row and checks what a full-buffer renderer would have drawn.
// `make` also leaves build/portal_800x480.pbm to look at.
#include <stdlib.h>

#include "pk_fosb.h"
#include "pk_status_screen.h"
#include "pk_test.h"

static bool is_black(const uint8_t *row, int format, int x)
{
    switch (format) {
        case PK_PIXEL_1BPP: return (row[x / 8] & (0x80u >> (x & 7))) == 0;
        case PK_PIXEL_2BPP_GRAY: return ((row[x / 4] >> (6 - (x & 3) * 2)) & 3u) == 0;
        default: return ((x & 1) == 0 ? row[x / 2] >> 4 : row[x / 2] & 0x0Fu) == 0;
    }
}

// Renders the whole screen; returns black pixel count, fills bounds.
static long render(const pk_status_screen_t *screen, int *min_x, int *max_x, int *min_y, int *max_y,
                   FILE *pbm)
{
    size_t row_bytes = pk_fosb_row_bytes(screen->format, screen->width);
    uint8_t *row = malloc(row_bytes + 8);
    memset(row + row_bytes, 0xA5, 8); // canary: a row write must stay inside the row
    long black = 0;
    *min_x = *min_y = 1 << 30;
    *max_x = *max_y = -1;
    if (pbm) fprintf(pbm, "P1\n%d %d\n", screen->width, screen->height);
    for (int y = 0; y < screen->height; y++) {
        pk_status_screen_row(screen, y, row);
        for (int x = 0; x < screen->width; x++) {
            bool on = is_black(row, screen->format, x);
            if (pbm) fputc(on ? '1' : '0', pbm);
            if (!on) continue;
            black++;
            if (x < *min_x) *min_x = x;
            if (x > *max_x) *max_x = x;
            if (y < *min_y) *min_y = y;
            if (y > *max_y) *max_y = y;
        }
        if (pbm) fputc('\n', pbm);
    }
    for (int i = 0; i < 8; i++) CHECK(row[row_bytes + i] == 0xA5);
    free(row);
    return black;
}

int main(void)
{
    pk_status_screen_t screen;
    int min_x, max_x, min_y, max_y;

    // The board this PR is for.
    pk_status_screen_portal(&screen, 800, 480, PK_PIXEL_4BPP_SPECTRA6, "FrameOS-A1B2", "kp7m3xw9qz",
                            "192.168.4.1");
    CHECK(screen.item_count == 6); // FrameOS, status, hint, ssid, password, url
    CHECK(screen.mark_scale == 2);
    FILE *pbm = fopen("build/portal_800x480.pbm", "w");
    long black = render(&screen, &min_x, &max_x, &min_y, &max_y, pbm);
    if (pbm) fclose(pbm);
    CHECK(black > 8000 && black < 80000); // text, not a blank or a solid panel
    CHECK(min_x >= 50 && min_y >= 50);    // inside the margin (800/16)
    CHECK(max_x < 750 && max_y < 430);    // everything fits on the glass
    bool found_psk = false;
    for (int i = 0; i < screen.item_count; i++) {
        if (strcmp(screen.items[i].text, "Password: kp7m3xw9qz") == 0) found_psk = true;
        // Every line fits the width it was given.
        CHECK(screen.items[i].x + ((int)strlen(screen.items[i].text) * 6 - 1) * screen.items[i].scale <= 750);
    }
    CHECK(found_psk);

    // Same text on every supported packing → same picture.
    static const int formats[] = {PK_PIXEL_1BPP, PK_PIXEL_2BPP_GRAY, PK_PIXEL_4BPP_7COLOR};
    for (size_t i = 0; i < sizeof(formats) / sizeof(formats[0]); i++) {
        pk_status_screen_t other;
        pk_status_screen_portal(&other, 800, 480, formats[i], "FrameOS-A1B2", "kp7m3xw9qz", "192.168.4.1");
        int a, b, c, d;
        CHECK(render(&other, &a, &b, &c, &d, NULL) == black);
    }

    // The smaller Inky Frames still fit their text (it scales down).
    pk_status_screen_portal(&screen, 600, 448, PK_PIXEL_4BPP_7COLOR, "FrameOS-A1B2", "kp7m3xw9qz",
                            "192.168.4.1");
    render(&screen, &min_x, &max_x, &min_y, &max_y, NULL);
    CHECK(max_x < 600 && max_y < 448);

    // Message screen: long lines shrink to fit, empty ones are skipped, and
    // an over-long one is clipped at the edge instead of wrapping around.
    const char *lines[] = {"http://a-very-long-backend-hostname.example.com:8989", NULL, "",
                           "cannot reach the backend"};
    pk_status_screen_message(&screen, 800, 480, PK_PIXEL_4BPP_SPECTRA6, "Cannot get a picture", lines, 4);
    CHECK(screen.item_count == 4); // title, status, two non-empty lines
    black = render(&screen, &min_x, &max_x, &min_y, &max_y, NULL);
    CHECK(black > 0 && max_x < 800);

    // An odd width must not write past the last (half-used) byte.
    pk_status_screen_message(&screen, 801, 31, PK_PIXEL_4BPP_7COLOR,
                             "a status line far too long for a panel this narrow, so it clips", lines, 1);
    render(&screen, &min_x, &max_x, &min_y, &max_y, NULL);
    CHECK(max_x <= 800);

    return pk_test_result("test_pk_status_screen");
}
