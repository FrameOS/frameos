/*
 * The scene store on the frame reads store answers and stored scenes without
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

    puts("fos_store_scan: ok");
    return 0;
}
