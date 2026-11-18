/*
 * What the scene index keeps of a scene, read off its bytes as they go by
 * (fos_scene_meta.c), against the whole parse. Host test:
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Iembedded/esp32/main \
 *     -I"$IDF_PATH/components/json/cJSON" "$IDF_PATH/components/json/cJSON/cJSON.c" \
 *     embedded/esp32/main/fos_scene_meta.c embedded/esp32/main/tests/test_fos_scene_meta.c \
 *     -lm -o /tmp/test_fos_scene_meta && /tmp/test_fos_scene_meta repo/scenes/samples/<name>/scenes.json ...
 * Each file named is a JSON array of scenes: every one is read both ways.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "fos_scene_meta.h"

static int checks = 0, failures = 0;
#define CHECK(cond)                                                              \
    do {                                                                         \
        checks++;                                                                \
        if (!(cond)) {                                                           \
            failures++;                                                          \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #cond);          \
        }                                                                        \
    } while (0)

static fos_scene_meta_t meta; /* 8 KB: not on the stack */

static char *copy_text(const char *text)
{
    char *copy = malloc(strlen(text) + 1);
    strcpy(copy, text);
    return copy;
}

/* The scene's reading, fed `piece` bytes at a time; NULL when it is not one. */
static const char *read_in(const char *scene, size_t piece)
{
    size_t len = strlen(scene);
    fos_scene_meta_begin(&meta);
    for (size_t at = 0; at < len; at += piece) {
        fos_scene_meta_feed(&meta, scene + at, len - at < piece ? len - at : piece);
    }
    return fos_scene_meta_text(&meta);
}

/* The same text whatever the read size. */
static char *read_scene(const char *scene)
{
    static const size_t pieces[] = {1, 2, 3, 7, 64, 1000, 1 << 20};
    char *first = NULL;
    for (size_t i = 0; i < sizeof(pieces) / sizeof(pieces[0]); i++) {
        const char *text = read_in(scene, pieces[i]);
        if (i == 0) {
            first = text ? copy_text(text) : NULL;
        } else {
            CHECK((text == NULL) == (first == NULL));
            if (text != NULL && first != NULL) CHECK(strcmp(text, first) == 0);
        }
    }
    return first;
}

static bool same(const cJSON *a, const cJSON *b)
{
    if (a == NULL || b == NULL) return a == NULL && b == NULL;
    return cJSON_Compare(a, b, true);
}

/* Every member the index reads (make_entry in fos_scene_store.c) is in the
 * reading as it is in the scene. `names`: what the caller expects missing from
 * the reading although the scene has it (a member over the cap). */
static void check_against_tree(const char *scene, const char *without)
{
    char *text = read_scene(scene);
    cJSON *whole = cJSON_Parse(scene);
    cJSON *read = text ? cJSON_Parse(text) : NULL;
    CHECK(text != NULL);
    CHECK(whole != NULL);
    CHECK(read != NULL);
    if (text == NULL || read == NULL || whole == NULL) {
        fprintf(stderr, "  scene: %.120s\n  read: %.200s\n", scene, text ? text : "(none)");
        cJSON_Delete(whole);
        cJSON_Delete(read);
        free(text);
        return;
    }
    static const char *const top[] = {"id", "name", "default", "refreshInterval"};
    static const char *const settings[] = {"isLayout", "desktop", "windowSize", "icon", "category"};
    for (size_t i = 0; i < sizeof(top) / sizeof(top[0]); i++) {
        const cJSON *value = cJSON_GetObjectItemCaseSensitive(whole, top[i]);
        if (without != NULL && strcmp(without, top[i]) == 0) {
            CHECK(cJSON_GetObjectItemCaseSensitive(read, top[i]) == NULL);
        } else if (value == NULL || !(cJSON_IsObject(value) || cJSON_IsArray(value))) {
            CHECK(same(value, cJSON_GetObjectItemCaseSensitive(read, top[i])));
        }
    }
    const cJSON *whole_settings = cJSON_GetObjectItemCaseSensitive(whole, "settings");
    const cJSON *read_settings = cJSON_GetObjectItemCaseSensitive(read, "settings");
    if (cJSON_IsObject(whole_settings)) CHECK(cJSON_IsObject(read_settings));
    for (size_t i = 0; cJSON_IsObject(whole_settings) && i < sizeof(settings) / sizeof(settings[0]); i++) {
        const cJSON *value = cJSON_GetObjectItemCaseSensitive(whole_settings, settings[i]);
        if (without != NULL && strcmp(without, settings[i]) == 0) {
            CHECK(cJSON_GetObjectItemCaseSensitive(read_settings, settings[i]) == NULL);
        } else if (value == NULL || !(cJSON_IsObject(value) || cJSON_IsArray(value))) {
            bool ok = same(value, cJSON_GetObjectItemCaseSensitive(read_settings, settings[i]));
            CHECK(ok);
            if (!ok) fprintf(stderr, "  settings.%s differs\n  read: %.300s\n", settings[i], text);
        }
    }
    /* Nothing in the reading that the scene does not say. */
    const cJSON *item = NULL;
    cJSON_ArrayForEach(item, read) {
        if (strcmp(item->string, "settings") == 0 && cJSON_IsObject(item)) continue;
        CHECK(same(item, cJSON_GetObjectItemCaseSensitive(whole, item->string)));
    }
    cJSON_ArrayForEach(item, read_settings) {
        CHECK(same(item, cJSON_GetObjectItemCaseSensitive(whole_settings, item->string)));
    }
    cJSON_Delete(whole);
    cJSON_Delete(read);
    free(text);
}

