/*
 * Host tests for the relay of a frame rendered on its control plane
 * (fos_render_relay.c, docs/server-rendering.md "Keys, touch and the
 * schedule"). Pure: no IDF.
 *
 * Build and run (from the repository root):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Iembedded/esp32/main \
 *      embedded/esp32/main/fos_render_relay.c embedded/esp32/main/tests/test_fos_render_relay.c \
 *      -o /tmp/test_fos_render_relay && /tmp/test_fos_render_relay
 *
 * (the ESP32 job of .github/workflows/e2e-docker.yml runs exactly that.)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fos_render_relay.h"

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

static fos_render_relay_t relay;

static void fresh(void)
{
    fos_render_relay_clear(&relay);
    memset(&relay, 0, sizeof(relay));
}

static char *take(int64_t now_ms)
{
    size_t len = 0;
    char *body = fos_render_relay_take(&relay, now_ms, &len);
    if (body) CHECK(len == strlen(body), "the length is the body's (%zu vs %zu)", len, strlen(body));
    return body;
}

static void test_body_shape(void)
{
    fresh();
    CHECK(take(5) == NULL, "nothing held, nothing to send");
    CHECK(fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "gpio",
                               "{\"pin\":3,\"label\":\"RIGHT\",\"level\":0,\"action\":\"down\",\"atMs\":80410}",
                               NULL) == FOS_RENDER_RELAY_KEPT,
          "a key edge is held");
    CHECK(fos_render_relay_add(&relay, FOS_ORIGIN_SCHEDULE, "setCurrentScene", "  {\"sceneId\":\"news\"}\n", NULL) ==
              FOS_RENDER_RELAY_KEPT,
          "a schedule entry is held, blanks trimmed");
    CHECK(fos_render_relay_add(&relay, FOS_ORIGIN_HTTP_ADMIN, "render", NULL, NULL) == FOS_RENDER_RELAY_KEPT,
          "no payload is {}");
    CHECK(fos_render_relay_add(&relay, FOS_ORIGIN_HTTP_WRITE, "myEvent", "", NULL) == FOS_RENDER_RELAY_KEPT,
          "an empty payload is {}");
    CHECK(fos_render_relay_count(&relay) == 4, "four held");
    char *body = take(81234);
    const char *want =
        "{\"nowMs\":81234,\"events\":["
        "{\"origin\":\"driver\",\"name\":\"gpio\",\"payload\":"
        "{\"pin\":3,\"label\":\"RIGHT\",\"level\":0,\"action\":\"down\",\"atMs\":80410}},"
        "{\"origin\":\"schedule\",\"name\":\"setCurrentScene\",\"payload\":{\"sceneId\":\"news\"}},"
        "{\"origin\":\"http:admin\",\"name\":\"render\",\"payload\":{}},"
        "{\"origin\":\"http:write\",\"name\":\"myEvent\",\"payload\":{}}]}";
    CHECK(body && strcmp(body, want) == 0, "the body: %s", body ? body : "(null)");
    free(body);
}

static void test_refusals(void)
{
    fresh();
    CHECK(fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "", "{}", NULL) == FOS_RENDER_RELAY_REFUSED, "no name");
    CHECK(fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, NULL, "{}", NULL) == FOS_RENDER_RELAY_REFUSED, "NULL name");
    CHECK(fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "a\"b", "{}", NULL) == FOS_RENDER_RELAY_REFUSED,
          "a quote in a name");
    char long_name[FOS_CUSTOM_EVENT_MAX_NAME_LENGTH + 2];
    memset(long_name, 'a', sizeof(long_name) - 1);
    long_name[sizeof(long_name) - 1] = '\0';
    CHECK(fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, long_name, "{}", NULL) == FOS_RENDER_RELAY_REFUSED,
          "a name past the contract's length");
    const char *bad[] = {
        "[1,2]", "\"text\"", "42", "{", "{\"a\":1", "{\"a\":\"unclosed}", "{\"a\":1}}", "{\"a\":1} x",
        "{\"a\":\"line\nbreak\"}", "{\"a\":[1,2}", "{} {}",
    };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        CHECK(fos_render_relay_add(&relay, FOS_ORIGIN_HTTP_ADMIN, "setSceneState", bad[i], NULL) ==
                  FOS_RENDER_RELAY_REFUSED,
              "not one JSON object: %s", bad[i]);
    }
    CHECK(fos_render_relay_add(&relay, FOS_ORIGIN_HTTP_ADMIN, "setSceneState",
                               "{\"state\":{\"text\":\"a } in \\\"quotes\\\" ]\",\"list\":[1,{\"b\":[]}]}}",
                               NULL) == FOS_RENDER_RELAY_KEPT,
          "brackets inside strings and nesting are fine");
    CHECK(fos_render_relay_count(&relay) == 1, "only the good one is held");
    /* One event bigger than a body on its own. */
    size_t big = FOS_RENDER_RELAY_MAX_BODY;
    char *huge = malloc(big + 16);
    snprintf(huge, big + 16, "{\"s\":\"");
    size_t used = strlen(huge);
    memset(huge + used, 'x', big - used);
    snprintf(huge + big, 16, "\"}");
    CHECK(fos_render_relay_add(&relay, FOS_ORIGIN_HTTP_ADMIN, "setSceneState", huge, NULL) ==
              FOS_RENDER_RELAY_REFUSED,
          "an event bigger than a body");
    free(huge);
    CHECK(fos_render_relay_count(&relay) == 1, "and the one held stays");
}

