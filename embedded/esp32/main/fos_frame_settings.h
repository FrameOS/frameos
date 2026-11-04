/*
 * The frame tab of the settings panel on the screen (fos_frame_settings.c,
 * docs/scene-settings.md "The frame tab"). Called by the Nim runtime on the
 * render task (embedded_runtime.nim).
 */
#pragma once

/* At boot, before Wi-Fi starts: the panel follows the network's changes.
 * (Also what links this file in: the Nim runtime's calls alone come too late
 * in the link to pull it out of main's library.) */
void fos_frame_settings_init(void);
/* What the tab shows, as the scene's frameSettingsRead documents it: a
 * malloc'd JSON string, NULL when out of memory. */
char *fos_frame_settings_json(void);
/* The fields changed on the tab, by name: `wifiSsid`, `wifiPassword`,
 * `rotate`. Wi-Fi is joined in the background; a rotation restarts. */
void fos_frame_settings_apply(const char *json);
/* "scan", or "open" when the tab comes up (a scan when off Wi-Fi). */
void fos_frame_settings_action(const char *action);
