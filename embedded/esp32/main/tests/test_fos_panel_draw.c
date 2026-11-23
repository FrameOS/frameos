/*
 * Host tests for fos_panel_draw.c: the local network access code box drawn over a
 * packed render for the panel only (docs/lan-access.md), in every pixel
 * format and rotation the firmware drives.
 *
 * What matters most is that the code never outlives the blit: after
 * fos_panel_box_copy(..., restore) the buffer the snapshot, /image, image_get and the
 * backend push read must be the render, byte for byte. Next, that the box
 * reads upright on a rotated frame: the scene-orientation reader below is
 * the BMP preview's mapping (fos_http.c preview_bmp_row), written out again.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain -Imain/tests/host_shim \
 *      -Icomponents/frameos_display/include \
 *      main/fos_panel_draw.c main/tests/test_fos_panel_draw.c \
 *      -o /tmp/test_fos_panel_draw && /tmp/test_fos_panel_draw
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fos_panel_draw.h"

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

static const fos_pixel_format_t FORMATS[] = {
    FOS_PIXEL_1BPP,         FOS_PIXEL_DUAL_1BPP_RED, FOS_PIXEL_DUAL_1BPP_YELLOW,
    FOS_PIXEL_2BPP_GRAY,    FOS_PIXEL_2BPP_BWYR,     FOS_PIXEL_4BPP_7COLOR,
    FOS_PIXEL_4BPP_SPECTRA6, FOS_PIXEL_4BPP_GRAY, FOS_PIXEL_RGB565,
};
static const int ROTATIONS[] = {0, 90, 180, 270};

/* Panel geometries: an 800x480, the 13.3" portrait, odd widths that end
 * mid-byte, a 2.13", the 72x40 OLED and the 480x480 LCD. */
static const int SIZES[][2] = {{800, 480}, {1200, 1600}, {250, 122}, {122, 250}, {203, 97},
                               {72, 40}, {480, 480}};

static size_t row_bytes(int width, int bpp) { return ((size_t)width * (size_t)bpp + 7u) / 8u; }

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

static bool dual(fos_pixel_format_t format)
{
    return format == FOS_PIXEL_DUAL_1BPP_RED || format == FOS_PIXEL_DUAL_1BPP_YELLOW;
}

static size_t buffer_len(int width, int height, fos_pixel_format_t format)
{
    return row_bytes(width, bpp_of(format)) * (size_t)height * (dual(format) ? 2u : 1u);
}

/* The panel pixel's palette index, as fos_http.c's preview reads it (for a
 * two-plane format: 0 black, 1 white, 2 accent). */
static int panel_index(const fos_panel_surface_t *s, int px, int py)
{
    const int bpp = bpp_of(s->format);
    const size_t stride = row_bytes(s->width, bpp);
    if (bpp == 16) {
        /* A colour word: 0 black, 1 white, 2 anything else. */
        const uint8_t *at = s->buf + (size_t)py * stride + (size_t)px * 2u;
        const unsigned word = at[0] | (at[1] << 8);
        return word == 0 ? 0 : word == 0xFFFF ? 1 : 2;
    }
    const size_t bit = (size_t)px * (size_t)bpp;
    const size_t offset = (size_t)py * stride + bit / 8u;
    const unsigned shift = 8u - (unsigned)bpp - (unsigned)(bit % 8u);
    const int value = (s->buf[offset] >> shift) & ((1 << bpp) - 1);
    if (dual(s->format)) {
        const int accent = (s->buf[stride * (size_t)s->height + offset] >> shift) & 1;
        if (value == 0) return 0;
        return accent == 0 ? 2 : 1;
    }
    return value;
}

static int white_of(fos_pixel_format_t format)
{
    switch (format) {
        case FOS_PIXEL_2BPP_GRAY: return 3;
        case FOS_PIXEL_4BPP_GRAY: return 15;
        default: return 1;
    }
}

