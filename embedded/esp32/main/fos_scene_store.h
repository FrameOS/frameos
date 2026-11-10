/*
 * The per-scene store on /state: the index and the slot files, one scene at a
 * time. Pure C and cJSON, no IDF: the host test runs it against a directory.
 *
 * /state/scene-index.json  {"scenes":[{"id","name","refreshInterval","slot","bytes",
 *                                      "isLayout","default"}],
 *                           "default":"<id>","source":"local|backend|cloud"}
 * /state/scene-<slot>.json one scene, exactly as it was stored
 *
 * A changed scene is written to a NEW slot and the index is switched to it:
 * the old file stays until fos_scene_store_sweep(), so a power cut, a full
 * partition or a scene the runtime refuses leaves the scene that worked, and
 * a render task still loading from the previous index reads a whole file.
 * A whole payload is split through the same code (`replace_all`).
 *
 * One writer at a time: the caller holds the store lock (fos_scenes.c).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "cJSON.h"

#define FOS_SCENE_STORE_SLOTS 32
#define FOS_SCENE_STORE_ID_LEN 128
/* The most one file may be: a whole payload's cap (SCENES_MAX_BYTES). */
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
    const char *json;
    size_t len;
} fos_scene_store_put_t;

/* One atomic change: every put, then the removal or the new order; the index
 * is written last, once. */
typedef struct {
    const fos_scene_store_put_t *puts; /* scenes as text (USB, HTTP, a whole payload) */
    int put_count;
    const cJSON *put_items;    /* or a control plane's array of scene objects */
    const char *remove_id;     /* NULL: none */
    const cJSON *order;        /* array of ids; NULL: keep (a new scene goes last). Scenes not named are dropped. */
    const char *source;        /* NULL: keep the index's */
    bool replace_all;          /* the puts are the whole set, in order */
} fos_scene_store_change_t;

typedef struct {
    int scene_count;
    size_t put_bytes;
    char first_put_id[FOS_SCENE_STORE_ID_LEN];
} fos_scene_store_result_t;

typedef struct {
    void (*make_room)(size_t bytes);    /* before a write (SPIFFS GC); NULL = nothing */
    void *(*big_alloc)(size_t bytes);   /* for file bodies; NULL = malloc */
    void (*pace)(void);                 /* before each 2 KB written; NULL = nothing (fos_scenes.c: the store
                                         * task waits out renders and taps there, a flash write stalls both cores) */
} fos_scene_store_hooks_t;

void fos_scene_store_set_dir(const char *dir);
void fos_scene_store_set_hooks(const fos_scene_store_hooks_t *hooks);

void fos_scene_store_slot_path(int slot, char *out, size_t out_len);

/* A whole file, malloc'd (or big_alloc'd) and NUL-terminated; NULL when it is
 * missing, empty or over FOS_SCENE_STORE_MAX_BYTES. */
char *fos_scene_store_read_file(const char *path, size_t *out_len);

/* Write `tmp`, then put it in place of `path` (remove + rename: SPIFFS has no
 * rename over a file). The old file stays until the new one is whole. On a
 * failure errno says why: ERR_IO is the rename, anything else the write. */
fos_scene_store_err_t fos_scene_store_write_file(const char *path, const char *tmp,
                                                 const char *data, size_t len);

/* Apply one change. On any failure the index and the slots it names are as
 * they were. `on_dropped` is called (after the index is written) for each
 * scene the change removed. */
fos_scene_store_err_t fos_scene_store_apply(const fos_scene_store_change_t *change,
                                            fos_scene_store_result_t *result,
                                            void (*on_dropped)(const char *id, void *ctx),
                                            void *ctx);

/* The index as a tree, every entry with its `bytes` (an index from before
 * that field gets the files' sizes). Caller deletes. NULL when there is no
 * usable index. */
cJSON *fos_scene_store_read_index(void);

/* An index entry's slot; -1 when it has none. */
int fos_scene_store_entry_slot(const cJSON *entry);

/* One scene's stored bytes, as fos_scene_store_read_file. NULL when the index
 * has no such scene. Safe beside a put (the old slot stays). */
char *fos_scene_store_read_scene(const char *scene_id, size_t *out_len);

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
