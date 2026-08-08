#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#include "fos_config.h"

/* Room for esp_err_to_name() plus the human-readable cause. */
#define FOS_ASSETS_SD_ERROR_LEN 384
/* Structured "assets:sd" log line; stays well under FOS_NIM_LOG_MAX_LINE. */
#define FOS_ASSETS_SD_LOG_LEN 768

/* Boot-time mount. NEVER formats: a card that fails to mount is left exactly
 * as the user handed it over, and the reason is reported instead (see
 * fos_assets_sd.c for the exFAT trap). */
esp_err_t fos_assets_sd_mount(const fos_config_t *config);
/* Explicit user actions, triggered by hand and never automatically:
 *  - remount: unmount and mount again, for a card inserted after boot.
 *  - format: ERASES the card and writes a fresh FAT volume. Only acts on a
 *    card that carries no volume this firmware can mount; a card that mounts
 *    is left alone. Whoever calls this must have told the user it erases. */
esp_err_t fos_assets_sd_remount(void);
esp_err_t fos_assets_sd_format(void);
bool fos_assets_sd_mounted(void);
uint64_t fos_assets_sd_capacity_bytes(void);
/* "" when mounted, else "<ESP_ERR_NAME> (<reason code>): <explanation>", where
 * the reason code is one of no_card / unreadable_filesystem / io_error /
 * not_configured / unsupported. */
const char *fos_assets_sd_last_error(void);
/* Just the reason code, for callers that want to branch on it. */
const char *fos_assets_sd_last_error_code(void);
/* Re-emit the last mount outcome into the log ring (used once log upload is
 * enabled, since the mount itself happens before Wi-Fi is up). */
void fos_assets_sd_log_status(void);
