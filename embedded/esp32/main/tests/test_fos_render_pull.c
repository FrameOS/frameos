/*
 * Host tests for the render pull of a frame rendered on its control plane
 * (fos_render_pull.c, docs/server-rendering.md). Pure: no IDF.
 *
 * Build and run (from the repository root):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Iembedded/esp32/main \
 *      embedded/esp32/main/fos_render_pull.c embedded/esp32/main/tests/test_fos_render_pull.c \
 *      -o /tmp/test_fos_render_pull && /tmp/test_fos_render_pull
 *
 * (the ESP32 job of .github/workflows/e2e-docker.yml runs exactly that.)
 */
#include <stdio.h>
#include <string.h>

#include "fos_render_pull.h"

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

static void test_outcome(void)
{
    CHECK(fos_render_pull_outcome(200, FOS_RENDER_PULL_CLOUD) == FOS_RENDER_PULL_PICTURE, "200 is a picture");
    CHECK(fos_render_pull_outcome(304, FOS_RENDER_PULL_BACKEND) == FOS_RENDER_PULL_UNCHANGED, "304 is unchanged");
    CHECK(fos_render_pull_outcome(403, FOS_RENDER_PULL_CLOUD) == FOS_RENDER_PULL_REFUSED,
          "the cloud's 403 is a refusal");
    CHECK(fos_render_pull_outcome(403, FOS_RENDER_PULL_BACKEND) == FOS_RENDER_PULL_FAILED,
          "a backend never refuses: its 403 is a failure");
    CHECK(fos_render_pull_outcome(0, FOS_RENDER_PULL_CLOUD) == FOS_RENDER_PULL_FAILED, "no answer");
    CHECK(fos_render_pull_outcome(503, FOS_RENDER_PULL_CLOUD) == FOS_RENDER_PULL_FAILED, "busy is a failure");
    CHECK(fos_render_pull_outcome(401, FOS_RENDER_PULL_CLOUD) == FOS_RENDER_PULL_FAILED, "401 is a failure");
}

static void test_url(void)
{
    char url[256];
    CHECK(fos_render_pull_url(url, sizeof(url), "https://cloud.frameos.net/", "4b1c-uuid", 800, 480, 1, 0),
          "a cloud URL fits");
    CHECK(strcmp(url, "https://cloud.frameos.net/api/frames/4b1c-uuid/embedded/render"
                      "?width=800&height=480&format=1&rotate=0") == 0,
          "cloud URL: got %s", url);

    CHECK(fos_render_pull_url(url, sizeof(url), "http://10.0.0.2:8989", "12", 1200, 1600, 7, 90),
          "a backend URL fits");
    CHECK(strcmp(url, "http://10.0.0.2:8989/api/frames/12/embedded/render"
                      "?width=1200&height=1600&format=7&rotate=90") == 0,
          "backend URL: got %s", url);

    char tiny[40];
    CHECK(!fos_render_pull_url(tiny, sizeof(tiny), "https://cloud.frameos.net", "uuid", 800, 480, 1, 0),
          "a URL that does not fit is refused");
    CHECK(tiny[0] == '\0', "and leaves nothing behind");
    CHECK(!fos_render_pull_url(url, sizeof(url), "", "1", 1, 1, 1, 0), "no base, no URL");
    CHECK(!fos_render_pull_url(url, sizeof(url), "//", "1", 1, 1, 1, 0), "slashes alone are no base");
    CHECK(!fos_render_pull_url(url, sizeof(url), "http://h", "", 1, 1, 1, 0), "no frame, no URL");
}

