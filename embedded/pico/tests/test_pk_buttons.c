// The front buttons as edges for the backend (pk_buttons.c): what is kept,
// when a batch is ready to go with the render pull, and its JSON.
#include <stdlib.h>

#include "fos_events_gen.h"
#include "pk_buttons.h"
#include "pk_test.h"

#define A 0x01u
#define B 0x02u
#define E 0x10u

static void test_a_tap_is_sent_once_its_window_closes(void)
{
    pk_buttons_t buttons;
    pk_buttons_init(&buttons, 0, 5);
    CHECK(!pk_buttons_ready(&buttons, 100));
    CHECK(pk_buttons_sample(&buttons, B, 1000) == B);
    CHECK(pk_buttons_busy(&buttons, 1000));
    CHECK(pk_buttons_sample(&buttons, 0, 1080) == 0);
    CHECK(buttons.count == 2);
    // Up: a second down may still make it a double press.
    CHECK(!pk_buttons_ready(&buttons, 1080 + FOS_BUTTON_DOUBLE_PRESS_MS));
    CHECK(pk_buttons_ready(&buttons, 1080 + FOS_BUTTON_DOUBLE_PRESS_MS + PK_BUTTON_SETTLE_SLACK_MS + 1));

    char json[PK_BUTTONS_JSON_MAX];
    size_t sent = 0;
    size_t len = pk_buttons_json(&buttons, 1600, json, sizeof(json), &sent);
    CHECK(len == strlen(json));
    CHECK(sent == 2);
    CHECK_STR(json, "{\"nowMs\":1600,\"edges\":[{\"label\":\"B\",\"action\":\"down\",\"atMs\":1000},"
                    "{\"label\":\"B\",\"action\":\"up\",\"atMs\":1080}]}");
    pk_buttons_consume(&buttons, sent);
    CHECK(buttons.count == 0 && !pk_buttons_ready(&buttons, 5000));
}

static void test_a_double_tap_travels_as_one_batch(void)
{
    pk_buttons_t buttons;
    pk_buttons_init(&buttons, 0, 0);
    pk_buttons_sample(&buttons, A, 1000);
    pk_buttons_sample(&buttons, 0, 1060);
    CHECK(pk_buttons_busy(&buttons, 1200));
    pk_buttons_sample(&buttons, A, 1200);
    pk_buttons_sample(&buttons, 0, 1260);
    // The pair is decided on the second down: nothing more to wait for.
    CHECK(buttons.count == 4);
    CHECK(pk_buttons_ready(&buttons, 1261));
}

static void test_a_held_key_is_never_sent_until_it_is_let_go(void)
{
    pk_buttons_t buttons;
    pk_buttons_init(&buttons, 0, 0);
    pk_buttons_sample(&buttons, E, 1000);
    CHECK(!pk_buttons_ready(&buttons, 60000));
    pk_buttons_sample(&buttons, E, 60000);
    pk_buttons_sample(&buttons, 0, 61000);
    // A long press is decided by its up.
    CHECK(pk_buttons_ready(&buttons, 61001));
    CHECK(buttons.edges[1].index == 4 && !buttons.edges[1].down && buttons.edges[1].at_ms == 61000);
}

static void test_bounce_is_one_edge(void)
{
    pk_buttons_t buttons;
    pk_buttons_init(&buttons, 0, 0);
    pk_buttons_sample(&buttons, A, 1000);
    pk_buttons_sample(&buttons, 0, 1010); // inside the lockout
    pk_buttons_sample(&buttons, A, 1020);
    CHECK(buttons.count == 1);
    pk_buttons_sample(&buttons, 0, 1100);
    CHECK(buttons.count == 2);
}

static void test_the_press_that_woke_the_board_starts_at_the_reset(void)
{
    pk_buttons_t buttons;
    pk_buttons_init(&buttons, B, 4);
    CHECK(buttons.count == 1 && buttons.edges[0].down && buttons.edges[0].wake && buttons.edges[0].at_ms == 0);
    CHECK(pk_buttons_busy(&buttons, 500));
    pk_buttons_sample(&buttons, 0, 180);
    CHECK(pk_buttons_ready(&buttons, 180 + FOS_BUTTON_DOUBLE_PRESS_MS + PK_BUTTON_SETTLE_SLACK_MS + 1));
    char json[PK_BUTTONS_JSON_MAX];
    pk_buttons_json(&buttons, 900, json, sizeof(json), NULL);
    CHECK(strstr(json, "{\"label\":\"B\",\"action\":\"down\",\"atMs\":0,\"wake\":true}") != NULL);
}

static void test_edges_that_come_while_a_batch_is_out_stay(void)
{
    pk_buttons_t buttons;
    pk_buttons_init(&buttons, 0, 0);
    pk_buttons_sample(&buttons, A, 1000);
    pk_buttons_sample(&buttons, 0, 1050);
    char json[PK_BUTTONS_JSON_MAX];
    size_t sent = 0;
    pk_buttons_json(&buttons, 1500, json, sizeof(json), &sent);
    pk_buttons_sample(&buttons, B, 1600); // during the pull
    pk_buttons_consume(&buttons, sent);
    CHECK(buttons.count == 1 && buttons.edges[0].index == 1 && buttons.edges[0].down);
}

static void test_a_flood_keeps_the_newest_and_always_fits(void)
{
    pk_buttons_t buttons;
    pk_buttons_init(&buttons, 0, 0);
    uint32_t t = 1000;
    for (int i = 0; i < 40; i++) {
        pk_buttons_sample(&buttons, A, t);
        pk_buttons_sample(&buttons, 0, t + 40);
        t += 500;
    }
    CHECK(buttons.count == PK_BUTTON_EDGES_MAX);
    CHECK(buttons.dropped == 80 - PK_BUTTON_EDGES_MAX);
    CHECK(buttons.edges[PK_BUTTON_EDGES_MAX - 1].at_ms == t - 500 + 40);
    char json[PK_BUTTONS_JSON_MAX];
    size_t sent = 0;
    CHECK(pk_buttons_json(&buttons, UINT32_MAX, json, sizeof(json), &sent) > 0);
    CHECK(sent == PK_BUTTON_EDGES_MAX);
    // A buffer too small says so instead of sending half a batch.
    char small[40];
    CHECK(pk_buttons_json(&buttons, 1, small, sizeof(small), &sent) == 0 && sent == 0);
}

int main(void)
{
    test_a_tap_is_sent_once_its_window_closes();
    test_a_double_tap_travels_as_one_batch();
    test_a_held_key_is_never_sent_until_it_is_let_go();
    test_bounce_is_one_edge();
    test_the_press_that_woke_the_board_starts_at_the_reset();
    test_edges_that_come_while_a_batch_is_out_stay();
    test_a_flood_keeps_the_newest_and_always_fits();
    return pk_test_result("test_pk_buttons");
}
