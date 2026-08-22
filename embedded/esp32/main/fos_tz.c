#include "fos_tz.h"
#include "fos_config.h"
#include "fos_defaults.h"
#include "fos_scenes.h"
#include "fos_wifi.h"
#include "frameos_nim.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "fos_tz";
#define TZ_SLICE_PATH "/state/tz.json"
#define TZ_LOOKUP_URL_PREFIX "https://tz.frameos.net/zone/"
#define TZ_LOOKUP_RETRY_US (10LL * 60 * 1000 * 1000)
#define TZ_RULE_MAX 64

static bool s_active = false;
/* The zone the installed slice is for, so a name change is detectable. */
static char s_installed_zone[FOS_STR_LEN] = "";
/* One lookup attempt per name per 10 minutes: a zone tz.frameos.net does
 * not know must not turn every render pass into a TLS handshake. */
static char s_lookup_name[FOS_STR_LEN] = "";
static int64_t s_lookup_at_us = 0;

static bool is_utc_name(const char *name)
{
    return name == NULL || name[0] == '\0' || strcmp(name, "UTC") == 0 || strcmp(name, "Etc/UTC") == 0;
}

static void apply_rule(const char *rule)
{
    if (rule == NULL || rule[0] == '\0') {
        setenv("TZ", "UTC0", 1);
        tzset();
        s_active = false;
        return;
    }
    setenv("TZ", rule, 1);
    tzset();
    s_active = true;
}

static char *read_slice_file(void)
{
    FILE *f = fopen(TZ_SLICE_PATH, "rb");
    if (!f) return NULL;
    char *buf = malloc(FOS_TZ_SLICE_MAX_BYTES + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    size_t n = fread(buf, 1, FOS_TZ_SLICE_MAX_BYTES, f);
    fclose(f);
    buf[n] = '\0';
    if (n == 0) {
        free(buf);
        return NULL;
    }
    return buf;
}

static void write_slice_file(const char *slice_json)
{
    if (!fos_scenes_state_mounted()) return;
    char *current = read_slice_file();
    bool same = current && strcmp(current, slice_json) == 0;
    free(current);
    if (same) return;
    FILE *f = fopen(TZ_SLICE_PATH, "wb");
    if (!f) {
        ESP_LOGW(TAG, "could not write %s", TZ_SLICE_PATH);
        return;
    }
    fwrite(slice_json, 1, strlen(slice_json), f);
    fclose(f);
}

bool fos_tz_install(const char *slice_json)
{
    fos_config_t *config = fos_config();
    if (is_utc_name(config->time_zone)) {
        apply_rule(NULL);
        s_installed_zone[0] = '\0';
        ESP_LOGI(TAG, "time zone: UTC");
        return true;
    }
    if (slice_json == NULL || slice_json[0] == '\0' || strlen(slice_json) > FOS_TZ_SLICE_MAX_BYTES) {
        return false;
    }
    char rule[TZ_RULE_MAX];
    if (!frameos_nim_load_tz_data(slice_json, config->time_zone, rule, sizeof(rule))) {
        ESP_LOGW(TAG, "tz slice unusable for '%s' (nim runtime %s)", config->time_zone,
                 frameos_nim_available() ? "rejected it" : "not up: thin client stays in UTC");
        return false;
    }
    apply_rule(rule);
    strlcpy(s_installed_zone, config->time_zone, sizeof(s_installed_zone));
    write_slice_file(slice_json);
    ESP_LOGI(TAG, "time zone: %s (TZ=%s)", config->time_zone, rule);
    return true;
}

void fos_tz_clear(void)
{
    apply_rule(NULL);
    s_installed_zone[0] = '\0';
}

void fos_tz_boot(void)
{
    fos_config_t *config = fos_config();
    if (is_utc_name(config->time_zone)) {
        fos_tz_install(NULL);
        return;
    }
    char *stored = read_slice_file();
    if (stored && fos_tz_install(stored)) {
        free(stored);
        return;
    }
    free(stored);
    if (FRAMEOS_DEFAULT_TZ_DATA[0] && fos_tz_install(FRAMEOS_DEFAULT_TZ_DATA)) {
        return;
    }
    ESP_LOGW(TAG, "no tz data for '%s' yet; UTC until a slice arrives", config->time_zone);
}

bool fos_tz_active(void)
{
    return s_active;
}

bool fos_tz_slice_missing(void)
{
    const fos_config_t *config = fos_config();
    return !is_utc_name(config->time_zone) && strcmp(s_installed_zone, config->time_zone) != 0;
}

static esp_err_t fetch_slice(const char *name, char *out, size_t out_len)
{
    char url[sizeof(TZ_LOOKUP_URL_PREFIX) + FOS_STR_LEN + 8];
    snprintf(url, sizeof(url), TZ_LOOKUP_URL_PREFIX "%s.json", name);
    esp_http_client_config_t http_config = {
        .url = url,
        .timeout_ms = 10000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 1024,
    };
    esp_http_client_handle_t client = esp_http_client_init(&http_config);
    if (client == NULL) return ESP_FAIL;
    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        esp_http_client_cleanup(client);
        return err;
    }
    int64_t content_length = esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);
    if (status != 200 || content_length > (int64_t)out_len - 1) {
        ESP_LOGW(TAG, "tz lookup for '%s': HTTP %d (%lld bytes)", name, status, (long long)content_length);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return status == 404 ? ESP_ERR_NOT_FOUND : ESP_FAIL;
    }
    int total = 0;
    while (total < (int)out_len - 1) {
        int n = esp_http_client_read(client, out + total, (int)out_len - 1 - total);
        if (n <= 0) break;
        total += n;
    }
    out[total] = '\0';
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    return out[0] ? ESP_OK : ESP_FAIL;
}

