#include "fos_device_request.h"

#include <string.h>

/* The `set` keys the backend's provisioning plan may send, minus the ones
 * that connect the frame to its control plane (see the header). */
static const char *const k_console_keys[] = {
    "hardware",
    "panel",
    "pins",
    "gpio_buttons",
    "hostname",
    "render_mode",
    "interval",
    "rotate",
    "scaling_mode",
    "time_zone",
    "server_send_logs",
    "max_http_response_bytes",
    "admin_user",
    "admin_pass",
    "admin_auth",
    "assets_sd",
    "assets_sd_pins",
    "assets_sd_freq",
    "deep_sleep",
    "deep_sleep_on_battery",
    "wake_check",
    "wake_schedule",
    "battery_pin",
    "battery_divider",
    "battery_enable_pin",
};

static bool valid_request_id(const char *value)
{
    size_t len = strlen(value);
    if (len == 0 || len >= FOS_DEVICE_REQUEST_ID_LEN) return false;
    for (const char *p = value; *p; p++) {
        char c = *p;
        bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                  (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == ':';
        if (!ok) return false;
    }
    return true;
}

fos_device_request_decision_t fos_device_request_decide(const char *request_id, const char *applied_id)
{
    if (request_id == NULL || request_id[0] == '\0') return FOS_DEVICE_REQUEST_NONE;
    if (!valid_request_id(request_id)) return FOS_DEVICE_REQUEST_INVALID;
    if (applied_id != NULL && applied_id[0] != '\0' && strcmp(applied_id, request_id) == 0) {
        return FOS_DEVICE_REQUEST_SEEN;
    }
    return FOS_DEVICE_REQUEST_APPLY;
}

bool fos_device_request_console_key_allowed(const char *key)
{
    if (key == NULL) return false;
    for (size_t i = 0; i < sizeof(k_console_keys) / sizeof(k_console_keys[0]); i++) {
        if (strcmp(key, k_console_keys[i]) == 0) return true;
    }
    return false;
}