static void test_remember(void)
{
    uint8_t sha[FOS_RENDER_PULL_SHA_LEN];
    memset(sha, 0xAB, sizeof(sha));
    fos_render_pull_shown_t kept;
    fos_render_pull_remember(&kept, FOS_RENDER_PULL_CLOUD, "\"0123abcd\"", sha);
    CHECK(kept.valid && strcmp(kept.etag, "\"0123abcd\"") == 0, "a quoted ETag is kept");
    fos_render_pull_remember(&kept, FOS_RENDER_PULL_CLOUD, "W/\"x\"", sha);
    CHECK(kept.valid && strcmp(kept.etag, "W/\"x\"") == 0, "a weak ETag is kept as sent");
    fos_render_pull_remember(&kept, FOS_RENDER_PULL_CLOUD, "\"a\r\nX-Injected: 1\"", sha);
    CHECK(!kept.valid && kept.etag[0] == '\0', "no CR/LF, and a refused ETag leaves nothing");
    fos_render_pull_remember(&kept, FOS_RENDER_PULL_CLOUD, "\"caf\xc3\xa9\"", sha);
    CHECK(!kept.valid, "printable ASCII only");
    fos_render_pull_remember(&kept, FOS_RENDER_PULL_CLOUD, "", sha);
    CHECK(!kept.valid, "empty is not an ETag");
    char long_tag[200];
    memset(long_tag, 'a', sizeof(long_tag) - 1);
    long_tag[sizeof(long_tag) - 1] = '\0';
    fos_render_pull_remember(&kept, FOS_RENDER_PULL_CLOUD, long_tag, sha);
    CHECK(!kept.valid, "too long to keep");
}

static void test_if_none_match(void)
{
    uint8_t sha[FOS_RENDER_PULL_SHA_LEN];
    uint8_t other[FOS_RENDER_PULL_SHA_LEN];
    memset(sha, 0xAB, sizeof(sha));
    memset(other, 0xCD, sizeof(other));
    fos_render_pull_shown_t kept;
    fos_render_pull_forget(&kept);
    CHECK(fos_render_pull_if_none_match(&kept, FOS_RENDER_PULL_CLOUD, sha, false) == NULL, "nothing kept");

    fos_render_pull_remember(&kept, FOS_RENDER_PULL_CLOUD, "\"e1\"", sha);
    const char *sent = fos_render_pull_if_none_match(&kept, FOS_RENDER_PULL_CLOUD, sha, false);
    CHECK(sent != NULL && strcmp(sent, "\"e1\"") == 0, "the panel shows the picture: its ETag goes");
    CHECK(fos_render_pull_if_none_match(&kept, FOS_RENDER_PULL_CLOUD, other, false) == NULL,
          "something else is on the panel (a local render, a status screen)");
    CHECK(fos_render_pull_if_none_match(&kept, FOS_RENDER_PULL_CLOUD, NULL, false) == NULL,
          "what the panel shows is not known (forgotten after an overlay)");
    CHECK(fos_render_pull_if_none_match(&kept, FOS_RENDER_PULL_BACKEND, sha, false) == NULL,
          "another plane's ETag is meaningless");
    CHECK(fos_render_pull_if_none_match(&kept, FOS_RENDER_PULL_CLOUD, sha, true) == NULL,
          "an overlay is due: a 304 leaves nothing to draw it on");

    fos_render_pull_remember(&kept, FOS_RENDER_PULL_CLOUD, "bad\nvalue", sha);
    CHECK(!kept.valid, "an ETag that cannot go back out is not kept");
    fos_render_pull_remember(&kept, FOS_RENDER_PULL_NONE, "\"e1\"", sha);
    CHECK(!kept.valid, "no source, no ETag");
    fos_render_pull_remember(&kept, FOS_RENDER_PULL_BACKEND, "\"e2\"", sha);
    fos_render_pull_forget(&kept);
    CHECK(fos_render_pull_if_none_match(&kept, FOS_RENDER_PULL_BACKEND, sha, false) == NULL, "forgotten");
}

static void test_refused_now(void)
{
    const int64_t now = 1800000000; /* 2027 */
    CHECK(!fos_render_pull_refused_now(0, now), "never refused");
    CHECK(fos_render_pull_refused_now(now + FOS_RENDER_PULL_REFUSED_RETRY_S, now), "refused for the hour");
    CHECK(!fos_render_pull_refused_now(now, now), "the hour is up: ask again");
    CHECK(!fos_render_pull_refused_now(now + 60, 1000), "no clock: ask again");
}

