/*
 * Host tests for fos_qr.c and fos_portal_screen.c: the provisioning portal's
 * screen, two QR codes a phone joins the hotspot and opens the setup page by.
 *
 * The encoder replays the byte-mode vectors of frameos/src/frameos/utils/
 * tests/test_qr.nim (same FNV digest over the modules), which decoded back
 * to their text with zxing-cpp when they were pinned: same symbols as the
 * Nim encoder. The screen is drawn at every panel size and pixel format the
 * firmware drives, and read back: each code's modules where the layout put
 * them, a white background on e-paper, a black one on an LCD.
 *
 * FOS_PORTAL_DUMP=<dir> writes each 1-bit screen as a PGM to look at.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain -Imain/tests/host_shim \
 *      -Icomponents/frameos_display/include \
 *      main/fos_qr.c main/fos_panel_draw.c main/fos_portal_screen.c \
 *      main/tests/test_fos_portal_screen.c -o /tmp/test_fos_portal_screen \
 *      && /tmp/test_fos_portal_screen
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fos_portal_screen.h"
#include "fos_qr.h"

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond, ...)                                                       \
    do {                                                                       \
        g_checks++;                                                            \
        if (!(cond)) {                                                         \
            g_failures++;                                                      \
            printf("FAIL %s:%d: ", __func__, __LINE__);                        \
            printf(__VA_ARGS__);                                               \
            printf("\n");                                                      \
        }                                                                      \
    } while (0)

/* test_qr.nim's sample(): text from an LCG. */
static void sample(const char *alphabet, int n, int seed, char *out)
{
    const uint32_t len = (uint32_t)strlen(alphabet);
    uint32_t x = (uint32_t)seed * 2654435761u + 1u;
    for (int i = 0; i < n; i++) {
        x = x * 1664525u + 1013904223u;
        out[i] = alphabet[(x >> 16) % len];
    }
    out[n] = '\0';
}

static uint32_t module_digest(const fos_qr_t *qr)
{
    uint32_t result = 2166136261u;
    for (int y = 0; y < qr->size; y++) {
        for (int x = 0; x < qr->size; x++) {
            result = (result ^ (uint32_t)fos_qr_dark(qr, x, y)) * 16777619u;
        }
    }
    return result;
}

static const char BYTES[] = "abcdefghijklmnopqrstuvwxyz0123456789:/.?=&-_";

static void test_qr_vectors(void)
{
    static fos_qr_t qr;
    static char text[400];
    const struct {
        const char *text;
        int sample_n, sample_seed;
        int size;
        uint32_t digest;
    } vectors[] = {
        {"frameos", 0, 0, 21, 1092847045u},
        {"http://frame.local:8787/c?k=secret", 0, 0, 29, 2336303363u},
        {"WIFI:T:WPA;S:FrameOS-Setup;P:frame1234;;", 0, 0, 29, 3030313940u},
        {NULL, 154, 7, 45, 1472810855u},  /* version 7: version bits */
        {NULL, 271, 10, 57, 3994478101u}, /* version 10: 16-bit count */
    };
    for (size_t i = 0; i < sizeof(vectors) / sizeof(vectors[0]); i++) {
        if (vectors[i].text) {
            strcpy(text, vectors[i].text);
        } else {
            sample(BYTES, vectors[i].sample_n, vectors[i].sample_seed, text);
        }
        CHECK(fos_qr_encode(text, &qr), "vector %zu encodes", i);
        CHECK(qr.size == vectors[i].size, "vector %zu: size %d, want %d", i, qr.size, vectors[i].size);
        CHECK(module_digest(&qr) == vectors[i].digest, "vector %zu: digest %u, want %u", i,
              module_digest(&qr), vectors[i].digest);
    }

    /* The smallest version that fits; past version 10 is refused. */
    CHECK(fos_qr_encode("", &qr) && qr.size == 21, "empty text is version 1");
    sample(BYTES, 17, 1, text);
    CHECK(fos_qr_encode(text, &qr) && qr.size == 21, "17 bytes fit version 1");
    sample(BYTES, 18, 1, text);
    CHECK(fos_qr_encode(text, &qr) && qr.size == 25, "18 bytes take version 2");
    sample(BYTES, 272, 1, text);
    CHECK(!fos_qr_encode(text, &qr), "272 bytes are past version 10");
}

