/*
 * The scene store's host on an ESP32 (fos_store.c, docs/scene-store.md): the
 * facts a JS app reads with frameos.store() and the work it asks with
 * frameos.storeAction() (frameos/scene_store_hooks.nim). Called by the Nim
 * runtime on the render task (embedded_runtime.nim); the work runs on a task
 * of its own.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

/* At boot. (Also what links this file in: the Nim runtime's calls alone come
 * too late in the link to pull it out of main's library.) */
void fos_store_init(void);
/* The facts, as scene_store_hooks.nim documents them: a malloc'd JSON string;
 * NULL when there is no store on the frame (the frame's
 * `frame_settings_on_screen` is off, unless `settings_unlock`) or no memory.
 * `asker` is the scene reading: it is drawn again when there is news. */
char *fos_store_json(const char *asker);
/* browse, preview, install, update, remove, discard, with their arguments as
 * JSON. Returns at once; `asker` is drawn again when the work is done, if it
 * still shows. */
void fos_store_action(const char *asker, const char *action, const char *args);
/* The frame's control plane, at `route` ("/panel/scenes"): a backend first,
 * else the cloud it is enrolled with (as the voice chat's upload_target), its
 * URL and bearer value. False for a frame with none; `*pending` (and true)
 * when it belongs to a cloud it cannot reach yet. The code editor's host
 * (fos_code.c) asks the same plane. */
bool fos_store_plane(const char *route, char *url, size_t len, char *auth, size_t auth_len, bool *backend,
                     bool *pending);
