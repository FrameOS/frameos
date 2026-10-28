/*
 * Host tests for the RGB LCD's loading mark (components/frameos_display/
 * lcd_loading.c): nothing before the delay, the mark in the buffer on the
 * glass after it, the pixels under it put back exactly when it goes, moved
 * along when another buffer goes up, a switch begun during another keeping
 * the first one's start, and the two-minute stop.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Icomponents/frameos_display/include \
 *      components/frameos_display/lcd_loading.c main/tests/test_fos_lcd_loading.c \
 *      -o /tmp/test_fos_lcd_loading && /tmp/test_fos_lcd_loading
 *
 * (backend/app/tasks/tests/test_esp32_lcd_loading.py does exactly that in CI.)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "lcd_loading.h"

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

#define W 64
#define H 48
#define MS 1

static uint16_t g_fb[3][W * H];
static uint16_t g_saved[32 * 32];
static int g_draws = 0;
static int32_t g_last_t = -1;
static int32_t g_last_rotation = -1;

/* Where the runtime puts the mark: this rect, or `g_moved` at a quarter turn. */
static const fos_lcd_loading_rect_t k_rect = {40, 4, 20, 10};
static fos_lcd_loading_rect_t g_moved = {2, 30, 10, 10};
static fos_lcd_loading_rect_t g_rect;

/* A stand-in for the runtime's mark (loading_mark.nim): the rect it is asked
 * for, and frames in which every pixel of the rect becomes a function of the
 * frame's time and what was under it. */
static void fake_mark(int32_t panel_w, int32_t panel_h, int32_t rotation, int32_t t_ms, int32_t *rect,
                      const void *src, int32_t src_stride, void *dst, int32_t dst_stride)
{
    CHECK(panel_w == W && panel_h == H, "asked about the panel");
    if (!src) {
        fos_lcd_loading_rect_t where = rotation == 270 ? g_moved : g_rect;
        memcpy(rect, &where, sizeof(where));
        return;
    }
    g_draws++;
    g_last_t = t_ms;
    g_last_rotation = rotation;
    for (int32_t y = 0; y < rect[3]; y++) {
        const uint16_t *s = (const uint16_t *)((const uint8_t *)src + (size_t)y * (size_t)src_stride);
        uint16_t *d = (uint16_t *)((uint8_t *)dst + (size_t)y * (size_t)dst_stride);
        for (int32_t x = 0; x < rect[2]; x++) d[x] = (uint16_t)(~s[x] ^ (uint16_t)t_ms);
    }
}

static void paint(int buffer, unsigned seed)
{
    for (int i = 0; i < W * H; i++) g_fb[buffer][i] = (uint16_t)(i * 2654435761u + seed);
}

static fos_lcd_loading_t fresh(void)
{
    fos_lcd_loading_t m;
    memset(&m, 0, sizeof(m));
    m.width = W;
    m.height = H;
    m.saved = g_saved;
    m.saved_words = sizeof(g_saved) / sizeof(g_saved[0]);
    m.draw = fake_mark;
    g_draws = 0;
    g_rect = k_rect;
    return m;
}

/* Pixels that differ from `before`, and whether they are all inside the rect. */
static int changed(const uint16_t *fb, const uint16_t *before, bool *inside)
{
    int n = 0;
    *inside = true;
    for (int y = 0; y < H; y++) {
        for (int x = 0; x < W; x++) {
            if (fb[y * W + x] == before[y * W + x]) continue;
            n++;
            if (x < k_rect.x || x >= k_rect.x + k_rect.w || y < k_rect.y || y >= k_rect.y + k_rect.h) {
                *inside = false;
            }
        }
    }
    return n;
}