static void test_wifi_code(void)
{
    char out[200];
    CHECK(fos_portal_wifi_code("FrameOS-1A2B", "abcdefghjk", out, sizeof(out)), "fits");
    CHECK(strcmp(out, "WIFI:T:WPA;S:FrameOS-1A2B;P:abcdefghjk;;") == 0, "plain: %s", out);
    CHECK(fos_portal_wifi_code("a;b,c", "p:q\"r\\s", out, sizeof(out)), "fits");
    CHECK(strcmp(out, "WIFI:T:WPA;S:a\\;b\\,c;P:p\\:q\\\"r\\\\s;;") == 0, "escaped: %s", out);
    CHECK(fos_portal_wifi_code("Open", "", out, sizeof(out)), "fits");
    CHECK(strcmp(out, "WIFI:T:nopass;S:Open;;") == 0, "open: %s", out);
    CHECK(!fos_portal_wifi_code("FrameOS-1A2B", "abcdefghjk", out, 20), "too small is refused");
    CHECK(strlen(out) < 20, "and still terminated");
}

/* ------------------------------------------------------------- the screen */

static const fos_pixel_format_t FORMATS[] = {
    FOS_PIXEL_1BPP,          FOS_PIXEL_DUAL_1BPP_RED, FOS_PIXEL_DUAL_1BPP_YELLOW,
    FOS_PIXEL_2BPP_GRAY,     FOS_PIXEL_2BPP_BWYR,     FOS_PIXEL_4BPP_7COLOR,
    FOS_PIXEL_4BPP_SPECTRA6, FOS_PIXEL_4BPP_GRAY,     FOS_PIXEL_RGB565,
};

/* Panel geometries: the 7.5" and 13.3" e-paper, the reTerminal E-series,
 * the 2.13" both ways, the 72x40 OLED, the 480x480 and 800x480 LCDs. */
static const int SIZES[][2] = {{800, 480}, {1200, 1600}, {1600, 1200}, {480, 800}, {250, 122},
                               {122, 250}, {72, 40},     {480, 480},   {720, 720}, {400, 300}};

static int bpp_of(fos_pixel_format_t format)
{
    switch (format) {
        case FOS_PIXEL_2BPP_GRAY:
        case FOS_PIXEL_2BPP_BWYR: return 2;
        case FOS_PIXEL_4BPP_7COLOR:
        case FOS_PIXEL_4BPP_SPECTRA6:
        case FOS_PIXEL_4BPP_GRAY: return 4;
        case FOS_PIXEL_RGB565: return 16;
        default: return 1;
    }
}

static size_t buffer_len(int w, int h, fos_pixel_format_t format)
{
    size_t row = ((size_t)w * (size_t)bpp_of(format) + 7u) / 8u;
    bool planes = format == FOS_PIXEL_DUAL_1BPP_RED || format == FOS_PIXEL_DUAL_1BPP_YELLOW;
    return row * (size_t)h * (planes ? 2u : 1u);
}

/* Black at scene (x, y)? Through the rotation as fos_panel_draw.c maps it. */
static bool black_at(const fos_panel_surface_t *s, int x, int y)
{
    const int sw = fos_panel_scene_width(s);
    const int sh = fos_panel_scene_height(s);
    int px = x, py = y;
    switch (s->rotate) {
        case 90: px = sh - 1 - y; py = x; break;
        case 180: px = sw - 1 - x; py = sh - 1 - y; break;
        case 270: px = y; py = sw - 1 - x; break;
        default: break;
    }
    const int bpp = bpp_of(s->format);
    const size_t stride = ((size_t)s->width * (size_t)bpp + 7u) / 8u;
    if (bpp == 16) return s->buf[(size_t)py * stride + (size_t)px * 2u] == 0;
    const size_t bit = (size_t)px * (size_t)bpp;
    const unsigned shift = 8u - (unsigned)bpp - (unsigned)(bit % 8u);
    return ((s->buf[(size_t)py * stride + bit / 8u] >> shift) & ((1u << bpp) - 1u)) == 0;
}

