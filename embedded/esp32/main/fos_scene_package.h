/*
 * A scene package (docs/scene-packages.md): one scene as a ZIP, kept in its
 * slot file as it came. scene.json is the scene without its apps' files, and
 * on a frame it is the package's first member and stored, so what the index
 * keeps of it (fos_scene_store.c) is read where it lies, right after its
 * 30-byte local header; apps/<keyword>/<file> are the apps' files, read by the
 * runtime when an interpreter starts (frameos/scene_package.nim, through
 * utils/zip_entry.nim). A slot file that is no package is the scene's JSON,
 * as before.
 *
 * fos_scene_package_scene_json is the test the store makes (no allocation);
 * fos_scene_package_to_json is the scene whole again for the readers of a
 * scene's JSON (the Code editor, GET .../scenes/<id>, scene-get, the
 * cloud's scenes_get).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Whether the bytes are a package (a ZIP's first local header). */
bool fos_scene_package_is(const char *bytes, size_t len);

/* A package's scene.json where it lies, its length in `*json_len`; NULL
 * when its first member is not scene.json stored whole (a frame refuses that
 * package). */
const char *fos_scene_package_scene_json(const char *bytes, size_t len, size_t *json_len);

/* The scene whole again: scene.json with every apps/<keyword>/<file> member
 * back in `apps[keyword].sources[file]`, as JSON text (malloc'd, NUL
 * ended); NULL when the package cannot be read or there is no memory. */
char *fos_scene_package_to_json(const char *bytes, size_t len, size_t *out_len);
