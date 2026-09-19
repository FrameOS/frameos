// The settings pull against the document shape the backend serves
// (backend/app/api/embedded_device.py embedded_frame_settings).
#include "pk_settings_parse.h"
#include "pk_config_keys.h"
#include "pk_test.h"

static const char DOCUMENT[] =
    "{\"openAI\":{\"apiKey\":\"sk-x\"},"
    "\"frame\":{\"interval\":900.0,\"name\":\"Hallway\",\"renderMode\":\"remote\",\"deepSleep\":true,"
    "\"wakeSchedule\":false,\"deepSleepOnBattery\":true,\"rotate\":90,\"scalingMode\":\"cover\","
    "\"timeZone\":\"Europe/Brussels\",\"timeZoneData\":\"AAAA\",\"utcOffsetMinutes\":120,"
    "\"maxHttpResponseBytes\":4194304,"
    "\"adminAuth\":{\"enabled\":true,\"user\":\"admin\",\"pass\":\"hunter2\"},"
    "\"tls\":{\"enable\":false,\"port\":8443,\"cert\":\"\",\"key\":\"\"}},"
    "\"schedule\":{\"events\":[]}}";

int main(void)
{
    pk_config_t config;
    char summary[160];
    pk_config_defaults(&config);

    unsigned changed = pk_settings_apply(DOCUMENT, sizeof(DOCUMENT) - 1, &config, summary, sizeof(summary));
    CHECK(changed == (PK_SETTINGS_CHANGED_INTERVAL | PK_SETTINGS_CHANGED_NAME |
                      PK_SETTINGS_CHANGED_DEEP_SLEEP | PK_SETTINGS_CHANGED_ADMIN_AUTH));
    CHECK(config.interval_seconds == 900);
    CHECK_STR(config.name, "Hallway");
    CHECK(config.deep_sleep == 1 && config.deep_sleep_on_battery == 1);
    CHECK(config.admin_auth == 1);
    CHECK_STR(config.admin_user, "admin");
    CHECK_STR(config.admin_pass, "hunter2");
    // The log line names what changed and never carries the password.
    CHECK(strstr(summary, "interval 300->900") != NULL);
    CHECK(strstr(summary, "deepSleep on") != NULL);
    CHECK(strstr(summary, "hunter2") == NULL);

    // Steady state: the same document changes nothing (no flash write).
    changed = pk_settings_apply(DOCUMENT, sizeof(DOCUMENT) - 1, &config, summary, sizeof(summary));
    CHECK(changed == 0);
    CHECK_STR(summary, "");

    // The backend stays silent about power keys it holds no value for: the
    // device's own copy survives.
    const char *quiet = "{\"frame\":{\"interval\":900,\"name\":\"Hallway\",\"deepSleep\":false}}";
    changed = pk_settings_apply(quiet, strlen(quiet), &config, summary, sizeof(summary));
    CHECK(changed == PK_SETTINGS_CHANGED_DEEP_SLEEP);
    CHECK(config.deep_sleep == 0 && config.deep_sleep_on_battery == 1);
    CHECK(config.admin_auth == 1); // no adminAuth object: untouched

    // Enabled without credentials is refused rather than locking the pages.
    const char *half = "{\"frame\":{\"adminAuth\":{\"enabled\":true,\"user\":\"\",\"pass\":\"\"}}}";
    changed = pk_settings_apply(half, strlen(half), &config, summary, sizeof(summary));
    CHECK(changed == PK_SETTINGS_CHANGED_ADMIN_AUTH);
    CHECK(config.admin_auth == 0);

    // A sub-minimum interval is clamped, not obeyed.
    const char *fast = "{\"frame\":{\"interval\":1}}";
    pk_settings_apply(fast, strlen(fast), &config, summary, sizeof(summary));
    CHECK(config.interval_seconds == PK_INTERVAL_MIN_SECONDS);

    // Garbage leaves the config alone.
    pk_config_t before = config;
    static const char *const bad[] = {"", "[]", "{\"frame\":5}", "{\"frame\":", "<html>502</html>", "{\"settings\":{}}"};
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        changed = pk_settings_apply(bad[i], strlen(bad[i]), &config, summary, sizeof(summary));
        CHECK(changed == PK_SETTINGS_INVALID);
        CHECK(memcmp(&before, &config, sizeof(config)) == 0);
    }
    // Wrong types inside a valid frame object are skipped key by key.
    const char *typed = "{\"frame\":{\"interval\":\"soon\",\"name\":7,\"deepSleep\":\"yes\"}}";
    changed = pk_settings_apply(typed, strlen(typed), &config, summary, sizeof(summary));
    CHECK(changed == 0);
    CHECK(memcmp(&before, &config, sizeof(config)) == 0);

    // A name too long for the field is ignored, not truncated.
    char long_name[256];
    snprintf(long_name, sizeof(long_name), "{\"frame\":{\"name\":\"%0*d\"}}", PK_NAME_LEN + 10, 7);
    changed = pk_settings_apply(long_name, strlen(long_name), &config, summary, sizeof(summary));
    CHECK(changed == 0);

    return pk_test_result("test_pk_settings_parse");
}
