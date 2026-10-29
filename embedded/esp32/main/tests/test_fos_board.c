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
    const char *e1001 = fos_board_event_map("seeed_reterminal_e1001");
    CHECK(strcmp(e1001, fos_board_event_map("seeed_reterminal_e1002")) == 0, "e1001 = e1002 event map");
    CHECK(strstr(e1004, "\"label\":\"LEFT\",\"action\":\"longPress\"") != NULL, "LEFT held");
    CHECK(strstr(e1004, "\"direction\":\"prev\"") != NULL, "LEFT is prev");
    CHECK(strstr(e1004, "\"label\":\"RIGHT\",\"action\":\"longPress\"") != NULL, "RIGHT held");
    CHECK(strstr(e1004, "\"direction\":\"next\"") != NULL, "RIGHT is next");
    CHECK(strstr(e1004, "\"pin\"") == NULL, "rules name labels, never pins");
    CHECK(e1004[0] == '[' && e1004[strlen(e1004) - 1] == ']', "a JSON list");
    CHECK(strlen(e1004) < 1024, "fits the config slot");
    /* The two with a microphone also talk: REFRESH held is the voice chat
     * (docs/voice-chat.md); the E1004 has no microphone and no such rule. */
    CHECK(strncmp(e1001, e1004, strlen(e1004) - 1) == 0, "e1001 starts with the arrows");
    CHECK(strstr(e1001, "\"label\":\"REFRESH\",\"action\":\"longPress\"},\"emit\":\"voiceChat\"") != NULL,
          "REFRESH held talks on the e1001");
    CHECK(strstr(e1004, "voiceChat") == NULL, "the e1004 has no voice key");
    CHECK(strlen(e1001) < 1024, "fits the config slot");
    /* The E1003 has the E1001's keys and microphone, and a touch screen: the
     * E1001's map, then the edge swipes (docs/scene-switcher.md). */
    const char *e1003 = fos_board_event_map("seeed_reterminal_e1003");
    CHECK(strncmp(e1003, e1001, strlen(e1001) - 1) == 0, "e1003 starts with the e1001 map");
    CHECK(strstr(e1003, "\"edge\":\"right\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"next\"}") != NULL,
          "e1003 right edge is next");
    CHECK(strstr(e1003, "\"edge\":\"left\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"prev\"}") != NULL,
          "e1003 left edge is prev");
    CHECK(strstr(e1003, "\"edge\":\"bottom\"},\"emit\":\"sceneSwitcher\"") != NULL, "e1003 bottom edge is the switcher");
    CHECK(strstr(e1003, "\"edge\":\"top\"},\"emit\":\"sceneSettings\"") != NULL, "e1003 top edge is the settings");
    CHECK(strstr(e1001, "edgeSwipe") == NULL, "the e1001 has no glass");
    CHECK(e1003[strlen(e1003) - 1] == ']' && strlen(e1003) < 1024, "a JSON list that fits");
    /* The Indicator's key: pressed the screen, twice the switcher, held
     * nothing. Its edges swipe the same way. */
    const char *indicator = fos_board_event_map("seeed_sensecap_indicator_d1");
    CHECK(strstr(indicator, "\"action\":\"press\"},\"emit\":\"toggleScreen\"") != NULL,
          "indicator press toggles the screen");
    CHECK(strstr(indicator, "\"action\":\"doublePress\"},\"emit\":\"sceneSwitcher\"") != NULL,
          "indicator double press is the switcher");
    CHECK(strstr(indicator, "longPress") == NULL, "indicator held is nothing");
    CHECK(strstr(indicator, "\"edge\":\"bottom\"},\"emit\":\"sceneSwitcher\",\"as\":{}}") != NULL,
          "indicator bottom edge is the switcher");
    CHECK(strstr(indicator, "\"edge\":\"top\"},\"emit\":\"sceneSettings\",\"as\":{}}]") != NULL,
          "indicator top edge is the settings");
    /* The Sticky: UP and DOWN held walk the scenes, the AI key held talks. */
    const char *sticky = fos_board_event_map("seeed_reterminal_sticky");
    CHECK(strstr(sticky, "\"label\":\"UP\",\"action\":\"longPress\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"prev\"}") != NULL,
          "UP held is prev");
    CHECK(strstr(sticky, "\"label\":\"DOWN\",\"action\":\"longPress\"},\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"next\"}") != NULL,
          "DOWN held is next");
    CHECK(strstr(sticky, "\"label\":\"AI\",\"action\":\"longPress\"},\"emit\":\"voiceChat\"") != NULL, "AI held talks");
    CHECK(sticky[0] == '[' && sticky[strlen(sticky) - 1] == ']' && strlen(sticky) < 1024, "a JSON list that fits");
    /* The Waveshare codec boards: their one user key held talks. */
    CHECK(strstr(fos_board_event_map("waveshare_esp32_s3_photopainter"),
                 "\"label\":\"KEY1\",\"action\":\"longPress\"},\"emit\":\"voiceChat\"") != NULL,
          "PhotoPainter KEY1 held talks");
    CHECK(strstr(fos_board_event_map("waveshare_esp32_s3_epaper_13_3e6"),
                 "\"label\":\"BOOT\",\"action\":\"longPress\"},\"emit\":\"voiceChat\"") != NULL,
          "13.3E6 BOOT held talks");
    CHECK(strstr(fos_board_event_map("waveshare_esp32_s3_photopainter"), "setCurrentScene") == NULL,
          "one key: no scene walking");
    /* A board without bindings, and no board at all: none. */
    CHECK(strcmp(fos_board_event_map("trmnl_og"), "") == 0, "trmnl has no map");
    CHECK(strcmp(fos_board_event_map("elecrow_crowpanel_5in79"), "") == 0, "crowpanel has no map");
    CHECK(strcmp(fos_board_event_map(""), "") == 0, "no preset");
    CHECK(strcmp(fos_board_event_map(NULL), "") == 0, "NULL preset");
}

