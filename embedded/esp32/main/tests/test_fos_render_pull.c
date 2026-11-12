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

int main(void)
{
    test_outcome();
    test_url();
    test_remember();
    test_if_none_match();
    test_refused_now();
    test_next_render_seconds();
    if (g_failures) {
        printf("%d of %d checks failed\n", g_failures, g_checks);
        return 1;
    }
    printf("test_fos_render_pull: %d checks passed\n", g_checks);
    return 0;
}
