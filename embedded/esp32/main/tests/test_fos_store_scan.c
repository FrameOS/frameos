/*
 * The scene store's host reads store answers and stored scenes without
 * a JSON tree (fos_store_scan.c). Host test:
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Iembedded/esp32/main \
 *     embedded/esp32/main/fos_store_scan.c embedded/esp32/main/tests/test_fos_store_scan.c \
 *     -o /tmp/test_fos_store_scan && /tmp/test_fos_store_scan
 */
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "fos_store_scan.h"

static int split(const char *json, const char **starts, size_t *lens, int max)
{
    return fos_store_split_scenes(json, strlen(json), starts, lens, max);
}

int main(void)
{
    const char *starts[4];
    size_t lens[4];

    /* One scene, two, with braces, brackets and quotes inside strings. */
    const char *one = "[{\"id\":\"a\",\"nodes\":[{\"x\":\"}]\\\"[{\"}]}]";
    assert(split(one, starts, lens, 4) == 1);
    assert(starts[0] == one + 1 && lens[0] == strlen(one) - 2);
    const char *two = " [ {\"id\":\"a\"} ,\n {\"id\":\"b\",\"o\":{\"k\":[1,2]}} ] ";
    assert(split(two, starts, lens, 4) == 2);
    assert(strncmp(starts[0], "{\"id\":\"a\"}", lens[0]) == 0);
    assert(strncmp(starts[1], "{\"id\":\"b\",\"o\":{\"k\":[1,2]}}", lens[1]) == 0);
    assert(split("[]", starts, lens, 4) == 0);

    /* More than fit: the first `max`. */
    assert(split("[{},{},{}]", starts, lens, 2) == 2);

    /* Not an array of whole objects. */
    assert(split("{\"id\":\"a\"}", starts, lens, 4) == -1);
    assert(split("[{\"id\":\"a\"}", starts, lens, 4) == -1);
    assert(split("[{\"id\":\"a\"}]]", starts, lens, 4) == -1);
    assert(split("[1,{\"id\":\"a\"}]", starts, lens, 4) == -1);
    assert(split("[\"a\"]", starts, lens, 4) == -1);
    assert(split("[[{}]]", starts, lens, 4) == -1);
    assert(split("[{\"id\":\"a}]", starts, lens, 4) == -1);
    assert(split("[][]", starts, lens, 4) == -1);
    assert(split("", starts, lens, 4) == -1);

    /* The store's stamp. */
    char store[40];
    int version;
    fos_store_read_origin("{\"id\":\"x\",\"apps\":{\"a\":{\"origin\":\"repo/apps/image/immich\"}},"
                          "\"origin\":{\"href\":\"https://scenes.frameos.net/s/x\","
                          "\"storeSceneId\":\"0b1e8a52-6f0e-4a33-9f39-7a0d0b0b0a01\",\"version\":\"12\","
                          "\"sceneId\":\"x\"}}",
                          store, sizeof(store), &version);
    assert(strcmp(store, "0b1e8a52-6f0e-4a33-9f39-7a0d0b0b0a01") == 0 && version == 12);
    fos_store_read_origin("{\"id\":\"x\",\"origin\":{\"repository\":\"y\"}}", store, sizeof(store), &version);
    assert(store[0] == '\0' && version == 0);
    fos_store_read_origin(NULL, store, sizeof(store), &version);
    assert(store[0] == '\0');
    /* An id too long for the buffer is no id. */
    fos_store_read_origin("{\"origin\":{\"storeSceneId\":\"0123456789012345678901234567890123456789012\"}}", store,
                          sizeof(store), &version);
    assert(store[0] == '\0');
    /* No version after it. */
    fos_store_read_origin("{\"origin\":{\"storeSceneId\":\"abc\"}}", store, sizeof(store), &version);
    assert(strcmp(store, "abc") == 0 && version == 0);
    /* The workspace's longer stamp as a backend serves it (keys sorted): the
     * repository and template between the id and the version. */
    fos_store_read_origin("{\"id\":\"hn\",\"name\":\"Hacker News\",\"nodes\":[],"
                          "\"origin\":{\"href\":\"https://scenes.frameos.net/s/hn\",\"repositoryId\":\"store\","
                          "\"repositoryUrl\":\"https://scenes.frameos.net/api/store/repository.json\","
                          "\"sceneId\":\"hn\",\"storeSceneId\":\"abc\",\"templateId\":\"hacker-news\","
                          "\"templateName\":\"Hacker News\",\"version\":\"7\"},\"settings\":{}}",
                          store, sizeof(store), &version);
    assert(strcmp(store, "abc") == 0 && version == 7);
    /* The same in the order the workspace writes it, spaced, with a number. */
    fos_store_read_origin("{ \"origin\" : { \"href\" : \"h\", \"storeSceneId\" : \"abc\", \"repositoryId\" : \"r\", "
                          "\"templateName\" : \"T\", \"sceneId\" : \"x\", \"version\" : 4 } }",
                          store, sizeof(store), &version);
    assert(strcmp(store, "abc") == 0 && version == 4);
    /* A version before the id. */
    fos_store_read_origin("{\"origin\":{\"version\":\"3\",\"storeSceneId\":\"abc\"}}", store, sizeof(store), &version);
    assert(strcmp(store, "abc") == 0 && version == 3);
    /* A version of another object is not the stamp's: one nested in the
     * stamp, the scene's own, a node's, an app's, a string's. */
    fos_store_read_origin("{\"version\":\"5\",\"nodes\":[{\"data\":{\"version\":\"6\"}}],"
                          "\"origin\":{\"storeSceneId\":\"abc\",\"meta\":{\"version\":\"9\"},\"note\":\"\\\"version\\\":\\\"8\\\"\"},"
                          "\"apps\":{\"a\":{\"origin\":{\"version\":\"2\"}}},\"settings\":{\"version\":\"1\"}}",
                          store, sizeof(store), &version);
    assert(strcmp(store, "abc") == 0 && version == 0);
    /* An id that is not the scene's own stamp's is no id. */
    fos_store_read_origin("{\"apps\":{\"a\":{\"origin\":{\"storeSceneId\":\"abc\",\"version\":\"2\"}}},"
                          "\"origin\":{\"repositoryUrl\":\"r\",\"version\":\"3\"}}",
                          store, sizeof(store), &version);
    assert(store[0] == '\0' && version == 0);
    fos_store_read_origin("{\"origin\":{\"meta\":{\"storeSceneId\":\"abc\"}}}", store, sizeof(store), &version);
    assert(store[0] == '\0');
    fos_store_read_origin("{\"origin\":\"repo/scenes/x\",\"storeSceneId\":\"abc\"}", store, sizeof(store), &version);
    assert(store[0] == '\0');
    fos_store_read_origin("{\"origin\":{\"storeSceneId\":12}}", store, sizeof(store), &version);
    assert(store[0] == '\0');
    /* An origin cut off: nothing read past the end of the text. */
    fos_store_read_origin("{\"origin\":{\"storeSceneId\":\"abc\",\"version\":\"7\"", store, sizeof(store), &version);
    assert(store[0] == '\0' && version == 0);

    /* The scene's own default goes; a nested one, a string, stay. */
    char scene[] = "{\"id\":\"a\",\"settings\":{\"default\":true},\"name\":\"\\\"default\\\": true\","
                   "\"default\" : true,\"fields\":[{\"default\":true}]}";
    fos_store_clear_default(scene, strlen(scene));
    assert(strcmp(scene, "{\"id\":\"a\",\"settings\":{\"default\":true},\"name\":\"\\\"default\\\": true\","
                         "\"default\" : null,\"fields\":[{\"default\":true}]}") == 0);
    char plain[] = "{\"id\":\"a\",\"default\":false}";
    fos_store_clear_default(plain, strlen(plain));
    assert(strcmp(plain, "{\"id\":\"a\",\"default\":false}") == 0);
    fos_store_clear_default(NULL, 0);

    /* A key of the object itself, not of a nested one or inside a string. */
    const char *v = NULL;
    size_t vl = 0;
    const char *answer = "{ \"summary\" : \"a \\\"scene\\\": x\" , \"nested\":{\"scene\":1},"
                         "\"list\":[{\"scene\":2}],\"scene\": {\"id\":\"s\",\"a\":[1,{\"b\":\"}\"}]} ,\"ok\":true }";
    assert(fos_store_find_key(answer, strlen(answer), "scene", &v, &vl));
    assert(vl == strlen("{\"id\":\"s\",\"a\":[1,{\"b\":\"}\"}]}") && strncmp(v, "{\"id\":\"s\"", 9) == 0);
    assert(fos_store_find_key(v, vl, "id", &v, &vl) && vl == 3 && strncmp(v, "\"s\"", 3) == 0);
    assert(fos_store_find_key(answer, strlen(answer), "ok", &v, &vl) && vl == 4 && strncmp(v, "true", 4) == 0);
    assert(fos_store_find_key(answer, strlen(answer), "summary", &v, &vl) && v[0] == '"' && v[vl - 1] == '"');
    assert(!fos_store_find_key(answer, strlen(answer), "b", &v, &vl));
    assert(!fos_store_find_key(answer, strlen(answer), "scen", &v, &vl));
    /* A value that is a key's name is no key. */
    const char *tricky = "{\"a\":\"scene\",\"scene\":false}";
    assert(fos_store_find_key(tricky, strlen(tricky), "scene", &v, &vl) && vl == 5);
    assert(!fos_store_find_key("[{\"scene\":1}]", 14, "scene", &v, &vl));
    assert(!fos_store_find_key("{\"scene\":1", 11, "scene", &v, &vl));
    assert(!fos_store_find_key("{\"scene\":}", 11, "scene", &v, &vl));
    assert(!fos_store_find_key(NULL, 0, "scene", &v, &vl));

    puts("fos_store_scan: ok");
    return 0;
}
