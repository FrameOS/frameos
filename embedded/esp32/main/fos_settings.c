#include "fos_settings.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_system.h"

#include "cJSON.h"
#include "esp_timer.h"
#include "nvs.h"
#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_mem.h"
#include "fos_schedule.h"
#include "fos_tz.h"
#include "fos_wifi.h"
#include "frameos_nim.h"

static const char *TAG = "fos_settings";

#define SETTINGS_MAX_BYTES (16 * 1024)
#define SETTINGS_ETAG_LEN 96
/* Provider error bodies are a bare {"error": "…"}. */
#define SETTINGS_ERROR_MAX_BYTES 512
#define SETTINGS_AUTH_LEN (FOS_CLOUD_TOKEN_LEN + 16)
/* Steady-state and post-failure spacing for the cloud pull, matching the Pi
 * hub client (HubServiceSettingsIntervalSeconds / …RetrySeconds). Every other
 * pull is event-driven: `ready` and the `refresh_service_settings` nudge both
 * force one, so a key the owner just saved does not wait six hours. */
#define SETTINGS_CLOUD_INTERVAL_US (6LL * 60 * 60 * 1000000)
#define SETTINGS_CLOUD_RETRY_US (5LL * 60 * 1000000)

/* Where this poll gets its payload. A frame with a FrameOS backend keeps
 * polling the backend (the backend owns its frames); a cloud-only frame polls
 * the provider's service-settings route. Never both — the ETag below belongs
 * to exactly one of them. */
typedef enum {
    SETTINGS_SOURCE_NONE = 0,
    SETTINGS_SOURCE_BACKEND,
    SETTINGS_SOURCE_CLOUD,
} settings_source_t;

/* The ETag of the copy in RAM; on a cloud-only frame it is seeded from the
 * NVS cache at boot (fos_settings_boot_apply_cache), otherwise the source
 * is refetched once per boot, then 304 thereafter. */
static char s_etag[SETTINGS_ETAG_LEN] = "";

/* NVS cache of the six cloud-owned service-settings groups, so a boot
 * starts with the settings it had (docs/cloud-frames.md "Service
 * settings"). Two things this fixes for a deep-sleep frame, whose every
 * wake is a boot:
 *
 *  - It used to render its first (and only) pass with NO service settings:
 *    the pull is requested by the session's `ready`, which on a battery
 *    frame lands a couple of seconds after the render pass has already
 *    started, and the pass that would have pulled never comes — the frame
 *    sleeps. Any scene needing an API key failed on every wake.
 *  - Every boot that did pull paid a full TLS handshake to the provider
 *    (the ETag was RAM-only), ~1-2 s of radio per wake for a body that
 *    changes a few times a year.
 *
 * With the cache, `ready` skips the pull while the copy is younger than the
 * hub client's 6 h interval; the `refresh_service_settings` nudge (queued by
 * the provider on every save, delivered on the next connect) still forces a
 * fetch, as does a revocation's 403. The blob is the same JSON the Nim
 * runtime is handed — the account's API keys — stored next to the cloud
 * bearer token and the Wi-Fi password in the same NVS namespace, cleared by
 * a revocation, a demotion, and `factory-reset`. */
#define SETTINGS_CACHE_KEY "svc_cache"
#define SETTINGS_CACHE_ETAG_KEY "svc_etag"
#define SETTINGS_CACHE_AT_KEY "svc_at"
static bool s_cache_applied = false;   /* this boot started from the cache */
static void cache_store(const char *printed, const char *etag);
static uint32_t s_cache_stored_at = 0; /* unix seconds; 0 = unknown age */
/* Which source the stored ETag came from: a backend ETag replayed against the
 * cloud (or the reverse) would earn a bogus 304 and freeze a stale copy. */
static settings_source_t s_etag_source = SETTINGS_SOURCE_NONE;
static volatile bool s_sync_requested = false;
static bool s_restart_after_apply = false;
/* `settings:services` as announced by a cloud session's `ready`. Additive and
 * never forgotten within a boot (docs/cloud-frames.md: a device treats the
 * ready scope list as additive truth), so a revocation is enforced by the
 * provider's 403 on the fetch below — not by the scope going quiet. */
static volatile bool s_cloud_scope_granted = false;
/* Set by that 403: stop asking until a later `ready` re-announces the scope. */
static volatile bool s_cloud_scope_blocked = false;
static int64_t s_cloud_next_pull_us = 0;

static void settings_restart_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(750)); /* let the applied-settings log flush */
    esp_restart();
}