static void test_buzzer_pins(void)
{
    /* Every reTerminal E-series model has the buzzer on GPIO45. */
    CHECK(fos_board_buzzer_pin("seeed_reterminal_e1001") == 45, "e1001 buzzer");
    CHECK(fos_board_buzzer_pin("seeed_reterminal_e1002") == 45, "e1002 buzzer");
    CHECK(fos_board_buzzer_pin("seeed_reterminal_e1003") == 45, "e1003 buzzer");
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
    CHECK(fos_board_mic_pins("seeed_reterminal_e1003", &clk, &data, &pwr), "e1003 has a microphone");
    CHECK(clk == 42 && data == 41 && pwr == 38, "e1003 mic pins %d/%d/%d", clk, data, pwr);
    /* The E1004 has none: its schematic has no microphone, GPIO41/42 are its
     * J2 UART and GPIO38 its panel reset. Driving a PDM clock on the panel
     * reset would be a very bad surprise. */
    CHECK(!fos_board_mic_pins("seeed_reterminal_e1004", &clk, &data, &pwr), "e1004 has no microphone");
    CHECK(clk == -1 && data == -1 && pwr == -1, "no microphone is -1 everywhere");
    /* The Sticky's MSM261 on the S3's USB pads, powered through GPIO38. */
    CHECK(fos_board_mic_pins("seeed_reterminal_sticky", &clk, &data, &pwr), "sticky has a microphone");
    CHECK(clk == 19 && data == 20 && pwr == 38, "sticky mic pins %d/%d/%d", clk, data, pwr);
    /* The Waveshare boards' microphones are their codec's, not PDM pins:
     * a PDM clock on the PhotoPainter's I2S MCLK would be a mess. */
    CHECK(!fos_board_mic_pins("waveshare_esp32_s3_photopainter", &clk, &data, &pwr), "photopainter: no PDM mic");
    CHECK(!fos_board_mic_pins("waveshare_esp32_s3_epaper_13_3e6", &clk, &data, &pwr), "13.3E6: no PDM mic");
    CHECK(!fos_board_mic_pins("", &clk, &data, &pwr), "no preset, no microphone");
    CHECK(!fos_board_mic_pins(NULL, NULL, NULL, NULL), "NULLs are fine");
    CHECK(fos_board_buzzer_pin(NULL) == -1, "NULL preset, no buzzer");
    CHECK(fos_board_buzzer_tone_hz(NULL) == 0, "NULL preset, no tone");
}

