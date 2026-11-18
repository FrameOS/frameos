/* The per-scene store: see the header. No IDF calls here, the host test
 * compiles this with a laptop cc and IDF's cJSON. */
#include "fos_scene_store.h"

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "fos_json_guard.h"
#include "fos_scene_meta.h"

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

/* Which slot files exist, as far as the store knows. Every slot file is
 * written and removed here, under the caller's lock, so once it has listed
 * the directory (learn_slot_files: the first time it needs to know, a boot's
 * sweep as a rule) the store asks flash nothing about them. A lookup by name
 * on SPIFFS walks every block's lookup page, about half a second on a 24 MB
 * partition (2026-11-10, the reTerminal Sticky): a put that stat'ed every
 * unnamed slot and a sweep that removed them all cost seconds each, the sweep
 * on the render task. One listing is one such walk for all of them: asked
 * slot by slot, 256 slots were two minutes of every boot. Unknown again after
 * fos_scene_store_forget(). */
static fos_scene_store_slots_t s_slot_map[3]; /* one array: slot_is() sets all three */
#define s_slot_file s_slot_map[0]
/* A slot file the sweep emptied rather than removed, nobody's: the next put
 * writes it. Opening a file that is there is one lookup that finds it
 * (~15 ms); creating one walks the whole partition twice, for the name and
 * for a free id (~1.07 s on 24 MB). An empty file is a page or two. */
#define s_slot_spare s_slot_map[1]
/* A slot file a set being read is written to (the stage calls): no index
 * names it yet, and no sweep takes it. */
#define s_slot_staged s_slot_map[2]
static bool s_slot_map_known = false;
/* The listing found the file firmware before 2026.11.6 wrote a slot to first. */
static bool s_old_slot_tmp = false;

#define has fos_scene_store_slots_has
#define put_slot fos_scene_store_slots_put

/* What the store knows of one slot file, all three maps in one call (a call
 * a map at every site was 150 bytes more). */
enum { SLOT_NONE = 0, SLOT_FILE = 1, SLOT_SPARE = 2, SLOT_STAGED = 4 };

static void slot_is(int slot, unsigned what)
{
    for (int map = 0; map < 3; map++) put_slot(&s_slot_map[map], slot, (what >> map) & 1u);
}

static void stage_forget(void);

void fos_scene_store_forget(void)
{
    stage_forget();
    memset(s_slot_map, 0, sizeof(s_slot_map));
    s_slot_map_known = false;
}

/* Emptied and kept for the next put (s_slot_spare); removed if it cannot be. */
static void retire_slot(int slot)
{
    char path[PATH_LEN];
    fos_scene_store_slot_path(slot, path, sizeof(path));
    FILE *f = fopen(path, "wb");
    if (f != NULL && fclose(f) == 0) {
        slot_is(slot, SLOT_FILE | SLOT_SPARE);
        return;
    }
    remove(path);
    slot_is(slot, SLOT_NONE);
}

/* The slot files there are, from one listing of the directory. Without a
 * listing (the directory cannot be opened) nothing is known and each slot is
 * asked for by name, as before. */
static void learn_slot_files(void)
{
    if (s_slot_map_known) return;
    DIR *dir = opendir(s_dir);
    if (dir == NULL) return;
    memset(s_slot_map, 0, 2 * sizeof(s_slot_map[0])); /* the files and the spares; a staging stays */
    struct dirent *item;
    while ((item = readdir(dir)) != NULL) {
        if (strcmp(item->d_name, FOS_SCENE_STORE_SLOT_TMP_NAME) == 0) s_old_slot_tmp = true;
        /* "scene-<slot>.json", as the store writes it: no other spelling. */
        const char *at = item->d_name;
        if (strncmp(at, "scene-", 6) != 0) continue;
        at += 6;
        int slot = 0, digits = 0;
        while (*at >= '0' && *at <= '9' && digits < 4) {
            slot = slot * 10 + (*at++ - '0');
            digits++;
        }
        if (digits == 0 || (digits > 1 && item->d_name[6] == '0') || strcmp(at, ".json") != 0) continue;
        if (slot < FOS_SCENE_STORE_SLOTS) put_slot(&s_slot_file, slot, true);
    }
    closedir(dir);
    s_slot_map_known = true;
}

static bool slot_has_file(int slot)
{
    learn_slot_files();
    if (s_slot_map_known) return has(&s_slot_file, slot);
    char path[PATH_LEN];
    fos_scene_store_slot_path(slot, path, sizeof(path));
    return file_size(path) >= 0;
}

static void remove_slot(int slot)
{
    char path[PATH_LEN];
    fos_scene_store_slot_path(slot, path, sizeof(path));
    remove(path);
    slot_is(slot, SLOT_NONE);
}

void fos_scene_store_remove_slots(void)
{
    /* A set being read was against the set these files are: it ends here. */
    fos_scene_store_stage_drop(0);
    learn_slot_files();
    if (!s_slot_map_known) {
        for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) remove_slot(slot);
        s_slot_map_known = true; /* none now */
        return;
    }
    /* Emptied, so the whole set written next opens files that are there. */
    for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) {
        if (has(&s_slot_file, slot) && !has(&s_slot_spare, slot)) retire_slot(slot);
    }
}

/* The slot a put writes: a spare first (a file that is there), else the
 * first slot nobody names and no file sits in. FOS_SCENE_STORE_SLOTS: none. */
static int pick_slot(fos_scene_store_slots_t *used)
{
    learn_slot_files();
    if (s_slot_map_known) {
        for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) {
            if (!has(used, slot) && has(&s_slot_spare, slot)) return slot;
        }
    }
    int slot = 0;
    while (slot < FOS_SCENE_STORE_SLOTS && (has(used, slot) || slot_has_file(slot))) {
        put_slot(used, slot, true);
        slot++;
    }
    return slot;
}

