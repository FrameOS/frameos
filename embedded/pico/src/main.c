// FrameOS thin client for Raspberry Pi Pico W / Pico 2 W.
//
// Boot: load config → hold the power latch → note what woke the board →
// join Wi-Fi, or open the setup hotspot when there is no network to join.
// Then one loop: pull settings and the rendered panel payload from the
// backend on the configured interval (or when a button, the console, or the
// backend asks), draw it, ship the log, and — in battery mode — cut the power
// until the RTC or a button brings the board back.
//
// Everything a person needs is reachable three ways: the USB console (also
// the browser's `usb_api`), the setup hotspot's page, and the HTTP API on the
// LAN. See README.md.
#include <stdio.h>
#include <string.h>

#include "hardware/gpio.h"
#include "pico/stdlib.h"

#include "pk_config.h"
#include "pk_console.h"
#include "pk_display.h"
#include "pk_hotspot.h"
#include "pk_httpd.h"
#include "pk_leds.h"
#include "pk_log.h"
#include "pk_platform.h"
#include "pk_render.h"
#include "pk_rtc.h"
#include "pk_shiftreg.h"
#include "pk_time.h"
#include "pk_wifi.h"

#define WIFI_CONNECT_TIMEOUT_MS 30000
#define WIFI_RECONNECT_EVERY_MS 30000
// Offline this long with credentials that used to work: reboot, which ends
// in the setup hotspot if the network is really gone.
#define WIFI_OFFLINE_REBOOT_MS (10u * 60u * 1000u)
// A hotspot opened because the saved network did not answer retries it this
// often, unless somebody is using the setup page.
#define PORTAL_RETRY_MS (5u * 60u * 1000u)
// A console line or a hotspot client holds off the power cut this long.
#define KEEP_AWAKE_MS (3u * 60u * 1000u)
#define FAILED_RENDER_RETRY_SECONDS 60u
#define MAX_BUSY_RETRIES 3u
#define BUTTON_POLL_MS 20

// Shift register bits (Pimoroni inky_frame.hpp): buttons A-E are 0-4.
#define SR_BUTTON_MASK 0x1Fu
#define SR_RTC_ALARM (1u << 5)
#define SR_EXTERNAL_TRIGGER (1u << 6)

static bool s_render_requested = false;
static uint8_t s_buttons_last = 0;
static absolute_time_t s_next_button_poll;

static uint32_t now_ms(void)
{
    return to_ms_since_boot(get_absolute_time());
}

static bool has_shift_register(void)
{
    return pk_config()->pins.sr_clock >= 0;
}

static void log_wake(uint8_t wake_bits)
{
    char line[PK_LOG_LINE_MAX];
    uint8_t buttons = wake_bits & SR_BUTTON_MASK;
    if (buttons) {
        int index = 0;
        while (!(buttons & (1u << index))) index++;
        snprintf(line, sizeof(line),
                 "{\"event\":\"wake\",\"source\":\"pico\",\"cause\":\"button\",\"label\":\"%c\"}", 'A' + index);
    } else {
        const char *cause = (wake_bits & SR_RTC_ALARM) ? "timer"
                            : (wake_bits & SR_EXTERNAL_TRIGGER) ? "external"
                                                                : "power";
        snprintf(line, sizeof(line), "{\"event\":\"wake\",\"source\":\"pico\",\"cause\":\"%s\"}", cause);
    }
    pk_log_event(line);
}

static void log_bootup(void)
{
    const pk_config_t *config = pk_config();
    const pk_panel_t *panel = pk_display_current();
    char line[PK_LOG_LINE_MAX];
    snprintf(line, sizeof(line),
             "{\"event\":\"bootup\",\"source\":\"pico\",\"width\":%d,\"height\":%d,\"pixelFormat\":%d,"
             "\"mode\":\"embedded\",\"renderMode\":\"remote\",\"version\":\"%s\",\"panel\":\"%s\","
             "\"ip\":\"%s\",\"wifi\":\"connected\"}",
             panel ? panel->width : 0, panel ? panel->height : 0, panel ? panel->format : 0,
             FRAMEOS_VERSION, config->panel, pk_wifi_ip());
    pk_log_event(line);
}

// Front buttons: any press re-renders (the ESP32 thin client's behaviour —
// the scene runs on the backend, so there is no local scene to hand the
// event to) and is logged, so the backend's log shows which one it was.
static void poll_buttons(void)
{
    if (!has_shift_register()) return;
    if (absolute_time_diff_us(get_absolute_time(), s_next_button_poll) > 0) return;
    s_next_button_poll = make_timeout_time_ms(BUTTON_POLL_MS);
    uint8_t buttons = pk_shiftreg_read(&pk_config()->pins) & SR_BUTTON_MASK;
    uint8_t pressed = buttons & (uint8_t)~s_buttons_last;
    s_buttons_last = buttons;
    for (int index = 0; index < 5; index++) {
        if (!(pressed & (1u << index))) continue;
        pk_leds_button(index);
        char line[PK_LOG_LINE_MAX];
        snprintf(line, sizeof(line),
                 "{\"event\":\"button\",\"source\":\"pico\",\"label\":\"%c\",\"dispatched\":false}", 'A' + index);
        pk_log_event(line);
        s_render_requested = true;
    }
}

