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
