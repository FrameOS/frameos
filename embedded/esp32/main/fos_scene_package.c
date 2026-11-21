/* See fos_scene_package.h. cJSON, and the ROM's inflater (tinfl, as a FOSB
 * version 2 picture uses it) for a deflated member; the host test builds
 * with FOS_SCENE_PACKAGE_NO_INFLATE and stored members. */
#include "fos_scene_package.h"

#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#ifndef FOS_SCENE_PACKAGE_NO_INFLATE
#include "miniz.h"
#endif

#define APPS_PREFIX "apps/"
#define SCENE_NAME "scene.json"

static uint32_t le(const char *p, int bytes)
{
    uint32_t value = 0;
    for (int i = bytes - 1; i >= 0; i--) value = (value << 8) | (uint8_t)p[i];
    return value;
}

bool fos_scene_package_is(const char *bytes, size_t len)
{
    return bytes != NULL && len >= 4 && memcmp(bytes, "PK\x03\x04", 4) == 0;
}

const char *fos_scene_package_scene_json(const char *bytes, size_t len, size_t *json_len)
{
    if (!fos_scene_package_is(bytes, len) || len < 30) return NULL;
    uint32_t size = le(bytes + 22, 4);
    uint32_t name_len = le(bytes + 26, 2);
    size_t start = 30u + name_len + le(bytes + 28, 2);
    /* Stored (method 0), no encryption or data descriptor (flags 0 and 3). */
    if (le(bytes + 8, 2) != 0 || (le(bytes + 6, 2) & 0x0009u) != 0 || le(bytes + 18, 4) != size ||
        name_len != sizeof(SCENE_NAME) - 1 || memcmp(bytes + 30, SCENE_NAME, name_len) != 0 || start > len ||
        size > len - start) {
        return NULL;
    }
    *json_len = size;
    return bytes + start;
}

/* A member's bytes as they are, malloc'd and NUL ended; NULL for a member
 * this reader cannot take. */
