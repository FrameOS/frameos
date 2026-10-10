/*
 * Serial console for dev + headless provisioning, answering on UART0 (a
 * board's USB-UART bridge) and on the chip's USB-Serial/JTAG port alike:
 *   status | show | set <key> <value> | wifi <ssid> [pass] | render | ota
 *   restart | factory-reset
 */
#pragma once

#include "esp_err.h"

esp_err_t fos_console_start(void);

/* One `set <key> <value>` exactly as the console runs it (validation,
 * persisting, the lot), for a caller that is not the console: the backend's
 * queued deploy settings (fos_settings.c). Returns 0 on success. The caller
 * decides which keys may arrive that way (fos_device_request.h). */
int fos_console_apply_setting(const char *key, const char *value);
