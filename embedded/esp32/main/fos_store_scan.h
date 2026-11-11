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

/* The store scene a stored scene came from: the `origin` the store stamps on
 * every scene it serves ({href, storeSceneId, version, sceneId}), found by its
 * keys (no app's `origin` has a storeSceneId). `store` gets the uuid ("" for
 * none), `*version` the version (0 for none). */
void fos_store_read_origin(const char *json, char *store, size_t store_len, int *version);
