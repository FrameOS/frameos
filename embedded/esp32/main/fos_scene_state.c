/* Scene state across deep sleep: one small JSON file per scene. See the
 * header. No IDF calls here — the host test compiles this with a laptop cc. */
#include "fos_scene_state.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FOS_SCENE_STATE_DIR_MAX 64

static char s_dir[FOS_SCENE_STATE_DIR_MAX] = "/state";

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

bool fos_scene_state_path(const char *scene_id, char *out, size_t out_len)
{
    if (scene_id == NULL || scene_id[0] == '\0' || out == NULL || out_len == 0) return false;
    int n = snprintf(out, out_len, "%s/st-%08lx.json", s_dir, (unsigned long)fnv1a32(scene_id));
    return n > 0 && (size_t)n < out_len;
}

static bool temp_path(const char *scene_id, char *out, size_t out_len)
{
    if (scene_id == NULL || scene_id[0] == '\0' || out == NULL || out_len == 0) return false;
    int n = snprintf(out, out_len, "%s/st-%08lx.tmp", s_dir, (unsigned long)fnv1a32(scene_id));
    return n > 0 && (size_t)n < out_len;
}

char *fos_scene_state_load(const char *scene_id)
{
    char path[FOS_SCENE_STATE_DIR_MAX + 32];
    if (!fos_scene_state_path(scene_id, path, sizeof(path))) return NULL;
    FILE *f = fopen(path, "rb");
    if (f == NULL) return NULL;
    char *buf = malloc(FOS_SCENE_STATE_MAX_BYTES + 1);
    if (buf == NULL) {
        fclose(f);
        return NULL;
    }
    size_t total = 0;
    while (total < FOS_SCENE_STATE_MAX_BYTES + 1) {
        size_t r = fread(buf + total, 1, FOS_SCENE_STATE_MAX_BYTES + 1 - total, f);
        if (r == 0) break;
        total += r;
    }
    fclose(f);
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

bool fos_scene_state_save(const char *scene_id, const char *json)
{
    char path[FOS_SCENE_STATE_DIR_MAX + 32];
    char tmp[FOS_SCENE_STATE_DIR_MAX + 32];
    if (!fos_scene_state_path(scene_id, path, sizeof(path)) || !temp_path(scene_id, tmp, sizeof(tmp))) {
        return false;
    }
    if (json_is_empty_object(json)) {
        remove(path);
        return true;
    }
    size_t len = strlen(json);
    if (len > FOS_SCENE_STATE_MAX_BYTES) return false;
    FILE *f = fopen(tmp, "wb");
    if (f == NULL) return false;
    bool ok = fwrite(json, 1, len, f) == len;
    if (fclose(f) != 0) ok = false;
    if (!ok) {
        remove(tmp);
        return false;
    }
    if (rename(tmp, path) != 0) {
        /* SPIFFS rename refuses an existing target on some IDF versions. */
        remove(path);
        if (rename(tmp, path) != 0) {
            remove(tmp);
            return false;
        }
    }
    return true;
}

void fos_scene_state_forget(const char *scene_id)
{
    char path[FOS_SCENE_STATE_DIR_MAX + 32];
    if (fos_scene_state_path(scene_id, path, sizeof(path))) remove(path);
}