/* Scene (x, y) through the BMP preview's mapping (fos_http.c). */
static int scene_index(const fos_panel_surface_t *s, int x, int y)
{
    const int out_width = (s->rotate == 90 || s->rotate == 270) ? s->height : s->width;
    const int out_height = (s->rotate == 90 || s->rotate == 270) ? s->width : s->height;
    int px = x, py = y;
    switch (s->rotate) {
        case 90: px = out_height - 1 - y; py = x; break;
        case 180: px = out_width - 1 - x; py = out_height - 1 - y; break;
        case 270: px = y; py = out_width - 1 - x; break;
        default: break;
    }
    return panel_index(s, px, py);
}

static uint32_t s_seed = 1;
static uint8_t next_byte(void)
{
    s_seed = s_seed * 1103515245u + 12345u;
    return (uint8_t)(s_seed >> 16);
}

static bool in_panel_box(const fos_panel_code_box_t *box, int px, int py)
{
    return px >= box->px && px < box->px + box->pw && py >= box->py && py < box->py + box->ph;
}

static void check_one(fos_pixel_format_t format, int width, int height, int rotate)
{
    const size_t len = buffer_len(width, height, format);
    uint8_t *buf = malloc(len);
    uint8_t *original = malloc(len);
    uint8_t *upright = NULL;
    if (buf == NULL || original == NULL) {
        printf("out of memory\n");
        exit(2);
    }
    for (size_t i = 0; i < len; i++) original[i] = next_byte(); /* a busy scene */
    memcpy(buf, original, len);
    fos_panel_surface_t s = {buf, width, height, format, rotate};

    fos_panel_code_box_t box;
    const char *title = "Local network access code";
    if (!fos_panel_code_box(&s, title, 6, &box)) {
        CHECK(false, "fmt %d %dx%d rot %d: no box", format, width, height, rotate);
        goto done;
    }
    const int sw = fos_panel_scene_width(&s);
    const int sh = fos_panel_scene_height(&s);
    CHECK(box.x >= 0 && box.y >= 0 && box.x + box.w <= sw && box.y + box.h <= sh,
          "fmt %d %dx%d rot %d: box %d,%d %dx%d off the %dx%d scene", format, width, height,
          rotate, box.x, box.y, box.w, box.h, sw, sh);
    CHECK(box.pw * box.ph == box.w * box.h, "panel box has the scene box's area");
    if (width >= 200 && height >= 200) {
        CHECK(box.title_scale > 0, "fmt %d %dx%d: a panel this size has room for the title",
              format, width, height);
        CHECK(box.digit_scale >= 3, "fmt %d %dx%d: digits at scale %d", format, width, height,
              box.digit_scale);
    }

    const size_t saved_len = fos_panel_box_copy(&s, &box, NULL, false);
    uint8_t *saved = malloc(saved_len ? saved_len : 1);
    CHECK(fos_panel_box_copy(&s, &box, saved, false) == saved_len, "the copy is the counted size");
    fos_panel_draw_code(&s, &box, title, "042917");

    /* Ink and paper only, inside the box; nothing outside it moved. */
    int black = 0, white = 0, other = 0, moved_outside = 0;
    const int white_index = white_of(format);
    fos_panel_surface_t before = {original, width, height, format, rotate};
    for (int py = 0; py < height; py++) {
        for (int px = 0; px < width; px++) {
            const int now = panel_index(&s, px, py);
            if (in_panel_box(&box, px, py)) {
                if (now == 0) black++;
                else if (now == white_index) white++;
                else other++;
            } else if (now != panel_index(&before, px, py)) {
                moved_outside++;
            }
        }
    }
    CHECK(moved_outside == 0, "fmt %d %dx%d rot %d: %d pixels outside the box changed", format,
          width, height, rotate, moved_outside);
    CHECK(other == 0, "fmt %d %dx%d rot %d: %d box pixels neither black nor white", format,
          width, height, rotate, other);
    CHECK(black > 0 && white > black, "fmt %d %dx%d rot %d: %d black, %d white", format, width,
          height, rotate, black, white);
    /* The border's corners. */
    CHECK(scene_index(&s, box.x, box.y) == 0 && scene_index(&s, box.x + box.w - 1, box.y + box.h - 1) == 0,
          "fmt %d %dx%d rot %d: border corners", format, width, height, rotate);

    /* Upright: the same box drawn unrotated into a scene-sized buffer reads
     * the same, pixel by pixel, through the preview's mapping. */
    if (rotate != 0) {
        const size_t upright_len = buffer_len(sw, sh, format);
        upright = malloc(upright_len);
        memset(upright, fos_panel_white_fill(format), upright_len);
        fos_panel_surface_t u = {upright, sw, sh, format, 0};
        fos_panel_code_box_t ubox;
        CHECK(fos_panel_code_box(&u, title, 6, &ubox), "upright box");
        CHECK(ubox.x == box.x && ubox.y == box.y && ubox.w == box.w && ubox.h == box.h,
              "same layout in scene coordinates");
        fos_panel_draw_code(&u, &ubox, title, "042917");
        int mismatches = 0;
        for (int y = box.y; y < box.y + box.h; y++) {
            for (int x = box.x; x < box.x + box.w; x++) {
                const bool ink_rotated = scene_index(&s, x, y) == 0;
                const bool ink_upright = scene_index(&u, x, y) == 0;
                if (ink_rotated != ink_upright) mismatches++;
            }
        }
        CHECK(mismatches == 0, "fmt %d %dx%d rot %d: %d pixels differ from the upright draw",
              format, width, height, rotate, mismatches);
    }

    /* Restored: the render, byte for byte. */
    fos_panel_box_copy(&s, &box, saved, true);
    CHECK(memcmp(buf, original, len) == 0, "fmt %d %dx%d rot %d: restore is not exact", format,
          width, height, rotate);

    /* Without a copy (fos_client.c, out of memory): the box is painted
     * white, nothing else changes, and the code is gone either way. */
    fos_panel_draw_code(&s, &box, title, "042917");
    fos_panel_fill_rect(&s, box.x, box.y, box.w, box.h, false);
    int not_white = 0;
    moved_outside = 0;
    for (int py = 0; py < height; py++) {
        for (int px = 0; px < width; px++) {
            const int now = panel_index(&s, px, py);
            if (in_panel_box(&box, px, py)) {
                if (now != white_index) not_white++;
            } else if (now != panel_index(&before, px, py)) {
                moved_outside++;
            }
        }
    }
    CHECK(not_white == 0 && moved_outside == 0,
          "fmt %d %dx%d rot %d: blank restore left %d dark, moved %d outside", format, width,
          height, rotate, not_white, moved_outside);
    free(saved);
done:
    free(upright);
    free(buf);
    free(original);
}

