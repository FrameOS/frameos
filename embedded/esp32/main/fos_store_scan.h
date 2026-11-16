/*
 * What the scene store on the frame (fos_store.c) reads off untrusted text
 * without building a JSON tree: the scene objects of a store scene's
 * scenes.json, and where a stored scene came from. Pure C, no IDF: the host
 * test runs it (tests/test_fos_store_scan.c).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

/* The objects of a JSON array, by where they start and how long they are, up
 * to `max` of them. -1 when `json` is not an array of whole objects (anything
 * but objects in it, unbalanced brackets, an open string). */
int fos_store_split_scenes(const char *json, size_t len, const char **starts, size_t *lens, int max);

/* The value of one key of a JSON object, by where it starts and how long it
 * is, without building a tree: what a backend's scene patch is read with
 * (`base`, `order` and the scenes of `put`, fos_scenes.c), so a patch of
 * twenty scenes costs no more memory than its text. False when `json` is not
 * an object, the key is not one of its own (nested objects are not looked
 * into), or the text is cut short. Keys are compared as written. */
bool fos_store_object_member(const char *json, size_t len, const char *key, const char **value,
                             size_t *value_len);

/* The store scene a stored scene came from: the `origin` the store stamps on
 * every scene it serves ({href, storeSceneId, version, sceneId}), found by its
 * keys (no app's `origin` has a storeSceneId). `store` gets the uuid ("" for
 * none), `*version` the version (0 for none). */
void fos_store_read_origin(const char *json, char *store, size_t store_len, int *version);

/* A scene object's own `"default": true` (the scene a frame boots to) made
 * `"default": null` in place, the same length: a scene installed from the
 * store does not take the frame's default from the owner. Keys of nested
 * objects are left alone. */
void fos_store_clear_default(char *scene, size_t len);
