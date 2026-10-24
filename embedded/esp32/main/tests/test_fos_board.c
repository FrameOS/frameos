/*
 * Host tests for the board-identity strings and the framebuffer reservation
 * policy. No IDF, no CMake, no mocks — both files keep their decisions as
 * plain C so a laptop compiler can argue with them.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_board.c main/fos_framebuffer.c main/tests/test_fos_board.c \
 *      -o /tmp/test_fos_board && /tmp/test_fos_board
 *
 * (backend/app/tasks/tests/test_esp32_board.py does exactly that in CI.)
 *
 * Both halves come from one bug report: an XTEINK X4 — an ESP32-C3 thin
 * client — logged `"board":{"target":"esp32-s3"}` and then died with "out of
 * memory for 96000 byte framebuffer". The target was a hardcoded literal, so
 * the log sent its reader looking for a broken S3; the OOM was a C3 asking
 * its fragmented internal heap for 96000 contiguous bytes. The assertions
 * below are what stops either from coming back quietly.
 */
#include <stdio.h>
#include <string.h>

#include "fos_board.h"
#include "fos_framebuffer.h"

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

static void expect_target(const char *idf, const char *want)
{
    const char *got = fos_board_target_name(idf);
    CHECK(strcmp(got, want) == 0, "target(%s) = %s, want %s", idf, got, want);
}

static void test_target_names(void)
{
    /* The two chips FrameOS actually ships: the whole point of the change is
     * that these are no longer the same string. */
    expect_target("esp32c3", "esp32-c3");
    expect_target("esp32s3", "esp32-s3");
    CHECK(strcmp(fos_board_target_name("esp32c3"),
                 fos_board_target_name("esp32s3")) != 0,
          "a C3 and an S3 must not report the same target");

    /* Dashed to match the backend's `platform` keys and the hardware presets,
     * which is what makes a status line comparable to a build config. */
    expect_target("esp32", "esp32");
    expect_target("esp32s2", "esp32-s2");
    expect_target("esp32c2", "esp32-c2");
    expect_target("esp32c5", "esp32-c5");
    expect_target("esp32c6", "esp32-c6");
    expect_target("esp32c61", "esp32-c61");
    expect_target("esp32h2", "esp32-h2");
    expect_target("esp32p4", "esp32-p4");

    /* An unmapped chip stays readable rather than becoming a wrong guess. */
    expect_target("esp32c99", "esp32c99");
    expect_target("", "unknown");
    expect_target(NULL, "unknown");
}

static void test_module_label(void)
{
    /* The preset key is the only field that names the physical board. */
    CHECK(strcmp(fos_board_module("xteink_x4"), "xteink_x4") == 0,
          "a baked-in preset must be reported verbatim");
    /* The generic published binary carries no preset; fall back to the chip
     * rather than to a board nobody flashed. */
    CHECK(strcmp(fos_board_module(""), fos_board_target()) == 0,
          "an empty preset must fall back to the chip");
    CHECK(fos_board_module(NULL) != NULL, "NULL preset must not return NULL");
}

/* The 4.26" 800x480 four-grey panel on the XTEINK X4 — the case that failed. */
#define PANEL_4IN26_BYTES 96000u
/* A C3 at the point in boot where the reservation is taken. */
#define C3_BOOT_FREE 280000u

static void test_reservation_policy(void)
{
    CHECK(fos_framebuffer_should_reserve(PANEL_4IN26_BYTES, 0, C3_BOOT_FREE),
          "a C3 with a whole heap must reserve the 4.26in panel buffer");

    /* PSRAM boards reserve too (out of PSRAM): the E1004's 960 KB packed
     * buffer lost to PSRAM fragmentation after a scene switch. The internal
     * heap floor does not apply to them. */
    CHECK(fos_framebuffer_should_reserve(PANEL_4IN26_BYTES, 8u * 1024 * 1024, C3_BOOT_FREE),
          "a PSRAM board must reserve its panel buffer");
    CHECK(fos_framebuffer_should_reserve(960000, 8u * 1024 * 1024, 1024),
          "a PSRAM board reserves regardless of internal heap");

    /* Reserving must never cost the frame its network stack: a frame that
     * renders but cannot fetch is not better than one that retries. */
    CHECK(!fos_framebuffer_should_reserve(PANEL_4IN26_BYTES, 0,
                                          PANEL_4IN26_BYTES + FOS_FRAMEBUFFER_MIN_HEAP_AFTER_RESERVE - 1),
          "must not reserve when too little heap would survive it");
    CHECK(fos_framebuffer_should_reserve(PANEL_4IN26_BYTES, 0,
                                         PANEL_4IN26_BYTES + FOS_FRAMEBUFFER_MIN_HEAP_AFTER_RESERVE),
          "must reserve at exactly the floor");

    /* Free heap smaller than the buffer: no underflow, just no. */
    CHECK(!fos_framebuffer_should_reserve(PANEL_4IN26_BYTES, 0, 1024),
          "must not reserve more than the heap holds");
    CHECK(!fos_framebuffer_should_reserve(0, 0, C3_BOOT_FREE),
          "a headless board has no panel buffer to reserve");
}

