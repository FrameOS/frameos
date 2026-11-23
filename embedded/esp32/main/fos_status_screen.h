#pragma once

#include <stdbool.h>

#include "esp_err.h"

/* The provisioning portal's screen (fos_portal_screen.h) on the panel, drawn
 * without Nim/pixie: the hotspot's join code and the setup page's. The
 * render task's fallback (fos_client.c show_portal_screen). */
esp_err_t fos_status_screen_show_portal(const char *ssid, const char *psk, const char *ip);

/* Whether only the circle inside the panel shows: frameos_display's, or
 * false where that does not say (a weak default in fos_status_screen.c). */
bool fos_display_round(void);