void fos_settings_request_sync(void)
{
    s_sync_requested = true;
}

static bool cache_is_fresh(void)
{
    if (!s_cache_applied || s_cache_stored_at == 0) return false;
    time_t now = time(NULL);
    if (now < 1000000000) return false; /* no clock: age unknown */
    return (uint64_t)now < (uint64_t)s_cache_stored_at + SETTINGS_CLOUD_INTERVAL_US / 1000000;
}

void fos_settings_cloud_scope_granted(bool granted)
{
    if (!granted) {
        /* A ready that stops listing the scope is NOT a revocation signal: the
         * device's scope list is additive, and the provider's 403 on the fetch
         * is what actually takes the keys off the device. */
        return;
    }
    s_cloud_scope_granted = true;
    s_cloud_scope_blocked = false; /* a fresh grant lifts an earlier 403 */
    s_cloud_next_pull_us = 0;
    if (cache_is_fresh()) {
        /* The copy applied at boot is younger than the poll interval, and a
         * save on the provider's side arrives as a queued nudge anyway. */
        return;
    }
    /* One conditional pull per session that reaches `ready`, before the first
     * render this session drives. */
    s_sync_requested = true;
}

/* Group NAMES only, never a value: device logs are uploaded to the provider
 * and retained, so a value logged here becomes a value in a cloud database.
 * An empty `groups` on "applied" means the device now holds none of them. */
static void log_service_settings_event(const char *origin, const char *status,
                                       const char *groups)
{
    char line[256];
    snprintf(line, sizeof(line),
             "{\"event\":\"settings:services\",\"source\":\"esp32\","
             "\"origin\":\"%s\",\"status\":\"%s\",\"groups\":\"%s\"}",
             origin, status, groups ? groups : "");
    frameos_nim_log_hook(line);
}

/* The six cloud-owned settings groups (docs/cloud-frames.md, "Service
 * settings"). Kept in sync with CloudServiceSettingsGroups in
 * frameos/src/frameos/apps.nim, which does the actual merge. */
static const char *const k_service_settings_groups[] = {
    "frameOS", "github", "homeAssistant", "immich", "openAI", "unsplash",
};

/* Hand the six groups to the Nim runtime, which replaces the ones present and
 * DELETES the ones absent.
 *
 * One parser, two payload shapes:
 *   backend  {"homeAssistant": {…}, "openAI": {…}, "frame": {…}, "schedule": …}
 *            — the groups sit at the ROOT, next to `frame`/`schedule`.
 *   cloud    {"settings": {"homeAssistant": {…}}, "groups": [...]}
 *            — the groups sit under `settings`, and `groups` lists what the
 *              frame's scenes declare (advisory; not a source of values).
 * So: use `settings` when the payload has one, else scan the root for the
 * known group names. Only those names are ever forwarded — `frame`,
 * `schedule` and `groups` never reach the Nim side. */
static void apply_service_settings(const cJSON *root, const char *origin, const char *etag)
{
    const cJSON *settings = cJSON_GetObjectItem(root, "settings");
    if (!cJSON_IsObject(settings)) settings = root;

    cJSON *out = cJSON_CreateObject();
    if (out == NULL) return; /* no memory: keep the current copy, retry later */
    char names[160] = "";
    size_t names_len = 0;
    for (size_t i = 0; i < sizeof(k_service_settings_groups) / sizeof(k_service_settings_groups[0]); i++) {
        const char *name = k_service_settings_groups[i];
        const cJSON *group = cJSON_GetObjectItem(settings, name);
        if (!cJSON_IsObject(group)) continue;
        /* A reference: cJSON_Delete(out) below will not free the parsed tree. */
        if (!cJSON_AddItemReferenceToObject(out, name, (cJSON *)group)) continue;
        int written = snprintf(names + names_len, sizeof(names) - names_len,
                               "%s%s", names_len ? "," : "", name);
        if (written > 0 && (size_t)written < sizeof(names) - names_len) {
            names_len += (size_t)written;
        }
    }
    char *printed = cJSON_PrintUnformatted(out);
    cJSON_Delete(out);
    if (printed == NULL) return; /* same: an OOM must not read as a revocation */
    frameos_nim_apply_service_settings(printed);
    if (strcmp(origin, "cloud") == 0) cache_store(printed, etag);
    /* These are the account's credentials; do not leave them in freed heap. */
    memset(printed, 0, strlen(printed));
    cJSON_free(printed);
    log_service_settings_event(origin, "applied", names);
}

