/*
 * The frame page of the settings panel on the screen, behind its gear
 * (system/sceneSettings, docs/scene-settings.md "The frame page"): the facts
 * the page shows (Wi-Fi, address, who manages the frame, the version, the
 * rotation and render scale, what the frame is: `about`) and what it sets
 * (the Wi-Fi network, the rotation, the scale). The page has the words; this
 * file has the facts.
 *
 * The Nim scene asks through three hooks (embedded_runtime.nim); every call
 * comes on the render task, under the runtime lock. What the page shows
 * changes under it (a join, a scan), and main.c renders the panel again when
 * it does (fos_wifi_set_change_hook, fos_scenes_settings_shown).
 */
#include "fos_restart.h"
#include "fos_frame_settings.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_flash.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_spiffs.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "nvs.h"

#include "fos_assets_sd.h"
#include "fos_board.h"
#include "fos_buzzer.h"
#include "fos_bt.h"
#include "fos_client.h"
#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_cpu.h"
#include "fos_lan_access.h"
#include "fos_mem.h"
#include "fos_ota.h"
#include "fos_rtc.h"
#include "fos_scenes.h"
#include "fos_settings.h"
#include "fos_wifi.h"
#include "frameos_nim.h"

static const char *TAG = "fos_frame_settings";

/* A scan when the tab comes up off Wi-Fi, unless one is this fresh. */
#define SCAN_FRESH_US (30LL * 1000000)

/* The page asks for an update check when it opens, unless one is this fresh. */
#define UPDATE_CHECK_FRESH_S 3600

/* What the last Save could not do, for the tab's first note; "" = nothing.
 * Render task only. */
static char s_refused[96] = "";

/* Who manages the frame: a plane that adopts what is set here (the cloud's
 * mirror from the hardware report, a backend from the `settings:frame` line).
 * NULL = nobody. */
static const char *manager(void)
{
    const fos_config_t *config = fos_config();
    if (config->backend_url[0]) return "FrameOS backend";
    if (config->cloud_url[0] && fos_cloud_state() != FOS_CLOUD_NONE) return "FrameOS Cloud";
    return NULL;
}

/* The page's facts as JSON, written as text: the keys are literals, and what
 * the frame says (a network's name) is escaped on its way in. A buffer of
 * JSON_CAP holds the worst case: every name in range and the saved one, 32
 * bytes each, every byte escaped to \u00XX, a link code with its QR text,
 * its server and why it failed, and the About facts (the server, the preset,
 * the panel and the host name escaped). */
#define JSON_CAP (1536 + (FOS_URL_LEN * 2 + 64) * 6 + 3 * FOS_STR_LEN * 6 + (FOS_WIFI_SCAN_MAX + 1) * (32 * 6 + 4) + \
                  BT_FACTS_CAP)
/* The Bluetooth section (fos_bt_facts_json): four bonds, each name escaped. */
#define BT_FACTS_CAP 1280

typedef struct {
    char *buf;
    size_t len;
} out_t;

static void put(out_t *out, const char *text)
{
    size_t n = strlen(text);
    if (out->len + n < JSON_CAP) {
        memcpy(out->buf + out->len, text, n + 1);
        out->len += n;
    }
}

static void put_string(out_t *out, const char *text)
{
    char one[8];
    put(out, "\"");
    for (const unsigned char *c = (const unsigned char *)text; *c; c++) {
        if (*c == '"' || *c == '\\') snprintf(one, sizeof(one), "\\%c", *c);
        else if (*c < 0x20) snprintf(one, sizeof(one), "\\u%04x", *c);
        else snprintf(one, sizeof(one), "%c", *c);
        put(out, one);
    }
    put(out, "\"");
}

static void trim_comma(out_t *out)
{
    if (out->len > 0 && out->buf[out->len - 1] == ',') out->buf[--out->len] = '\0';
}

/* `,"key":"text"` */
static void put_pair(out_t *out, const char *key, const char *text)
{
    put(out, ",\"");
    put(out, key);
    put(out, "\":");
    put_string(out, text);
}

/* What the frame is, for the page's About card (docs/scene-settings.md
 * "About"): numbers as they are, bytes as bytes ([total, free] for what
 * fills), the frame id as text; the page has the words and the units. */
