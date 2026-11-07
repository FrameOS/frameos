/*
 * The frame page of the settings panel on the screen, behind its gear
 * (fos_frame_settings.c, docs/scene-settings.md "The frame page"). Called by
 * the Nim runtime on the render task (embedded_runtime.nim).
 */
#pragma once

/* At boot, before Wi-Fi starts: the panel follows the network's changes.
 * (Also what links this file in: the Nim runtime's calls alone come too late
 * in the link to pull it out of main's library.) */
void fos_frame_settings_init(void);
/* The page's facts, as the scene's frameSettingsRead documents them: a
 * malloc'd JSON string; NULL when the page is turned off (the frame's
 * `frame_settings_on_screen`, unless `settings_unlock`) or out of memory. */
char *fos_frame_settings_json(void);
/* What Save changed, by name: `wifiSsid` with `wifiPassword`, `rotate`,
 * `renderScale`. Wi-Fi is joined in the background, the scale is live, a
 * rotation restarts. */
void fos_frame_settings_apply(const char *json);
/* "scan", or "open" when the page comes up (a scan when off Wi-Fi). */
void fos_frame_settings_action(const char *action);
