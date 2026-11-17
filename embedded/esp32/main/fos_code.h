/*
 * The code editor's host on an ESP32 (fos_code.c, docs/code-editor.md): what a
 * JS app reads and asks with frameos.code() (frameos/scene_code_hooks.nim).
 * Called by the Nim runtime on the render task (embedded_runtime.nim); the
 * work runs on the request task (fos_js_io_run).
 */
#pragma once

/* At boot. (Also what links this file in, as fos_store_init does.) */
void fos_code_init(void);
/* The facts, as scene_code_hooks.nim documents them: a malloc'd JSON string;
 * NULL when the frame does not offer its page (`frame_settings_on_screen`
 * off, unless `settings_unlock`) or there is no memory. `asker` is drawn
 * again when an action is done, if it still shows. */
char *fos_code_json(const char *asker);
/* A scene's JSON text as the scene store holds it, or the AI's last scene
 * for "\x01draft"; malloc'd, NULL without one. */
char *fos_code_source(const char *what);
/* ask {prompt, scene?}, save {scene, show?}, clear; `args` a JSON object's
 * text. Returns at once; one action at a time. */
void fos_code_action(const char *asker, const char *action, const char *args);
