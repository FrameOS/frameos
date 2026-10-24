#include "fos_settings.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_log.h"
#include "esp_system.h"

#include "cJSON.h"
#include "esp_timer.h"
#include "nvs.h"
#include "fos_backend_http.h"
#include "fos_client.h"
#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_mem.h"
#include "fos_schedule.h"
#include "fos_tz.h"
#include "fos_voice.h"
#include "fos_wifi.h"
#include "frameos_nim.h"

static const char *TAG = "fos_settings";

/* Service-settings groups plus the `frame` object; the latter can carry two
 * PEMs (the frame's own HTTPS certificate and key, ~2-4 KB each) next to the
 * tzdata slice, hence the headroom. */
#define SETTINGS_MAX_BYTES (32 * 1024)
/* The cache shares the "frameos" NVS namespace with the frame's own config,
 * on a 16-24 KB partition. A payload that would leave fewer free entries
 * than this (32 bytes each) is applied but not cached, so fos_config_save
 * always has room: otherwise a large settings payload could make a later
 * console `set` or lan_access_set fail to persist. */
#define SETTINGS_CACHE_NVS_RESERVE_ENTRIES 192
#define SETTINGS_ETAG_LEN 96
/* Provider error bodies are a bare {"error": "…"}. */
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
 * settings"). Written on every applied pull, from either source. Three
 * things this fixes for a deep-sleep frame, whose every wake is a boot:
 *
 *  - A cloud-only frame used to render its first (and only) pass with NO
 *    service settings: the pull is requested by the session's `ready`,
 *    which on a battery frame lands a couple of seconds after the render
 *    pass has already started, and the pass that would have pulled never
 *    comes — the frame sleeps. Any scene needing an API key failed on every
 *    wake.
 *  - Every boot that did pull paid a full TLS handshake to the provider
 *    (the ETag was RAM-only), ~1-2 s of radio per wake for a body that
 *    changes a few times a year.
 *  - A backend-managed frame rendered its pass with no service settings
 *    whenever the backend was unreachable at wake (the pull's
 *    `connect-failed`): the Immich scene on an E1004 painted "Please
 *    provide an Immich server URL in the settings" onto the panel every
 *    time the dev backend wedged (2026-10-12), with the groups intact on
 *    the backend. The cache was cloud-only until then.
 *
 * With the cache, `ready` skips the pull while the copy is younger than the
 * hub client's 6 h interval; the `refresh_service_settings` nudge (queued by
 * the provider on every save, delivered on the next connect) still forces a
 * fetch, as does a revocation's 403. A backend-managed frame still fetches
 * once per boot — its payload also carries the `frame` object and the
 * schedule — so the cache only decides what the pass renders with when that
 * fetch fails; a fetch that succeeds replaces the groups wholesale and
 * rewrites the cache. The blob is the same JSON the Nim runtime is handed —
 * the account's API keys — stored next to the cloud bearer token and the
 * Wi-Fi password in the same NVS namespace, cleared by a revocation, a
 * demotion, and `factory-reset`. `svc_src` records which source wrote it:
 * only a cloud ETag is replayed against the cloud (see s_etag_source). */
#define SETTINGS_CACHE_KEY "svc_cache"
#define SETTINGS_CACHE_ETAG_KEY "svc_etag"
#define SETTINGS_CACHE_AT_KEY "svc_at"
#define SETTINGS_CACHE_SOURCE_KEY "svc_src"
static bool s_cache_applied = false;   /* this boot started from the cache */
static bool s_boot_had_cache = false;  /* any source's cache applied at boot */
static void cache_store(const char *printed, const char *etag, const char *origin);
/* frame.json's `palette` object → the colour list as compact JSON, or ""
 * for an empty list. false when the list is not an array of #rrggbb strings
 * (the cloud's contract check already refuses that; the backend's settings
 * JSON is trusted but still checked) or would not fit the slot. */
