#include "pk_settings_parse.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "pk_json.h"

static void note(char *summary, size_t cap, const char *fmt, ...)
{
    if (summary == NULL || cap == 0) return;
    size_t used = strlen(summary);
    if (used + 3 >= cap) return;
    if (used > 0) used += (size_t)snprintf(summary + used, cap - used, ", ");
    va_list args;
    va_start(args, fmt);
    vsnprintf(summary + used, cap - used, fmt, args);
    va_end(args);
}

// A flag the document may omit (the backend stays silent about power keys it
// holds no value for, so the device's own copy survives).
static bool apply_flag(const char *json, size_t len, const char *path, uint8_t *field)
{
    pk_json_slice_t value;
    bool flag = false;
    if (!pk_json_find(json, len, path, &value) || !pk_json_as_bool(value, &flag)) return false;
    if ((*field != 0) == flag) return false;
    *field = flag ? 1 : 0;
    return true;
}

unsigned pk_settings_apply(const char *json, size_t len, pk_config_t *config,
                           char *summary, size_t summary_cap)
{
    if (summary && summary_cap) summary[0] = '\0';
    pk_json_slice_t frame;
    if (json == NULL || config == NULL || !pk_json_find(json, len, "frame", &frame) ||
        frame.len == 0 || frame.start[0] != '{') {
        return PK_SETTINGS_INVALID;
    }

    unsigned changed = 0;
    pk_json_slice_t value;

    // Sent as a float ("300.0"); whole seconds are all the RTC can count.
    long interval = 0;
    if (pk_json_find(json, len, "frame.interval", &value) && pk_json_as_long(value, &interval)) {
        if (interval < PK_INTERVAL_MIN_SECONDS) interval = PK_INTERVAL_MIN_SECONDS;
        if ((uint32_t)interval != config->interval_seconds) {
            note(summary, summary_cap, "interval %lu->%ld",
                 (unsigned long)config->interval_seconds, interval);
            config->interval_seconds = (uint32_t)interval;
            changed |= PK_SETTINGS_CHANGED_INTERVAL;
        }
    }

    char name[PK_NAME_LEN];
    if (pk_json_find(json, len, "frame.name", &value) && pk_json_as_string(value, name, sizeof(name)) &&
        strcmp(name, config->name) != 0) {
        snprintf(config->name, sizeof(config->name), "%s", name);
        note(summary, summary_cap, "name");
        changed |= PK_SETTINGS_CHANGED_NAME;
    }

    if (apply_flag(json, len, "frame.deepSleep", &config->deep_sleep)) {
        note(summary, summary_cap, "deepSleep %s", config->deep_sleep ? "on" : "off");
        changed |= PK_SETTINGS_CHANGED_DEEP_SLEEP;
    }
    if (apply_flag(json, len, "frame.deepSleepOnBattery", &config->deep_sleep_on_battery)) {
        note(summary, summary_cap, "deepSleepOnBattery %s",
             config->deep_sleep_on_battery ? "on" : "off");
        changed |= PK_SETTINGS_CHANGED_DEEP_SLEEP;
    }

    // The device's own page login. All three move together, and "enabled"
    // without both credentials is refused — the same rule `set admin_auth`
    // applies — so a half-filled document cannot lock the pages open or shut.
    char user[PK_NAME_LEN];
    char pass[PK_STR_LEN];
    bool enabled = false;
    pk_json_slice_t user_value, pass_value;
    if (pk_json_find(json, len, "frame.adminAuth.enabled", &value) && pk_json_as_bool(value, &enabled) &&
        pk_json_find(json, len, "frame.adminAuth.user", &user_value) &&
        pk_json_as_string(user_value, user, sizeof(user)) &&
        pk_json_find(json, len, "frame.adminAuth.pass", &pass_value) &&
        pk_json_as_string(pass_value, pass, sizeof(pass)) && strchr(user, ':') == NULL) {
        if (enabled && (!user[0] || !pass[0])) enabled = false;
        bool differs = (config->admin_auth != 0) != enabled || strcmp(config->admin_user, user) != 0 ||
                       strcmp(config->admin_pass, pass) != 0;
        if (differs) {
            config->admin_auth = enabled ? 1 : 0;
            snprintf(config->admin_user, sizeof(config->admin_user), "%s", user);
            snprintf(config->admin_pass, sizeof(config->admin_pass), "%s", pass);
            note(summary, summary_cap, "adminAuth %s", enabled ? "on" : "off");
            changed |= PK_SETTINGS_CHANGED_ADMIN_AUTH;
        }
    }

    return changed;
}
