#include "fos_console.h"

#include <ctype.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include "esp_console.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "cJSON.h"
#include "fos_assets.h"
#include "fos_assets_sd.h"
#include "fos_battery.h"
#include "fos_client.h"
#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_http.h"
#include "fos_mem.h"
#include "fos_ota.h"
#include "fos_scenes.h"
#include "fos_wifi.h"
#include "fos_netguard.h"
#include "frameos_display.h"
#include "frameos_nim.h"

static const char *TAG = "fos_console";

#if CONFIG_ESPTOOLPY_FLASHSIZE_32MB
#define FOS_USB_API_MAX_UPLOAD (4 * 1024 * 1024)
#else
#define FOS_USB_API_MAX_UPLOAD (512 * 1024)
#endif
#define FOS_USB_API_MAX_SCENE_ID 256
#define FOS_USB_API_RAW_CHUNK 384
#define FOS_USB_API_PAYLOAD_TIMEOUT_MS 180000
#define FOS_USB_API_PAYLOAD_READ_CHUNK 2048
#define FOS_CONSOLE_MAX_CMDLINE_LENGTH 512
#define FOS_CONSOLE_TASK_STACK_SIZE 8192

static const char *USB_API_OK = "__FRAMEOS_USB_OK__";
static const char *USB_API_ERROR = "__FRAMEOS_USB_ERROR__";
static const char *USB_API_READY = "__FRAMEOS_USB_READY__";
static const char *USB_API_BEGIN = "__FRAMEOS_USB_BEGIN__";
static const char *USB_API_END = "__FRAMEOS_USB_END__";

static const char *auth_mode_name(wifi_auth_mode_t authmode)
{
    switch (authmode) {
        case WIFI_AUTH_OPEN:
            return "open";
        case WIFI_AUTH_WEP:
            return "wep";
        case WIFI_AUTH_WPA_PSK:
            return "wpa";
        case WIFI_AUTH_WPA2_PSK:
            return "wpa2";
        case WIFI_AUTH_WPA_WPA2_PSK:
            return "wpa/wpa2";
        case WIFI_AUTH_WPA3_PSK:
            return "wpa3";
        case WIFI_AUTH_WPA2_WPA3_PSK:
            return "wpa2/wpa3";
        default:
            return "other";
    }
}