static void cache_store(const char *printed, const char *etag)
{
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READWRITE, &nvs) != ESP_OK) return;
    esp_err_t err = nvs_set_blob(nvs, SETTINGS_CACHE_KEY, printed, strlen(printed) + 1);
    if (err == ESP_OK) err = nvs_set_str(nvs, SETTINGS_CACHE_ETAG_KEY, etag ? etag : "");
    time_t now = time(NULL);
    uint32_t at = now > 1000000000 ? (uint32_t)now : 0;
    if (err == ESP_OK) err = nvs_set_u32(nvs, SETTINGS_CACHE_AT_KEY, at);
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "service settings cache write failed: %s", esp_err_to_name(err));
        return;
    }
    s_cache_applied = true;
    s_cache_stored_at = at;
}

void fos_settings_forget_cache(void)
{
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READWRITE, &nvs) != ESP_OK) return;
    nvs_erase_key(nvs, SETTINGS_CACHE_KEY);
    nvs_erase_key(nvs, SETTINGS_CACHE_ETAG_KEY);
    nvs_erase_key(nvs, SETTINGS_CACHE_AT_KEY);
    nvs_commit(nvs);
    nvs_close(nvs);
    s_cache_applied = false;
    s_cache_stored_at = 0;
}

bool fos_settings_boot_apply_cache(void)
{
    /* Cloud-only frames only: a backend-managed frame's settings poll owns
     * the groups (and its payload carries more than them), so its first
     * pass fetches as before. */
    if (fos_config()->backend_url[0] != '\0' || fos_cloud_state() != FOS_CLOUD_ENROLLED) {
        return false;
    }
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READONLY, &nvs) != ESP_OK) return false;
    size_t len = 0;
    esp_err_t err = nvs_get_blob(nvs, SETTINGS_CACHE_KEY, NULL, &len);
    if (err != ESP_OK || len == 0 || len > SETTINGS_MAX_BYTES + 1) {
        nvs_close(nvs);
        return false;
    }
    char *blob = malloc(len);
    if (blob == NULL) {
        nvs_close(nvs);
        return false;
    }
    err = nvs_get_blob(nvs, SETTINGS_CACHE_KEY, blob, &len);
    char etag[SETTINGS_ETAG_LEN] = "";
    size_t etag_len = sizeof(etag);
    if (err == ESP_OK && nvs_get_str(nvs, SETTINGS_CACHE_ETAG_KEY, etag, &etag_len) != ESP_OK) {
        etag[0] = '\0';
    }
    uint32_t at = 0;
    if (err == ESP_OK && nvs_get_u32(nvs, SETTINGS_CACHE_AT_KEY, &at) != ESP_OK) at = 0;
    nvs_close(nvs);
    if (err != ESP_OK) {
        free(blob);
        return false;
    }
    blob[len - 1] = '\0';
    cJSON *root = cJSON_ParseWithLength(blob, strlen(blob));
    if (root == NULL || !cJSON_IsObject(root)) {
        cJSON_Delete(root);
        memset(blob, 0, len);
        free(blob);
        fos_settings_forget_cache(); /* a corrupt cache is not a copy to keep */
        return false;
    }
    /* Names only in the log, never a value (see apply_service_settings). */
    char names[160] = "";
    size_t names_len = 0;
    for (size_t i = 0; i < sizeof(k_service_settings_groups) / sizeof(k_service_settings_groups[0]); i++) {
        if (!cJSON_IsObject(cJSON_GetObjectItem(root, k_service_settings_groups[i]))) continue;
        int written = snprintf(names + names_len, sizeof(names) - names_len, "%s%s",
                               names_len ? "," : "", k_service_settings_groups[i]);
        if (written > 0 && (size_t)written < sizeof(names) - names_len) names_len += (size_t)written;
    }
    cJSON_Delete(root);
    frameos_nim_apply_service_settings(blob);
    memset(blob, 0, len);
    free(blob);
    strlcpy(s_etag, etag, sizeof(s_etag));
    s_etag_source = SETTINGS_SOURCE_CLOUD;
    s_cache_applied = true;
    s_cache_stored_at = at;
    log_service_settings_event("cache", "applied", names);
    return true;
}

bool fos_settings_cloud_scope(void)
{
    return s_cloud_scope_granted;
}

static esp_err_t collect_etag_handler(esp_http_client_event_t *evt)
{
    if (evt->event_id == HTTP_EVENT_ON_HEADER &&
        strcasecmp(evt->header_key, "ETag") == 0) {
        char *etag_out = (char *)evt->user_data;
        snprintf(etag_out, SETTINGS_ETAG_LEN, "%s", evt->header_value);
    }
    return ESP_OK;
}

