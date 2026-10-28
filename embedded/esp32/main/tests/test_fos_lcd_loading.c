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
#define MS 1000LL

static uint16_t g_fb[3][W * H];
static uint16_t g_saved[32 * 32];
static int g_draws = 0;
static int32_t g_last_t = -1;

/* A stand-in for the runtime's drawer: every pixel of the rect becomes a
 * function of the frame's time and what was under it. */
static void fake_draw(int32_t t_ms, const fos_lcd_loading_rect_t *rect, const uint16_t *src,
                      int32_t src_stride, uint16_t *dst, int32_t dst_stride)
{
    g_draws++;
    g_last_t = t_ms;
    for (int32_t y = 0; y < rect->h; y++) {
        const uint16_t *s = (const uint16_t *)((const uint8_t *)src + (size_t)y * (size_t)src_stride);
        uint16_t *d = (uint16_t *)((uint8_t *)dst + (size_t)y * (size_t)dst_stride);
        for (int32_t x = 0; x < rect->w; x++) d[x] = (uint16_t)(~s[x] ^ (uint16_t)t_ms);
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
    m.draw = fake_draw;
    m.shown_ms = -1;
    g_draws = 0;
    return m;
}

static const fos_lcd_loading_rect_t k_rect = {40, 4, 20, 10};

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
    uint16_t *wrote, *restored;
    CHECK(fos_lcd_loading_begin(&m, &k_rect, 1000 * MS), "begins");
    int64_t wait = fos_lcd_loading_step(&m, g_fb[0], 1000 * MS, &wrote, &restored);
    CHECK(wait == FOS_LCD_LOADING_DELAY_MS * MS, "waits out the delay: %lld", (long long)wait);
    wait = fos_lcd_loading_step(&m, g_fb[0], 1150 * MS, &wrote, &restored);
    CHECK(wait == 50 * MS, "the rest of it: %lld", (long long)wait);
    CHECK(g_draws == 0 && wrote == NULL, "nothing drawn yet");
    CHECK(memcmp(before, g_fb[0], sizeof(before)) == 0, "the picture untouched");
    wait = fos_lcd_loading_step(&m, g_fb[0], 1200 * MS, &wrote, &restored);
    CHECK(wait == FOS_LCD_LOADING_FRAME_MS * MS, "then a frame every %d ms", FOS_LCD_LOADING_FRAME_MS);
    CHECK(g_draws == 1 && g_last_t == 0 && wrote == g_fb[0], "the first frame, at t 0, on the glass");
    bool inside;
    int n = changed(g_fb[0], before, &inside);
    CHECK(n > 0 && inside, "%d pixels changed, all inside the rect: %d", n, inside);
    fos_lcd_loading_step(&m, g_fb[0], 1450 * MS, &wrote, &restored);
    CHECK(g_last_t == 250, "frames from the saved picture, timed from the delay: %d", (int)g_last_t);
    uint16_t *back = fos_lcd_loading_end(&m, 1600 * MS);
    CHECK(back == g_fb[0], "put back where it was");
    CHECK(memcmp(before, g_fb[0], sizeof(before)) == 0, "the picture exactly as it was");
    CHECK(fos_lcd_loading_take_shown_ms(&m) == 600, "the switch took 600 ms");
    CHECK(fos_lcd_loading_take_shown_ms(&m) == -1, "told once");
    CHECK(fos_lcd_loading_step(&m, g_fb[0], 1700 * MS, &wrote, &restored) == -1, "then idle");
}