/* From the caller's big blocks (PSRAM) where it has them, else the heap. */
static void *big_alloc(size_t size)
{
    void *block = s_hooks.big_alloc ? s_hooks.big_alloc(size) : NULL;
    return block ? block : malloc(size);
}

char *fos_scene_store_read_file(const char *path, size_t *out_len)
{
    FILE *f = fopen(path, "rb");
    if (f == NULL) return NULL;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = NULL;
    if (size > 0 && size <= FOS_SCENE_STORE_MAX_BYTES) buf = big_alloc((size_t)size + 1);
    if (buf != NULL) {
        size_t got = fread(buf, 1, (size_t)size, f);
        buf[got] = '\0';
        if (out_len != NULL) *out_len = got;
    }
    fclose(f);
    return buf;
}

/* A file is written through a buffer of this size, in PSRAM where the board
 * has it: SPIFFS rewrites a file's index header page at the end of every
 * write call, so 2 KB at a time was a page of flash for every four of data,
 * and a deleted page more for the collector. */
#define WRITE_BUFFER_BYTES (8 * 1024)

static char *write_buffer_new(void)
{
    return big_alloc(WRITE_BUFFER_BYTES);
}

/* `path` written whole, or not there at all (removed on any failure, errno
 * kept). "wb" truncates a file that is there, so nothing is removed first:
 * each remove is one more lookup by name. */
/* `count` parts written one after the other, or with `array` as the JSON
 * array of them (a set's combined file written from its scenes, never one
 * block of its size). */
static fos_scene_store_err_t write_parts(const char *path, const fos_scene_store_put_t *parts, int count, bool array)
{
    size_t len = array ? (size_t)(count > 1 ? count + 1 : 2) : 0;
    for (int i = 0; i < count; i++) len += parts[i].len;
    if (s_hooks.make_room) s_hooks.make_room(len);
    errno = 0;
    FILE *f = fopen(path, "wb");
    if (f == NULL) {
        int err_no = errno;
        remove(path);
        errno = err_no;
        return err_no == ENOSPC ? FOS_SCENE_STORE_ERR_NO_SPACE : FOS_SCENE_STORE_ERR_IO;
    }
    /* Without one the file is written as before, a call for each 2 KB. */
    char *buffer = write_buffer_new();
    if (buffer != NULL) setvbuf(f, buffer, _IOFBF, WRITE_BUFFER_BYTES);
    bool ok = !array || fputc('[', f) != EOF;
    for (int i = 0; ok && i < count; i++) {
        if (array && i > 0 && fputc(',', f) == EOF) ok = false;
        size_t written = 0;
        while (ok && written < parts[i].len) {
            size_t chunk = parts[i].len - written > 2048 ? 2048 : parts[i].len - written;
            if (s_hooks.pace) s_hooks.pace();
            size_t wrote = fwrite(parts[i].json + written, 1, chunk, f);
            if (wrote == 0) ok = false;
            written += wrote;
        }
    }
    if (ok && array) ok = fputc(']', f) != EOF;
    if (ferror(f)) ok = false;
    if (fclose(f) != 0) ok = false;
    free(buffer);
    if (!ok) {
        int err_no = errno ? errno : ENOSPC;
        remove(path);
        errno = err_no;
        return FOS_SCENE_STORE_ERR_NO_SPACE;
    }
    return FOS_SCENE_STORE_OK;
}

static fos_scene_store_err_t write_plain(const char *path, const char *data, size_t len)
{
    fos_scene_store_put_t part = {.json = data, .len = len};
    return write_parts(path, &part, 1, false);
}

static fos_scene_store_err_t write_replace(const char *path, const char *tmp, const fos_scene_store_put_t *parts,
                                           int count, bool array)
{
    fos_scene_store_err_t written = write_parts(tmp, parts, count, array);
    if (written != FOS_SCENE_STORE_OK) return written;
    remove(path);
    /* A failed rename keeps the tmp: for the index it is the only copy, and
     * fos_scene_store_recover_index() puts it back at the next boot. */
    return rename(tmp, path) == 0 ? FOS_SCENE_STORE_OK : FOS_SCENE_STORE_ERR_IO;
}

fos_scene_store_err_t fos_scene_store_write_file(const char *path, const char *tmp,
                                                 const char *data, size_t len)
{
    fos_scene_store_put_t part = {.json = data, .len = len};
    return write_replace(path, tmp, &part, 1, false);
}

fos_scene_store_err_t fos_scene_store_write_set(const char *path, const char *tmp,
                                                const fos_scene_store_put_t *scenes, int count)
{
    return write_replace(path, tmp, scenes, count, true);
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

static void mark_slots(const cJSON *index, fos_scene_store_slots_t *used)
{
    const cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, cJSON_GetObjectItem(index, "scenes")) {
        put_slot(used, fos_scene_store_entry_slot(entry), true);
    }
}

/* One index file as a tree; NULL when it is missing or not an index. */
static cJSON *parse_index_file(const char *name)
{
    char path[PATH_LEN];
    path_of(name, path);
    size_t len = 0;
    char *text = fos_scene_store_read_file(path, &len);
    if (text == NULL) return NULL;
    cJSON *index = cJSON_ParseWithLength(text, len);
    free(text);
    if (!cJSON_IsArray(cJSON_GetObjectItem(index, "scenes"))) {
        cJSON_Delete(index);
        return NULL;
    }
    return index;
}