static void put_about(out_t *out, const fos_config_t *config)
{
    char line[256];
    size_t state_total = 0, state_used = 0;
    esp_spiffs_info("state", &state_total, &state_used);
    uint32_t flash = 0;
    esp_flash_get_size(NULL, &flash);
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    char build[9];
    esp_app_get_elf_sha256(build, sizeof(build));
    snprintf(line, sizeof(line),
             ",\"about\":{\"chip\":\"%s\",\"cores\":%d,\"mhz\":%d,\"memory\":[%u,%u],\"flash\":%lu,"
             "\"storage\":[%u,%u],\"uptime\":%lld,\"mac\":\"%02x:%02x:%02x:%02x:%02x:%02x\",\"build\":\"%s\"",
             fos_board_target(), portNUM_PROCESSORS, fos_cpu_mhz(),
             (unsigned)heap_caps_get_total_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned long)flash, (unsigned)state_total,
             (unsigned)(state_total - state_used), esp_timer_get_time() / 1000000, mac[0], mac[1], mac[2], mac[3],
             mac[4], mac[5], build);
    put(out, line);
    size_t psram = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);
    if (psram > 0) {
        snprintf(line, sizeof(line), ",\"psram\":[%u,%u]", (unsigned)psram,
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
        put(out, line);
    }
    if (fos_assets_sd_mounted()) {
        snprintf(line, sizeof(line), ",\"card\":%llu", (unsigned long long)fos_assets_sd_capacity_bytes());
        put(out, line);
    }
    if (config->frame_id) {
        snprintf(line, sizeof(line), ",\"frameId\":\"%lu\"", (unsigned long)config->frame_id);
        put(out, line);
    }
    if (config->hardware_preset[0]) put_pair(out, "board", config->hardware_preset);
    put_pair(out, "display", config->panel);
    if (config->hostname[0]) put_pair(out, "hostname", config->hostname);
    /* Where the plane that manages it is. */
    if (config->backend_url[0]) put_pair(out, "server", config->backend_url);
    else if (manager() != NULL) put_pair(out, "server", config->cloud_url);
    put(out, "}");
}

