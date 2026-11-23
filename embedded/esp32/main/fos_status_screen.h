#pragma once

#include "esp_err.h"

/* The provisioning portal's screen (fos_portal_screen.h) on the panel, drawn
 * without Nim/pixie: the hotspot's join code and the setup page's. */
esp_err_t fos_status_screen_show_portal(const char *ssid, const char *psk, const char *ip);
