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

#include <stdbool.h>

/* What FrameOS does on the way down from esp_restart() (a reboot, an update,
 * the console's `restart`): a hook a module, run newest first, as ESP-IDF
 * runs its own. Never esp_register_shutdown_handler(): ESP-IDF keeps five
 * such handlers in all (esp_system.c SHUTDOWN_HANDLERS_NO), its timekeeping
 * takes one and the Wi-Fi driver one more when its station or access point
 * first comes up. FrameOS's modules once took six of their own, so on a board
 * that brings Wi-Fi up late (a frame with no network saved, whose frame page
 * scans for one) the driver found the five taken and
 * esp_netif_create_default_wifi_sta aborted the board: the frame page's gear
 * restarted a reTerminal Sticky flashed without Wi-Fi (2026-11-25), and on a
 * board that joined early the sixth hook had been left out without a word.
 * FrameOS takes one of the five, here (fos_restart.c), the first time a hook
 * is added. The same hook twice is kept once; false when the list is full
 * (FOS_RESTART_HOOKS_MAX). */
typedef void (*fos_restart_hook_t)(void);
bool fos_on_restart(fos_restart_hook_t hook);
