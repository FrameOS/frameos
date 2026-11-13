/*
 * Host tests for the relay of a frame rendered on its control plane
 * (fos_render_relay.c, docs/server-rendering.md "Keys, touch and the
 * schedule"). Pure: no IDF.
 *
 * Build and run (from the repository root):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Iembedded/esp32/main \
 *      embedded/esp32/main/fos_render_relay.c embedded/esp32/main/fos_json_guard.c \
 *      embedded/esp32/main/tests/test_fos_render_relay.c \
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
static unsigned dropped;

static void fresh(void)
{
    fos_render_relay_drop(&relay, relay.count);
    memset(&relay, 0, sizeof(relay));
}

static bool add(const char *origin, const char *name, const char *payload)
{
    return fos_render_relay_add(&relay, origin, name, payload, &dropped);
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
    CHECK(add("driver", "gpio", "{\"pin\":3,\"label\":\"RIGHT\",\"level\":0,\"action\":\"down\",\"atMs\":80410}"),
          "a key edge is held");
    CHECK(add("schedule", "setCurrentScene", "{\"sceneId\":\"news\"}"), "a schedule entry is held");
    CHECK(add("http:admin", "render", NULL), "no payload is {}");
    CHECK(add("http:write", "myEvent", ""), "an empty payload is {}");
    CHECK(relay.count == 4, "four held");
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
    CHECK(!add("driver", "a\"b", "{}"), "a quote in a name");
    CHECK(!add("driver", "a\\b", "{}"), "a backslash in a name");
    const char *bad[] = {"[1,2]", "\"text\"", "42", "{", "{\"a\":1", " x{}", "{\"a\":1} x"};
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        CHECK(!add("http:admin", "setSceneState", bad[i]), "not one JSON object: %s", bad[i]);
    }
    CHECK(add("http:admin", "setSceneState", " {\"state\":{\"text\":\"a } ]\",\"list\":[1,{\"b\":[]}]}}\n"),
          "brackets inside strings, nesting and blanks around are fine");
    CHECK(relay.count == 1, "only the good one is held");
    /* One event bigger than a body on its own. */
    size_t big = FOS_RENDER_RELAY_MAX_BODY;
    char *huge = malloc(big + 16);
    snprintf(huge, big + 16, "{\"s\":\"");
    size_t used = strlen(huge);
    memset(huge + used, 'x', big - used);
    snprintf(huge + big, 16, "\"}");
    CHECK(!add("http:admin", "setSceneState", huge), "an event bigger than a body");
    free(huge);
    CHECK(relay.count == 1, "and the one held stays");
}

static void test_take_and_answer(void)
{
    fresh();
    add("driver", "gpio", "{\"n\":1}");
    add("driver", "gpio", "{\"n\":2}");
    char *body = take(10);
    free(body);
    CHECK(relay.in_flight == 2, "both went out");
    add("schedule", "render", "{\"n\":3}");
    relay.in_flight = 0; /* no answer */
    CHECK(relay.count == 3, "no answer: all three wait");
    body = take(11);
    CHECK(body && strstr(body, "\"n\":1") && strstr(body, "\"n\":3"), "the retry carries them all: %s",
          body ? body : "(null)");
    free(body);
    add("driver", "gpio", "{\"n\":4}");
    fos_render_relay_drop(&relay, relay.in_flight); /* answered */
    CHECK(relay.count == 1 && relay.in_flight == 0, "what it took is gone, what came after stays");
    body = take(12);
    CHECK(body && strcmp(body, "{\"nowMs\":12,\"events\":[{\"origin\":\"driver\",\"name\":\"gpio\",\"payload\":{\"n\":4}}]}") == 0,
          "the one left: %s", body ? body : "(null)");
    free(body);
    fos_render_relay_drop(&relay, relay.in_flight);
    CHECK(relay.count == 0 && relay.body == 0, "empty, its bytes too");
    fos_render_relay_drop(&relay, relay.in_flight);
    CHECK(relay.count == 0, "an answer without a take is nothing");
}

static void test_caps(void)
{
    fresh();
    for (int i = 0; i < FOS_RENDER_RELAY_MAX_EVENTS; i++) {
        char payload[32];
        snprintf(payload, sizeof(payload), "{\"n\":%d}", i);
        add("driver", "gpio", payload);
        CHECK(dropped == 0, "room for %d", i);
    }
    char *body = take(1);
    free(body);
    add("driver", "gpio", "{\"n\":32}");
    CHECK(dropped == 1, "the 33rd pushes the oldest out");
    CHECK(relay.count == FOS_RENDER_RELAY_MAX_EVENTS, "never past the cap");
    CHECK(strstr(relay.events[0], "{\"n\":1}") != NULL, "the oldest went");
    CHECK(relay.in_flight == FOS_RENDER_RELAY_MAX_EVENTS - 1, "and it was one of those in flight");
    fos_render_relay_drop(&relay, relay.in_flight);
    CHECK(relay.count == 1 && strstr(relay.events[0], "{\"n\":32}") != NULL,
          "the answer takes what went out, not the newcomer");

    /* Bytes: events of ~5 KB each, three fit, the fourth pushes one out. */
    fresh();
    char *payload = malloc(5001);
    snprintf(payload, 5001, "{\"s\":\"");
    size_t used = strlen(payload);
    memset(payload + used, 'y', 5000 - used - 2);
    snprintf(payload + 5000 - 2, 3, "\"}");
    for (int i = 0; i < 3; i++) {
        add("http:admin", "setSceneState", payload);
        CHECK(dropped == 0, "%d fits", i);
    }
    add("http:admin", "setSceneState", payload);
    CHECK(dropped == 1 && relay.count == 3, "the fourth pushes one out (%u, %u)", dropped, relay.count);
    body = take(-9223372036854775807LL - 1);
    CHECK(body && strlen(body) <= FOS_RENDER_RELAY_MAX_BODY, "the body stays under the cap, the longest clock too (%zu)",
          body ? strlen(body) : 0);
    free(body);
    free(payload);
    fresh();
}

int main(void)
{
    test_body_shape();
    test_refusals();
    test_take_and_answer();
    test_caps();
    if (g_failures) {
        printf("test_fos_render_relay: %d of %d checks failed\n", g_failures, g_checks);
        return 1;
    }
    printf("test_fos_render_relay: %d checks passed\n", g_checks);
    return 0;
}
