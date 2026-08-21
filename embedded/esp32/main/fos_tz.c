#include "fos_tz.h"
#include "fos_tz_table.h"

#include <stdlib.h>
#include <string.h>

#include "esp_log.h"

static const char *TAG = "fos_tz";
static bool s_active = false;

const char *fos_tz_rule(const char *name)
{
    if (name == NULL || name[0] == '\0') return NULL;
    int lo = 0;
    int hi = FOS_TZ_ENTRY_COUNT - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        int cmp = strcmp(FOS_TZ_ENTRIES[mid].name, name);
        if (cmp == 0) return FOS_TZ_RULES[FOS_TZ_ENTRIES[mid].rule];
        if (cmp < 0) lo = mid + 1;
        else hi = mid - 1;
    }
    return NULL;
}

bool fos_tz_apply(const char *name)
{
    if (name == NULL || name[0] == '\0' || strcmp(name, "UTC") == 0 ||
        strcmp(name, "Etc/UTC") == 0) {
        setenv("TZ", "UTC0", 1);
        tzset();
        s_active = false;
        ESP_LOGI(TAG, "time zone: UTC");
        return true;
    }
    const char *rule = fos_tz_rule(name);
    if (rule == NULL) {
        ESP_LOGW(TAG, "unknown time zone '%s'; keeping the current one", name);
        return false;
    }
    setenv("TZ", rule, 1);
    tzset();
    s_active = true;
    ESP_LOGI(TAG, "time zone: %s (%s)", name, rule);
    return true;
}

bool fos_tz_active(void)
{
    return s_active;
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
