/*
 * On-device HTTP server. Two hats, one route layer:
 *  - provisioning portal (captive-portal probes + setup form) in AP mode
 *  - status/admin endpoints (/, /status, /api/setup, /api/action/...) in STA mode
 */
#pragma once

#include <stdbool.h>
#include "esp_err.h"

typedef void (*fos_action_cb)(void);

esp_err_t fos_http_start(bool portal_mode);
bool fos_http_is_running(void);
void fos_http_stop(void);
/* Wired by main: "render now" and "check OTA now" triggers. */
void fos_http_set_actions(fos_action_cb render_now, fos_action_cb ota_now);