static void log_settings_event(const char *status, const char *detail)
{
    char line[256];
    snprintf(line, sizeof(line),
             "{\"event\":\"settings:sync\",\"source\":\"esp32\","
             "\"status\":\"%s\",\"detail\":\"%s\"}",
             status, detail ? detail : "");
    frameos_nim_log_hook(line);
}

/* `applied` with what changed: the owner toggling deep sleep in the cloud
 * used to leave no trace on the device beyond a bare "applied". */
static void log_settings_applied(const char *detail, const char *changed)
{
    char line[512];
    snprintf(line, sizeof(line),
             "{\"event\":\"settings:sync\",\"source\":\"esp32\","
             "\"status\":\"applied\",\"detail\":\"%s\",\"changed\":\"%s\"}",
             detail ? detail : "", changed ? changed : "");
    frameos_nim_log_hook(line);
}

/* Read at most `limit` bytes of the response body. Returns a NUL-terminated
 * malloc'd buffer (caller frees) or NULL. */
static char *read_body(esp_http_client_handle_t client, int64_t content_length,
                       size_t limit)
{
    if (content_length > (int64_t)limit) return NULL;
    size_t cap = content_length > 0 ? (size_t)content_length : limit;
    char *buf = malloc(cap + 1);
    if (buf == NULL) return NULL;
    size_t total = 0;
    while (total < cap) {
        int r = esp_http_client_read(client, buf + total, cap - total);
        if (r < 0) {
            free(buf);
            return NULL;
        }
        if (r == 0) break;
        total += (size_t)r;
    }
    buf[total] = '\0';
    return buf;
}

