/*
 * Host tests for when an e-paper panel takes a partial update and how worn
 * its glass is (components/frameos_display/fos_partial_refresh.c).
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Icomponents/frameos_display/include \
 *      components/frameos_display/fos_partial_refresh.c main/tests/test_fos_partial_refresh.c \
 *      -o /tmp/test_fos_partial_refresh && /tmp/test_fos_partial_refresh
 *
 * (backend/app/tasks/tests/test_esp32_partial_refresh.py does exactly that in CI.)
 */
#include <stdio.h>
#include <string.h>

#include "fos_partial_refresh.h"

static int checks = 0;
static int failures = 0;

#define CHECK(condition)                                                     \
    do {                                                                     \
        checks++;                                                            \
        if (!(condition)) {                                                  \
            failures++;                                                      \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);      \
        }                                                                    \
    } while (0)

/* The reTerminal Sticky's panel: 800x480, a bit a pixel. */
#define W_BYTES 100
#define H 480
#define LEN (W_BYTES * H)
static uint8_t s_glass[LEN];
static uint8_t s_next[LEN];
static uint16_t s_flips[(W_BYTES / 2) * (H / 16)];

static fos_partial_refresh_input_t a_small_change(void)
{
    fos_partial_refresh_input_t input = {
        .supported = true,
        .glass_known = true,
        .same_scene = true,
        .counted = true,
        .wear = {.tiles = 1500},
        .changed_bytes = 100,
        .total_bytes = LEN,
    };
    return input;
}

/* Inverts a block of whole tiles, `cols` x `rows` of them from (col, row). */
static void invert_tiles(uint8_t *picture, int col, int row, int cols, int rows)
{
    for (int y = row * 16; y < (row + rows) * 16; y++) {
        for (int x = col * 2; x < (col + cols) * 2; x++) picture[y * W_BYTES + x] ^= 0xff;
    }
}

/* One partial update to `s_next`, counted; the glass then shows it. */
static fos_refresh_kind_t update(fos_ghost_t *ghost, bool input_recent)
{
    fos_partial_refresh_input_t input = a_small_change();
    input.input_recent = input_recent;
    input.changed_bytes = fos_ghost_add(ghost, s_glass, s_next);
    fos_ghost_wear(ghost, &input.wear);
    fos_refresh_kind_t kind = fos_partial_refresh_kind(&input);
    if (kind != FOS_REFRESH_PARTIAL) fos_ghost_clear(ghost);
    memcpy(s_glass, s_next, LEN);
    return kind;
}

static void a_clean_glass(fos_ghost_t *ghost)
{
    memset(s_glass, 0xff, LEN);
    memset(s_next, 0xff, LEN);
    fos_ghost_init(ghost, s_flips, W_BYTES, H);
}

static void test_a_small_change_to_the_same_scene_is_partial(void)
{
    fos_partial_refresh_input_t input = a_small_change();
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_PARTIAL);
}

static void test_a_panel_without_the_waveform_is_never_partial(void)
{
    fos_partial_refresh_input_t input = a_small_change();
    input.supported = false;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_FULL_UNSUPPORTED);
}

static void test_an_unknown_picture_on_the_glass_is_a_full_refresh(void)
{
    /* The first picture after a boot or a deep sleep. */
    fos_partial_refresh_input_t input = a_small_change();
    input.glass_known = false;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_FULL_UNSUPPORTED);
}

static void test_a_new_scene_starts_from_a_clean_panel(void)
{
    fos_partial_refresh_input_t input = a_small_change();
    input.same_scene = false;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_FULL_NEW_SCENE);
}

static void test_a_new_scene_someone_switched_to_is_partial(void)
{
    /* The switcher's tile, a swipe: half a second, not a flash. */
    fos_partial_refresh_input_t input = a_small_change();
    input.same_scene = false;
    input.input_recent = true;
    input.changed_bytes = 20000;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_PARTIAL);
    /* Most of the panel changed: a flash all the same. */
    input.changed_bytes = 30000;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_FULL_CHANGED);
}

static void test_a_picture_that_mostly_changed_is_a_full_refresh(void)
{
    fos_partial_refresh_input_t input = a_small_change();
    input.changed_bytes = LEN / 2 - 1;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_PARTIAL);
    input.changed_bytes = LEN / 2;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_FULL_CHANGED);
}

