/*
 * The per-scene store on /state: the index and the slot files, one scene at a
 * time. Pure C and cJSON, no IDF: the host test runs it against a directory.
 *
 * /state/scene-index.json  {"scenes":[{"id","name","refreshInterval","slot","bytes"}],
 *                           "default":"<id>","source":"local|backend|cloud"}
 * /state/scene-<slot>.json one scene, exactly as it was stored
 *
 * A changed scene is written to a NEW slot and the index is switched to it:
 * the old file stays until fos_scene_store_sweep(), so a power cut, a full
 * partition or a scene the runtime refuses leaves the scene that worked, and
 * a render task still loading from the previous index reads a whole file.
 *
 * One writer at a time: the caller holds the store lock (fos_scenes.c).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "cJSON.h"

#define FOS_SCENE_STORE_SLOTS 32
#define FOS_SCENE_STORE_ID_LEN 128
/* The most one scene may be: a whole payload's cap (SCENES_MAX_BYTES). */
#define FOS_SCENE_STORE_MAX_BYTES (512 * 1024)

#define FOS_SCENE_STORE_INDEX_NAME "scene-index.json"
#define FOS_SCENE_STORE_INDEX_TMP_NAME "scene-index.tmp"
#define FOS_SCENE_STORE_SLOT_TMP_NAME "scene-slot.tmp"

typedef enum {
    FOS_SCENE_STORE_OK = 0,
    FOS_SCENE_STORE_ERR_INVALID,        /* not one scene object with a string id */
    FOS_SCENE_STORE_ERR_NOT_FOUND,      /* no scene with that id */
    FOS_SCENE_STORE_ERR_NO_SLOTS,       /* all FOS_SCENE_STORE_SLOTS files are taken */
    FOS_SCENE_STORE_ERR_NO_SPACE,       /* the partition has no room for it */
    FOS_SCENE_STORE_ERR_IO,             /* another file error */
    FOS_SCENE_STORE_ERR_NO_MEMORY,
    FOS_SCENE_STORE_ERR_LAST_SCENE,     /* the change would leave no scenes */
    FOS_SCENE_STORE_ERR_MISSING_SCENE,  /* `order` names a scene that is not there */
} fos_scene_store_err_t;

typedef struct {
    char id[FOS_SCENE_STORE_ID_LEN];
    int slot;
    size_t bytes;
} fos_scene_store_entry_t;

typedef struct {
    const char *json;
    size_t len;
} fos_scene_store_put_t;

/* One atomic change: every put, then the removal, then the new order; the
 * index is written last, once. */
typedef struct {
    const fos_scene_store_put_t *puts;
    int put_count;
    const char *remove_id;     /* NULL: none */
    const char *const *order;  /* NULL: keep (a new scene goes last). Scenes not named are dropped. */
    int order_count;
    const char *source;        /* NULL: keep the index's */
} fos_scene_store_change_t;

typedef struct {
    int scene_count;
    size_t scenes_bytes;
    char first_put_id[FOS_SCENE_STORE_ID_LEN];
} fos_scene_store_result_t;

typedef struct {
    void (*make_room)(size_t bytes);    /* before a write (SPIFFS GC); NULL = nothing */
    void *(*big_alloc)(size_t bytes);   /* for scene bodies; NULL = malloc */
} fos_scene_store_hooks_t;

void fos_scene_store_set_dir(const char *dir);
void fos_scene_store_set_hooks(const fos_scene_store_hooks_t *hooks);

void fos_scene_store_slot_path(int slot, char *out, size_t out_len);

/* Apply one change. On any failure the index and the slots it names are as
 * they were. `on_dropped` is called (after the index is written) for each
 * scene the change removed. */
fos_scene_store_err_t fos_scene_store_apply(const fos_scene_store_change_t *change,
                                            fos_scene_store_result_t *result,
                                            void (*on_dropped)(const char *id, void *ctx),
                                            void *ctx);

/* The index's scenes, up to `max`. -1 when there is no usable index. */
int fos_scene_store_read_entries(fos_scene_store_entry_t *out, int max);

/* One scene's stored bytes; malloc'd (or big_alloc'd), NUL-terminated. NULL
 * when the index has no such scene. Safe beside a put (the old slot stays). */
char *fos_scene_store_read_scene(const char *scene_id, size_t *out_len);

/* The index as a tree with every entry's `bytes` filled in, plus `sceneCount`
 * and `scenesBytes`. Caller deletes. Never NULL unless out of memory; an empty
 * list when there is no index. */
cJSON *fos_scene_store_list_tree(void);

/* Point `scene_id` back at `slot` (a scene the runtime refused goes back to
 * the file that worked). */
fos_scene_store_err_t fos_scene_store_repoint(const char *scene_id, int slot);

/* Delete every slot file the index does not name. Nothing without a usable
 * index: a damaged index must not cost the scenes. */
void fos_scene_store_sweep(void);

/* The index and its tmp are swapped by remove + rename (SPIFFS has no
 * atomic replace). A power cut in between leaves only the tmp, whole: move
 * it back. True when it did. */
bool fos_scene_store_recover_index(void);

const char *fos_scene_store_err_str(fos_scene_store_err_t err);