/* Apply the `frame` object. Returns true when anything changed. */
static bool apply_frame_settings(const cJSON *frame)
{
    fos_config_t *config = fos_config();
    bool changed = false;

    const cJSON *interval = cJSON_GetObjectItem(frame, "interval");
    if (cJSON_IsNumber(interval) && interval->valuedouble >= 1 &&
        interval->valuedouble <= 7 * 86400) {
        uint32_t seconds = (uint32_t)interval->valuedouble;
        if (seconds < 5) seconds = 5; /* same floor as the local admin API */
        if (config->interval_sec != seconds) {
            config->interval_sec = seconds;
            changed = true;
        }
    }

    const cJSON *name = cJSON_GetObjectItem(frame, "name");
    if (cJSON_IsString(name) && name->valuestring[0] &&
        strcmp(config->hostname, name->valuestring) != 0 &&
        strlen(name->valuestring) < sizeof(config->hostname)) {
        strlcpy(config->hostname, name->valuestring, sizeof(config->hostname));
        changed = true;
    }

    const cJSON *render_mode = cJSON_GetObjectItem(frame, "renderMode");
    if (cJSON_IsString(render_mode)) {
        fos_render_mode_t mode = strcmp(render_mode->valuestring, "remote") == 0
                                     ? FOS_RENDER_REMOTE
                                     : FOS_RENDER_LOCAL;
        if (config->render_mode != mode) {
            config->render_mode = mode;
            changed = true;
        }
    }

    const cJSON *deep_sleep = cJSON_GetObjectItem(frame, "deepSleep");
    if (cJSON_IsBool(deep_sleep) &&
        config->deep_sleep != (bool)cJSON_IsTrue(deep_sleep)) {
        config->deep_sleep = cJSON_IsTrue(deep_sleep);
        changed = true;
    }

    const cJSON *wake_schedule = cJSON_GetObjectItem(frame, "wakeSchedule");
    if (cJSON_IsBool(wake_schedule) &&
        config->wake_schedule != (bool)cJSON_IsTrue(wake_schedule)) {
        config->wake_schedule = cJSON_IsTrue(wake_schedule);
        changed = true;
    }

    const cJSON *sleep_on_battery = cJSON_GetObjectItem(frame, "deepSleepOnBattery");
    if (cJSON_IsBool(sleep_on_battery) &&
        config->deep_sleep_on_battery != (bool)cJSON_IsTrue(sleep_on_battery)) {
        config->deep_sleep_on_battery = cJSON_IsTrue(sleep_on_battery);
        changed = true;
    }

    const cJSON *wake_check = cJSON_GetObjectItem(frame, "wakeCheckSeconds");
    if (cJSON_IsNumber(wake_check) && wake_check->valuedouble >= 0 &&
        wake_check->valuedouble <= 86400) {
        uint32_t seconds = (uint32_t)wake_check->valuedouble;
        /* Floor mirrors the cloud validator: sub-minute check-ins would
         * drain a battery for nothing. 0 stays 0 (only wake to render). */
        if (seconds > 0 && seconds < 60) seconds = 60;
        if (config->wake_check_sec != seconds) {
            config->wake_check_sec = seconds;
            changed = true;
        }
    }

    const cJSON *battery_pin = cJSON_GetObjectItem(frame, "batteryPin");
    if (cJSON_IsNumber(battery_pin) && battery_pin->valuedouble >= -1 &&
        battery_pin->valuedouble <= 48 &&
        config->battery_pin != (int8_t)battery_pin->valuedouble) {
        config->battery_pin = (int8_t)battery_pin->valuedouble;
        /* The ADC is set up once at boot (main.c) — re-init via restart. */
        s_restart_after_apply = true;
        changed = true;
    }

    const cJSON *battery_divider = cJSON_GetObjectItem(frame, "batteryDivider");
    if (cJSON_IsNumber(battery_divider) && battery_divider->valuedouble >= 0.5 &&
        battery_divider->valuedouble <= 20.0 &&
        config->battery_divider != (float)battery_divider->valuedouble) {
        config->battery_divider = (float)battery_divider->valuedouble;
        s_restart_after_apply = true;
        changed = true;
    }

    const cJSON *battery_enable_pin = cJSON_GetObjectItem(frame, "batteryEnablePin");
    if (cJSON_IsNumber(battery_enable_pin) && battery_enable_pin->valuedouble >= -1 &&
        battery_enable_pin->valuedouble <= 48 &&
        config->battery_enable_pin != (int8_t)battery_enable_pin->valuedouble) {
        config->battery_enable_pin = (int8_t)battery_enable_pin->valuedouble;
        s_restart_after_apply = true;
        changed = true;
    }

    const cJSON *rotate = cJSON_GetObjectItem(frame, "rotate");
    uint16_t normalized_rotate = 0;
    if (cJSON_IsNumber(rotate) &&
        fos_config_normalize_rotate(rotate->valuedouble, &normalized_rotate) &&
        config->rotate != normalized_rotate) {
        config->rotate = normalized_rotate;
        /* The Nim runtime sizes the scene canvas at init; a rotation
         * change needs a restart to take effect. */
        s_restart_after_apply = true;
        changed = true;
    }

    const cJSON *time_zone = cJSON_GetObjectItem(frame, "timeZone");
    if (cJSON_IsString(time_zone) && strlen(time_zone->valuestring) < sizeof(config->time_zone)) {
        /* The backend sends that zone's tzdata slice next to the name
         * (timeZoneData, fos_tz.h); without one the name is kept and
         * fos_tz_resolve_pending fetches a slice from tz.frameos.net. */
        const cJSON *data = cJSON_GetObjectItem(frame, "timeZoneData");
        char *slice = cJSON_IsObject(data) ? cJSON_PrintUnformatted(data) : NULL;
        bool name_changed = strcmp(config->time_zone, time_zone->valuestring) != 0;
        if (name_changed) {
            strlcpy(config->time_zone, time_zone->valuestring, sizeof(config->time_zone));
            fos_tz_clear();
            changed = true;
        }
        if (name_changed || fos_tz_slice_missing()) {
            /* Live: localtime/QuickJS Date/schedule read TZ on their next call. */
            fos_tz_install(slice);
        }
        free(slice);
    }

    const cJSON *scaling = cJSON_GetObjectItem(frame, "scalingMode");
    char normalized_scaling[16];
    if (cJSON_IsString(scaling) &&
        fos_config_normalize_scaling_mode(scaling->valuestring, normalized_scaling,
                                          sizeof(normalized_scaling)) &&
        strcmp(config->scaling_mode, normalized_scaling) != 0) {
        strlcpy(config->scaling_mode, normalized_scaling, sizeof(config->scaling_mode));
        /* Unlike rotate this is a per-decode fallback, not a canvas
         * dimension — fos_client pushes it into the Nim runtime every pass,
         * so no restart is needed. */
        changed = true;
    }

    return changed;
}

static void log_settings_exit(const char *why)
{
    /* Once per boot per reason would be ideal; once per pass is acceptable
     * noise for a sync that should never silently die again. NULL = the sync
     * is going ahead: re-arm the guard, log nothing (this used to log a
     * `skipped` with an empty detail two seconds before every `fetched`). */
    static const char *s_last_why = NULL;
    if (why == s_last_why) return;
    s_last_why = why;
    if (why) log_settings_event("skipped", why);
}