void fos_tz_resolve_pending(void)
{
    fos_config_t *config = fos_config();
    if (!fos_tz_slice_missing() || !frameos_nim_available()) return;
    if (fos_wifi_ip()[0] == '\0' || fos_wifi_state() == FOS_WIFI_PORTAL) return;
    int64_t now = esp_timer_get_time();
    if (strcmp(s_lookup_name, config->time_zone) == 0 && now - s_lookup_at_us < TZ_LOOKUP_RETRY_US) return;
    strlcpy(s_lookup_name, config->time_zone, sizeof(s_lookup_name));
    s_lookup_at_us = now;

    char *slice = malloc(FOS_TZ_SLICE_MAX_BYTES + 1);
    if (!slice) return;
    esp_err_t err = fetch_slice(config->time_zone, slice, FOS_TZ_SLICE_MAX_BYTES + 1);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "no tz data for '%s' yet (%s); staying on %s", config->time_zone,
                 esp_err_to_name(err), s_active ? "the previous zone" : "UTC");
    } else if (fos_tz_install(slice)) {
        ESP_LOGI(TAG, "time zone %s resolved via tz.frameos.net", config->time_zone);
    }
    free(slice);
}

int fos_tz_offset_minutes(time_t now)
{
    if (!s_active) return 0;
    struct tm local_tm;
    struct tm utc_tm;
    localtime_r(&now, &local_tm);
    gmtime_r(&now, &utc_tm);
    int local_minutes = local_tm.tm_hour * 60 + local_tm.tm_min;
    int utc_minutes = utc_tm.tm_hour * 60 + utc_tm.tm_min;
    int diff = local_minutes - utc_minutes;
    /* The two calendars can sit on different days around midnight. */
    int day_delta = local_tm.tm_yday - utc_tm.tm_yday;
    if (local_tm.tm_year != utc_tm.tm_year) {
        day_delta = local_tm.tm_year > utc_tm.tm_year ? 1 : -1;
    }
    diff += day_delta * 24 * 60;
    return diff;
}
