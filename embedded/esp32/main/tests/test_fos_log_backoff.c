/*
 * Host tests for the log upload's backoff after a backend that did not answer.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Icomponents/frameos_nim/include \
 *      components/frameos_nim/fos_log_backoff.c main/tests/test_fos_log_backoff.c \
 *      -o /tmp/test_fos_log_backoff && /tmp/test_fos_log_backoff
 *
 * (backend/app/tasks/tests/test_esp32_log_backoff.py does exactly that in CI.)
 *
 * What is pinned: a frame that never had a failure posts at once; one that
 * did waits 30 s, then twice as long per failure, never more than 5 min; an
 * answer resets it, so a backend that restarts costs one wait, not a growing
 * one.
 */
#include <stdio.h>

#include "fos_log_backoff.h"

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

static void test_fresh_state_posts_at_once(void)
{
    fos_log_backoff_t backoff = {0};
    CHECK(fos_log_backoff_ready(&backoff, 0));
    CHECK(fos_log_backoff_ready(&backoff, 123456));
    CHECK(fos_log_backoff_ready(NULL, 0));
}

static void test_first_failure_waits_thirty_seconds(void)
{
    fos_log_backoff_t backoff = {0};
    CHECK(fos_log_backoff_failed(&backoff, 10000) == 30000u);
    CHECK(!fos_log_backoff_ready(&backoff, 10000));
    CHECK(!fos_log_backoff_ready(&backoff, 39999));
    CHECK(fos_log_backoff_ready(&backoff, 40000));
    CHECK(fos_log_backoff_ready(&backoff, 90000));
}

static void test_waits_double_up_to_five_minutes(void)
{
    fos_log_backoff_t backoff = {0};
    const uint32_t expected[] = {30000u, 60000u, 120000u, 240000u, 300000u, 300000u, 300000u};
    int64_t now = 1000;
    for (size_t i = 0; i < sizeof(expected) / sizeof(expected[0]); i++) {
        uint32_t delay = fos_log_backoff_failed(&backoff, now);
        CHECK(delay == expected[i]);
        CHECK(!fos_log_backoff_ready(&backoff, now + (int64_t)delay - 1));
        CHECK(fos_log_backoff_ready(&backoff, now + (int64_t)delay));
        now += delay;
    }
}

static void test_an_answer_resets_the_wait(void)
{
    fos_log_backoff_t backoff = {0};
    fos_log_backoff_failed(&backoff, 0);
    fos_log_backoff_failed(&backoff, 30000);
    fos_log_backoff_failed(&backoff, 90000);
    CHECK(backoff.delay_ms == 120000u);
    fos_log_backoff_succeeded(&backoff);
    CHECK(fos_log_backoff_ready(&backoff, 90001));
    CHECK(fos_log_backoff_failed(&backoff, 100000) == 30000u);
    CHECK(fos_log_backoff_ready(&backoff, 130000));
}

static void test_null_is_harmless(void)
{
    CHECK(fos_log_backoff_failed(NULL, 0) == 0);
    fos_log_backoff_succeeded(NULL);
}

int main(void)
{
    test_fresh_state_posts_at_once();
    test_first_failure_waits_thirty_seconds();
    test_waits_double_up_to_five_minutes();
    test_an_answer_resets_the_wait();
    test_null_is_harmless();
    printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