static void gather_requests(void)
{
    pk_platform_sample();
    poll_buttons();
    if (pk_console_take_render_request()) s_render_requested = true;
    switch (pk_httpd_take_action()) {
        case PK_HTTPD_ACTION_RENDER:
            s_render_requested = true;
            break;
        case PK_HTTPD_ACTION_RESTART:
            pk_wait_ms(1000); // let the response leave first
            pk_reboot();
            break;
        default:
            break;
    }
    // The RTC keeps what SNTP said, for the next cold boot.
    if (pk_time_take_sntp_update()) pk_rtc_write_epoch(pk_epoch_or_zero());
}

static bool somebody_is_here(void)
{
    uint32_t console = pk_console_last_activity_ms();
    return console != 0 && now_ms() - console < KEEP_AWAKE_MS;
}

// For the wait-in-place of a USB-powered "deep sleep": anything a person
// does ends it.
static bool sleep_should_end(void)
{
    gather_requests();
    return s_render_requested || somebody_is_here();
}

static void run_portal(void)
{
    const pk_config_t *config = pk_config();
    if (!pk_wifi_start_portal()) return;
    pk_httpd_start();
    pk_leds_connection(PK_LED_BLINK);
    pk_render_show_portal_screen(pk_wifi_portal_ssid(), pk_wifi_portal_psk(), PK_HOTSPOT_IP_STRING);
    pk_leds_activity(PK_LED_OFF);
    uint32_t started = now_ms();
    for (;;) {
        pk_poll();
        gather_requests();
        s_render_requested = false; // nothing to render from in here
        if (pk_config_wifi_ready()) {
            // The saved network may only have been down for a moment.
            uint32_t client = pk_wifi_portal_last_activity_ms();
            uint32_t quiet_since = client > started ? client : started;
            if (now_ms() - quiet_since > PORTAL_RETRY_MS && !somebody_is_here()) {
                pk_logf("wifi: retrying \"%s\"", config->wifi_ssid);
                pk_reboot();
            }
        }
        sleep_ms(1);
    }
}

static void show_render_problem(pk_render_result_t result)
{
    const pk_config_t *config = pk_config();
    char address[64];
    snprintf(address, sizeof(address), "This frame: http://%s/", pk_wifi_ip());
    if (result == PK_RENDER_NOT_CONFIGURED) {
        if (pk_config_backend_ready()) return; // no panel selected: nothing to draw on
        pk_render_show_message("On Wi-Fi, not linked to a backend yet",
                               "Open the frame in FrameOS and connect it over USB,", "or fill in the form at",
                               address);
    } else if (!pk_render_panel_shows_scene()) {
        // Only while the glass holds no picture: once it does, a backend that
        // is briefly unreachable is no reason to replace it.
        pk_render_show_message("Cannot get a picture from the backend", config->backend_url,
                               pk_render_stats()->last_error, address);
    }
}

