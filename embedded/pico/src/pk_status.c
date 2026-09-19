#include "pk_status.h"

#include <stdio.h>
#include <string.h>

#include "pk_config.h"
#include "pk_config_keys.h"
#include "pk_display.h"
#include "pk_json.h"
#include "pk_platform.h"
#include "pk_render.h"
#include "pk_rtc.h"
#include "pk_time.h"
#include "pk_wifi.h"

// Same numbering the ESP32 reports (fos_wifi_state_t): 0 idle, 1 connecting,
// 2 connected, 3 portal.
static int wifi_state(void)
{
    if (pk_wifi_portal_active()) return 3;
    if (pk_wifi_connected()) return 2;
    return pk_config_wifi_ready() ? 1 : 0;
}

// Whether GET /image has something to serve.
static bool preview_ready(void)
{
    int format, width, height;
    return pk_render_framebuffer(&format, &width, &height) != NULL;
}

size_t pk_status_json(char *dst, size_t cap)
{
    const pk_config_t *config = pk_config();
    const pk_render_stats_t *render = pk_render_stats();
    const pk_panel_t *panel = pk_display_current();

    // ~2 KB of scratch: static, because GET /status runs inside an lwIP
    // callback that may itself sit on top of a render pass's stack.
    static char panel_key[PK_STR_LEN * 2], preset[PK_STR_LEN * 2], backend[PK_URL_LEN * 2];
    static char ssid[PK_STR_LEN * 2], hostname[PK_NAME_LEN * 2], name[PK_NAME_LEN * 2];
    static char pins[160], pins_json[200], error[200];
    pk_json_escape(config->panel, panel_key, sizeof(panel_key));
    pk_json_escape(config->hardware_preset, preset, sizeof(preset));
    pk_json_escape(config->backend_url, backend, sizeof(backend));
    pk_json_escape(config->wifi_ssid, ssid, sizeof(ssid));
    pk_json_escape(config->hostname, hostname, sizeof(hostname));
    pk_json_escape(config->name, name, sizeof(name));
    pk_config_format_pins(&config->pins, pins, sizeof(pins));
    pk_json_escape(pins, pins_json, sizeof(pins_json));
    pk_json_escape(render->last_error, error, sizeof(error));

    // The shape the browser's USB flow and the ESP32's /status share
    // (EmbeddedUsbStatus in frontend/src/models/embeddedUsbLogsModel.ts). The
    // cloud block is constant: this firmware has no FrameOS Cloud link.
    int written = snprintf(
        dst, cap,
        "{\"app\":\"frameos-pico\",\"version\":\"%s\",\"uptimeSec\":%lu,"
        "\"board\":{\"target\":\"%s\",\"module\":\"%s\",\"display\":\"%s\"},"
        "\"memory\":{\"free\":%lu,\"framebufferBytes\":%lu},"
        "\"ota\":{\"supported\":false},"
        "\"wifi\":{\"state\":%d,\"ip\":\"%s\",\"rssi\":%d,\"timeSynced\":%s,\"hostname\":\"%s\"},"
        "\"power\":{\"usbPowered\":%s,\"rtc\":%s},"
        "\"render\":{\"count\":%lu,\"passes\":%lu,\"lastMs\":%lu,\"lastRefreshSkipped\":%s,"
        "\"busy\":%s,\"previewReady\":%s,\"lastError\":\"%s\"},"
        "\"scenes\":{\"loaded\":0,\"available\":0,\"hasScene\":false},"
        "\"cloud\":{\"state\":\"unsupported\",\"url\":\"\",\"frameId\":\"\",\"wsConnected\":false,"
        "\"error\":\"\"},"
        "\"config\":{\"frameId\":%lu,\"name\":\"%s\",\"panel\":\"%s\",\"hardwarePreset\":\"%s\","
        "\"renderMode\":\"remote\",\"intervalSec\":%lu,\"serverSendLogs\":%s,"
        "\"deepSleep\":%s,\"deepSleepOnBattery\":%s,\"adminAuth\":%s,\"pins\":\"%s\","
        "\"backendUrl\":\"%s\",\"wifiSsid\":\"%s\"}}",
        FRAMEOS_VERSION, (unsigned long)pk_uptime_seconds(), pk_platform_name(),
        preset[0] ? preset : pk_platform_name(), panel ? panel->name : "none",
        (unsigned long)pk_free_heap(), (unsigned long)PK_FRAMEBUFFER_BYTES, wifi_state(),
        pk_wifi_ip(), pk_wifi_rssi_cached(), pk_time_synced() ? "true" : "false", hostname,
        pk_usb_powered() ? "true" : "false", pk_rtc_present() ? "true" : "false",
        (unsigned long)render->count, (unsigned long)render->passes, (unsigned long)render->last_ms,
        render->last_refresh_skipped ? "true" : "false", render->busy ? "true" : "false",
        preview_ready() ? "true" : "false", error,
        (unsigned long)config->frame_id, name, panel_key, preset,
        (unsigned long)config->interval_seconds, config->send_logs ? "true" : "false",
        config->deep_sleep ? "true" : "false", config->deep_sleep_on_battery ? "true" : "false",
        config->admin_auth ? "true" : "false", pins_json, backend, ssid);
    if (written < 0 || (size_t)written >= cap) {
        if (cap) dst[0] = '\0';
        return 0;
    }
    return (size_t)written;
}
