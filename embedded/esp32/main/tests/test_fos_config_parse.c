/*
 * Host tests for the config parsers (fos_config_parse.c) behind every
 * writer of a setting: the USB console `set`, the backend settings poll and
 * the cloud set_settings verb. No IDF: fos_config.h's esp_err.h comes from
 * main/tests/host_shim/, and the one chip-specific hook
 * (fos_config_gpio_pin_reserved) is defined below.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain -Imain/tests/host_shim \
 *      main/fos_config_parse.c main/tests/test_fos_config_parse.c \
 *      -o /tmp/test_fos_config_parse && /tmp/test_fos_config_parse
 *
 * (.github/workflows/e2e-docker.yml runs exactly that in CI.)
 */
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "fos_config.h"

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

/* The chip table the real one consults; here: an S3-shaped flash window. */
const char *fos_config_gpio_pin_reserved(int pin)
{
    if (pin < 0 || pin > 48) return "not a GPIO on this chip";
    if (pin >= 26 && pin <= 32) return "SPI flash / PSRAM pad";
    if (pin == 43 || pin == 44) return "claimed by a driver";
    return NULL;
}

static fos_pins_t pins_all(int8_t v)
{
    fos_pins_t p = { v, v, v, v, v, v, v, v };
    return p;
}

/* --------------------------------------------------------------------- */

static void test_parse_pins_full_and_subset(void)
{
    fos_pins_t p = pins_all(-1);
    CHECK(fos_config_parse_pins("rst=5,dc=4,cs=3,cs2=-1,busy=6,sck=7,mosi=9,pwr=-1", &p) == ESP_OK,
          "full spec refused");
    CHECK(p.rst == 5 && p.dc == 4 && p.cs == 3 && p.cs2 == -1 && p.busy == 6 && p.sck == 7 &&
          p.mosi == 9 && p.pwr == -1, "full spec misparsed");

    p = pins_all(1);
    CHECK(fos_config_parse_pins("busy=48", &p) == ESP_OK, "subset refused");
    CHECK(p.busy == 48 && p.rst == 1 && p.mosi == 1, "subset touched other pins");

    p = pins_all(1);
    CHECK(fos_config_parse_pins("rst=2, dc=3 ,cs=4", &p) == ESP_OK, "spaces refused");
    CHECK(p.rst == 2 && p.dc == 3 && p.cs == 4, "spaced spec misparsed");

    p = pins_all(1);
    CHECK(fos_config_parse_pins("", &p) == ESP_OK, "empty spec refused");
    CHECK(p.rst == 1, "empty spec touched pins");

    char out[128];
    fos_config_format_pins(&p, out, sizeof(out));
    fos_pins_t q = pins_all(-1);
    CHECK(fos_config_parse_pins(out, &q) == ESP_OK && memcmp(&p, &q, sizeof(p)) == 0,
          "format/parse round trip differs: %s", out);
}

static void test_parse_pins_refusals(void)
{
    fos_pins_t p = pins_all(1);
    CHECK(fos_config_parse_pins("rst", &p) == ESP_ERR_INVALID_ARG, "missing = accepted");
    CHECK(fos_config_parse_pins("rst=5,bogus=1", &p) == ESP_ERR_INVALID_ARG, "unknown key accepted");
    CHECK(fos_config_parse_pins("rst=49", &p) == ESP_ERR_INVALID_ARG, "pin 49 accepted");
    CHECK(fos_config_parse_pins("rst=-2", &p) == ESP_ERR_INVALID_ARG, "pin -2 accepted");
    CHECK(fos_config_parse_pins("RST=5", &p) == ESP_ERR_INVALID_ARG, "upper-case key accepted");
    CHECK(fos_config_parse_pins("rst=abc", &p) == ESP_OK && p.rst == 0,
          "non-numeric value is atoi's 0 (documented)");
    /* Over-long specs are truncated to the buffer rather than overrun. */
    char big[FOS_STR_LEN * 2];
    memset(big, 'a', sizeof(big));
    big[sizeof(big) - 1] = '\0';
    CHECK(fos_config_parse_pins(big, &p) == ESP_ERR_INVALID_ARG, "over-long junk accepted");
}