int main(void)
{
    pk_config_load();
    pk_config_t *config = pk_config();
    // Inky Frame power latch: on battery the 3V3 rail only stays up while
    // HOLD_VSYS_EN (GP2) is driven high — assert it before anything else,
    // or the board powers off the moment the wake source de-asserts.
    if (config->pins.hold_vsys >= 0) {
        gpio_init(config->pins.hold_vsys);
        gpio_set_dir(config->pins.hold_vsys, GPIO_OUT);
        gpio_put(config->pins.hold_vsys, 1);
    }
    // Next, before the finger lifts: which button (or the RTC) woke us.
    uint8_t wake_bits = has_shift_register() ? pk_shiftreg_read(&config->pins) : 0;
    s_buttons_last = wake_bits & SR_BUTTON_MASK;

    stdio_init_all();
    pk_log_init(pk_epoch_or_zero, pk_console_print_line);
    pk_leds_init();
    pk_leds_activity(PK_LED_ON);
    pk_render_init();
    pk_rtc_init();
    pk_time_seed(pk_rtc_read_epoch());
    s_next_button_poll = get_absolute_time();

    printf("\nFrameOS Pico thin client %s (%s)\nframeos> ", FRAMEOS_VERSION, pk_platform_name());
    if (has_shift_register()) log_wake(wake_bits);

    pk_platform_start_watchdog();
    if (!pk_wifi_init()) {
        // No radio, no product; the console still works for a diagnosis.
        for (;;) {
            pk_poll();
            sleep_ms(5);
        }
    }

    pk_platform_sample(); // VBUS: on battery or not decides what follows
    if (!pk_config_wifi_ready() || !pk_wifi_connect(WIFI_CONNECT_TIMEOUT_MS)) {
        // A provisioned frame running off its cells does not open a hotspot
        // because the router blinked: five minutes of access point per wake
        // would empty them in a day. It keeps its picture, sleeps the interval
        // out and tries again. On USB power (somebody is at the desk) and on
        // a board with no network at all, the hotspot is the way in.
        bool battery_sleeper = pk_config_wifi_ready() && pk_config_backend_ready() &&
                               (config->deep_sleep || config->deep_sleep_on_battery) &&
                               !pk_usb_powered() && pk_rtc_present() && config->pins.hold_vsys >= 0;
        if (battery_sleeper) {
            pk_logf("wifi: no network on battery, sleeping %lus before the next try",
                    (unsigned long)config->interval_seconds);
            pk_rtc_sleep(config->interval_seconds, sleep_should_end);
            // Still here: USB power arrived, or somebody is at the console.
            pk_reboot();
        }
        run_portal(); // never returns: it ends in a reboot
    }
    pk_leds_connection(PK_LED_ON);
    pk_time_start_sntp();
    pk_wifi_start_mdns();
    pk_httpd_start();
    log_bootup();
    pk_leds_activity(PK_LED_OFF);

    absolute_time_t next_render = get_absolute_time(); // render once at boot
    uint32_t offline_since = 0;
    unsigned busy_retries = 0;
    absolute_time_t next_reconnect = get_absolute_time();
    for (;;) {
        pk_poll();
        gather_requests();

        if (!pk_wifi_connected()) {
            pk_leds_connection(PK_LED_BLINK);
            if (offline_since == 0) offline_since = now_ms() ? now_ms() : 1;
            if (now_ms() - offline_since > WIFI_OFFLINE_REBOOT_MS && !somebody_is_here()) {
                pk_logf("wifi: offline for %u minutes, restarting", WIFI_OFFLINE_REBOOT_MS / 60000u);
                pk_reboot();
            }
            if (absolute_time_diff_us(get_absolute_time(), next_reconnect) <= 0) {
                if (pk_wifi_connect(WIFI_CONNECT_TIMEOUT_MS)) offline_since = 0;
                next_reconnect = make_timeout_time_ms(WIFI_RECONNECT_EVERY_MS);
            }
            sleep_ms(1);
            continue;
        }
        offline_since = 0;
        pk_leds_connection(PK_LED_ON);

        bool due = absolute_time_diff_us(get_absolute_time(), next_render) <= 0;
        if (!due && !s_render_requested) {
            sleep_ms(1);
            continue;
        }
        s_render_requested = false;

        pk_render_sync_settings();
        uint32_t retry_after = 0;
        pk_render_result_t result = pk_render_once(&retry_after);
        uint32_t wait_seconds = config->interval_seconds;
        // A backend whose queue stays full must not keep a battery frame
        // awake: after a few polite retries it counts as a failed pass.
        if (result == PK_RENDER_RETRY_LATER && ++busy_retries > MAX_BUSY_RETRIES) {
            result = PK_RENDER_FAILED;
        }
        if (result != PK_RENDER_RETRY_LATER) busy_retries = 0;
        if (result == PK_RENDER_RETRY_LATER) {
            wait_seconds = retry_after < wait_seconds ? retry_after : wait_seconds;
        } else if (result == PK_RENDER_FAILED || result == PK_RENDER_NOT_CONFIGURED) {
            show_render_problem(result);
            if (wait_seconds > FAILED_RENDER_RETRY_SECONDS) wait_seconds = FAILED_RENDER_RETRY_SECONDS;
        }

        // Battery mode. A failed pass sleeps the full interval all the same:
        // retrying every minute against a backend that is down would empty
        // the cells for nothing.
        bool sleep_wanted = config->deep_sleep || (config->deep_sleep_on_battery && !pk_usb_powered());
        bool can_sleep = pk_rtc_present() && config->pins.hold_vsys >= 0;
        if (sleep_wanted && can_sleep && pk_config_backend_ready() && result != PK_RENDER_RETRY_LATER &&
            !somebody_is_here()) {
            char line[PK_LOG_LINE_MAX];
            snprintf(line, sizeof(line),
                     "{\"event\":\"sleep\",\"source\":\"pico\",\"wakeInSeconds\":%lu,\"onBattery\":%s}",
                     (unsigned long)config->interval_seconds, pk_usb_powered() ? "false" : "true");
            pk_log_event(line);
            pk_render_flush_logs();
            pk_rtc_sleep(config->interval_seconds, sleep_should_end);
            // Still here: USB power. Carry on as if freshly woken.
            next_render = get_absolute_time();
            continue;
        }

        pk_render_flush_logs();
        if (wait_seconds > 4000000u) wait_seconds = 4000000u; // make_timeout_time_ms takes 32 bits
        next_render = make_timeout_time_ms(wait_seconds * 1000u);
    }
}
