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
 * Lookups by name are what a SPIFFS write costs on a big partition (each one
 * walks every block's lookup page: ~0.5 s on 24 MB), so the store makes as few
 * as it can: it knows its slot files after the first sweep, writes a slot
 * straight to its name (the index switch is the commit), and writes the index
 * as a copy then in place (scene-index.tmp stays beside it, and a reader takes
 * it when the index is torn).
 *
 * One writer at a time: the caller holds the store lock (fos_scenes.c), and
 * every slot file and the index are written and removed through here.
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
/* The index's copy: written first, kept, read when the index is torn. */
#define FOS_SCENE_STORE_INDEX_TMP_NAME "scene-index.tmp"
/* Only removed: where firmware before 2026.11.6 wrote a slot first. */
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
    bool freed[FOS_SCENE_STORE_SLOTS]; /* slots the old index named and the new one does not */
} fos_scene_store_result_t;

typedef struct {
    void (*make_room)(size_t bytes);    /* before a write (SPIFFS GC); NULL = nothing */
    void *(*big_alloc)(size_t bytes);   /* for file bodies; NULL = malloc */
    void (*pace)(void);                 /* before each 2 KB written; NULL = nothing (fos_scenes.c: the store
                                         * task waits out renders and taps there, a flash write stalls both cores) */
    void (*between)(void);              /* between two committed steps of fos_scene_store_apply_set, each
                                         * leaving a whole set on flash; NULL = nothing (fos_scenes.c lets go
                                         * of its lock there, so a render reads the scene file it waits for) */
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

typedef struct {
    int scene_count; /* in the set now on flash */
    int written;     /* scenes whose bytes were new */
    int kept;        /* scenes stored already, byte for byte */
    int dropped;     /* scenes the set no longer has */
    size_t written_bytes;
} fos_scene_store_set_result_t;

/* A whole set (`puts`, in order) stored as changes to the set on flash, one
 * scene at a time: a scene whose bytes are stored already is kept (the index
 * keeps each scene's `hash`), the scenes the set drops go first, then each
 * new or changed scene is written and committed by itself and the file it
 * replaced emptied before the next, and last the set's order and `source`.
 * /state never holds more than the stored set and one scene: a 415 KB set
 * written whole beside the one it replaced did not fit an 8 MB board's 1 MB
 * /state (the reTerminal E1002, 2026-11-10), and a push that changed one
 * scene of twenty wrote all twenty. Not atomic: a failure or a power cut
 * leaves a set holding some of the new scenes, each whole, and the producer
 * sends the set again (nothing acknowledged it). The set is checked whole
 * before anything is written. FOS_SCENE_STORE_ERR_NOT_FOUND, with nothing
 * written, when there is no index to change: the caller stores the set
 * another way. */
fos_scene_store_err_t fos_scene_store_apply_set(const fos_scene_store_put_t *puts, int count,
                                                const char *source, fos_scene_store_set_result_t *result,
                                                void (*on_dropped)(const char *id, void *ctx),
                                                void *ctx);

/* The index as a tree, every entry with its `bytes` (an index from before
 * that field gets the files' sizes); its copy when the index is torn. Caller
 * deletes. NULL when there is no usable index. Safe without the lock: the
 * index and its copy are never both being written. */
cJSON *fos_scene_store_read_index(void);

/* An index entry's slot; -1 when it has none. */
int fos_scene_store_entry_slot(const cJSON *entry);

/* One scene's stored bytes, as fos_scene_store_read_file. NULL when the index
 * has no such scene. Safe beside a put (the old slot stays). */
char *fos_scene_store_read_scene(const char *scene_id, size_t *out_len);

/* Point `scene_id` back at `slot` (a scene the runtime refused goes back to
 * the file that worked). */
fos_scene_store_err_t fos_scene_store_repoint(const char *scene_id, int slot);

/* Delete every slot file the index does not name: the first one each boot
 * looks at every slot, after that only the files the store wrote. Nothing
 * without a usable index: a damaged index must not cost the scenes. */
void fos_scene_store_sweep(void);

/* Every slot file (a whole payload's split starts from none). */
void fos_scene_store_remove_slots(void);

/* The index and its copy: no index, and no copy to take its place. */
void fos_scene_store_remove_index(void);

/* Files on /state changed outside the store (a wipe, a format): what it
 * knows of its slot files goes, and the next sweep looks at every slot. */
void fos_scene_store_forget(void);

/* The index gone or torn and its copy whole (a power cut inside a write):
 * the copy goes back in its place. True when it did. */
bool fos_scene_store_recover_index(void);

const char *fos_scene_store_err_str(fos_scene_store_err_t err);
