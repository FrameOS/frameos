/* The per-scene store: see the header. No IDF calls here, the host test
 * compiles this with a laptop cc and IDF's cJSON. */
#include "fos_scene_store.h"

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "fos_json_guard.h"

#define PATH_LEN 96
#define WRITE_CHUNK 2048

static char s_dir[64] = "/state";
static fos_scene_store_hooks_t s_hooks = {0};

void fos_scene_store_set_dir(const char *dir)
{
    if (dir == NULL || dir[0] == '\0') return;
    snprintf(s_dir, sizeof(s_dir), "%s", dir);
    size_t len = strlen(s_dir);
    while (len > 1 && s_dir[len - 1] == '/') s_dir[--len] = '\0';
}

void fos_scene_store_set_hooks(const fos_scene_store_hooks_t *hooks)
{
    if (hooks != NULL) {
        s_hooks = *hooks;
    } else {
        memset(&s_hooks, 0, sizeof(s_hooks));
    }
}

const char *fos_scene_store_err_str(fos_scene_store_err_t err)
{
    switch (err) {
    case FOS_SCENE_STORE_OK: return "ok";
    case FOS_SCENE_STORE_ERR_INVALID: return "not one scene object with an id";
    case FOS_SCENE_STORE_ERR_NOT_FOUND: return "no such scene";
    case FOS_SCENE_STORE_ERR_NO_SLOTS: return "no free scene slot";
    case FOS_SCENE_STORE_ERR_NO_SPACE: return "no room on /state";
    case FOS_SCENE_STORE_ERR_IO: return "file error on /state";
    case FOS_SCENE_STORE_ERR_NO_MEMORY: return "out of memory";
    case FOS_SCENE_STORE_ERR_LAST_SCENE: return "a frame keeps at least one scene";
    case FOS_SCENE_STORE_ERR_MISSING_SCENE: return "the order names a scene that is not stored";
    }
    return "scene store error";
}

static void path_of(const char *name, char *out, size_t out_len)
{
    snprintf(out, out_len, "%s/%s", s_dir, name);
}

void fos_scene_store_slot_path(int slot, char *out, size_t out_len)
{
    snprintf(out, out_len, "%s/scene-%d.json", s_dir, slot);
}

static void *big_alloc(size_t bytes)
{
    void *block = s_hooks.big_alloc ? s_hooks.big_alloc(bytes) : NULL;
    return block ? block : malloc(bytes);
}

static char *read_text(const char *path, size_t *out_len)
{
    FILE *f = fopen(path, "rb");
    if (f == NULL) return NULL;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (size <= 0 || size > FOS_SCENE_STORE_MAX_BYTES) {
        fclose(f);
        return NULL;
    }
    char *buf = big_alloc((size_t)size + 1);
    if (buf == NULL) {
        fclose(f);
        return NULL;
    }
    size_t got = fread(buf, 1, (size_t)size, f);
    fclose(f);
    buf[got] = '\0';
    if (out_len != NULL) *out_len = got;
    return buf;
}

static bool file_exists(const char *path)
{
    struct stat st;
    return stat(path, &st) == 0;
}

static fos_scene_store_err_t write_replace(const char *path, const char *tmp, const char *data, size_t len)
{
    remove(tmp);
    if (s_hooks.make_room) s_hooks.make_room(len);
    errno = 0;
    FILE *f = fopen(tmp, "wb");
    if (f == NULL) return errno == ENOSPC ? FOS_SCENE_STORE_ERR_NO_SPACE : FOS_SCENE_STORE_ERR_IO;
    size_t written = 0;
    while (written < len) {
        size_t chunk = len - written > WRITE_CHUNK ? WRITE_CHUNK : len - written;
        size_t wrote = fwrite(data + written, 1, chunk, f);
        if (wrote == 0) break;
        written += wrote;
    }
    bool ok = written == len && !ferror(f);
    if (fclose(f) != 0) ok = false;
    if (!ok) {
        remove(tmp);
        return FOS_SCENE_STORE_ERR_NO_SPACE;
    }
    remove(path); /* SPIFFS refuses to rename over a file */
    if (rename(tmp, path) != 0) {
        remove(tmp);
        return FOS_SCENE_STORE_ERR_IO;
    }
    return FOS_SCENE_STORE_OK;
}

