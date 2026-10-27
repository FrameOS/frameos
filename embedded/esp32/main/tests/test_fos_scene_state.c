/* Host test of fos_scene_state.c: the file a scene's state lives in, and the
 * load / save / forget round trip, against a temporary directory, written
 * through and written behind.
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_scene_state.c main/tests/test_fos_scene_state.c -o t && ./t
 *
 * Run by backend/app/tasks/tests/test_esp32_scene_state.py.
 */
#define _DEFAULT_SOURCE
#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "fos_scene_state.h"

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

static const char *UUID = "0d1c4a8e-7b2f-4c1d-9e3a-5f6b7c8d9e0f";

static void test_path(void)
{
    char path[96];
    fos_scene_state_set_dir("/state");
    CHECK(fos_scene_state_path(UUID, path, sizeof(path)));
    /* "/state/" + "st-" + 8 hex + ".json": 23 bytes, under SPIFFS's 32-byte
     * object name cap, whatever the id's length. */
    CHECK(strlen(path) == 23);
    CHECK(strncmp(path, "/state/st-", 10) == 0);
    CHECK(strcmp(path + strlen(path) - 5, ".json") == 0);
    /* Deterministic, and different ids get different files. */
    char again[96];
    char other[96];
    CHECK(fos_scene_state_path(UUID, again, sizeof(again)));
    CHECK(strcmp(path, again) == 0);
    CHECK(fos_scene_state_path("clock", other, sizeof(other)));
    CHECK(strcmp(path, other) != 0);
    /* A short name like the scene-store's slots never collides with a uuid's. */
    CHECK(!fos_scene_state_path("", path, sizeof(path)));
    CHECK(!fos_scene_state_path(NULL, path, sizeof(path)));
    CHECK(!fos_scene_state_path(UUID, path, 10));
    /* A trailing slash on the directory is not doubled. */
    fos_scene_state_set_dir("/state/");
    CHECK(fos_scene_state_path("clock", path, sizeof(path)));
    CHECK(strncmp(path, "/state/st-", 10) == 0);
}

static void test_round_trip(const char *dir)
{
    fos_scene_state_set_dir(dir);
    fos_scene_state_forget(UUID);
    CHECK(fos_scene_state_load(UUID) == NULL);

    CHECK(fos_scene_state_save(UUID, "{\"album\":\"holiday\",\"size\":3}"));
    char *loaded = fos_scene_state_load(UUID);
    CHECK(loaded != NULL);
    CHECK(loaded && strcmp(loaded, "{\"album\":\"holiday\",\"size\":3}") == 0);
    free(loaded);

    /* A rewrite replaces, never appends. */
    CHECK(fos_scene_state_save(UUID, "{\"album\":\"birds\"}"));
    loaded = fos_scene_state_load(UUID);
    CHECK(loaded && strcmp(loaded, "{\"album\":\"birds\"}") == 0);
    free(loaded);
    /* No temporary file is left behind. */
    char tmp[128];
    snprintf(tmp, sizeof(tmp), "%s/st-", dir);
    char path[128];
    CHECK(fos_scene_state_path(UUID, path, sizeof(path)));
    memcpy(tmp, path, strlen(path) - 4);
    strcpy(tmp + strlen(path) - 4, "tmp");
    CHECK(fopen(tmp, "rb") == NULL);

    /* Another scene's file is its own. */
    CHECK(fos_scene_state_save("clock", "{\"size\":1}"));
    loaded = fos_scene_state_load(UUID);
    CHECK(loaded && strcmp(loaded, "{\"album\":\"birds\"}") == 0);
    free(loaded);

    /* Nothing left to keep removes the file; so does forgetting. */
    CHECK(fos_scene_state_save(UUID, "{}"));
    CHECK(fos_scene_state_load(UUID) == NULL);
    CHECK(fos_scene_state_save(UUID, " { } "));
    CHECK(fos_scene_state_load(UUID) == NULL);
    CHECK(fos_scene_state_save(UUID, NULL));
    CHECK(fos_scene_state_load(UUID) == NULL);
    fos_scene_state_forget("clock");
    CHECK(fos_scene_state_load("clock") == NULL);

    /* Over the cap is refused, and the previous state stays. */
    CHECK(fos_scene_state_save(UUID, "{\"a\":1}"));
    char *big = malloc(FOS_SCENE_STATE_MAX_BYTES + 64);
    memset(big, 'x', FOS_SCENE_STATE_MAX_BYTES + 63);
    big[FOS_SCENE_STATE_MAX_BYTES + 63] = '\0';
    big[0] = '{';
    CHECK(!fos_scene_state_save(UUID, big));
    free(big);
    loaded = fos_scene_state_load(UUID);
    CHECK(loaded && strcmp(loaded, "{\"a\":1}") == 0);
    free(loaded);
    fos_scene_state_forget(UUID);
}