static void test_leds(void)
{
    /* The E-series' green LED: GPIO6 on the E1001/E1002, lit low (Seeed's
     * schematics; the Arduino cookbook's "inverted logic"); GPIO48 on the
     * E1004 behind a transistor, lit HIGH (the bench: typed as inverted it
     * idled lit and blinked dark). */
    int pin = 0, type = 0;
    CHECK(fos_board_led("seeed_reterminal_e1001", &pin, &type), "e1001 has an LED");
    CHECK(pin == 6 && type == 1, "e1001 LED %d/%d", pin, type);
    CHECK(fos_board_led("seeed_reterminal_e1002", &pin, &type), "e1002 has an LED");
    CHECK(pin == 6 && type == 1, "e1002 LED %d/%d", pin, type);
    /* The E1003's on GPIO16 (its TF power switch moved to 39), lit low. */
    CHECK(fos_board_led("seeed_reterminal_e1003", &pin, &type), "e1003 has an LED");
    CHECK(pin == 16 && type == 1, "e1003 LED %d/%d", pin, type);
    CHECK(fos_board_led("seeed_reterminal_e1004", &pin, &type), "e1004 has an LED");
    CHECK(pin == 48 && type == 0, "e1004 LED %d/%d", pin, type);
    /* The Sticky's GPIO48 is its buzzer; a board without a known LED gets
     * none, or the buzzer would be lit. */
    CHECK(!fos_board_led("seeed_reterminal_sticky", &pin, &type), "sticky: no LED");
    CHECK(pin == -1 && type == 0, "no LED is -1 / gpio");
    CHECK(!fos_board_led("", &pin, &type), "no preset, no LED");
    CHECK(!fos_board_led(NULL, NULL, NULL), "NULLs are fine");
}

static void test_i2c_buses(void)
{
    /* The clock and the sensor on 19/20 everywhere; the charger on 39/40 on
     * the E1001/E1002 (E1002 V1.2 schematic) and on 19/20 on the E1004
     * (V1.0 schematic: SY_SDA/SY_SCL are the I2C0 nets), whose 39/40 is the
     * J2 header and is left alone. */
    CHECK(strcmp(fos_board_i2c_buses("seeed_reterminal_e1001"), "sda=19,scl=20;sda=39,scl=40") == 0, "e1001 buses");
    CHECK(strcmp(fos_board_i2c_buses("seeed_reterminal_e1002"), "sda=19,scl=20;sda=39,scl=40") == 0, "e1002 buses");
    CHECK(strcmp(fos_board_i2c_buses("seeed_reterminal_e1004"), "sda=19,scl=20") == 0, "e1004 bus");
    /* The E1003: clock, sensor, charger and its touch controller, all on 19/20. */
    CHECK(strcmp(fos_board_i2c_buses("seeed_reterminal_e1003"), "sda=19,scl=20") == 0, "e1003 bus");
    /* The Waveshare boards' codec chips: the PhotoPainter's on the PMIC's
     * 47/48 (the PMIC driver shares the port), the 13.3E6's on 41/42. */
    CHECK(strcmp(fos_board_i2c_buses("waveshare_esp32_s3_photopainter"), "sda=47,scl=48") == 0, "photopainter bus");
    CHECK(strcmp(fos_board_i2c_buses("waveshare_esp32_s3_epaper_13_3e6"), "sda=41,scl=42") == 0, "13.3E6 bus");
    /* The Sticky's sensor bus: SCL on the GPIO0 strapping pin, SDA GPIO1. */
    CHECK(strcmp(fos_board_i2c_buses("seeed_reterminal_sticky"), "sda=1,scl=0") == 0, "sticky bus");
    CHECK(strcmp(fos_board_i2c_buses("elecrow_crowpanel_5in79"), "") == 0, "crowpanel: none");
    CHECK(strcmp(fos_board_i2c_buses(""), "") == 0, "no preset");
    CHECK(strcmp(fos_board_i2c_buses(NULL), "") == 0, "NULL preset");
}

static void test_sd_pins(void)
{
    /* The Waveshare boards' own SPI3 sockets, as the console preset table
     * always had them. */
    CHECK(strcmp(fos_board_sd_pins("waveshare_esp32_s3_photopainter"), "cs=38,sck=39,miso=40,mosi=41") == 0,
          "photopainter TF");
    CHECK(strcmp(fos_board_sd_pins("waveshare_esp32_s3_epaper_13_3e6"), "cs=15,sck=6,miso=5,mosi=7") == 0,
          "13.3E6 TF");
    /* The E-series socket on the panel's bus: SCK7/MOSI9 are the panel's
     * (fos_assets_sd.c shares the bus on that match), MISO8, CS14, the
     * card-detect on 15 and the power switch on 16. */
    const char *e = "cs=14,sck=7,miso=8,mosi=9,pwr=16,det=15";
    CHECK(strcmp(fos_board_sd_pins("seeed_reterminal_e1001"), e) == 0, "e1001 TF");
    CHECK(strcmp(fos_board_sd_pins("seeed_reterminal_e1002"), e) == 0, "e1002 TF");
    CHECK(strcmp(fos_board_sd_pins("seeed_reterminal_e1004"), e) == 0, "e1004 TF");
    /* The E1003's switch is GPIO39: its GPIO16 is the LED. */
    CHECK(strcmp(fos_board_sd_pins("seeed_reterminal_e1003"), "cs=14,sck=7,miso=8,mosi=9,pwr=39,det=15") == 0,
          "e1003 TF");
    /* The Sticky's, on its panel's SCK13/MOSI14 with its own switch and detect. */
    CHECK(strcmp(fos_board_sd_pins("seeed_reterminal_sticky"), "cs=8,sck=13,miso=12,mosi=14,pwr=10,det=11") == 0,
          "sticky TF");
    /* The X4 shares its bus too but its CS is unpublished: none, as before. */
    CHECK(strcmp(fos_board_sd_pins("xteink_x4"), "") == 0, "x4: none");
    CHECK(strcmp(fos_board_sd_pins("trmnl_og"), "") == 0, "trmnl: none");
    CHECK(strcmp(fos_board_sd_pins(NULL), "") == 0, "NULL preset");
}

