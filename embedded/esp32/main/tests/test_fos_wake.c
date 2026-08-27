/*
 * Host tests for the deep-sleep button-wake decisions (fos_wake.c). No IDF,
 * no mocks: the file is pure bit arithmetic on purpose, so a laptop compiler
 * can check it.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_wake.c main/tests/test_fos_wake.c \
 *      -o /tmp/test_fos_wake && /tmp/test_fos_wake
 *
 * (backend/app/tasks/tests/test_esp32_wake.py does exactly that in CI.)
 *
 * The cases come from the boards this ships on: the Seeed reTerminal E10xx
 * keys on GPIO 3/4/5 (all RTC IOs on the S3), the TRMNL OG button on GPIO 2
 * (inside the C3's GPIO0-5 wake window), and the CrowPanel's five keys —
 * plus the two ways arming goes wrong: a pin the chip cannot wake from, and
 * a key still held down at the moment the frame goes to sleep.
 */
#include <stdio.h>

#include "fos_wake.h"

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

/* ESP32-S3: GPIO0-21 are RTC IOs. ESP32-C3: only GPIO0-5 wake from deep sleep. */
#define S3_RTC_MASK ((1ULL << 22) - 1)
#define C3_WAKE_MASK ((1ULL << 6) - 1)
#define BIT_(n) (1ULL << (n))

static void test_arms_every_rtc_capable_button(void)
{
    const int e10xx[] = {3, 4, 5};
    uint64_t skipped = 0xFF;
    uint64_t armed = fos_wake_button_mask(e10xx, 3, S3_RTC_MASK, 0, &skipped);
    CHECK(armed == (BIT_(3) | BIT_(4) | BIT_(5)), "E10xx keys must all arm: got 0x%llx",
          (unsigned long long)armed);
    CHECK(skipped == 0, "nothing skipped on the E10xx: got 0x%llx", (unsigned long long)skipped);

    const int trmnl[] = {2};
    armed = fos_wake_button_mask(trmnl, 1, C3_WAKE_MASK, 0, &skipped);
    CHECK(armed == BIT_(2), "TRMNL GPIO 2 is inside the C3 wake window");
    CHECK(skipped == 0, "C3 GPIO 2 must not be skipped");

    const int crowpanel[] = {2, 1, 4, 5, 6};
    armed = fos_wake_button_mask(crowpanel, 5, S3_RTC_MASK, 0, &skipped);
    CHECK(armed == (BIT_(1) | BIT_(2) | BIT_(4) | BIT_(5) | BIT_(6)),
          "CrowPanel keys all sit on RTC IOs: got 0x%llx", (unsigned long long)armed);
}

static void test_skips_pins_the_chip_cannot_wake_from(void)
{
    /* A button wired to GPIO 38 (an S3 digital-only pad) cannot be a wake
     * source; the frame must still arm the ones that can, and say which it
     * left out so the log explains why that key does nothing while asleep. */
    const int mixed[] = {3, 38};
    uint64_t skipped = 0;
    uint64_t armed = fos_wake_button_mask(mixed, 2, S3_RTC_MASK, 0, &skipped);
    CHECK(armed == BIT_(3), "GPIO 3 arms even when GPIO 38 cannot");
    CHECK(skipped == BIT_(38), "GPIO 38 is reported as skipped: got 0x%llx",
          (unsigned long long)skipped);

    /* C3: GPIO 9 (the BOOT button on many C3 boards) is outside 0-5. */
    const int c3_boot[] = {9};
    armed = fos_wake_button_mask(c3_boot, 1, C3_WAKE_MASK, 0, &skipped);
    CHECK(armed == 0, "C3 GPIO 9 cannot wake the chip");
    CHECK(skipped == BIT_(9), "and is reported as skipped");

    /* Garbage pins (unset slots, a corrupt spec) are neither armed nor
     * reported — there is no bit to report them under. */
    const int garbage[] = {-1, 64, 200};
    armed = fos_wake_button_mask(garbage, 3, S3_RTC_MASK, 0, &skipped);
    CHECK(armed == 0 && skipped == 0, "out-of-range pins are ignored outright");

    CHECK(fos_wake_button_mask(NULL, 0, S3_RTC_MASK, 0, NULL) == 0,
          "no buttons, nothing armed, NULL out pointer tolerated");
}

static void test_held_button_sits_the_sleep_out(void)
{
    /* Any-low wake + a key held at sleep time = an instant wake and a
     * render-sleep-render loop for as long as the finger stays. The held key
     * is skipped for this sleep only; the other keys still work. */
    const int e10xx[] = {3, 4, 5};
    uint64_t skipped = 0;
    uint64_t armed = fos_wake_button_mask(e10xx, 3, S3_RTC_MASK, BIT_(4), &skipped);
    CHECK(armed == (BIT_(3) | BIT_(5)), "held GPIO 4 must not arm: got 0x%llx",
          (unsigned long long)armed);
    CHECK(skipped == BIT_(4), "held GPIO 4 is reported as skipped");

    armed = fos_wake_button_mask(e10xx, 3, S3_RTC_MASK, BIT_(3) | BIT_(4) | BIT_(5), &skipped);
    CHECK(armed == 0, "every key held: nothing armed, the timer alone wakes the frame");
}

static void test_wake_status_maps_back_to_a_button(void)
{
    const int e10xx[] = {3, 4, 5};
    CHECK(fos_wake_button_index(e10xx, 3, BIT_(4)) == 1, "GPIO 4 latched → LEFT (index 1)");
    CHECK(fos_wake_button_index(e10xx, 3, BIT_(5)) == 2, "GPIO 5 latched → RIGHT (index 2)");
    /* Two keys latched at once (a chord, or bounce across the sample): the
     * lowest GPIO wins, deterministically. */
    CHECK(fos_wake_button_index(e10xx, 3, BIT_(5) | BIT_(3)) == 0,
          "a multi-pin status resolves to the lowest configured pin");
    /* Order in the spec must not matter — the CrowPanel lists 2 before 1. */
    const int crowpanel[] = {2, 1, 4, 5, 6};
    CHECK(fos_wake_button_index(crowpanel, 5, BIT_(1) | BIT_(2)) == 1,
          "lowest pin wins regardless of spec order");
    /* A status naming a pin no button owns is not a button wake. */
    CHECK(fos_wake_button_index(e10xx, 3, BIT_(21)) == -1,
          "a foreign pin in the status is not a button");
    CHECK(fos_wake_button_index(e10xx, 3, 0) == -1, "an empty status is not a button");
    CHECK(fos_wake_button_index(NULL, 0, BIT_(3)) == -1, "no buttons configured");
}

int main(void)
{
    test_arms_every_rtc_capable_button();
    test_skips_pins_the_chip_cannot_wake_from();
    test_held_button_sits_the_sleep_out();
    test_wake_status_maps_back_to_a_button();
    printf("%s: %d checks, %d failures\n", g_failures ? "FAILED" : "ok",
           g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
