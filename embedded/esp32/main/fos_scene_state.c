/* Scene state across deep sleep: one small JSON file per scene. See the
 * header. No IDF calls here — the host test compiles this with a laptop cc. */
#include "fos_scene_state.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FOS_SCENE_STATE_DIR_MAX 64
/* Scenes whose state may wait at once. A walk through the scenes leaves one
 * behind per scene with state, and with four a fifth wrote the oldest on the
 * render task: 0.7 s of SPIFFS in every scene switch on the reTerminal E1003
 * (`persist` in the render line, 2026-11-10). Past half of these the writer
 * task writes them all (fos_scene_state_crowded); a full table still writes
 * the oldest first. */
#define FOS_SCENE_STATE_PENDING_MAX 16
#define FOS_SCENE_STATE_ID_MAX 64

static char s_dir[FOS_SCENE_STATE_DIR_MAX] = "/state";

typedef struct {
    bool used;
    char id[FOS_SCENE_STATE_ID_MAX];
    char *json; /* NULL: the file goes */
    uint32_t since_ms;
} pending_t;

static fos_scene_state_write_behind_t s_behind = {0};
static pending_t s_pending[FOS_SCENE_STATE_PENDING_MAX];
/* The change a flush is writing, taken out of s_pending: the file write runs
 * without the lock (a write is seconds of SPIFFS on a full partition, and a
 * render that saves or loads state must not wait for it), so a load finds
 * the state here until the file has it. `forgotten`: the scene's state was
 * forgotten meanwhile, and the file goes again once written. */
static pending_t s_inflight;
static bool s_inflight_forgotten = false;

static void lock(void)
{
    if (s_behind.lock) s_behind.lock();
}

static void unlock(void)
{
    if (s_behind.unlock) s_behind.unlock();
}

void fos_scene_state_set_dir(const char *dir)
{
    if (dir == NULL || dir[0] == '\0') return;
    snprintf(s_dir, sizeof(s_dir), "%s", dir);
    size_t len = strlen(s_dir);
    while (len > 1 && s_dir[len - 1] == '/') s_dir[--len] = '\0';
}

static uint32_t fnv1a32(const char *text)
{
    uint32_t hash = 2166136261u;
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        hash ^= *p;
        hash *= 16777619u;
    }
    return hash;
}

/* Scenes known to have no state file. Opening a SPIFFS file that is not there
 * walks the whole partition (0.7 s on the reTerminal E1003's 24 MB), and a
 * scene without state asked for it on every switch. This store writes every
 * one of these files, so what it saw missing stays missing until it writes it.
 * Under the lock. */
#define FOS_SCENE_STATE_ABSENT_MAX 64
static uint32_t s_absent[FOS_SCENE_STATE_ABSENT_MAX];
static int s_absent_count = 0;

static int absent_index(uint32_t hash)
{
    for (int i = 0; i < s_absent_count; i++) {
        if (s_absent[i] == hash) return i;
    }
    return -1;
}

static void note_absent(const char *scene_id, bool absent)
{
    uint32_t hash = fnv1a32(scene_id);
    int i = absent_index(hash);
    if (absent && i < 0) {
        if (s_absent_count == FOS_SCENE_STATE_ABSENT_MAX) {
            /* Full: the oldest goes, and is opened again next time. */
            memmove(s_absent, s_absent + 1, sizeof(s_absent[0]) * (FOS_SCENE_STATE_ABSENT_MAX - 1));
            s_absent_count--;
        }
        s_absent[s_absent_count++] = hash;
    } else if (!absent && i >= 0) {
        s_absent[i] = s_absent[--s_absent_count];
    }
}

bool fos_scene_state_path(const char *scene_id, char *out, size_t out_len)
{
    if (scene_id == NULL || scene_id[0] == '\0' || out == NULL || out_len == 0) return false;
    /* The id is written into the file (OWNER_KEY): one with a control
     * character in it keeps no state. */
    for (const unsigned char *p = (const unsigned char *)scene_id; *p; p++) {
        if (*p < 0x20) return false;
    }
    int n = snprintf(out, out_len, "%s/st-%08lx.json", s_dir, (unsigned long)fnv1a32(scene_id));
    return n > 0 && (size_t)n < out_len;
}

/* A file's first member names the scene whose state it is:
 * {"__owner":"<id>", ...the state...}. The name is 32 bits of hash, and two
 * ids that share one are easy to make on purpose: without it, a scene given
 * such an id read the state another scene had kept (its public fields, its
 * persist:"disk" ones). Inside the object, not in front of it, so firmware
 * from before reads the file as it always did (one key more, which no scene
 * declares). A file without it is from before (`legacy`). */