/* Append "key=value" to a comma-separated list. */
static void change_append(char *out, size_t out_len, const char *key, const char *value)
{
    size_t used = strlen(out);
    if (used >= out_len) return;
    snprintf(out + used, out_len - used, "%s%s=%s", used ? "," : "", key, value);
}

static void change_append_int(char *out, size_t out_len, const char *key, long value)
{
    char buf[24];
    snprintf(buf, sizeof(buf), "%ld", value);
    change_append(out, out_len, key, buf);
}

void fos_settings_describe_changes(const fos_config_t *before, const fos_config_t *after,
                                   char *out, size_t out_len)
{
    if (!out || out_len == 0) return;
    out[0] = '\0';
    if (!before || !after) return;
    if (before->interval_sec != after->interval_sec) {
        change_append_int(out, out_len, "interval", (long)after->interval_sec);
    }
    if (strcmp(before->hostname, after->hostname) != 0) {
        change_append(out, out_len, "name", after->hostname);
    }
    if (before->render_mode != after->render_mode) {
        change_append(out, out_len, "render_mode",
                      after->render_mode == FOS_RENDER_REMOTE ? "remote" : "local");
    }
    if (before->rotate != after->rotate) {
        change_append_int(out, out_len, "rotate", (long)after->rotate);
    }
    if (strcmp(before->scaling_mode, after->scaling_mode) != 0) {
        change_append(out, out_len, "scaling_mode", after->scaling_mode);
    }
    if (strcmp(before->time_zone, after->time_zone) != 0) {
        change_append(out, out_len, "timezone", after->time_zone);
    }
    if (before->deep_sleep != after->deep_sleep) {
        change_append(out, out_len, "deep_sleep", after->deep_sleep ? "true" : "false");
    }
    if (before->deep_sleep_on_battery != after->deep_sleep_on_battery) {
        change_append(out, out_len, "deep_sleep_on_battery",
                      after->deep_sleep_on_battery ? "true" : "false");
    }
    if (before->wake_schedule != after->wake_schedule) {
        change_append(out, out_len, "wake_schedule", after->wake_schedule ? "true" : "false");
    }
    if (before->wake_check_sec != after->wake_check_sec) {
        change_append_int(out, out_len, "wake_check_seconds", (long)after->wake_check_sec);
    }
    if (before->battery_pin != after->battery_pin) {
        change_append_int(out, out_len, "battery_pin", (long)after->battery_pin);
    }
    if (before->battery_divider != after->battery_divider) {
        char buf[24];
        snprintf(buf, sizeof(buf), "%.2f", (double)after->battery_divider);
        change_append(out, out_len, "battery_divider", buf);
    }
    if (before->battery_enable_pin != after->battery_enable_pin) {
        change_append_int(out, out_len, "battery_enable_pin", (long)after->battery_enable_pin);
    }
    if (before->debug_logging != after->debug_logging) {
        change_append(out, out_len, "debug", after->debug_logging ? "true" : "false");
    }
    if (before->max_http_response_bytes != after->max_http_response_bytes) {
        change_append_int(out, out_len, "max_http_response_bytes",
                          (long)after->max_http_response_bytes);
    }
    char buttons_before[FOS_GPIO_BUTTONS_SPEC_LEN];
    char buttons_after[FOS_GPIO_BUTTONS_SPEC_LEN];
    fos_config_format_gpio_buttons(before, buttons_before, sizeof(buttons_before));
    fos_config_format_gpio_buttons(after, buttons_after, sizeof(buttons_after));
    if (strcmp(buttons_before, buttons_after) != 0) {
        change_append_int(out, out_len, "gpio_buttons", (long)after->gpio_button_count);
    }
}

/* Pick the payload source and fill in its URL + Authorization value.
 *
 * A FrameOS backend wins whenever one is configured: it owns its frames, and
 * its /embedded/settings payload carries the `frame` object and the schedule
 * the cloud route does not. Only a cloud-only frame — no backend, enrolled,
 * and holding `settings:services` — pulls the provider's service-settings
 * route, which before this existed left such a frame never polling at all. */
