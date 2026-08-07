#include "fos_schedule.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "esp_log.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "nvs.h"

#include "cJSON.h"
#include "fos_client.h"
#include "fos_scenes.h"
#include "fos_wifi.h"
#include "frameos_nim.h"

static const char *TAG = "fos_schedule";

#define SCHEDULE_PATH "/state/schedule.json"
#define SCHEDULE_TMP_PATH "/state/schedule.json.tmp"
#define SCHEDULE_MAX_BYTES (32 * 1024)
#define SCHEDULE_MAX_EVENTS 64
#define SCHEDULE_EVENT_NAME_LEN 64
#define SCHEDULE_PAYLOAD_LEN 512

typedef struct {
    int8_t minute;   /* 0-59 */
    int8_t hour;     /* 0-23 */
    int8_t weekday;  /* 0 daily, 1-7 mon-sun, 8 weekdays, 9 weekends */
    char event[SCHEDULE_EVENT_NAME_LEN];
    char payload[SCHEDULE_PAYLOAD_LEN];
} schedule_event_t;

static SemaphoreHandle_t s_lock = NULL;
static schedule_event_t *s_events = NULL;
static int s_event_count = 0;
static int s_utc_offset_minutes = 0;
static int64_t s_last_fired_minute = -1;

static bool ensure_lock(void)
{
    if (s_lock == NULL) s_lock = xSemaphoreCreateMutex();
    return s_lock != NULL;
}

void fos_schedule_set_utc_offset_minutes(int minutes)
{
    if (minutes < -14 * 60 || minutes > 14 * 60) return;
    if (s_utc_offset_minutes == minutes) return;
    s_utc_offset_minutes = minutes;
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READWRITE, &nvs) == ESP_OK) {
        nvs_set_i32(nvs, "utc_offset_min", minutes);
        nvs_commit(nvs);
        nvs_close(nvs);
    }
}

int fos_schedule_utc_offset_minutes(void)
{
    return s_utc_offset_minutes;
}

int fos_schedule_event_count(void)
{
    return s_event_count;
}

/* Parse into a fresh array; returns count or -1 on structural failure.
 * Individual malformed events are skipped, mirroring the tolerant Pi
 * loader. Accepts either the events object or {"schedule": {...}}. */
static int parse_events(const char *json, size_t len, schedule_event_t **out)
{
    *out = NULL;
    cJSON *root = cJSON_ParseWithLength(json, len);
    if (root == NULL) return -1;
    const cJSON *container = cJSON_GetObjectItem(root, "schedule");
    if (!cJSON_IsObject(container)) container = root;
    const cJSON *events = cJSON_GetObjectItem(container, "events");
    if (!cJSON_IsArray(events)) {
        cJSON_Delete(root);
        return cJSON_IsNull(events) || events == NULL ? 0 : -1;
    }
    int cap = cJSON_GetArraySize(events);
    if (cap > SCHEDULE_MAX_EVENTS) cap = SCHEDULE_MAX_EVENTS;
    schedule_event_t *parsed = cap > 0 ? calloc(cap, sizeof(*parsed)) : NULL;
    if (cap > 0 && parsed == NULL) {
        cJSON_Delete(root);
        return -1;
    }
    int count = 0;
    const cJSON *item = NULL;
    cJSON_ArrayForEach(item, events) {
        if (count >= cap) break;
        const cJSON *minute = cJSON_GetObjectItem(item, "minute");
        const cJSON *hour = cJSON_GetObjectItem(item, "hour");
        const cJSON *weekday = cJSON_GetObjectItem(item, "weekday");
        const cJSON *event = cJSON_GetObjectItem(item, "event");
        if (!cJSON_IsNumber(minute) || minute->valuedouble < 0 || minute->valuedouble > 59 ||
            !cJSON_IsNumber(hour) || hour->valuedouble < 0 || hour->valuedouble > 23 ||
            !cJSON_IsString(event) || !event->valuestring[0] ||
            strlen(event->valuestring) >= SCHEDULE_EVENT_NAME_LEN) {
            continue;
        }
        int wd = cJSON_IsNumber(weekday) ? (int)weekday->valuedouble : 0;
        if (wd < 0 || wd > 9) continue;
        schedule_event_t *dst = &parsed[count];
        dst->minute = (int8_t)minute->valuedouble;
        dst->hour = (int8_t)hour->valuedouble;
        dst->weekday = (int8_t)wd;
        strlcpy(dst->event, event->valuestring, sizeof(dst->event));
        const cJSON *payload = cJSON_GetObjectItem(item, "payload");
        if (cJSON_IsObject(payload)) {
            char *printed = cJSON_PrintUnformatted(payload);
            if (printed != NULL) {
                if (strlen(printed) < SCHEDULE_PAYLOAD_LEN) {
                    strlcpy(dst->payload, printed, sizeof(dst->payload));
                } else {
                    ESP_LOGW(TAG, "event \"%s\" payload over %d bytes, dropped",
                             dst->event, SCHEDULE_PAYLOAD_LEN);
                    cJSON_free(printed);
                    continue;
                }
                cJSON_free(printed);
            }
        }
        if (dst->payload[0] == '\0') strlcpy(dst->payload, "{}", sizeof(dst->payload));
        count++;
    }
    cJSON_Delete(root);
    *out = parsed;
    return count;
}

