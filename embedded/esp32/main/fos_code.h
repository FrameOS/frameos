/*
 * The code editor's host on an ESP32 (fos_code.c, docs/code-editor.md): what a
 * JS app reads and asks with frameos.code() (frameos/scene_code_hooks.nim).
 * Called by the Nim runtime on the render task (embedded_runtime.nim); the
 * work runs on the request task (fos_js_io_run).
 */
#pragma once

/* At boot. (Also what links this file in, as fos_store_init does.) */
void fos_code_init(void);
/* frameos.code(op, arg) as scene_code_hooks.nim documents it: the answer,
 * malloc'd JSON text ("!" and a reason to throw), NULL for null. "read" is
 * NULL when the frame does not offer its page (`frame_settings_on_screen`
 * off, unless `settings_unlock`); "source" `arg` is a scene id; "ask" and
 * "save" take the request body in `arg` and return at once, one action at a
 * time. `asker` is drawn again when an action is done, if it still shows. */
char *fos_code(const char *asker, const char *op, const char *arg);
