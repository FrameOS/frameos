/*
 * Serial console (USB Serial/JTAG) for dev + headless provisioning:
 *   status | show | set <key> <value> | wifi <ssid> [pass] | render | ota
 *   restart | factory-reset
 */
#pragma once

#include "esp_err.h"

esp_err_t fos_console_start(void);