cJSON *fos_scene_store_read_index(void)
{
    /* The copy, when the index itself is not whole: a power cut while it was
     * rewritten in place (write_index). */
    cJSON *index = parse_index_file(FOS_SCENE_STORE_INDEX_NAME);
    if (index == NULL) index = parse_index_file(FOS_SCENE_STORE_INDEX_TMP_NAME);
    if (index == NULL) return NULL;
    cJSON *scenes = cJSON_GetObjectItem(index, "scenes");
    char path[PATH_LEN];
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

/* The copy first, whole: that is the change made. Then the index in place,
 * which a power cut can leave torn, and then readers take the copy
 * (fos_scene_store_read_index). Two lookups by name where a tmp, a remove and
 * a rename took five (2.7 s on a 24 MB SPIFFS). Both files stay. An index the
 * rewrite could not finish is removed, so no reader takes the old one. */
static fos_scene_store_err_t write_index(const cJSON *index)
{
    char *text = cJSON_PrintUnformatted(index);
    if (text == NULL) return FOS_SCENE_STORE_ERR_NO_MEMORY;
    char path[PATH_LEN];
    char tmp[PATH_LEN];
    path_of(FOS_SCENE_STORE_INDEX_NAME, path);
    path_of(FOS_SCENE_STORE_INDEX_TMP_NAME, tmp);
    size_t len = strlen(text);
    fos_scene_store_err_t err = write_plain(tmp, text, len);
    if (err == FOS_SCENE_STORE_OK) (void)write_plain(path, text, len); /* removed if it failed */
    cJSON_free(text);
    return err;
}

void fos_scene_store_remove_index(void)
{
    char path[PATH_LEN];
    path_of(FOS_SCENE_STORE_INDEX_NAME, path);
    remove(path);
    path_of(FOS_SCENE_STORE_INDEX_TMP_NAME, path);
    remove(path);
}

/* FNV-1a over a scene's bytes: whether the file stored is the one a whole set
 * brings again (fos_scene_store_apply_set). */
#define CONTENT_HASH_START 2166136261u

static uint32_t content_hash_more(uint32_t hash, const char *data, size_t len)
{
    for (size_t i = 0; i < len; i++) {
        hash ^= (unsigned char)data[i];
        hash *= 16777619u;
    }
    return hash;
}

static uint32_t content_hash(const char *data, size_t len)
{
    return content_hash_more(CONTENT_HASH_START, data, len);
}

static bool entry_hash_is(const cJSON *entry, uint32_t hash)
{
    const cJSON *stored = cJSON_GetObjectItem(entry, "hash");
    return cJSON_IsNumber(stored) && stored->valuedouble == (double)hash;
}

/* A scene's icon (`settings.icon`, docs/scene-icons.md) is one SVG path of at
 * most this many characters, its ends trimmed. The runtime checks the path
 * itself (scene_icon.nim); the store only keeps a longer value out of the
 * index, which every catalog read parses whole. */
#define ICON_MAX_LEN 1024
/* A category is a name ("Photos", docs/scene-icons.md "Category"), listed as
 * it is: the store keeps one of a heading's length out of the index. */
#define CATEGORY_MAX_LEN 128

/* A setting kept in the index: text no longer than `max` bytes once its ends
 * are trimmed, and not empty. */
static void keep_text(cJSON *entry, const cJSON *settings, const char *key, size_t max)
{
    const cJSON *value = cJSON_GetObjectItem(settings, key);
    if (!cJSON_IsString(value)) return;
    const char *text = value->valuestring;
    size_t start = 0, end = strlen(text);
    while (start < end && strchr(" \t\n\r", text[start])) start++;
    while (end > start && strchr(" \t\n\r", text[end - 1])) end--;
    if (end > start && end - start <= max) cJSON_AddStringToObject(entry, key, text);
}

/* What the index keeps of a scene: what the catalog and a boot need, and the
 * hash of the bytes in its file. */
static cJSON *make_entry(const cJSON *scene, int slot, size_t bytes, uint32_t hash)
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
    cJSON_AddNumberToObject(entry, "hash", (double)hash);
    /* A layout (docs/scene-layouts.md) is read by id when a scene names it;
     * it is in no list and never what a frame boots to. */
    const cJSON *settings = cJSON_GetObjectItem(scene, "settings");
    if (entry_flag(settings, "isLayout")) {
        cJSON_AddBoolToObject(entry, "isLayout", true);
        /* A desktop (`settings.desktop`) is listed apart on the frame page. */
        if (entry_flag(settings, "desktop")) cJSON_AddBoolToObject(entry, "desktop", true);
    } else {
        if (entry_flag(scene, "default")) cJSON_AddBoolToObject(entry, "default", true);
        /* "WxH": the size it opens at in a desktop's window (app.frame.scenes). */
        const cJSON *window = cJSON_GetObjectItem(settings, "windowSize");
        if (cJSON_IsString(window) && window->valuestring[0]) {
            cJSON_AddStringToObject(entry, "windowSize", window->valuestring);
        }
        /* Its icon: the switcher's tile and app.frame.scenes, read off the index. */
        keep_text(entry, settings, "icon", ICON_MAX_LEN);
    }
    /* Its category: a desktop groups its scene lists by it, and the frame
     * page its layouts. */
    keep_text(entry, settings, "category", CATEGORY_MAX_LEN);
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

/* ------------------------------------------------- a set as it arrives */

/* How much room is asked for ahead of a staged scene's bytes: its length is
 * not known until it has all come. */
#define STAGE_ROOM_STEP (64 * 1024)

typedef struct {
    unsigned int id;        /* 0: nothing is staged */
    FILE *file;             /* the scene being written; NULL between two */
    int slot;
    size_t bytes;           /* of the scene being written */
    uint32_t hash;
    size_t room_asked;
    char *buffer;           /* the file's (write_buffer_new); NULL: none */
    fos_scene_meta_t *meta; /* what the index keeps of it, read off its bytes */
    cJSON *old;             /* the index when the staging began: what is stored already */
    cJSON *entries;         /* the written scenes' index entries, in the order they came */
    cJSON *order;           /* every scene's id, in the order they came */
    cJSON *kept;            /* {"<id>": hash} of the scenes stored already */
    size_t written_bytes;
} stage_t;

static stage_t s_stage;
static unsigned int s_stage_ids;

bool fos_scene_store_staging(unsigned int id)
{
    return s_stage.id != 0 && s_stage.id == id;
}
#define staging fos_scene_store_staging

/* The staging's memory, not its files. */
static void stage_free(void)
{
    if (s_stage.file != NULL) fclose(s_stage.file);
    free(s_stage.buffer);
    free(s_stage.meta);
    cJSON_Delete(s_stage.old);
    cJSON_Delete(s_stage.entries);
    cJSON_Delete(s_stage.order);
    cJSON_Delete(s_stage.kept);
    memset(&s_stage, 0, sizeof(s_stage));
}

/* The files are gone already (a wipe). */
static void stage_forget(void)
{
    stage_free();
}

void fos_scene_store_stage_drop(unsigned int id)
{
    if (s_stage.id == 0 || (id != 0 && id != s_stage.id)) return;
    bool open = s_stage.file != NULL;
    int open_slot = s_stage.slot;
    if (open) {
        fclose(s_stage.file);
        s_stage.file = NULL;
        retire_slot(open_slot);
    }
    const cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, s_stage.entries) {
        int slot = fos_scene_store_entry_slot(entry);
        if (slot >= 0) retire_slot(slot);
    }
    stage_free();
}

