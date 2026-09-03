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

/* Compare two NUL-terminated secrets without stopping at the first
 * differing byte, so response timing does not leak how much of an API key
 * or password prefix was right. Lengths still differ in time; the length of
 * a credential is not the secret. */
bool fos_consttime_eq(const char *a, const char *b);
bool fos_http_is_running(void);
void fos_http_stop(void);
/* Wired by main: "render now" and "check OTA now" triggers. */
void fos_http_set_actions(fos_action_cb render_now, fos_action_cb ota_now);

/* Shared by the USB console API so serial control matches the HTTP routes. */
esp_err_t fos_http_store_uploaded_scenes_payload(const char *body, size_t len);
char *fos_http_status_json(void);

/* Partition-map byte counts, read fresh from the partition table. Shared by
 * the /status JSON and the cloud "hardware" report (fos_cloud.c) so both
 * describe the same layout. */
typedef struct {
    uint32_t flash_bytes;
    uint32_t nvs_bytes;
    uint32_t otadata_bytes;
    uint32_t phy_bytes;
    uint32_t factory_slot_bytes;
    uint32_t ota_slots;
    uint32_t ota_slot_bytes;
    uint32_t ota_bytes;
    uint32_t state_bytes;
} fos_storage_info_t;

void fos_http_collect_storage_info(fos_storage_info_t *info);
esp_err_t fos_http_preview_bmp_alloc(uint8_t **out, size_t *out_len, char *scene_id, size_t scene_id_len);

/* The same BMP, streamed: `begin` is called once with the total byte count,
 * then `write` with the header, the palette and each pixel row (bottom-up,
 * BMP order) until the image is complete. A `write` returning false aborts
 * the stream (ESP_FAIL). Reads the packed snapshot in place under its lock
 * — no copy of the framebuffer, no whole-image buffer — which is what lets
 * an 8 MB board with a 960 KB panel serve a preview at all. ESP_ERR_NOT_FOUND
 * when nothing is rendered; ESP_ERR_TIMEOUT when the snapshot stayed locked
 * (a render packing into it) for `lock_timeout_ms`. */
typedef struct {
    void (*begin)(void *ctx, size_t total);
    bool (*write)(void *ctx, const uint8_t *data, size_t len);
} fos_preview_sink_t;
esp_err_t fos_http_preview_bmp_stream(const fos_preview_sink_t *sink, void *ctx,
                                      uint32_t lock_timeout_ms,
                                      char *scene_id, size_t scene_id_len);
