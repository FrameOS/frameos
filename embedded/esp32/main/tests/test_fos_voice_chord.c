/*
 * Host tests for the voice chord (fos_voice_chord.c): both keys held half a
 * second start a session, either key let go ends it, and nothing starts again
 * until both keys are up.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_voice_chord.c main/tests/test_fos_voice_chord.c \
 *      -o /tmp/test_fos_voice_chord && /tmp/test_fos_voice_chord
 *
 * (backend/app/tasks/tests/test_esp32_voice_chord.py does exactly that in CI.)
 */
#include <stdio.h>

#include "fos_voice_chord.h"

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

/* Poll at 20 ms from `start_ms` with both keys as given; returns the first
 * event other than NONE, or NONE, and the time it came. */
static fos_voice_chord_event_t hold(fos_voice_chord_t *c, bool left, bool right, int64_t start_ms,
                                    int polls, int64_t *at)
{
    for (int i = 0; i < polls; i++) {
        int64_t now = start_ms + 20 * i;
        fos_voice_chord_event_t event = fos_voice_chord_sample(c, left, right, now);
        if (event != FOS_VOICE_CHORD_NONE) {
            if (at) *at = now;
            return event;
        }
    }
    return FOS_VOICE_CHORD_NONE;
}

static void test_both_held_half_a_second_starts(void)
{
    fos_voice_chord_t c;
    fos_voice_chord_init(&c);
    int64_t at = 0;
    CHECK(hold(&c, true, true, 1000, 100, &at) == FOS_VOICE_CHORD_START, "both held starts");
    CHECK(at == 1000 + FOS_VOICE_CHORD_HOLD_MS, "starts at the hold, got %lld", (long long)at);
    CHECK(fos_voice_chord_claimed(&c), "the keys are claimed from the start");
}

static void test_one_key_is_nothing(void)
{
    fos_voice_chord_t c;
    fos_voice_chord_init(&c);
    CHECK(hold(&c, true, false, 0, 200, NULL) == FOS_VOICE_CHORD_NONE, "left alone is nothing");
    CHECK(hold(&c, false, true, 5000, 200, NULL) == FOS_VOICE_CHORD_NONE, "right alone is nothing");
    CHECK(!fos_voice_chord_claimed(&c), "nothing claimed");
}

static void test_a_release_before_the_hold_is_two_presses(void)
{
    fos_voice_chord_t c;
    fos_voice_chord_init(&c);
    /* Down together for 300 ms, then right lets go. */
    CHECK(hold(&c, true, true, 0, 15, NULL) == FOS_VOICE_CHORD_NONE, "300 ms is not a chord");
    CHECK(fos_voice_chord_sample(&c, true, false, 300) == FOS_VOICE_CHORD_NONE, "an early release is nothing");
    CHECK(!fos_voice_chord_claimed(&c), "the presses are the scene's");
    /* Right comes back down: the hold counts from now, not from the first time. */
    int64_t at = 0;
    CHECK(hold(&c, true, true, 400, 100, &at) == FOS_VOICE_CHORD_START, "a new hold starts");
    CHECK(at == 400 + FOS_VOICE_CHORD_HOLD_MS, "timed from when both went down again, got %lld", (long long)at);
}

static void test_a_release_after_the_start_ends(void)
{
    fos_voice_chord_t c;
    fos_voice_chord_init(&c);
    CHECK(hold(&c, true, true, 0, 100, NULL) == FOS_VOICE_CHORD_START, "starts");
    /* Held for a sentence. */
    CHECK(hold(&c, true, true, 600, 200, NULL) == FOS_VOICE_CHORD_NONE, "holding is quiet");
    CHECK(fos_voice_chord_sample(&c, false, true, 4600) == FOS_VOICE_CHORD_END, "left let go ends");
    CHECK(fos_voice_chord_claimed(&c), "right, still down, stays claimed");
    CHECK(fos_voice_chord_sample(&c, false, true, 4620) == FOS_VOICE_CHORD_NONE, "no second end");
    CHECK(fos_voice_chord_sample(&c, false, false, 4700) == FOS_VOICE_CHORD_NONE, "the last release is quiet");
    CHECK(!fos_voice_chord_claimed(&c), "both up: the keys are the scene's again");
}

static void test_nothing_starts_until_both_are_up(void)
{
    fos_voice_chord_t c;
    fos_voice_chord_init(&c);
    CHECK(hold(&c, true, true, 0, 100, NULL) == FOS_VOICE_CHORD_START, "starts");
    CHECK(fos_voice_chord_sample(&c, true, false, 2000) == FOS_VOICE_CHORD_END, "ends");
    /* Right comes down again while left never let go: not a new chord. */
    CHECK(hold(&c, true, true, 2100, 100, NULL) == FOS_VOICE_CHORD_NONE, "a lingering key starts nothing");
    CHECK(fos_voice_chord_sample(&c, false, false, 4200) == FOS_VOICE_CHORD_NONE, "both up");
    CHECK(hold(&c, true, true, 4300, 100, NULL) == FOS_VOICE_CHORD_START, "then a fresh chord starts");
}

static void test_both_released_at_once_ends_once(void)
{
    fos_voice_chord_t c;
    fos_voice_chord_init(&c);
    CHECK(hold(&c, true, true, 0, 100, NULL) == FOS_VOICE_CHORD_START, "starts");
    CHECK(fos_voice_chord_sample(&c, false, false, 3000) == FOS_VOICE_CHORD_END, "ends");
    CHECK(!fos_voice_chord_claimed(&c), "nothing left to claim");
    CHECK(fos_voice_chord_sample(&c, false, false, 3020) == FOS_VOICE_CHORD_NONE, "quiet after");
}

static void test_held_from_boot_counts_from_the_first_look(void)
{
    /* The button task's first look after a deep-sleep wake finds both keys
     * down: the hold counts from then. */
    fos_voice_chord_t c;
    fos_voice_chord_init(&c);
    int64_t at = 0;
    CHECK(hold(&c, true, true, 750, 100, &at) == FOS_VOICE_CHORD_START, "starts");
    CHECK(at == 750 + FOS_VOICE_CHORD_HOLD_MS, "from the first look, got %lld", (long long)at);
}

int main(void)
{
    test_both_held_half_a_second_starts();
    test_one_key_is_nothing();
    test_a_release_before_the_hold_is_two_presses();
    test_a_release_after_the_start_ends();
    test_nothing_starts_until_both_are_up();
    test_both_released_at_once_ends_once();
    test_held_from_boot_counts_from_the_first_look();
    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