char *fos_frame_settings_json(void)
{
    /* Turned off by the frame's control plane, and not unlocked on the
     * device: no page, no gear. */
    if (!fos_config_frame_page_offered()) return NULL;
    const fos_config_t *config = fos_config();
    out_t out = {.buf = fos_big_malloc(JSON_CAP), .len = 0};
    if (out.buf == NULL) return NULL;
    out.buf[0] = '\0';
    fos_wifi_state_t state = fos_wifi_state();
    const char *ssid = config->wifi_ssid;
    uint8_t reason = fos_wifi_join_reason();
    const char *word = state == FOS_WIFI_CONNECTED                ? "connected"
                       : state == FOS_WIFI_PORTAL                 ? "hotspot"
                       : !ssid[0]                                 ? "unset"
                       : fos_wifi_join_reason_not_found(reason)   ? "notFound"
                       : fos_wifi_join_reason_auth(reason)        ? "auth"
                       : state == FOS_WIFI_CONNECTING             ? "connecting"
                                                                  : "off";
    char line[96];
    put(&out, "{\"wifi\":{\"state\":\"");
    put(&out, word);
    put(&out, "\"");
    put_pair(&out, "ssid", ssid);
    if (state == FOS_WIFI_PORTAL) put_pair(&out, "hotspot", fos_wifi_ap_ssid());
    if (state == FOS_WIFI_CONNECTED) {
        snprintf(line, sizeof(line), ",\"rssi\":%d", fos_wifi_rssi());
        put(&out, line);
        put_pair(&out, "ip", fos_wifi_ip());
    }
    /* The networks in range, by name (the scan sorted them). */
    put(&out, ",\"networks\":[");
    fos_wifi_network_t *networks = fos_big_malloc(FOS_WIFI_SCAN_MAX * sizeof(*networks));
    int count = networks ? fos_wifi_scan_results(networks, FOS_WIFI_SCAN_MAX) : 0;
    for (int i = 0; i < count; i++) {
        put_string(&out, networks[i].ssid);
        put(&out, ",");
    }
    free(networks);
    trim_comma(&out);
    snprintf(line, sizeof(line), "],\"scanning\":%s,\"password\":%s},\"rotate\":%u,\"renderScale\":%g",
             fos_wifi_scanning() ? "true" : "false", config->wifi_pass[0] ? "true" : "false",
             (unsigned)config->rotate, config->render_scale_milli / 1000.0);
    put(&out, line);
    /* A glass whose level the client sets (fos_client_brightness_now: never
     * on one that cannot dim) offers its brightness; the page has the words. */
    if (fos_client_brightness_now() >= 0) {
        snprintf(line, sizeof(line), ",\"brightness\":%u", (unsigned)config->brightness);
        put(&out, line);
    }
    /* A frame that makes sounds (a buzzer, a codec's speaker, an LED that
     * follows them) offers its Tap and click sounds; the page has the words. */
    if (fos_buzzer_sounds()) {
        put_pair(&out, "clickSounds", fos_config_click_sounds_name(config->click_sounds));
    }
    /* A frame that deep-sleeps offers how long a tap keeps it up; the page
     * has the words. */
    if (config->deep_sleep || config->deep_sleep_on_battery) {
        snprintf(line, sizeof(line), ",\"awakeAfterInputSeconds\":%lu", (unsigned long)config->awake_after_input_sec);
        put(&out, line);
    }
    int battery = fos_client_battery_percent();
    if (battery >= 0) {
        snprintf(line, sizeof(line), ",\"battery\":{\"percent\":%d}", battery);
        put(&out, line);
    }
    if (manager() != NULL) put_pair(&out, "managedBy", manager());
    put_pair(&out, "version", esp_app_get_description()->version);
    put_about(&out, config);
    /* The clock in the frame's own time zone; empty while it is not set.
     * Not strftime, which alone brings 12 KB of libc. */
    time_t now = time(NULL);
    struct tm local;
    localtime_r(&now, &local);
    if (now > 1000000000) {
        snprintf(line, sizeof(line), ",\"clock\":\"%04d-%02d-%02d %02d:%02d\"", local.tm_year + 1900, local.tm_mon + 1,
                 local.tm_mday, local.tm_hour, local.tm_min);
        put(&out, line);
    } else {
        put(&out, ",\"clock\":\"\"");
    }
    if (fos_ota_has_control_plane()) {
        char version[32];
        snprintf(line, sizeof(line), ",\"updateState\":%d", (int)fos_ota_check_state(version, sizeof(version)));
        put(&out, line);
        if (version[0]) put_pair(&out, "updateVersion", version);
    }
    if (s_refused[0]) put_pair(&out, "note", s_refused);
    /* A control plane being connected (docs/scene-settings.md "Connecting
     * the frame"): its code, where to enter it and what its QR code says, for
     * the page to show. The page is the only place either code is drawn, and
     * no picture is kept while one shows (fos_client.c store_snapshot). */
    char code[16], uri[192], pin[FOS_LAN_ACCESS_CODE_LEN + 1];
    const bool cloud = fos_cloud_link_code(code, sizeof(code), uri, sizeof(uri));
    const bool adopt = fos_lan_access_panel_code(fos_lan_access_now(), FOS_LAN_ACCESS_SCOPE_ADOPT, pin) != 0;
    if (adopt) {
        /* Port 80: the address alone. The QR code holds both, to paste. */
        put(&out, ",\"link\":{\"to\":\"backend\",\"code\":");
        put_string(&out, pin);
        put_pair(&out, "where", fos_wifi_ip());
        snprintf(line, sizeof(line), "%s %s", fos_wifi_ip(), pin);
        put_pair(&out, "qr", line);
        put(&out, "}");
    } else if (cloud) {
        put(&out, ",\"link\":{\"to\":\"cloud\",\"code\":");
        put_string(&out, code);
        put_pair(&out, "qr", uri);
        const char *where = strstr(uri, "://");
        uri[strcspn(uri, "?")] = '\0';
        put_pair(&out, "where", where ? where + 3 : uri);
        /* Where it goes, which the page shows and lets be changed, and why
         * it stopped if it did. */
        put_pair(&out, "server", fos_cloud_link_server());
        char detail[64];
        const char *failed = fos_cloud_link_failure(detail, sizeof(detail));
        if (failed) {
            put_pair(&out, "failed", failed);
            put_pair(&out, "detail", detail);
        }
        put(&out, "}");
    }
    out.len += fos_bt_facts_json(out.buf + out.len, JSON_CAP - out.len);
    /* Restart is a reboot here: the page shows Reboot alone. Connecting is
     * offered to a frame no plane holds, online, with nothing pending. */
    put(&out, ",\"actions\":[");
    if (!cloud && !adopt && !config->backend_url[0] && fos_cloud_state() != FOS_CLOUD_ENROLLED &&
        fos_cloud_state() != FOS_CLOUD_PENDING && state == FOS_WIFI_CONNECTED) {
        put(&out, "\"linkCloud\",\"adopt\"");
    } else if (config->backend_url[0] || fos_cloud_state() == FOS_CLOUD_ENROLLED) {
        /* Leaving the plane that manages it (the page asks twice). */
        put(&out, "\"unlink\"");
    }
    put(&out, "]}");
    return out.buf;
}

