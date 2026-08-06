// FrameOS thin client for Raspberry Pi Pico W / Pico 2 W.
//
// Boot: load config → bring up WiFi → poll the backend's
// /api/frames/{id}/embedded/render endpoint on the configured interval and
// stream the FOSB payload straight into the e-paper controller. The USB CDC
// console provisions everything (same command surface as the ESP32 build).
#include <stdio.h>
#include <string.h>

#include "hardware/gpio.h"
#include "pico/stdlib.h"

#include "pk_config.h"
#include "pk_console.h"
#include "pk_display.h"
#include "pk_http.h"
#include "pk_wifi.h"

#define WIFI_CONNECT_TIMEOUT_MS 30000

// FOSB header: magic "FOSB", version u8, format u8, width u16le,
// height u16le, reserved u16le. Payload follows.
#define FOSB_HEADER_LEN 12

typedef struct {
    const pk_panel_t *panel;
    const pk_pins_t *pins;
    uint8_t header[FOSB_HEADER_LEN];
    size_t header_len;
    size_t payload_expected;
    size_t payload_written;
    bool begun;
    bool failed;
} fosb_sink_t;

static size_t fosb_payload_size(const pk_panel_t *panel)
{
    switch (panel->format) {
        case PK_PIXEL_1BPP:
            return ((size_t)(panel->width + 7) / 8) * (size_t)panel->height;
        case PK_PIXEL_2BPP_GRAY:
            return ((size_t)(panel->width + 3) / 4) * (size_t)panel->height;
        case PK_PIXEL_4BPP_7COLOR:
        case PK_PIXEL_4BPP_SPECTRA6:
            return ((size_t)(panel->width + 1) / 2) * (size_t)panel->height;
        default:
            return 0;
    }
}

static bool fosb_sink(void *arg, const uint8_t *data, size_t len)
{
    fosb_sink_t *sink = arg;
    if (sink->failed) return false;

    if (sink->header_len < FOSB_HEADER_LEN) {
        size_t take = FOSB_HEADER_LEN - sink->header_len;
        if (take > len) take = len;
        memcpy(sink->header + sink->header_len, data, take);
        sink->header_len += take;
        data += take;
        len -= take;
        if (sink->header_len < FOSB_HEADER_LEN) return true;

        if (memcmp(sink->header, "FOSB", 4) != 0 || sink->header[4] != 1) {
            printf("render: not a FOSB v1 payload\n");
            sink->failed = true;
            return false;
        }
        int format = sink->header[5];
        int width = sink->header[6] | (sink->header[7] << 8);
        int height = sink->header[8] | (sink->header[9] << 8);
        if (format != sink->panel->format || width != sink->panel->width ||
            height != sink->panel->height) {
            printf("render: payload %dx%d fmt %d does not match panel %s "
                   "(%dx%d fmt %d) — check the frame's device setting\n",
                   width, height, format, sink->panel->name,
                   sink->panel->width, sink->panel->height, sink->panel->format);
            sink->failed = true;
            return false;
        }
        if (!sink->panel->begin(sink->panel, sink->pins)) {
            printf("render: panel init failed (busy timeout?)\n");
            sink->failed = true;
            return false;
        }
        sink->begun = true;
    }

    if (len > 0) {
        size_t room = sink->payload_expected - sink->payload_written;
        if (len > room) len = room; // ignore trailing bytes
        sink->panel->write(data, len);
        sink->payload_written += len;
    }
    return true;
}

static void render_once(void)
{
    pk_config_t *config = pk_config();
    if (!pk_config_backend_ready()) {
        printf("render: backend not configured (set backend/frame_id/api_key)\n");
        return;
    }
    const pk_panel_t *panel = pk_display_find(config->panel);
    if (panel == NULL) {
        printf("render: no panel selected (set panel <key> or set hardware <preset>)\n");
        return;
    }
    if (!pk_wifi_connected() && !pk_wifi_connect(WIFI_CONNECT_TIMEOUT_MS)) {
        return;
    }

    char url[PK_URL_LEN + 64];
    snprintf(url, sizeof(url), "%s/api/frames/%lu/embedded/render",
             config->backend_url, (unsigned long)config->frame_id);

    fosb_sink_t sink = {
        .panel = panel,
        .pins = &config->pins,
        .payload_expected = fosb_payload_size(panel),
    };
    pk_http_request_t request = {
        .url = url,
        .bearer_token = config->api_key,
        .timeout_ms = 120000,
        .sink = fosb_sink,
        .sink_arg = &sink,
    };
    printf("render: GET %s\n", url);
    pk_http_result_t result = pk_http_get(&request);
    if (result.status != 200) {
        printf("render: HTTP %d\n", result.status);
        return;
    }
    if (sink.failed || !sink.begun || sink.payload_written != sink.payload_expected) {
        printf("render: incomplete payload (%u of %u bytes)\n",
               (unsigned)sink.payload_written, (unsigned)sink.payload_expected);
        return;
    }
    printf("render: refreshing panel\n");
    if (panel->end(&config->pins)) {
        printf("render: done\n");
    } else {
        printf("render: refresh timed out\n");
    }
}

int main(void)
{
    pk_config_load();
    // Inky Frame power latch: on battery the 3V3 rail only stays up while
    // HOLD_VSYS_EN (GP2) is driven high — assert it before anything else,
    // or the board powers off the moment the wake source de-asserts.
    if (pk_config()->pins.hold_vsys >= 0) {
        gpio_init(pk_config()->pins.hold_vsys);
        gpio_set_dir(pk_config()->pins.hold_vsys, GPIO_OUT);
        gpio_put(pk_config()->pins.hold_vsys, 1);
    }
    stdio_init_all();
    pk_wifi_init();

    printf("\nFrameOS Pico thin client %s\nframeos> ", FRAMEOS_VERSION);

    if (pk_config_wifi_ready()) {
        pk_wifi_connect(WIFI_CONNECT_TIMEOUT_MS);
    }

    absolute_time_t next_render = get_absolute_time(); // render once at boot
    for (;;) {
        bool render_requested = pk_console_poll();
        if (render_requested ||
            absolute_time_diff_us(get_absolute_time(), next_render) < 0) {
            render_once();
            next_render = make_timeout_time_ms(pk_config()->interval_seconds * 1000);
        }
        sleep_ms(20);
    }
}