static void test_every_format_size_and_rotation(void)
{
    for (size_t f = 0; f < sizeof(FORMATS) / sizeof(FORMATS[0]); f++) {
        for (size_t z = 0; z < sizeof(SIZES) / sizeof(SIZES[0]); z++) {
            for (size_t r = 0; r < sizeof(ROTATIONS) / sizeof(ROTATIONS[0]); r++) {
                check_one(FORMATS[f], SIZES[z][0], SIZES[z][1], ROTATIONS[r]);
            }
        }
    }
}

static void test_small_and_odd(void)
{
    uint8_t buf[64];
    memset(buf, 0xFF, sizeof(buf));
    fos_panel_surface_t tiny = {buf, 16, 16, FOS_PIXEL_1BPP, 0};
    fos_panel_code_box_t box;
    CHECK(!fos_panel_code_box(&tiny, "Local network access code", 6, &box), "16x16 has no room for six digits");

    uint8_t oled[(72 / 8) * 40];
    memset(oled, 0xFF, sizeof(oled));
    fos_panel_surface_t small = {oled, 72, 40, FOS_PIXEL_1BPP, 0};
    CHECK(fos_panel_code_box(&small, "Local network access code", 6, &box), "72x40 fits the digits");
    CHECK(box.title_scale == 0 && box.digit_scale == 1, "72x40: digits alone (title %d, digits %d)",
          box.title_scale, box.digit_scale);

    fos_panel_surface_t unknown = {oled, 72, 40, (fos_pixel_format_t)0, 0};
    CHECK(!fos_panel_code_box(&unknown, "Local network access code", 6, &box), "unknown format: no box");
    CHECK(fos_panel_box_copy(&unknown, &box, NULL, false) == 0, "unknown format: nothing to save");
}