static cJSON *read_index(void)
{
    char path[PATH_LEN];
    path_of(FOS_SCENE_STORE_INDEX_NAME, path, sizeof(path));
    size_t len = 0;
    char *text = read_text(path, &len);
    if (text == NULL) return NULL;
    cJSON *index = cJSON_ParseWithLength(text, len);
    free(text);
    if (index != NULL && !cJSON_IsArray(cJSON_GetObjectItem(index, "scenes"))) {
        cJSON_Delete(index);
        return NULL;
    }
    return index;
}

static fos_scene_store_err_t write_index(cJSON *index)
{
    char *text = cJSON_PrintUnformatted(index);
    if (text == NULL) return FOS_SCENE_STORE_ERR_NO_MEMORY;
    char path[PATH_LEN];
    char tmp[PATH_LEN];
    path_of(FOS_SCENE_STORE_INDEX_NAME, path, sizeof(path));
    path_of(FOS_SCENE_STORE_INDEX_TMP_NAME, tmp, sizeof(tmp));
    fos_scene_store_err_t err = write_replace(path, tmp, text, strlen(text));
    cJSON_free(text);
    return err;
}

/* ------------------------------------------------------- reading a scene
 *
 * What the index needs from a scene is three top-level fields. A cJSON tree
 * of the whole scene is a node per token in internal RAM (its allocations are
 * under CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL), so the text is walked instead:
 * a scene with a lot of JavaScript costs a scan, not a heap spike. */

typedef struct {
    char id[FOS_SCENE_STORE_ID_LEN];
    char name[FOS_SCENE_STORE_ID_LEN];
    double refresh_interval;
    bool has_refresh_interval;
} scene_meta_t;

static size_t skip_space(const char *s, size_t len, size_t i)
{
    while (i < len && isspace((unsigned char)s[i])) i++;
    return i;
}

static bool skip_string(const char *s, size_t len, size_t *i)
{
    size_t p = *i;
    if (p >= len || s[p] != '"') return false;
    p++;
    while (p < len) {
        if (s[p] == '\\') {
            p += 2;
            continue;
        }
        if (s[p] == '"') {
            *i = p + 1;
            return true;
        }
        p++;
    }
    return false;
}

static bool skip_value(const char *s, size_t len, size_t *i)
{
    size_t p = *i;
    if (p >= len) return false;
    if (s[p] == '"') return skip_string(s, len, i);
    if (s[p] == '{' || s[p] == '[') {
        int depth = 0;
        while (p < len) {
            char c = s[p];
            if (c == '"') {
                if (!skip_string(s, len, &p)) return false;
                continue;
            }
            if (c == '{' || c == '[') depth++;
            if (c == '}' || c == ']') {
                depth--;
                if (depth == 0) {
                    *i = p + 1;
                    return true;
                }
            }
            p++;
        }
        return false;
    }
    while (p < len && s[p] != ',' && s[p] != '}' && s[p] != ']' && !isspace((unsigned char)s[p])) p++;
    if (p == *i) return false;
    *i = p;
    return true;
}

/* The decoded value of a JSON string token, by cJSON (a single small node).
 * False when it does not fit: an id must not be stored cut short. */
static bool copy_string_value(const char *token, size_t token_len, char *out, size_t out_len)
{
    bool ok = true;
    cJSON *value = cJSON_ParseWithLength(token, token_len);
    if (cJSON_IsString(value) && value->valuestring) {
        ok = strlen(value->valuestring) < out_len;
        if (ok) memcpy(out, value->valuestring, strlen(value->valuestring) + 1);
    }
    cJSON_Delete(value);
    return ok;
}

static bool key_is(const char *s, size_t start, size_t end, const char *name)
{
    size_t name_len = strlen(name);
    return end - start - 2 == name_len && memcmp(s + start + 1, name, name_len) == 0;
}