static void test_coalescing(void)
{
    fresh();
    fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "pointerDown",
                         "{\"x\":10,\"y\":10,\"pointerId\":1,\"pointerType\":\"touch\",\"button\":0,\"buttons\":1,\"atMs\":100}",
                         NULL);
    CHECK(fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "pointerMove",
                               "{\"x\":20,\"y\":10,\"pointerId\":1,\"pointerType\":\"touch\",\"buttons\":1}", NULL) ==
              FOS_RENDER_RELAY_KEPT,
          "the first move is held");
    CHECK(fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "pointerMove",
                               "{\"x\":30,\"y\":10,\"pointerId\":1,\"pointerType\":\"touch\",\"buttons\":1}", NULL) ==
              FOS_RENDER_RELAY_COALESCED,
          "the next move of that finger replaces it");
    CHECK(fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "pointerMove",
                               "{\"x\":5,\"y\":5,\"pointerId\":2,\"pointerType\":\"touch\",\"buttons\":1}", NULL) ==
              FOS_RENDER_RELAY_KEPT,
          "another finger's move does not");
    CHECK(fos_render_relay_count(&relay) == 3, "down, one move each");
    CHECK(fos_render_relay_pointer_down(&relay), "a finger is on the glass");
    char *body = take(200);
    CHECK(body && strstr(body, "\"x\":30") && !strstr(body, "\"x\":20"), "the newest position went: %s",
          body ? body : "(null)");
    free(body);
    /* A move that comes while the last one is out with a pull is kept behind it. */
    CHECK(fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "pointerMove",
                               "{\"x\":6,\"y\":6,\"pointerId\":2,\"pointerType\":\"touch\",\"buttons\":1}", NULL) ==
              FOS_RENDER_RELAY_KEPT,
          "a move after the take is not folded into one in flight");
    fos_render_relay_commit(&relay);
    CHECK(fos_render_relay_count(&relay) == 1, "the move after the take stays");
    fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "pointerUp",
                         "{\"x\":6,\"y\":6,\"pointerId\":2,\"pointerType\":\"touch\",\"button\":0,\"buttons\":0,\"atMs\":300}",
                         NULL);
    CHECK(fos_render_relay_pointer_down(&relay), "finger 1 is still down");
    fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "pointerCancel", "{\"pointerId\":1}", NULL);
    CHECK(!fos_render_relay_pointer_down(&relay), "no finger on the glass");
    /* A pointer event over HTTP says nothing about the glass. */
    fos_render_relay_add(&relay, FOS_ORIGIN_HTTP_ADMIN, "pointerDown", "{\"x\":1,\"y\":1,\"pointerId\":3}", NULL);
    CHECK(!fos_render_relay_pointer_down(&relay), "only the driver's fingers count");
    /* Consecutive and of a coalesced name, but from another origin: kept. */
    fresh();
    fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "pointerMove", "{\"pointerId\":1,\"x\":1}", NULL);
    CHECK(fos_render_relay_add(&relay, FOS_ORIGIN_HTTP_ADMIN, "pointerMove", "{\"pointerId\":1,\"x\":2}", NULL) ==
              FOS_RENDER_RELAY_KEPT,
          "another origin's move is its own");
    /* A key edge is never folded. */
    fresh();
    fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "gpio", "{\"label\":\"A\",\"action\":\"down\",\"atMs\":1}", NULL);
    CHECK(fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "gpio", "{\"label\":\"A\",\"action\":\"up\",\"atMs\":2}",
                               NULL) == FOS_RENDER_RELAY_KEPT,
          "gpio is not coalesced");
}