bool fos_settings_palette_text(const cJSON *palette, char *out, size_t out_len)
{
    const cJSON *colors = cJSON_GetObjectItem(palette, "colors");
    if (!cJSON_IsArray(colors) || out_len == 0) return false;
    size_t used = 0;
    out[0] = '\0';
    if (cJSON_GetArraySize(colors) == 0) return true;
    const cJSON *entry = NULL;
    out[used++] = '[';
    cJSON_ArrayForEach(entry, colors) {
        if (!cJSON_IsString(entry) || entry->valuestring == NULL) return false;
        const char *hex = entry->valuestring;
        if (strlen(hex) != 7 || hex[0] != '#') return false;
        for (int i = 1; i < 7; i++) {
            if (!isxdigit((unsigned char)hex[i])) return false;
        }
        /* `"#rrggbb",` is 10 bytes; keep room for the closing bracket + NUL. */
        if (used + 10 + 2 > out_len) return false;
        if (used > 1) out[used++] = ',';
        out[used++] = '"';
        memcpy(out + used, hex, 7);
        used += 7;
        out[used++] = '"';
    }
    out[used++] = ']';
    out[used] = '\0';
    return true;
}

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
    /* A rotation spoken to the frame (docs/voice-chat.md rotate_frame)
     * arrives mid-session: the answer still has to come back and go on the
     * panel, so the restart waits for the session, the render that follows
     * it and the refresh — bounded, the restart is owed either way. */
    int64_t deadline = esp_timer_get_time() + 180 * 1000000LL;
    while (fos_voice_busy() && esp_timer_get_time() < deadline) vTaskDelay(pdMS_TO_TICKS(250));
    vTaskDelay(pdMS_TO_TICKS(2000)); /* the release's render starts within this */
    while (fos_client_render_in_flight() && esp_timer_get_time() < deadline) vTaskDelay(pdMS_TO_TICKS(250));
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
    if (!s_boot_had_cache) {
        /* Nothing to apply at boot and no scope until now: the first pass
         * already rendered (or is rendering) without the account's keys —
         * an Immich scene painted "Please provide an Immich server URL" and
         * kept it until the next interval. Ask for a pass: it pulls first
         * (the request above), then renders; the panel skips its refresh
         * when the picture comes out the same. Every later boot applies
         * the cache this pull writes and does not come through here. Fresh:
         * every scene inside a split must run with the keys too. */
        fos_client_render_fresh();
    }
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
    cache_store(printed, etag, origin);
    /* These are the account's credentials; do not leave them in freed heap. */
    memset(printed, 0, strlen(printed));
    cJSON_free(printed);
    log_service_settings_event(origin, "applied", names);
}

static void cache_store(const char *printed, const char *etag, const char *origin)
{
    /* Room check first. A blob takes one entry per 32 bytes plus its index,
     * and the new one is written before the old one is freed. */
    const size_t blob_entries = (strlen(printed) + 1 + 31) / 32 + 2;
    nvs_stats_t stats;
    if (nvs_get_stats(NULL, &stats) == ESP_OK &&
        stats.free_entries < blob_entries + SETTINGS_CACHE_NVS_RESERVE_ENTRIES) {
        ESP_LOGW(TAG, "service settings not cached: %u NVS entries needed, %u free (keeping %u for the config)",
                 (unsigned)blob_entries, (unsigned)stats.free_entries,
                 (unsigned)SETTINGS_CACHE_NVS_RESERVE_ENTRIES);
        /* An older cache would be applied at the next boot as if current. */
        fos_settings_forget_cache();
        return;
    }
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READWRITE, &nvs) != ESP_OK) return;
    esp_err_t err = nvs_set_blob(nvs, SETTINGS_CACHE_KEY, printed, strlen(printed) + 1);
    if (err == ESP_OK) err = nvs_set_str(nvs, SETTINGS_CACHE_ETAG_KEY, etag ? etag : "");
    if (err == ESP_OK) err = nvs_set_str(nvs, SETTINGS_CACHE_SOURCE_KEY, origin ? origin : "");
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
    nvs_erase_key(nvs, SETTINGS_CACHE_SOURCE_KEY);
    nvs_commit(nvs);
    nvs_close(nvs);
    s_cache_applied = false;
    s_cache_stored_at = 0;
}