/* False unless `json` is one object whose top level walks cleanly and holds
 * a non-empty string `id`. */
static bool scan_scene_meta(const char *json, size_t len, scene_meta_t *meta)
{
    memset(meta, 0, sizeof(*meta));
    size_t i = skip_space(json, len, 0);
    if (i >= len || json[i] != '{') return false;
    i++;
    bool closed = false;
    while (true) {
        i = skip_space(json, len, i);
        if (i >= len) return false;
        if (json[i] == '}') {
            i++;
            closed = true;
            break;
        }
        if (json[i] == ',') {
            i++;
            continue;
        }
        size_t key_start = i;
        if (!skip_string(json, len, &i)) return false;
        size_t key_end = i;
        i = skip_space(json, len, i);
        if (i >= len || json[i] != ':') return false;
        i = skip_space(json, len, i + 1);
        size_t value_start = i;
        if (!skip_value(json, len, &i)) return false;
        size_t value_len = i - value_start;
        if (json[value_start] == '"') {
            if (key_is(json, key_start, key_end, "id")) {
                if (!copy_string_value(json + value_start, value_len, meta->id, sizeof(meta->id))) return false;
            } else if (key_is(json, key_start, key_end, "name")) {
                copy_string_value(json + value_start, value_len, meta->name, sizeof(meta->name));
            }
        } else if (key_is(json, key_start, key_end, "refreshInterval")) {
            char *end = NULL;
            double value = strtod(json + value_start, &end);
            if (end != json + value_start) {
                meta->refresh_interval = value;
                meta->has_refresh_interval = true;
            }
        }
    }
    /* Only white space may follow the closing brace: one scene, whole. */
    if (!closed || skip_space(json, len, i) != len) return false;
    return meta->id[0] != '\0';
}

/* ----------------------------------------------------------- the index */

static cJSON *find_entry(cJSON *scenes, const char *scene_id)
{
    cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, scenes) {
        const cJSON *id = cJSON_GetObjectItem(entry, "id");
        if (cJSON_IsString(id) && id->valuestring && strcmp(id->valuestring, scene_id) == 0) return entry;
    }
    return NULL;
}

static int entry_slot(const cJSON *entry)
{
    const cJSON *slot = cJSON_GetObjectItem(entry, "slot");
    return cJSON_IsNumber(slot) ? (int)slot->valuedouble : -1;
}

static void set_number(cJSON *entry, const char *key, double value)
{
    cJSON_DeleteItemFromObject(entry, key);
    cJSON_AddNumberToObject(entry, key, value);
}

static void update_entry(cJSON *entry, const scene_meta_t *meta, int slot, size_t bytes)
{
    set_number(entry, "slot", slot);
    set_number(entry, "bytes", (double)bytes);
    cJSON_DeleteItemFromObject(entry, "name");
    if (meta->name[0]) cJSON_AddStringToObject(entry, "name", meta->name);
    cJSON_DeleteItemFromObject(entry, "refreshInterval");
    if (meta->has_refresh_interval) cJSON_AddNumberToObject(entry, "refreshInterval", meta->refresh_interval);
}

static size_t entry_bytes(const cJSON *entry)
{
    const cJSON *bytes = cJSON_GetObjectItem(entry, "bytes");
    if (cJSON_IsNumber(bytes)) return (size_t)bytes->valuedouble;
    /* An index from before this field: the file itself. */
    int slot = entry_slot(entry);
    if (slot < 0) return 0;
    char path[PATH_LEN];
    fos_scene_store_slot_path(slot, path, sizeof(path));
    struct stat st;
    return stat(path, &st) == 0 ? (size_t)st.st_size : 0;
}

static void set_default_and_source(cJSON *index, cJSON *scenes, const char *source)
{
    cJSON_DeleteItemFromObject(index, "default");
    const cJSON *first_id = cJSON_GetObjectItem(cJSON_GetArrayItem(scenes, 0), "id");
    if (cJSON_IsString(first_id)) cJSON_AddStringToObject(index, "default", first_id->valuestring);
    if (source != NULL) {
        cJSON_DeleteItemFromObject(index, "source");
        cJSON_AddStringToObject(index, "source", source);
    }
}

