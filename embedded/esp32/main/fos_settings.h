#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "esp_err.h"
#include "cJSON.h"
#include "fos_config.h"

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
/* Apply a cloud `set_settings` object (docs/cloud-frames.md; the keys of
 * CLOUD_SETTINGS_ALLOWLIST_ESP32 in frameos/cloud/verbs.nim, snake_case) to
 * fos_config and persist it. The shared verb layer has already shape-checked
 * every value; this is where they land in NVS, where a live key (interval,
 * debug, scaling_mode, the power keys, timezone + its tzdata slice) takes
 * effect and where the boot-time ones (rotate, battery sensing, the HTTP
 * ceiling, GPIO buttons) set *reboot so the caller restarts the device.
 * Failure: *err is "invalid_settings" (a value the device refuses — the
 * config is left untouched in NVS) or "persist_failed". */
esp_err_t fos_settings_apply_cloud_json(const cJSON *settings, const char **err,
                                        bool *reboot);
/* Which declarative settings differ between two config snapshots, as the
 * wire's snake_case keys with their new values ("deep_sleep_on_battery=false,
 * interval=900"), for the log line that confirms what a settings push or
 * poll actually changed on the device. Empty string when nothing did. */
void fos_settings_describe_changes(const fos_config_t *before, const fos_config_t *after,
                                   char *out, size_t out_len);
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