bool fos_settings_boot_apply_cache(void)
{
    /* A backend-managed frame applies the cache and still fetches on its
     * first pass (the poll also carries `frame` and the schedule, and the
     * fetch replaces the groups wholesale); the cache is what that pass
     * renders with when the fetch fails. A cloud-only frame needs the
     * enrolled link the groups belong to; an unprovisioned board has
     * neither source and nothing to apply. */
    bool backend = fos_config()->backend_url[0] != '\0';
    if (!backend && fos_cloud_state() != FOS_CLOUD_ENROLLED) {
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
    /* Firmware before `svc_src` only ever cached a cloud pull. */
    char source[16] = "cloud";
    size_t source_len = sizeof(source);
    if (err == ESP_OK && nvs_get_str(nvs, SETTINGS_CACHE_SOURCE_KEY, source, &source_len) != ESP_OK) {
        strlcpy(source, "cloud", sizeof(source));
    }
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
    /* The ETag stands in for a body only against the source that sent it,
     * and only where the body is just the groups: a cloud frame's `ready`
     * then skips the pull. A backend frame's first pass fetches regardless
     * (its ETag covers `frame` and the schedule too), so it starts without
     * one; a stale ETag replayed against the other source would earn a
     * bogus 304 and freeze this copy. */
    if (!backend && strcmp(source, "cloud") == 0) {
        strlcpy(s_etag, etag, sizeof(s_etag));
        s_etag_source = SETTINGS_SOURCE_CLOUD;
        /* "Fresh" (cache_is_fresh) only means something for a cloud copy on
         * a cloud frame: a backend copy a frame carried over to the cloud
         * must not let `ready` skip the first pull. */
        s_cache_applied = true;
        s_cache_stored_at = at;
    }
    log_service_settings_event("cache", "applied", names);
    s_boot_had_cache = true;
    return true;
}

bool fos_settings_cloud_scope(void)
{
    return s_cloud_scope_granted;
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
/* A pin the chip cannot spare (SPI flash / PSRAM pad, driver-claimed) is
 * refused and the previous value kept; -1 ("none") always passes. */
static bool settings_pin_usable(const char *key, int pin)
{
    if (pin < 0) return true;
    const char *why = fos_config_gpio_pin_reserved(pin);
    if (why == NULL) return true;
    ESP_LOGW(TAG, "settings: %s GPIO %d refused: %s", key, pin, why);
    return false;
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
        config->battery_pin != (int8_t)battery_pin->valuedouble &&
        settings_pin_usable("batteryPin", (int)battery_pin->valuedouble)) {
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
        config->battery_enable_pin != (int8_t)battery_enable_pin->valuedouble &&
        settings_pin_usable("batteryEnablePin", (int)battery_enable_pin->valuedouble)) {
        config->battery_enable_pin = (int8_t)battery_enable_pin->valuedouble;
        s_restart_after_apply = true;
        changed = true;
    }

    /* The board buzzer a button press sounds, and its pitch; -1 = silent.
     * Live: the next tone reads both (fos_buzzer.c), no restart. */
    const cJSON *buzzer_pin = cJSON_GetObjectItem(frame, "buzzerPin");
    if (cJSON_IsNumber(buzzer_pin) && buzzer_pin->valuedouble >= -1 &&
        buzzer_pin->valuedouble <= 48 &&
        config->buzzer_pin != (int8_t)buzzer_pin->valuedouble &&
        settings_pin_usable("buzzerPin", (int)buzzer_pin->valuedouble)) {
        config->buzzer_pin = (int8_t)buzzer_pin->valuedouble;
        changed = true;
    }
    const cJSON *buzzer_tone_hz = cJSON_GetObjectItem(frame, "buzzerToneHz");
    if (cJSON_IsNumber(buzzer_tone_hz) && buzzer_tone_hz->valuedouble >= FOS_BUZZER_TONE_HZ_MIN &&
        buzzer_tone_hz->valuedouble <= FOS_BUZZER_TONE_HZ_MAX &&
        config->buzzer_tone_hz != (uint16_t)buzzer_tone_hz->valuedouble) {
        config->buzzer_tone_hz = (uint16_t)buzzer_tone_hz->valuedouble;
        changed = true;
    }
    /* Voice chat (docs/voice-chat.md): whether the voice key's hold opens
     * the microphone. Live: the hold asks on every press. */
    const cJSON *voice_chat = cJSON_GetObjectItem(frame, "voiceChat");
    if (cJSON_IsBool(voice_chat) && config->voice_chat != cJSON_IsTrue(voice_chat)) {
        config->voice_chat = cJSON_IsTrue(voice_chat);
        changed = true;
    }

    /* GPIO buttons: [{pin, label}], the whole list replaced — the cloud's
     * set_settings shape (fos_cloud.c), through the console's spec parser so
     * the limits live in one place. Present only when the backend holds a
     * map; a reserved pin or a bad entry keeps the previous list. The
     * buttons task binds pins once at boot, hence the restart. Before this
     * the Settings panel's GPIO buttons changed nothing on a provisioned
     * board (E1004, 2026-10-12). */
    const cJSON *buttons = cJSON_GetObjectItem(frame, "gpioButtons");
    if (cJSON_IsArray(buttons)) {
        char spec[FOS_GPIO_BUTTONS_SPEC_LEN] = "";
        size_t used = 0;
        bool valid = true;
        const cJSON *button = NULL;
        cJSON_ArrayForEach(button, buttons) {
            const cJSON *pin = cJSON_IsObject(button) ? cJSON_GetObjectItem(button, "pin") : NULL;
            const cJSON *label = cJSON_IsObject(button) ? cJSON_GetObjectItem(button, "label") : NULL;
            if (!cJSON_IsNumber(pin) || !cJSON_IsString(label) ||
                strlen(label->valuestring) >= FOS_GPIO_BUTTON_LABEL_LEN ||
                !settings_pin_usable("gpioButtons", (int)pin->valuedouble)) {
                valid = false;
                break;
            }
            int written = snprintf(spec + used, sizeof(spec) - used, "%s%d:%s",
                                   used ? "\n" : "", (int)pin->valuedouble, label->valuestring);
            if (written < 0 || (size_t)written >= sizeof(spec) - used) {
                valid = false;
                break;
            }
            used += (size_t)written;
        }
        if (valid) {
            char before_spec[FOS_GPIO_BUTTONS_SPEC_LEN];
            fos_config_format_gpio_buttons(config, before_spec, sizeof(before_spec));
            if (strcmp(before_spec, spec) != 0) {
                /* Into the live config, as the cloud verb does: the parser
                 * validates the whole spec before it writes. */
                if (fos_config_parse_gpio_buttons(spec, config) == ESP_OK) {
                    s_restart_after_apply = true;
                    changed = true;
                } else {
                    ESP_LOGW(TAG, "settings: gpioButtons refused: %s", spec);
                }
            }
        } else {
            ESP_LOGW(TAG, "settings: gpioButtons ignored (bad entry or reserved pin)");
        }
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

    /* `colors` (docs/asset-color-profiles.md): kept as compact JSON and
     * pushed into the Nim runtime every pass like scalingMode, so it applies
     * live. An empty object is the defaults; a block too big for the slot is
     * ignored rather than truncated into something that no longer parses. */
    const cJSON *colors = cJSON_GetObjectItem(frame, "colors");
    if (cJSON_IsObject(colors)) {
        char *printed = cJSON_GetArraySize(colors) > 0 ? cJSON_PrintUnformatted(colors) : NULL;
        const char *next = printed != NULL ? printed : "";
        if (strlen(next) < sizeof(config->colors) && strcmp(config->colors, next) != 0) {
            strlcpy(config->colors, next, sizeof(config->colors));
            changed = true;
        }
        free(printed);
    }

    /* `palette` (the SPA's {colors, name?, colorNames?}): only the colour
     * list is kept, as compact JSON, and pushed into the Nim runtime every
     * pass like `colors`. An empty list hands the panel back its own table. */
    const cJSON *palette = cJSON_GetObjectItem(frame, "palette");
    if (cJSON_IsObject(palette)) {
        char next[FOS_PALETTE_LEN];
        if (fos_settings_palette_text(palette, next, sizeof(next)) && strcmp(config->palette, next) != 0) {
            strlcpy(config->palette, next, sizeof(config->palette));
            changed = true;
        }
    }

    /* `eventMap` (docs/events.md "Event map"): the frame's button bindings,
     * kept as compact JSON and pushed into the Nim runtime every pass like
     * `colors`, so the next press sees it. Present only when the backend
     * holds a map (the board preset's own applies otherwise); an empty list
     * clears it; a list too big for the slot is ignored, not truncated. */
    const cJSON *event_map = cJSON_GetObjectItem(frame, "eventMap");
    if (cJSON_IsArray(event_map)) {
        char *printed = cJSON_GetArraySize(event_map) > 0 ? cJSON_PrintUnformatted(event_map) : NULL;
        const char *next = printed != NULL ? printed : "";
        if (strlen(next) < sizeof(config->event_map) && strcmp(config->event_map, next) != 0) {
            strlcpy(config->event_map, next, sizeof(config->event_map));
            changed = true;
        } else if (strlen(next) >= sizeof(config->event_map)) {
            ESP_LOGW(TAG, "settings: eventMap ignored (%u bytes, slot holds %u)",
                     (unsigned)strlen(next), (unsigned)sizeof(config->event_map));
        }
        free(printed);
    }

    const cJSON *max_http = cJSON_GetObjectItem(frame, "maxHttpResponseBytes");
    if (cJSON_IsNumber(max_http) && max_http->valuedouble >= 1024 &&
        max_http->valuedouble <= 512.0 * 1024 * 1024 &&
        config->max_http_response_bytes != (uint32_t)max_http->valuedouble) {
        config->max_http_response_bytes = (uint32_t)max_http->valuedouble;
        /* Handed to the Nim runtime once at init (main.c). */
        s_restart_after_apply = true;
        changed = true;
    }

    /* Local admin auth for the frame's own HTTP API. The backend is the
     * source of truth for a backend-managed frame; an enabled flag without
     * both credentials is refused, matching the local POST route. */
    const cJSON *admin = cJSON_GetObjectItem(frame, "adminAuth");
    if (cJSON_IsObject(admin)) {
        const cJSON *enabled = cJSON_GetObjectItem(admin, "enabled");
        const cJSON *user = cJSON_GetObjectItem(admin, "user");
        const cJSON *pass = cJSON_GetObjectItem(admin, "pass");
        char next_user[FOS_STR_LEN];
        char next_pass[FOS_STR_LEN];
        strlcpy(next_user, config->admin_user, sizeof(next_user));
        strlcpy(next_pass, config->admin_pass, sizeof(next_pass));
        if (cJSON_IsString(user) && strlen(user->valuestring) < sizeof(next_user)) {
            strlcpy(next_user, user->valuestring, sizeof(next_user));
        }
        if (cJSON_IsString(pass) && strlen(pass->valuestring) < sizeof(next_pass)) {
            strlcpy(next_pass, pass->valuestring, sizeof(next_pass));
        }
        bool next_enabled = cJSON_IsBool(enabled) ? (bool)cJSON_IsTrue(enabled)
                                                  : config->admin_auth_enabled;
        if (next_enabled && (!next_user[0] || !next_pass[0])) {
            ESP_LOGW(TAG, "settings: adminAuth enabled without user+pass; ignored");
        } else if (next_enabled != config->admin_auth_enabled ||
                   strcmp(next_user, config->admin_user) != 0 ||
                   strcmp(next_pass, config->admin_pass) != 0) {
            config->admin_auth_enabled = next_enabled;
            strlcpy(config->admin_user, next_user, sizeof(config->admin_user));
            strlcpy(config->admin_pass, next_pass, sizeof(config->admin_pass));
            changed = true; /* checked per request (fos_http.c), no restart */
        }
    }

    /* HTTPS for the frame's own HTTP API: the listener flag, its port and
     * the PEM material. The material is what a generic image cannot get any
     * other way (a PEM does not fit a console line), so this pull is its
     * provisioning path; it persists in NVS (fos_config.c) and the server
     * is (re)started with it after the restart below. */
    const cJSON *tls = cJSON_GetObjectItem(frame, "tls");
    if (cJSON_IsObject(tls)) {
        bool tls_changed = false;
        const cJSON *enable = cJSON_GetObjectItem(tls, "enable");
        if (cJSON_IsBool(enable) && config->tls_enable != (bool)cJSON_IsTrue(enable)) {
            config->tls_enable = cJSON_IsTrue(enable);
            tls_changed = true;
        }
        const cJSON *port = cJSON_GetObjectItem(tls, "port");
        if (cJSON_IsNumber(port) && port->valuedouble >= 1 && port->valuedouble <= 65535 &&
            config->tls_port != (uint16_t)port->valuedouble) {
            config->tls_port = (uint16_t)port->valuedouble;
            tls_changed = true;
        }
        const cJSON *cert = cJSON_GetObjectItem(tls, "cert");
        if (cJSON_IsString(cert) && strlen(cert->valuestring) < sizeof(config->tls_server_cert) &&
            strcmp(config->tls_server_cert, cert->valuestring) != 0) {
            strlcpy(config->tls_server_cert, cert->valuestring, sizeof(config->tls_server_cert));
            tls_changed = true;
        }
        const cJSON *key = cJSON_GetObjectItem(tls, "key");
        if (cJSON_IsString(key) && strlen(key->valuestring) < sizeof(config->tls_server_key) &&
            strcmp(config->tls_server_key, key->valuestring) != 0) {
            strlcpy(config->tls_server_key, key->valuestring, sizeof(config->tls_server_key));
            tls_changed = true;
        }
        if (tls_changed) {
            s_restart_after_apply = true;
            changed = true;
        }
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
    if (strcmp(before->colors, after->colors) != 0) {
        change_append(out, out_len, "colors", after->colors[0] ? "set" : "default");
    }
    if (strcmp(before->palette, after->palette) != 0) {
        change_append(out, out_len, "palette", after->palette[0] ? "set" : "default");
    }
    if (strcmp(before->event_map, after->event_map) != 0) {
        change_append(out, out_len, "event_map", after->event_map[0] ? "set" : "none");
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
    if (before->buzzer_pin != after->buzzer_pin) {
        change_append_int(out, out_len, "buzzer_pin", (long)after->buzzer_pin);
    }
    if (before->buzzer_tone_hz != after->buzzer_tone_hz) {
        change_append_int(out, out_len, "buzzer_tone_hz", (long)after->buzzer_tone_hz);
    }
    if (before->voice_chat != after->voice_chat) {
        change_append(out, out_len, "voice_chat", after->voice_chat ? "true" : "false");
    }
    if (before->debug_logging != after->debug_logging) {
        change_append(out, out_len, "debug", after->debug_logging ? "true" : "false");
    }
    if (before->max_http_response_bytes != after->max_http_response_bytes) {
        change_append_int(out, out_len, "max_http_response_bytes",
                          (long)after->max_http_response_bytes);
    }
    if (before->admin_auth_enabled != after->admin_auth_enabled ||
        strcmp(before->admin_user, after->admin_user) != 0 ||
        strcmp(before->admin_pass, after->admin_pass) != 0) {
        change_append(out, out_len, "admin_auth", after->admin_auth_enabled ? "true" : "false");
    }
    if (before->tls_enable != after->tls_enable || before->tls_port != after->tls_port ||
        strcmp(before->tls_server_cert, after->tls_server_cert) != 0 ||
        strcmp(before->tls_server_key, after->tls_server_key) != 0) {
        change_append(out, out_len, "tls", after->tls_enable ? "true" : "false");
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

const char *fos_settings_etag(void)
{
    return s_etag_source == SETTINGS_SOURCE_BACKEND ? s_etag : "";
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
        /* An enrolled cloud frame has no source until this session's `ready`
         * announces the scope: a boot's first pass, with no cache to apply,
         * renders before that and used to call it "unconfigured". */
        const char *why = "unconfigured";
        if (s_cloud_scope_blocked) {
            why = "scope-revoked";
        } else if (!s_cloud_scope_granted && fos_cloud_frame_id()[0] != '\0') {
            why = "awaiting-session";
        }
        log_settings_exit(why);
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

    fos_http_request_t request = {
        .url = url,
        .auth = auth,
        /* This body is the account's credentials: no intermediate cache may
         * keep a copy, matching the provider's own Cache-Control: no-store. */
        .no_store = source == SETTINGS_SOURCE_CLOUD,
        .if_none_match = force ? NULL : s_etag,
    };
    fos_http_response_t response;
    esp_err_t fetch_err = fos_http_fetch(&request, SETTINGS_MAX_BYTES, &response);
    if (fetch_err != ESP_OK) {
        /* With the code: a refused connect on the wake's first request and a
         * read timeout look the same as a bare "connect-failed". */
        char detail[80];
        snprintf(detail, sizeof(detail), "connect-failed:%s", fos_http_err_name(fetch_err));
        log_settings_event("error", detail);
        return ESP_FAIL;
    }
    int status = response.status;
    if (status != 304) {
        char status_line[192];
        snprintf(status_line, sizeof(status_line),
                 "{\"event\":\"settings:sync\",\"source\":\"esp32\","
                 "\"status\":\"fetched\",\"httpStatus\":%d,\"bytes\":%lld}",
                 status, (long long)response.content_length);
        frameos_nim_log_hook(status_line);
    }

    if (status == 304) {
        /* The copy we hold is the copy the source would send. Keep it. */
        if (source == SETTINGS_SOURCE_CLOUD) {
            s_cloud_next_pull_us = esp_timer_get_time() + SETTINGS_CLOUD_INTERVAL_US;
        }
        return ESP_OK;
    }
    if (status != 200 || response.too_large || response.body == NULL) {
        /* `403 insufficient_scope` is the revocation boundary: the link no
         * longer holds settings:services, so every cloud-owned group comes off
         * the device and the source goes quiet until a `ready` re-announces
         * the scope. Every other failure — 403 frame_mismatch, 409
         * frame_not_active, 401, 429, 5xx, a truncated read — keeps the
         * current copy. */
        bool revoked = false;
        if (source == SETTINGS_SOURCE_CLOUD && status == 403 && response.body != NULL) {
            cJSON *error_json = cJSON_Parse(response.body);
            const cJSON *code = cJSON_GetObjectItem(error_json, "error");
            revoked = cJSON_IsString(code) && code->valuestring &&
                      strcmp(code->valuestring, "insufficient_scope") == 0;
            cJSON_Delete(error_json);
        }
        fos_http_response_free(&response);
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
        return status == 200 ? ESP_ERR_NO_MEM : ESP_FAIL;
    }

    char response_etag[SETTINGS_ETAG_LEN];
    strlcpy(response_etag, response.etag, sizeof(response_etag));
    cJSON *root = cJSON_ParseWithLength(response.body, response.body_len);
    memset(response.body, 0, response.body_len); /* the body carries the account's API keys */
    fos_http_response_free(&response);
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
        ESP_LOGW(TAG, "settings need a restart (rotation, battery wiring, TLS or the HTTP cap); restarting");
        if (xTaskCreate(settings_restart_task, "fos_set_restart", 2048, NULL, 5, NULL) != pdPASS) {
            esp_restart();
        }
    }
    return ESP_OK;
}
