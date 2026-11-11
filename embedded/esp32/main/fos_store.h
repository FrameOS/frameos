/*
 * The scene store on the frame's own screen (fos_store.c,
 * docs/scene-store-on-frame.md): the facts the scene switcher's store pages
 * show and the work they ask for. Called by the Nim runtime on the render
 * task (embedded_runtime.nim); the work runs on a task of its own.
 */
#pragma once

/* At boot. (Also what links this file in: the Nim runtime's calls alone come
 * too late in the link to pull it out of main's library.) */
void fos_store_init(void);
/* The facts, as the scene's sceneStoreRead documents them: a malloc'd JSON
 * string; NULL when there is no store on the frame's screen (the frame's
 * `frame_settings_on_screen` is off, unless `settings_unlock`) or no memory. */
char *fos_store_json(void);
/* open, browse, info, preview, install, update, remove, discard, with their
 * arguments as JSON. Returns at once; the panel is drawn again when the work
 * is done. */
void fos_store_action(const char *action, const char *args);
