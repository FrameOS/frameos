/* The per-scene store: see the header. No IDF calls here, the host test
 * compiles this with a laptop cc and IDF's cJSON. */
#include "fos_scene_store.h"

#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "fos_json_guard.h"

#define PATH_LEN 96

static const char *s_dir = "/state";
static fos_scene_store_hooks_t s_hooks;

void fos_scene_store_set_dir(const char *dir)
{
    s_dir = dir; /* kept, not copied: the caller's for good */
}

void fos_scene_store_set_hooks(const fos_scene_store_hooks_t *hooks)
{
    s_hooks = *hooks;
}

const char *fos_scene_store_err_str(fos_scene_store_err_t err)
{
    static const char *const text[] = {
        "ok",
        "not one scene object with an id",
        "no such scene",
        "no free scene slot",
        "no room on /state",
        "file error on /state",
        "out of memory",
        "a frame keeps at least one scene",
        "the order names a scene that is not stored",
    };
    return (unsigned)err < sizeof(text) / sizeof(text[0]) ? text[err] : "scene store error";
}

static void path_of(const char *name, char *out)
{
    snprintf(out, PATH_LEN, "%s/%s", s_dir, name);
}

void fos_scene_store_slot_path(int slot, char *out, size_t out_len)
{
    snprintf(out, out_len, "%s/scene-%d.json", s_dir, slot);
}

/* -1 when there is no such file. */
static long file_size(const char *path)
{
    struct stat st;
    return stat(path, &st) == 0 ? (long)st.st_size : -1;
}

char *fos_scene_store_read_file(const char *path, size_t *out_len)
{
    FILE *f = fopen(path, "rb");
    if (f == NULL) return NULL;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = NULL;
    if (size > 0 && size <= FOS_SCENE_STORE_MAX_BYTES) {
        buf = s_hooks.big_alloc ? s_hooks.big_alloc((size_t)size + 1) : NULL;
        if (buf == NULL) buf = malloc((size_t)size + 1);
    }
    if (buf != NULL) {
        size_t got = fread(buf, 1, (size_t)size, f);
        buf[got] = '\0';
        if (out_len != NULL) *out_len = got;
    }
    fclose(f);
    return buf;
}

fos_scene_store_err_t fos_scene_store_write_file(const char *path, const char *tmp,
                                                 const char *data, size_t len)
{
    remove(tmp);
    if (s_hooks.make_room) s_hooks.make_room(len);
    errno = 0;
    FILE *f = fopen(tmp, "wb");
    if (f == NULL) return errno == ENOSPC ? FOS_SCENE_STORE_ERR_NO_SPACE : FOS_SCENE_STORE_ERR_IO;
    size_t written = 0;
    while (written < len) {
        size_t chunk = len - written > 2048 ? 2048 : len - written;
        size_t wrote = fwrite(data + written, 1, chunk, f);
        if (wrote == 0) break;
        written += wrote;
    }
    bool ok = written == len && !ferror(f);
    if (fclose(f) != 0) ok = false;
    if (!ok) {
        int err_no = errno ? errno : ENOSPC;
        remove(tmp);
        errno = err_no;
        return FOS_SCENE_STORE_ERR_NO_SPACE;
    }
    remove(path);
    /* A failed rename keeps the tmp: for the index it is the only copy, and
     * fos_scene_store_recover_index() puts it back at the next boot. */
    return rename(tmp, path) == 0 ? FOS_SCENE_STORE_OK : FOS_SCENE_STORE_ERR_IO;
}

/* ----------------------------------------------------------- the index */

static const char *entry_id(const cJSON *entry)
{
    const cJSON *id = cJSON_GetObjectItem(entry, "id");
    return cJSON_IsString(id) ? id->valuestring : "";
}

int fos_scene_store_entry_slot(const cJSON *entry)
{
    const cJSON *slot = cJSON_GetObjectItem(entry, "slot");
    return cJSON_IsNumber(slot) && (unsigned)slot->valueint < FOS_SCENE_STORE_SLOTS ? slot->valueint : -1;
}

static bool entry_flag(const cJSON *entry, const char *key)
{
    return cJSON_IsTrue(cJSON_GetObjectItem(entry, key));
}

static cJSON *find_entry(const cJSON *scenes, const char *scene_id)
{
    cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, scenes) {
        if (strcmp(entry_id(entry), scene_id) == 0) return entry;
    }
    return NULL;
}

static void mark_slots(const cJSON *index, bool *used)
{
    const cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, cJSON_GetObjectItem(index, "scenes")) {
        int slot = fos_scene_store_entry_slot(entry);
        if (slot >= 0) used[slot] = true;
    }
}