static uint32_t s_clock_ms = 0;

static uint32_t fake_now_ms(void)
{
    return s_clock_ms;
}

static bool file_exists(const char *scene_id)
{
    char path[128];
    if (!fos_scene_state_path(scene_id, path, sizeof(path))) return false;
    FILE *f = fopen(path, "rb");
    if (f == NULL) return false;
    fclose(f);
    return true;
}

static bool loads_as(const char *scene_id, const char *expected)
{
    char *loaded = fos_scene_state_load(scene_id);
    bool same = expected == NULL ? loaded == NULL : (loaded != NULL && strcmp(loaded, expected) == 0);
    free(loaded);
    return same;
}

static void test_write_behind(const char *dir)
{
    fos_scene_state_set_dir(dir);
    fos_scene_state_forget(UUID);
    /* A clock that starts near its wrap: the delay is a difference. */
    s_clock_ms = 0xFFFFF000u;
    fos_scene_state_write_behind_t behind = {.delay_ms = 60000, .now_ms = fake_now_ms};
    fos_scene_state_set_write_behind(&behind);

    /* A change waits in RAM, and a load sees it. */
    CHECK(fos_scene_state_save(UUID, "{\"taps\":1}"));
    CHECK(!file_exists(UUID));
    CHECK(fos_scene_state_pending());
    CHECK(loads_as(UUID, "{\"taps\":1}"));

    /* Later changes ride along without restarting the wait. */
    s_clock_ms += 40000;
    CHECK(fos_scene_state_save(UUID, "{\"taps\":2}"));
    fos_scene_state_flush(false);
    CHECK(!file_exists(UUID));
    s_clock_ms += 20000;
    fos_scene_state_flush(false);
    CHECK(file_exists(UUID));
    CHECK(!fos_scene_state_pending());
    CHECK(loads_as(UUID, "{\"taps\":2}"));

    /* Emptied: the file stays until the flush, a load already says nothing. */
    CHECK(fos_scene_state_save(UUID, "{}"));
    CHECK(loads_as(UUID, NULL));
    CHECK(file_exists(UUID));
    fos_scene_state_flush(true);
    CHECK(!file_exists(UUID));

    /* Over the cap is refused here too, and changes nothing. */
    CHECK(fos_scene_state_save(UUID, "{\"a\":1}"));
    char *big = malloc(FOS_SCENE_STATE_MAX_BYTES + 64);
    memset(big, 'x', FOS_SCENE_STATE_MAX_BYTES + 63);
    big[FOS_SCENE_STATE_MAX_BYTES + 63] = '\0';
    big[0] = '{';
    CHECK(!fos_scene_state_save(UUID, big));
    free(big);
    CHECK(loads_as(UUID, "{\"a\":1}"));

    /* Forgetting drops what waits as well as the file. */
    fos_scene_state_forget(UUID);
    CHECK(!fos_scene_state_pending());
    fos_scene_state_flush(true);
    CHECK(!file_exists(UUID));

    /* A fifth waiting scene writes the one that waited longest. */
    const char *ids[5] = {"s1", "s2", "s3", "s4", "s5"};
    for (int i = 0; i < 5; i++) {
        s_clock_ms += 1000;
        CHECK(fos_scene_state_save(ids[i], "{\"n\":1}"));
    }
    CHECK(file_exists("s1"));
    CHECK(!file_exists("s2"));
    CHECK(!file_exists("s5"));
    for (int i = 0; i < 5; i++) CHECK(loads_as(ids[i], "{\"n\":1}"));

    /* Turning it off writes what waits, and later saves go straight through. */
    fos_scene_state_set_write_behind(NULL);
    for (int i = 0; i < 5; i++) CHECK(file_exists(ids[i]));
    CHECK(!fos_scene_state_pending());
    CHECK(fos_scene_state_save(UUID, "{\"b\":2}"));
    CHECK(file_exists(UUID));
    for (int i = 0; i < 5; i++) fos_scene_state_forget(ids[i]);
    fos_scene_state_forget(UUID);
}

int main(void)
{
    test_path();
    char dir[] = "/tmp/fos_scene_state_XXXXXX";
    if (mkdtemp(dir) == NULL) {
        printf("mkdtemp failed\n");
        return 1;
    }
    test_round_trip(dir);
    test_write_behind(dir);
    rmdir(dir);
    printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
