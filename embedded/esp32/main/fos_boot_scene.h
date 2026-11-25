#ifndef FOS_BOOT_SCENE_H
#define FOS_BOOT_SCENE_H

/*
 * Which scene a frame starts on (fos_scenes.c, activate_from_index). A layout
 * (docs/scene-layouts.md) wraps other scenes and shows nothing on its own, so
 * it is never one: not from a remembered selection, not as the default, not
 * because it happens to be first in the list.
 *
 * Pure: no IDF, so main/tests/test_fos_boot_scene.c runs it on the host.
 */

#include <stdbool.h>

typedef struct {
    const char *id;
    bool is_layout;
    bool is_default; /* marked `default` by whoever made the set */
} fos_boot_scene_t;

/* The index in `scenes` to start on: `wanted` (a queued or remembered
 * selection, may be NULL or empty) when it names a scene on the frame, else
 * `default_id` (the scene index's default), else the first scene. -1 when the
 * frame holds nothing but layouts. */
int fos_boot_scene_pick(const fos_boot_scene_t *scenes, int count, const char *wanted, const char *default_id);

/* The first scene that is neither `avoid` nor a layout, -1 when there is none:
 * where a frame starts when `avoid` ran it out of memory. */
int fos_boot_scene_other(const fos_boot_scene_t *scenes, int count, const char *avoid);

/* Whether the frame starts on its home, the scene switcher
 * (docs/scene-switcher.md "The frame's home"), over the scene
 * fos_boot_scene_pick names: nothing was picked on it (`wanted` names no
 * scene it can start) and no scene is marked default, so that scene would
 * only be the first in the list (a fresh board: the Clock of a flasher's set
 * was all it ever showed). Never with nothing to start. The runtime still
 * decides whether the frame takes taps (frameos_nim_open_home): e-paper with
 * keys alone starts on that scene, as before. */
bool fos_boot_scene_home(const fos_boot_scene_t *scenes, int count, const char *wanted);

#endif
