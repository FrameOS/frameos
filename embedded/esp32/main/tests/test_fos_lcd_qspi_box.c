/* What a QSPI AMOLED that keeps its picture is sent
 * (components/frameos_display/lcd_qspi_box.c): the rectangle around every
 * changed pixel, widened to the CO5300's even start and odd end, and the
 * pixels byte-swapped, a pair at a time. And the QSPI driver's board choice
 * (lcd_qspi_amoled.c, compiled as its stub for a chip without the panel). */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "lcd_qspi_amoled.h"
#include "lcd_qspi_box.h"

static int failures = 0;

#define CHECK(cond, ...)                                    \
    do {                                                    \
        if (!(cond)) {                                      \
            failures++;                                     \
            printf("FAIL %s:%d: ", __FILE__, __LINE__);     \
            printf(__VA_ARGS__);                            \
            printf("\n");                                   \
        }                                                   \
    } while (0)

#define W 466
#define H 466

static uint16_t glass[W * H];
static uint16_t now[W * H];

static void reset_frames(void)
{
    for (int i = 0; i < W * H; i++) glass[i] = now[i] = (uint16_t)(i * 2654435761u >> 16);
}

static void expect_box(const char *name, int x0, int y0, int x1, int y1)
{
    fos_lcd_qspi_box_t box;
    bool changed = fos_lcd_qspi_changed_box(glass, now, W, H, &box);
    CHECK(changed, "%s: no change found", name);
    if (!changed) return;
    CHECK(box.x0 == x0 && box.y0 == y0 && box.x1 == x1 && box.y1 == y1, "%s: got %d,%d..%d,%d want %d,%d..%d,%d",
          name, box.x0, box.y0, box.x1, box.y1, x0, y0, x1, y1);
}

int main(void)
{
    fos_lcd_qspi_box_t box;
    reset_frames();
    CHECK(!fos_lcd_qspi_changed_box(glass, now, W, H, &box), "the same frame changed");

    /* One pixel: its pair of columns, its row. */
    now[100 * W + 201] ^= 0x1234;
    expect_box("one pixel", 200, 100, 201, 100);
    fos_lcd_qspi_changed_box(glass, now, W, H, &box);
    fos_lcd_qspi_align_box(&box, W, H);
    CHECK(box.x0 == 200 && box.y0 == 100 && box.x1 == 201 && box.y1 == 101, "aligned: %d,%d..%d,%d", box.x0,
          box.y0, box.x1, box.y1);

    /* Two pixels far apart: one box around both. */
    reset_frames();
    now[3 * W + 400] ^= 1;
    now[300 * W + 7] ^= 1;
    expect_box("two corners", 6, 3, 401, 300);

    /* A change in the first and the last pixel: the whole frame. */
    reset_frames();
    now[0] ^= 1;
    now[W * H - 1] ^= 1;
    expect_box("whole", 0, 0, W - 1, H - 1);

    /* A row between two changed rows that is the same still counts its
     * columns from the rows that changed. */
    reset_frames();
    now[10 * W + 50] ^= 1;
    now[12 * W + 60] ^= 1;
    expect_box("gap row", 50, 10, 61, 12);

    /* Align: odd starts go down, even ends go up, inside the frame. */
    box = (fos_lcd_qspi_box_t){3, 5, 8, 10};
    fos_lcd_qspi_align_box(&box, W, H);
    CHECK(box.x0 == 2 && box.y0 == 4 && box.x1 == 9 && box.y1 == 11, "align: %d,%d..%d,%d", box.x0, box.y0,
          box.x1, box.y1);
    box = (fos_lcd_qspi_box_t){0, 0, W - 1, H - 1};
    fos_lcd_qspi_align_box(&box, W, H);
    CHECK(box.x1 == W - 1 && box.y1 == H - 1, "align at the edge: %d,%d", box.x1, box.y1);

    /* The copy: the box's rows, each word's bytes swapped. */
    uint16_t frame[8 * 4];
    for (int i = 0; i < 32; i++) frame[i] = (uint16_t)(0x0100 * i + 0x10 + i);
    box = (fos_lcd_qspi_box_t){2, 1, 5, 3};
    uint16_t out[4 * 2];
    memset(out, 0, sizeof(out));
    fos_lcd_qspi_copy_swapped(frame, 8, &box, 1, 2, out);
    for (int r = 0; r < 2; r++) {
        for (int c = 0; c < 4; c++) {
            uint16_t src = frame[(1 + r) * 8 + 2 + c];
            uint16_t want = (uint16_t)((src >> 8) | (src << 8));
            CHECK(out[r * 4 + c] == want, "copy row %d col %d: %04x want %04x", r, c, out[r * 4 + c], want);
        }
    }

    /* The board: the preset names it, the panel without one. */
    int w = 0, h = 0;
    fos_lcd_qspi_select_board("waveshare_esp32_s3_touch_amoled_1_75", "AMOLED_CO5300_466x466");
    fos_lcd_qspi_size(&w, &h);
    CHECK(w == 466 && h == 466, "preset size %dx%d", w, h);
    fos_lcd_qspi_select_board(NULL, "AMOLED_CO5300_466x466");
    fos_lcd_qspi_size(&w, &h);
    CHECK(w == 466 && h == 466, "panel size %dx%d", w, h);
    CHECK(fos_lcd_qspi_round(), "the 1.75\" glass is round");
    CHECK(fos_lcd_qspi_init() != 0, "the stub has no panel");

    if (failures) {
        printf("%d failure(s)\n", failures);
        return 1;
    }
    printf("ok: qspi box\n");
    return 0;
}
