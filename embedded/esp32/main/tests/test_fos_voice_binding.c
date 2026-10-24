/*
 * Host tests for fos_voice_binding.c: which of the frame's keys the event
 * map makes voice keys (docs/voice-chat.md, docs/events.md "Event map").
 *
 * Build and run (from embedded/esp32/, with ESP-IDF's cJSON):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain -I$IDF_PATH/components/json/cJSON \
 *      $IDF_PATH/components/json/cJSON/cJSON.c \
 *      main/fos_voice_binding.c main/tests/test_fos_voice_binding.c \
 *      -lm -o /tmp/test_fos_voice_binding && /tmp/test_fos_voice_binding
 *
 * (backend/app/tasks/tests/test_esp32_voice_binding.py does exactly that in CI.)
 */
#include <stdio.h>
#include <string.h>

#include "fos_voice_binding.h"

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

#define ARROWS                                                                                   \
    "{\"event\":\"button\",\"match\":{\"label\":\"LEFT\",\"action\":\"longPress\"},"            \
    "\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"prev\"}},"                              \
    "{\"event\":\"button\",\"match\":{\"label\":\"RIGHT\",\"action\":\"longPress\"},"           \
    "\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"next\"}}"
#define VOICE_REFRESH                                                                            \
    "{\"event\":\"button\",\"match\":{\"label\":\"REFRESH\",\"action\":\"longPress\"},"         \
    "\"emit\":\"voiceChat\",\"as\":{}}"

static size_t labels_of(const char *map, char labels[][FOS_VOICE_BINDING_LABEL_LEN], size_t max)
{
    for (size_t i = 0; i < max; i++) labels[i][0] = '\0';
    return fos_voice_binding_labels(map, labels, max);
}

static void test_the_reterminal_map(void)
{
    char labels[4][FOS_VOICE_BINDING_LABEL_LEN];
    /* The E1001/E1002 preset: arrows walk the scenes, REFRESH held talks. */
    size_t n = labels_of("[" ARROWS "," VOICE_REFRESH "]", labels, 4);
    CHECK(n == 1, "one voice key, got %zu", n);
    CHECK(strcmp(labels[0], "REFRESH") == 0, "it is REFRESH, got %s", labels[0]);
    /* The E1004 preset (no microphone): the arrows alone. */
    CHECK(labels_of("[" ARROWS "]", labels, 4) == 0, "arrows only: no voice key");
}

static void test_nothing_without_a_map(void)
{
    char labels[4][FOS_VOICE_BINDING_LABEL_LEN];
    CHECK(labels_of(NULL, labels, 4) == 0, "NULL map");
    CHECK(labels_of("", labels, 4) == 0, "empty map");
    CHECK(labels_of("[]", labels, 4) == 0, "no rules");
    CHECK(labels_of("{\"event\":\"button\"}", labels, 4) == 0, "not a list");
    CHECK(labels_of("[{\"event\":\"button\",", labels, 4) == 0, "broken JSON");
    CHECK(fos_voice_binding_labels("[" VOICE_REFRESH "]", labels, 0) == 0, "no room asked for");
}

static void test_the_first_matching_rule_wins(void)
{
    char labels[4][FOS_VOICE_BINDING_LABEL_LEN];
    /* REFRESH held is a refresh first: the voice rule after it never runs. */
    size_t n = labels_of("[{\"event\":\"button\",\"match\":{\"label\":\"REFRESH\",\"action\":\"longPress\"},"
                         "\"emit\":\"render\",\"as\":{}}," VOICE_REFRESH "]", labels, 4);
    CHECK(n == 0, "a rule before it took the long press, got %zu", n);
    /* A rule on the key's every press (no action) before it also wins. */
    n = labels_of("[{\"event\":\"button\",\"match\":{\"label\":\"REFRESH\"},\"as\":{\"label\":\"A\"}},"
                  VOICE_REFRESH "]", labels, 4);
    CHECK(n == 0, "a rule on every press of the key took it, got %zu", n);
    /* A rule on another press of the key does not: a double press is not a hold. */
    n = labels_of("[{\"event\":\"button\",\"match\":{\"label\":\"REFRESH\",\"action\":\"doublePress\"},"
                  "\"emit\":\"render\",\"as\":{}}," VOICE_REFRESH "]", labels, 4);
    CHECK(n == 1 && strcmp(labels[0], "REFRESH") == 0, "another press of the key is no obstacle");
    /* The voice rule first, then a render rule for the same hold: voice. */
    n = labels_of("[" VOICE_REFRESH ",{\"event\":\"button\",\"match\":{\"label\":\"REFRESH\","
                  "\"action\":\"longPress\"},\"emit\":\"render\",\"as\":{}}]", labels, 4);
    CHECK(n == 1, "the voice rule came first, got %zu", n);
}

static void test_other_rules_and_keys(void)
{
    char labels[4][FOS_VOICE_BINDING_LABEL_LEN];
    /* Two voice keys, mixed case and a `gpio` rule in between that is not a button rule. */
    size_t n = labels_of("[{\"event\":\"button\",\"match\":{\"label\":\"left\",\"action\":\"longPress\"},"
                         "\"emit\":\"voiceChat\",\"as\":{}},"
                         "{\"event\":\"gpio\",\"match\":{\"label\":\"RIGHT\",\"action\":\"longPress\"},"
                         "\"emit\":\"voiceChat\",\"as\":{}},"
                         "{\"event\":\"button\",\"match\":{\"label\":\"RIGHT\",\"action\":\"longPress\"},"
                         "\"emit\":\"voiceChat\"}]", labels, 4);
    CHECK(n == 2, "two voice keys, got %zu", n);
    CHECK(strcmp(labels[0], "LEFT") == 0, "upper-cased, got %s", labels[0]);
    CHECK(strcmp(labels[1], "RIGHT") == 0, "the button rule, not the gpio one, got %s", labels[1]);
    /* No room for the second: the first is reported, nothing overflows. */
    n = labels_of("[{\"event\":\"button\",\"match\":{\"label\":\"LEFT\",\"action\":\"longPress\"},"
                  "\"emit\":\"voiceChat\"},{\"event\":\"button\",\"match\":{\"label\":\"RIGHT\","
                  "\"action\":\"longPress\"},\"emit\":\"voiceChat\"}]", labels, 1);
    CHECK(n == 1 && strcmp(labels[0], "LEFT") == 0, "capped at the room given");
    /* A rule matching by role, or a rewrite without emit, is not a voice key. */
    n = labels_of("[{\"event\":\"button\",\"match\":{\"role\":\"refresh\",\"action\":\"longPress\"},"
                  "\"emit\":\"voiceChat\"},{\"event\":\"button\",\"match\":{\"label\":\"LEFT\","
                  "\"action\":\"longPress\"},\"as\":{\"label\":\"A\"}}]", labels, 4);
    CHECK(n == 0, "by role or a rewrite: not a voice key, got %zu", n);
}

int main(void)
{
    test_the_reterminal_map();
    test_nothing_without_a_map();
    test_the_first_matching_rule_wins();
    test_other_rules_and_keys();
    printf("%s: %d checks, %d failures\n", g_failures ? "FAILED" : "ok", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
