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

/* Cloud-only frames: apply the NVS copy of the service-settings groups
 * saved by the last successful pull, before the first render — a deep-sleep
 * frame's only pass runs before its session's `ready` could ask for a pull.
 * True when a copy was applied; `ready` then skips the network pull while
 * the copy is under 6 h old (the provider's `refresh_service_settings`
 * nudge still forces one). Call once at boot after the Nim runtime is up. */
bool fos_settings_boot_apply_cache(void);
/* Drop the NVS copy: on a `403 insufficient_scope`, and when the frame
 * leaves cloud management. */
void fos_settings_forget_cache(void);
