#pragma once

/* The stack of a task that only waits and calls esp_restart() (the reboot
 * verb, the frame page's restart, an OTA's restart into the early updater,
 * settings, HTTP, the cloud). esp_restart() runs the shutdown handlers on the
 * caller's stack, and one of them writes the scene state still waiting to
 * flash (scene_state_flush_on_restart in main.c, on SPIFFS: the work the
 * 4096-byte `state_wr` task does). At 2048 bytes the reTerminal E1004 hit
 * "stack overflow in task fos_ota_reboot" on `ota downgrade` with a scene's
 * state waiting (the hardware bench, 2026-11-17). */
#define FOS_RESTART_TASK_STACK 4096

/* Before a planned restart (the reboot and restart verbs, a firmware update,
 * a setting that needs one, the console's `restart`): `text` ("Updating...",
 * "Rebooting...", "Restarting...") in a band over what the panel shows, in
 * its fast waveform, so a frame that is about to stop answering says so.
 * Only where that is quick: an LCD, or an e-paper with a partial waveform
 * (fos_display_quick_update); anything else, no panel, or a render task busy
 * for longer than RESTART_NOTICE_TAKE_US, and nothing is drawn. Called from
 * any task: the render task draws it (it alone touches the panel), and the
 * caller waits for it at most ~2 s (fos_client.c). Call it, then restart. */
void fos_restart_notice(const char *text);