#define OWNER_KEY "{\"__owner\":\""

/* The id as the owner member writes it: `"` and `\` escaped, nothing else to
 * escape (fos_scene_state_path refuses control characters). */
static bool owner_matches(const char *text, size_t len, const char *scene_id, size_t *member_len)
{
    size_t at = strlen(OWNER_KEY);
    for (const char *p = scene_id; *p; p++) {
        if (*p == '"' || *p == '\\') {
            if (at >= len || text[at] != '\\') return false;
            at++;
        }
        if (at >= len || text[at] != *p) return false;
        at++;
    }
    if (at + 1 >= len || text[at] != '"' || text[at + 1] != ',') return false;
    *member_len = at + 2;
    return true;
}

static char *read_file(const char *scene_id, bool *legacy)
{
    char path[FOS_SCENE_STATE_DIR_MAX + 32];
    *legacy = false;
    if (!fos_scene_state_path(scene_id, path, sizeof(path))) return NULL;
    if (absent_index(fnv1a32(scene_id)) >= 0) return NULL;
    FILE *f = fopen(path, "rb");
    if (f == NULL) {
        note_absent(scene_id, true);
        return NULL;
    }
    /* The owner member, then the state. */
    size_t most = FOS_SCENE_STATE_MAX_BYTES + strlen(OWNER_KEY) + 2 * strlen(scene_id) + 2;
    char *buf = malloc(most + 2);
    if (buf == NULL) {
        fclose(f);
        return NULL;
    }
    size_t total = 0;
    while (total < most + 1) {
        size_t r = fread(buf + total, 1, most + 1 - total, f);
        if (r == 0) break;
        total += r;
    }
    fclose(f);
    size_t key_len = strlen(OWNER_KEY);
    if (total >= key_len && memcmp(buf, OWNER_KEY, key_len) == 0) {
        size_t member_len = 0;
        if (!owner_matches(buf, total, scene_id, &member_len)) {
            /* Another scene's file under this scene's hash: not this one's state. */
            free(buf);
            return NULL;
        }
        /* "{" and what follows the owner member. */
        memmove(buf + 1, buf + member_len, total - member_len);
        total -= member_len - 1;
    } else {
        *legacy = true;
    }
    if (total == 0 || total > FOS_SCENE_STATE_MAX_BYTES) {
        /* Empty or over the cap: not state we vouch for. */
        free(buf);
        return NULL;
    }
    buf[total] = '\0';
    char *shrunk = realloc(buf, total + 1);
    return shrunk ? shrunk : buf;
}

static bool json_is_empty_object(const char *json)
{
    if (json == NULL) return true;
    while (*json == ' ' || *json == '\n' || *json == '\r' || *json == '\t') json++;
    if (*json == '\0') return true;
    if (*json != '{') return false;
    json++;
    while (*json == ' ' || *json == '\n' || *json == '\r' || *json == '\t') json++;
    if (*json != '}') return false;
    json++;
    while (*json == ' ' || *json == '\n' || *json == '\r' || *json == '\t') json++;
    return *json == '\0';
}

/* What a write left of the scene's file. */
typedef enum {
    FILE_KEPT = -1,   /* nothing was done: whatever was there still is */
    FILE_GONE = 0,    /* there is none now */
    FILE_WRITTEN = 1, /* it holds the state */
} file_result_t;

/* Every call that names a file is a walk of the partition's lookup pages on
 * SPIFFS, to the file or, for a name that is not there, to the end: 0.5 s on
 * a 24 MB /state, flash reads back to back, each with the cache off on both
 * cores. So the fewest names: the file is written where it is, in one open,
 * and nothing is removed that this store knows is not there (`known_absent`:
 * the absent list, read under the lock by the caller). Through a temporary
 * file it was six names a write (the open, a rename SPIFFS refuses while the
 * target exists, the remove, the rename again), 3 s of a reTerminal Sticky
 * running at a fraction of its speed, and a remove for every scene without
 * state a minute after it was shown (the bench, 2026-11-18: a render of
 * 0.5 s took 3.5 s and its lines reached the console 5 s late). A power cut
 * during the write leaves a short file, which is no state (the reader takes
 * an object or nothing); the temporary file had the same gap between its
 * remove and its rename. */
