// `set <key> <value>`: the provisioning plan the backend emits for a Pico
// frame (backend/app/tasks/embedded_firmware.py embedded_provisioning_plan)
// must apply cleanly, key by key, in its order.
#include "pk_config_keys.h"
#include "pk_test.h"

static bool panel_known(const char *panel)
{
    return strcmp(panel, "EPD_7in3e") == 0 || strcmp(panel, "EPD_7in3f") == 0;
}

static pk_set_result_t set(pk_config_t *config, const char *key, const char *value)
{
    char message[128];
    return pk_config_set(config, key, value, panel_known, message, sizeof(message));
}

static void test_backend_plan_applies(void)
{
    pk_config_t config;
    pk_config_defaults(&config);
    CHECK(config.interval_seconds == 300 && config.send_logs == 1 && config.pins.cs == -1);
    CHECK_STR(config.hostname, "frameos");

    // The plan for a pimoroni_inky_frame_7_3_spectra frame, in plan order.
    // The pins line is the ESP32 vocabulary (EMBEDDED_PIN_KEYS) — busy=-1
    // and no sr_* keys, which must survive from the preset.
    static const struct {
        const char *key;
        const char *value;
        pk_set_result_t expect;
    } plan[] = {
        {"hardware", "pimoroni_inky_frame_7_3_spectra", PK_SET_OK},
        {"panel", "EPD_7in3e", PK_SET_OK},
        {"pins", "rst=27,dc=28,cs=17,cs2=-1,busy=-1,sck=18,mosi=19,pwr=-1", PK_SET_OK},
        {"backend", "http://10.4.0.47:8989/", PK_SET_OK},
        {"api_key", "k3y", PK_SET_OK},
        {"frame_id", "42", PK_SET_OK},
        {"hostname", "Frame42", PK_SET_OK},
        {"render_mode", "remote", PK_SET_IGNORED},
        {"interval", "900", PK_SET_OK},
        {"rotate", "90", PK_SET_IGNORED},
        {"scaling_mode", "cover", PK_SET_IGNORED},
        {"server_send_logs", "1", PK_SET_OK},
        {"admin_user", "admin", PK_SET_OK},
        {"admin_pass", "s3cret pass", PK_SET_OK},
        {"admin_auth", "1", PK_SET_OK},
        {"assets_sd", "0", PK_SET_IGNORED},
        {"deep_sleep", "1", PK_SET_OK},
        {"deep_sleep_on_battery", "0", PK_SET_OK},
        {"wake_schedule", "0", PK_SET_IGNORED},
        {"wake_check", "0", PK_SET_IGNORED},
    };
    for (size_t i = 0; i < sizeof(plan) / sizeof(plan[0]); i++) {
        pk_set_result_t result = set(&config, plan[i].key, plan[i].value);
        if (result != plan[i].expect) fprintf(stderr, "plan key %s -> %d\n", plan[i].key, (int)result);
        CHECK(result == plan[i].expect);
    }
    CHECK_STR(config.hardware_preset, "pimoroni_inky_frame_7_3_spectra");
    CHECK_STR(config.panel, "EPD_7in3e");
    CHECK(config.pins.sck == 18 && config.pins.mosi == 19 && config.pins.cs == 17 &&
          config.pins.dc == 28 && config.pins.rst == 27 && config.pins.busy == -1);
    // The Inky wiring the plan does not mention came from the preset.
    CHECK(config.pins.sr_clock == 8 && config.pins.sr_latch == 9 && config.pins.sr_data == 10 &&
          config.pins.busy_bit == 7 && config.pins.hold_vsys == 2);
    CHECK_STR(config.backend_url, "http://10.4.0.47:8989"); // trailing slash dropped
    CHECK(config.frame_id == 42 && config.interval_seconds == 900);
    CHECK_STR(config.hostname, "frame42"); // DNS labels are lowercase
    CHECK(config.admin_auth == 1 && config.deep_sleep == 1 && config.deep_sleep_on_battery == 0);
}