static void test_touch_pins(void)
{
    /* The Sticky's GT911 on its own bus, with its interrupt on an RTC IO. */
    CHECK(strcmp(fos_board_touch_pins("seeed_reterminal_sticky"), "sda=3,scl=2,int=21,rst=41,en=42") == 0,
          "sticky touch");
    /* The E1003's GT911 on the clock's 19/20 (fos_i2c.c lends the bus), no
     * load switch. */
    CHECK(strcmp(fos_board_touch_pins("seeed_reterminal_e1003"), "sda=19,scl=20,int=2,rst=48") == 0,
          "e1003 touch");
    /* No other board has a glass: a touch bus on the E1004's panel pins
     * would be a very bad surprise. */
    CHECK(strcmp(fos_board_touch_pins("seeed_reterminal_e1004"), "") == 0, "e1004: no touch");
    CHECK(strcmp(fos_board_touch_pins("waveshare_esp32_s3_photopainter"), "") == 0, "photopainter: no touch");
    CHECK(strcmp(fos_board_touch_pins(""), "") == 0, "no preset");
    /* The Indicator's glass reads both axes the other way; the others match. */
    CHECK(fos_board_touch_mirror("seeed_sensecap_indicator_d1") ==
              (FOS_BOARD_TOUCH_MIRROR_X | FOS_BOARD_TOUCH_MIRROR_Y),
          "indicator touch mirrored");
    CHECK(fos_board_touch_mirror("seeed_reterminal_sticky") == 0, "sticky touch not mirrored");
    CHECK(fos_board_touch_mirror("seeed_reterminal_e1003") == 0, "e1003 touch not mirrored");
    CHECK(fos_board_touch_mirror("") == 0 && fos_board_touch_mirror(NULL) == 0, "no preset: not mirrored");
    CHECK(strcmp(fos_board_touch_pins(NULL), "") == 0, "NULL preset");
}

static void test_codec_pins(void)
{
    /* The PhotoPainter's and the 13.3E6's ES8311 + ES7210 on one I2S bus. */
    CHECK(strcmp(fos_board_codec_pins("waveshare_esp32_s3_photopainter"), "mclk=14,bclk=15,ws=16,din=18,dout=17,pa=7") == 0,
          "photopainter codec");
    CHECK(strcmp(fos_board_codec_pins("waveshare_esp32_s3_epaper_13_3e6"), "mclk=14,bclk=21,ws=47,din=48,dout=45,pa=13") == 0,
          "13.3E6 codec");
    /* The Seeed boards have a buzzer and a PDM microphone, no codec. */
    CHECK(strcmp(fos_board_codec_pins("seeed_reterminal_sticky"), "") == 0, "sticky: no codec");
    CHECK(strcmp(fos_board_codec_pins("seeed_reterminal_e1002"), "") == 0, "e1002: no codec");
    CHECK(strcmp(fos_board_codec_pins(""), "") == 0, "no preset");
    CHECK(strcmp(fos_board_codec_pins(NULL), "") == 0, "NULL preset");
}

int main(void)
{
    test_touch_pins();
    test_codec_pins();
    test_target_names();
    test_module_label();
    test_reservation_policy();
    test_buzzer_pins();
    test_event_maps();
    test_mic_pins();
    test_leds();
    test_i2c_buses();
    test_sd_pins();
    printf("%s: %d checks, %d failures\n", g_failures ? "FAILED" : "ok",
           g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
