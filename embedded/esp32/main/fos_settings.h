#pragma once

#include <stdbool.h>

#include "esp_err.h"

/* Pull declarative settings from the backend
 * (GET /api/frames/{id}/embedded/settings, ETag'd) and apply the `frame`
 * subset — interval, name, render mode, deep sleep, wake schedule — without
 * a rebuild. Runs on the render task, next to the scenes sync. */
esp_err_t fos_settings_sync(bool force);
void fos_settings_request_sync(void);