static void swap_events(schedule_event_t *events, int count)
{
    if (!ensure_lock()) {
        free(events);
        return;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    schedule_event_t *old = s_events;
    s_events = events;
    s_event_count = count;
    xSemaphoreGive(s_lock);
    free(old);
}

static esp_err_t persist(const char *json, size_t len)
{
    if (json == NULL || len == 0) {
        unlink(SCHEDULE_PATH);
        return ESP_OK;
    }
    FILE *f = fopen(SCHEDULE_TMP_PATH, "wb");
    if (f == NULL) return ESP_FAIL;
    bool ok = fwrite(json, 1, len, f) == len;
    ok = (fclose(f) == 0) && ok;
    if (!ok) {
        unlink(SCHEDULE_TMP_PATH);
        return ESP_FAIL;
    }
    unlink(SCHEDULE_PATH);
    if (rename(SCHEDULE_TMP_PATH, SCHEDULE_PATH) != 0) {
        unlink(SCHEDULE_TMP_PATH);
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t fos_schedule_set_json(const char *json, size_t len)
{
    if (json == NULL || len == 0) {
        swap_events(NULL, 0);
        persist(NULL, 0);
        return ESP_OK;
    }
    if (len > SCHEDULE_MAX_BYTES) return ESP_ERR_INVALID_SIZE;
    schedule_event_t *events = NULL;
    int count = parse_events(json, len, &events);
    if (count < 0) return ESP_ERR_INVALID_ARG;
    swap_events(events, count);
    esp_err_t err = persist(json, len);
    char line[160];
    snprintf(line, sizeof(line),
             "{\"event\":\"schedule:set\",\"source\":\"esp32\",\"events\":%d,"
             "\"utcOffsetMinutes\":%d,\"persisted\":%s}",
             count, s_utc_offset_minutes, err == ESP_OK ? "true" : "false");
    frameos_nim_log_hook(line);
    return err;
}

esp_err_t fos_schedule_init(void)
{
    if (!ensure_lock()) return ESP_ERR_NO_MEM;
    nvs_handle_t nvs;
    if (nvs_open("frameos", NVS_READONLY, &nvs) == ESP_OK) {
        int32_t offset = 0;
        if (nvs_get_i32(nvs, "utc_offset_min", &offset) == ESP_OK &&
            offset >= -14 * 60 && offset <= 14 * 60) {
            s_utc_offset_minutes = (int)offset;
        }
        nvs_close(nvs);
    }
    FILE *f = fopen(SCHEDULE_PATH, "rb");
    if (f == NULL) return ESP_OK; /* no schedule stored */
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (size <= 0 || size > SCHEDULE_MAX_BYTES) {
        fclose(f);
        return ESP_OK;
    }
    char *buf = malloc((size_t)size + 1);
    if (buf == NULL) {
        fclose(f);
        return ESP_ERR_NO_MEM;
    }
    size_t got = fread(buf, 1, (size_t)size, f);
    fclose(f);
    buf[got] = '\0';
    schedule_event_t *events = NULL;
    int count = parse_events(buf, got, &events);
    free(buf);
    if (count < 0) {
        ESP_LOGW(TAG, "stored schedule unparseable, ignoring");
        return ESP_OK;
    }
    swap_events(events, count);
    if (count > 0) ESP_LOGI(TAG, "schedule loaded: %d event(s)", count);
    return ESP_OK;
}

/* 1=Monday..7=Sunday, from a local-time struct tm (tm_wday: 0=Sunday). */
static int weekday_mon_sun(const struct tm *tm_local)
{
    return tm_local->tm_wday == 0 ? 7 : tm_local->tm_wday;
}

static bool weekday_matches(int event_weekday, int today)
{
    switch (event_weekday) {
        case 0: return true;
        case 1: case 2: case 3: case 4: case 5: case 6: case 7:
            return event_weekday == today;
        case 8: return today >= 1 && today <= 5;
        case 9: return today >= 6 && today <= 7;
        default: return false;
    }
}

static void fire_event(const schedule_event_t *event)
{
    char line[256];
    snprintf(line, sizeof(line),
             "{\"event\":\"schedule:fire\",\"source\":\"esp32\","
             "\"name\":\"%s\",\"hour\":%d,\"minute\":%d}",
             event->event, event->hour, event->minute);
    frameos_nim_log_hook(line);
    if (strcmp(event->event, "setCurrentScene") == 0) {
        cJSON *payload = cJSON_Parse(event->payload);
        const cJSON *scene = payload ? cJSON_GetObjectItem(payload, "sceneId") : NULL;
        if (!cJSON_IsString(scene)) {
            scene = payload ? cJSON_GetObjectItem(payload, "scene_id") : NULL;
        }
        if (cJSON_IsString(scene) && scene->valuestring[0]) {
            if (fos_scenes_select(scene->valuestring) == ESP_OK) {
                fos_client_render_now();
            } else {
                ESP_LOGW(TAG, "scheduled scene \"%s\" not loaded", scene->valuestring);
            }
        }
        cJSON_Delete(payload);
    } else if (strcmp(event->event, "render") == 0) {
        fos_client_render_now();
    } else if (frameos_nim_available()) {
        frameos_nim_send_event(event->event, event->payload);
        if (frameos_nim_render_requested()) fos_client_render_now();
    }
}

/* An EPD render + refresh can hold the render task for minutes, and this
 * tick only runs between renders — so evaluation CATCHES UP over every
 * wall-clock minute since the last tick (bounded), instead of sampling only
 * the current one. Events that fell inside a render window fire late (right
 * after it), oldest first, so the last matching scene change wins the
 * display — the correct behavior for a slow e-ink frame. */
#define SCHEDULE_CATCH_UP_MAX_MINUTES 180

bool fos_schedule_tick(void)
{
    if (s_event_count == 0) return false;
    /* Trust the clock itself, not the SNTP flag: the RTC survives soft
     * reboots, so time() can be valid on a boot whose own SNTP timed out. */
    time_t now = time(NULL);
    if (now < 1000000000) return false; /* clock not actually set */
    time_t local = now + (time_t)s_utc_offset_minutes * 60;
    int64_t minute_key = (int64_t)local / 60;
    if (minute_key == s_last_fired_minute) return false;
    /* First tick with a valid clock (boot, or SNTP landing late): treat the
     * current minute as un-evaluated. A quick reboot may re-fire an event
     * from the same minute — harmless for idempotent scene selects — but the
     * alternative (arming ON the minute) swallowed events whose minute
     * arrived while the clock was still syncing or a render was running. */
    if (s_last_fired_minute < 0) {
        s_last_fired_minute = minute_key - 1;
    }
    int64_t from = s_last_fired_minute + 1;
    if (minute_key - from >= SCHEDULE_CATCH_UP_MAX_MINUTES) {
        /* A very long gap (deep sleep, NTP step): evaluate only the recent
         * window rather than replaying hours of stale scene changes. */
        from = minute_key - SCHEDULE_CATCH_UP_MAX_MINUTES + 1;
    }
    if (minute_key < from) { /* NTP stepped the clock backwards */
        s_last_fired_minute = minute_key;
        return false;
    }
    s_last_fired_minute = minute_key;

    bool fired = false;
    if (!ensure_lock()) return false;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    for (int64_t key = from; key <= minute_key; key++) {
        time_t minute_local = (time_t)key * 60;
        struct tm tm_local;
        gmtime_r(&minute_local, &tm_local); /* offset already applied */
        int today = weekday_mon_sun(&tm_local);
        for (int i = 0; i < s_event_count; i++) {
            const schedule_event_t *event = &s_events[i];
            if (event->minute == tm_local.tm_min && event->hour == tm_local.tm_hour &&
                weekday_matches(event->weekday, today)) {
                fire_event(event);
                fired = true;
            }
        }
    }
    xSemaphoreGive(s_lock);
    return fired;
}
