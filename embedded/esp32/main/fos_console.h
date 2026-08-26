/*
 * Serial console for dev + headless provisioning, answering on UART0 (a
 * board's USB-UART bridge) and on the chip's USB-Serial/JTAG port alike:
 *   status | show | set <key> <value> | wifi <ssid> [pass] | render | ota
 *   restart | factory-reset
 */
#pragma once

#include "esp_err.h"

esp_err_t fos_console_start(void);