static void test_event_maps(void)
{
    /* Every reTerminal E-series model: the arrows held walk the scene list
     * (docs/events.md "Event map"), by label — the E1004's pins are swapped. */
    const char *e1004 = fos_board_event_map("seeed_reterminal_e1004");
    CHECK(strcmp(fos_board_event_map("seeed_reterminal_e1001"), e1004) == 0, "e1001 event map");
    CHECK(strcmp(fos_board_event_map("seeed_reterminal_e1002"), e1004) == 0, "e1002 event map");
    CHECK(strstr(e1004, "\"label\":\"LEFT\",\"action\":\"longPress\"") != NULL, "LEFT held");
    CHECK(strstr(e1004, "\"direction\":\"prev\"") != NULL, "LEFT is prev");
    CHECK(strstr(e1004, "\"label\":\"RIGHT\",\"action\":\"longPress\"") != NULL, "RIGHT held");
    CHECK(strstr(e1004, "\"direction\":\"next\"") != NULL, "RIGHT is next");
    CHECK(strstr(e1004, "\"pin\"") == NULL, "rules name labels, never pins");
    CHECK(e1004[0] == '[' && e1004[strlen(e1004) - 1] == ']', "a JSON list");
    CHECK(strlen(e1004) < 1024, "fits the config slot");
    /* A board without bindings, and no board at all: none. */
    CHECK(strcmp(fos_board_event_map("seeed_reterminal_sticky"), "") == 0, "sticky has no map");
    CHECK(strcmp(fos_board_event_map("trmnl_og"), "") == 0, "trmnl has no map");
    CHECK(strcmp(fos_board_event_map(""), "") == 0, "no preset");
    CHECK(strcmp(fos_board_event_map(NULL), "") == 0, "NULL preset");
}

static void test_buzzer_pins(void)
{
    /* Every reTerminal E-series model has the buzzer on GPIO45. */
    CHECK(fos_board_buzzer_pin("seeed_reterminal_e1001") == 45, "e1001 buzzer");
    CHECK(fos_board_buzzer_pin("seeed_reterminal_e1002") == 45, "e1002 buzzer");
    CHECK(fos_board_buzzer_pin("seeed_reterminal_e1004") == 45, "e1004 buzzer");
    CHECK(fos_board_buzzer_tone_hz("seeed_reterminal_e1004") == 2000, "e1004 tone");
    /* The Sticky's 4 kHz electromagnetic buzzer, on GPIO48. */
    CHECK(fos_board_buzzer_pin("seeed_reterminal_sticky") == 48, "sticky buzzer");
    CHECK(fos_board_buzzer_tone_hz("seeed_reterminal_sticky") == 4000, "sticky tone");
    /* The Elecrow CrowPanel drives its EPD chip-select on GPIO45 and BUSY on
     * GPIO48: a board without a buzzer must never get one, or a press would
     * toggle a panel line. */
    CHECK(fos_board_buzzer_pin("elecrow_crowpanel_5in79") == -1, "crowpanel has no buzzer");
    CHECK(fos_board_buzzer_tone_hz("elecrow_crowpanel_5in79") == 0, "crowpanel has no tone");
    CHECK(fos_board_buzzer_pin("") == -1, "no preset, no buzzer");
}

static void test_mic_pins(void)
{
    /* The E1001/E1002 carry the MSM261 PDM microphone on 42/41, powered
     * through GPIO38 (docs/voice-chat.md). */
    int clk = 0, data = 0, pwr = 0;
    CHECK(fos_board_mic_pins("seeed_reterminal_e1001", &clk, &data, &pwr), "e1001 has a microphone");
    CHECK(clk == 42 && data == 41 && pwr == 38, "e1001 mic pins %d/%d/%d", clk, data, pwr);
    CHECK(fos_board_mic_pins("seeed_reterminal_e1002", &clk, &data, &pwr), "e1002 has a microphone");
    CHECK(clk == 42 && data == 41 && pwr == 38, "e1002 mic pins %d/%d/%d", clk, data, pwr);
    /* The E1004 has none: its schematic has no microphone, GPIO41/42 are its
     * J2 UART and GPIO38 its panel reset. Driving a PDM clock on the panel
     * reset would be a very bad surprise. */
    CHECK(!fos_board_mic_pins("seeed_reterminal_e1004", &clk, &data, &pwr), "e1004 has no microphone");
    CHECK(clk == -1 && data == -1 && pwr == -1, "no microphone is -1 everywhere");
    CHECK(!fos_board_mic_pins("", &clk, &data, &pwr), "no preset, no microphone");
    CHECK(!fos_board_mic_pins(NULL, NULL, NULL, NULL), "NULLs are fine");
    CHECK(fos_board_buzzer_pin(NULL) == -1, "NULL preset, no buzzer");
    CHECK(fos_board_buzzer_tone_hz(NULL) == 0, "NULL preset, no tone");
}

int main(void)
{
    test_target_names();
    test_module_label();
    test_reservation_policy();
    test_buzzer_pins();
    test_event_maps();
    test_mic_pins();
    printf("%s: %d checks, %d failures\n", g_failures ? "FAILED" : "ok",
           g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