static char *member_bytes(const char *bytes, size_t len, size_t local, uint32_t method, uint32_t packed, uint32_t size)
{
    if (local > len || len - local < 30 || le(bytes + local, 4) != 0x04034b50u) return NULL;
    size_t start = local + 30 + le(bytes + local + 26, 2) + le(bytes + local + 28, 2);
    if (start > len || packed > len - start || size > 4u * 1024u * 1024u) return NULL;
    char *out = malloc((size_t)size + 1);
    if (out == NULL) return NULL;
    out[size] = '\0';
    if (method == 0 && packed == size) {
        memcpy(out, bytes + start, size);
        return out;
    }
#ifndef FOS_SCENE_PACKAGE_NO_INFLATE
    if (method == 8) {
        tinfl_decompressor *inflater = malloc(sizeof(*inflater));
        bool ok = false;
        if (inflater != NULL) {
            tinfl_init(inflater);
            size_t in = packed, made = size;
            tinfl_status status = tinfl_decompress(inflater, (const mz_uint8 *)bytes + start, &in, (mz_uint8 *)out,
                                                   (mz_uint8 *)out, &made, TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
            ok = status == TINFL_STATUS_DONE && made == size;
            free(inflater);
        }
        if (ok) return out;
    }
#endif
    free(out);
    return NULL;
}

/* `apps/<keyword>/<file>`'s keyword, %2F and %25 taken back, into `out`. */
static bool keyword_of(const char *folder, size_t folder_len, char *out, size_t out_len)
{
    size_t at = 0;
    for (size_t i = 0; i < folder_len; i++) {
        char c = folder[i];
        if (c == '%' && i + 2 < folder_len && folder[i + 1] == '2' && (folder[i + 2] == 'F' || folder[i + 2] == 'f')) {
            c = '/';
            i += 2;
        } else if (c == '%' && i + 2 < folder_len && folder[i + 1] == '2' && folder[i + 2] == '5') {
            i += 2;
        }
        if (at + 1 >= out_len) return false;
        out[at++] = c;
    }
    out[at] = '\0';
    return at > 0;
}

char *fos_scene_package_to_json(const char *bytes, size_t len, size_t *out_len)
{
    size_t scene_len = 0;
    const char *scene_text = fos_scene_package_scene_json(bytes, len, &scene_len);
    if (scene_text == NULL || len < 22) return NULL;
    /* The end record, then the central directory it points at. */
    size_t eocd = len - 22;
    while (eocd > 0 && le(bytes + eocd, 4) != 0x06054b50u) eocd--;
    if (le(bytes + eocd, 4) != 0x06054b50u) return NULL;
    uint32_t count = le(bytes + eocd + 10, 2);
    size_t at = le(bytes + eocd + 16, 4);
    cJSON *scene = cJSON_ParseWithLength(scene_text, scene_len);
    if (!cJSON_IsObject(scene)) {
        cJSON_Delete(scene);
        return NULL;
    }
    bool ok = true;
    for (uint32_t i = 0; i < count && ok; i++) {
        if (at > len || len - at < 46 || le(bytes + at, 4) != 0x02014b50u) {
            ok = false;
            break;
        }
        uint32_t method = le(bytes + at + 10, 2);
        uint32_t packed = le(bytes + at + 20, 4);
        uint32_t size = le(bytes + at + 24, 4);
        size_t name_len = le(bytes + at + 28, 2);
        size_t skip = 46 + name_len + le(bytes + at + 30, 2) + le(bytes + at + 32, 2);
        size_t local = le(bytes + at + 42, 4);
        const char *name = bytes + at + 46;
        if (name_len > len - at - 46) {
            ok = false;
            break;
        }
        at += skip;
        const size_t prefix = sizeof(APPS_PREFIX) - 1;
        const char *slash = name_len > prefix ? memchr(name + prefix, '/', name_len - prefix) : NULL;
        if (name_len <= prefix || memcmp(name, APPS_PREFIX, prefix) != 0 || slash == NULL ||
            slash == name + prefix || slash == name + name_len - 1) {
            continue; /* scene.json, assets/, a folder */
        }
        char keyword[128];
        char file[160];
        size_t file_len = (size_t)(name + name_len - slash - 1);
        if (!keyword_of(name + prefix, (size_t)(slash - name - prefix), keyword, sizeof(keyword)) ||
            file_len >= sizeof(file)) {
            ok = false;
            break;
        }
        memcpy(file, slash + 1, file_len);
        file[file_len] = '\0';
        char *text = member_bytes(bytes, len, local, method, packed, size);
        if (text == NULL) {
            ok = false;
            break;
        }
        cJSON *apps = cJSON_GetObjectItemCaseSensitive(scene, "apps");
        if (!cJSON_IsObject(apps)) {
            cJSON_DeleteItemFromObjectCaseSensitive(scene, "apps");
            apps = cJSON_AddObjectToObject(scene, "apps");
        }
        cJSON *app = cJSON_GetObjectItemCaseSensitive(apps, keyword);
        if (!cJSON_IsObject(app)) {
            cJSON_DeleteItemFromObjectCaseSensitive(apps, keyword);
            app = cJSON_AddObjectToObject(apps, keyword);
        }
        cJSON *sources = cJSON_GetObjectItemCaseSensitive(app, "sources");
        if (!cJSON_IsObject(sources)) {
            cJSON_DeleteItemFromObjectCaseSensitive(app, "sources");
            sources = cJSON_AddObjectToObject(app, "sources");
        }
        cJSON_DeleteItemFromObjectCaseSensitive(sources, file);
        ok = apps != NULL && app != NULL && sources != NULL && cJSON_AddStringToObject(sources, file, text) != NULL;
        free(text);
    }
    char *json = ok ? cJSON_PrintUnformatted(scene) : NULL;
    cJSON_Delete(scene);
    if (json != NULL && out_len != NULL) *out_len = strlen(json);
    return json;
}