static void restart_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(1500)); /* the log line goes out first */
    /* After the page's own redraw (the render task serves the notice from its
     * wait): a reTerminal Sticky going blank without a word for ten seconds
     * after Save looked like a crash (2026-11-22). */
    fos_restart_notice("Restarting...");
    esp_restart();
}

/* One `settings:frame` line for what was saved, with the values a control
 * plane adopts (a backend reads it from the log, app/models/log.py; the cloud
 * follows the hardware report instead). Never the network's name. */
static void log_applied(const char *changes, bool rotate, bool scale, bool sounds, bool awake, bool bright)
{
    const fos_config_t *config = fos_config();
    char line[288];
    int n = snprintf(line, sizeof(line), "{\"event\":\"settings:frame\",\"source\":\"esp32\",\"origin\":\"panel\","
                     "\"changes\":\"%s\"", changes);
    if (rotate && n > 0 && n < (int)sizeof(line)) {
        n += snprintf(line + n, sizeof(line) - n, ",\"rotate\":%u", (unsigned)config->rotate);
    }
    if (scale && n > 0 && n < (int)sizeof(line)) {
        n += snprintf(line + n, sizeof(line) - n, ",\"renderScale\":%g", config->render_scale_milli / 1000.0);
    }
    if (sounds && n > 0 && n < (int)sizeof(line)) {
        n += snprintf(line + n, sizeof(line) - n, ",\"clickSounds\":\"%s\"",
                      fos_config_click_sounds_name(config->click_sounds));
    }
    if (awake && n > 0 && n < (int)sizeof(line)) {
        n += snprintf(line + n, sizeof(line) - n, ",\"awakeAfterInputSeconds\":%lu",
                      (unsigned long)config->awake_after_input_sec);
    }
    if (bright && n > 0 && n < (int)sizeof(line)) {
        n += snprintf(line + n, sizeof(line) - n, ",\"brightness\":%u", (unsigned)config->brightness);
    }
    if (n > 0 && n < (int)sizeof(line) - 1) strlcat(line, "}", sizeof(line));
    frameos_nim_log_hook(line);
}