static void test_text_metrics(void)
{
    CHECK(fos_panel_text_width("000000", 1) == 35, "six glyphs at scale 1");
    CHECK(fos_panel_text_width("000000", 3) == 105, "six glyphs at scale 3");
    CHECK(fos_panel_text_width("", 3) == 0 && fos_panel_text_width(NULL, 3) == 0, "empty");
    CHECK(fos_panel_fit_scale("Local network access code", 6, 300) == 2, "fit %d",
          fos_panel_fit_scale("Local network access code", 6, 300));
    CHECK(fos_panel_fit_scale("Local network access code", 6, 10) == 1, "never below 1");
    CHECK(fos_panel_white_fill(FOS_PIXEL_4BPP_SPECTRA6) == 0x11 &&
              fos_panel_white_fill(FOS_PIXEL_2BPP_BWYR) == 0x55 &&
              fos_panel_white_fill(FOS_PIXEL_1BPP) == 0xFF,
          "white fills");
}

/* The voice chat's notice (docs/voice-chat.md): wrapped text in a box across
 * the bottom of the scene, restored byte for byte like the code box. */
static void test_notice_box(void)
{
    const int width = 800, height = 480, rotate = 90;
    const fos_pixel_format_t format = FOS_PIXEL_4BPP_SPECTRA6;
    const size_t len = buffer_len(width, height, format);
    uint8_t *buf = malloc(len);
    uint8_t *original = malloc(len);
    for (size_t i = 0; i < len; i++) original[i] = next_byte();
    memcpy(buf, original, len);
    fos_panel_surface_t s = {buf, width, height, format, rotate};
    const int sw = fos_panel_scene_width(&s);
    const int sh = fos_panel_scene_height(&s);

    fos_panel_code_box_t box;
    const char *text = "\"Switch to the calendar.\"\nSwitched to Calendar.";
    CHECK(fos_panel_notice_box(&s, text, 3, 6, &box), "a two-line notice fits a 480x800 scene");
    CHECK(box.digit_scale == 2, "two lines, got %d", box.digit_scale);
    CHECK(box.title_scale >= 2, "readable glyphs (scale %d)", box.title_scale);
    CHECK(box.x >= 0 && box.x + box.w <= sw && box.y + box.h == sh - box.gap,
          "across the bottom: %d,%d %dx%d on %dx%d", box.x, box.y, box.w, box.h, sw, sh);
    CHECK(box.pw * box.ph == box.w * box.h, "panel box has the scene box's area");

    const size_t saved_len = fos_panel_box_copy(&s, &box, NULL, false);
    uint8_t *saved = malloc(saved_len ? saved_len : 1);
    fos_panel_box_copy(&s, &box, saved, false);
    fos_panel_draw_notice(&s, &box, text);
    int black = 0, white = 0, moved_outside = 0;
    const int white_index = white_of(format);
    fos_panel_surface_t before = {original, width, height, format, rotate};
    for (int py = 0; py < height; py++) {
        for (int px = 0; px < width; px++) {
            int now = panel_index(&s, px, py);
            if (in_panel_box(&box, px, py)) {
                if (now == 0) black++;
                else if (now == white_index) white++;
            } else if (now != panel_index(&before, px, py)) {
                moved_outside++;
            }
        }
    }
    CHECK(black > 0 && white > black, "%d black, %d white", black, white);
    CHECK(moved_outside == 0, "%d pixels outside the notice changed", moved_outside);
    fos_panel_box_copy(&s, &box, saved, true);
    CHECK(memcmp(buf, original, len) == 0, "restore is not exact");

    /* A long answer wraps onto more lines at a smaller scale, and never past
     * six lines; a tiny panel has no room for words at all. */
    const char *essay =
        "\"What is on the frame right now?\"\nThe frame shows the Calendar scene, with this week's events "
        "from the shared family calendar; the Message board and the Counter are the other two scenes "
        "installed, and I can switch to either of them if you ask.";
    CHECK(fos_panel_notice_box(&s, essay, 3, 6, &box), "a long notice still fits");
    CHECK(box.digit_scale <= 6 && box.digit_scale >= 4, "wrapped to %d lines", box.digit_scale);
    CHECK(box.title_scale <= 2, "smaller glyphs for the long text (scale %d)", box.title_scale);
    uint8_t tiny_buf[16 * 16];
    fos_panel_surface_t tiny = {tiny_buf, 16, 16, FOS_PIXEL_1BPP, 0};
    CHECK(!fos_panel_notice_box(&tiny, text, 3, 6, &box), "16x16 has no room for a notice");
    free(saved);
    free(buf);
    free(original);
}