static void test_nothing_before_the_delay_then_the_mark_then_the_picture_back(void)
{
    fos_lcd_loading_t m = fresh();
    paint(0, 1);
    uint16_t before[W * H];
    memcpy(before, g_fb[0], sizeof(before));
    CHECK(fos_lcd_loading_begin(&m, 90, 1000 * MS), "begins");
    int32_t wait = fos_lcd_loading_step(&m, g_fb[0], 1000 * MS);
    CHECK(wait == FOS_LCD_LOADING_DELAY_MS * MS, "waits out the delay: %lld", (long long)wait);
    wait = fos_lcd_loading_step(&m, g_fb[0], 1150 * MS);
    CHECK(wait == 50 * MS, "the rest of it: %lld", (long long)wait);
    CHECK(g_draws == 0 && m.drawn_in == NULL, "nothing drawn yet");
    CHECK(memcmp(before, g_fb[0], sizeof(before)) == 0, "the picture untouched");
    wait = fos_lcd_loading_step(&m, g_fb[0], 1200 * MS);
    CHECK(wait == FOS_LCD_LOADING_FRAME_MS * MS, "then a frame every %d ms", FOS_LCD_LOADING_FRAME_MS);
    CHECK(g_draws == 1 && g_last_t == 0 && m.drawn_in == g_fb[0], "the first frame, at t 0, on the glass");
    CHECK(g_last_rotation == 90, "drawn at the frame's rotation");
    bool inside;
    int n = changed(g_fb[0], before, &inside);
    CHECK(n > 0 && inside, "%d pixels changed, all inside the rect: %d", n, inside);
    fos_lcd_loading_step(&m, g_fb[0], 1450 * MS);
    CHECK(g_last_t == 250, "frames from the saved picture, timed from the delay: %d", (int)g_last_t);
    fos_lcd_loading_end(&m);
    CHECK(m.drawn_in == NULL && !m.active, "put away, the switch over");
    CHECK(memcmp(before, g_fb[0], sizeof(before)) == 0, "the picture exactly as it was");
    CHECK(fos_lcd_loading_step(&m, g_fb[0], 1700 * MS) == -1, "then idle");
}

static void test_a_quick_switch_shows_nothing(void)
{
    fos_lcd_loading_t m = fresh();
    paint(0, 2);
    uint16_t before[W * H];
    memcpy(before, g_fb[0], sizeof(before));
    fos_lcd_loading_begin(&m, 0, 0);
    fos_lcd_loading_step(&m, g_fb[0], 120 * MS);
    fos_lcd_loading_end(&m);
    CHECK(g_draws == 0 && memcmp(before, g_fb[0], sizeof(before)) == 0, "the picture untouched");
}

static void test_the_mark_follows_the_buffer_on_the_glass(void)
{
    fos_lcd_loading_t m = fresh();
    paint(0, 3);
    paint(1, 4);
    uint16_t before0[W * H], before1[W * H];
    memcpy(before0, g_fb[0], sizeof(before0));
    memcpy(before1, g_fb[1], sizeof(before1));
    fos_lcd_loading_begin(&m, 0, 0);
    fos_lcd_loading_step(&m, g_fb[0], 300 * MS);
    CHECK(m.drawn_in == g_fb[0], "in the first buffer");
    /* Another buffer went up (a frame of the scene being left, before the
     * switch was applied): the mark moves with it. */
    fos_lcd_loading_step(&m, g_fb[1], 350 * MS);
    CHECK(m.drawn_in == g_fb[1], "drawn in the second");
    CHECK(memcmp(before0, g_fb[0], sizeof(before0)) == 0, "the first buffer exactly as it was");
    bool inside;
    CHECK(changed(g_fb[1], before1, &inside) > 0 && inside, "the second carries it");
    fos_lcd_loading_end(&m);
    CHECK(memcmp(before1, g_fb[1], sizeof(before1)) == 0, "and is clean once it goes");
}

