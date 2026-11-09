/*
 * Host tests for when an e-paper panel takes a partial update
 * (components/frameos_display/fos_partial_refresh.c).
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

static fos_partial_refresh_input_t a_small_change(void)
{
    fos_partial_refresh_input_t input = {
        .supported = true,
        .glass_known = true,
        .same_scene = true,
        .partials_since_full = 0,
        .changed_bytes = 100,
        .total_bytes = 48000,
    };
    return input;
}

static void test_a_small_change_to_the_same_scene_is_partial(void)
{
    fos_partial_refresh_input_t input = a_small_change();
    CHECK(fos_partial_refresh_wanted(&input));
}

static void test_a_panel_without_the_waveform_is_never_partial(void)
{
    fos_partial_refresh_input_t input = a_small_change();
    input.supported = false;
    CHECK(!fos_partial_refresh_wanted(&input));
}

static void test_an_unknown_picture_on_the_glass_is_a_full_refresh(void)
{
    /* The first picture after a boot or a deep sleep. */
    fos_partial_refresh_input_t input = a_small_change();
    input.glass_known = false;
    CHECK(!fos_partial_refresh_wanted(&input));
}

static void test_a_new_scene_starts_from_a_clean_panel(void)
{
    fos_partial_refresh_input_t input = a_small_change();
    input.same_scene = false;
    CHECK(!fos_partial_refresh_wanted(&input));
}

static void test_a_full_refresh_clears_the_ghosts_on_a_schedule(void)
{
    fos_partial_refresh_input_t input = a_small_change();
    input.partials_since_full = FOS_PARTIAL_MAX_BEFORE_FULL - 1;
    CHECK(fos_partial_refresh_wanted(&input));
    input.partials_since_full = FOS_PARTIAL_MAX_BEFORE_FULL;
    CHECK(!fos_partial_refresh_wanted(&input));
}

static void test_the_ghosts_wait_while_someone_is_tapping(void)
{
    fos_partial_refresh_input_t input = a_small_change();
    input.input_recent = true;
    input.partials_since_full = FOS_PARTIAL_MAX_BEFORE_FULL;
    CHECK(fos_partial_refresh_wanted(&input));
    input.partials_since_full = FOS_PARTIAL_MAX_WHILE_INPUT - 1;
    CHECK(fos_partial_refresh_wanted(&input));
    input.partials_since_full = FOS_PARTIAL_MAX_WHILE_INPUT;
    CHECK(!fos_partial_refresh_wanted(&input));
}

static void test_a_picture_that_mostly_changed_is_a_full_refresh(void)
{
    fos_partial_refresh_input_t input = a_small_change();
    input.changed_bytes = 23999;
    CHECK(fos_partial_refresh_wanted(&input));
    input.changed_bytes = 24000;
    CHECK(!fos_partial_refresh_wanted(&input));
}

static void test_changed_bytes_are_counted(void)
{
    const uint8_t a[] = {1, 2, 3, 4};
    const uint8_t b[] = {1, 9, 3, 8};
    CHECK(fos_partial_changed_bytes(a, b, 4) == 2);
    CHECK(fos_partial_changed_bytes(a, a, 4) == 0);
    CHECK(fos_partial_changed_bytes(a, b, 0) == 0);
}

int main(void)
{
    test_a_small_change_to_the_same_scene_is_partial();
    test_a_panel_without_the_waveform_is_never_partial();
    test_an_unknown_picture_on_the_glass_is_a_full_refresh();
    test_a_new_scene_starts_from_a_clean_panel();
    test_a_full_refresh_clears_the_ghosts_on_a_schedule();
    test_the_ghosts_wait_while_someone_is_tapping();
    test_a_picture_that_mostly_changed_is_a_full_refresh();
    test_changed_bytes_are_counted();
    printf("%d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