void fos_frame_settings_apply(const char *json)
{
    cJSON *root = json ? cJSON_Parse(json) : NULL;
    if (!cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return;
    }
    fos_config_t *config = fos_config();
    bool wifi = false, restart = false, scale = false;
    char changes[112] = "";
    s_refused[0] = '\0';

    const cJSON *ssid = cJSON_GetObjectItem(root, "wifiSsid");
    const cJSON *pass = cJSON_GetObjectItem(root, "wifiPassword");
    const char *new_ssid = cJSON_IsString(ssid) ? ssid->valuestring : config->wifi_ssid;
    const char *new_pass = cJSON_IsString(pass) ? pass->valuestring : "";
    if (!cJSON_IsString(ssid) && !cJSON_IsString(pass)) {
        /* No network on this Save. */
    } else if (new_ssid[0] && strlen(new_ssid) <= 32 && strlen(new_pass) < sizeof(config->wifi_pass) &&
               (new_pass[0] == '\0' || strlen(new_pass) >= 8)) {
        if (strcmp(new_ssid, config->wifi_ssid) != 0) {
            /* Another network: its password, or none (an open one). */
            strlcpy(config->wifi_ssid, new_ssid, sizeof(config->wifi_ssid));
            strlcpy(config->wifi_pass, new_pass, sizeof(config->wifi_pass));
            wifi = true;
        } else if (new_pass[0] && strcmp(new_pass, config->wifi_pass) != 0) {
            strlcpy(config->wifi_pass, new_pass, sizeof(config->wifi_pass));
            wifi = true;
        } else if (fos_wifi_state() != FOS_WIFI_CONNECTED) {
            /* The same again on a frame that is off it: try now. */
            wifi = true;
        }
    } else {
        strlcpy(s_refused,
                !new_ssid[0] || strlen(new_ssid) > 32 ? "A network name is 1 to 32 characters"
                                                      : "A password is 8 to 63 characters",
                sizeof(s_refused));
        ESP_LOGW(TAG, "Wi-Fi refused: %s", s_refused);
    }

    /* The rotation and the scale, on a managed frame too: its plane adopts
     * them (docs/scene-settings.md "What a control plane learns"). */
    const cJSON *rotate = cJSON_GetObjectItem(root, "rotate");
    uint16_t value = 0;
    if (cJSON_IsNumber(rotate) && fos_config_normalize_rotate(rotate->valuedouble, &value) && value != config->rotate) {
        config->rotate = value;
        restart = true;
    }
    const cJSON *render_scale = cJSON_GetObjectItem(root, "renderScale");
    if (cJSON_IsNumber(render_scale) && fos_config_normalize_render_scale(render_scale->valuedouble, &value) &&
        value != config->render_scale_milli) {
        /* Live: fos_client.c hands the runtime the scale on every pass. */
        config->render_scale_milli = value;
        scale = true;
    }
    /* Tap and click sounds: live (fos_buzzer.c reads it at every click); the
     * planes adopt it like the rotation (the settings:frame line, the
     * hardware report). */
    const cJSON *click_sounds = cJSON_GetObjectItem(root, "clickSounds");
    uint8_t mode = 0;
    bool sounds = false;
    if (cJSON_IsString(click_sounds) && fos_config_parse_click_sounds(click_sounds->valuestring, &mode) &&
        mode != config->click_sounds) {
        config->click_sounds = mode;
        sounds = true;
    }
    /* How long a tap keeps a deep-sleeping frame up: live (fos_client.c reads
     * it every pass), adopted by the planes like the sounds. */
    const cJSON *awake_after = cJSON_GetObjectItem(root, "awakeAfterInputSeconds");
    bool awake = false;
    if (cJSON_IsNumber(awake_after) && awake_after->valuedouble >= 0 && awake_after->valuedouble <= 3600 &&
        (uint32_t)awake_after->valuedouble != config->awake_after_input_sec) {
        config->awake_after_input_sec = (uint32_t)awake_after->valuedouble;
        awake = true;
    }
    /* The glass's brightness: on the glass at once, saved unless a finger is
     * still dragging it (`live`): its lift, or a step, sends it again. */
    const cJSON *bright_pct = cJSON_GetObjectItem(root, "brightness");
    bool bright = false;
    if (cJSON_IsNumber(bright_pct) && bright_pct->valuedouble >= 5 && bright_pct->valuedouble <= 100) {
        config->brightness = (uint8_t)bright_pct->valuedouble;
        fos_client_apply_brightness();
        bright = !cJSON_IsTrue(cJSON_GetObjectItem(root, "live"));
    }
    /* The clock, in the frame's own time zone, and on the board's battery
     * clock too so the next cold boot starts right. */
    const cJSON *clock_text = cJSON_GetObjectItem(root, "clock");
    bool clock_changed = false;
    if (cJSON_IsString(clock_text)) {
        struct tm local;
        struct timeval set = {0};
        if (!fos_rtc_parse_clock(clock_text->valuestring, &local)) {
            strlcpy(s_refused, "Write the time as YYYY-MM-DD HH:MM", sizeof(s_refused));
        } else if ((set.tv_sec = mktime(&local)), settimeofday(&set, NULL) == 0) {
            fos_rtc_mark_dirty();
            clock_changed = true;
        }
    }
    /* The cloud's address, from the Connect page: where Link to cloud goes
     * (fos_cloud_link_server), "" for FrameOS Cloud's own. Only on a frame no
     * plane holds; a link under way starts over against it. */
    const cJSON *cloud_text = cJSON_GetObjectItem(root, "cloudUrl");
    bool cloud = false;
    if (cJSON_IsString(cloud_text) && !config->backend_url[0] && fos_cloud_state() == FOS_CLOUD_NONE) {
        char url[FOS_URL_LEN];
        const char *typed = cloud_text->valuestring;
        while (*typed == ' ') typed++;
        if (typed[0] && !strstr(typed, "://")) snprintf(url, sizeof(url), "https://%s", typed);
        else strlcpy(url, typed, sizeof(url));
        size_t n = strlen(url);
        while (n > 0 && (url[n - 1] == '/' || url[n - 1] == ' ')) url[--n] = '\0';
        const char *why = NULL;
        if (url[0] && !fos_cloud_url_transport_ok(url, &why)) {
            snprintf(s_refused, sizeof(s_refused), "The address %s", why ? why : "is not one");
        } else if (strcmp(url, config->cloud_url) != 0) {
            strlcpy(config->cloud_url, url, sizeof(config->cloud_url));
            cloud = true;
        }
    }
    /* Bluetooth on or off, at once (fos_bt_set_enabled). Kept on when the
     * stack cannot start now: it starts at the next boot, and the page says so. */
    const cJSON *bluetooth = cJSON_GetObjectItem(root, "bluetooth");
    bool bluetooth_changed = false;
    if (cJSON_IsBool(bluetooth) && cJSON_IsTrue(bluetooth) != config->bluetooth) {
        config->bluetooth = cJSON_IsTrue(bluetooth);
        bluetooth_changed = true;
        if (fos_bt_set_enabled(config->bluetooth) != ESP_OK) {
            strlcpy(s_refused, "Not enough memory for Bluetooth now: it starts at the next restart",
                    sizeof(s_refused));
        }
    }
    cJSON_Delete(root);

    if (cloud) strlcat(changes, "cloudUrl,", sizeof(changes));
    if (bluetooth_changed) strlcat(changes, "bluetooth,", sizeof(changes));
    if (clock_changed) strlcat(changes, "clock,", sizeof(changes));
    if (sounds) strlcat(changes, "clickSounds,", sizeof(changes));
    if (awake) strlcat(changes, "awakeAfterInputSeconds,", sizeof(changes));
    if (bright) strlcat(changes, "brightness,", sizeof(changes));
    if (wifi) strlcat(changes, "wifi,", sizeof(changes));
    if (restart) strlcat(changes, "rotate,", sizeof(changes));
    if (scale) strlcat(changes, "renderScale,", sizeof(changes));
    if (!changes[0]) return;
    changes[strlen(changes) - 1] = '\0';
    esp_err_t err = fos_config_save();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "frame settings not saved: %s", esp_err_to_name(err));
    }
    ESP_LOGI(TAG, "frame settings from the panel: %s", changes);
    log_applied(changes, restart, scale, sounds, awake, bright);
    if (restart || (wifi && fos_wifi_state() == FOS_WIFI_PORTAL)) {
        /* The runtime sizes its canvas at init (fos_settings.c does the same
         * for a rotation from a plane), and a frame on the setup hotspot
         * comes back without it, as the portal's own form does. The new
         * network is joined after it; the hello after it reports the
         * rotation. */
        if (xTaskCreate(restart_task, "fos_fs_restart", FOS_RESTART_TASK_STACK, NULL, 5, NULL) != pdPASS) esp_restart();
        return;
    }
    if (scale) {
        fos_cloud_request_state();
        fos_client_render_now();
    } else if (clock_changed || bluetooth_changed) {
        fos_client_render_now();
    }
    /* The cloud's mirror follows the hardware report (hardware.clickSounds). */
    if ((sounds || awake || bright) && !scale) fos_cloud_request_state();
    if (cloud) {
        /* The link on the page, under way or failed, starts over at the new
         * address. */
        char code[2], uri[2];
        if (fos_cloud_link_code(code, sizeof(code), uri, sizeof(uri))) fos_cloud_link_start();
        fos_client_render_now();
    }
    if (wifi) {
        err = fos_wifi_start_background();
        if (err != ESP_OK) ESP_LOGW(TAG, "joining \"%s\" failed to start: %s", config->wifi_ssid, esp_err_to_name(err));
    }
}

