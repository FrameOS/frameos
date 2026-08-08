#pragma once

#include <stdbool.h>

#include "esp_err.h"

/* Pull declarative settings and apply them without a rebuild. Runs on the
 * render task, next to the scenes sync, ETag'd against one of two sources:
 *
 *  - a FrameOS backend (GET /api/frames/{id}/embedded/settings) — the `frame`
 *    subset (interval, name, render mode, deep sleep, wake schedule), the
 *    schedule, and the service-settings groups at the payload root;
 *  - failing that, a cloud provider (GET /api/frames/{uuid}/service-settings,
 *    docs/cloud-frames.md) — the six cloud-owned service-settings groups
 *    under `settings`. Only while `settings:services` has been announced.
 *
 * Both feed frameos_nim_apply_service_settings, which replaces the groups the
 * payload carries and deletes the ones it does not. */
esp_err_t fos_settings_sync(bool force);
void fos_settings_request_sync(void);

/* A cloud session reached `ready`. Pass whether its scopes list contained
 * `settings:services`: true enables the provider source, lifts a block left by
 * an earlier `403 insufficient_scope`, and requests one pull before the next
 * render. False does nothing at all — a device's scope list is additive and
 * never forgets, so a revocation is the provider's 403, not a quiet scope. */
void fos_settings_cloud_scope_granted(bool granted);
/* Has `settings:services` been announced at any point this boot? Gates the
 * `refresh_service_settings` verb. */
bool fos_settings_cloud_scope(void);
