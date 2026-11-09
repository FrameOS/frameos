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
} fos_boot_scene_t;

/* The index in `scenes` to start on: `wanted` (a queued or remembered
 * selection, may be NULL or empty) when it names a scene on the frame, else
 * `default_id` (the scene index's default), else the first scene. -1 when the
 * frame holds nothing but layouts. */
int fos_boot_scene_pick(const fos_boot_scene_t *scenes, int count, const char *wanted, const char *default_id);

/* The first scene that is neither `avoid` nor a layout, -1 when there is none:
 * where a frame starts when `avoid` ran it out of memory. */
int fos_boot_scene_other(const fos_boot_scene_t *scenes, int count, const char *avoid);

#endif