static void test_flips_are_counted_per_tile(void)
{
    fos_ghost_t ghost;
    a_clean_glass(&ghost);
    CHECK(ghost.cols == 50 && ghost.tile_rows == 30);
    CHECK(fos_ghost_tiles(W_BYTES, H) == 1500);
    /* Three pixels of one byte in the second tile across, the first row of
     * tiles; one byte of eight pixels in the tile below it. */
    s_next[5 * W_BYTES + 2] = (uint8_t)~0x07;
    s_next[20 * W_BYTES + 3] = 0x00;
    CHECK(fos_ghost_add(&ghost, s_glass, s_next) == 2);
    CHECK(s_flips[1] == 3);
    CHECK(s_flips[50 + 1] == 8);
    CHECK(s_flips[0] == 0 && s_flips[2] == 0);
    fos_ghost_wear_t wear;
    fos_ghost_wear(&ghost, &wear);
    CHECK(wear.tiles == 1500);
    CHECK(wear.worn == 0);
    CHECK(wear.deepest == 8 * 10 / FOS_GHOST_TILE_PIXELS);
    /* Nothing changed: nothing counted. */
    CHECK(fos_ghost_add(&ghost, s_next, s_next) == 0);
    CHECK(s_flips[1] == 3);
    fos_ghost_clear(&ghost);
    CHECK(s_flips[1] == 0 && s_flips[51] == 0);
}

static void test_a_tile_flipped_whole_is_one_deeper_each_time(void)
{
    fos_ghost_t ghost;
    a_clean_glass(&ghost);
    fos_ghost_wear_t wear;
    for (int i = 1; i <= 3; i++) {
        invert_tiles(s_next, 7, 7, 1, 1);
        fos_ghost_add(&ghost, s_glass, s_next);
        memcpy(s_glass, s_next, LEN);
        fos_ghost_wear(&ghost, &wear);
        CHECK(wear.deepest == (uint32_t)i * 10);
        CHECK(wear.worn == 1);
    }
}

static void test_updates_in_different_places_do_not_add_up(void)
{
    /* A thousand updates, each a key's light somewhere new: no ghosts. The
     * old rule flashed after twenty of them. */
    fos_ghost_t ghost;
    a_clean_glass(&ghost);
    for (int i = 0; i < 1000; i++) {
        invert_tiles(s_next, (i * 7) % 50, (i * 3) % 30, 1, 1);
        CHECK(update(&ghost, false) == FOS_REFRESH_PARTIAL);
        invert_tiles(s_next, (i * 7) % 50, (i * 3) % 30, 1, 1);
        if (update(&ghost, false) != FOS_REFRESH_PARTIAL) {
            /* Every tile gets its turn: deep enough, eventually. */
            CHECK(i >= 200);
            break;
        }
    }
}

static void test_one_place_rewritten_over_and_over_is_due(void)
{
    /* A clock's digit, a highlight walking over the same tiles. */
    fos_ghost_t ghost;
    a_clean_glass(&ghost);
    int partials = 0;
    while (partials < 1000) {
        invert_tiles(s_next, 10, 10, 3, 2);
        if (update(&ghost, false) != FOS_REFRESH_PARTIAL) break;
        partials++;
    }
    CHECK(partials == FOS_GHOST_DEEP / 10 - 1);
}

static void test_a_deep_tile_waits_while_someone_taps(void)
{
    fos_ghost_t ghost;
    a_clean_glass(&ghost);
    int partials = 0;
    while (partials < 1000) {
        invert_tiles(s_next, 10, 10, 3, 2);
        if (update(&ghost, true) != FOS_REFRESH_PARTIAL) break;
        partials++;
    }
    CHECK(partials == 2 * FOS_GHOST_DEEP / 10 - 1);
    /* What is left is due once the tapping stops. */
    fos_ghost_wear_t wear = {.deepest = FOS_GHOST_DEEP, .worn = 6, .tiles = 1500};
    CHECK(fos_ghost_due(&wear));
    wear.deepest = FOS_GHOST_DEEP - 1;
    CHECK(!fos_ghost_due(&wear));
}

static void test_a_worn_quarter_is_due_tapping_or_not(void)
{
    /* A book's page turned: most of the text tiles flip about a fifth of
     * their pixels, and once a quarter of the glass has flipped once over,
     * the next page is a full refresh, tapping or not. */
    fos_partial_refresh_input_t input = a_small_change();
    input.input_recent = true;
    input.wear.deepest = FOS_GHOST_WORN + 10;
    input.wear.worn = 1500 / FOS_GHOST_WORN_SHARE - 1;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_PARTIAL);
    input.wear.worn = 1500 / FOS_GHOST_WORN_SHARE;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_FULL_GHOSTS);
    input.input_recent = false;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_FULL_GHOSTS);
}