static void test_parse_assets_sd_pins(void)
{
    fos_assets_sd_config_t sd;
    memset(&sd, 0, sizeof(sd));
    sd.enabled = true;
    sd.max_freq_khz = 1234;
    sd.cs = sd.sck = sd.miso = sd.mosi = -1;
    CHECK(fos_config_parse_assets_sd_pins("cs=38,sck=39,miso=40,mosi=41", &sd) == ESP_OK, "refused");
    CHECK(sd.cs == 38 && sd.sck == 39 && sd.miso == 40 && sd.mosi == 41, "misparsed");
    CHECK(sd.enabled && !sd.autoformat && sd.max_freq_khz == 1234, "touched non-pin fields");
    CHECK(fos_config_parse_assets_sd_pins("rst=5", &sd) == ESP_ERR_INVALID_ARG,
          "display pin key accepted for the SD bus");
    CHECK(fos_config_parse_assets_sd_pins("cs=49", &sd) == ESP_ERR_INVALID_ARG, "pin 49 accepted");
    CHECK(fos_config_parse_assets_sd_pins("cs", &sd) == ESP_ERR_INVALID_ARG, "missing = accepted");
    char out[64];
    fos_config_format_assets_sd_pins(&sd, out, sizeof(out));
    CHECK(strcmp(out, "cs=38,sck=39,miso=40,mosi=41") == 0, "format: %s", out);
}

static void test_normalize_rotate(void)
{
    uint16_t r = 999;
    CHECK(fos_config_normalize_rotate(0, &r) && r == 0, "0");
    CHECK(fos_config_normalize_rotate(90, &r) && r == 90, "90");
    CHECK(fos_config_normalize_rotate(180, &r) && r == 180, "180");
    CHECK(fos_config_normalize_rotate(270, &r) && r == 270, "270");
    CHECK(fos_config_normalize_rotate(360, &r) && r == 0, "360 -> %u", r);
    CHECK(fos_config_normalize_rotate(450, &r) && r == 90, "450 -> %u", r);
    CHECK(fos_config_normalize_rotate(-90, &r) && r == 270, "-90 -> %u", r);
    CHECK(fos_config_normalize_rotate(-270, &r) && r == 90, "-270 -> %u", r);
    CHECK(fos_config_normalize_rotate(90.0, NULL), "NULL out crashed?");

    r = 999;
    CHECK(!fos_config_normalize_rotate(45, &r) && r == 999, "45 accepted / out touched");
    /* Fractional degrees truncate toward zero before the right-angle test
     * (a "90.5" from a lenient JSON writer lands on 90; "90.9" too). */
    CHECK(fos_config_normalize_rotate(90.5, &r) && r == 90, "90.5 -> %u", r);
    CHECK(!fos_config_normalize_rotate(89.5, &r), "89.5 accepted");
    CHECK(!fos_config_normalize_rotate(1, &r), "1 accepted");
    CHECK(!fos_config_normalize_rotate(NAN, &r), "NaN accepted");
    CHECK(!fos_config_normalize_rotate(INFINITY, &r), "inf accepted");
    CHECK(!fos_config_normalize_rotate(-INFINITY, &r), "-inf accepted");
    CHECK(!fos_config_normalize_rotate(1e9, &r), "1e9 accepted");
    CHECK(!fos_config_normalize_rotate(-1e9, &r), "-1e9 accepted");
    /* The magnitude bound is inclusive: 99990 = 277 * 360 + 270 is inside it
     * and a right angle; 100000 is inside it but not one; 100080 (= 278 * 360)
     * is a right angle but outside it. */
    CHECK(fos_config_normalize_rotate(99990, &r) && r == 270, "99990 -> %u", r);
    CHECK(!fos_config_normalize_rotate(100000, &r), "100000 accepted");
    CHECK(!fos_config_normalize_rotate(100080, &r), "100080 accepted");
    CHECK(fos_config_normalize_rotate(-99990, &r) && r == 90, "-99990 -> %u", r);
}