static void test_take_commit_release(void)
{
    fresh();
    fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "gpio", "{\"n\":1}", NULL);
    fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "gpio", "{\"n\":2}", NULL);
    char *body = take(10);
    free(body);
    CHECK(relay.in_flight == 2, "both went out");
    fos_render_relay_add(&relay, FOS_ORIGIN_SCHEDULE, "render", "{\"n\":3}", NULL);
    fos_render_relay_release(&relay);
    CHECK(fos_render_relay_count(&relay) == 3 && relay.in_flight == 0, "no answer: all three wait");
    body = take(11);
    CHECK(body && strstr(body, "\"n\":1") && strstr(body, "\"n\":3"), "the retry carries them all: %s",
          body ? body : "(null)");
    free(body);
    fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "gpio", "{\"n\":4}", NULL);
    fos_render_relay_commit(&relay);
    CHECK(fos_render_relay_count(&relay) == 1, "answered: what it took is gone, what came after stays");
    body = take(12);
    CHECK(body && strcmp(body, "{\"nowMs\":12,\"events\":[{\"origin\":\"driver\",\"name\":\"gpio\",\"payload\":{\"n\":4}}]}") == 0,
          "the one left: %s", body ? body : "(null)");
    free(body);
    fos_render_relay_commit(&relay);
    CHECK(fos_render_relay_count(&relay) == 0 && relay.body_bytes == 0, "empty, its bytes too");
    fos_render_relay_commit(&relay);
    CHECK(fos_render_relay_count(&relay) == 0, "a commit without a take is nothing");
}

static void test_caps(void)
{
    fresh();
    size_t dropped = 0;
    for (int i = 0; i < FOS_RENDER_RELAY_MAX_EVENTS; i++) {
        char payload[32];
        snprintf(payload, sizeof(payload), "{\"n\":%d}", i);
        fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "gpio", payload, &dropped);
        CHECK(dropped == 0, "room for %d", i);
    }
    char *body = take(1);
    free(body);
    fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "gpio", "{\"n\":32}", &dropped);
    CHECK(dropped == 1, "the 33rd pushes the oldest out");
    CHECK(fos_render_relay_count(&relay) == FOS_RENDER_RELAY_MAX_EVENTS, "never past the cap");
    CHECK(relay.events[0].payload && strcmp(relay.events[0].payload, "{\"n\":1}") == 0, "the oldest went");
    CHECK(relay.in_flight == FOS_RENDER_RELAY_MAX_EVENTS - 1, "and it was one of those in flight");
    fos_render_relay_commit(&relay);
    CHECK(fos_render_relay_count(&relay) == 1 && strcmp(relay.events[0].payload, "{\"n\":32}") == 0,
          "the commit takes what went out, not the newcomer");

    /* Bytes: events of ~5 KB each, three fit, the fourth pushes one out. */
    fresh();
    char *payload = malloc(5001);
    snprintf(payload, 5001, "{\"s\":\"");
    size_t used = strlen(payload);
    memset(payload + used, 'y', 5000 - used - 2);
    snprintf(payload + 5000 - 2, 3, "\"}");
    for (int i = 0; i < 3; i++) {
        fos_render_relay_add(&relay, FOS_ORIGIN_HTTP_ADMIN, "setSceneState", payload, &dropped);
        CHECK(dropped == 0, "%d fits", i);
    }
    fos_render_relay_add(&relay, FOS_ORIGIN_HTTP_ADMIN, "setSceneState", payload, &dropped);
    CHECK(dropped == 1 && fos_render_relay_count(&relay) == 3, "the fourth pushes one out (%zu, %zu)", dropped,
          fos_render_relay_count(&relay));
    body = take(1);
    CHECK(body && strlen(body) <= FOS_RENDER_RELAY_MAX_BODY, "the body stays under the cap (%zu)",
          body ? strlen(body) : 0);
    free(body);
    free(payload);
}

static void test_pop_and_clear(void)
{
    fresh();
    fos_render_relay_add(&relay, FOS_ORIGIN_SCHEDULE, "setCurrentScene", "{\"sceneId\":\"a\"}", NULL);
    fos_render_relay_add(&relay, FOS_ORIGIN_DRIVER, "gpio", "{\"n\":1}", NULL);
    fos_event_origin_t origin = 0;
    char name[64];
    char *payload = NULL;
    CHECK(fos_render_relay_pop(&relay, &origin, name, sizeof(name), &payload), "one to pop");
    CHECK(origin == FOS_ORIGIN_SCHEDULE && strcmp(name, "setCurrentScene") == 0 && payload &&
              strcmp(payload, "{\"sceneId\":\"a\"}") == 0,
          "the oldest, as held");
    free(payload);
    CHECK(fos_render_relay_count(&relay) == 1, "one left");
    CHECK(fos_render_relay_clear(&relay) == 1, "clear says how many went");
    CHECK(!fos_render_relay_pop(&relay, &origin, name, sizeof(name), &payload), "nothing to pop");
}

int main(void)
{
    test_body_shape();
    test_refusals();
    test_coalescing();
    test_take_commit_release();
    test_caps();
    test_pop_and_clear();
    fos_render_relay_clear(&relay);
    if (g_failures) {
        printf("test_fos_render_relay: %d of %d checks failed\n", g_failures, g_checks);
        return 1;
    }
    printf("test_fos_render_relay: %d checks passed\n", g_checks);
    return 0;
}