fos_scene_store_err_t fos_scene_store_apply(const fos_scene_store_change_t *change,
                                            fos_scene_store_result_t *result,
                                            void (*on_dropped)(const char *id, void *ctx),
                                            void *ctx)
{
    if (change == NULL || result == NULL) return FOS_SCENE_STORE_ERR_INVALID;
    memset(result, 0, sizeof(*result));

    cJSON *index = read_index();
    if (index == NULL) {
        index = cJSON_CreateObject();
        if (index == NULL || cJSON_AddArrayToObject(index, "scenes") == NULL) {
            cJSON_Delete(index);
            return FOS_SCENE_STORE_ERR_NO_MEMORY;
        }
    }
    cJSON *scenes = cJSON_GetObjectItem(index, "scenes");

    /* A slot is free when no entry names it AND no file sits there: a file
     * the index does not name is one a reader may still be holding, until
     * the sweep. */
    bool used[FOS_SCENE_STORE_SLOTS] = {false};
    const cJSON *existing = NULL;
    cJSON_ArrayForEach(existing, scenes) {
        int slot = entry_slot(existing);
        if (slot >= 0 && slot < FOS_SCENE_STORE_SLOTS) used[slot] = true;
    }
    for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) {
        char path[PATH_LEN];
        fos_scene_store_slot_path(slot, path, sizeof(path));
        if (!used[slot] && file_exists(path)) used[slot] = true;
    }

    fos_scene_store_err_t err = FOS_SCENE_STORE_OK;
    int written[FOS_SCENE_STORE_SLOTS];
    int written_count = 0;
    char *dropped = NULL; /* FOS_SCENE_STORE_SLOTS ids in one block */
    int dropped_count = 0;

    for (int i = 0; i < change->put_count && err == FOS_SCENE_STORE_OK; i++) {
        const fos_scene_store_put_t *put = &change->puts[i];
        scene_meta_t meta;
        if (put->json == NULL || put->len == 0 || put->len > FOS_SCENE_STORE_MAX_BYTES ||
            !fos_json_depth_ok(put->json, put->len, FOS_JSON_MAX_DEPTH) ||
            !scan_scene_meta(put->json, put->len, &meta)) {
            err = FOS_SCENE_STORE_ERR_INVALID;
            break;
        }
        int slot = -1;
        for (int candidate = 0; candidate < FOS_SCENE_STORE_SLOTS; candidate++) {
            if (!used[candidate]) {
                slot = candidate;
                break;
            }
        }
        if (slot < 0) {
            err = FOS_SCENE_STORE_ERR_NO_SLOTS;
            break;
        }
        char path[PATH_LEN];
        char tmp[PATH_LEN];
        fos_scene_store_slot_path(slot, path, sizeof(path));
        path_of(FOS_SCENE_STORE_SLOT_TMP_NAME, tmp, sizeof(tmp));
        err = write_replace(path, tmp, put->json, put->len);
        if (err != FOS_SCENE_STORE_OK) break;
        used[slot] = true;
        written[written_count++] = slot;
        if (!result->first_put_id[0]) {
            snprintf(result->first_put_id, sizeof(result->first_put_id), "%s", meta.id);
        }
        cJSON *entry = find_entry(scenes, meta.id);
        if (entry == NULL) {
            entry = cJSON_CreateObject();
            if (entry == NULL) {
                err = FOS_SCENE_STORE_ERR_NO_MEMORY;
                break;
            }
            cJSON_AddStringToObject(entry, "id", meta.id);
            cJSON_AddItemToArray(scenes, entry);
        }
        update_entry(entry, &meta, slot, put->len);
    }

    if (err == FOS_SCENE_STORE_OK && change->remove_id != NULL) {
        cJSON *entry = find_entry(scenes, change->remove_id);
        if (entry == NULL) {
            err = FOS_SCENE_STORE_ERR_NOT_FOUND;
        } else {
            dropped = malloc(FOS_SCENE_STORE_ID_LEN);
            if (dropped == NULL) {
                err = FOS_SCENE_STORE_ERR_NO_MEMORY;
            } else {
                snprintf(dropped, FOS_SCENE_STORE_ID_LEN, "%s", change->remove_id);
                dropped_count = 1;
                cJSON_DetachItemViaPointer(scenes, entry);
                cJSON_Delete(entry);
            }
        }
    }

    if (err == FOS_SCENE_STORE_OK && change->order != NULL) {
        cJSON *ordered = cJSON_CreateArray();
        if (ordered == NULL) err = FOS_SCENE_STORE_ERR_NO_MEMORY;
        for (int i = 0; i < change->order_count && err == FOS_SCENE_STORE_OK; i++) {
            cJSON *entry = change->order[i] ? find_entry(scenes, change->order[i]) : NULL;
            if (entry == NULL) {
                err = FOS_SCENE_STORE_ERR_MISSING_SCENE;
                break;
            }
            cJSON_DetachItemViaPointer(scenes, entry);
            cJSON_AddItemToArray(ordered, entry);
        }
        if (err == FOS_SCENE_STORE_OK) {
            /* Whatever the order does not name is gone. */
            int rest = cJSON_GetArraySize(scenes);
            if (rest > 0) {
                dropped = malloc((size_t)rest * FOS_SCENE_STORE_ID_LEN);
                if (dropped == NULL) err = FOS_SCENE_STORE_ERR_NO_MEMORY;
            }
            if (err == FOS_SCENE_STORE_OK) {
                cJSON *entry = NULL;
                cJSON_ArrayForEach(entry, scenes) {
                    const cJSON *id = cJSON_GetObjectItem(entry, "id");
                    if (cJSON_IsString(id)) {
                        snprintf(dropped + (size_t)dropped_count * FOS_SCENE_STORE_ID_LEN,
                                 FOS_SCENE_STORE_ID_LEN, "%s", id->valuestring);
                        dropped_count++;
                    }
                }
                cJSON_ReplaceItemInObject(index, "scenes", ordered);
                ordered = NULL;
                scenes = cJSON_GetObjectItem(index, "scenes");
            }
        }
        cJSON_Delete(ordered);
    }

    if (err == FOS_SCENE_STORE_OK && cJSON_GetArraySize(scenes) == 0) {
        err = FOS_SCENE_STORE_ERR_LAST_SCENE;
    }

    if (err == FOS_SCENE_STORE_OK) {
        set_default_and_source(index, scenes, change->source);
        err = write_index(index);
    }

    if (err != FOS_SCENE_STORE_OK) {
        /* The index was not switched: this op's files are nobody's. */
        for (int i = 0; i < written_count; i++) {
            char path[PATH_LEN];
            fos_scene_store_slot_path(written[i], path, sizeof(path));
            remove(path);
        }
    } else {
        const cJSON *entry = NULL;
        cJSON_ArrayForEach(entry, scenes) {
            result->scene_count++;
            result->scenes_bytes += entry_bytes(entry);
        }
        if (on_dropped != NULL) {
            for (int i = 0; i < dropped_count; i++) {
                on_dropped(dropped + (size_t)i * FOS_SCENE_STORE_ID_LEN, ctx);
            }
        }
    }
    free(dropped);
    cJSON_Delete(index);
    return err;
}

