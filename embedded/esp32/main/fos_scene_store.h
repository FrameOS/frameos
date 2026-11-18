/*
 * The per-scene store on /state: the index and the slot files, one scene at a
 * time. Pure C and cJSON, no IDF: the host test runs it against a directory.
 *
 * /state/scene-index.json  {"scenes":[{"id","name","refreshInterval","slot","bytes",
 *                                      "isLayout","desktop","default"}],
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
 * A set too big to hold in memory is written as it arrives (the `stage`
 * calls below): each scene's bytes go straight to a slot file no index names,
 * and one change switches the index to all of them. What a set may be is then
 * what /state holds, never a block of memory.
 *
 * One writer at a time: the caller holds the store lock (fos_scenes.c), and
 * every slot file and the index are written and removed through here.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "cJSON.h"

/* The most scenes a set holds. What the index keeps of each (its icon is up
 * to a kilobyte) is read whole for every catalog, so this is what bounds a
 * set's count; its bytes are bounded by /state alone. */
#define FOS_SCENE_STORE_SCENES 128
/* Slot files: twice that, so a change to every scene of a full set fits
 * beside the set it replaces until the index is switched. */
#define FOS_SCENE_STORE_SLOTS 256
#define FOS_SCENE_STORE_ID_LEN 128
/* The most one file may be: a scene is read whole to be run, and so are the
 * index and a combined payload not split yet. */
#define FOS_SCENE_STORE_MAX_BYTES (512 * 1024)

/* A set of slots, a bit each. */
typedef struct {
    unsigned int bits[FOS_SCENE_STORE_SLOTS / 32];
} fos_scene_store_slots_t;

static inline bool fos_scene_store_slots_has(const fos_scene_store_slots_t *set, int slot)
{
    return (unsigned)slot < FOS_SCENE_STORE_SLOTS && ((set->bits[slot / 32] >> (slot % 32)) & 1u) != 0;
}

static inline void fos_scene_store_slots_put(fos_scene_store_slots_t *set, int slot, bool in)
{
    if ((unsigned)slot >= FOS_SCENE_STORE_SLOTS) return;
    if (in) set->bits[slot / 32] |= 1u << (slot % 32);
    else set->bits[slot / 32] &= ~(1u << (slot % 32));
}

#define FOS_SCENE_STORE_INDEX_NAME "scene-index.json"
/* The index's copy: written first, kept, read when the index is torn. */
#define FOS_SCENE_STORE_INDEX_TMP_NAME "scene-index.tmp"
/* Only removed: where firmware before 2026.11.6 wrote a slot first. */
#define FOS_SCENE_STORE_SLOT_TMP_NAME "scene-slot.tmp"

typedef enum {
    FOS_SCENE_STORE_OK = 0,
    FOS_SCENE_STORE_ERR_INVALID,        /* not one scene object with a string id */
    FOS_SCENE_STORE_ERR_NOT_FOUND,      /* no scene with that id */
    FOS_SCENE_STORE_ERR_NO_SLOTS,       /* all FOS_SCENE_STORE_SLOTS files are taken, or the set would
                                         * hold more than FOS_SCENE_STORE_SCENES */
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
    /* Not 0: the puts are the scenes staged under this id (fos_scene_store_stage_open),
     * already in their slot files. Without `order` they are the whole set, in
     * the order they came. Whatever the outcome, nothing is staged after. */
    unsigned int staged;
} fos_scene_store_change_t;

typedef struct {
    int scene_count;
    size_t put_bytes;
    char first_put_id[FOS_SCENE_STORE_ID_LEN];
    fos_scene_store_slots_t freed; /* slots the old index named and the new one does not */
} fos_scene_store_result_t;

typedef struct {
    void (*make_room)(size_t bytes);    /* before a write (SPIFFS GC); NULL = nothing */
    void *(*big_alloc)(size_t bytes);   /* for file bodies; NULL = malloc */
    void (*pace)(void);                 /* before each 2 KB written; NULL = nothing (fos_scenes.c: the store
                                         * task waits out renders and taps there, a flash write stalls both cores) */
    void (*between)(void);              /* between two committed steps of fos_scene_store_apply_set, each
                                         * leaving a whole set on flash; NULL = nothing (fos_scenes.c lets go
                                         * of its lock there, so a render reads the scene file it waits for) */
    bool (*has_room)(size_t bytes);     /* whether /state takes this much more beside what it holds;
                                         * NULL = not known (a whole set then goes one scene at a time) */
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

/* As fos_scene_store_write_file, a JSON array of `scenes` (a set's combined
 * file written from scenes read in pieces, fos_scene_pieces.h). */
fos_scene_store_err_t fos_scene_store_write_set(const char *path, const char *tmp,
                                                const fos_scene_store_put_t *scenes, int count);

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
    bool at_once;    /* written as one change, the index switched once */
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
 * another way.
 *
 * Where /state has room for every changed scene beside the set it holds
 * (`has_room`, and slots for them), they are written and the index switched
 * once, as one change: a step a scene writes the index twice a scene, and for
 * 26 scenes on a 24 MB /state that was three times the bytes of the set
 * itself (a 525 KB set took 112 s on the reTerminal Sticky, the hardware
 * bench, 2026-11-18). `result->at_once` says which. */
fos_scene_store_err_t fos_scene_store_apply_set(const fos_scene_store_put_t *puts, int count,
                                                const char *source, fos_scene_store_set_result_t *result,
                                                void (*on_dropped)(const char *id, void *ctx),
                                                void *ctx);

/* ---- A set written as it arrives ---------------------------------------
 *
 * fos_scene_store_stage_open() starts one and answers its id; then, for each
 * scene, _begin, its bytes through _write in as many calls as they come, and
 * _end. The scene goes straight to a free slot's file, with its hash and what
 * the index keeps of it read off the bytes (fos_scene_meta.h): the store never
 * holds more of it than the call's bytes. A scene stored already, byte for
 * byte, gives its file back and is kept as it is. Nothing the index names
 * changes until fos_scene_store_apply() is given the id (`staged`).
 *
 * The lock is the caller's for each call, not across them: a render reads its
 * scene file between two writes, and another change may be made meanwhile (a
 * staged file is nobody's until the commit, and no sweep takes it). One
 * staging at a time: the next _open ends the one before, and so does a whole
 * payload stored meanwhile (fos_scene_store_remove_slots). The calls for an
 * ended one answer FOS_SCENE_STORE_ERR_INVALID (fos_scene_store_staging tells
 * that from a scene that is not one). */
unsigned int fos_scene_store_stage_open(void);
fos_scene_store_err_t fos_scene_store_stage_begin(unsigned int id);
fos_scene_store_err_t fos_scene_store_stage_write(unsigned int id, const char *bytes, size_t len);
/* `*kept`: the scene was stored already and its staged file given back. */
fos_scene_store_err_t fos_scene_store_stage_end(unsigned int id, bool *kept);
/* The staging under `id` (0: whichever there is) dropped, its files given back. */
void fos_scene_store_stage_drop(unsigned int id);
/* Whether the staging under `id` is still there: another staging begun, or
 * a whole payload stored, ends one. */
bool fos_scene_store_staging(unsigned int id);
/* How many scenes are staged under `id`: written, and stored already. */
void fos_scene_store_stage_counts(unsigned int id, int *written, int *kept, size_t *written_bytes);

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

/* Empty every slot file the index does not name, for the next put: the first
 * one each boot lists the directory once (what a crash left, and the spares
 * from before), after that only the files the store wrote. The caller's
 * `between` comes after each file emptied. Nothing without a usable index: a
 * damaged index must not cost the scenes. */
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