static void test_validation(void)
{
    pk_config_t config;
    pk_config_defaults(&config);
    CHECK(set(&config, "backend", "ftp://nope") == PK_SET_INVALID);
    CHECK(set(&config, "backend", "http://") == PK_SET_INVALID);
    CHECK(set(&config, "backend", "https://frames.example.com") == PK_SET_OK);
    CHECK(set(&config, "frame_id", "abc") == PK_SET_INVALID);
    CHECK(set(&config, "frame_id", "12x") == PK_SET_INVALID);
    CHECK(set(&config, "interval", "5") == PK_SET_OK && config.interval_seconds == PK_INTERVAL_MIN_SECONDS);
    CHECK(set(&config, "interval", "-5") == PK_SET_INVALID);
    CHECK(set(&config, "deep_sleep", "maybe") == PK_SET_INVALID);
    CHECK(set(&config, "deep_sleep", "true") == PK_SET_OK && config.deep_sleep == 1);
    CHECK(set(&config, "panel", "EPD_13in3e") == PK_SET_INVALID); // no driver in this image
    CHECK(set(&config, "panel", "none") == PK_SET_OK);
    CHECK(set(&config, "hostname", "frame.local") == PK_SET_INVALID);
    CHECK(set(&config, "hostname", "-frame") == PK_SET_INVALID);
    CHECK(set(&config, "admin_user", "a:b") == PK_SET_INVALID);
    // The login cannot be switched on without credentials (no open lock-out).
    CHECK(set(&config, "admin_auth", "1") == PK_SET_INVALID);
    CHECK(set(&config, "ap_psk", "short") == PK_SET_INVALID);
    CHECK(set(&config, "ap_psk", "longenough") == PK_SET_OK);
    CHECK(set(&config, "ap_psk", "") == PK_SET_OK); // re-mint on next portal
    // No on-device renderer, no cloud link: say so instead of pretending.
    CHECK(set(&config, "render_mode", "local") == PK_SET_INVALID);
    CHECK(set(&config, "cloud_url", "https://cloud.frameos.net") == PK_SET_INVALID);
    CHECK(set(&config, "claim_token", "FRCT_x") == PK_SET_INVALID);
    CHECK(set(&config, "no_such_key", "1") == PK_SET_UNKNOWN_KEY);

    // A value that does not fit is refused, never truncated into the field.
    char big[PK_URL_LEN + 40];
    memset(big, 'a', sizeof(big) - 1);
    big[sizeof(big) - 1] = '\0';
    memcpy(big, "http://", 7);
    CHECK(set(&config, "backend", big) == PK_SET_INVALID);
    CHECK_STR(config.backend_url, "https://frames.example.com");
    CHECK(set(&config, "wifi_ssid", big) == PK_SET_INVALID);

    // An unknown preset name is kept (a newer backend's label must not fail
    // provisioning) and leaves panel/pins alone.
    pk_pins_t before = config.pins;
    CHECK(set(&config, "hardware", "some_future_board") == PK_SET_OK);
    CHECK_STR(config.hardware_preset, "some_future_board");
    CHECK(memcmp(&before, &config.pins, sizeof(before)) == 0);
}

static void test_pins(void)
{
    pk_pins_t pins = {-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1};
    CHECK(pk_config_parse_pins("sck=10, mosi=11 cs=9,dc=8,rst=12,busy=13", &pins));
    CHECK(pins.sck == 10 && pins.mosi == 11 && pins.cs == 9 && pins.busy == 13 && pins.sr_clock == -1);
    pk_pins_t saved = pins;
    CHECK(!pk_config_parse_pins("sck=48", &pins));      // past the last RP2350B GPIO
    CHECK(!pk_config_parse_pins("sck=-2", &pins));
    CHECK(!pk_config_parse_pins("sck", &pins));
    CHECK(!pk_config_parse_pins("sck=1x", &pins));
    CHECK(!pk_config_parse_pins("clk=1", &pins));
    CHECK(!pk_config_parse_pins("busy_bit=8", &pins));  // a shift register has 8 bits
    CHECK(!pk_config_parse_pins("sck=1,bogus=2", &pins));
    CHECK(memcmp(&saved, &pins, sizeof(pins)) == 0);      // a bad spec changes nothing

    char text[160];
    pk_config_format_pins(&pins, text, sizeof(text));
    pk_pins_t round = {-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1};
    CHECK(pk_config_parse_pins(text, &round));
    CHECK(memcmp(&round, &pins, sizeof(pins)) == 0);
}

static void test_presets(void)
{
    size_t count = 0;
    const pk_preset_t *presets = pk_config_presets(&count);
    CHECK(count == 5);
    for (size_t i = 0; i < count; i++) {
        CHECK(strncmp(presets[i].name, "pimoroni_inky_frame", 19) == 0);
        CHECK(presets[i].pins.hold_vsys == 2); // the power latch, or a battery frame dies at boot
    }
    CHECK(pk_config_find_preset("pimoroni_inky_frame_7_3_spectra") != NULL);
    CHECK_STR(pk_config_find_preset("pimoroni_inky_frame_7_3_spectra")->panel, "EPD_7in3e");
    CHECK(pk_config_find_preset("nope") == NULL);
    CHECK(pk_config_find_preset(NULL) == NULL);
}

int main(void)
{
    test_backend_plan_applies();
    test_validation();
    test_pins();
    test_presets();
    return pk_test_result("test_pk_config_keys");
}