unsigned int fos_scene_store_stage_open(void)
{
    fos_scene_store_stage_drop(0);
    s_stage.meta = big_alloc(sizeof(*s_stage.meta));
    s_stage.buffer = write_buffer_new();
    s_stage.old = fos_scene_store_read_index(); /* NULL: none yet */
    s_stage.entries = cJSON_CreateArray();
    s_stage.order = cJSON_CreateArray();
    s_stage.kept = cJSON_CreateObject();
    if (s_stage.meta == NULL || s_stage.entries == NULL || s_stage.order == NULL || s_stage.kept == NULL) {
        stage_free();
        return 0;
    }
    if (++s_stage_ids == 0) s_stage_ids = 1;
    s_stage.id = s_stage_ids;
    return s_stage.id;
}

fos_scene_store_err_t fos_scene_store_stage_begin(unsigned int id)
{
    if (!staging(id) || s_stage.file != NULL) return FOS_SCENE_STORE_ERR_INVALID;
    if (cJSON_GetArraySize(s_stage.order) >= FOS_SCENE_STORE_SCENES) return FOS_SCENE_STORE_ERR_NO_SLOTS;
    /* Free of the set as it was when the staging began and of every file the
     * store knows of since (a slot another change took has a file). */
    fos_scene_store_slots_t used = {{0}};
    mark_slots(s_stage.old, &used);
    int slot = pick_slot(&used);
    if (slot == FOS_SCENE_STORE_SLOTS) return FOS_SCENE_STORE_ERR_NO_SLOTS;
    char path[PATH_LEN];
    fos_scene_store_slot_path(slot, path, sizeof(path));
    if (s_hooks.make_room) s_hooks.make_room(STAGE_ROOM_STEP);
    errno = 0;
    FILE *f = fopen(path, "wb");
    if (f == NULL) {
        int err_no = errno;
        remove_slot(slot);
        errno = err_no;
        return err_no == ENOSPC ? FOS_SCENE_STORE_ERR_NO_SPACE : FOS_SCENE_STORE_ERR_IO;
    }
    slot_is(slot, SLOT_FILE | SLOT_STAGED);
    if (s_stage.buffer != NULL) setvbuf(f, s_stage.buffer, _IOFBF, WRITE_BUFFER_BYTES);
    s_stage.file = f;
    s_stage.slot = slot;
    s_stage.bytes = 0;
    s_stage.hash = CONTENT_HASH_START;
    s_stage.room_asked = STAGE_ROOM_STEP;
    fos_scene_meta_begin(s_stage.meta);
    return FOS_SCENE_STORE_OK;
}

/* The scene being written is given up: its file goes back, the rest stays. */
static fos_scene_store_err_t stage_abort_scene(fos_scene_store_err_t err)
{
    int err_no = errno;
    if (s_stage.file != NULL) fclose(s_stage.file);
    s_stage.file = NULL;
    retire_slot(s_stage.slot);
    errno = err_no;
    return err;
}

fos_scene_store_err_t fos_scene_store_stage_write(unsigned int id, const char *bytes, size_t len)
{
    if (!staging(id) || s_stage.file == NULL) return FOS_SCENE_STORE_ERR_INVALID;
    /* A scene is read whole to be run: one that no read would take is refused
     * while it comes, not stored. */
    if (s_stage.bytes + len > FOS_SCENE_STORE_MAX_BYTES) return stage_abort_scene(FOS_SCENE_STORE_ERR_INVALID);
    size_t written = 0;
    while (written < len) {
        size_t chunk = len - written > 2048 ? 2048 : len - written;
        if (s_stage.bytes + chunk > s_stage.room_asked) {
            if (s_hooks.make_room) s_hooks.make_room(STAGE_ROOM_STEP);
            s_stage.room_asked += STAGE_ROOM_STEP;
        }
        if (s_hooks.pace) s_hooks.pace();
        /* Another change's whole payload may have ended the staging while the
         * pace let the lock go: its file is closed. */
        if (!staging(id) || s_stage.file == NULL) return FOS_SCENE_STORE_ERR_INVALID;
        errno = 0;
        if (fwrite(bytes + written, 1, chunk, s_stage.file) != chunk) {
            if (errno == 0) errno = ENOSPC;
            return stage_abort_scene(FOS_SCENE_STORE_ERR_NO_SPACE);
        }
        s_stage.hash = content_hash_more(s_stage.hash, bytes + written, chunk);
        fos_scene_meta_feed(s_stage.meta, bytes + written, chunk);
        s_stage.bytes += chunk;
        written += chunk;
    }
    return FOS_SCENE_STORE_OK;
}