/* Wi-Fi changed (joined, lost, a failure, a scan): the panel says so, and is
 * drawn again if it is up. On a new address, a backend hears at once where the
 * frame is now (the commands pull reports it); a cloud session comes back by
 * itself with a hello that does. From the event or scan task: bits set, no
 * more. */
static void on_wifi_change(void)
{
    static char reported[16] = "";
    if (fos_scenes_settings_shown()) fos_client_render_now();
    if (fos_wifi_state() == FOS_WIFI_CONNECTED && strcmp(fos_wifi_ip(), reported) != 0) {
        strlcpy(reported, fos_wifi_ip(), sizeof(reported));
        fos_client_request_commands_sync();
    }
}

/* A Bluetooth device came or went, or pairing opened or closed: drawn again
 * if the page is up. From the Bluetooth host's task or a timer's. */
static void on_bt_change(void)
{
    if (fos_scenes_settings_shown()) fos_client_render_now();
}

/* The update check moved on. From its own task: bits set, no more. */
static void on_update_check(void)
{
    if (fos_scenes_settings_shown()) fos_client_render_now();
}

void fos_frame_settings_init(void)
{
    fos_wifi_set_change_hook(on_wifi_change);
    fos_ota_set_check_hook(on_update_check);
    fos_bt_set_change_hook(on_bt_change);
}

