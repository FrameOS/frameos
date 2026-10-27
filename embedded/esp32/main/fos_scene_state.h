/*
 * Scene state that survives a deep sleep.
 *
 * A battery frame deep-sleeps between renders, and every wake is a fresh
 * boot: the Nim runtime starts from nothing and the scene is rebuilt from its
 * JSON defaults. So "Apply to active scene" lasted exactly one render — an
 * Immich frame switched to an album was back on random images on the next
 * wake (2026-10). The Linux runtime keeps its `persist: "disk"` fields in
 * ./state/scene-<id>.json (frameos/src/frameos/scenes.nim); this is the same
 * idea for the chip, one file per scene under /state, written by the Nim
 * host whenever the scene's public state changes and read back when the
 * scene is next built (single_scene_host.initialState). The runtime decides
 * WHAT is persisted (frameos/src/embedded/embedded_runtime.nim: the public
 * fields and the persist:"disk" ones, each only once it has left its declared
 * default, so a redeploy with a new default still reaches the frame); this
 * module only keeps bytes.
 *
 * File names: /state/st-<fnv1a32 of the scene id>.json. SPIFFS caps a name
 * at 32 bytes (CONFIG_SPIFFS_OBJ_NAME_LEN) and a scene id is a 36-byte uuid,
 * so the id cannot be the name; a hash, unlike the scene-store slot number
 * (fos_scenes.c), does not move when a redeploy reorders the scenes.
 *
 * Written behind (fos_scene_state_set_write_behind): on the chip the files
 * share the program flash, and a SPIFFS write that has to erase a block holds
 * the flash cache off for 50-100 ms. That stalls both cores, and an RGB
 * panel scanned out of PSRAM shows garbage for those frames (the SenseCAP
 * Indicator flickered after every tap of the touch test, whose taps are
 * disk fields: one write in three or four erased, 2026-10-25). So a change
 * waits in RAM and is written once it has waited the delay (later changes
 * ride along, so a scene that never settles is still written once a delay),
 * before a deep sleep and before a restart (main.c, fos_client.c). Losing
 * power loses at most one delay of changes.
 *
 * IDF-free on purpose (stdio only), so it has a host test:
 * main/tests/test_fos_scene_state.c, run by
 * backend/app/tasks/tests/test_esp32_scene_state.py.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* The largest state file kept, in bytes of JSON. A scene's public fields are
 * a few short strings and numbers; anything bigger is not state. The cloud
 * caps a state push at 16 KB too. */
#define FOS_SCENE_STATE_MAX_BYTES (16 * 1024)

/* Where the files live. "/state" (the SPIFFS partition) on the device; the
 * host test points it at a temporary directory. */
void fos_scene_state_set_dir(const char *dir);

/* The file a scene's state is kept in: "<dir>/st-xxxxxxxx.json". False when
 * the id is empty or the buffer too small. */
bool fos_scene_state_path(const char *scene_id, char *out, size_t out_len);

/* The persisted JSON for a scene, malloc'd (free() it), or NULL when there is
 * none, it is unreadable, or it is larger than the cap. */
char *fos_scene_state_load(const char *scene_id);

/* Replace the persisted JSON for a scene. An empty object ("{}", "" or NULL)
 * removes the file. Written to a temporary name and renamed, so a reset
 * mid-write leaves the previous state, never half a file. With write-behind
 * on, kept in RAM until fos_scene_state_flush writes it; a load sees it
 * either way. */
bool fos_scene_state_save(const char *scene_id, const char *json);

/* Forget a scene's state (a scene the store no longer holds). */
void fos_scene_state_forget(const char *scene_id);

typedef struct {
    uint32_t delay_ms;        /* how long a change may wait; 0 writes through */
    uint32_t (*now_ms)(void); /* a millisecond clock (wraps are fine) */
    void (*lock)(void);       /* around every call; NULL on one task */
    void (*unlock)(void);
} fos_scene_state_write_behind_t;

/* Turn write-behind on (NULL: off). Whatever waits is written first. */
void fos_scene_state_set_write_behind(const fos_scene_state_write_behind_t *config);

/* Write the changes that have waited the delay; with `all`, every one. */
void fos_scene_state_flush(bool all);

/* Something is waiting to be written. */
bool fos_scene_state_pending(void);