fos_scene_store_err_t fos_scene_store_stage_end(unsigned int id, bool *kept)
{
    if (kept != NULL) *kept = false;
    if (!staging(id) || s_stage.file == NULL) return FOS_SCENE_STORE_ERR_INVALID;
    errno = 0;
    bool wrote = !ferror(s_stage.file);
    if (fclose(s_stage.file) != 0) wrote = false;
    s_stage.file = NULL;
    if (!wrote) {
        if (errno == 0) errno = ENOSPC;
        return stage_abort_scene(FOS_SCENE_STORE_ERR_NO_SPACE);
    }
    /* What the index keeps of it, as read off its bytes: one object, an id,
     * no deeper than a whole parse takes, not in the set twice. */
    const char *text = fos_scene_meta_text(s_stage.meta);
    cJSON *scene = text != NULL && fos_scene_meta_depth(s_stage.meta) <= FOS_JSON_MAX_DEPTH ? cJSON_Parse(text) : NULL;
    const char *scene_id = entry_id(scene);
    bool ok = cJSON_IsObject(scene) && scene_id[0] && strlen(scene_id) < FOS_SCENE_STORE_ID_LEN;
    const cJSON *named = NULL;
    cJSON_ArrayForEach(named, s_stage.order) {
        if (ok && strcmp(named->valuestring, scene_id) == 0) ok = false;
    }
    if (!ok) {
        cJSON_Delete(scene);
        return stage_abort_scene(FOS_SCENE_STORE_ERR_INVALID);
    }
    /* Stored already when its hash says so, as a set held in memory is told
     * (fos_scene_store_apply_set). */
    const cJSON *stored = find_entry(cJSON_GetObjectItem(s_stage.old, "scenes"), scene_id);
    bool same = stored != NULL && fos_scene_store_entry_slot(stored) >= 0 && entry_hash_is(stored, s_stage.hash);
    cJSON *order_id = cJSON_CreateString(scene_id);
    cJSON *entry = same ? cJSON_CreateNumber((double)s_stage.hash)
                        : make_entry(scene, s_stage.slot, s_stage.bytes, s_stage.hash);
    cJSON_Delete(scene); /* scene_id with it: the copies are made */
    if (order_id == NULL || entry == NULL) {
        cJSON_Delete(order_id);
        cJSON_Delete(entry);
        return stage_abort_scene(FOS_SCENE_STORE_ERR_NO_MEMORY);
    }
    if (same) {
        /* Stored already, byte for byte: the file written is given back. */
        cJSON_AddItemToObject(s_stage.kept, order_id->valuestring, entry);
        retire_slot(s_stage.slot);
        if (kept != NULL) *kept = true;
    } else {
        cJSON_AddItemToArray(s_stage.entries, entry);
        s_stage.written_bytes += s_stage.bytes;
    }
    cJSON_AddItemToArray(s_stage.order, order_id);
    return FOS_SCENE_STORE_OK;
}

void fos_scene_store_stage_counts(unsigned int id, int *written, int *kept, size_t *written_bytes)
{
    bool live = staging(id);
    if (written != NULL) *written = live ? cJSON_GetArraySize(s_stage.entries) : 0;
    if (kept != NULL) *kept = live ? cJSON_GetArraySize(s_stage.kept) : 0;
    if (written_bytes != NULL) *written_bytes = live ? s_stage.written_bytes : 0;
}

/* The work arrays of one change: one writer at a time (the caller's lock),
 * and 128 pointers are not for an 8 KB task's stack. */
