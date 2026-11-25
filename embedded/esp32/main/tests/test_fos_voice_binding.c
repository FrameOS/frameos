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

static void test_the_keys_bound_three_times(void)
{
    char labels[4][FOS_VOICE_BINDING_LABEL_LEN];
    /* The reTerminal Sticky's AI key: pressed twice back, three times the
     * scene list, held talks. Only the triplePress rule counts, whatever it
     * emits (a rewrite too); a rule naming no action does not. */
    size_t n = fos_voice_binding_triple_labels(
        "[{\"event\":\"button\",\"match\":{\"label\":\"AI\",\"action\":\"doublePress\"},\"emit\":\"back\",\"as\":{}},"
        "{\"event\":\"button\",\"match\":{\"label\":\"ai\",\"action\":\"triplePress\"},\"emit\":\"sceneSwitcher\",\"as\":{}},"
        "{\"event\":\"button\",\"match\":{\"label\":\"AI\",\"action\":\"longPress\"},\"emit\":\"voiceChat\",\"as\":{}},"
        "{\"event\":\"button\",\"match\":{\"label\":\"UP\"},\"emit\":\"render\"},"
        "{\"event\":\"button\",\"match\":{\"label\":\"DOWN\",\"action\":\"triplePress\"},\"as\":{\"label\":\"A\"}}]",
        labels, 4);
    CHECK(n == 2, "AI and DOWN, got %zu", n);
    CHECK(n == 2 && strcmp(labels[0], "AI") == 0 && strcmp(labels[1], "DOWN") == 0, "upper-cased, in map order");
    CHECK(fos_voice_binding_labels("[{\"event\":\"button\",\"match\":{\"label\":\"AI\",\"action\":\"triplePress\"},"
                                   "\"emit\":\"voiceChat\"}]", labels, 4) == 0,
          "a triple press bound to voiceChat is no voice key");
    CHECK(fos_voice_binding_triple_labels("", labels, 4) == 0, "no map, no keys");
}

#define EDGE(edge, emit) "{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"" edge "\"},\"emit\":\"" emit "\",\"as\":{}}"

static void test_the_way_to_the_frame_page(void)
{
    char way[64];
    /* The Sticky's preset: its keys first, the edge swipes after. The
     * settings' swipe wins over the AI key's thrice, which is the list. */
    const char *sticky =
        "[{\"event\":\"button\",\"match\":{\"label\":\"AI\",\"action\":\"triplePress\"},\"emit\":\"sceneSwitcher\",\"as\":{}},"
        "{\"event\":\"button\",\"match\":{\"label\":\"AI\",\"action\":\"longPress\"},\"emit\":\"voiceChat\",\"as\":{}}," EDGE(
            "bottom", "sceneSwitcher") "," EDGE("top", "sceneSettings") "]";
    CHECK(fos_voice_binding_page_way(sticky, way, sizeof(way)) == FOS_VOICE_PAGE_GEAR, "the panel, then its gear");
    CHECK(strcmp(way, "swipe down from the top") == 0, "got %s", way);

    /* No settings rule: the list's, the first in the map. The AI key reads
     * as the Action key, its third press as thrice. */
    const char *no_settings =
        "[{\"event\":\"button\",\"match\":{\"label\":\"AI\",\"action\":\"triplePress\"},\"emit\":\"sceneSwitcher\",\"as\":{}}," EDGE(
            "bottom", "sceneSwitcher") "]";
    CHECK(fos_voice_binding_page_way(no_settings, way, sizeof(way)) == FOS_VOICE_PAGE_GEAR, "the list, then its gear");
    CHECK(strcmp(way, "press the Action key thrice") == 0, "got %s", way);
    CHECK(fos_voice_binding_page_way("[" EDGE("bottom", "sceneSwitcher") "]", way, sizeof(way)) == FOS_VOICE_PAGE_GEAR &&
              strcmp(way, "swipe up from the bottom") == 0,
          "got %s", way);

    /* Straight onto the frame page: no gear to tap. */
    CHECK(fos_voice_binding_page_way("[{\"event\":\"button\",\"match\":{\"label\":\"KEY1\",\"action\":\"doublePress\"},"
                                     "\"emit\":\"sceneSettings\",\"as\":{\"page\":\"frame\"}}," EDGE("left", "back") "]",
                                     way, sizeof(way)) == FOS_VOICE_PAGE_OPEN,
          "page frame opens it");
    CHECK(strcmp(way, "press the KEY1 key twice") == 0, "got %s", way);
    CHECK(fos_voice_binding_page_way("[{\"event\":\"button\",\"match\":{\"label\":\"UP\",\"action\":\"longPress\"},"
                                     "\"emit\":\"sceneSettings\",\"as\":{}}," EDGE("right", "forward") "]",
                                     way, sizeof(way)) == FOS_VOICE_PAGE_GEAR &&
              strcmp(way, "hold the UP key") == 0,
          "got %s", way);

    /* A board of keys alone (the reTerminal E1002's): the gear wants a
     * finger, so a key's rule is no way there. */
    CHECK(fos_voice_binding_page_way("[{\"event\":\"button\",\"match\":{\"label\":\"REFRESH\",\"action\":\"doublePress\"},"
                                     "\"emit\":\"sceneSwitcher\",\"as\":{}}," VOICE_REFRESH "]",
                                     way, sizeof(way)) == FOS_VOICE_PAGE_NONE,
          "keys alone");
    CHECK(way[0] == '\0', "no words, got %s", way);

    /* Nothing to put into words, no map, a broken one. */
    CHECK(fos_voice_binding_page_way("[{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"middle\"},\"emit\":\"sceneSettings\"}]",
                                     way, sizeof(way)) == FOS_VOICE_PAGE_NONE,
          "an edge it does not know");
    CHECK(fos_voice_binding_page_way("[" ARROWS "]", way, sizeof(way)) == FOS_VOICE_PAGE_NONE, "no such rule");
    CHECK(fos_voice_binding_page_way("", way, sizeof(way)) == FOS_VOICE_PAGE_NONE, "no map");
    CHECK(fos_voice_binding_page_way("{", way, sizeof(way)) == FOS_VOICE_PAGE_NONE, "unparsable");
    CHECK(fos_voice_binding_page_way(NULL, way, sizeof(way)) == FOS_VOICE_PAGE_NONE, "null");

    /* Cut to the room given, never past it. */
    char small[8];
    CHECK(fos_voice_binding_page_way(sticky, small, sizeof(small)) == FOS_VOICE_PAGE_GEAR, "cut, still a way");
    CHECK(strlen(small) == sizeof(small) - 1, "cut to %zu, got %zu", sizeof(small) - 1, strlen(small));
}

int main(void)
{
    test_the_reterminal_map();
    test_nothing_without_a_map();
    test_the_first_matching_rule_wins();
    test_other_rules_and_keys();
    test_the_keys_bound_three_times();
    test_the_way_to_the_frame_page();
    printf("%s: %d checks, %d failures\n", g_failures ? "FAILED" : "ok", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
