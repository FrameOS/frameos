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
 * did waits a minute, and every further failure waits a minute again, never
 * longer, so a backend that comes back sees the logs within a minute; an
 * answer clears the wait.
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

static void test_a_failure_waits_a_minute(void)
{
    fos_log_backoff_t backoff = {0};
    CHECK(fos_log_backoff_failed(&backoff, 10000) == 60000u);
    CHECK(!fos_log_backoff_ready(&backoff, 10000));
    CHECK(!fos_log_backoff_ready(&backoff, 69999));
    CHECK(fos_log_backoff_ready(&backoff, 70000));
    CHECK(fos_log_backoff_ready(&backoff, 900000));
}

static void test_the_wait_never_grows(void)
{
    fos_log_backoff_t backoff = {0};
    int64_t now = 1000;
    for (int i = 0; i < 10; i++) {
        CHECK(fos_log_backoff_failed(&backoff, now) == 60000u);
        CHECK(!fos_log_backoff_ready(&backoff, now + 59999));
        CHECK(fos_log_backoff_ready(&backoff, now + 60000));
        now += 60000;
    }
}

static void test_an_answer_clears_the_wait(void)
{
    fos_log_backoff_t backoff = {0};
    fos_log_backoff_failed(&backoff, 0);
    CHECK(!fos_log_backoff_ready(&backoff, 1000));
    fos_log_backoff_succeeded(&backoff);
    CHECK(fos_log_backoff_ready(&backoff, 1000));
    CHECK(fos_log_backoff_failed(&backoff, 2000) == 60000u);
    CHECK(!fos_log_backoff_ready(&backoff, 61999));
    CHECK(fos_log_backoff_ready(&backoff, 62000));
}

static void test_null_is_harmless(void)
{
    CHECK(fos_log_backoff_failed(NULL, 0) == 0);
    fos_log_backoff_succeeded(NULL);
}

int main(void)
{
    test_fresh_state_posts_at_once();
    test_a_failure_waits_a_minute();
    test_the_wait_never_grows();
    test_an_answer_clears_the_wait();
    test_null_is_harmless();
    printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