static int cmd_status(int argc, char **argv)
{
    fos_config_t *config = fos_config();
    char pins[FOS_STR_LEN];
    char sd_pins[FOS_STR_LEN];
    fos_config_format_pins(&config->pins, pins, sizeof(pins));
    fos_config_format_assets_sd_pins(&config->assets_sd, sd_pins, sizeof(sd_pins));
    printf("frame_id:    %lu\n", (unsigned long)config->frame_id);
    printf("wifi:        ssid=\"%s\" state=%d ip=%s rssi=%d\n",
           config->wifi_ssid, (int)fos_wifi_state(), fos_wifi_ip(), fos_wifi_rssi());
    printf("backend:     %s\n", config->backend_url[0] ? config->backend_url : "(unset)");
    /* Never print the claim token, access token, or device key. */
    printf("cloud:       %s url=%s claim_token=%s%s%s ws=%s\n",
           fos_cloud_state_name(),
           config->cloud_url[0] ? config->cloud_url : "(unset)",
           config->claim_token[0] ? "(set)" : "(none)",
           fos_cloud_frame_id()[0] ? " frame=" : "",
           fos_cloud_frame_id(),
           fos_cloud_ws_connected() ? "connected" : "off");
    /* The ws_url override, when one is set. It is NOT secret, and it is the
     * one input that decides where the management socket dials — a leftover
     * dev value (ws://localhost:3100/...) makes every attempt fail with an
     * instant TCP reset while enrollment over cloud_url keeps working, which
     * reads as a network fault. Printing it here turns that into a glance.
     * Clear it with `set cloud_wsurl ""`. */
    if (fos_cloud_ws_url()[0]) {
        printf("cloud_ws_url: %s (override; clear with: set cloud_wsurl \"\")\n",
               fos_cloud_ws_url());
    }
    if (fos_cloud_last_error()[0]) {
        printf("cloud_error: %s\n", fos_cloud_last_error());
    }
    /* Whether scene HTTP can currently reach the LAN. Worth a line of its own:
     * when the deny is on, a scene calling a local API fails with a message
     * that looks like a network fault, and this is where that gets explained. */
    printf("net_policy:  scene HTTP to private addresses %s%s\n",
           fos_netguard_policy_active() ? "BLOCKED (cloud-managed)" : "allowed",
           config->allow_local_network ? " [allow_local_network=1]" : "");
    printf("https:       %s port=%u cert=%s key=%s\n",
           config->tls_enable ? "enabled" : "disabled",
           (unsigned)config->tls_port,
           config->tls_server_cert[0] ? "yes" : "no",
           config->tls_server_key[0] ? "yes" : "no");
    printf("admin_auth:  %s user=%s\n",
           (config->admin_auth_enabled && config->admin_user[0] && config->admin_pass[0]) ? "enabled" : "disabled",
           config->admin_user[0] ? config->admin_user : "(unset)");
    printf("hardware:    %s\n", config->hardware_preset[0] ? config->hardware_preset : "(custom)");
    printf("panel:       %s (%dx%d)\n", config->panel, fos_display_width(), fos_display_height());
    printf("pins:        %s\n", pins);
    if (config->gpio_button_count > 0) {
        printf("buttons:     ");
        for (size_t i = 0; i < config->gpio_button_count; i++) {
            printf("%s%d:%s", i ? "," : "", config->gpio_buttons[i].pin,
                   config->gpio_buttons[i].label);
        }
        printf("\n");
    } else {
        printf("buttons:     (none configured)\n");
    }
    printf("render_mode: %s\n", config->render_mode == FOS_RENDER_LOCAL ? "local" : "remote");
    printf("rotate:      %u\n", (unsigned)config->rotate);
    printf("scaling_mode: %s\n", config->scaling_mode);
    printf("send_logs:   %d\n", (int)config->server_send_logs);
    printf("debug:       %d\n", (int)config->debug_logging);
    printf("fusion:      %d\n", (int)config->image_fusion);
    printf("assets:      path=%s sd=%d mounted=%d pins=%s freq=%lu kHz autoformat=%d\n",
           config->assets_path, (int)config->assets_sd.enabled,
           (int)fos_assets_sd_mounted(), sd_pins,
           (unsigned long)config->assets_sd.max_freq_khz,
           (int)config->assets_sd.autoformat);
    if (fos_assets_sd_last_error()[0]) {
        printf("sd_error:    %s\n", fos_assets_sd_last_error());
    }
    printf("interval:    %lu s, deep_sleep=%d, wake_schedule=%d\n",
           (unsigned long)config->interval_sec, (int)config->deep_sleep,
           (int)config->wake_schedule);
    if (fos_battery_present()) {
        printf("battery:     %d mV (%d%%) on GPIO %d, divider %.2f\n",
               fos_battery_millivolts(), fos_battery_percent(),
               (int)config->battery_pin, config->battery_divider);
    } else {
        printf("battery:     not configured\n");
    }
    printf("nim:         %s\n", frameos_nim_info());
    printf("renders:     %lu (last %lld ms)\n",
           (unsigned long)fos_client_render_count(), fos_client_last_render_ms());
    /* Internal RAM is the scarce one and the largest BLOCK is what decides
     * whether TLS can start, so both are printed. The cloud link needs
     * ~48 KB free with a 16 KB block (FOS_CLOUD_WS_MIN_INTERNAL_* in
     * fos_cloud.c); below that `cloud_error:` above says so outright. */
    size_t internal_free = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    size_t internal_block =
        heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    printf("heap:        internal %u free (%u largest block)%s, psram %u free\n",
           (unsigned)internal_free, (unsigned)internal_block,
           (internal_free < 48 * 1024 || internal_block < 16 * 1024)
               ? " — TOO LOW for the cloud link (needs 49152 free / 16384 block)"
               : "",
           (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    return 0;
}

/* Block-level heap truth, for when the totals in `status` are not enough.
 *
 * "psram 3856 free" says a frame is out of memory but not what took it, and
 * guessing from totals wastes hours. This prints ESP-IDF's per-region
 * breakdown (largest free block, minimum-ever free, allocation counts) for
 * both pools, which is what distinguishes exhaustion from fragmentation and
 * a leak from a big legitimate buffer. */
static int cmd_heapinfo(int argc, char **argv)
{
    (void)argc; (void)argv;
    printf("--- internal (MALLOC_CAP_INTERNAL)\n");
    printf("free=%u largest=%u min_ever_free=%u\n",
           (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
           (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
           (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
    printf("--- psram (MALLOC_CAP_SPIRAM)\n");
    printf("total=%u free=%u largest=%u min_ever_free=%u\n",
           (unsigned)heap_caps_get_total_size(MALLOC_CAP_SPIRAM),
           (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
           (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM),
           (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_SPIRAM));
    printf("--- per-region detail\n");
    heap_caps_print_heap_info(MALLOC_CAP_SPIRAM);
    heap_caps_print_heap_info(MALLOC_CAP_INTERNAL);
    return 0;
}

/* Which GPIOs are wired to buttons, what they read right now, and — with
 * `buttons watch` — which pin actually moves when someone presses one.
 *
 * A frame whose buttons "do nothing" gives no clue why: the configured pins
 * are invisible in `status`, and fos_buttons logs its wiring at INFO, which
 * the console's WARN level hides. The usual cause is simply that the board's
 * button is not on the GPIO its hardware preset assumes — boards get
 * relabelled and DIY builds differ — and that is a question only the board
 * can answer.
 *
 * `watch` polls a curated safe list. Pins driving the panel, the SD card, USB
 * and the SPI flash/PSRAM are skipped: reconfiguring those as inputs
 * mid-flight would break the very frame being debugged. */
static bool console_pin_in_use(const fos_config_t *config, int pin)
{
    const int used[] = {
        config->pins.rst, config->pins.dc, config->pins.cs, config->pins.cs2,
        config->pins.busy, config->pins.sck, config->pins.mosi, config->pins.pwr,
        config->assets_sd.cs, config->assets_sd.sck,
        config->assets_sd.miso, config->assets_sd.mosi,
        19, 20, /* USB D-/D+ (the console itself) */
        /* 26-32 SPI flash, 33-37 octal PSRAM. On an S3 module with octal
         * PSRAM (CONFIG_SPIRAM_MODE_OCT) 33-37 carry the memory bus, and
         * reconfiguring them as inputs takes the running system's RAM away
         * mid-instruction: the first attempt at this scan reset the board
         * with TG1WDT_SYS_RST. Both ranges are excluded unconditionally —
         * quad-PSRAM parts simply lose a few candidate pins, which is a
         * cheap price for a diagnostic that cannot crash the frame it is
         * diagnosing. */
        26, 27, 28, 29, 30, 31, 32,
        33, 34, 35, 36, 37
    };
    for (size_t i = 0; i < sizeof(used) / sizeof(used[0]); i++) {
        if (used[i] == pin) return true;
    }
    return false;
}

static int cmd_buttons(int argc, char **argv)
{
    fos_config_t *config = fos_config();
    printf("configured buttons: %u\n", (unsigned)config->gpio_button_count);
    for (size_t i = 0; i < config->gpio_button_count; i++) {
        const fos_gpio_button_t *b = &config->gpio_buttons[i];
        printf("  GPIO %-2d %-16s level=%d\n", b->pin, b->label, gpio_get_level(b->pin));
    }
    if (config->gpio_button_count == 0) {
        printf("  (none — set them with: set gpio_buttons \"0:BOOT\\n4:KEY1\")\n");
    }
    if (argc < 2 || strcmp(argv[1], "watch") != 0) {
        printf("press a button and run `buttons watch` to find which GPIO it is\n");
        return 0;
    }

    int seconds = argc > 2 ? atoi(argv[2]) : 10;
    if (seconds < 1) seconds = 1;
    if (seconds > 60) seconds = 60;

    /* Deliberately conservative: no flash/PSRAM pins, no USB, nothing the
     * panel or SD card is using. A button on an excluded pin is reported as
     * "not found" rather than risking the board. */
    static const int candidates[] = {0, 1, 2, 3, 4, 5, 6, 7, 14, 15, 16, 17, 18,
                                     21, 42, 43, 44, 45, 46, 47, 48};
    int levels[sizeof(candidates) / sizeof(candidates[0])];
    size_t count = 0;
    int watched[sizeof(candidates) / sizeof(candidates[0])];
    for (size_t i = 0; i < sizeof(candidates) / sizeof(candidates[0]); i++) {
        int pin = candidates[i];
        if (console_pin_in_use(config, pin)) continue;
        gpio_config_t gpio = {
            .pin_bit_mask = 1ULL << pin,
            .mode = GPIO_MODE_INPUT,
            .pull_up_en = GPIO_PULLUP_ENABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        if (gpio_config(&gpio) != ESP_OK) continue;
        watched[count] = pin;
        levels[count] = gpio_get_level(pin);
        count++;
    }
    printf("watching %u pins for %d s — press the button now\n", (unsigned)count, seconds);
    int64_t end_us = esp_timer_get_time() + (int64_t)seconds * 1000000;
    int changes = 0;
    while (esp_timer_get_time() < end_us) {
        for (size_t i = 0; i < count; i++) {
            int level = gpio_get_level(watched[i]);
            if (level != levels[i]) {
                printf("  GPIO %-2d %d -> %d\n", watched[i], levels[i], level);
                levels[i] = level;
                changes++;
            }
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    if (changes == 0) {
        printf("no pin changed. The button may be on a skipped pin (panel/SD/USB/flash), "
               "wired to a port expander, or not connected to a GPIO at all.\n");
    } else {
        printf("done — set the pin with: set gpio_buttons \"<pin>:KEY1\"\n");
    }
    return 0;
}

static int cmd_set(int argc, char **argv)
{
    if (argc < 3) {
        printf("usage: set <wifi_ssid|wifi_pass|backend|api_key|cloud_url|claim_token|frame_id|"
               "cloud_wsurl|hardware|panel|render_mode|rotate|scaling_mode|"
               "interval|spill_force|debug|fusion|server_send_logs|allow_local_network|"
               "assets_path|assets_sd|assets_sd_pins|assets_sd_freq|"
               "assets_sd_autoformat|"
               "deep_sleep|wake_schedule|battery_pin|battery_divider|pins|gpio_buttons> <value...>\n");
        return 1;
    }
    fos_config_t *config = fos_config();
    const char *key = argv[1];
    /* join remaining args so values may contain spaces */
    char value[FOS_URL_LEN] = "";
    for (int i = 2; i < argc; i++) {
        if (i > 2) strlcat(value, " ", sizeof(value));
        strlcat(value, argv[i], sizeof(value));
    }

    if (strcmp(key, "wifi_ssid") == 0) strlcpy(config->wifi_ssid, value, sizeof(config->wifi_ssid));
    else if (strcmp(key, "wifi_pass") == 0) strlcpy(config->wifi_pass, value, sizeof(config->wifi_pass));
    else if (strcmp(key, "backend") == 0) strlcpy(config->backend_url, value, sizeof(config->backend_url));
    else if (strcmp(key, "api_key") == 0) strlcpy(config->api_key, value, sizeof(config->api_key));
    /* Cloud-frame provisioning (browser flasher / manual): the enrollment
     * task picks these up once Wi-Fi is connected. The claim token is single
     * use and never echoed back — check `status` for the enrollment state. */
    else if (strcmp(key, "cloud_url") == 0) {
        /* Refuse a provider URL the enrollment/WS paths would not use anyway:
         * the claim token, the bearer token and every scene push ride this
         * link, so plain http:// is only accepted for local development hosts
         * (docs/cloud-link.md). Rejecting here means the mistake surfaces at
         * provisioning time instead of as a silent non-enrolling frame. */
        const char *why = NULL;
        if (value[0] && !fos_cloud_url_transport_ok(value, &why)) {
            printf("refusing cloud_url: %s\n", why ? why : "invalid URL");
            return 1;
        }
        strlcpy(config->cloud_url, value, sizeof(config->cloud_url));
    }
    else if (strcmp(key, "cloud_wsurl") == 0) {
        /* Only ever cleared from here. The value itself is set by enrollment
         * (dev providers whose hub is a separate port); typing one in by hand
         * is how a frame ends up dialing somewhere the provider never named.
         * `set cloud_wsurl ""` is the escape hatch for a stale one. */
        if (value[0]) {
            printf("cloud_wsurl is set by enrollment; only clearing is supported "
                   "(set cloud_wsurl \"\")\n");
            return 1;
        }
        fos_cloud_clear_ws_url();
        printf("cloud_wsurl cleared; dialing cloud_url + ws_path from now on\n");
        return 0;
    }
    else if (strcmp(key, "claim_token") == 0) strlcpy(config->claim_token, value, sizeof(config->claim_token));
    else if (strcmp(key, "frame_id") == 0) config->frame_id = strtoul(value, NULL, 10);
    else if (strcmp(key, "hardware") == 0 || strcmp(key, "hardware_preset") == 0) {
        /* Integrated boards are bundles, not just labels: the preset implies
         * the panel, the EPD wiring, the buttons and the TF socket. Apply the
         * known ones here so one `set hardware` provisions the whole board —
         * keep the table in sync with EMBEDDED_HARDWARE_PRESETS in
         * backend/app/tasks/embedded_firmware.py. Unknown names are stored
         * as-is (labels from newer backends must not brick provisioning). */
        static const struct {
            const char *name;
            const char *panel;
            const char *pins;
            const char *gpio_buttons;
            const char *assets_sd_pins; /* empty = board has no usable TF socket */
        } presets[] = {
            { "waveshare_esp32_s3_photopainter", "EPD_7in3e",
              "rst=12,dc=8,cs=9,cs2=-1,busy=13,sck=10,mosi=11,pwr=-1",
              "0:BOOT\n4:KEY1",
              "cs=38,sck=39,miso=40,mosi=41" },
            { "waveshare_esp32_s3_epaper_13_3e6", "EPD_13in3e",
              "rst=2,dc=11,cs=10,cs2=3,busy=12,sck=9,mosi=46,pwr=1",
              "",
              "cs=15,sck=6,miso=5,mosi=7" },
            /* TRMNL OG / BWRY (ESP32-C3 firmware). */
            { "trmnl_og", "EPD_7in5_V2",
              "rst=10,dc=5,cs=6,cs2=-1,busy=4,sck=7,mosi=8,pwr=-1",
              "2:BUTTON",
              "" },
            { "trmnl_bwry", "EPD_7in5yr",
              "rst=10,dc=5,cs=6,cs2=-1,busy=4,sck=7,mosi=8,pwr=-1",
              "2:BUTTON",
              "" },
            /* Seeed XIAO ePaper Driver Board (TRMNL DIY kits, XIAO ESP32-S3). */
            { "trmnl_og_diy_kit", "EPD_7in5_V2",
              "rst=38,dc=10,cs=44,cs2=-1,busy=4,sck=7,mosi=9,pwr=-1",
              "0:BOOT\n5:KEY3",
              "" },
            { "trmnl_4in26_diy_kit", "EPD_4in26",
              "rst=38,dc=10,cs=44,cs2=-1,busy=4,sck=7,mosi=9,pwr=-1",
              "0:BOOT\n2:KEY1",
              "" },
            /* XTEINK X4 (ESP32-C3 firmware). TF socket shares the EPD SPI bus,
             * so SD assets stay off. */
            { "xteink_x4", "EPD_4in26",
              "rst=5,dc=4,cs=21,cs2=-1,busy=6,sck=8,mosi=10,pwr=-1",
              "3:POWER",
              "" },
            /* Seeed reTerminal Sticky (ESP32-S3R8, 32MB flash). */
            { "seeed_reterminal_sticky", "EPD_3in97",
              "rst=17,dc=16,cs=15,cs2=-1,busy=18,sck=13,mosi=14,pwr=-1",
              "4:POWER",
              "" },
            /* Seeed reTerminal E1001 (7.5" mono) / E1002 (7.3" Spectra 6):
             * same EPD wiring on both. SD pins unconfirmed, assets off. */
            { "seeed_reterminal_e1001", "EPD_7in5_V2",
              "rst=12,dc=11,cs=10,cs2=-1,busy=13,sck=7,mosi=9,pwr=-1",
              "3:REFRESH\n4:LEFT\n5:RIGHT",
              "" },
            { "seeed_reterminal_e1002", "EPD_7in3e",
              "rst=12,dc=11,cs=10,cs2=-1,busy=13,sck=7,mosi=9,pwr=-1",
              "3:REFRESH\n4:LEFT\n5:RIGHT",
              "" },
            /* Elecrow CrowPanel 5.79" (ESP32-S3-WROOM-1-N8R8). */
            { "elecrow_crowpanel_5in79", "EPD_5in79",
              "rst=47,dc=46,cs=45,cs2=-1,busy=48,sck=12,mosi=11,pwr=-1",
              "2:HOME\n1:EXIT\n4:NEXT\n5:OK\n6:PREV",
              "" },
        };
        strlcpy(config->hardware_preset, value, sizeof(config->hardware_preset));
        for (size_t i = 0; i < sizeof(presets) / sizeof(presets[0]); i++) {
            if (strcmp(value, presets[i].name) != 0) continue;
            strlcpy(config->panel, presets[i].panel, sizeof(config->panel));
            if (fos_config_parse_pins(presets[i].pins, &config->pins) != ESP_OK ||
                fos_config_parse_gpio_buttons(presets[i].gpio_buttons, config) != ESP_OK ||
                fos_config_parse_assets_sd_pins(presets[i].assets_sd_pins, &config->assets_sd) != ESP_OK) {
                printf("internal error applying preset %s\n", presets[i].name);
                return 1;
            }
            config->assets_sd.enabled = presets[i].assets_sd_pins[0] != '\0';
            printf("applied %s: panel=%s pins=%s buttons=%u sd_pins=%s\n",
                   presets[i].name, presets[i].panel, presets[i].pins,
                   (unsigned)config->gpio_button_count,
                   presets[i].assets_sd_pins[0] ? presets[i].assets_sd_pins : "(none)");
            break;
        }
    }
    else if (strcmp(key, "gpio_buttons") == 0) {
        /* The stored spec is newline-separated pin:LABEL lines; commas make
         * it typeable on one console line (`set gpio_buttons 0:BOOT,4:KEY1`;
         * an empty value clears the buttons). */
        for (char *c = value; *c; c++) {
            if (*c == ',') *c = '\n';
        }
        if (fos_config_parse_gpio_buttons(value, config) != ESP_OK) {
            printf("bad button spec, want e.g. 0:BOOT,4:KEY1\n");
            return 1;
        }
    }
    else if (strcmp(key, "panel") == 0) {
        /* Every supported panel is compiled in, so an unknown key can only be
         * a typo — and it would surface as a frame that renders to nothing
         * after the next restart. Refuse it now, while someone is looking. */
        if (strcmp(value, "none") != 0) {
            bool panel_known = false;
            for (size_t i = 0; i < fos_display_panel_count(); i++) {
                if (strcmp(fos_display_panel_name(i), value) == 0) {
                    panel_known = true;
                    break;
                }
            }
            if (!panel_known) {
                printf("unknown panel \"%s\" — this firmware compiles in %u panels; "
                       "see the setup portal's list or `set panel none`\n",
                       value, (unsigned)fos_display_panel_count());
                return 1;
            }
        }
        strlcpy(config->panel, value, sizeof(config->panel));
    }
    else if (strcmp(key, "render_mode") == 0)
        config->render_mode = (strcmp(value, "remote") == 0 || strcmp(value, "1") == 0)
            ? FOS_RENDER_REMOTE : FOS_RENDER_LOCAL;
    else if (strcmp(key, "interval") == 0) config->interval_sec = strtoul(value, NULL, 10);
    else if (strcmp(key, "spill_force") == 0) config->http_spill_force_bytes = strtoul(value, NULL, 10);
    else if (strcmp(key, "rotate") == 0) {
        uint16_t rot = 0;
        if (!fos_config_normalize_rotate(strtod(value, NULL), &rot)) {
            printf("bad rotate value, want 0, 90, 180 or 270\n");
            return 1;
        }
        config->rotate = rot;
    }
    else if (strcmp(key, "scaling_mode") == 0) {
        char mode[16];
        if (!fos_config_normalize_scaling_mode(value, mode, sizeof(mode))) {
            printf("bad scaling_mode value, want contain, cover, stretch or center\n");
            return 1;
        }
        strlcpy(config->scaling_mode, mode, sizeof(config->scaling_mode));
    }
    else if (strcmp(key, "server_send_logs") == 0) config->server_send_logs = atoi(value) != 0;
    else if (strcmp(key, "debug") == 0) config->debug_logging = atoi(value) != 0;
    else if (strcmp(key, "fusion") == 0) config->image_fusion = atoi(value) != 0;
    /* 0 (default): while this frame is enrolled with a cloud provider, scene
     * HTTP to private/link-local addresses is denied — the provider installs
     * the scenes and the frame sits inside the owner's LAN. 1 lifts that, for
     * an owner who deliberately wants cloud scenes talking to a local API.
     * Console-only by design: see fos_config.h. Takes effect within a second,
     * no restart. */
    else if (strcmp(key, "allow_local_network") == 0)
        config->allow_local_network = atoi(value) != 0;
    else if (strcmp(key, "assets_path") == 0) strlcpy(config->assets_path, value, sizeof(config->assets_path));
    else if (strcmp(key, "assets_sd") == 0) config->assets_sd.enabled = atoi(value) != 0;
    else if (strcmp(key, "assets_sd_freq") == 0) config->assets_sd.max_freq_khz = strtoul(value, NULL, 10);
    /* 1 (default): format a card at boot when the raw sectors prove it empty.
     * 0: never format without an explicit `sd format`. */
    else if (strcmp(key, "assets_sd_autoformat") == 0) config->assets_sd.autoformat = atoi(value) != 0;
    else if (strcmp(key, "assets_sd_pins") == 0) {
        if (fos_config_parse_assets_sd_pins(value, &config->assets_sd) != ESP_OK) {
            printf("bad SD pin spec, want e.g. cs=38,sck=39,miso=40,mosi=41\n");
            return 1;
        }
    }
    else if (strcmp(key, "deep_sleep") == 0) config->deep_sleep = atoi(value) != 0;
    else if (strcmp(key, "wake_schedule") == 0) config->wake_schedule = atoi(value) != 0;
    else if (strcmp(key, "battery_pin") == 0) config->battery_pin = (int8_t)atoi(value);
    else if (strcmp(key, "battery_divider") == 0) config->battery_divider = (float)atof(value);
    else if (strcmp(key, "pins") == 0) {
        if (fos_config_parse_pins(value, &config->pins) != ESP_OK) {
            printf("bad pin spec, want e.g. rst=5,dc=4,cs=3,cs2=-1,busy=6,sck=7,mosi=9,pwr=-1\n");
            return 1;
        }
    } else {
        printf("unknown key \"%s\"\n", key);
        return 1;
    }
    fos_config_save();
    printf("ok: %s set (some settings need `restart`)\n", key);
    return 0;
}

static int cmd_wifi(int argc, char **argv)
{
    if (argc < 2) {
        printf("usage: wifi <ssid> [password]\n");
        return 1;
    }
    fos_config_t *config = fos_config();
    strlcpy(config->wifi_ssid, argv[1], sizeof(config->wifi_ssid));
    strlcpy(config->wifi_pass, argc > 2 ? argv[2] : "", sizeof(config->wifi_pass));
    fos_config_save();
    printf("wifi credentials saved, restarting...\n");
    esp_restart();
    return 0;
}

static int cmd_wifi_scan(int argc, char **argv)
{
    wifi_mode_t mode = WIFI_MODE_NULL;
    esp_err_t err = esp_wifi_get_mode(&mode);
    if (err != ESP_OK) {
        printf("wifi-scan: get mode failed: %s\n", esp_err_to_name(err));
        return 1;
    }
    /* scan_only suppresses the auto-reconnect for the whole scan window —
     * otherwise a connected STA races the scan ("STA is connecting"). */
    fos_wifi_set_scan_only(true);
    if (mode == WIFI_MODE_AP) {
        err = esp_wifi_set_mode(WIFI_MODE_APSTA);
        if (err != ESP_OK) {
            fos_wifi_set_scan_only(false);
            printf("wifi-scan: switch to APSTA failed: %s\n", esp_err_to_name(err));
            return 1;
        }
        vTaskDelay(pdMS_TO_TICKS(200));
    }
    esp_wifi_disconnect();
    vTaskDelay(pdMS_TO_TICKS(200));

    wifi_scan_config_t scan_config = {
        .show_hidden = true,
    };
    printf("wifi-scan: scanning...\n");
    err = esp_wifi_scan_start(&scan_config, true);
    fos_wifi_set_scan_only(false);
    if (err != ESP_OK) {
        esp_wifi_connect();
        printf("wifi-scan: scan failed: %s\n", esp_err_to_name(err));
        return 1;
    }

    uint16_t total = 0;
    esp_wifi_scan_get_ap_num(&total);
    uint16_t count = total > 20 ? 20 : total;
    wifi_ap_record_t records[20] = {0};
    err = esp_wifi_scan_get_ap_records(&count, records);
    esp_wifi_connect(); /* resume the STA link the scan dropped */
    if (err != ESP_OK) {
        esp_wifi_clear_ap_list();
        printf("wifi-scan: read results failed: %s\n", esp_err_to_name(err));
        return 1;
    }

    printf("wifi-scan: %u APs found", (unsigned)total);
    if (total > count) printf(" (showing strongest %u)", (unsigned)count);
    printf("\n");
    for (uint16_t i = 0; i < count; i++) {
        printf("%2u: ch=%2u rssi=%4d auth=%-9s ssid=\"%s\"\n",
               (unsigned)(i + 1),
               (unsigned)records[i].primary,
               (int)records[i].rssi,
               auth_mode_name(records[i].authmode),
               (char *)records[i].ssid);
    }
    return 0;
}

static int cmd_render(int argc, char **argv)
{
    fos_client_render_now();
    printf("render triggered\n");
    return 0;
}

static int cmd_event(int argc, char **argv)
{
    /* Send a scene event by hand. Scene event handlers were previously only
     * reachable by physically pressing a button wired to the right GPIO with
     * the label the scene happens to filter on — three things that all have
     * to line up before anything visibly happens, and nothing tells you which
     * one is wrong when it does not. This exercises the same path the button
     * driver and the HTTP /event/<name> route use. */
    if (argc < 2) {
        printf("usage: event <name> [json payload]\n");
        printf("  e.g. event button {\"label\":\"A\"}   (the label a scene node filters on)\n");
        return 1;
    }
    if (!frameos_nim_available()) {
        printf("no interpreted scene runtime on this build\n");
        return 1;
    }
    const char *payload = argc >= 3 ? argv[2] : "{}";
    if (!frameos_nim_send_event(argv[1], payload)) {
        printf("event rejected by the scene runtime\n");
        return 1;
    }
    printf("sent %s %s\n", argv[1], payload);
    if (frameos_nim_render_requested()) {
        fos_client_render_now();
        printf("scene asked for a render\n");
    }
    return 0;
}

static void display_test_set_4bpp(uint8_t *buf, int width, int x, int y, uint8_t color)
{
    size_t row_bytes = ((size_t)width + 1u) / 2u;
    size_t offset = (size_t)y * row_bytes + (size_t)x / 2u;
    if ((x & 1) == 0) {
        buf[offset] = (uint8_t)((buf[offset] & 0x0F) | ((color & 0x0F) << 4));
    } else {
        buf[offset] = (uint8_t)((buf[offset] & 0xF0) | (color & 0x0F));
    }
}

static uint8_t display_test_color_4bpp(const char *name)
{
    if (strcmp(name, "black") == 0) return 0x0;
    if (strcmp(name, "yellow") == 0) return 0x2;
    if (strcmp(name, "red") == 0) return 0x3;
    if (strcmp(name, "blue") == 0) return 0x5;
    if (strcmp(name, "green") == 0) return 0x6;
    return 0x1; /* white */
}

static int cmd_display_test(int argc, char **argv)
{
    const char *mode = argc >= 2 ? argv[1] : "bands";
    int width = fos_display_width();
    int height = fos_display_height();
    fos_pixel_format_t format = fos_display_format();
    size_t len = fos_display_buffer_size();
    if (!fos_display_present() || width <= 0 || height <= 0 || len == 0) {
        printf("display_test: no display configured\n");
        return 1;
    }

    uint8_t *buf = fos_big_malloc(len);
    if (!buf) buf = malloc(len);
    if (!buf) {
        printf("display_test: allocation failed (%u bytes)\n", (unsigned)len);
        return 1;
    }

    if (format == FOS_PIXEL_4BPP_SPECTRA6 || format == FOS_PIXEL_4BPP_7COLOR ||
        format == FOS_PIXEL_4BPP_GRAY) {
        memset(buf, 0x11, len);
        if (strcmp(mode, "bands") == 0) {
            static const uint8_t colors[] = {0x0, 0x3, 0x6, 0x5, 0x2, 0x1};
            int color_count = (int)(sizeof(colors) / sizeof(colors[0]));
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    int band = (x * color_count) / width;
                    if (band < 0) band = 0;
                    if (band >= color_count) band = color_count - 1;
                    display_test_set_4bpp(buf, width, x, y, colors[band]);
                }
            }
        } else {
            uint8_t color = display_test_color_4bpp(mode);
            uint8_t packed = (uint8_t)((color << 4) | color);
            memset(buf, packed, len);
        }
    } else {
        memset(buf, 0x00, len);
    }

    printf("display_test: mode=%s panel=%s %dx%d format=%d bytes=%u\n",
           mode, fos_display_selected_panel(), width, height, (int)format, (unsigned)len);
    esp_err_t err = fos_display_blit(buf, len);
    free(buf);
    printf("display_test: %s (%d)\n", err == ESP_OK ? "ESP_OK" : esp_err_to_name(err), (int)err);
    return err == ESP_OK ? 0 : 1;
}

/* Explicit SD-card maintenance. The boot mount only formats a card whose raw
 * sectors prove it empty (an exFAT card full of photos is indistinguishable
 * from a blank one at the FatFs API, so the proof has to come from reading the
 * sectors directly), and never re-probes the socket after boot — so formatting
 * a card the probe refused, and picking up a card inserted while the frame was
 * running, both have to be asked for by hand, here. `format` deliberately
 * overrides the probe: the warning below is the user's informed consent. */
static int cmd_sd(int argc, char **argv)
{
    const char *action = argc >= 2 ? argv[1] : "status";
    esp_err_t err = ESP_OK;
    if (strcmp(action, "remount") == 0) {
        err = fos_assets_sd_remount();
    } else if (strcmp(action, "format") == 0) {
        /* Writes a filesystem only to a card that carries no volume this
         * firmware can mount; a card that mounts is never erased. */
        printf("sd: FORMATTING - this ERASES everything on an unreadable card and is\n"
               "    NOT undoable. It is meant for a blank card. If the card only looks\n"
               "    empty to the frame because it is exFAT, pull it out and copy the\n"
               "    files off on a computer first.\n");
        err = fos_assets_sd_format();
    } else if (strcmp(action, "status") != 0) {
        printf("usage: sd [status|remount|format]\n");
        return 1;
    }
    printf("sd: mounted=%d path=%s capacity=%llu bytes\n",
           (int)fos_assets_sd_mounted(), fos_config()->assets_path,
           (unsigned long long)fos_assets_sd_capacity_bytes());
    if (fos_assets_sd_last_error()[0]) {
        printf("sd_error:    %s\n", fos_assets_sd_last_error());
    }
    return err == ESP_OK ? 0 : 1;
}

/* Two OTA paths exist and a board only ever has one of them: the backend one
 * (manifest under backend_url, authenticated with the frame api_key, applied
 * by the early updater after a reboot) and the cloud one (device-authed
 * manifest + minisign verification, fos_ota_request_cloud_update). An enrolled
 * cloud frame has no backend_url/api_key at all, so sending it down the
 * backend path could only ever answer ESP_ERR_INVALID_STATE — which read like
 * "OTA is broken" rather than "wrong path". Pick by what this board is. */
static esp_err_t ota_request_for_control_plane(const char **plane_out)
{
    const fos_config_t *config = fos_config();
    bool backend_ready = config->backend_url[0] && config->frame_id != 0 && config->api_key[0];
    if (!backend_ready && fos_cloud_frame_id()[0]) {
        if (plane_out) *plane_out = "cloud";
        fos_ota_request_cloud_update();
        return ESP_OK;
    }
    if (plane_out) *plane_out = "backend";
    return fos_ota_request_check();
}

static int cmd_ota(int argc, char **argv)
{
    const char *plane = "backend";
    esp_err_t err = ota_request_for_control_plane(&plane);
    printf("ota: %s (%s)\n", esp_err_to_name(err), plane);
    return err == ESP_OK ? 0 : 1;
}

static int cmd_scenes(int argc, char **argv)
{
    printf("scenes: %d loaded, etag %s\n", fos_scenes_loaded(),
           fos_scenes_etag()[0] ? fos_scenes_etag() : "none");
    printf("%s\n", frameos_nim_scene_info_json());
    fos_scenes_request_sync();
    fos_client_render_now();
    printf("sync requested; the render task pulls from the backend next pass\n");
    return 0;
}

static int cmd_scene_state(int argc, char **argv)
{
    printf("%s\n", frameos_nim_scene_state_json());
    return 0;
}

static int cmd_scene(int argc, char **argv)
{
    if (argc < 2) {
        printf("usage: scene <scene-id>\n");
        printf("%s\n", frameos_nim_scene_info_json());
        return 1;
    }
    esp_err_t err = fos_scenes_select(argv[1]);
    if (err != ESP_OK) {
        printf("scene select failed: %s\n", esp_err_to_name(err));
        return 1;
    }
    fos_client_render_now();
    printf("scene queued: %s\n", argv[1]);
    return 0;
}

static void usb_api_ok(const char *name)
{
    printf("%s %s\n", USB_API_OK, name);
    fflush(stdout);
}

static void usb_api_error(const char *name, esp_err_t err, const char *message)
{
    printf("%s %s %s %s\n", USB_API_ERROR, name, esp_err_to_name(err), message ? message : "");
    fflush(stdout);
}

static void usb_api_ready(const char *name)
{
    printf("%s %s\n", USB_API_READY, name);
    fflush(stdout);
}

static bool usb_api_read_exact(uint8_t *buf, size_t len, TickType_t timeout_ticks, size_t *bytes_read)
{
    size_t off = 0;
    TickType_t start = xTaskGetTickCount();
    if (bytes_read) *bytes_read = 0;
    while (off < len) {
#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
        size_t remaining = len - off;
        uint32_t chunk = remaining > FOS_USB_API_PAYLOAD_READ_CHUNK
                             ? FOS_USB_API_PAYLOAD_READ_CHUNK
                             : (uint32_t)remaining;
        int count = usb_serial_jtag_read_bytes(buf + off, chunk, pdMS_TO_TICKS(20));
        if (count > 0) {
            off += (size_t)count;
            if (bytes_read) *bytes_read = off;
            taskYIELD();
            continue;
        }
#else
        int ch = fgetc(stdin);
        if (ch != EOF) {
            buf[off++] = (uint8_t)ch;
            if (bytes_read) *bytes_read = off;
            if ((off & 0x3ff) == 0) taskYIELD();
            continue;
        }
#endif
        if ((xTaskGetTickCount() - start) >= timeout_ticks) {
            return false;
        }
        /* At least one full tick: pdMS_TO_TICKS(1) is 0 ticks at 100Hz. */
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    return true;
}

static void usb_api_payload_timeout_error(const char *name, size_t read, size_t expected)
{
    char message[96];
    snprintf(message, sizeof(message), "payload read timed out (%u/%u bytes)",
             (unsigned)read, (unsigned)expected);
    usb_api_error(name, ESP_ERR_TIMEOUT, message);
}

/* Console args split on whitespace, so asset paths travel percent-encoded. */
static bool usb_api_decode_asset_path(const char *encoded, bool write_rule,
                                      char *out, size_t out_len)
{
    if (!encoded) return false;
    char raw[FOS_ASSETS_PATH_MAX];
    size_t used = 0;
    for (const char *p = encoded; *p && used + 1 < sizeof(raw); p++) {
        if (*p == '%' && isxdigit((unsigned char)p[1]) && isxdigit((unsigned char)p[2])) {
            char hex[3] = {p[1], p[2], 0};
            raw[used++] = (char)strtol(hex, NULL, 16);
            p += 2;
        } else {
            raw[used++] = *p;
        }
    }
    if (used == 0 || used + 1 >= sizeof(raw)) return false;
    raw[used] = '\0';
    return write_rule ? fos_assets_sanitize_write_path(raw, out, out_len)
                      : fos_assets_sanitize_path(raw, out, out_len);
}

static void usb_api_payload_text(const char *name, const char *text)
{
    size_t len = text ? strlen(text) : 0;
    printf("%s %s %u text\n", USB_API_BEGIN, name, (unsigned)len);
    if (len > 0) {
        fwrite(text, 1, len, stdout);
    }
    printf("\n%s %s\n", USB_API_END, name);
    fflush(stdout);
}

static size_t usb_api_base64_encode(const uint8_t *src, size_t len, char *dst)
{
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t out = 0;
    for (size_t i = 0; i < len; i += 3) {
        uint32_t v = (uint32_t)src[i] << 16;
        bool has_b = i + 1 < len;
        bool has_c = i + 2 < len;
        if (has_b) v |= (uint32_t)src[i + 1] << 8;
        if (has_c) v |= src[i + 2];
        dst[out++] = alphabet[(v >> 18) & 0x3F];
        dst[out++] = alphabet[(v >> 12) & 0x3F];
        dst[out++] = has_b ? alphabet[(v >> 6) & 0x3F] : '=';
        dst[out++] = has_c ? alphabet[v & 0x3F] : '=';
    }
    dst[out] = '\0';
    return out;
}

static void usb_api_payload_base64(const char *name, const uint8_t *data, size_t len,
                                   const char *metadata)
{
    char encoded[((FOS_USB_API_RAW_CHUNK + 2) / 3) * 4 + 1];
    printf("%s %s %u base64%s%s\n", USB_API_BEGIN, name, (unsigned)len,
           metadata && metadata[0] ? " " : "", metadata && metadata[0] ? metadata : "");
    for (size_t off = 0; off < len; off += FOS_USB_API_RAW_CHUNK) {
        size_t chunk = len - off;
        if (chunk > FOS_USB_API_RAW_CHUNK) chunk = FOS_USB_API_RAW_CHUNK;
        size_t encoded_len = usb_api_base64_encode(data + off, chunk, encoded);
        fwrite(encoded, 1, encoded_len, stdout);
        fputc('\n', stdout);
    }
    printf("%s %s\n", USB_API_END, name);
    fflush(stdout);
}

static int cmd_usb_api(int argc, char **argv)
{
    if (argc < 2) {
        printf("usage: usb_api <status|image|render|reload|scenes-sync|upload-scenes|scene|scene-payload|ota|scene-state|logs|set|wifi|wifi-scan|restart|factory-reset|list-assets|get-asset|upload-asset|asset-op|remount-sd|format-sd> ...\n");
        return 1;
    }

    const char *subcommand = argv[1];
    if (strcmp(subcommand, "status") == 0) {
        char *json = fos_http_status_json();
        if (!json) {
            usb_api_error(subcommand, ESP_ERR_NO_MEM, "status json allocation failed");
            return 1;
        }
        usb_api_payload_text(subcommand, json);
        free(json);
        return 0;
    }

    if (strcmp(subcommand, "scene-state") == 0) {
        usb_api_payload_text(subcommand, frameos_nim_scene_state_json());
        return 0;
    }

    if (strcmp(subcommand, "image") == 0) {
        uint8_t *bmp = NULL;
        size_t bmp_len = 0;
        char scene_id[128];
        scene_id[0] = '\0';
        esp_err_t err = fos_http_preview_bmp_alloc(&bmp, &bmp_len, scene_id, sizeof(scene_id));
        if (err != ESP_OK) {
            const char *reason = "image unavailable";
            if (err == ESP_ERR_NOT_FOUND) {
                reason = strcmp(fos_client_snapshot_mode(), "hash-only") == 0
                    ? "panel image is rendered, but preview snapshot was not retained"
                    : "no preview rendered yet";
            }
            usb_api_error(subcommand, err, reason);
            return 1;
        }
        char metadata[160];
        snprintf(metadata, sizeof(metadata), "scene=%s", scene_id);
        usb_api_payload_base64(subcommand, bmp, bmp_len, metadata);
        free(bmp);
        return 0;
    }

    if (strcmp(subcommand, "render") == 0) {
        fos_client_render_now();
        usb_api_ok(subcommand);
        return 0;
    }

    if (strcmp(subcommand, "reload") == 0 || strcmp(subcommand, "scenes-sync") == 0) {
        fos_scenes_request_sync();
        fos_client_render_now();
        usb_api_ok(subcommand);
        return 0;
    }

    if (strcmp(subcommand, "ota") == 0) {
        esp_err_t err = ota_request_for_control_plane(NULL);
        if (err == ESP_OK) {
            usb_api_ok(subcommand);
            return 0;
        }
        usb_api_error(subcommand, err, "ota request failed");
        return 1;
    }

    if (strcmp(subcommand, "scene") == 0) {
        if (argc < 3) {
            usb_api_error(subcommand, ESP_ERR_INVALID_ARG, "missing scene id");
            return 1;
        }
        esp_err_t err = fos_scenes_select(argv[2]);
        if (err != ESP_OK) {
            usb_api_error(subcommand, err, "scene select failed");
            return 1;
        }
        fos_client_render_now();
        usb_api_ok(subcommand);
        return 0;
    }

    if (strcmp(subcommand, "scene-payload") == 0) {
        if (argc < 3) {
            usb_api_error(subcommand, ESP_ERR_INVALID_ARG, "missing byte length");
            return 1;
        }
        size_t len = (size_t)strtoul(argv[2], NULL, 10);
        if (len == 0 || len >= FOS_USB_API_MAX_SCENE_ID) {
            usb_api_error(subcommand, ESP_ERR_INVALID_SIZE, "bad scene id length");
            return 1;
        }
        char scene_id[FOS_USB_API_MAX_SCENE_ID];
        usb_api_ready(subcommand);
        size_t bytes_read = 0;
        if (!usb_api_read_exact((uint8_t *)scene_id, len, pdMS_TO_TICKS(FOS_USB_API_PAYLOAD_TIMEOUT_MS), &bytes_read)) {
            usb_api_payload_timeout_error(subcommand, bytes_read, len);
            return 1;
        }
        scene_id[len] = '\0';
        esp_err_t err = fos_scenes_select(scene_id);
        if (err != ESP_OK) {
            usb_api_error(subcommand, err, "scene select failed");
            return 1;
        }
        fos_client_render_now();
        usb_api_ok(subcommand);
        return 0;
    }

    if (strcmp(subcommand, "set") == 0) {
        /* Machine-framed config write: same implementation as the human
         * `set` command, with an OK/ERROR marker the browser can await
         * instead of scraping free-form console text. */
        if (argc < 4) {
            usb_api_error(subcommand, ESP_ERR_INVALID_ARG, "usage: set <key> <value...>");
            return 1;
        }
        int rc = cmd_set(argc - 1, argv + 1);
        if (rc == 0) {
            usb_api_ok(subcommand);
        } else {
            usb_api_error(subcommand, ESP_FAIL, "set failed (see console output)");
        }
        return rc;
    }

    if (strcmp(subcommand, "wifi") == 0) {
        if (argc < 3) {
            usb_api_error(subcommand, ESP_ERR_INVALID_ARG, "usage: wifi <ssid> [pass]");
            return 1;
        }
        fos_config_t *config = fos_config();
        strlcpy(config->wifi_ssid, argv[2], sizeof(config->wifi_ssid));
        strlcpy(config->wifi_pass, argc >= 4 ? argv[3] : "", sizeof(config->wifi_pass));
        if (fos_config_save() != ESP_OK) {
            usb_api_error(subcommand, ESP_FAIL, "persist failed");
            return 1;
        }
        usb_api_ok(subcommand);
        fflush(stdout);
        vTaskDelay(pdMS_TO_TICKS(250)); /* let the marker flush */
        esp_restart();
        return 0;
    }

    if (strcmp(subcommand, "wifi-scan") == 0) {
        wifi_ap_record_t records[20] = {0};
        uint16_t total = 0;
        wifi_mode_t mode = WIFI_MODE_NULL;
        esp_err_t err = esp_wifi_get_mode(&mode);
        /* scan_only suppresses the auto-reconnect for the whole window —
         * otherwise the STA races the scan ("STA is connecting"). */
        fos_wifi_set_scan_only(true);
        if (err == ESP_OK && mode == WIFI_MODE_AP) {
            err = esp_wifi_set_mode(WIFI_MODE_APSTA);
            if (err == ESP_OK) vTaskDelay(pdMS_TO_TICKS(200));
        }
        if (err == ESP_OK) {
            esp_wifi_disconnect();
            vTaskDelay(pdMS_TO_TICKS(200));
            wifi_scan_config_t scan_config = { .show_hidden = true };
            err = esp_wifi_scan_start(&scan_config, true);
        }
        fos_wifi_set_scan_only(false);
        uint16_t count = 0;
        if (err == ESP_OK) {
            esp_wifi_scan_get_ap_num(&total);
            count = total > 20 ? 20 : total;
            err = esp_wifi_scan_get_ap_records(&count, records);
            if (err != ESP_OK) esp_wifi_clear_ap_list();
        }
        esp_wifi_connect(); /* resume the STA link the scan dropped */
        if (err != ESP_OK) {
            usb_api_error(subcommand, err, "wifi scan failed");
            return 1;
        }
        cJSON *msg = cJSON_CreateObject();
        cJSON *networks = msg ? cJSON_AddArrayToObject(msg, "networks") : NULL;
        if (networks) {
            for (uint16_t i = 0; i < count; i++) {
                cJSON *net = cJSON_CreateObject();
                if (!net) break;
                cJSON_AddStringToObject(net, "ssid", (const char *)records[i].ssid);
                cJSON_AddNumberToObject(net, "rssi", records[i].rssi);
                cJSON_AddNumberToObject(net, "channel", records[i].primary);
                cJSON_AddStringToObject(net, "auth", auth_mode_name(records[i].authmode));
                cJSON_AddItemToArray(networks, net);
            }
            cJSON_AddNumberToObject(msg, "total", total);
        }
        char *json = networks ? cJSON_PrintUnformatted(msg) : NULL;
        cJSON_Delete(msg);
        if (!json) {
            usb_api_error(subcommand, ESP_ERR_NO_MEM, "scan json allocation failed");
            return 1;
        }
        usb_api_payload_text(subcommand, json);
        cJSON_free(json);
        return 0;
    }

    if (strcmp(subcommand, "restart") == 0) {
        usb_api_ok(subcommand);
        fflush(stdout);
        vTaskDelay(pdMS_TO_TICKS(250));
        esp_restart();
        return 0;
    }

    if (strcmp(subcommand, "factory-reset") == 0) {
        usb_api_ok(subcommand);
        fflush(stdout);
        vTaskDelay(pdMS_TO_TICKS(250));
        fos_config_erase();
        esp_restart();
        return 0;
    }

    if (strcmp(subcommand, "logs") == 0) {
        frameos_log_entry_t *entries = calloc(FOS_NIM_LOG_RING_CAP, sizeof(*entries));
        if (!entries) {
            usb_api_error(subcommand, ESP_ERR_NO_MEM, "log snapshot allocation failed");
            return 1;
        }
        size_t count = frameos_nim_log_recent(entries, FOS_NIM_LOG_RING_CAP);
        printf("%s %s %u text\n", USB_API_BEGIN, subcommand, (unsigned)count);
        for (size_t i = 0; i < count; i++) {
            if (entries[i].timestamp > 1e9) {
                printf("%.0f %s\n", entries[i].timestamp, entries[i].line);
            } else {
                printf("- %s\n", entries[i].line);
            }
            free(entries[i].line);
        }
        free(entries);
        printf("%s %s\n", USB_API_END, subcommand);
        fflush(stdout);
        return 0;
    }

    /* Explicit SD maintenance — see cmd_sd. Never triggered automatically. */
    if (strcmp(subcommand, "remount-sd") == 0 || strcmp(subcommand, "format-sd") == 0) {
        bool format = strcmp(subcommand, "format-sd") == 0;
        esp_err_t err = format ? fos_assets_sd_format() : fos_assets_sd_remount();
        if (err != ESP_OK) {
            const char *detail = fos_assets_sd_last_error();
            usb_api_error(subcommand, err, (detail && detail[0]) ? detail : "sd action failed");
            return 1;
        }
        usb_api_ok(subcommand);
        return 0;
    }

    if (strcmp(subcommand, "list-assets") == 0) {
        cJSON *msg = cJSON_CreateObject();
        cJSON *assets = msg ? cJSON_AddArrayToObject(msg, "assets") : NULL;
        bool truncated = false;
        bool ok = assets && fos_assets_list_json(assets, &truncated);
        if (ok && truncated) cJSON_AddBoolToObject(msg, "truncated", true);
        if (ok) cJSON_AddBoolToObject(msg, "mounted", fos_assets_available());
        char *json = ok ? cJSON_PrintUnformatted(msg) : NULL;
        cJSON_Delete(msg);
        if (!json) {
            usb_api_error(subcommand, ESP_ERR_NO_MEM, "asset list allocation failed");
            return 1;
        }
        usb_api_payload_text(subcommand, json);
        cJSON_free(json);
        return 0;
    }

    if (strcmp(subcommand, "get-asset") == 0) {
        if (argc < 3) {
            usb_api_error(subcommand, ESP_ERR_INVALID_ARG, "missing path");
            return 1;
        }
        char rel[FOS_ASSETS_PATH_MAX];
        if (!usb_api_decode_asset_path(argv[2], false, rel, sizeof(rel))) {
            usb_api_error(subcommand, ESP_ERR_INVALID_ARG, "invalid path");
            return 1;
        }
        struct stat st;
        if (fos_assets_stat(rel, &st) != ESP_OK || S_ISDIR(st.st_mode)) {
            usb_api_error(subcommand, ESP_ERR_NOT_FOUND, "asset not found");
            return 1;
        }
        char full[FOS_ASSETS_FULL_PATH_MAX];
        fos_assets_full_path(full, sizeof(full), rel);
        FILE *file = fopen(full, "rb");
        if (!file) {
            usb_api_error(subcommand, ESP_ERR_NOT_FOUND, "asset not found");
            return 1;
        }
        char metadata[FOS_ASSETS_PATH_MAX + 64];
        snprintf(metadata, sizeof(metadata), "content_type=%s",
                 fos_assets_content_type(rel));
        /* Same framing as `image`, streamed straight off the card. */
        uint8_t raw[FOS_USB_API_RAW_CHUNK];
        char encoded[((FOS_USB_API_RAW_CHUNK + 2) / 3) * 4 + 1];
        printf("%s %s %u base64 %s\n", USB_API_BEGIN, subcommand,
               (unsigned)st.st_size, metadata);
        size_t remaining = (size_t)st.st_size;
        bool failed = false;
        while (remaining > 0) {
            size_t want = remaining > sizeof(raw) ? sizeof(raw) : remaining;
            size_t r = fread(raw, 1, want, file);
            if (r == 0) {
                failed = true;
                break;
            }
            size_t encoded_len = usb_api_base64_encode(raw, r, encoded);
            fwrite(encoded, 1, encoded_len, stdout);
            fputc('\n', stdout);
            remaining -= r;
        }
        fclose(file);
        printf("%s %s\n", USB_API_END, subcommand);
        fflush(stdout);
        if (failed) {
            usb_api_error(subcommand, ESP_FAIL, "asset read failed");
            return 1;
        }
        return 0;
    }

    if (strcmp(subcommand, "upload-asset") == 0) {
        if (argc < 4) {
            usb_api_error(subcommand, ESP_ERR_INVALID_ARG, "usage: upload-asset <len> <urlencoded-path>");
            return 1;
        }
        size_t len = (size_t)strtoul(argv[2], NULL, 10);
        if (len == 0 || len > FOS_USB_API_MAX_UPLOAD) {
            usb_api_error(subcommand, ESP_ERR_INVALID_SIZE, "bad upload length");
            return 1;
        }
        char rel[FOS_ASSETS_PATH_MAX];
        if (!usb_api_decode_asset_path(argv[3], true, rel, sizeof(rel))) {
            usb_api_error(subcommand, ESP_ERR_INVALID_ARG, "invalid path");
            return 1;
        }
        if (!fos_assets_available()) {
            usb_api_error(subcommand, ESP_ERR_INVALID_STATE, "assets storage not mounted");
            return 1;
        }
        uint8_t *body = fos_big_malloc(len);
        if (!body) body = malloc(len);
        if (!body) {
            usb_api_error(subcommand, ESP_ERR_NO_MEM, "upload allocation failed");
            return 1;
        }
        usb_api_ready(subcommand);
        size_t bytes_read = 0;
        if (!usb_api_read_exact(body, len, pdMS_TO_TICKS(FOS_USB_API_PAYLOAD_TIMEOUT_MS), &bytes_read)) {
            free(body);
            usb_api_payload_timeout_error(subcommand, bytes_read, len);
            return 1;
        }
        const char *asset_err = NULL;
        esp_err_t err = fos_assets_write_file(rel, body, len, &asset_err);
        free(body);
        if (err != ESP_OK) {
            usb_api_error(subcommand, err, asset_err ? asset_err : "asset write failed");
            return 1;
        }
        usb_api_ok(subcommand);
        return 0;
    }

    if (strcmp(subcommand, "asset-op") == 0) {
        if (argc < 4) {
            usb_api_error(subcommand, ESP_ERR_INVALID_ARG,
                          "usage: asset-op <mkdir|delete|rename> <urlencoded-path> [urlencoded-dst]");
            return 1;
        }
        const char *op = argv[2];
        char rel[FOS_ASSETS_PATH_MAX];
        if (!usb_api_decode_asset_path(argv[3], true, rel, sizeof(rel))) {
            usb_api_error(subcommand, ESP_ERR_INVALID_ARG, "invalid path");
            return 1;
        }
        const char *asset_err = NULL;
        esp_err_t err;
        if (strcmp(op, "mkdir") == 0) {
            err = fos_assets_mkdir(rel, &asset_err);
        } else if (strcmp(op, "delete") == 0) {
            err = fos_assets_delete(rel, &asset_err);
        } else if (strcmp(op, "rename") == 0) {
            char dst[FOS_ASSETS_PATH_MAX];
            if (argc < 5 || !usb_api_decode_asset_path(argv[4], true, dst, sizeof(dst))) {
                usb_api_error(subcommand, ESP_ERR_INVALID_ARG, "invalid destination");
                return 1;
            }
            err = fos_assets_rename(rel, dst, &asset_err);
        } else {
            usb_api_error(subcommand, ESP_ERR_INVALID_ARG, "unknown asset op");
            return 1;
        }
        if (err != ESP_OK) {
            usb_api_error(subcommand, err, asset_err ? asset_err : "asset op failed");
            return 1;
        }
        usb_api_ok(subcommand);
        return 0;
    }

    if (strcmp(subcommand, "upload-scenes") == 0) {
        if (argc < 3) {
            usb_api_error(subcommand, ESP_ERR_INVALID_ARG, "missing byte length");
            return 1;
        }
        size_t len = (size_t)strtoul(argv[2], NULL, 10);
        if (len == 0 || len > FOS_USB_API_MAX_UPLOAD) {
            usb_api_error(subcommand, ESP_ERR_INVALID_SIZE, "bad upload length");
            return 1;
        }
        uint8_t *body = fos_big_malloc(len + 1);
        if (!body) body = malloc(len + 1);
        if (!body) {
            usb_api_error(subcommand, ESP_ERR_NO_MEM, "upload allocation failed");
            return 1;
        }
        usb_api_ready(subcommand);
        size_t bytes_read = 0;
        if (!usb_api_read_exact(body, len, pdMS_TO_TICKS(FOS_USB_API_PAYLOAD_TIMEOUT_MS), &bytes_read)) {
            free(body);
            usb_api_payload_timeout_error(subcommand, bytes_read, len);
            return 1;
        }
        body[len] = '\0';
        esp_err_t err = fos_http_store_uploaded_scenes_payload((const char *)body, len);
        free(body);
        if (err != ESP_OK) {
            const char *detail = fos_scenes_last_error();
            usb_api_error(subcommand, err, (detail && detail[0]) ? detail : "scene upload failed");
            return 1;
        }
        fos_client_render_now();
        usb_api_ok(subcommand);
        return 0;
    }

    usb_api_error(subcommand, ESP_ERR_NOT_SUPPORTED, "unknown subcommand");
    return 1;
}

static int cmd_restart(int argc, char **argv)
{
    esp_restart();
    return 0;
}

static int cmd_factory_reset(int argc, char **argv)
{
    fos_config_erase();
    printf("config erased, restarting...\n");
    esp_restart();
    return 0;
}

static esp_err_t register_frameos_console_commands(void)
{
    const esp_console_cmd_t commands[] = {
        {.command = "status", .help = "Show device status", .func = cmd_status},
        {.command = "heapinfo", .help = "Per-region heap breakdown (internal + PSRAM)", .func = cmd_heapinfo},
        {.command = "buttons", .help = "buttons [watch [seconds]] — configured buttons, or find which GPIO a press moves", .func = cmd_buttons},
        {.command = "set", .help = "set <key> <value> — persist a config value", .func = cmd_set},
        {.command = "wifi", .help = "wifi <ssid> [pass] — set Wi-Fi and restart", .func = cmd_wifi},
        {.command = "wifi-scan", .help = "Scan visible Wi-Fi networks", .func = cmd_wifi_scan},
        {.command = "render", .help = "Render now", .func = cmd_render},
        {.command = "event", .help = "event <name> [json] — send a scene event by hand (e.g. event button {\"label\":\"A\"})", .func = cmd_event},
        {.command = "display_test", .help = "display_test [bands|black|white|red|green|blue|yellow] — draw direct panel test", .func = cmd_display_test},
        {.command = "sd", .help = "sd [status|remount|format] — SD assets card; format ERASES an unreadable card and is never automatic", .func = cmd_sd},
        {.command = "ota", .help = "Check for OTA update now", .func = cmd_ota},
        {.command = "scenes", .help = "Show loaded scenes + sync from backend", .func = cmd_scenes},
        {.command = "scene_state", .help = "Show current interpreted scene state JSON", .func = cmd_scene_state},
        {.command = "scene", .help = "scene <id> — select a loaded scene and render", .func = cmd_scene},
        {.command = "usb_api", .help = "USB API bridge for the browser", .func = cmd_usb_api},
        {.command = "restart", .help = "Reboot", .func = cmd_restart},
        {.command = "factory-reset", .help = "Erase config and reboot", .func = cmd_factory_reset},
    };
    for (size_t i = 0; i < sizeof(commands) / sizeof(commands[0]); i++) {
        ESP_ERROR_CHECK(esp_console_cmd_register(&commands[i]));
    }
    return ESP_OK;
}

#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
static void console_prompt(void)
{
    printf("frameos>");
    fflush(stdout);
}

static void run_console_line(char *line)
{
    char *start = line;
    while (*start && isspace((unsigned char)*start)) start++;
    if (!*start) return;

    int cmd_ret = 0;
    esp_err_t err = esp_console_run(start, &cmd_ret);
    if (err == ESP_ERR_NOT_FOUND) {
        printf("unknown command: %s\n", start);
    } else if (err == ESP_ERR_INVALID_ARG) {
        /* Empty/whitespace lines are filtered above; treat the rest as parse errors. */
        printf("invalid command: %s\n", start);
    } else if (err != ESP_OK) {
        printf("command failed: %s\n", esp_err_to_name(err));
    } else if (cmd_ret != 0 && strncmp(start, "usb_api", 7) != 0) {
        printf("command returned %d\n", cmd_ret);
    }
    fflush(stdout);
}

static void fos_console_usb_task(void *arg)
{
    (void)arg;
    char line[FOS_CONSOLE_MAX_CMDLINE_LENGTH];
    size_t len = 0;

    console_prompt();
    while (true) {
        int ch = fgetc(stdin);
        if (ch == EOF) {
            /* stdin is non-blocking; sleep at least one full tick. At
             * CONFIG_FREERTOS_HZ=100, pdMS_TO_TICKS(1) rounds to 0 ticks and
             * this loop busy-spins, starving IDLE0 (task_wdt warnings). */
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        if (ch == '\r' || ch == '\n') {
            line[len] = '\0';
            run_console_line(line);
            len = 0;
            console_prompt();
            continue;
        }

        if (ch == 0x08 || ch == 0x7f) {
            if (len > 0) len--;
            continue;
        }

        if (len < sizeof(line) - 1) {
            line[len++] = (char)ch;
        } else {
            line[sizeof(line) - 1] = '\0';
            printf("command too long\n");
            len = 0;
            console_prompt();
        }
    }
}

static esp_err_t fos_console_start_usb_serial_jtag(void)
{
    /* Commands are LF-delimited; raw usb_api payload bytes must not be CRLF-normalized. */
    usb_serial_jtag_vfs_set_rx_line_endings(ESP_LINE_ENDINGS_LF);
    usb_serial_jtag_vfs_set_tx_line_endings(ESP_LINE_ENDINGS_CRLF);

    fcntl(fileno(stdout), F_SETFL, 0);
    fcntl(fileno(stdin), F_SETFL, O_NONBLOCK);

    usb_serial_jtag_driver_config_t usb_serial_jtag_config = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    usb_serial_jtag_config.rx_buffer_size = 8192;
    usb_serial_jtag_config.tx_buffer_size = 2048;
    esp_err_t err = usb_serial_jtag_driver_install(&usb_serial_jtag_config);
    if (err != ESP_OK) return err;
    usb_serial_jtag_vfs_use_driver();

    esp_console_config_t console_config = ESP_CONSOLE_CONFIG_DEFAULT();
    console_config.max_cmdline_length = FOS_CONSOLE_MAX_CMDLINE_LENGTH;
    err = esp_console_init(&console_config);
    if (err != ESP_OK) return err;
    ESP_ERROR_CHECK(esp_console_register_help_command());
    ESP_ERROR_CHECK(register_frameos_console_commands());

    if (xTaskCreate(fos_console_usb_task, "console_usb", FOS_CONSOLE_TASK_STACK_SIZE, NULL, 2, NULL) != pdTRUE) {
        return ESP_FAIL;
    }
    return ESP_OK;
}
#endif

esp_err_t fos_console_start(void)
{
#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
    esp_err_t err = fos_console_start_usb_serial_jtag();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "console init failed: %s", esp_err_to_name(err));
    }
    return err;
#else
    esp_console_repl_t *repl = NULL;
    esp_console_repl_config_t repl_config = ESP_CONSOLE_REPL_CONFIG_DEFAULT();
    repl_config.prompt = "frameos>";
    repl_config.max_cmdline_length = FOS_CONSOLE_MAX_CMDLINE_LENGTH;
    repl_config.task_stack_size = FOS_CONSOLE_TASK_STACK_SIZE;

    esp_err_t err = ESP_OK;
#if CONFIG_ESP_CONSOLE_UART
    esp_console_dev_uart_config_t hw_config = ESP_CONSOLE_DEV_UART_CONFIG_DEFAULT();
    err = esp_console_new_repl_uart(&hw_config, &repl_config, &repl);
#elif CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
    esp_console_dev_usb_serial_jtag_config_t hw_config =
        ESP_CONSOLE_DEV_USB_SERIAL_JTAG_CONFIG_DEFAULT();
    err = esp_console_new_repl_usb_serial_jtag(&hw_config, &repl_config, &repl);
#else
    err = ESP_ERR_NOT_SUPPORTED;
#endif
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "console init failed: %s", esp_err_to_name(err));
        return err;
    }

    ESP_ERROR_CHECK(register_frameos_console_commands());
    ESP_ERROR_CHECK(esp_console_start_repl(repl));
    return ESP_OK;
#endif
}
