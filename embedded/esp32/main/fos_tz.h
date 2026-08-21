#pragma once

#include <stdbool.h>
#include <time.h>

/* Time zone for the ESP32, without a tz database.
 *
 * The frame stores an IANA zone name (config->time_zone, e.g.
 * "Europe/Brussels"); this module maps it to the POSIX TZ rule in force
 * today (fos_tz_table.h, generated from the TZif footers by
 * embedded/esp32/tools/gen_tz_table.py) and installs it with setenv("TZ")
 * + tzset(). From then on newlib's localtime_r() — and so QuickJS `Date`,
 * Nim's std/times `now()`, and the on-device schedule — run in that zone,
 * DST included. An empty name means UTC, the pre-2026.8.34 behaviour. */

/* The POSIX rule for `name`, or NULL when the zone is unknown. */
const char *fos_tz_rule(const char *name);

/* Install `name` (NULL/"" = UTC). Returns false and leaves the previous
 * zone in place when the name is unknown. */
bool fos_tz_apply(const char *name);

/* True when a zone other than UTC is installed. */
bool fos_tz_active(void);

/* The zone's offset from UTC at `now`, in minutes (DST-aware). 0 when no
 * zone is installed. */
int fos_tz_offset_minutes(time_t now);