static settings_source_t select_source(char *url, size_t url_len,
                                       char *auth, size_t auth_len)
{
    const fos_config_t *config = fos_config();
    if (config->backend_url[0] && config->frame_id != 0 && config->api_key[0]) {
        snprintf(url, url_len, "%s/api/frames/%lu/embedded/settings",
                 config->backend_url, (unsigned long)config->frame_id);
        snprintf(auth, auth_len, "Bearer %s", config->api_key);
        return SETTINGS_SOURCE_BACKEND;
    }
    if (!s_cloud_scope_granted || s_cloud_scope_blocked) {
        return SETTINGS_SOURCE_NONE;
    }
    char base_url[FOS_URL_LEN];
    char frame_id[64];
    if (!fos_cloud_api_access(base_url, sizeof(base_url), frame_id, sizeof(frame_id),
                              auth, auth_len)) {
        return SETTINGS_SOURCE_NONE;
    }
    snprintf(url, url_len, "%s/api/frames/%s/service-settings", base_url, frame_id);
    return SETTINGS_SOURCE_CLOUD;
}

esp_err_t fos_settings_sync(bool force)
{
    fos_config_t *config = fos_config();
    if (s_sync_requested) {
        force = true;
        s_sync_requested = false;
    }

    char url[FOS_URL_LEN + 128];
    char auth[SETTINGS_AUTH_LEN];
    settings_source_t source = select_source(url, sizeof(url), auth, sizeof(auth));
    if (source == SETTINGS_SOURCE_NONE) {
        log_settings_exit(s_cloud_scope_blocked ? "scope-revoked" : "unconfigured");
        return ESP_ERR_INVALID_STATE;
    }
    if (fos_wifi_state() != FOS_WIFI_CONNECTED) {
        log_settings_exit("wifi");
        return ESP_ERR_INVALID_STATE;
    }
    /* The provider route is credentials over TLS on someone else's server, so
     * it is polled on the hub client's schedule (6 h, 5 min after a failure)
     * rather than once per render pass; `ready` and the nudge force it. */
    if (source == SETTINGS_SOURCE_CLOUD && !force &&
        esp_timer_get_time() < s_cloud_next_pull_us) {
        return ESP_OK;
    }
    log_settings_exit(NULL); /* configured + online: fetch follows */
    const char *origin = source == SETTINGS_SOURCE_CLOUD ? "cloud" : "backend";
    if (source == SETTINGS_SOURCE_CLOUD) {
        s_cloud_next_pull_us = esp_timer_get_time() + SETTINGS_CLOUD_RETRY_US;
    }

    /* An ETag identifies one source's body; replaying it against the other
     * would earn a 304 and freeze whatever the first source had delivered. */
    if (source != s_etag_source) {
        s_etag[0] = '\0';
        s_etag_source = source;
    }

    char response_etag[SETTINGS_ETAG_LEN] = "";
    esp_http_client_config_t http_config = {
        .url = url,
        .timeout_ms = 15000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 2048,
        .event_handler = collect_etag_handler,
        .user_data = response_etag,
    };
    esp_http_client_handle_t client = esp_http_client_init(&http_config);
    if (client == NULL) {
        log_settings_event("error", "client-init-failed");
        return ESP_FAIL;
    }
    esp_http_client_set_header(client, "Authorization", auth);
    if (source == SETTINGS_SOURCE_CLOUD) {
        /* This body is the account's credentials: no intermediate cache may
         * keep a copy, matching the provider's own Cache-Control: no-store. */
        esp_http_client_set_header(client, "Cache-Control", "no-store");
    }
    if (!force && s_etag[0]) {
        esp_http_client_set_header(client, "If-None-Match", s_etag);
    }

    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "settings sync: connect failed: %s", esp_err_to_name(err));
        esp_http_client_cleanup(client);
        return err;
    }
    int64_t content_length = esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);
    if (status != 304) {
        char status_line[192];
        snprintf(status_line, sizeof(status_line),
                 "{\"event\":\"settings:sync\",\"source\":\"esp32\","
                 "\"status\":\"fetched\",\"httpStatus\":%d,\"bytes\":%lld}",
                 status, (long long)content_length);
        frameos_nim_log_hook(status_line);
    }

    if (status == 304) {
        /* The copy we hold is the copy the source would send. Keep it. */
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        if (source == SETTINGS_SOURCE_CLOUD) {
            s_cloud_next_pull_us = esp_timer_get_time() + SETTINGS_CLOUD_INTERVAL_US;
        }
        return ESP_OK;
    }
    if (status != 200 || content_length > SETTINGS_MAX_BYTES) {
        /* `403 insufficient_scope` is the revocation boundary: the link no
         * longer holds settings:services, so every cloud-owned group comes off
         * the device and the source goes quiet until a `ready` re-announces
         * the scope. Every other failure — 403 frame_mismatch, 409
         * frame_not_active, 401, 429, 5xx, a truncated read — keeps the
         * current copy. */
        bool revoked = false;
        if (source == SETTINGS_SOURCE_CLOUD && status == 403) {
            char *error_body = read_body(client, content_length, SETTINGS_ERROR_MAX_BYTES);
            if (error_body != NULL) {
                cJSON *error_json = cJSON_Parse(error_body);
                const cJSON *code = cJSON_GetObjectItem(error_json, "error");
                revoked = cJSON_IsString(code) && code->valuestring &&
                          strcmp(code->valuestring, "insufficient_scope") == 0;
                cJSON_Delete(error_json);
                free(error_body);
            }
        }
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        if (revoked) {
            frameos_nim_apply_service_settings("{}");
            fos_settings_forget_cache();
            s_cloud_scope_blocked = true;
            s_etag[0] = '\0';
            log_service_settings_event(origin, "revoked", "");
            ESP_LOGW(TAG, "service settings: provider refused the fetch "
                          "(insufficient_scope); cloud-owned settings cleared");
            return ESP_OK;
        }
        if (status != 404) { /* older backends have no settings route */
            ESP_LOGW(TAG, "settings sync: HTTP %d from %s", status, url);
        }
        return ESP_FAIL;
    }

    char *buf = read_body(client, content_length, SETTINGS_MAX_BYTES);
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    if (buf == NULL) {
        return ESP_ERR_NO_MEM;
    }

    cJSON *root = cJSON_ParseWithLength(buf, strlen(buf));
    memset(buf, 0, strlen(buf)); /* the body carries the account's API keys */
    free(buf);
    if (root == NULL || !cJSON_IsObject(root)) {
        cJSON_Delete(root);
        log_settings_event("error", "unparseable");
        return ESP_FAIL;
    }

    /* Service settings first: the six cloud-owned groups this payload carries
     * (see apply_service_settings for the two shapes) go straight to the Nim
     * runtime, which replaces the ones present and deletes the ones absent. */
    apply_service_settings(root, origin, response_etag);

    /* The `frame` object and `schedule` are backend-only — the cloud route
     * carries neither (the provider pushes them as set_settings/set_schedule
     * verbs), so these lookups simply miss on a cloud payload. */
    const cJSON *frame = cJSON_GetObjectItem(root, "frame");
    /* A copy to diff against for the `applied` line; heap, not stack — the
     * config carries the token buffers. NULL just loses the detail. */
    fos_config_t *before = cJSON_IsObject(frame) ? malloc(sizeof(*before)) : NULL;
    if (before) memcpy(before, config, sizeof(*before));
    bool changed = cJSON_IsObject(frame) ? apply_frame_settings(frame) : false;
    const cJSON *offset = cJSON_IsObject(frame)
                              ? cJSON_GetObjectItem(frame, "utcOffsetMinutes")
                              : NULL;
    if (cJSON_IsNumber(offset)) {
        fos_schedule_set_utc_offset_minutes((int)offset->valuedouble);
    }
    const cJSON *schedule = cJSON_GetObjectItem(root, "schedule");
    if (cJSON_IsObject(schedule)) {
        char *printed = cJSON_PrintUnformatted(schedule);
        if (printed != NULL) {
            fos_schedule_set_json(printed, strlen(printed));
            cJSON_free(printed);
        }
    } else if (cJSON_IsNull(schedule)) {
        fos_schedule_set_json(NULL, 0);
    }
    cJSON_Delete(root);

    if (changed) {
        if (fos_config_save() != ESP_OK) {
            free(before);
            log_settings_event("error", "persist-failed");
            return ESP_FAIL;
        }
        char changes[320] = "";
        fos_settings_describe_changes(before, config, changes, sizeof(changes));
        log_settings_applied(s_restart_after_apply ? "restarting" : "", changes);
        ESP_LOGI(TAG, "settings applied from backend (interval=%lu render_mode=%d rotate=%u scaling=%s)",
                 (unsigned long)config->interval_sec, (int)config->render_mode,
                 (unsigned)config->rotate, config->scaling_mode);
    }
    free(before);
    if (response_etag[0]) {
        strlcpy(s_etag, response_etag, sizeof(s_etag));
    }
    if (source == SETTINGS_SOURCE_CLOUD) {
        s_cloud_next_pull_us = esp_timer_get_time() + SETTINGS_CLOUD_INTERVAL_US;
    }
    if (s_restart_after_apply) {
        s_restart_after_apply = false;
        ESP_LOGW(TAG, "rotation changed; restarting to re-init the renderer");
        if (xTaskCreate(settings_restart_task, "fos_set_restart", 2048, NULL, 5, NULL) != pdPASS) {
            esp_restart();
        }
    }
    return ESP_OK;
}