/* The deep sleep mark lands in the top-right corner of the SCENE whatever
 * the rotation: its border, the moon and the "z" in black, the rest of its
 * tile white, and nothing outside it touched. */
static void test_sleep_mark(void)
{
    for (size_t f = 0; f < sizeof(FORMATS) / sizeof(FORMATS[0]); f++) {
        for (size_t z = 0; z < sizeof(SIZES) / sizeof(SIZES[0]); z++) {
            for (size_t r = 0; r < sizeof(ROTATIONS) / sizeof(ROTATIONS[0]); r++) {
                const fos_pixel_format_t format = FORMATS[f];
                const int width = SIZES[z][0], height = SIZES[z][1];
                size_t len = buffer_len(width, height, format);
                uint8_t *buf = calloc(1, len);
                fos_panel_surface_t s = {.buf = buf, .width = width, .height = height,
                                         .format = format, .rotate = ROTATIONS[r]};
                const int sw = fos_panel_scene_width(&s), sh = fos_panel_scene_height(&s);
                fos_panel_fill_rect(&s, 0, 0, sw, sh, false);
                const int white = white_of(format);
                fos_panel_code_box_t box;
                bool drawn = fos_panel_draw_sleep_mark(&s, &box);
                CHECK(drawn, "fmt %d %dx%d rot %d: drawn", format, width, height, ROTATIONS[r]);
                if (!drawn) { free(buf); continue; }
                const int scale = box.w / 22;
                CHECK(box.x + box.w == sw - 4 * scale && box.y == 4 * scale,
                      "fmt %d %dx%d rot %d: top right (%d,%d %dx%d of %dx%d)", format, width, height,
                      ROTATIONS[r], box.x, box.y, box.w, box.h, sw, sh);
                CHECK(scene_index(&s, box.x, box.y) == 0, "fmt %d rot %d: border black", format, ROTATIONS[r]);
                CHECK(scene_index(&s, box.x + box.w - 1, box.y + box.h - 1) == 0,
                      "fmt %d rot %d: far border black", format, ROTATIONS[r]);
                /* Row 12 col 4: the moon; row 0 col 0: tile white; row 0 col 11: the z. */
                CHECK(scene_index(&s, box.x + box.pad + 4 * scale, box.y + box.pad + 12 * scale) == 0,
                      "fmt %d rot %d: moon black", format, ROTATIONS[r]);
                CHECK(scene_index(&s, box.x + box.pad, box.y + box.pad) == white,
                      "fmt %d rot %d: tile white", format, ROTATIONS[r]);
                CHECK(scene_index(&s, box.x + box.pad + 11 * scale, box.y + box.pad) == 0,
                      "fmt %d rot %d: z black", format, ROTATIONS[r]);
                CHECK(scene_index(&s, 0, sh - 1) == white && scene_index(&s, box.x - 1, box.y) == white &&
                          scene_index(&s, box.x, box.y + box.h) == white,
                      "fmt %d rot %d: nothing drawn outside the tile", format, ROTATIONS[r]);
                free(buf);
            }
        }
    }
    /* The 480x800 Sticky: a 32 px moon on a 44 px tile, 8 px from the corner. */
    size_t len = buffer_len(800, 480, FOS_PIXEL_2BPP_GRAY);
    uint8_t *buf = calloc(1, len);
    fos_panel_surface_t s = {.buf = buf, .width = 800, .height = 480, .format = FOS_PIXEL_2BPP_GRAY, .rotate = 270};
    fos_panel_code_box_t box;
    CHECK(fos_panel_draw_sleep_mark(&s, &box) && box.w == 44 && box.x == 480 - 8 - 44 && box.y == 8,
          "sticky: 44 px tile at (%d,%d) %d", box.x, box.y, box.w);
    free(buf);
    /* Too small for it: nothing. */
    uint8_t tiny[8] = {0};
    fos_panel_surface_t t = {.buf = tiny, .width = 16, .height = 4, .format = FOS_PIXEL_1BPP, .rotate = 0};
    CHECK(!fos_panel_draw_sleep_mark(&t, NULL), "16x4: no mark");
}