static cJSON *s_fresh[FOS_SCENE_STORE_SCENES];
static int16_t s_written[FOS_SCENE_STORE_SCENES];

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
     * the sweep. Asked of flash only while the store does not know its
     * files (slot_has_file), and only for the slots a put tries. */
    fos_scene_store_slots_t used = {{0}};
    mark_slots(old, &used);
    char path[PATH_LEN];

    fos_scene_store_err_t err = FOS_SCENE_STORE_OK;
    cJSON **fresh = s_fresh; /* the puts' new entries, each until it is placed */
    int fresh_count = 0;
    int16_t *written = s_written;
    int written_count = 0;

    const cJSON *item = change->put_items ? change->put_items->child : NULL;
    int put_count = change->put_items ? cJSON_GetArraySize(change->put_items) : change->put_count;
    const cJSON *order = change->order;
    const cJSON *staged_kept = NULL;
    if (change->staged != 0) {
        /* The puts are in their files already: their entries are the fresh
         * ones, and a failure gives the files back like any put's. */
        put_count = 0;
        if (!staging(change->staged) || s_stage.file != NULL) {
            err = FOS_SCENE_STORE_ERR_INVALID;
        } else {
            while (s_stage.entries->child != NULL) {
                cJSON *entry = cJSON_DetachItemFromArray(s_stage.entries, 0);
                written[written_count++] = (int16_t)fos_scene_store_entry_slot(entry);
                fresh[fresh_count++] = entry;
                if (!result->first_put_id[0]) {
                    snprintf(result->first_put_id, sizeof(result->first_put_id), "%s", entry_id(entry));
                }
            }
            result->put_bytes = s_stage.written_bytes;
            if (order == NULL) order = s_stage.order;
            staged_kept = s_stage.kept;
        }
    } else if (put_count > FOS_SCENE_STORE_SCENES) {
        err = FOS_SCENE_STORE_ERR_NO_SLOTS;
    }
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
        int slot = pick_slot(&used);
        if (json == NULL) {
            err = FOS_SCENE_STORE_ERR_NO_MEMORY;
        } else if (!ok) {
            err = FOS_SCENE_STORE_ERR_INVALID;
        } else if (slot == FOS_SCENE_STORE_SLOTS) {
            err = FOS_SCENE_STORE_ERR_NO_SLOTS;
        } else {
            /* Straight to its own name: no index names this slot until the
             * index is written, so a torn file is nobody's (the sweep's),
             * and a tmp, a remove and a rename were three more lookups. */
            fos_scene_store_slot_path(slot, path, sizeof(path));
            slot_is(slot, SLOT_FILE);
            err = write_plain(path, json, len);
            if (err != FOS_SCENE_STORE_OK) slot_is(slot, SLOT_NONE); /* removed */
        }
        if (err == FOS_SCENE_STORE_OK) {
            put_slot(&used, slot, true);
            written[written_count++] = (int16_t)slot;
            fresh[fresh_count] = make_entry(scene, slot, len, content_hash(json, len));
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
    if (err == FOS_SCENE_STORE_OK && order != NULL) {
        const cJSON *named = NULL;
        cJSON_ArrayForEach(named, order) {
            const char *id = cJSON_IsString(named) ? named->valuestring : "";
            cJSON *entry = NULL;
            if (id[0] && find_entry(scenes, id) == NULL) {
                entry = take_fresh(fresh, fresh_count, id);
                const cJSON *kept = entry ? NULL : find_entry(old_scenes, id);
                /* A staged scene found stored already must still be that
                 * scene: another change may have been made since. */
                const cJSON *kept_hash = kept ? cJSON_GetObjectItem(staged_kept, id) : NULL;
                if (kept_hash != NULL && !entry_hash_is(kept, (uint32_t)kept_hash->valuedouble)) kept = NULL;
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
    if (err == FOS_SCENE_STORE_OK && order == NULL) {
        /* A new scene goes last, in the order they came. */
        for (int i = 0; i < fresh_count; i++) {
            if (fresh[i] != NULL) cJSON_AddItemToArray(scenes, fresh[i]);
            fresh[i] = NULL;
        }
    }

    if (err == FOS_SCENE_STORE_OK && cJSON_GetArraySize(scenes) == 0) err = FOS_SCENE_STORE_ERR_LAST_SCENE;
    if (err == FOS_SCENE_STORE_OK && cJSON_GetArraySize(scenes) > FOS_SCENE_STORE_SCENES) {
        err = FOS_SCENE_STORE_ERR_NO_SLOTS;
    }
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
        /* The index was not switched: this op's files are nobody's. A staged
         * set's are emptied for the next put, not removed: a remove is a
         * lookup by name each, half a second on a big partition. */
        for (int i = 0; i < written_count; i++) {
            if (change->staged != 0) retire_slot(written[i]);
            else remove_slot(written[i]);
        }
    } else {
        result->scene_count = cJSON_GetArraySize(scenes);
        fos_scene_store_slots_t named = {{0}};
        mark_slots(index, &named);
        const cJSON *kept = NULL;
        cJSON_ArrayForEach(kept, old_scenes) {
            if (on_dropped != NULL && find_entry(scenes, entry_id(kept)) == NULL) on_dropped(entry_id(kept), ctx);
            int slot = fos_scene_store_entry_slot(kept);
            if (slot >= 0 && !has(&named, slot)) put_slot(&result->freed, slot, true);
        }
        /* The staged files are the index's now. */
        for (int i = 0; i < written_count; i++) put_slot(&s_slot_staged, written[i], false);
        /* A staged scene the new index does not name (a patch's order left it
         * out) is nobody's. */
        for (int i = 0; change->staged != 0 && i < written_count; i++) {
            if (!has(&named, written[i])) retire_slot(written[i]);
        }
    }
    /* Committed or refused, the staging is over: its files went one way or
     * the other above. */
    if (change->staged != 0 && staging(change->staged)) stage_free();
    for (int i = 0; i < fresh_count; i++) cJSON_Delete(fresh[i]);
    cJSON_Delete(index);
    cJSON_Delete(old);
    return err;
}

/* One change, then the files it left unnamed emptied for the next put (a
 * whole set's next scene needs that room), then the caller's moment between
 * two steps (each leaves a whole set on flash). No index read of its own: on
 * a 24 MB SPIFFS each is a lookup by name, half a second, and a step that
 * read it twice more took 9 s a scene (the reTerminal E1003, 2026-11-10). */
static fos_scene_store_err_t apply_and_retire(const fos_scene_store_change_t *change,
                                              void (*on_dropped)(const char *id, void *ctx), void *ctx)
{
    fos_scene_store_result_t result;
    fos_scene_store_err_t err = fos_scene_store_apply(change, &result, on_dropped, ctx);
    if (err != FOS_SCENE_STORE_OK) return err;
    /* Emptying a file is a write for each of its pages: the caller's moment
     * after each, or 71 scenes dropped held its lock for a minute and a half
     * (the reTerminal Sticky, 2026-11-18). No index names these any more. */
    for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) {
        if (!has(&result.freed, slot)) continue;
        retire_slot(slot);
        if (s_hooks.between) s_hooks.between();
    }
    if (s_hooks.between) s_hooks.between();
    return FOS_SCENE_STORE_OK;
}

/* What an index entry may come to, written twice (the index and its copy):
 * the room a whole set written at once asks for beside its scenes. */
#define AT_ONCE_INDEX_ENTRY_BYTES 1536
/* How much of a scene is written between two of the caller's moments. */
#define AT_ONCE_PIECE_BYTES (16 * 1024)

/* The changed scenes of a set written to slot files no index names (the
 * stage calls), then the index switched to all of them in one change. The
 * caller's moment (`between`: its lock goes) comes after every piece written,
 * not only between two scenes: nothing the index names changes until the
 * last step, so a render reads its scene file all the while. Held from the
 * first scene to the index, the lock kept a reTerminal Sticky's render
 * waiting 33 s for a 524 KB set (2026-11-18). */
static fos_scene_store_err_t apply_set_at_once(const fos_scene_store_put_t *puts, const bool *changed, int count,
                                               const cJSON *order, const char *source,
                                               void (*on_dropped)(const char *id, void *ctx), void *ctx)
{
    unsigned int id = fos_scene_store_stage_open();
    if (id == 0) return FOS_SCENE_STORE_ERR_NO_MEMORY;
    fos_scene_store_err_t err = FOS_SCENE_STORE_OK;
    for (int i = 0; i < count && err == FOS_SCENE_STORE_OK; i++) {
        if (!changed[i]) continue;
        err = fos_scene_store_stage_begin(id);
        for (size_t at = 0; err == FOS_SCENE_STORE_OK && at < puts[i].len; at += AT_ONCE_PIECE_BYTES) {
            size_t piece = puts[i].len - at < AT_ONCE_PIECE_BYTES ? puts[i].len - at : AT_ONCE_PIECE_BYTES;
            err = fos_scene_store_stage_write(id, puts[i].json + at, piece);
            if (err == FOS_SCENE_STORE_OK && s_hooks.between) s_hooks.between();
        }
        if (err == FOS_SCENE_STORE_OK) err = fos_scene_store_stage_end(id, NULL);
    }
    if (err != FOS_SCENE_STORE_OK) {
        fos_scene_store_stage_drop(id);
        return err;
    }
    fos_scene_store_change_t all = {.staged = id, .order = order, .source = source};
    return apply_and_retire(&all, on_dropped, ctx);
}

/* The index's ids in its order, as an array; NULL out of memory. */
static cJSON *index_ids(const cJSON *index, const char *const *only, int only_count)
{
    cJSON *ids = cJSON_CreateArray();
    const cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, cJSON_GetObjectItem(index, "scenes")) {
        bool wanted = only == NULL;
        for (int i = 0; !wanted && i < only_count; i++) wanted = strcmp(only[i], entry_id(entry)) == 0;
        if (wanted && ids != NULL) cJSON_AddItemToArray(ids, cJSON_CreateString(entry_id(entry)));
    }
    return ids;
}

