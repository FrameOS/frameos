/*
 * Host tests for the ADC burst reducer (fos_battery_filter.c). No IDF, no
 * mocks: the file is pure arithmetic on purpose, so a laptop compiler can
 * check it.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_battery_filter.c main/tests/test_fos_battery_filter.c \
 *      -o /tmp/test_fos_battery_filter && /tmp/test_fos_battery_filter
 *
 * (backend/app/tasks/tests/test_esp32_battery_filter.py does exactly that
 * in CI.)
 *
 * The cases replay the two shapes the prod logs show. Raw counts here are
 * the 12-bit ADC's, so a ~4.0 V cell behind a divider of 2 sits near 2640:
 *
 *  - E1002, 2026-08-29..31: 20 of 293 on-battery samples read far below
 *    truth, the lowest 1050 mV against a true ~4018 mV. The ratios (a
 *    quarter, a half, three quarters) say a varying MINORITY of samples came
 *    back near zero and the old mean averaged them in.
 *  - E1004, same window: 44 of 396, and one pass reported 1 % at 16:38
 *    against 74 % fifteen minutes either side — a WHOLE burst low, which is
 *    the divider still charging and which no average can recover.
 */
#include <stdio.h>
#include <string.h>

#include "fos_battery_filter.h"

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

/* The old reducer, kept so the tests can state what changed rather than
 * just asserting the new numbers. */
static int mean_of(const int *v, int n)
{
    int sum = 0;
    for (int i = 0; i < n; i++) sum += v[i];
    return n ? sum / n : -1;
}

static int median_of(const int *v, int n)
{
    int scratch[FOS_BATTERY_ROUND_SAMPLES];
    memcpy(scratch, v, (size_t)n * sizeof(int));
    return fos_battery_median(scratch, n);
}

static void test_median_ignores_a_minority_of_dropouts(void)
{
    /* Nine samples of a ~4018 mV cell, three of which came back at zero:
     * the mean is the fault the prod logs show, the median is not. */
    const int samples[FOS_BATTERY_ROUND_SAMPLES] = {2640, 2642, 0, 2639, 0,
                                                    2641, 2640, 0, 2643};
    CHECK(median_of(samples, 9) == 2640, "the median is the cell, not the dropouts");
    CHECK(mean_of(samples, 9) < 1800, "the mean this replaces was dragged to %d",
          mean_of(samples, 9));
}

static void test_median_survives_a_minority_of_spikes(void)
{
    const int samples[FOS_BATTERY_ROUND_SAMPLES] = {2640, 4095, 2639, 2641, 4095,
                                                    2640, 2642, 2640, 2638};
    CHECK(median_of(samples, 9) == 2640, "a high spike is rejected the same way");
}

static void test_median_of_nothing(void)
{
    int scratch[1] = {0};
    CHECK(fos_battery_median(scratch, 0) == -1, "no samples is not a reading");
    CHECK(fos_battery_median(NULL, 4) == -1, "no buffer is not a reading");
}

static void test_median_of_one_and_of_all_equal(void)
{
    int one[1] = {2640};
    CHECK(fos_battery_median(one, 1) == 2640, "a single sample is its own median");
    int flat[5] = {2640, 2640, 2640, 2640, 2640};
    CHECK(fos_battery_median(flat, 5) == 2640, "a flat round is its own median");
}

static void test_settled_divider_stops_after_two_rounds(void)
{
    fos_battery_burst_t burst;
    fos_battery_burst_reset(&burst);
    CHECK(!fos_battery_burst_add(&burst, 2640), "one round cannot agree with itself");
    CHECK(fos_battery_burst_add(&burst, 2644), "two rounds 4 counts apart have settled");
    CHECK(burst.count == 2, "and the read stops there");
    CHECK(fos_battery_burst_value(&burst) == 2644, "believing the higher of the two");
}