static file_result_t write_file(const char *scene_id, const char *json, bool known_absent)
{
    char path[FOS_SCENE_STATE_DIR_MAX + 32];
    if (!fos_scene_state_path(scene_id, path, sizeof(path))) return FILE_KEPT;
    if (json_is_empty_object(json)) {
        if (!known_absent) remove(path);
        return FILE_GONE;
    }
    size_t len = strlen(json);
    if (len > FOS_SCENE_STATE_MAX_BYTES) return FILE_KEPT;
    /* An object with members (an empty one is no file, above): the owner
     * goes in as its first. Anything else is no state. */
    const char *members = json;
    while (*members == ' ' || *members == '\n' || *members == '\r' || *members == '\t') members++;
    if (*members != '{') return FILE_KEPT;
    members++;
    size_t members_len = len - (size_t)(members - json);
    FILE *f = fopen(path, "wb");
    if (f == NULL) return FILE_KEPT;
    bool ok = fputs(OWNER_KEY, f) >= 0;
    for (const char *p = scene_id; ok && *p; p++) {
        if ((*p == '"' || *p == '\\') && fputc('\\', f) == EOF) ok = false;
        if (ok && fputc(*p, f) == EOF) ok = false;
    }
    ok = ok && fputs("\",", f) >= 0 && fwrite(members, 1, members_len, f) == members_len;
    if (fclose(f) != 0) ok = false;
    if (!ok) {
        remove(path);
        return FILE_GONE;
    }
    return FILE_WRITTEN;
}

static bool known_absent(const char *scene_id)
{
    return absent_index(fnv1a32(scene_id)) >= 0;
}

/* Writes now, under the lock, and keeps the absent list true. True when the
 * file is what was asked for. */
static bool write_now(const char *scene_id, const char *json)
{
    file_result_t result = write_file(scene_id, json, known_absent(scene_id));
    if (result != FILE_KEPT) note_absent(scene_id, result == FILE_GONE);
    return result == FILE_WRITTEN || (result == FILE_GONE && json_is_empty_object(json));
}

static char *copy_text(const char *text)
{
    size_t len = strlen(text) + 1;
    char *copy = malloc(len);
    if (copy != NULL) memcpy(copy, text, len);
    return copy;
}

static pending_t *find_pending(const char *scene_id)
{
    for (int i = 0; i < FOS_SCENE_STATE_PENDING_MAX; i++) {
        if (s_pending[i].used && strcmp(s_pending[i].id, scene_id) == 0) return &s_pending[i];
    }
    return NULL;
}

static void drop_pending(pending_t *entry)
{
    free(entry->json);
    memset(entry, 0, sizeof(*entry));
}

static void write_pending(pending_t *entry)
{
    /* A write that fails is not retried: the next change queues it again,
     * the same as a failed write-through. */
    write_now(entry->id, entry->json);
    drop_pending(entry);
}

char *fos_scene_state_load(const char *scene_id)
{
    if (scene_id == NULL || scene_id[0] == '\0') return NULL;
    lock();
    char *result = NULL;
    pending_t *entry = find_pending(scene_id);
    if (entry == NULL && s_inflight.used && strcmp(s_inflight.id, scene_id) == 0) entry = &s_inflight;
    bool legacy = false;
    if (entry != NULL) {
        result = entry->json ? copy_text(entry->json) : NULL;
    } else {
        result = read_file(scene_id, &legacy);
    }
    unlock();
    /* A file from before the owner line belongs to the scene that reads it
     * first: written again with the line, so no other id that shares its
     * hash is given it later. */
    if (legacy && result != NULL) fos_scene_state_save(scene_id, result);
    return result;
}