cJSON *fos_scene_store_read_index(void)
{
    char path[PATH_LEN];
    path_of(FOS_SCENE_STORE_INDEX_NAME, path);
    size_t len = 0;
    char *text = fos_scene_store_read_file(path, &len);
    if (text == NULL) return NULL;
    cJSON *index = cJSON_ParseWithLength(text, len);
    free(text);
    cJSON *scenes = cJSON_GetObjectItem(index, "scenes");
    if (!cJSON_IsArray(scenes)) {
        cJSON_Delete(index);
        return NULL;
    }
    cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, scenes) {
        if (cJSON_GetObjectItem(entry, "bytes") == NULL) {
            /* An index from before this field: the file itself. */
            fos_scene_store_slot_path(fos_scene_store_entry_slot(entry), path, sizeof(path));
            long size = file_size(path);
            cJSON_AddNumberToObject(entry, "bytes", size > 0 ? (double)size : 0);
        }
    }
    return index;
}

static fos_scene_store_err_t write_index(const cJSON *index)
{
    char *text = cJSON_PrintUnformatted(index);
    if (text == NULL) return FOS_SCENE_STORE_ERR_NO_MEMORY;
    char path[PATH_LEN];
    char tmp[PATH_LEN];
    path_of(FOS_SCENE_STORE_INDEX_NAME, path);
    path_of(FOS_SCENE_STORE_INDEX_TMP_NAME, tmp);
    fos_scene_store_err_t err = fos_scene_store_write_file(path, tmp, text, strlen(text));
    cJSON_free(text);
    return err;
}

/* What the index keeps of a scene: what the catalog and a boot need. */
static cJSON *make_entry(const cJSON *scene, int slot, size_t bytes)
{
    cJSON *entry = cJSON_CreateObject();
    if (entry == NULL) return NULL;
    cJSON_AddStringToObject(entry, "id", entry_id(scene));
    const cJSON *name = cJSON_GetObjectItem(scene, "name");
    if (cJSON_IsString(name)) cJSON_AddStringToObject(entry, "name", name->valuestring);
    const cJSON *refresh = cJSON_GetObjectItem(scene, "refreshInterval");
    if (cJSON_IsNumber(refresh)) cJSON_AddNumberToObject(entry, "refreshInterval", refresh->valuedouble);
    cJSON_AddNumberToObject(entry, "slot", slot);
    cJSON_AddNumberToObject(entry, "bytes", (double)bytes);
    /* A layout (docs/scene-layouts.md) is read by id when a scene names it;
     * it is in no list and never what a frame boots to. */
    if (entry_flag(cJSON_GetObjectItem(scene, "settings"), "isLayout")) {
        cJSON_AddBoolToObject(entry, "isLayout", true);
    } else if (entry_flag(scene, "default")) {
        cJSON_AddBoolToObject(entry, "default", true);
    }
    return entry;
}

/* What a frame boots to without a scene of its own choosing: the scene marked
 * default, else the first that is not a layout. */
static const char *pick_default(const cJSON *scenes)
{
    const char *first = NULL;
    const cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, scenes) {
        if (entry_flag(entry, "default")) return entry_id(entry);
        if (first == NULL && !entry_flag(entry, "isLayout")) first = entry_id(entry);
    }
    return first;
}

static int fresh_index(cJSON *const *fresh, int count, const char *id)
{
    for (int i = 0; i < count; i++) {
        if (fresh[i] != NULL && strcmp(entry_id(fresh[i]), id) == 0) return i;
    }
    return -1;
}

static cJSON *take_fresh(cJSON **fresh, int count, const char *id)
{
    int i = fresh_index(fresh, count, id);
    if (i < 0) return NULL;
    cJSON *entry = fresh[i];
    fresh[i] = NULL;
    return entry;
}

