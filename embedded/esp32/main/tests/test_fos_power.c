/*
 * Host tests for the pass-start power decision (fos_power.c). No IDF, no
 * mocks: the file is pure arithmetic on purpose, so a laptop compiler can
 * check it.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_power.c main/tests/test_fos_power.c \
 *      -o /tmp/test_fos_power && /tmp/test_fos_power
 *
 * (backend/app/tasks/tests/test_esp32_power.py does exactly that in CI.)
 *
 * The cases replay a real log: a reTerminal E1004 on battery whose
 * pass-start ADC burst read "0 %" seconds before its post-render sample
 * read 3932 mV, and which then sat awake for nine hours because that one
 * reading both parked it in the critical sleep and told it there was no
 * cell to sleep on.
 */
#include <stdio.h>
#include <string.h>

#include "fos_power.h"

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

static fos_power_decision_t decide(fos_power_state_t *state, int mv, bool on_battery_flag)
{
    fos_power_input_t in = {.mv = mv, .deep_sleep = false,
                            .deep_sleep_on_battery = on_battery_flag};
    fos_power_decision_t out;
    fos_power_decide(&in, state, &out);
    return out;
}

static void test_healthy_cell_sleeps_every_pass(void)
{
    fos_power_state_t state;
    memset(&state, 0, sizeof(state));
    const int readings[] = {4164, 4150, 4070, 4052, 4036};
    for (size_t i = 0; i < sizeof(readings) / sizeof(readings[0]); i++) {
        fos_power_decision_t d = decide(&state, readings[i], true);
        CHECK(d.on_battery, "pass %zu: %d mV is a cell", i, readings[i]);
        CHECK(d.deep_sleep, "pass %zu: deep_sleep_on_battery sleeps", i);
        CHECK(!d.critical && !d.suspect, "pass %zu: nothing odd about %d mV", i, readings[i]);
        CHECK(d.mv_used == readings[i], "pass %zu: believed as read", i);
    }
    CHECK(state.last_good_mv == 4036, "state carries the last believed reading");
}

static void test_one_glitch_does_not_switch_deep_sleep_off(void)
{
    /* The 2026-08-27 log: 4036 mV a pass ago, one burst reads far too low. */
    fos_power_state_t state;
    memset(&state, 0, sizeof(state));
    decide(&state, 4036, true);
    fos_power_decision_t d = decide(&state, 1900, true);
    CHECK(d.on_battery, "a cell seen a pass ago is still there through one bad burst");
    CHECK(d.deep_sleep, "...so the pass still deep sleeps");
    CHECK(d.suspect, "...and the log says the reading was disbelieved");
    CHECK(!d.critical, "a disbelieved reading is never critical");
    CHECK(d.mv_used == 4036, "the decision ran on the last believed value");
    /* A reading of exactly 0 (ADC returned nothing) is the same case. */
    fos_power_state_t again;
    memset(&again, 0, sizeof(again));
    decide(&again, 3932, true);
    d = decide(&again, 0, true);
    CHECK(d.on_battery && d.deep_sleep && d.suspect, "an empty read is a glitch too");
}

static void test_two_low_reads_mean_no_cell(void)
{
    fos_power_state_t state;
    memset(&state, 0, sizeof(state));
    decide(&state, 4000, true);
    decide(&state, 100, true);
    fos_power_decision_t d = decide(&state, 100, true);
    CHECK(!d.on_battery, "the second sub-threshold read is believed");
    CHECK(!d.deep_sleep, "deep_sleep_on_battery has nothing to sleep on");
    CHECK(!d.suspect, "nothing was overridden");
    CHECK(state.last_good_mv == 0, "the carried reading is cleared");
    /* The cell comes back: believed immediately (no drop to disbelieve). */
    d = decide(&state, 3900, true);
    CHECK(d.on_battery && d.deep_sleep && !d.suspect, "a returning cell counts at once");
}

static void test_never_seen_a_cell(void)
{
    fos_power_state_t state;
    memset(&state, 0, sizeof(state));
    fos_power_decision_t d = decide(&state, 0, true);
    CHECK(!d.on_battery && !d.deep_sleep && !d.critical && !d.suspect,
          "no sensing, no cell, no sleep, nothing suspect");
    fos_power_input_t always = {.mv = 0, .deep_sleep = true, .deep_sleep_on_battery = false};
    fos_power_decision_t out;
    fos_power_decide(&always, &state, &out);
    CHECK(out.deep_sleep, "deep_sleep=always sleeps without a battery");
}

static void test_critical_needs_two_passes_and_still_sleeps(void)
{
    fos_power_state_t state;
    memset(&state, 0, sizeof(state));
    decide(&state, 3400, true);
    fos_power_decision_t d = decide(&state, 3150, true);
    CHECK(!d.critical, "the first critical read renders normally");
    CHECK(d.suspect, "...but is flagged");
    CHECK(d.deep_sleep, "...and sleeps");
    d = decide(&state, 3120, true);
    CHECK(d.critical, "the second consecutive critical read is believed");
    CHECK(d.on_battery, "a 3.1 V cell is present");
    CHECK(d.deep_sleep, "the critical branch deep sleeps");
    /* Even when the presence test is lost the same pass (a cell so flat it
     * reads below 2.5 V twice), deep_sleep_on_battery still sleeps on
     * critical — the whole point is to stop spending the cell. */
    fos_power_state_t flat;
    memset(&flat, 0, sizeof(flat));
    decide(&flat, 3150, true);
    decide(&flat, 3100, true);
    d = decide(&flat, 3050, true);
    CHECK(d.critical && d.deep_sleep, "a flat cell keeps sleeping");
    /* A recovering reading clears the streak. */
    d = decide(&flat, 3900, true);
    CHECK(!d.critical, "charged again: not critical");
}

static void test_big_drop_is_believed_on_repeat(void)
{
    fos_power_state_t state;
    memset(&state, 0, sizeof(state));
    decide(&state, 4100, true);
    fos_power_decision_t d = decide(&state, 3300, true);
    CHECK(d.suspect && d.mv_used == 4100, "an 0.8 V drop in one pass is doubted first");
    CHECK(d.on_battery && d.deep_sleep, "...without changing the sleep decision");
    d = decide(&state, 3280, true);
    CHECK(!d.suspect && d.mv_used == 3280, "the repeat is believed");
    CHECK(state.last_good_mv == 3280, "and carried forward");
    /* A small drop is never doubted. */
    d = decide(&state, 3260, true);
    CHECK(!d.suspect, "20 mV between passes is ordinary");
}

int main(void)
{
    test_healthy_cell_sleeps_every_pass();
    test_one_glitch_does_not_switch_deep_sleep_off();
    test_two_low_reads_mean_no_cell();
    test_never_seen_a_cell();
    test_critical_needs_two_passes_and_still_sleeps();
    test_big_drop_is_believed_on_repeat();
    printf("%s: %d checks, %d failures\n", g_failures ? "FAILED" : "ok",
           g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