int fos_scene_store_read_entries(fos_scene_store_entry_t *out, int max)
{
    cJSON *index = read_index();
    if (index == NULL) return -1;
    int count = 0;
    const cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, cJSON_GetObjectItem(index, "scenes")) {
        const cJSON *id = cJSON_GetObjectItem(entry, "id");
        int slot = entry_slot(entry);
        if (!cJSON_IsString(id) || id->valuestring == NULL || slot < 0) continue;
        if (count >= max) break;
        snprintf(out[count].id, sizeof(out[count].id), "%s", id->valuestring);
        out[count].slot = slot;
        out[count].bytes = entry_bytes(entry);
        count++;
    }
    cJSON_Delete(index);
    return count;
}

char *fos_scene_store_read_scene(const char *scene_id, size_t *out_len)
{
    if (out_len != NULL) *out_len = 0;
    if (scene_id == NULL || scene_id[0] == '\0') return NULL;
    cJSON *index = read_index();
    if (index == NULL) return NULL;
    cJSON *entry = find_entry(cJSON_GetObjectItem(index, "scenes"), scene_id);
    int slot = entry ? entry_slot(entry) : -1;
    cJSON_Delete(index);
    if (slot < 0) return NULL;
    char path[PATH_LEN];
    fos_scene_store_slot_path(slot, path, sizeof(path));
    return read_text(path, out_len);
}