static int g_dumped = 0;

static void dump_pgm(const fos_panel_surface_t *s, const char *dir, const char *name)
{
    char path[512];
    snprintf(path, sizeof(path), "%s/%s.pgm", dir, name);
    FILE *f = fopen(path, "wb");
    if (!f) return;
    const int sw = fos_panel_scene_width(s);
    const int sh = fos_panel_scene_height(s);
    fprintf(f, "P5\n%d %d\n255\n", sw, sh);
    for (int y = 0; y < sh; y++) {
        for (int x = 0; x < sw; x++) fputc(black_at(s, x, y) ? 0 : 255, f);
    }
    fclose(f);
    g_dumped++;
}

/* How many times `qr` is on the screen: at every top-left corner of dark
 * (a finder's, light left of it and above), at every module size whose 7
 * units end the finder's top edge, every module's centre compared. */
static int count_codes(const fos_panel_surface_t *s, const fos_qr_t *qr)
{
    const int sw = fos_panel_scene_width(s);
    const int sh = fos_panel_scene_height(s);
    const int n = qr->size;
    int found = 0;
    for (int y = 2; y < sh; y++) {
        for (int x = 2; x < sw; x++) {
            /* A finder's corner: dark here, light to the left and above. */
            if (!black_at(s, x, y) || black_at(s, x - 1, y) || black_at(s, x, y - 1)) continue;
            for (int unit = 2; x + unit * n <= sw && y + unit * n <= sh; unit++) {
                /* The finder's top edge is exactly 7 units long. */
                if (!black_at(s, x + unit * 7 - 1, y) || black_at(s, x + unit * 7, y)) continue;
                bool all = true;
                for (int my = 0; my < n && all; my++) {
                    for (int mx = 0; mx < n && all; mx++) {
                        int cx = x + mx * unit + unit / 2;
                        int cy = y + my * unit + unit / 2;
                        if (black_at(s, cx, cy) != fos_qr_dark(qr, mx, my)) all = false;
                    }
                }
                if (all) found++;
            }
        }
    }
    return found;
}

