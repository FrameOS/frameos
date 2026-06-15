#pragma once

#include "esp_err.h"

/* Render a minimal on-device status screen without using Nim/pixie. */
esp_err_t fos_status_screen_show_portal(const char *ssid, const char *ip);
