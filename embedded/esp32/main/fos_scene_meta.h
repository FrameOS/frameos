/*
 * What the scene index keeps of a scene, read off the scene's bytes as they
 * go by. A scene written to flash while it arrives (fos_scene_store_stage_*:
 * a set too big to hold) is never in memory whole, so there is no tree to ask
 * for its id, its name or whether it is a layout.
 *
 * The reader keeps the scene's top-level scalar members (`id`, `name`,
 * `default`, `refreshInterval`, ...) and the scalar members of its `settings`
 * (`isLayout`, `desktop`, `windowSize`, `icon`, `category`, ...) as their own
 * text, in one small JSON object: `{"id":"a","name":"A","settings":{...}}`.
 * cJSON reads that, escapes and all, and the store makes the index entry from
 * it exactly as it does from the whole scene (make_entry). Arrays and objects
 * (nodes, edges, apps, fields) are passed over, and so is a member longer
 * than FOS_SCENE_META_MEMBER_MAX: an icon is at most 1024 characters, and a
 * longer value is one the index would not keep.
 *
 * Pure C, no allocation: tests/test_fos_scene_meta.c runs it at every read
 * size against the whole parse.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define FOS_SCENE_META_MAX 8192
#define FOS_SCENE_META_MEMBER_MAX 1536

typedef struct {
    char text[FOS_SCENE_META_MAX];
    size_t len;
    size_t mark;        /* where the member being kept began: cut back to it when it is dropped */
    int depth;          /* 0 outside the scene's braces */
    int max_depth;
    int level;          /* the depth whose members are read: 1 the scene's, 2 its settings' */
    uint8_t phase;
    bool in_string, escaped;
    bool keeping;       /* the member being read is copied to `text` */
    bool whole;         /* the closing brace was read */
    bool failed;        /* not one object */
} fos_scene_meta_t;

void fos_scene_meta_begin(fos_scene_meta_t *meta);

/* The scene's bytes, from its `{` to its `}`, in as many calls as they come. */
void fos_scene_meta_feed(fos_scene_meta_t *meta, const char *bytes, size_t len);

/* The object described above, NUL-terminated, once the scene was read whole;
 * NULL when what was fed is not one object. */
const char *fos_scene_meta_text(fos_scene_meta_t *meta);

/* The deepest nesting the scene's bytes reached (1: a flat object). */
int fos_scene_meta_depth(const fos_scene_meta_t *meta);
