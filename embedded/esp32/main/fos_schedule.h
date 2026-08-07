#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "esp_err.h"

/* On-device scene schedule: the same event model the Pi runtime's scheduler
 * uses (docs/cloud-frames.md set_schedule; frameos/src/frameos/scheduler.nim)
 * — events fire when the wall-clock minute matches:
 *   {"events":[{"id","minute":0-59,"hour":0-23,
 *               "weekday":0(daily)|1-7(mon-sun)|8(weekdays)|9(weekends),
 *               "event":"setCurrentScene","payload":{...}}, ...]}
 * Matching happens in frame-local time: UTC from SNTP plus the backend- or
 * cloud-provided offset (fos_schedule_set_utc_offset_minutes). Persisted to
 * /state/schedule.json; evaluated once per wall-clock minute on the render
 * task, deduped so an NTP step never fires a minute twice. */

esp_err_t fos_schedule_init(void);

/* Replace the schedule. `json` is either the events object itself or a
 * wrapper {"schedule": {...}}. NULL/empty clears it. */
esp_err_t fos_schedule_set_json(const char *json, size_t len);

int fos_schedule_event_count(void);

/* Offset applied to UTC for matching (persisted via fos_config). */
void fos_schedule_set_utc_offset_minutes(int minutes);
int fos_schedule_utc_offset_minutes(void);

/* Called from the render task's wait loop (~1 Hz). Fires matching events:
 * setCurrentScene selects + requests a render, anything else goes to the
 * Nim runtime as a scene event. Returns true when something fired. */
bool fos_schedule_tick(void);
