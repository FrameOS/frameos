#include "fos_boot_scene.h"

#include <stddef.h>
#include <string.h>

/* The index of the scene called `id`, -1 when it is not there or is a layout. */
static int startable(const fos_boot_scene_t *scenes, int count, const char *id)
{
    if (id == NULL || id[0] == '\0') return -1;
    for (int i = 0; i < count; i++) {
        if (strcmp(scenes[i].id, id) == 0) return scenes[i].is_layout ? -1 : i;
    }
    return -1;
}

int fos_boot_scene_other(const fos_boot_scene_t *scenes, int count, const char *avoid)
{
    for (int i = 0; i < count; i++) {
        if (scenes[i].is_layout) continue;
        if (avoid != NULL && strcmp(scenes[i].id, avoid) == 0) continue;
        return i;
    }
    return -1;
}

int fos_boot_scene_pick(const fos_boot_scene_t *scenes, int count, const char *wanted, const char *default_id)
{
    int pick = startable(scenes, count, wanted);
    if (pick < 0) pick = startable(scenes, count, default_id);
    if (pick < 0) pick = fos_boot_scene_other(scenes, count, NULL);
    return pick;
}