static void test_a_switch_during_another_keeps_its_start(void)
{
    fos_lcd_loading_t m = fresh();
    paint(0, 5);
    uint16_t before[W * H];
    memcpy(before, g_fb[0], sizeof(before));
    fos_lcd_loading_begin(&m, 0, 0);
    fos_lcd_loading_step(&m, g_fb[0], 250 * MS);
    CHECK(fos_lcd_loading_begin(&m, 0, 240 * MS), "a second switch");
    CHECK(m.since_ms == 0, "still counted from the first");
    CHECK(m.drawn_in == g_fb[0], "the mark stays up");
    fos_lcd_loading_step(&m, g_fb[0], 300 * MS);
    CHECK(g_last_t == 100, "and keeps its time: %d", (int)g_last_t);
    /* A switch at another turn: the mark moves, put back where it was first. */
    CHECK(fos_lcd_loading_begin(&m, 270, 260 * MS), "begun at another turn");
    CHECK(m.drawn_in == NULL && memcmp(before, g_fb[0], sizeof(before)) == 0, "the old one put back first");
    CHECK(m.rect.x == g_moved.x && m.rect.y == g_moved.y, "and goes where the runtime says");
    fos_lcd_loading_step(&m, g_fb[0], 320 * MS);
    CHECK(g_last_rotation == 270 && m.drawn_in == g_fb[0], "drawn at the new turn");
}

static void test_a_rect_it_cannot_hold_is_no_mark(void)
{
    fos_lcd_loading_t m = fresh();
    g_rect = (fos_lcd_loading_rect_t){0, 0, W, H};
    CHECK(!fos_lcd_loading_begin(&m, 0, 0), "too big for the saved pixels");
    g_rect = (fos_lcd_loading_rect_t){0, 0, 0, 0};
    CHECK(!fos_lcd_loading_begin(&m, 0, 0), "empty: nowhere to go");
    CHECK(!m.active, "nothing loading");
    CHECK(fos_lcd_loading_step(&m, g_fb[0], 500 * MS) == -1, "nothing to do");
}

static void test_the_clock_may_wrap(void)
{
    /* The tick count in milliseconds wraps every 49.7 days. */
    fos_lcd_loading_t m = fresh();
    uint32_t since = UINT32_MAX - 100;
    CHECK(fos_lcd_loading_begin(&m, 0, since), "begins just before the wrap");
    CHECK(fos_lcd_loading_step(&m, g_fb[0], since + 50) == 150, "waits out the rest of the delay");
    CHECK(fos_lcd_loading_step(&m, g_fb[0], since + 250) == FOS_LCD_LOADING_FRAME_MS && g_last_t == 50,
          "then draws, past the wrap: t %d", (int)g_last_t);
    fos_lcd_loading_end(&m);
}

static void test_a_switch_that_never_lands_stops_by_itself(void)
{
    fos_lcd_loading_t m = fresh();
    paint(2, 6);
    uint16_t before[W * H];
    memcpy(before, g_fb[2], sizeof(before));
    fos_lcd_loading_begin(&m, 0, 0);
    fos_lcd_loading_step(&m, g_fb[2], 1000 * MS);
    int32_t wait = fos_lcd_loading_step(&m, g_fb[2], FOS_LCD_LOADING_MAX_MS * MS);
    CHECK(wait == -1 && !m.active, "stopped");
    CHECK(m.drawn_in == NULL && memcmp(before, g_fb[2], sizeof(before)) == 0, "with the picture back");
}

int main(void)
{
    test_nothing_before_the_delay_then_the_mark_then_the_picture_back();
    test_a_quick_switch_shows_nothing();
    test_the_mark_follows_the_buffer_on_the_glass();
    test_a_switch_during_another_keeps_its_start();
    test_a_rect_it_cannot_hold_is_no_mark();
    test_the_clock_may_wrap();
    test_a_switch_that_never_lands_stops_by_itself();
    if (g_failures) {
        printf("%d of %d checks failed\n", g_failures, g_checks);
        return 1;
    }
    printf("ok: %d checks\n", g_checks);
    return 0;
}
