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

static bool json_space(char c)
{
    return c == ' ' || c == '\n' || c == '\r' || c == '\t';
}

/* One past the end of the JSON value starting at `i`; 0 when it is cut short
 * or is not a value. */
static size_t json_value_end(const char *json, size_t len, size_t i)
{
    if (i >= len) return 0;
    char c = json[i];
    if (c == '"') {
        bool escaped = false;
        for (size_t j = i + 1; j < len; j++) {
            if (escaped) escaped = false;
            else if (json[j] == '\\') escaped = true;
            else if (json[j] == '"') return j + 1;
        }
        return 0;
    }
    if (c == '{' || c == '[') {
        int depth = 0;
        bool in_string = false, escaped = false;
        for (size_t j = i; j < len; j++) {
            char d = json[j];
            if (in_string) {
                if (escaped) escaped = false;
                else if (d == '\\') escaped = true;
                else if (d == '"') in_string = false;
            } else if (d == '"') {
                in_string = true;
            } else if (d == '{' || d == '[') {
                depth++;
            } else if (d == '}' || d == ']') {
                if (--depth == 0) return j + 1;
            }
        }
        return 0;
    }
    /* A number, true, false or null: up to the next delimiter, which an
     * object's value always has after it. */
    size_t j = i;
    while (j < len && json[j] != ',' && json[j] != '}' && json[j] != ']' && !json_space(json[j])) j++;
    return j > i && j < len ? j : 0;
}

bool fos_store_object_member(const char *json, size_t len, const char *key, const char **value,
                             size_t *value_len)
{
    if (json == NULL || key == NULL) return false;
    size_t key_len = strlen(key);
    size_t i = 0;
    while (i < len && json_space(json[i])) i++;
    if (i >= len || json[i] != '{') return false;
    i++;
    for (;;) {
        while (i < len && json_space(json[i])) i++;
        if (i >= len || json[i] != '"') return false; /* the closing brace: not there */
        size_t key_end = json_value_end(json, len, i);
        if (key_end == 0) return false;
        bool match = key_end - i - 2 == key_len && memcmp(json + i + 1, key, key_len) == 0;
        i = key_end;
        while (i < len && json_space(json[i])) i++;
        if (i >= len || json[i] != ':') return false;
        i++;
        while (i < len && json_space(json[i])) i++;
        size_t end = json_value_end(json, len, i);
        if (end == 0) return false;
        if (match) {
            *value = json + i;
            *value_len = end - i;
            return true;
        }
        i = end;
        while (i < len && json_space(json[i])) i++;
        if (i >= len || json[i] != ',') return false;
        i++;
    }
}

void fos_store_read_origin(const char *json, char *store, size_t store_len, int *version)
{
    static const char key[] = "\"storeSceneId\":\"";
    store[0] = '\0';
    *version = 0;
    const char *at = json != NULL ? strstr(json, key) : NULL;
    if (at == NULL) return;
    at += sizeof(key) - 1;
    size_t n = 0;
    while (at[n] && at[n] != '"' && n + 1 < store_len) n++;
    if (at[n] != '"') return; /* longer than an id, or cut off */
    memcpy(store, at, n);
    store[n] = '\0';
    /* The stamp's next key: "version":"N". */
    const char *next = at + n + 1;
    if (strncmp(next, ",\"version\":\"", 12) == 0) *version = atoi(next + 12);
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