static void test_normalize_scaling_mode(void)
{
    char out[16];
    CHECK(fos_config_normalize_scaling_mode("cover", out, sizeof(out)) && strcmp(out, "cover") == 0, "cover");
    CHECK(fos_config_normalize_scaling_mode("COVER", out, sizeof(out)) && strcmp(out, "cover") == 0,
          "COVER -> %s", out);
    CHECK(fos_config_normalize_scaling_mode("Contain", out, sizeof(out)) && strcmp(out, "contain") == 0,
          "Contain");
    CHECK(fos_config_normalize_scaling_mode("stretch", out, sizeof(out)), "stretch");
    CHECK(fos_config_normalize_scaling_mode("center", out, sizeof(out)), "center");

    strcpy(out, "keep");
    CHECK(!fos_config_normalize_scaling_mode("fill", out, sizeof(out)) && strcmp(out, "keep") == 0,
          "fill accepted / out touched");
    CHECK(!fos_config_normalize_scaling_mode("", out, sizeof(out)), "empty accepted");
    CHECK(!fos_config_normalize_scaling_mode(" cover", out, sizeof(out)), "leading space accepted");
    CHECK(!fos_config_normalize_scaling_mode("cover ", out, sizeof(out)), "trailing space accepted");
    CHECK(!fos_config_normalize_scaling_mode(NULL, out, sizeof(out)), "NULL accepted");
    CHECK(!fos_config_normalize_scaling_mode("cover", NULL, sizeof(out)), "NULL out accepted");
    CHECK(!fos_config_normalize_scaling_mode("cover", out, 0), "zero-length out accepted");
    char tiny[4];
    CHECK(fos_config_normalize_scaling_mode("cover", tiny, sizeof(tiny)) && strcmp(tiny, "cov") == 0,
          "small out not bounded: %s", tiny);
}

static void reset_buttons(fos_config_t *config)
{
    memset(config, 0, sizeof(*config));
    config->gpio_button_count = 2;
    config->gpio_buttons[0].pin = 1;
    strcpy(config->gpio_buttons[0].label, "Old A");
    config->gpio_buttons[1].pin = 2;
    strcpy(config->gpio_buttons[1].label, "Old B");
}

static void test_parse_gpio_buttons(void)
{
    fos_config_t config;
    reset_buttons(&config);
    CHECK(fos_config_parse_gpio_buttons("5:A\n6:B", &config) == ESP_OK, "two buttons refused");
    CHECK(config.gpio_button_count == 2 && config.gpio_buttons[0].pin == 5 &&
          strcmp(config.gpio_buttons[0].label, "A") == 0 && config.gpio_buttons[1].pin == 6 &&
          strcmp(config.gpio_buttons[1].label, "B") == 0, "two buttons misparsed");

    /* Whitespace: leading, around the label, CRLF, blank lines. */
    reset_buttons(&config);
    CHECK(fos_config_parse_gpio_buttons("  5:  Next  \r\n\n\t6:Prev\r\n   \n", &config) == ESP_OK,
          "whitespace refused");
    CHECK(config.gpio_button_count == 2 && strcmp(config.gpio_buttons[0].label, "Next") == 0 &&
          strcmp(config.gpio_buttons[1].label, "Prev") == 0, "whitespace mishandled: \"%s\" / \"%s\"",
          config.gpio_buttons[0].label, config.gpio_buttons[1].label);

    /* An empty label gets a name; the label is bounded. */
    reset_buttons(&config);
    CHECK(fos_config_parse_gpio_buttons("5:", &config) == ESP_OK &&
          strcmp(config.gpio_buttons[0].label, "Button") == 0, "empty label: \"%s\"",
          config.gpio_buttons[0].label);
    char spec[128];
    snprintf(spec, sizeof(spec), "5:%s", "0123456789012345678901234567890123456789");
    CHECK(fos_config_parse_gpio_buttons(spec, &config) == ESP_OK &&
          strlen(config.gpio_buttons[0].label) == FOS_GPIO_BUTTON_LABEL_LEN - 1,
          "label not bounded: %u", (unsigned)strlen(config.gpio_buttons[0].label));

    /* Labels keep their punctuation (a comma once broke the Pi console spec). */
    reset_buttons(&config);
    CHECK(fos_config_parse_gpio_buttons("5:Next, please: now", &config) == ESP_OK &&
          strcmp(config.gpio_buttons[0].label, "Next, please: now") == 0, "punctuated label: \"%s\"",
          config.gpio_buttons[0].label);

    /* Empty / NULL spec clears the buttons. */
    reset_buttons(&config);
    CHECK(fos_config_parse_gpio_buttons("", &config) == ESP_OK && config.gpio_button_count == 0,
          "empty spec kept buttons");
    reset_buttons(&config);
    CHECK(fos_config_parse_gpio_buttons(NULL, &config) == ESP_OK && config.gpio_button_count == 0,
          "NULL spec kept buttons");

    /* More than the maximum: the first FOS_GPIO_BUTTONS_MAX are kept. */
    reset_buttons(&config);
    char many[256] = "";
    for (int i = 0; i < FOS_GPIO_BUTTONS_MAX + 3; i++) {
        char line[16];
        snprintf(line, sizeof(line), "%d:B%d\n", i + 3, i);
        strcat(many, line);
    }
    CHECK(fos_config_parse_gpio_buttons(many, &config) == ESP_OK &&
          config.gpio_button_count == FOS_GPIO_BUTTONS_MAX, "over-max count %u",
          (unsigned)config.gpio_button_count);

    /* Round trip. */
    reset_buttons(&config);
    fos_config_parse_gpio_buttons("5:A\n6:B two", &config);
    char out[FOS_GPIO_BUTTONS_SPEC_LEN];
    fos_config_format_gpio_buttons(&config, out, sizeof(out));
    CHECK(strcmp(out, "5:A\n6:B two") == 0, "format: \"%s\"", out);
    fos_config_t again;
    memset(&again, 0, sizeof(again));
    CHECK(fos_config_parse_gpio_buttons(out, &again) == ESP_OK &&
          again.gpio_button_count == 2 && again.gpio_buttons[0].pin == 5 &&
          strcmp(again.gpio_buttons[0].label, "A") == 0 && again.gpio_buttons[1].pin == 6 &&
          strcmp(again.gpio_buttons[1].label, "B two") == 0, "round trip differs");
}

