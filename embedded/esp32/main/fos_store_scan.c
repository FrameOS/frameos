/* See fos_store_scan.h. */
#include "fos_store_scan.h"

#include <stdlib.h>
#include <string.h>

int fos_store_split_scenes(const char *json, size_t len, const char **starts, size_t *lens, int max)
{
    int depth = 0, count = 0;
    bool in_string = false, escaped = false, opened = false;
    const char *start = NULL;
    for (size_t i = 0; json != NULL && i < len; i++) {
        char c = json[i];
        if (in_string) {
            if (escaped) escaped = false;
            else if (c == '\\') escaped = true;
            else if (c == '"') in_string = false;
        } else if (c == '"') {
            if (depth < 2) return -1; /* a string in the array itself */
            in_string = true;
        } else if (c == '{' || c == '[') {
            if (depth == 0 && (c != '[' || opened)) return -1;
            if (depth == 1 && c != '{') return -1;
            if (depth == 1) start = json + i;
            opened = true;
            depth++;
        } else if (c == '}' || c == ']') {
            if (depth == 0) return -1;
            depth--;
            if (depth == 1 && start != NULL) {
                if (count < max) {
                    starts[count] = start;
                    lens[count] = (size_t)(json + i + 1 - start);
                }
                count++;
                start = NULL;
            }
        } else if (depth == 1 && c != ',' && c != ' ' && c != '\n' && c != '\r' && c != '\t') {
            return -1; /* a number, a true, a null in the array itself */
        }
    }
    if (!opened || depth != 0 || in_string) return -1;
    return count < max ? count : max;
}

void fos_store_read_origin(const char *json, char *store, size_t store_len, int *version)
{
    const char *origin, *v;
    size_t origin_len, n;
    store[0] = '\0';
    *version = 0;
    /* The scene's own `origin`, then its own keys, in whatever order. */
    if (json == NULL || !fos_store_find_key(json, strlen(json), "origin", &origin, &origin_len)) return;
    if (!fos_store_find_key(origin, origin_len, "storeSceneId", &v, &n) || n < 2 || v[0] != '"' || n - 2 >= store_len)
        return; /* not a string, or longer than an id */
    memcpy(store, v + 1, n - 2);
    store[n - 2] = '\0';
    /* "version":"N", or a number. */
    if (fos_store_find_key(origin, origin_len, "version", &v, &n)) *version = atoi(v + (v[0] == '"'));
}

void fos_store_clear_default(char *scene, size_t len)
{
    static const char key[] = "\"default\"";
    int depth = 0;
    bool in_string = false, escaped = false;
    for (size_t i = 0; scene != NULL && i < len; i++) {
        char c = scene[i];
        if (in_string) {
            if (escaped) escaped = false;
            else if (c == '\\') escaped = true;
            else if (c == '"') in_string = false;
        } else if (c == '{' || c == '[') {
            depth++;
        } else if (c == '}' || c == ']') {
            depth--;
        } else if (c == '"') {
            /* A key of the scene object itself, followed by `: true`. */
            if (depth == 1 && i + sizeof(key) - 1 <= len && memcmp(scene + i, key, sizeof(key) - 1) == 0) {
                size_t j = i + sizeof(key) - 1;
                while (j < len && (scene[j] == ' ' || scene[j] == '\n' || scene[j] == '\r' || scene[j] == '\t')) j++;
                if (j < len && scene[j] == ':') {
                    j++;
                    while (j < len && (scene[j] == ' ' || scene[j] == '\n' || scene[j] == '\r' || scene[j] == '\t')) j++;
                    if (j + 4 <= len && memcmp(scene + j, "true", 4) == 0) memcpy(scene + j, "null", 4);
                }
            }
            in_string = true;
        }
    }
}

static bool blank(char c) { return c == ' ' || c == '\n' || c == '\r' || c == '\t'; }

bool fos_store_find_key(const char *json, size_t len, const char *key, const char **value, size_t *value_len)
{
    size_t key_len = strlen(key);
    int depth = 0;
    bool in_string = false, escaped = false, want_key = false, match = false, next = false;
    const char *found = NULL;
    for (size_t i = 0; json != NULL && i < len; i++) {
        char c = json[i];
        if (in_string) {
            if (escaped) escaped = false;
            else if (c == '\\') escaped = true;
            else if (c == '"') in_string = false;
            continue;
        }
        if (blank(c)) continue;
        if (next) {
            found = json + i;
            next = false;
        }
        if (found != NULL && depth == 1 && (c == ',' || c == '}')) {
            size_t n = (size_t)(json + i - found);
            while (n > 0 && blank(found[n - 1])) n--;
            *value = found;
            *value_len = n;
            return n > 0;
        }
        if (c == '"') {
            match = depth == 1 && want_key && i + key_len + 1 < len && memcmp(json + i + 1, key, key_len) == 0 &&
                    json[i + key_len + 1] == '"';
            in_string = true;
        } else if (c == '{' || c == '[') {
            if (depth == 0 && c != '{') return false;
            want_key = ++depth == 1;
        } else if (c == '}' || c == ']') {
            if (--depth <= 0) return false;
        } else if (depth == 1 && c == ':') {
            want_key = false;
            next = match;
        } else if (depth == 1 && c == ',') {
            want_key = true;
            match = false;
        } else if (depth == 0) {
            return false;
        }
    }
    return false;
}