static void test_screen(void)
{
    const char *dump = getenv("FOS_PORTAL_DUMP");
    fos_qr_t *codes = malloc(2 * sizeof(fos_qr_t));
    static fos_qr_t wifi, url;
    char wifi_code[200];
    fos_portal_wifi_code("FrameOS-1A2B", "abcdefghjk", wifi_code, sizeof(wifi_code));
    fos_qr_encode(wifi_code, &wifi);
    fos_qr_encode("http://192.168.4.1/", &url);

    for (size_t si = 0; si < sizeof(SIZES) / sizeof(SIZES[0]); si++) {
        for (size_t fi = 0; fi < sizeof(FORMATS) / sizeof(FORMATS[0]); fi++) {
            for (int rotate = 0; rotate < 360; rotate += 90) {
                const int w = SIZES[si][0];
                const int h = SIZES[si][1];
                const fos_pixel_format_t format = FORMATS[fi];
                const size_t len = buffer_len(w, h, format);
                uint8_t *buf = malloc(len);
                memset(buf, fos_panel_white_fill(format), len);
                const fos_panel_surface_t s = {.buf = buf, .width = w, .height = h, .format = format,
                                               .rotate = rotate};
                const bool dark = format == FOS_PIXEL_RGB565;
                fos_portal_screen_layout_t layout =
                    fos_portal_screen_draw(&s, "FrameOS-1A2B", "abcdefghjk", "192.168.4.1", dark, codes);
                const int sw = fos_panel_scene_width(&s);
                const int sh = fos_panel_scene_height(&s);

                const bool tiny = sw < 120 || sh < 100;
                /* The background: white on e-paper, black on an LCD (a
                 * tiny panel's text runs to its edges). */
                CHECK(tiny || (black_at(&s, 0, 0) == dark && black_at(&s, sw - 1, sh - 1) == dark),
                      "%dx%d fmt %d rot %d: background %s", w, h, format, rotate, dark ? "black" : "white");
                if (tiny) {
                    CHECK(layout == FOS_PORTAL_SCREEN_TEXT, "%dx%d: text only", w, h);
                } else {
                    CHECK(layout != FOS_PORTAL_SCREEN_TEXT, "%dx%d rot %d: has the codes", w, h, rotate);
                }
                /* Wide panels side by side, tall narrow ones stacked (a
                 * 3:4 one goes whichever way gives the larger codes). */
                if (sw * 3 >= sh * 5 && !tiny) {
                    CHECK(layout == FOS_PORTAL_SCREEN_COLUMNS, "%dx%d rot %d: side by side", w, h, rotate);
                } else if (sh * 3 >= sw * 5 && !tiny) {
                    CHECK(layout == FOS_PORTAL_SCREEN_ROWS, "%dx%d rot %d: stacked", w, h, rotate);
                }
                /* Reading the codes back is slow: one format a size, each
                 * rotation. */
                if (!tiny && format == FOS_PIXEL_1BPP) {
                    CHECK(count_codes(&s, &wifi) == 1, "%dx%d rot %d: the Wi-Fi code is there once", w, h,
                          rotate);
                    CHECK(count_codes(&s, &url) == 1, "%dx%d rot %d: the page's code is there once", w, h,
                          rotate);
                }
                if (dump && (rotate == 0 || (rotate == 90 && w > h)) && (format == FOS_PIXEL_1BPP || format == FOS_PIXEL_RGB565)) {
                    char name[64];
                    snprintf(name, sizeof(name), "portal_%dx%d_%s", sw, sh, dark ? "lcd" : "epaper");
                    dump_pgm(&s, dump, name);
                }
                free(buf);
            }
        }
    }

    /* No working memory for the codes: the facts as text, still drawn. */
    uint8_t *buf = calloc(1, buffer_len(800, 480, FOS_PIXEL_1BPP));
    memset(buf, 0xFF, buffer_len(800, 480, FOS_PIXEL_1BPP));
    const fos_panel_surface_t s = {.buf = buf, .width = 800, .height = 480, .format = FOS_PIXEL_1BPP};
    CHECK(fos_portal_screen_draw(&s, "FrameOS-1A2B", "abcdefghjk", "192.168.4.1", false, NULL) ==
              FOS_PORTAL_SCREEN_TEXT,
          "no scratch: text");
    int ink = 0;
    for (int y = 0; y < 480; y++) {
        for (int x = 0; x < 800; x++) ink += black_at(&s, x, y);
    }
    CHECK(ink > 1000, "no scratch: something drawn (%d px)", ink);
    free(buf);

    /* An open hotspot: no password line, the code says nopass. */
    buf = malloc(buffer_len(800, 480, FOS_PIXEL_1BPP));
    memset(buf, 0xFF, buffer_len(800, 480, FOS_PIXEL_1BPP));
    const fos_panel_surface_t open = {.buf = buf, .width = 800, .height = 480, .format = FOS_PIXEL_1BPP};
    CHECK(fos_portal_screen_draw(&open, "FrameOS-1A2B", "", NULL, false, codes) == FOS_PORTAL_SCREEN_COLUMNS,
          "open hotspot: columns");
    fos_portal_wifi_code("FrameOS-1A2B", "", wifi_code, sizeof(wifi_code));
    fos_qr_encode(wifi_code, &wifi);
    CHECK(count_codes(&open, &wifi) == 1, "open hotspot: its code");
    CHECK(count_codes(&open, &url) == 1, "open hotspot: the default address");
    free(buf);
    free(codes);
    if (dump) printf("dumped %d screens to %s\n", g_dumped, dump);
}

int main(void)
{
    test_qr_vectors();
    test_wifi_code();
    test_screen();
    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures ? 1 : 0;
}