fos_scene_store_err_t fos_scene_store_apply_set(const fos_scene_store_put_t *puts, int count,
                                                const char *source, fos_scene_store_set_result_t *result,
                                                void (*on_dropped)(const char *id, void *ctx),
                                                void *ctx)
{
    memset(result, 0, sizeof(*result));
    if (count <= 0) return FOS_SCENE_STORE_ERR_LAST_SCENE;
    if (count > FOS_SCENE_STORE_SCENES) return FOS_SCENE_STORE_ERR_NO_SLOTS;
    cJSON *old = fos_scene_store_read_index();
    if (old == NULL) return FOS_SCENE_STORE_ERR_NOT_FOUND;
    const cJSON *old_scenes = cJSON_GetObjectItem(old, "scenes");

    /* The whole set checked first, nothing written: an id each, none twice,
     * one scene object per put. Which ones the set changes, by their hash. */
    char(*ids)[FOS_SCENE_STORE_ID_LEN] = calloc((size_t)count, FOS_SCENE_STORE_ID_LEN);
    const char **id_list = calloc((size_t)count, sizeof(*id_list));
    bool *changed = calloc((size_t)count, sizeof(*changed));
    cJSON *order = cJSON_CreateArray();
    fos_scene_store_err_t err =
        ids && id_list && changed && order ? FOS_SCENE_STORE_OK : FOS_SCENE_STORE_ERR_NO_MEMORY;
    for (int i = 0; i < count && err == FOS_SCENE_STORE_OK; i++) {
        const char *json = puts[i].json;
        size_t len = puts[i].len;
        const char *end = NULL;
        cJSON *scene = NULL;
        if (len <= FOS_SCENE_STORE_MAX_BYTES && fos_json_depth_ok(json, len, FOS_JSON_MAX_DEPTH)) {
            scene = cJSON_ParseWithLengthOpts(json, len, &end, false);
        }
        const char *id = entry_id(scene);
        bool ok = cJSON_IsObject(scene) && id[0] && strlen(id) < FOS_SCENE_STORE_ID_LEN;
        while (ok && end != NULL && end < json + len) ok = isspace((unsigned char)*end++);
        for (int j = 0; ok && j < i; j++) ok = strcmp(ids[j], id) != 0;
        if (ok) {
            snprintf(ids[i], FOS_SCENE_STORE_ID_LEN, "%s", id);
            id_list[i] = ids[i];
            const cJSON *stored = find_entry(old_scenes, id);
            changed[i] = stored == NULL || fos_scene_store_entry_slot(stored) < 0 ||
                         !entry_hash_is(stored, content_hash(json, len));
            cJSON_AddItemToArray(order, cJSON_CreateString(id));
        } else {
            err = FOS_SCENE_STORE_ERR_INVALID;
        }
        cJSON_Delete(scene);
    }

    /* What goes: the stored scenes the set does not name. First, so their
     * room is there for the new ones, unless the set keeps none of the old
     * (a frame keeps a scene): then after the first new one. */
    cJSON *keep = NULL;
    bool drops = false;
    if (err == FOS_SCENE_STORE_OK) {
        keep = index_ids(old, id_list, count);
        if (keep == NULL) err = FOS_SCENE_STORE_ERR_NO_MEMORY;
        result->dropped = cJSON_GetArraySize(old_scenes) - cJSON_GetArraySize(keep);
        drops = result->dropped > 0;
    }

    /* With room for every changed scene beside the set as it is: all of them
     * written, then the index once, order and source with them. Refused for
     * want of slots or room (nothing is changed then), it goes the long way. */
    int changes = 0;
    size_t change_bytes = 0;
    for (int i = 0; i < count && err == FOS_SCENE_STORE_OK; i++) {
        if (!changed[i]) continue;
        changes++;
        change_bytes += puts[i].len;
    }
    if (err == FOS_SCENE_STORE_OK && changes > 1 && s_hooks.has_room != NULL &&
        s_hooks.has_room(change_bytes + 2 * (size_t)count * AT_ONCE_INDEX_ENTRY_BYTES)) {
        fos_scene_store_err_t once = apply_set_at_once(puts, changed, count, order, source, on_dropped, ctx);
        if (once == FOS_SCENE_STORE_OK) {
            result->at_once = true;
            result->written = changes;
            result->written_bytes = change_bytes;
            result->scene_count = count;
            result->kept = count - changes;
            cJSON_Delete(keep);
            cJSON_Delete(order);
            free(changed);
            free(id_list);
            free(ids);
            cJSON_Delete(old);
            return FOS_SCENE_STORE_OK;
        }
        if (once != FOS_SCENE_STORE_ERR_NO_SLOTS && once != FOS_SCENE_STORE_ERR_NO_SPACE) err = once;
    }

    if (err == FOS_SCENE_STORE_OK && drops && cJSON_GetArraySize(keep) > 0) {
        fos_scene_store_change_t drop = {.order = keep};
        err = apply_and_retire(&drop, on_dropped, ctx);
        drops = false;
    }

    /* Each new or changed scene by itself: written, committed, and the file
     * it replaced emptied before the next. */
    for (int i = 0; i < count && err == FOS_SCENE_STORE_OK; i++) {
        if (!changed[i]) continue;
        fos_scene_store_change_t put = {.puts = &puts[i], .put_count = 1};
        err = apply_and_retire(&put, NULL, NULL);
        if (err != FOS_SCENE_STORE_OK) break;
        result->written++;
        result->written_bytes += puts[i].len;
        if (drops) {
            cJSON *only = cJSON_CreateArray();
            if (only == NULL) {
                err = FOS_SCENE_STORE_ERR_NO_MEMORY;
                break;
            }
            cJSON_AddItemToArray(only, cJSON_CreateString(ids[i]));
            fos_scene_store_change_t drop = {.order = only};
            err = apply_and_retire(&drop, on_dropped, ctx);
            cJSON_Delete(only);
            drops = false;
        }
    }

    /* Last the set's order and its source, unless both are as stored and
     * nothing changed: then nothing is written at all. */
    if (err == FOS_SCENE_STORE_OK) {
        cJSON *now = fos_scene_store_read_index();
        cJSON *now_ids = index_ids(now, NULL, 0);
        const cJSON *now_source = cJSON_GetObjectItem(now, "source");
        bool same_source = source == NULL ||
                           (cJSON_IsString(now_source) && strcmp(now_source->valuestring, source) == 0);
        bool same_order = now_ids != NULL && cJSON_Compare(now_ids, order, true);
        if (!same_order || !same_source) {
            fos_scene_store_change_t last = {.order = order, .source = source};
            err = apply_and_retire(&last, on_dropped, ctx);
        }
        cJSON_Delete(now_ids);
        cJSON_Delete(now);
    }
    if (err == FOS_SCENE_STORE_OK) {
        result->scene_count = count;
        result->kept = count - result->written;
    }
    cJSON_Delete(keep);
    cJSON_Delete(order);
    free(changed);
    free(id_list);
    free(ids);
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
        /* The hash was the refused file's: the next whole set writes it. */
        cJSON_DeleteItemFromObject(entry, "hash");
        err = write_index(index);
    }
    cJSON_Delete(index);
    return err;
}