static void test_charging_divider_climbs_and_the_highest_wins(void)
{
    /* The E1004 shape: the first round catches the divider a third of the
     * way up, and it is still climbing a round later. */
    fos_battery_burst_t burst;
    fos_battery_burst_reset(&burst);
    CHECK(!fos_battery_burst_add(&burst, 700), "round 1 is far too low");
    CHECK(!fos_battery_burst_add(&burst, 1800), "round 2 has not settled either");
    CHECK(!fos_battery_burst_add(&burst, 2500), "round 3 still climbing");
    CHECK(fos_battery_burst_add(&burst, 2640), "round 4 is the last one regardless");
    CHECK(fos_battery_burst_value(&burst) == 2640,
          "the believed reading is the top of the ramp, not its mean");
    CHECK(mean_of(burst.rounds, burst.count) < 2000,
          "averaging the ramp would have reported %d",
          mean_of(burst.rounds, burst.count));
}

static void test_a_settled_low_cell_is_still_believed(void)
{
    /* The filter must not invent charge: a genuinely flat cell reads low in
     * every round, and low is the answer. */
    fos_battery_burst_t burst;
    fos_battery_burst_reset(&burst);
    fos_battery_burst_add(&burst, 2050);
    fos_battery_burst_add(&burst, 2048);
    CHECK(fos_battery_burst_value(&burst) == 2050, "a low cell reads low");
}

static void test_dead_rounds_are_not_recorded(void)
{
    fos_battery_burst_t burst;
    fos_battery_burst_reset(&burst);
    CHECK(!fos_battery_burst_add(&burst, -1), "a round with no samples settles nothing");
    CHECK(burst.count == 0, "and is not recorded");
    CHECK(fos_battery_burst_value(&burst) == -1, "a read with no rounds is no reading");
    /* A dead round between two live ones must not make them look adjacent. */
    fos_battery_burst_add(&burst, 2640);
    fos_battery_burst_add(&burst, -1);
    CHECK(burst.count == 1, "still one round");
    CHECK(fos_battery_burst_value(&burst) == 2640, "and the live one stands");
}

static void test_burst_cannot_overrun_its_rounds(void)
{
    fos_battery_burst_t burst;
    fos_battery_burst_reset(&burst);
    /* Never settling: every round differs by more than the tolerance. */
    for (int i = 0; i < FOS_BATTERY_MAX_ROUNDS * 3; i++) {
        int value = 500 + i * (FOS_BATTERY_SETTLED_COUNTS + 50);
        bool stop = fos_battery_burst_add(&burst, value);
        if (i >= FOS_BATTERY_MAX_ROUNDS - 1) {
            CHECK(stop, "a full burst always stops (round %d)", i);
        }
    }
    CHECK(burst.count == FOS_BATTERY_MAX_ROUNDS, "and never records more than it holds");
}

static void test_reset_clears_a_previous_read(void)
{
    fos_battery_burst_t burst;
    fos_battery_burst_reset(&burst);
    fos_battery_burst_add(&burst, 2640);
    fos_battery_burst_reset(&burst);
    CHECK(burst.count == 0, "reset empties the burst");
    CHECK(fos_battery_burst_value(&burst) == -1, "and forgets the old reading");
}

static void test_null_burst_is_survivable(void)
{
    fos_battery_burst_reset(NULL);
    CHECK(!fos_battery_burst_add(NULL, 2640), "no burst settles nothing");
    CHECK(fos_battery_burst_value(NULL) == -1, "and holds no reading");
}

int main(void)
{
    test_median_ignores_a_minority_of_dropouts();
    test_median_survives_a_minority_of_spikes();
    test_median_of_nothing();
    test_median_of_one_and_of_all_equal();
    test_settled_divider_stops_after_two_rounds();
    test_charging_divider_climbs_and_the_highest_wins();
    test_a_settled_low_cell_is_still_believed();
    test_dead_rounds_are_not_recorded();
    test_burst_cannot_overrun_its_rounds();
    test_reset_clears_a_previous_read();
    test_null_burst_is_survivable();
    printf("%s: %d checks, %d failures\n", g_failures ? "FAILED" : "ok",
           g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