bool fos_scene_state_save(const char *scene_id, const char *json)
{
    if (scene_id == NULL || scene_id[0] == '\0') return false;
    bool empty = json_is_empty_object(json);
    if (!empty && strlen(json) > FOS_SCENE_STATE_MAX_BYTES) return false;
    lock();
    bool ok;
    if (empty && known_absent(scene_id) && find_pending(scene_id) == NULL &&
        !(s_inflight.used && strcmp(s_inflight.id, scene_id) == 0)) {
        /* Nothing to keep, nothing waiting and no file: a scene without state
         * says so every time it is shown. */
        unlock();
        return true;
    }
    if (s_behind.delay_ms == 0 || s_behind.now_ms == NULL ||
        strlen(scene_id) >= FOS_SCENE_STATE_ID_MAX) {
        pending_t *stale = find_pending(scene_id);
        if (stale != NULL) drop_pending(stale);
        ok = write_now(scene_id, json);
        unlock();
        return ok;
    }
    char *copy = NULL;
    if (!empty) {
        copy = copy_text(json);
        if (copy == NULL) {
            /* No memory to hold it: write it now instead. */
            pending_t *stale = find_pending(scene_id);
            if (stale != NULL) drop_pending(stale);
            ok = write_now(scene_id, json);
            unlock();
            return ok;
        }
    }
    pending_t *entry = find_pending(scene_id);
    if (entry != NULL) {
        /* `since_ms` stays: a scene that changes every few seconds is still
         * written once per delay, not never. */
        free(entry->json);
        entry->json = copy;
    } else {
        for (int i = 0; i < FOS_SCENE_STATE_PENDING_MAX && entry == NULL; i++) {
            if (!s_pending[i].used) entry = &s_pending[i];
        }
        if (entry == NULL) {
            pending_t *oldest = &s_pending[0];
            uint32_t now = s_behind.now_ms();
            for (int i = 1; i < FOS_SCENE_STATE_PENDING_MAX; i++) {
                if (now - s_pending[i].since_ms > now - oldest->since_ms) oldest = &s_pending[i];
            }
            write_pending(oldest);
            entry = oldest;
        }
        entry->used = true;
        snprintf(entry->id, sizeof(entry->id), "%s", scene_id);
        entry->json = copy;
        entry->since_ms = s_behind.now_ms();
    }
    unlock();
    return true;
}

void fos_scene_state_set_write_behind(const fos_scene_state_write_behind_t *config)
{
    fos_scene_state_flush(true);
    lock();
    if (config != NULL) {
        s_behind = *config;
    } else {
        memset(&s_behind, 0, sizeof(s_behind));
    }
    unlock();
}

void fos_scene_state_flush(bool all)
{
    /* One flusher at a time (the background task's, a deep sleep's): each
     * takes one due change out under the lock and writes it without it. */
    if (s_behind.flush_lock) s_behind.flush_lock();
    for (;;) {
        lock();
        uint32_t now = s_behind.now_ms ? s_behind.now_ms() : 0;
        pending_t *due = NULL;
        for (int i = 0; i < FOS_SCENE_STATE_PENDING_MAX && due == NULL; i++) {
            if (!s_pending[i].used) continue;
            if (all || s_behind.now_ms == NULL || now - s_pending[i].since_ms >= s_behind.delay_ms) {
                due = &s_pending[i];
            }
        }
        if (due == NULL) {
            unlock();
            break;
        }
        s_inflight = *due;
        s_inflight_forgotten = false;
        memset(due, 0, sizeof(*due));
        bool absent = known_absent(s_inflight.id);
        unlock();
        /* A write that fails is not retried: the next change queues it again. */
        file_result_t result = write_file(s_inflight.id, s_inflight.json, absent);
        lock();
        if (s_inflight_forgotten && result != FILE_GONE) {
            char path[FOS_SCENE_STATE_DIR_MAX + 32];
            if (fos_scene_state_path(s_inflight.id, path, sizeof(path))) remove(path);
            result = FILE_GONE;
        }
        if (result != FILE_KEPT) note_absent(s_inflight.id, result == FILE_GONE);
        free(s_inflight.json);
        memset(&s_inflight, 0, sizeof(s_inflight));
        s_inflight_forgotten = false;
        unlock();
    }
    if (s_behind.flush_unlock) s_behind.flush_unlock();
}

bool fos_scene_state_crowded(void)
{
    lock();
    int used = 0;
    for (int i = 0; i < FOS_SCENE_STATE_PENDING_MAX; i++) used += s_pending[i].used ? 1 : 0;
    unlock();
    return used * 2 >= FOS_SCENE_STATE_PENDING_MAX;
}

bool fos_scene_state_pending(void)
{
    lock();
    bool any = s_inflight.used;
    for (int i = 0; i < FOS_SCENE_STATE_PENDING_MAX && !any; i++) any = s_pending[i].used;
    unlock();
    return any;
}

void fos_scene_state_forget(const char *scene_id)
{
    char path[FOS_SCENE_STATE_DIR_MAX + 32];
    if (scene_id == NULL || scene_id[0] == '\0') return;
    lock();
    pending_t *entry = find_pending(scene_id);
    if (entry != NULL) drop_pending(entry);
    if (s_inflight.used && strcmp(s_inflight.id, scene_id) == 0) s_inflight_forgotten = true;
    if (!known_absent(scene_id) && fos_scene_state_path(scene_id, path, sizeof(path))) remove(path);
    note_absent(scene_id, true);
    unlock();
}