/* The wake spinner: the same tile as the sleep mark, its leading dot black
 * and moving clockwise, nothing outside the tile. */
static void test_wake_mark(void)
{
    static const int dots[8][2] = {{8, 2}, {12, 4}, {14, 8}, {12, 12}, {8, 14}, {4, 12}, {2, 8}, {4, 4}};
    for (size_t f = 0; f < sizeof(FORMATS) / sizeof(FORMATS[0]); f++) {
        for (size_t r = 0; r < sizeof(ROTATIONS) / sizeof(ROTATIONS[0]); r++) {
            const fos_pixel_format_t format = FORMATS[f];
            size_t len = buffer_len(800, 480, format);
            uint8_t *buf = calloc(1, len);
            fos_panel_surface_t s = {.buf = buf, .width = 800, .height = 480, .format = format,
                                     .rotate = ROTATIONS[r]};
            const int sw = fos_panel_scene_width(&s), sh = fos_panel_scene_height(&s);
            const int white = white_of(format);
            fos_panel_code_box_t sleep_box, box;
            fos_panel_fill_rect(&s, 0, 0, sw, sh, false);
            fos_panel_draw_sleep_mark(&s, &sleep_box);
            for (int frame = 0; frame < 9; frame++) {
                CHECK(fos_panel_draw_wake_mark(&s, frame, &box), "fmt %d rot %d: drawn", format, ROTATIONS[r]);
                CHECK(box.x == sleep_box.x && box.y == sleep_box.y && box.w == sleep_box.w,
                      "fmt %d rot %d: where the moon was", format, ROTATIONS[r]);
                const int scale = box.w / 22;
                const int lead = frame % 8;
                const int far = (lead + 4) % 8;
                CHECK(scene_index(&s, box.x + box.pad + dots[lead][0] * scale,
                                  box.y + box.pad + dots[lead][1] * scale) == 0,
                      "fmt %d rot %d frame %d: leading dot black", format, ROTATIONS[r], frame);
                /* The dot across from it is one pixel: next to its centre is white. */
                CHECK(scene_index(&s, box.x + box.pad + (dots[far][0] + 1) * scale,
                                  box.y + box.pad + (dots[far][1] + 1) * scale) == white,
                      "fmt %d rot %d frame %d: far dot small", format, ROTATIONS[r], frame);
                /* The moon's body (row 8 col 5, inside the ring: no dot) is gone. */
                CHECK(scene_index(&s, box.x + box.pad + 5 * scale, box.y + box.pad + 8 * scale) == white,
                      "fmt %d rot %d frame %d: no moon left", format, ROTATIONS[r], frame);
                CHECK(scene_index(&s, 0, sh - 1) == white && scene_index(&s, box.x - 1, box.y) == white,
                      "fmt %d rot %d: nothing outside the tile", format, ROTATIONS[r]);
            }
            free(buf);
        }
    }
}

int main(void)
{
    test_text_metrics();
    test_small_and_odd();
    test_every_format_size_and_rotation();
    test_notice_box();
    test_sleep_mark();
    test_wake_mark();
    printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