fos_scene_store_err_t fos_scene_store_apply(const fos_scene_store_change_t *change,
                                            fos_scene_store_result_t *result,
                                            void (*on_dropped)(const char *id, void *ctx),
                                            void *ctx)
{
    memset(result, 0, sizeof(*result));
    cJSON *old = fos_scene_store_read_index(); /* NULL: none yet */
    const cJSON *old_scenes = cJSON_GetObjectItem(old, "scenes");

    /* A slot is free when no entry names it AND no file sits there: a file
     * the index does not name is one a reader may still be holding, until
     * the sweep. */
    bool used[FOS_SCENE_STORE_SLOTS] = {false};
    mark_slots(old, used);
    char path[PATH_LEN];
    for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) {
        fos_scene_store_slot_path(slot, path, sizeof(path));
        if (!used[slot] && file_size(path) >= 0) used[slot] = true;
    }

    fos_scene_store_err_t err = FOS_SCENE_STORE_OK;
    cJSON *fresh[FOS_SCENE_STORE_SLOTS]; /* the puts' new entries, each until it is placed */
    int fresh_count = 0;
    int written[FOS_SCENE_STORE_SLOTS];
    int written_count = 0;
    char tmp[PATH_LEN];
    path_of(FOS_SCENE_STORE_SLOT_TMP_NAME, tmp);

    const cJSON *item = change->put_items ? change->put_items->child : NULL;
    int put_count = change->put_items ? cJSON_GetArraySize(change->put_items) : change->put_count;
    for (int i = 0; i < put_count && err == FOS_SCENE_STORE_OK; i++) {
        const char *json;
        size_t len;
        const char *end;
        const cJSON *scene;
        cJSON *parsed = NULL;
        char *printed = NULL;
        if (item != NULL) {
            /* Already a tree (a control plane's message): printed for the file. */
            scene = item;
            item = item->next;
            json = printed = cJSON_PrintUnformatted(scene);
            len = json ? strlen(json) : 0;
            end = NULL;
        } else {
            /* One scene parsed at a time: the peak is the largest scene. */
            json = change->puts[i].json;
            len = change->puts[i].len;
            end = NULL;
            if (len <= FOS_SCENE_STORE_MAX_BYTES && fos_json_depth_ok(json, len, FOS_JSON_MAX_DEPTH)) {
                parsed = cJSON_ParseWithLengthOpts(json, len, &end, false);
            }
            scene = parsed;
        }
        result->put_bytes += len;
        const char *id = entry_id(scene);
        bool ok = cJSON_IsObject(scene) && id[0] && strlen(id) < FOS_SCENE_STORE_ID_LEN &&
                  fresh_index(fresh, fresh_count, id) < 0;
        /* Only white space after it: one scene, whole. */
        while (ok && end != NULL && end < json + len) ok = isspace((unsigned char)*end++);
        int slot = 0;
        while (slot < FOS_SCENE_STORE_SLOTS && used[slot]) slot++;
        if (json == NULL) {
            err = FOS_SCENE_STORE_ERR_NO_MEMORY;
        } else if (!ok) {
            err = FOS_SCENE_STORE_ERR_INVALID;
        } else if (slot == FOS_SCENE_STORE_SLOTS) {
            err = FOS_SCENE_STORE_ERR_NO_SLOTS;
        } else {
            fos_scene_store_slot_path(slot, path, sizeof(path));
            err = fos_scene_store_write_file(path, tmp, json, len);
        }
        if (err == FOS_SCENE_STORE_OK) {
            used[slot] = true;
            written[written_count++] = slot;
            fresh[fresh_count] = make_entry(scene, slot, len);
            if (fresh[fresh_count] == NULL) err = FOS_SCENE_STORE_ERR_NO_MEMORY;
            else fresh_count++;
            if (!result->first_put_id[0]) snprintf(result->first_put_id, sizeof(result->first_put_id), "%s", id);
        }
        cJSON_free(printed);
        cJSON_Delete(parsed);
    }

    /* The new index is built whole; the old one is only read. */
    cJSON *index = NULL;
    cJSON *scenes = NULL;
    if (err == FOS_SCENE_STORE_OK) {
        index = cJSON_CreateObject();
        scenes = cJSON_AddArrayToObject(index, "scenes");
        if (scenes == NULL) err = FOS_SCENE_STORE_ERR_NO_MEMORY;
    }
    if (err == FOS_SCENE_STORE_OK && change->order != NULL) {
        const cJSON *named = NULL;
        cJSON_ArrayForEach(named, change->order) {
            const char *id = cJSON_IsString(named) ? named->valuestring : "";
            cJSON *entry = NULL;
            if (id[0] && find_entry(scenes, id) == NULL) {
                entry = take_fresh(fresh, fresh_count, id);
                const cJSON *kept = entry ? NULL : find_entry(old_scenes, id);
                if (kept != NULL) entry = cJSON_Duplicate(kept, true);
            }
            if (entry == NULL) {
                err = FOS_SCENE_STORE_ERR_MISSING_SCENE;
                break;
            }
            cJSON_AddItemToArray(scenes, entry);
        }
    } else if (err == FOS_SCENE_STORE_OK && !change->replace_all) {
        bool removed = false;
        const cJSON *kept = NULL;
        cJSON_ArrayForEach(kept, old_scenes) {
            const char *id = entry_id(kept);
            if (change->remove_id != NULL && strcmp(id, change->remove_id) == 0) {
                removed = true;
                continue;
            }
            cJSON *entry = take_fresh(fresh, fresh_count, id);
            if (entry == NULL) entry = cJSON_Duplicate(kept, true);
            if (entry == NULL) {
                err = FOS_SCENE_STORE_ERR_NO_MEMORY;
                break;
            }
            cJSON_AddItemToArray(scenes, entry);
        }
        if (change->remove_id != NULL && !removed && err == FOS_SCENE_STORE_OK) err = FOS_SCENE_STORE_ERR_NOT_FOUND;
    }
    if (err == FOS_SCENE_STORE_OK && change->order == NULL) {
        /* A new scene goes last, in the order they came. */
        for (int i = 0; i < fresh_count; i++) {
            if (fresh[i] != NULL) cJSON_AddItemToArray(scenes, fresh[i]);
            fresh[i] = NULL;
        }
    }

    if (err == FOS_SCENE_STORE_OK && cJSON_GetArraySize(scenes) == 0) err = FOS_SCENE_STORE_ERR_LAST_SCENE;
    if (err == FOS_SCENE_STORE_OK) {
        const char *default_id = pick_default(scenes);
        if (default_id != NULL) cJSON_AddStringToObject(index, "default", default_id);
        const cJSON *old_source = cJSON_GetObjectItem(old, "source");
        const char *source = change->source ? change->source
                             : cJSON_IsString(old_source) ? old_source->valuestring : NULL;
        if (source != NULL) cJSON_AddStringToObject(index, "source", source);
        err = write_index(index);
    }

    if (err != FOS_SCENE_STORE_OK) {
        /* The index was not switched: this op's files are nobody's. */
        for (int i = 0; i < written_count; i++) {
            fos_scene_store_slot_path(written[i], path, sizeof(path));
            remove(path);
        }
    } else {
        result->scene_count = cJSON_GetArraySize(scenes);
        const cJSON *kept = NULL;
        cJSON_ArrayForEach(kept, old_scenes) {
            if (on_dropped != NULL && find_entry(scenes, entry_id(kept)) == NULL) on_dropped(entry_id(kept), ctx);
        }
    }
    for (int i = 0; i < fresh_count; i++) cJSON_Delete(fresh[i]);
    cJSON_Delete(index);
    cJSON_Delete(old);
    return err;
}

