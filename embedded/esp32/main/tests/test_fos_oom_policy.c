/*
 * Host tests for whether an out-of-memory abort restarts the frame
 * (fos_oom_policy.h, used by frameos_nim_glue.c).
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Icomponents/frameos_nim/include \
 *      components/frameos_nim/fos_oom_policy.c main/tests/test_fos_oom_policy.c \
 *      -o /tmp/test_fos_oom_policy && /tmp/test_fos_oom_policy
 *
 * (backend/app/tasks/tests/test_esp32_oom_policy.py does exactly that in CI.)
 */
#include <stdio.h>

#include "fos_oom_policy.h"

#define KB ((size_t)1024)
#define MB (KB * KB)

static int checks = 0;
static int failures = 0;

#define CHECK(cond)                                                                    \
    do {                                                                               \
        checks++;                                                                      \
        if (!(cond)) {                                                                 \
            failures++;                                                                \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);                    \
        }                                                                              \
    } while (0)

static void test_baseline_is_the_first_healthy_render(void)
{
    fos_oom_policy_t p = {0};
    fos_oom_policy_healthy(&p, 4882700);
    CHECK(p.baseline == 4882700);
    fos_oom_policy_healthy(&p, 1000);
    CHECK(p.baseline == 4882700);
    CHECK(p.streak == 0);
}

static void test_fragmented_but_not_leaked_does_not_restart(void)
{
    /* The reTerminal E1003's switch storm (2026-11-15): 1.65 MB of a 4.88 MB
     * baseline free, held by live scenes and caches, largest block 328 KB; a
     * scene load did not fit and lost ~100 KB. Not "leaked beyond recovery". */
    fos_oom_policy_t p = {0};
    fos_oom_policy_healthy(&p, 4882700);
    CHECK(!fos_oom_policy_abort(&p, 1754180, 1654180, 335872, 0));
    CHECK(p.streak == 1);
    CHECK(p.leaked == 100000);
}

static void test_one_abort_that_leaks_half_restarts(void)
{
    /* The 13.3" board: one abort took free PSRAM from 8.6 MB to 4.3 MB. */
    fos_oom_policy_t p = {0};
    fos_oom_policy_healthy(&p, 8600 * KB);
    CHECK(fos_oom_policy_abort(&p, 8600 * KB, 4200 * KB, 1900 * KB, 0));
}

static void test_leaks_add_up_across_aborts(void)
{
    fos_oom_policy_t p = {0};
    fos_oom_policy_healthy(&p, 8 * MB);
    CHECK(!fos_oom_policy_abort(&p, 8 * MB, 6 * MB, 4 * MB, 0)); /* 2 MB */
    fos_oom_policy_healthy(&p, 6 * MB);                           /* streak ends, leak stays */
    CHECK(p.streak == 0);
    CHECK(p.leaked == 2 * MB);
    CHECK(!fos_oom_policy_abort(&p, 6 * MB, 4 * MB + 200 * KB, 3 * MB, 0)); /* 3.8 MB: under half */
    fos_oom_policy_healthy(&p, 4 * MB);
    CHECK(fos_oom_policy_abort(&p, 4 * MB, 3 * MB, 3 * MB, 0)); /* 4.8 MB: over half */
}

static void test_an_abort_that_freed_memory_leaks_nothing(void)
{
    /* A load drops the scene it replaces before it aborts: more free after. */
    fos_oom_policy_t p = {0};
    fos_oom_policy_healthy(&p, 4 * MB);
    CHECK(!fos_oom_policy_abort(&p, 1 * MB, 2 * MB, 300 * KB, 0));
    CHECK(p.leaked == 0);
}

static void test_no_baseline_no_leak_rule(void)
{
    fos_oom_policy_t p = {0};
    CHECK(!fos_oom_policy_abort(&p, 8 * MB, 1 * MB, 1 * MB, 0));
}

static void test_canvas_that_cannot_fit_twice_restarts(void)
{
    fos_oom_policy_t p = {0};
    fos_oom_policy_healthy(&p, 8 * MB);
    CHECK(!fos_oom_policy_abort(&p, 5 * MB, 5 * MB, 1 * MB, 2 * MB));
    CHECK(fos_oom_policy_abort(&p, 5 * MB, 5 * MB, 1 * MB, 2 * MB));
}

static void test_a_canvas_in_the_panel_buffer_is_never_impossible(void)
{
    fos_oom_policy_t p = {0};
    fos_oom_policy_healthy(&p, 8 * MB);
    CHECK(!fos_oom_policy_abort(&p, 2 * MB, 2 * MB, 100 * KB, 0));
    CHECK(!fos_oom_policy_abort(&p, 2 * MB, 2 * MB, 100 * KB, 0));
    CHECK(!fos_oom_policy_abort(&p, 2 * MB, 2 * MB, 100 * KB, 0));
}

static void test_four_in_a_row_restart(void)
{
    fos_oom_policy_t p = {0};
    fos_oom_policy_healthy(&p, 8 * MB);
    for (int i = 0; i < FOS_OOM_RESTART_STREAK - 1; i++) {
        CHECK(!fos_oom_policy_abort(&p, 5 * MB, 5 * MB, 4 * MB, 0));
    }
    CHECK(fos_oom_policy_abort(&p, 5 * MB, 5 * MB, 4 * MB, 0));
}

int main(void)
{
    test_baseline_is_the_first_healthy_render();
    test_fragmented_but_not_leaked_does_not_restart();
    test_one_abort_that_leaks_half_restarts();
    test_leaks_add_up_across_aborts();
    test_an_abort_that_freed_memory_leaks_nothing();
    test_no_baseline_no_leak_rule();
    test_canvas_that_cannot_fit_twice_restarts();
    test_a_canvas_in_the_panel_buffer_is_never_impossible();
    test_four_in_a_row_restart();
    printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