void fos_frame_settings_action(const char *action)
{
    if (action == NULL) return;
    if (strcmp(action, "scan") == 0) {
        fos_wifi_scan_start();
    } else if (strcmp(action, "btPair") == 0) {
        fos_bt_pair(FOS_BT_PAIR_SECONDS);
    } else if (strcmp(action, "btStop") == 0) {
        fos_bt_pair(0);
    } else if (strncmp(action, "btForget ", 9) == 0) {
        fos_bt_forget_one(action + 9);
    } else if (strcmp(action, "checkUpdate") == 0) {
        fos_ota_check_start(0);
    } else if (strcmp(action, "installUpdate") == 0) {
        if (fos_ota_install_checked() != ESP_OK) ESP_LOGW(TAG, "update refused: nothing to install");
    } else if (strcmp(action, "linkCloud") == 0 || strcmp(action, "adopt") == 0 ||
               strcmp(action, "cancelLink") == 0) {
        /* Connecting a control plane (docs/scene-settings.md "Connecting the
         * frame"): whatever was under way ends, the one asked for starts, and
         * the page shows it at once. Never an established link, never a
         * local network access code. */
        fos_cloud_link_cancel();
        if (fos_lan_access_panel_code(fos_lan_access_now(), FOS_LAN_ACCESS_SCOPE_ADOPT, NULL)) fos_lan_access_clear();
        if (action[0] == 'l') {
            fos_cloud_link_start();
        } else if (action[0] == 'a' && !fos_config()->backend_url[0] && fos_cloud_state() != FOS_CLOUD_ENROLLED &&
                   fos_lan_access_start(fos_lan_access_now(), esp_random, FOS_LAN_ACCESS_SCOPE_ADOPT) == 0) {
            strlcpy(s_refused, "Too many wrong codes: try in an hour", sizeof(s_refused));
        }
        fos_client_render_now();
    } else if (strcmp(action, "unlink") == 0) {
        /* The frame page's Unlink, asked twice there (docs/scene-settings.md
         * "Unlinking"). A backend's address, key and frame id go, with the
         * service keys it sent, and the frame restarts standalone, as a
         * console `set backend ""` and a restart leave it; the cloud's link
         * goes on its own task, which tells the cloud first. The scenes stay. */
        fos_config_t *config = fos_config();
        if (config->backend_url[0]) {
            config->backend_url[0] = '\0';
            config->api_key[0] = '\0';
            config->frame_id = 0;
            fos_settings_forget_cache();
            if (fos_config_save() != ESP_OK) ESP_LOGW(TAG, "unlink not saved");
            frameos_nim_log_hook("{\"event\":\"settings:frame:unlink\",\"source\":\"esp32\",\"origin\":\"panel\"}");
            if (xTaskCreate(restart_task, "fos_fs_restart", FOS_RESTART_TASK_STACK, NULL, 5, NULL) != pdPASS) esp_restart();
        } else {
            fos_cloud_unlink();
        }
    } else if (strcmp(action, "close") == 0) {
        /* Left the page, however (Back, the scene's settings, another
         * scene, a window beside it): a pairing code lives only while its
         * page is up (docs/scene-settings.md "Connecting the frame"). */
        fos_cloud_link_leave();
        if (fos_lan_access_panel_code(fos_lan_access_now(), FOS_LAN_ACCESS_SCOPE_ADOPT, NULL)) fos_lan_access_clear();
    } else if (strcmp(action, "open") == 0) {
        int64_t age = fos_wifi_scan_age_us();
        if (fos_wifi_state() != FOS_WIFI_CONNECTED && !fos_wifi_scanning() && (age < 0 || age > SCAN_FRESH_US)) {
            fos_wifi_scan_start();
        }
        if (fos_wifi_state() == FOS_WIFI_CONNECTED) fos_ota_check_start(UPDATE_CHECK_FRESH_S);
    }
}

