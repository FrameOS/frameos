/*
 * On-device HTTP server. Two hats, one route layer:
 *  - provisioning portal (captive-portal probes + setup form) in AP mode
 *  - status/admin endpoints (/, /status, /api/setup, /api/action/...) in STA mode
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

typedef void (*fos_action_cb)(void);

esp_err_t fos_http_start(bool portal_mode);
bool fos_http_is_running(void);
void fos_http_stop(void);
/* Wired by main: "render now" and "check OTA now" triggers. */
void fos_http_set_actions(fos_action_cb render_now, fos_action_cb ota_now);

/* Shared by the USB console API so serial control matches the HTTP routes. */
esp_err_t fos_http_store_uploaded_scenes_payload(const char *body, size_t len);
char *fos_http_status_json(void);
esp_err_t fos_http_preview_bmp_alloc(uint8_t **out, size_t *out_len, char *scene_id, size_t scene_id_len);