void fos_scene_store_sweep(void)
{
    cJSON *index = fos_scene_store_read_index();
    if (cJSON_GetArraySize(cJSON_GetObjectItem(index, "scenes")) > 0) {
        fos_scene_store_slots_t named = {{0}};
        mark_slots(index, &named);
        /* Every file the index does not name is emptied for the next put: on
         * the first sweep what a crash left and the spares from before (the
         * listing does not say which are empty), after it the files a change
         * stopped naming. A set being read keeps the files it is written to. */
        learn_slot_files();
        if (s_old_slot_tmp || !s_slot_map_known) {
            /* Where firmware before 2026.11.6 wrote a slot first; a crash
             * there left up to a whole scene's bytes. */
            char tmp[PATH_LEN];
            path_of(FOS_SCENE_STORE_SLOT_TMP_NAME, tmp);
            remove(tmp);
            s_old_slot_tmp = false;
        }
        for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) {
            if (has(&named, slot)) {
                slot_is(slot, SLOT_FILE);
            } else if (has(&s_slot_staged, slot)) {
                continue;
            } else if (!s_slot_map_known) {
                remove_slot(slot); /* no listing: asked for by name */
            } else if (has(&s_slot_file, slot) && !has(&s_slot_spare, slot)) {
                retire_slot(slot); /* emptied, for the next put */
                /* The caller's moment: no index names this file, and a slot
                 * with a file that is not a spare is no put's to take, so
                 * what was named when the sweep began stays right. */
                if (s_hooks.between) s_hooks.between();
            }
        }
        s_slot_map_known = true;
    }
    cJSON_Delete(index);
}

bool fos_scene_store_recover_index(void)
{
    /* The index gone or torn and the copy whole: the copy is the change that
     * was made (write_index), and goes back in its place. */
    cJSON *index = parse_index_file(FOS_SCENE_STORE_INDEX_NAME);
    if (index != NULL) {
        cJSON_Delete(index);
        return false;
    }
    cJSON *copy = parse_index_file(FOS_SCENE_STORE_INDEX_TMP_NAME);
    if (copy == NULL) return false;
    cJSON_Delete(copy);
    char path[PATH_LEN];
    char tmp[PATH_LEN];
    path_of(FOS_SCENE_STORE_INDEX_NAME, path);
    path_of(FOS_SCENE_STORE_INDEX_TMP_NAME, tmp);
    remove(path);
    return rename(tmp, path) == 0;
}