cJSON *fos_scene_store_list_tree(void)
{
    cJSON *index = read_index();
    if (index == NULL) {
        index = cJSON_CreateObject();
        if (index == NULL || cJSON_AddArrayToObject(index, "scenes") == NULL) {
            cJSON_Delete(index);
            return NULL;
        }
    }
    size_t total = 0;
    int count = 0;
    cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, cJSON_GetObjectItem(index, "scenes")) {
        size_t bytes = entry_bytes(entry);
        set_number(entry, "bytes", (double)bytes);
        total += bytes;
        count++;
    }
    cJSON_AddNumberToObject(index, "sceneCount", count);
    cJSON_AddNumberToObject(index, "scenesBytes", (double)total);
    return index;
}

fos_scene_store_err_t fos_scene_store_repoint(const char *scene_id, int slot)
{
    if (scene_id == NULL || slot < 0 || slot >= FOS_SCENE_STORE_SLOTS) return FOS_SCENE_STORE_ERR_INVALID;
    cJSON *index = read_index();
    if (index == NULL) return FOS_SCENE_STORE_ERR_NOT_FOUND;
    cJSON *entry = find_entry(cJSON_GetObjectItem(index, "scenes"), scene_id);
    fos_scene_store_err_t err = FOS_SCENE_STORE_ERR_NOT_FOUND;
    if (entry != NULL) {
        set_number(entry, "slot", slot);
        cJSON_DeleteItemFromObject(entry, "bytes");
        set_number(entry, "bytes", (double)entry_bytes(entry));
        err = write_index(index);
    }
    cJSON_Delete(index);
    return err;
}

static int slot_of_name(const char *name)
{
    if (strncmp(name, "scene-", 6) != 0) return -1;
    const char *p = name + 6;
    if (!isdigit((unsigned char)*p)) return -1;
    int value = 0;
    while (isdigit((unsigned char)*p)) {
        value = value * 10 + (*p - '0');
        if (value >= FOS_SCENE_STORE_SLOTS) return -1;
        p++;
    }
    return strcmp(p, ".json") == 0 ? value : -1;
}

void fos_scene_store_sweep(void)
{
    cJSON *index = read_index();
    if (index == NULL) return;
    const cJSON *scenes = cJSON_GetObjectItem(index, "scenes");
    if (cJSON_GetArraySize(scenes) == 0) {
        cJSON_Delete(index);
        return;
    }
    bool named[FOS_SCENE_STORE_SLOTS] = {false};
    const cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, scenes) {
        int slot = entry_slot(entry);
        if (slot >= 0 && slot < FOS_SCENE_STORE_SLOTS) named[slot] = true;
    }
    cJSON_Delete(index);
    DIR *dir = opendir(s_dir);
    if (dir == NULL) return;
    struct dirent *item;
    while ((item = readdir(dir)) != NULL) {
        int slot = slot_of_name(item->d_name);
        if (slot >= 0 && !named[slot]) {
            char path[PATH_LEN];
            fos_scene_store_slot_path(slot, path, sizeof(path));
            remove(path);
        }
    }
    closedir(dir);
}

bool fos_scene_store_recover_index(void)
{
    char path[PATH_LEN];
    char tmp[PATH_LEN];
    path_of(FOS_SCENE_STORE_INDEX_NAME, path, sizeof(path));
    path_of(FOS_SCENE_STORE_INDEX_TMP_NAME, tmp, sizeof(tmp));
    if (file_exists(path) || !file_exists(tmp)) return false;
    return rename(tmp, path) == 0;
}
