/*
 * Host tests for the voice key hold (fos_voice_hold.c): a voice key held a
 * long press starts a session, letting go ends it, a shorter press is
 * nothing, and the claim lasts from the start to the release.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_voice_hold.c main/tests/test_fos_voice_hold.c \
 *      -o /tmp/test_fos_voice_hold && /tmp/test_fos_voice_hold
 *
 * (backend/app/tasks/tests/test_esp32_voice_hold.py does exactly that in CI.)
 */
#include <stdio.h>

#include "fos_voice_hold.h"

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

/* Poll at 20 ms from `start_ms` with the key as given; returns the first
 * event other than NONE, or NONE, and the time it came. */
static fos_voice_hold_event_t hold(fos_voice_hold_t *h, bool down, int64_t start_ms, int polls, int64_t *at)
{
    for (int i = 0; i < polls; i++) {
        int64_t now = start_ms + 20 * i;
        fos_voice_hold_event_t event = fos_voice_hold_sample(h, down, now);
        if (event != FOS_VOICE_HOLD_NONE) {
            if (at) *at = now;
            return event;
        }
    }
    return FOS_VOICE_HOLD_NONE;
}

static void test_held_a_long_press_starts(void)
{
    fos_voice_hold_t h;
    fos_voice_hold_init(&h);
    int64_t at = 0;
    CHECK(!fos_voice_hold_claimed(&h), "nothing claimed before a hold");
    CHECK(hold(&h, true, 1000, 100, &at) == FOS_VOICE_HOLD_START, "held starts");
    CHECK(at == 1000 + FOS_VOICE_HOLD_MS, "starts at the long press, got %lld", (long long)at);
    CHECK(FOS_VOICE_HOLD_MS == FOS_BUTTON_LONG_PRESS_MS, "the hold is the contract's long press");
    CHECK(fos_voice_hold_claimed(&h), "the key is claimed from the start");
}

static void test_a_shorter_press_is_nothing(void)
{
    fos_voice_hold_t h;
    fos_voice_hold_init(&h);
    int64_t t = 5000;
    for (; t < 5000 + FOS_VOICE_HOLD_MS - 20; t += 20) {
        CHECK(fos_voice_hold_sample(&h, true, t) == FOS_VOICE_HOLD_NONE, "down, not long enough yet");
    }
    CHECK(fos_voice_hold_sample(&h, false, t) == FOS_VOICE_HOLD_NONE, "let go before the hold: nothing");
    CHECK(!fos_voice_hold_claimed(&h), "an ordinary press is not claimed");
    /* Down again: the hold counts from the new press, not the old one. */
    CHECK(fos_voice_hold_sample(&h, true, t + 100) == FOS_VOICE_HOLD_NONE, "a new press starts counting");
    int64_t at = 0;
    CHECK(hold(&h, true, t + 120, 100, &at) == FOS_VOICE_HOLD_START, "the new press held starts");
    CHECK(at >= t + 100 + FOS_VOICE_HOLD_MS, "counted from the new press, got %lld", (long long)at);
}

static void test_letting_go_ends_and_releases_the_claim(void)
{
    fos_voice_hold_t h;
    fos_voice_hold_init(&h);
    int64_t at = 0;
    CHECK(hold(&h, true, 0, 100, &at) == FOS_VOICE_HOLD_START, "starts");
    /* Still held: nothing more, still claimed (no hold sounds, no clicks). */
    for (int64_t t = at + 20; t < at + 3000; t += 20) {
        CHECK(fos_voice_hold_sample(&h, true, t) == FOS_VOICE_HOLD_NONE, "held on: nothing");
    }
    CHECK(fos_voice_hold_claimed(&h), "claimed while held");
    CHECK(fos_voice_hold_sample(&h, false, at + 3000) == FOS_VOICE_HOLD_END, "let go: end");
    CHECK(!fos_voice_hold_claimed(&h), "the claim ends with the release");
    CHECK(fos_voice_hold_sample(&h, false, at + 3020) == FOS_VOICE_HOLD_NONE, "up: nothing");
}

static void test_a_second_hold_starts_a_second_session(void)
{
    fos_voice_hold_t h;
    fos_voice_hold_init(&h);
    int64_t at = 0;
    CHECK(hold(&h, true, 0, 100, &at) == FOS_VOICE_HOLD_START, "first starts");
    CHECK(fos_voice_hold_sample(&h, false, at + 500) == FOS_VOICE_HOLD_END, "first ends");
    CHECK(hold(&h, true, at + 600, 100, &at) == FOS_VOICE_HOLD_START, "second starts");
    CHECK(fos_voice_hold_sample(&h, false, at + 100) == FOS_VOICE_HOLD_END, "second ends");
}

static void test_held_since_time_zero(void)
{
    /* The key that woke the chip: down from the reset, so its hold counts
     * from 0 (fos_buttons.c stamps it so). */
    fos_voice_hold_t h;
    fos_voice_hold_init(&h);
    int64_t at = 0;
    CHECK(hold(&h, true, 0, 100, &at) == FOS_VOICE_HOLD_START, "a wake hold starts");
    CHECK(at == FOS_VOICE_HOLD_MS, "at the long press from the reset, got %lld", (long long)at);
}

int main(void)
{
    test_held_a_long_press_starts();
    test_a_shorter_press_is_nothing();
    test_letting_go_ends_and_releases_the_claim();
    test_a_second_hold_starts_a_second_session();
    test_held_since_time_zero();
    printf("%s: %d checks, %d failures\n", g_failures ? "FAILED" : "ok", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
