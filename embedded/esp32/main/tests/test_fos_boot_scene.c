/*
 * Host tests for which scene a frame starts on (fos_boot_scene.c).
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_boot_scene.c main/tests/test_fos_boot_scene.c \
 *      -o /tmp/test_fos_boot_scene && /tmp/test_fos_boot_scene
 *
 * (backend/app/tasks/tests/test_esp32_boot_scene.py does exactly that in CI.)
 */
#include <stdio.h>

#include "fos_boot_scene.h"

static int checks = 0;
static int failures = 0;

#define CHECK_INT(actual, expected)                                                       \
    do {                                                                                  \
        checks++;                                                                         \
        int a = (actual), e = (expected);                                                 \
        if (a != e) {                                                                     \
            failures++;                                                                   \
            printf("FAIL %s:%d: %s = %d, expected %d\n", __FILE__, __LINE__, #actual, a, e); \
        }                                                                                 \
    } while (0)

static const fos_boot_scene_t LAYOUT_FIRST[] = {
    {"win98", true},
    {"touch", false},
    {"clock", false},
    {"bar", true},
};
#define LAYOUT_FIRST_COUNT 4

static const fos_boot_scene_t ONLY_LAYOUTS[] = {
    {"win98", true},
    {"bar", true},
};

static void test_a_layout_first_in_the_list_is_not_where_a_frame_starts(void)
{
    /* The first frame this bit (2026-11-09): nothing remembered, the layout in slot 0. */
    CHECK_INT(fos_boot_scene_pick(LAYOUT_FIRST, LAYOUT_FIRST_COUNT, "", "touch"), 1);
    CHECK_INT(fos_boot_scene_pick(LAYOUT_FIRST, LAYOUT_FIRST_COUNT, NULL, NULL), 1);
    CHECK_INT(fos_boot_scene_pick(LAYOUT_FIRST, LAYOUT_FIRST_COUNT, "", ""), 1);
}

static void test_the_index_default_wins_over_list_order(void)
{
    CHECK_INT(fos_boot_scene_pick(LAYOUT_FIRST, LAYOUT_FIRST_COUNT, "", "clock"), 2);
}

static void test_a_remembered_scene_wins_over_the_default(void)
{
    CHECK_INT(fos_boot_scene_pick(LAYOUT_FIRST, LAYOUT_FIRST_COUNT, "clock", "touch"), 2);
}

static void test_a_scene_gone_from_the_frame_falls_back_to_the_default(void)
{
    CHECK_INT(fos_boot_scene_pick(LAYOUT_FIRST, LAYOUT_FIRST_COUNT, "deleted", "clock"), 2);
}

static void test_a_remembered_layout_is_ignored(void)
{
    /* An editor's setCurrentScene by id can leave one remembered. */
    CHECK_INT(fos_boot_scene_pick(LAYOUT_FIRST, LAYOUT_FIRST_COUNT, "win98", "clock"), 2);
}

static void test_a_layout_named_default_is_ignored(void)
{
    CHECK_INT(fos_boot_scene_pick(LAYOUT_FIRST, LAYOUT_FIRST_COUNT, "", "win98"), 1);
}

static void test_a_frame_of_layouts_has_nothing_to_start(void)
{
    CHECK_INT(fos_boot_scene_pick(ONLY_LAYOUTS, 2, "", ""), -1);
    CHECK_INT(fos_boot_scene_pick(ONLY_LAYOUTS, 2, "win98", "bar"), -1);
    CHECK_INT(fos_boot_scene_pick(ONLY_LAYOUTS, 0, "", ""), -1);
}

static void test_after_an_out_of_memory_restart_the_next_scene_is_not_a_layout(void)
{
    CHECK_INT(fos_boot_scene_other(LAYOUT_FIRST, LAYOUT_FIRST_COUNT, "touch"), 2);
    CHECK_INT(fos_boot_scene_other(LAYOUT_FIRST, LAYOUT_FIRST_COUNT, "clock"), 1);
}

static void test_a_lone_scene_has_no_alternative(void)
{
    static const fos_boot_scene_t lone[] = {{"bar", true}, {"touch", false}};
    CHECK_INT(fos_boot_scene_other(lone, 2, "touch"), -1);
}

int main(void)
{
    test_a_layout_first_in_the_list_is_not_where_a_frame_starts();
    test_the_index_default_wins_over_list_order();
    test_a_remembered_scene_wins_over_the_default();
    test_a_scene_gone_from_the_frame_falls_back_to_the_default();
    test_a_remembered_layout_is_ignored();
    test_a_layout_named_default_is_ignored();
    test_a_frame_of_layouts_has_nothing_to_start();
    test_after_an_out_of_memory_restart_the_next_scene_is_not_a_layout();
    test_a_lone_scene_has_no_alternative();
    printf("%d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
