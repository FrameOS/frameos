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