static void expect_text(const char *scene, const char *expected)
{
    char *text = read_scene(scene);
    CHECK(text != NULL && strcmp(text, expected) == 0);
    if (text == NULL || strcmp(text, expected) != 0) {
        fprintf(stderr, "  scene: %s\n  read:  %s\n  want:  %s\n", scene, text ? text : "(none)", expected);
    }
    free(text);
}

static void expect_none(const char *scene)
{
    char *text = read_scene(scene);
    CHECK(text == NULL);
    if (text != NULL) fprintf(stderr, "  scene: %s\n  read:  %s\n", scene, text);
    free(text);
}

static char *read_file(const char *path)
{
    FILE *f = fopen(path, "rb");
    if (f == NULL) return NULL;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc((size_t)size + 1);
    size_t got = fread(buf, 1, (size_t)size, f);
    buf[got] = '\0';
    fclose(f);
    return buf;
}

int main(int argc, char **argv)
{
    /* Scalars kept as they are written, containers passed over. */
    expect_text("{\"id\":\"a\"}", "{\"id\":\"a\"}");
    expect_text("  {  \"id\" : \"a\" , \"name\":\"A\"  }  ", "{\"id\":\"a\",\"name\":\"A\"}");
    expect_text("{}", "{}");
    expect_text("{\"nodes\":[{\"id\":\"n\",\"data\":{\"a\":[1,2,{\"b\":\"}\"}]}}],\"id\":\"a\",\"edges\":[]}",
                "{\"id\":\"a\"}");
    expect_text("{\"default\":true,\"n\":-1.5e3,\"z\":null,\"id\":\"a\"}",
                "{\"default\":true,\"n\":-1.5e3,\"z\":null,\"id\":\"a\"}");
    /* The settings' scalars, and nothing nested in them. */
    expect_text("{\"id\":\"a\",\"settings\":{\"isLayout\":true,\"deep\":{\"x\":1},\"category\":\"Photos\",\"l\":[1]}}",
                "{\"id\":\"a\",\"settings\":{\"isLayout\":true,\"category\":\"Photos\"}}");
    expect_text("{\"settings\":{},\"id\":\"a\"}", "{\"settings\":{},\"id\":\"a\"}");
    expect_text("{\"settings\":{\"a\":{}},\"id\":\"a\"}", "{\"settings\":{},\"id\":\"a\"}");
    /* Settings that are not an object are a scalar like any other, or passed over. */
    expect_text("{\"settings\":\"no\",\"id\":\"a\"}", "{\"settings\":\"no\",\"id\":\"a\"}");
    expect_text("{\"settings\":[1,2],\"id\":\"a\"}", "{\"id\":\"a\"}");
    /* An object named settings deeper down is not the scene's. */
    expect_text("{\"apps\":{\"settings\":{\"isLayout\":true}},\"id\":\"a\"}", "{\"id\":\"a\"}");
    /* Escapes travel as written: quotes, backslashes, braces in strings. */
    expect_text("{\"name\":\"a \\\"b\\\" \\\\ } ] , : {\",\"id\":\"\\u00e9\"}",
                "{\"name\":\"a \\\"b\\\" \\\\ } ] , : {\",\"id\":\"\\u00e9\"}");
    /* An escaped key is not the plain "settings": its object is passed over. */
    expect_text("{\"s\\u0065ttings\":{\"isLayout\":true},\"id\":\"a\"}", "{\"id\":\"a\"}");

    /* Against the tree: what the index reads is there, as the scene says it. */
    check_against_tree("{\"id\":\"clock\",\"name\":\"Cl\\u00f6ck \\ud83d\\ude00\",\"default\":true,"
                       "\"refreshInterval\":60,\"settings\":{\"windowSize\":\"800x600\",\"icon\":\"M1 2L3 4Z\","
                       "\"category\":\"Real time\",\"backgroundColor\":\"#000\"},"
                       "\"nodes\":[{\"id\":\"1\",\"type\":\"app\",\"data\":{\"sources\":{\"app.ts\":\"{\\\"}\"}}}],"
                       "\"edges\":[],\"apps\":{\"a\":{\"name\":\"not the scene's\"}}}",
                       NULL);
    check_against_tree("{\"settings\":{\"isLayout\":true,\"desktop\":true,\"category\":\"Desktops\"},\"id\":\"win98\","
                       "\"name\":\"Windows 98\",\"fields\":[{\"name\":\"id\",\"value\":\"x\"}]}",
                       NULL);

    {
        /* An icon at its limit is kept; a member over the cap is left out and
         * the ones around it stay. */
        char scene[8192];
        char icon[2048];
        memset(icon, 'M', 1024);
        icon[1024] = '\0';
        snprintf(scene, sizeof(scene), "{\"id\":\"a\",\"settings\":{\"icon\":\"%s\",\"isLayout\":true},\"name\":\"A\"}",
                 icon);
        check_against_tree(scene, NULL);
        memset(icon, 'M', 1800);
        icon[1800] = '\0';
        snprintf(scene, sizeof(scene), "{\"id\":\"a\",\"settings\":{\"category\":\"C\",\"icon\":\"%s\",\"isLayout\":true},"
                                       "\"name\":\"A\"}",
                 icon);
        check_against_tree(scene, "icon");
        snprintf(scene, sizeof(scene), "{\"id\":\"a\",\"name\":\"%s\",\"settings\":{\"isLayout\":true}}", icon);
        check_against_tree(scene, "name");
    }

    {
        /* More scalars than the reading holds: the later ones are left out,
         * and what is kept is still one object. */
        size_t cap = 64 * 1024;
        char *scene = malloc(cap);
        size_t at = (size_t)snprintf(scene, cap, "{\"id\":\"a\"");
        for (int i = 0; i < 40; i++) {
            at += (size_t)snprintf(scene + at, cap - at, ",\"k%d\":\"", i);
            memset(scene + at, 'x', 1000);
            at += 1000;
            scene[at++] = '"';
        }
        snprintf(scene + at, cap - at, ",\"settings\":{\"isLayout\":true}}");
        char *text = read_scene(scene);
        cJSON *read = text ? cJSON_Parse(text) : NULL;
        CHECK(read != NULL && strlen(text) < FOS_SCENE_META_MAX);
        CHECK(strcmp(cJSON_GetStringValue(cJSON_GetObjectItem(read, "id")), "a") == 0);
        CHECK(cJSON_GetObjectItem(read, "k0") != NULL && cJSON_GetObjectItem(read, "k39") == NULL);
        cJSON_Delete(read);
        free(text);
        free(scene);
    }

    /* Not one object, or not whole. */
    expect_none("");
    expect_none("[]");
    expect_none("\"a\"");
    expect_none("{\"id\":\"a\"");
    expect_none("{\"id\":\"a\"}{}");
    expect_none("{\"id\":\"a\"}x");
    expect_none("{\"id\" \"a\"}");
    expect_none("{\"id\":\"a\" \"b\":1}");
    expect_none("{\"id\":\"a\"]");

    /* The depth the bytes reach, for the caller's own limit. */
    CHECK(read_in("{\"a\":[[[{\"b\":{}}]]]}", 3) != NULL && fos_scene_meta_depth(&meta) == 6);
    CHECK(read_in("{\"a\":1}", 3) != NULL && fos_scene_meta_depth(&meta) == 1);

    /* Scene files: every scene of each, compact and spread out. */
    int scenes = 0;
    for (int i = 1; i < argc; i++) {
        char *text = read_file(argv[i]);
        cJSON *set = text ? cJSON_Parse(text) : NULL;
        CHECK(cJSON_IsArray(set));
        const cJSON *scene = NULL;
        cJSON_ArrayForEach(scene, set) {
            char *compact = cJSON_PrintUnformatted(scene);
            char *spread = cJSON_Print(scene);
            check_against_tree(compact, NULL);
            check_against_tree(spread, NULL);
            cJSON_free(compact);
            cJSON_free(spread);
            scenes++;
        }
        cJSON_Delete(set);
        free(text);
    }
    if (argc > 1) printf("  %d scene(s) of %d file(s) read both ways\n", scenes, argc - 1);

    printf("%d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
