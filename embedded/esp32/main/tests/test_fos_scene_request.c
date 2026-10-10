/*
 * Host tests for the backend's queued scene switch (fos_scene_request.c).
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_scene_request.c main/tests/test_fos_scene_request.c \
 *      -o /tmp/test_fos_scene_request && /tmp/test_fos_scene_request
 *
 * (backend/app/tasks/tests/test_esp32_scene_request.py does exactly that in CI.)
 */
#include <stdio.h>
#include <string.h>

#include "fos_scene_request.h"

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond, ...)                                                       \
    do {                                                                       \
        g_checks++;                                                            \
        if (!(cond)) {                                                         \
            g_failures++;                                                      \
            printf("FAIL %s:%d: ", __func__, __LINE__);                        \
            printf(__VA_ARGS__);                                               \
            printf("\n");                                                      \
        }                                                                      \
    } while (0)

#define REQ "6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c"
#define SCENE "b91d14d1-ed3e-520f-bf9a-f88ce4c1cc9a"

static void test_no_request(void)
{
    CHECK(fos_scene_request_decide(NULL, NULL, NULL) == FOS_SCENE_REQUEST_NONE, "nothing");
    CHECK(fos_scene_request_decide("", "", REQ) == FOS_SCENE_REQUEST_NONE, "empty headers");
}

static void test_new_request_applies_once(void)
{
    CHECK(fos_scene_request_decide(REQ, SCENE, NULL) == FOS_SCENE_REQUEST_APPLY,
          "first request on a fresh frame");
    CHECK(fos_scene_request_decide(REQ, SCENE, "") == FOS_SCENE_REQUEST_APPLY,
          "no id stored yet");
    CHECK(fos_scene_request_decide(REQ, SCENE, REQ) == FOS_SCENE_REQUEST_SEEN,
          "the same request on the next wake must not re-select (a button may have moved on)");
    CHECK(fos_scene_request_decide("next-request", SCENE, REQ) == FOS_SCENE_REQUEST_APPLY,
          "a new activation of the same scene applies again");
}

static void test_half_a_request_is_invalid(void)
{
    CHECK(fos_scene_request_decide(REQ, NULL, NULL) == FOS_SCENE_REQUEST_INVALID, "no scene");
    CHECK(fos_scene_request_decide(NULL, SCENE, NULL) == FOS_SCENE_REQUEST_INVALID, "no id");
}

static void test_values_that_cannot_be_logged_are_refused(void)
{
    CHECK(fos_scene_request_decide("bad id", SCENE, NULL) == FOS_SCENE_REQUEST_INVALID, "space in id");
    CHECK(fos_scene_request_decide("x\"y", SCENE, NULL) == FOS_SCENE_REQUEST_INVALID, "quote in id");
    CHECK(fos_scene_request_decide(REQ, "a\"b", NULL) == FOS_SCENE_REQUEST_INVALID, "quote in scene");
    CHECK(fos_scene_request_decide(REQ, "a\\b", NULL) == FOS_SCENE_REQUEST_INVALID, "backslash in scene");
    CHECK(fos_scene_request_decide(REQ, "a\nb", NULL) == FOS_SCENE_REQUEST_INVALID, "newline in scene");
    CHECK(fos_scene_request_decide(REQ, "uploaded/scene 1", NULL) == FOS_SCENE_REQUEST_APPLY,
          "slashes and spaces are fine in a scene id");
}

static void test_lengths(void)
{
    char id[FOS_SCENE_REQUEST_ID_LEN + 1];
    memset(id, 'a', sizeof(id));
    id[FOS_SCENE_REQUEST_ID_LEN - 1] = '\0';
    CHECK(fos_scene_request_decide(id, SCENE, NULL) == FOS_SCENE_REQUEST_APPLY, "longest id that fits");
    id[FOS_SCENE_REQUEST_ID_LEN - 1] = 'a';
    id[FOS_SCENE_REQUEST_ID_LEN] = '\0';
    CHECK(fos_scene_request_decide(id, SCENE, NULL) == FOS_SCENE_REQUEST_INVALID, "id one too long");

    char scene[FOS_SCENE_REQUEST_SCENE_LEN + 1];
    memset(scene, 's', sizeof(scene));
    scene[FOS_SCENE_REQUEST_SCENE_LEN] = '\0';
    CHECK(fos_scene_request_decide(REQ, scene, NULL) == FOS_SCENE_REQUEST_INVALID, "scene one too long");
}

int main(void)
{
    test_no_request();
    test_new_request_applies_once();
    test_half_a_request_is_invalid();
    test_values_that_cannot_be_logged_are_refused();
    test_lengths();
    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