/* The service keys typed on the frame page (frame_service_keys.nim,
 * docs/scene-settings.md "Service keys"): the frame's own, in the namespace
 * factory-reset erases, beside the copy of a plane's (fos_settings.c
 * svc_cache), and never sent anywhere. At most 4 KB (MaxServiceKeysBytes), and
 * never into the entries the settings cache keeps free for the config. */
#define KEYS_NVS "svc_typed"
#define KEYS_MAX_BYTES 4096
#define KEYS_NVS_RESERVE_ENTRIES 192

char *fos_service_keys_load(void)
{
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READONLY, &nvs) != ESP_OK) return NULL;
    size_t len = 0;
    char *text = NULL;
    if (nvs_get_blob(nvs, KEYS_NVS, NULL, &len) == ESP_OK && len > 0 && len <= KEYS_MAX_BYTES + 1) {
        text = malloc(len);
        if (text && nvs_get_blob(nvs, KEYS_NVS, text, &len) == ESP_OK) {
            text[len - 1] = '\0';
        } else {
            free(text);
            text = NULL;
        }
    }
    nvs_close(nvs);
    return text;
}

bool fos_service_keys_save(const char *json)
{
    size_t len = json ? strlen(json) : 0;
    if (len > KEYS_MAX_BYTES) return false;
    nvs_handle_t nvs;
    esp_err_t err = nvs_open("frameos", NVS_READWRITE, &nvs);
    if (err != ESP_OK) return false;
    nvs_stats_t stats;
    if (len <= 2) {
        /* "{}": none typed. */
        err = nvs_erase_key(nvs, KEYS_NVS);
        if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    } else if (nvs_get_stats(NULL, &stats) == ESP_OK &&
               stats.free_entries < (len + 32) / 32 + 2 + KEYS_NVS_RESERVE_ENTRIES) {
        err = ESP_ERR_NVS_NOT_ENOUGH_SPACE;
    } else {
        err = nvs_set_blob(nvs, KEYS_NVS, json, len + 1);
    }
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);
    if (err != ESP_OK) ESP_LOGW(TAG, "service keys not kept: %s", esp_err_to_name(err));
    return err == ESP_OK;
}

bool fos_frame_settings_code_pending(void)
{
    return fos_cloud_link_seconds_left() > 0 ||
           fos_lan_access_panel_code(fos_lan_access_now(), FOS_LAN_ACCESS_SCOPE_ADOPT, NULL) != 0;
}