static void test_next_render_seconds(void)
{
    CHECK(fos_render_pull_next_render_seconds("60") == 60, "a minute");
    CHECK(fos_render_pull_next_render_seconds(" 300 ") == 300, "spaces around it");
    CHECK(fos_render_pull_next_render_seconds(NULL) == 0, "no header");
    CHECK(fos_render_pull_next_render_seconds("") == 0, "empty");
    CHECK(fos_render_pull_next_render_seconds("abc") == 0, "not a number");
    CHECK(fos_render_pull_next_render_seconds("60s") == 0, "a unit is not ours");
    CHECK(fos_render_pull_next_render_seconds("-5") == 0, "negative");
    CHECK(fos_render_pull_next_render_seconds("1.5") == 0, "whole seconds only");
    CHECK(fos_render_pull_next_render_seconds("0") == 0, "zero means none");
    CHECK(fos_render_pull_next_render_seconds("604800") == 604800, "a week");
    CHECK(fos_render_pull_next_render_seconds("604801") == FOS_RENDER_PULL_NEXT_RENDER_MAX_S, "past a week: a week");
    CHECK(fos_render_pull_next_render_seconds("99999999999999") == FOS_RENDER_PULL_NEXT_RENDER_MAX_S, "no overflow");
}

static void test_fosb_header(void)
{
    fos_fosb_header_t h;
    const uint8_t v1[FOS_FOSB_HEADER_LEN] = {'F', 'O', 'S', 'B', 1, 8, 0x50, 0x07, 0x7c, 0x05, 0xAA, 0x55};
    CHECK(fos_fosb_header(v1, &h), "version 1");
    CHECK(h.version == 1 && h.format == 8 && h.width == 1872 && h.height == 1404, "its fields");
    CHECK(h.flags == 0, "version 1's reserved word is no flags, whatever it holds");

    const uint8_t v2[FOS_FOSB_HEADER_LEN] = {'F', 'O', 'S', 'B', 2, 1, 0x20, 0x03, 0xe0, 0x01, 3, 0};
    CHECK(fos_fosb_header(v2, &h), "version 2");
    CHECK(h.version == 2 && h.width == 800 && h.height == 480, "its size");
    CHECK(h.flags == (FOS_FOSB_DELTA | FOS_FOSB_DEFLATE), "a deflated delta");

    const uint8_t whole[FOS_FOSB_HEADER_LEN] = {'F', 'O', 'S', 'B', 2, 1, 0x20, 0x03, 0xe0, 0x01, 2, 0};
    CHECK(fos_fosb_header(whole, &h) && h.flags == FOS_FOSB_DEFLATE, "the picture whole, deflated");
    const uint8_t raw[FOS_FOSB_HEADER_LEN] = {'F', 'O', 'S', 'B', 2, 1, 0x20, 0x03, 0xe0, 0x01, 1, 0};
    CHECK(!fos_fosb_header(raw, &h), "version 2 is always deflated");
    const uint8_t unknown_flag[FOS_FOSB_HEADER_LEN] = {'F', 'O', 'S', 'B', 2, 1, 0x20, 0x03, 0xe0, 0x01, 6, 0};
    CHECK(!fos_fosb_header(unknown_flag, &h), "a flag this does not know");
    const uint8_t v3[FOS_FOSB_HEADER_LEN] = {'F', 'O', 'S', 'B', 3, 1, 0x20, 0x03, 0xe0, 0x01, 0, 0};
    CHECK(!fos_fosb_header(v3, &h), "a version this does not read");
    const uint8_t other[FOS_FOSB_HEADER_LEN] = {'P', 'N', 'G', '!', 1, 1, 0x20, 0x03, 0xe0, 0x01, 0, 0};
    CHECK(!fos_fosb_header(other, &h), "not a FOSB");
}

