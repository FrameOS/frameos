/* Host test of fos_scene_package.c: a scene package's scene whole again, as
 * the readers of a scene's JSON get it (docs/scene-packages.md). Stored
 * members only: the inflater is the ROM's.
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -DFOS_SCENE_PACKAGE_NO_INFLATE -Imain \
 *      -I$IDF_PATH/components/json/cJSON $IDF_PATH/components/json/cJSON/cJSON.c \
 *      main/fos_scene_package.c main/tests/test_fos_scene_package.c -lm -o t && ./t
 */
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "fos_scene_package.h"

static int checks = 0;
static int failures = 0;

#define CHECK(cond)                                                              \
    do {                                                                         \
        checks++;                                                                \
        if (!(cond)) {                                                           \
            failures++;                                                          \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);               \
        }                                                                        \
    } while (0)

/* A ZIP of stored members, as a plane writes a scene package (CRCs left 0:
 * nothing on a frame checks them). */
static char *stored_zip(const char *const *names, const char *const *datas, int count, size_t *out_len)
{
    size_t cap = 256;
    for (int i = 0; i < count; i++) cap += 2 * (46 + strlen(names[i])) + strlen(datas[i]);
    unsigned char *z = calloc(1, cap);
    size_t at = 0, central = 0, offsets[16];
    for (int i = 0; i < count; i++) {
        size_t n = strlen(names[i]), d = strlen(datas[i]);
        offsets[i] = at;
        unsigned char h[30] = {0x50, 0x4b, 3, 4, 20};
        h[18] = h[22] = (unsigned char)(d & 0xff); h[19] = h[23] = (unsigned char)(d >> 8);
        h[26] = (unsigned char)n;
        memcpy(z + at, h, 30); at += 30;
        memcpy(z + at, names[i], n); at += n;
        memcpy(z + at, datas[i], d); at += d;
    }
    central = at;
    for (int i = 0; i < count; i++) {
        size_t n = strlen(names[i]), d = strlen(datas[i]);
        unsigned char h[46] = {0x50, 0x4b, 1, 2, 20, 0, 20};
        h[20] = h[24] = (unsigned char)(d & 0xff); h[21] = h[25] = (unsigned char)(d >> 8);
        h[28] = (unsigned char)n;
        h[42] = (unsigned char)(offsets[i] & 0xff); h[43] = (unsigned char)(offsets[i] >> 8);
        memcpy(z + at, h, 46); at += 46;
        memcpy(z + at, names[i], n); at += n;
    }
    unsigned char e[22] = {0x50, 0x4b, 5, 6};
    e[8] = e[10] = (unsigned char)count;
    e[12] = (unsigned char)((at - central) & 0xff); e[13] = (unsigned char)((at - central) >> 8);
    e[16] = (unsigned char)(central & 0xff); e[17] = (unsigned char)(central >> 8);
    memcpy(z + at, e, 22); at += 22;
    *out_len = at;
    return (char *)z;
}

static const char *source_of(const cJSON *scene, const char *keyword, const char *file)
{
    const cJSON *text = cJSON_GetObjectItemCaseSensitive(
        cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(
            cJSON_GetObjectItemCaseSensitive(scene, "apps"), keyword), "sources"), file);
    return cJSON_IsString(text) ? text->valuestring : NULL;
}

int main(void)
{
    const char *names[] = {"scene.json", "apps/clock/app.ts", "apps/clock/lib/a.ts", "apps/data%2Fimmich/app.js",
                           "assets/logo.svg"};
    const char *datas[] = {"{\"id\":\"p\",\"name\":\"P\",\"apps\":{\"clock\":{\"name\":\"Clock\"}}}",
                           "export const a = \"\\u00e9\"\n", "export const b = 2\n", "export const c = 3\n", "<svg/>"};
    size_t len = 0;
    char *zip = stored_zip(names, datas, 5, &len);
    size_t json_len = 0;
    const char *scene_json = fos_scene_package_scene_json(zip, len, &json_len);
    CHECK(scene_json != NULL && json_len == strlen(datas[0]) && memcmp(scene_json, datas[0], json_len) == 0);
    size_t out_len = 0;
    char *json = fos_scene_package_to_json(zip, len, &out_len);
    CHECK(json != NULL && out_len == strlen(json));
    cJSON *scene = cJSON_Parse(json);
    CHECK(cJSON_IsObject(scene));
    CHECK(source_of(scene, "clock", "app.ts") != NULL && strcmp(source_of(scene, "clock", "app.ts"), datas[1]) == 0);
    CHECK(source_of(scene, "clock", "lib/a.ts") != NULL);
    CHECK(source_of(scene, "data/immich", "app.js") != NULL);
    CHECK(strcmp(cJSON_GetObjectItem(cJSON_GetObjectItem(cJSON_GetObjectItem(scene, "apps"), "clock"), "name")->valuestring,
                 "Clock") == 0);
    CHECK(strstr(json, "logo") == NULL);
    cJSON_Delete(scene);
    free(json);

    /* scene.json not first: no package a frame keeps. */
    const char *wrong_names[] = {"apps/clock/app.ts", "scene.json"};
    const char *wrong_datas[] = {datas[1], datas[0]};
    size_t wrong_len = 0;
    char *wrong = stored_zip(wrong_names, wrong_datas, 2, &wrong_len);
    CHECK(fos_scene_package_scene_json(wrong, wrong_len, &json_len) == NULL);
    CHECK(fos_scene_package_to_json(wrong, wrong_len, &out_len) == NULL);
    CHECK(!fos_scene_package_is(datas[0], strlen(datas[0])));
    free(wrong);
    /* Cut short: refused, not read past its end. */
    CHECK(fos_scene_package_to_json(zip, len - 30, &out_len) == NULL);
    free(zip);
    printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