static void test_pages_of_text_flash_every_fifth(void)
{
    /* Two thirds of the glass is text, and a page turned flips a fifth of
     * its pixels, in strokes: four pixels of a byte in two (the reTerminal
     * Sticky's ePub reader, 2026-11-24: 0.2 to 0.25 a page in the text, 30%
     * of the bytes): a full refresh every fifth page, as on the Sticky. */
    fos_ghost_t ghost;
    a_clean_glass(&ghost);
    uint32_t seed = 12345;
    int fulls[3] = {0};
    int count = 0;
    for (int page = 1; page <= 20 && count < 3; page++) {
        for (int y = 0; y < H; y++) {
            for (int x = 0; x < W_BYTES * 2 / 3; x++) {
                seed = seed * 1103515245u + 12345u;
                uint32_t pick = (seed >> 16) % 10;
                if (pick < 4) s_next[y * W_BYTES + x] ^= pick < 2 ? 0x0f : 0xf0;
            }
        }
        if (update(&ghost, true) != FOS_REFRESH_PARTIAL) fulls[count++] = page;
    }
    CHECK(count == 3);
    CHECK(fulls[0] == 5);
    CHECK(fulls[1] - fulls[0] == 5);
    CHECK(fulls[2] - fulls[1] == 5);
}

static void test_a_controller_that_keeps_the_picture_counts_updates(void)
{
    /* The IT8951: no copy of the glass, its own GC16 settles. */
    fos_partial_refresh_input_t input = a_small_change();
    input.counted = false;
    input.partials_since_full = FOS_PARTIAL_MAX_BEFORE_FULL - 1;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_PARTIAL);
    input.partials_since_full = FOS_PARTIAL_MAX_BEFORE_FULL;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_FULL_GHOSTS);
    input.input_recent = true;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_PARTIAL);
    input.partials_since_full = FOS_PARTIAL_MAX_WHILE_INPUT;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_FULL_GHOSTS);
}

static void test_a_controller_that_keeps_the_picture_takes_any_change_while_tapping(void)
{
    /* The IT8951: a page turned by a tap goes up as one DU, not a GC16 of the
     * whole panel that flashes; the greys it halftoned settle afterwards. */
    fos_partial_refresh_input_t input = a_small_change();
    input.counted = false;
    input.controller_keeps = true;
    input.input_recent = true;
    input.changed_bytes = input.total_bytes;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_PARTIAL);
    /* A new scene someone switched to, too. */
    input.same_scene = false;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_PARTIAL);
    /* Nobody tapping: half the panel or more is the slow way, as before. */
    input.same_scene = true;
    input.input_recent = false;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_FULL_CHANGED);
    /* Its own count still ends a long session with a full refresh. */
    input.input_recent = true;
    input.partials_since_full = FOS_PARTIAL_MAX_WHILE_INPUT;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_FULL_GHOSTS);
    /* A panel whose glass the display layer copies (the Sticky) keeps the rule. */
    input = a_small_change();
    input.input_recent = true;
    input.changed_bytes = input.total_bytes;
    CHECK(fos_partial_refresh_kind(&input) == FOS_REFRESH_FULL_CHANGED);
}

static void test_a_tile_count_saturates(void)
{
    fos_ghost_t ghost;
    a_clean_glass(&ghost);
    s_flips[0] = UINT16_MAX - 3;
    s_next[0] = 0x00;
    fos_ghost_add(&ghost, s_glass, s_next);
    CHECK(s_flips[0] == UINT16_MAX);
}

int main(void)
{
    test_a_small_change_to_the_same_scene_is_partial();
    test_a_panel_without_the_waveform_is_never_partial();
    test_an_unknown_picture_on_the_glass_is_a_full_refresh();
    test_a_new_scene_starts_from_a_clean_panel();
    test_a_new_scene_someone_switched_to_is_partial();
    test_a_picture_that_mostly_changed_is_a_full_refresh();
    test_flips_are_counted_per_tile();
    test_a_tile_flipped_whole_is_one_deeper_each_time();
    test_updates_in_different_places_do_not_add_up();
    test_one_place_rewritten_over_and_over_is_due();
    test_a_deep_tile_waits_while_someone_taps();
    test_a_worn_quarter_is_due_tapping_or_not();
    test_pages_of_text_flash_every_fifth();
    test_a_controller_that_keeps_the_picture_counts_updates();
    test_a_controller_that_keeps_the_picture_takes_any_change_while_tapping();
    test_a_tile_count_saturates();
    printf("%d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