static void test_parse_gpio_buttons_refusals_leave_config_untouched(void)
{
    static const char *bad[] = {
        "5",            /* no colon */
        "x:A",          /* not a number */
        "5x:A",         /* trailing junk on the pin */
        "49:A",         /* past the GPIO range */
        "-1:A",         /* "none" is not a button */
        "26:A",         /* SPI flash pad (chip table) */
        "43:A",         /* claimed by a driver (chip table) */
        "5:A\n26:B",    /* one bad line poisons the whole spec */
        ":A",           /* empty pin */
    };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        fos_config_t config;
        reset_buttons(&config);
        esp_err_t err = fos_config_parse_gpio_buttons(bad[i], &config);
        CHECK(err == ESP_ERR_INVALID_ARG, "\"%s\" accepted", bad[i]);
        CHECK(config.gpio_button_count == 2 && config.gpio_buttons[0].pin == 1 &&
              strcmp(config.gpio_buttons[1].label, "Old B") == 0, "\"%s\" touched the config", bad[i]);
    }
}

static void test_format_gpio_buttons_is_bounded(void)
{
    fos_config_t config;
    memset(&config, 0, sizeof(config));
    fos_config_parse_gpio_buttons("5:Alpha\n6:Beta", &config);
    char small[8];
    fos_config_format_gpio_buttons(&config, small, sizeof(small));
    CHECK(strlen(small) < sizeof(small), "overrun");
    CHECK(strncmp(small, "5:Alpha", 7) == 0, "truncated form: \"%s\"", small);
    fos_config_format_gpio_buttons(&config, small, 0); /* must not write */
    char empty[8] = "x";
    config.gpio_button_count = 0;
    fos_config_format_gpio_buttons(&config, empty, sizeof(empty));
    CHECK(empty[0] == '\0', "no buttons formatted as \"%s\"", empty);
}

int main(void)
{
    test_parse_pins_full_and_subset();
    test_parse_pins_refusals();
    test_parse_assets_sd_pins();
    test_normalize_rotate();
    test_normalize_scaling_mode();
    test_parse_gpio_buttons();
    test_parse_gpio_buttons_refusals_leave_config_untouched();
    test_format_gpio_buttons_is_bounded();

    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