static void put_le32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

/* Feed `payload` in pieces of `piece` bytes. */
static bool feed_in_pieces(fos_fosb_writer_t *w, const uint8_t *payload, size_t len, size_t piece)
{
    for (size_t at = 0; at < len; at += piece) {
        size_t n = len - at < piece ? len - at : piece;
        if (!fos_fosb_writer_feed(w, payload + at, n)) return false;
    }
    return fos_fosb_writer_done(w);
}

static void test_fosb_writer_whole(void)
{
    uint8_t buf[16];
    uint8_t picture[16];
    for (int i = 0; i < 16; i++) picture[i] = (uint8_t)(0xA0 + i);
    for (size_t piece = 1; piece <= 16; piece++) {
        fos_fosb_writer_t w;
        memset(buf, 0, sizeof(buf));
        fos_fosb_writer_begin(&w, buf, sizeof(buf), false);
        CHECK(feed_in_pieces(&w, picture, sizeof(picture), piece), "whole, pieces of %zu", piece);
        CHECK(memcmp(buf, picture, sizeof(buf)) == 0, "the picture, pieces of %zu", piece);
    }
    fos_fosb_writer_t w;
    fos_fosb_writer_begin(&w, buf, sizeof(buf), false);
    CHECK(fos_fosb_writer_feed(&w, picture, 15) && !fos_fosb_writer_done(&w), "a byte short is not done");
    CHECK(!fos_fosb_writer_feed(&w, picture, 2), "a byte over is malformed");
    CHECK(!fos_fosb_writer_feed(&w, picture, 1), "and stays so");
    CHECK(!fos_fosb_writer_done(&w), "never done");
}

static void test_fosb_writer_delta(void)
{
    /* Two runs over a picture of 32 bytes: 4 bytes at 2, 3 bytes at 29. */
    uint8_t payload[8 + 4 + 8 + 3];
    put_le32(payload, 2);
    put_le32(payload + 4, 4);
    memcpy(payload + 8, "\x11\x22\x33\x44", 4);
    put_le32(payload + 12, 29);
    put_le32(payload + 16, 3);
    memcpy(payload + 20, "\x55\x66\x77", 3);
    uint8_t expected[32];
    for (int i = 0; i < 32; i++) expected[i] = (uint8_t)i;
    memcpy(expected + 2, "\x11\x22\x33\x44", 4);
    memcpy(expected + 29, "\x55\x66\x77", 3);
    for (size_t piece = 1; piece <= sizeof(payload); piece++) {
        uint8_t buf[32];
        for (int i = 0; i < 32; i++) buf[i] = (uint8_t)i;
        fos_fosb_writer_t w;
        fos_fosb_writer_begin(&w, buf, sizeof(buf), true);
        CHECK(feed_in_pieces(&w, payload, sizeof(payload), piece), "delta, pieces of %zu", piece);
        CHECK(memcmp(buf, expected, sizeof(buf)) == 0, "the runs over the picture, pieces of %zu", piece);
        CHECK(w.runs == 2, "two runs");
    }

    uint8_t buf[32] = {0};
    fos_fosb_writer_t w;
    fos_fosb_writer_begin(&w, buf, sizeof(buf), true);
    CHECK(fos_fosb_writer_feed(&w, NULL, 0) && fos_fosb_writer_done(&w), "no runs: nothing changed");

    uint8_t past[8 + 4];
    put_le32(past, 30);
    put_le32(past + 4, 4);
    fos_fosb_writer_begin(&w, buf, sizeof(buf), true);
    CHECK(!fos_fosb_writer_feed(&w, past, sizeof(past)), "a run past the picture");
    put_le32(past, 0);
    put_le32(past + 4, 0);
    fos_fosb_writer_begin(&w, buf, sizeof(buf), true);
    CHECK(!fos_fosb_writer_feed(&w, past, 8), "an empty run");
    put_le32(past, 0xFFFFFFF0u);
    put_le32(past + 4, 0x20);
    fos_fosb_writer_begin(&w, buf, sizeof(buf), true);
    CHECK(!fos_fosb_writer_feed(&w, past, 8), "no wrap-around");

    fos_fosb_writer_begin(&w, buf, sizeof(buf), true);
    CHECK(fos_fosb_writer_feed(&w, payload, 10) && !fos_fosb_writer_done(&w), "stopped inside a run");
    fos_fosb_writer_begin(&w, buf, sizeof(buf), true);
    CHECK(fos_fosb_writer_feed(&w, payload, 5) && !fos_fosb_writer_done(&w), "stopped inside a run's header");
}