char *fos_scene_store_read_scene(const char *scene_id, size_t *out_len)
{
    cJSON *index = fos_scene_store_read_index();
    int slot = fos_scene_store_entry_slot(find_entry(cJSON_GetObjectItem(index, "scenes"), scene_id));
    cJSON_Delete(index);
    if (slot < 0) return NULL;
    char path[PATH_LEN];
    fos_scene_store_slot_path(slot, path, sizeof(path));
    return fos_scene_store_read_file(path, out_len);
}

fos_scene_store_err_t fos_scene_store_repoint(const char *scene_id, int slot)
{
    cJSON *index = fos_scene_store_read_index();
    cJSON *entry = find_entry(cJSON_GetObjectItem(index, "scenes"), scene_id);
    cJSON *slot_item = cJSON_GetObjectItem(entry, "slot");
    cJSON *bytes_item = cJSON_GetObjectItem(entry, "bytes");
    fos_scene_store_err_t err = FOS_SCENE_STORE_ERR_NOT_FOUND;
    if (cJSON_IsNumber(slot_item) && cJSON_IsNumber(bytes_item)) {
        char path[PATH_LEN];
        fos_scene_store_slot_path(slot, path, sizeof(path));
        long size = file_size(path);
        /* In place, both fields (cJSON prints valueint when they agree). */
        if (size < 0) size = 0;
        slot_item->valueint = slot;
        slot_item->valuedouble = slot;
        bytes_item->valueint = (int)size;
        bytes_item->valuedouble = (double)size;
        err = write_index(index);
    }
    cJSON_Delete(index);
    return err;
}

void fos_scene_store_sweep(void)
{
    cJSON *index = fos_scene_store_read_index();
    if (cJSON_GetArraySize(cJSON_GetObjectItem(index, "scenes")) > 0) {
        bool named[FOS_SCENE_STORE_SLOTS] = {false};
        mark_slots(index, named);
        char path[PATH_LEN];
        for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) {
            if (named[slot]) continue;
            fos_scene_store_slot_path(slot, path, sizeof(path));
            remove(path);
        }
    }
    cJSON_Delete(index);
}

bool fos_scene_store_recover_index(void)
{
    char path[PATH_LEN];
    char tmp[PATH_LEN];
    path_of(FOS_SCENE_STORE_INDEX_NAME, path);
    path_of(FOS_SCENE_STORE_INDEX_TMP_NAME, tmp);
    return file_size(path) < 0 && file_size(tmp) >= 0 && rename(tmp, path) == 0;
}