static void test_a_quick_switch_shows_nothing(void)
{
    fos_lcd_loading_t m = fresh();
    paint(0, 2);
    uint16_t before[W * H];
    memcpy(before, g_fb[0], sizeof(before));
    uint16_t *wrote, *restored;
    fos_lcd_loading_begin(&m, &k_rect, 0);
    fos_lcd_loading_step(&m, g_fb[0], 120 * MS, &wrote, &restored);
    CHECK(fos_lcd_loading_end(&m, 150 * MS) == NULL, "nothing to put back");
    CHECK(fos_lcd_loading_take_shown_ms(&m) == -1, "and nothing to tell");
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
    uint16_t *wrote, *restored;
    fos_lcd_loading_begin(&m, &k_rect, 0);
    fos_lcd_loading_step(&m, g_fb[0], 300 * MS, &wrote, &restored);
    CHECK(wrote == g_fb[0], "in the first buffer");
    /* Another buffer went up (a frame of the scene being left, before the
     * switch was applied): the mark moves with it. */
    fos_lcd_loading_step(&m, g_fb[1], 350 * MS, &wrote, &restored);
    CHECK(restored == g_fb[0] && wrote == g_fb[1], "put back in the first, drawn in the second");
    CHECK(memcmp(before0, g_fb[0], sizeof(before0)) == 0, "the first buffer exactly as it was");
    bool inside;
    CHECK(changed(g_fb[1], before1, &inside) > 0 && inside, "the second carries it");
    fos_lcd_loading_end(&m, 400 * MS);
    CHECK(memcmp(before1, g_fb[1], sizeof(before1)) == 0, "and is clean once it goes");
}

static void test_a_switch_during_another_keeps_its_start(void)
{
    fos_lcd_loading_t m = fresh();
    paint(0, 5);
    uint16_t *wrote, *restored;
    fos_lcd_loading_begin(&m, &k_rect, 0);
    fos_lcd_loading_step(&m, g_fb[0], 250 * MS, &wrote, &restored);
    CHECK(fos_lcd_loading_begin(&m, &k_rect, 240 * MS), "a second switch");
    CHECK(m.since_us == 0, "still counted from the first");
    CHECK(m.drawn_in == g_fb[0], "the mark stays up");
    fos_lcd_loading_step(&m, g_fb[0], 300 * MS, &wrote, &restored);
    CHECK(g_last_t == 100, "and keeps its time: %d", (int)g_last_t);
}

static void test_a_rect_it_cannot_hold_is_no_mark(void)
{
    fos_lcd_loading_t m = fresh();
    fos_lcd_loading_rect_t huge = {0, 0, W, H};
    CHECK(!fos_lcd_loading_begin(&m, &huge, 0), "too big for the saved pixels");
    fos_lcd_loading_rect_t outside = {W - 4, 0, 10, 4};
    CHECK(!fos_lcd_loading_begin(&m, &outside, 0), "off the panel");
    fos_lcd_loading_rect_t empty = {0, 0, 0, 0};
    CHECK(!fos_lcd_loading_begin(&m, &empty, 0), "empty: the style is off");
    CHECK(!m.active, "nothing loading");
    uint16_t *wrote, *restored;
    CHECK(fos_lcd_loading_step(&m, g_fb[0], 500 * MS, &wrote, &restored) == -1, "nothing to do");
}

static void test_a_switch_that_never_lands_stops_by_itself(void)
{
    fos_lcd_loading_t m = fresh();
    paint(2, 6);
    uint16_t before[W * H];
    memcpy(before, g_fb[2], sizeof(before));
    uint16_t *wrote, *restored;
    fos_lcd_loading_begin(&m, &k_rect, 0);
    fos_lcd_loading_step(&m, g_fb[2], 1000 * MS, &wrote, &restored);
    int64_t wait = fos_lcd_loading_step(&m, g_fb[2], (int64_t)FOS_LCD_LOADING_MAX_MS * MS, &wrote, &restored);
    CHECK(wait == -1 && !m.active, "stopped");
    CHECK(restored == g_fb[2] && memcmp(before, g_fb[2], sizeof(before)) == 0, "with the picture back");
}

int main(void)
{
    test_nothing_before_the_delay_then_the_mark_then_the_picture_back();
    test_a_quick_switch_shows_nothing();
    test_the_mark_follows_the_buffer_on_the_glass();
    test_a_switch_during_another_keeps_its_start();
    test_a_rect_it_cannot_hold_is_no_mark();
    test_a_switch_that_never_lands_stops_by_itself();
    if (g_failures) {
        printf("%d of %d checks failed\n", g_failures, g_checks);
        return 1;
    }
    printf("ok: %d checks\n", g_checks);
    return 0;
}