static void test_press_map(void)
{
    fos_press_rect_t map[FOS_PRESS_MAP_MAX];
    int n = fos_press_map_parse("10,20,110,70;!0,0,200,100;0,0,400,300", map, FOS_PRESS_MAP_MAX);
    CHECK(n == 3, "three entries, got %d", n);
    CHECK(map[0].taken && map[0].x0 == 10 && map[0].y0 == 20 && map[0].x1 == 110 && map[0].y1 == 70, "the first");
    CHECK(!map[1].taken, "the second is not taken");
    CHECK(fos_press_map_takes(map, n, 10, 20), "the corner of the first");
    CHECK(fos_press_map_takes(map, n, 109, 69), "its last pixel");
    CHECK(!fos_press_map_takes(map, n, 110, 69), "its right edge is past it: the second answers, untaken");
    CHECK(!fos_press_map_takes(map, n, 150, 50), "inside the untaken one, over the third");
    CHECK(fos_press_map_takes(map, n, 250, 50), "the third");
    CHECK(!fos_press_map_takes(map, n, 450, 50), "in none");
    CHECK(!fos_press_map_takes(map, 0, 10, 20), "an empty map takes nothing");

    CHECK(fos_press_map_parse("", map, FOS_PRESS_MAP_MAX) == 0, "nothing");
    CHECK(fos_press_map_parse(" 1,2,3,4", map, FOS_PRESS_MAP_MAX) == -1, "no spaces: the planes send none");
    CHECK(fos_press_map_parse("5,5,5,9", map, FOS_PRESS_MAP_MAX) == 0, "an empty rectangle is left out");
    CHECK(fos_press_map_parse(NULL, map, FOS_PRESS_MAP_MAX) == -1, "no header");
    CHECK(fos_press_map_parse("1,2,3", map, FOS_PRESS_MAP_MAX) == -1, "three numbers");
    CHECK(fos_press_map_parse("1,2,3,4,5", map, FOS_PRESS_MAP_MAX) == -1, "five numbers");
    CHECK(fos_press_map_parse("1,2,3,x", map, FOS_PRESS_MAP_MAX) == -1, "not a number");
    CHECK(fos_press_map_parse("1,2,3,70000", map, FOS_PRESS_MAP_MAX) == -1, "past a panel");
    CHECK(fos_press_map_parse("-1,2,3,4", map, FOS_PRESS_MAP_MAX) == -1, "negative");

    n = fos_press_map_parse("0,0,10,10;!0,0,100,100;0,0,200,200", map, 1);
    CHECK(n == 1, "cut at the most it keeps");
    CHECK(!fos_press_map_takes(map, n, 150, 150), "what was cut is not clicked at");
}

int main(void)
{
    test_outcome();
    test_url();
    test_remember();
    test_if_none_match();
    test_refused_now();
    test_next_render_seconds();
    test_fosb_header();
    test_fosb_writer_whole();
    test_fosb_writer_delta();
    test_press_map();
    if (g_failures) {
        printf("%d of %d checks failed\n", g_failures, g_checks);
        return 1;
    }
    printf("test_fos_render_pull: %d checks passed\n", g_checks);
    return 0;
}
