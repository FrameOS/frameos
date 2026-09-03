#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <time.h>

/* Time zone for the ESP32 — the Nim tz stack (lib/tz.nim + chrono), fed one
 * zone at a time.
 *
 * The full tzdata.json is ~1.4 MB; the chip keeps a per-zone SLICE instead:
 * that zone's transitions from last year on, ~1.5 KB, in the same
 * {"timezones","dstChanges"} shape, stored at /state/tz.json. The IANA name
 * (config->time_zone, NVS) says which zone; the slice is what makes it
 * true. fos_tz_install() hands the slice to the Nim runtime, which loads it
 * into chrono (exact conversions for scenes and apps) and returns the POSIX
 * TZ rule in force now; that rule goes into setenv("TZ") + tzset() so
 * newlib's localtime_r() — QuickJS `Date`, Nim `now()`, fos_schedule — agrees
 * with chrono, DST included.
 *
 * Where slices come from: the backend settings poll (timeZoneData), cloud
 * set_settings (timezone_data), and — when only a name
 * is known (console `set time_zone`, an older provider) — one fetch of
 * https://tz.frameos.net/zone/<Zone>.json (fos_tz_resolve_pending). An empty
 * name means UTC. Thin clients (no Nim runtime) stay in UTC. */

/* Boot: apply the stored slice (or the baked default) for config->time_zone.
 * Call after the Nim runtime is up and /state is mounted. */
void fos_tz_boot(void);

/* Store `slice_json` as the zone's data (written to /state/tz.json when it
 * differs) and apply it. NULL/"" with an empty zone name = UTC. Returns
 * false when the slice is unusable for config->time_zone; the previous
 * zone stays installed. */
bool fos_tz_install(const char *slice_json);

/* Forget the slice (zone name changed, or cleared): UTC until a slice for
 * the new name arrives or fos_tz_resolve_pending fetches one. */
void fos_tz_clear(void);

/* True when a zone other than UTC is installed. */
bool fos_tz_active(void);

/* True when config->time_zone names a zone but no slice for it is installed. */
bool fos_tz_slice_missing(void);

/* Resolve a configured name that has no slice: one HTTPS GET of
 * tz.frameos.net/zone/<Zone>.json, then fos_tz_install. No-op when nothing
 * is pending or the network is down; retries are rate-limited. Call from a
 * task with the network up (the render pass). */
void fos_tz_resolve_pending(void);

/* The zone's offset from UTC at `now`, in minutes (DST-aware). 0 when no
 * zone is installed. */
int fos_tz_offset_minutes(time_t now);

/* Largest slice accepted (JSON bytes). */
#define FOS_TZ_SLICE_MAX_BYTES 8192
