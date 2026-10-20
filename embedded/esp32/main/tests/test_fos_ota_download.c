/*
 * Host tests for the OTA download bookkeeping (fos_ota_download.c): resume
 * ranges, the responses a resume accepts, the retry budget and the verdict
 * line. No IDF: fos_ota.c owns the sockets and the flash, this file only
 * decides.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_ota_download.c main/tests/test_fos_ota_download.c \
 *      -o /tmp/test_fos_ota_download && /tmp/test_fos_ota_download
 *
 * (backend/app/tasks/tests/test_esp32_ota_download.py does exactly that in CI.)
 *
 * The numbers are frame 70's (reTerminal E1004, 2026-10-20): a 3,106,000-byte
 * 2026.10.18 image whose download died 12,420 bytes in.
 */
#include <stdio.h>
#include <string.h>

#include "fos_ota_download.h"

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond, ...)                                                       \
    do {                                                                       \
        g_checks++;                                                            \
        if (!(cond)) {                                                         \
            g_failures++;                                                      \
            printf("FAIL %s:%d: ", __FILE__, __LINE__);                        \
            printf(__VA_ARGS__);                                               \
            printf("\n");                                                      \
        }                                                                      \
    } while (0)

#define IMAGE 3106000u

static void test_first_connection_asks_for_everything(void)
{
    fos_ota_dl_t dl;
    fos_ota_dl_init(&dl, IMAGE);
    char range[32] = "untouched";
    CHECK(!fos_ota_dl_begin_connection(&dl, range, sizeof(range)), "no Range on the first connection");
    CHECK(strcmp(range, "untouched") == 0, "range buffer left alone: %s", range);
    char why[32] = "";
    CHECK(fos_ota_dl_accept(&dl, 200, IMAGE, why, sizeof(why)), "200 with the manifest's size");
    CHECK(fos_ota_dl_drop(&dl, 8192) == 0, "nothing dropped on a fresh download");
    CHECK(!fos_ota_dl_accept(&dl, 206, IMAGE, why, sizeof(why)), "206 nobody asked for");
    CHECK(strcmp(why, "http 206") == 0, "why: %s", why);
    CHECK(!fos_ota_dl_accept(&dl, 404, 0, why, sizeof(why)), "404");
    CHECK(strcmp(why, "http 404") == 0, "why: %s", why);
    CHECK(!fos_ota_dl_accept(&dl, 200, 1234, why, sizeof(why)), "200 of another size");
    CHECK(strcmp(why, "length 1234") == 0, "why: %s", why);
    CHECK(fos_ota_dl_accept(&dl, 200, -1, why, sizeof(why)), "200 without a length (chunked)");
}

static void test_resume_after_a_drop(void)
{
    fos_ota_dl_t dl;
    fos_ota_dl_init(&dl, IMAGE);
    char range[32];
    char why[32];
    fos_ota_dl_begin_connection(&dl, range, sizeof(range));
    fos_ota_dl_accept(&dl, 200, IMAGE, why, sizeof(why));
    fos_ota_dl_wrote(&dl, 12420);
    CHECK(fos_ota_dl_failed(&dl, "closed"), "a connection that wrote bytes earns another");
    CHECK(dl.stalled == 0, "progress resets the stall count: %u", dl.stalled);

    CHECK(fos_ota_dl_begin_connection(&dl, range, sizeof(range)), "the second connection resumes");
    CHECK(strcmp(range, "bytes=12420-") == 0, "range: %s", range);
    CHECK(fos_ota_dl_accept(&dl, 206, IMAGE - 12420, why, sizeof(why)), "206 with the rest");
    CHECK(fos_ota_dl_drop(&dl, 8192) == 0, "a 206 body is all new bytes");
    CHECK(!fos_ota_dl_accept(&dl, 206, IMAGE, why, sizeof(why)), "206 of the wrong length");
    CHECK(strcmp(why, "range 3106000") == 0, "why: %s", why);
    CHECK(!fos_ota_dl_overflows(&dl, IMAGE - 12420), "the rest fits exactly");
    CHECK(fos_ota_dl_overflows(&dl, IMAGE - 12420 + 1), "one byte more does not");
    fos_ota_dl_wrote(&dl, IMAGE - 12420);
    CHECK(fos_ota_dl_complete(&dl), "complete at the manifest's size");
}

static void test_resume_answered_with_the_whole_image(void)
{
    fos_ota_dl_t dl;
    fos_ota_dl_init(&dl, IMAGE);
    char range[32];
    char why[32];
    fos_ota_dl_begin_connection(&dl, range, sizeof(range));
    fos_ota_dl_wrote(&dl, 10000);
    fos_ota_dl_failed(&dl, "timeout");
    fos_ota_dl_begin_connection(&dl, range, sizeof(range));
    CHECK(fos_ota_dl_accept(&dl, 200, IMAGE, why, sizeof(why)), "a 200 to a Range request is usable");
    CHECK(fos_ota_dl_drop(&dl, 8192) == 8192, "the first 8192 are already written");
    CHECK(fos_ota_dl_drop(&dl, 8192) == 1808, "then 1808 more, the rest of the chunk is new");
    CHECK(fos_ota_dl_drop(&dl, 8192) == 0, "past the skip, nothing dropped");
}

static void test_stalled_connections_give_up(void)
{
    fos_ota_dl_t dl;
    fos_ota_dl_init(&dl, IMAGE);
    char range[32];
    fos_ota_dl_begin_connection(&dl, range, sizeof(range));
    CHECK(fos_ota_dl_failed(&dl, "connect 0x7002"), "first stall");
    fos_ota_dl_begin_connection(&dl, range, sizeof(range));
    CHECK(fos_ota_dl_failed(&dl, "connect 0x7002"), "second stall");
    CHECK(!fos_ota_dl_failed(&dl, "wifi"), "the third stall in a row ends the run");
    CHECK(dl.stalled == FOS_OTA_DL_STALLED_TRIES, "stalled: %u", dl.stalled);
}

static void test_connection_cap(void)
{
    fos_ota_dl_t dl;
    fos_ota_dl_init(&dl, IMAGE);
    char range[32];
    bool again = true;
    unsigned opened = 0;
    while (again) {
        fos_ota_dl_begin_connection(&dl, range, sizeof(range));
        opened++;
        fos_ota_dl_wrote(&dl, 1000); /* every connection makes a little progress */
        again = fos_ota_dl_failed(&dl, "closed");
        CHECK(opened <= FOS_OTA_DL_MAX_CONNECTIONS, "runaway: %u connections", opened);
        if (opened > FOS_OTA_DL_MAX_CONNECTIONS) break;
    }
    CHECK(opened == FOS_OTA_DL_MAX_CONNECTIONS, "a run stops at the cap: %u", opened);
}

static void test_read_tokens(void)
{
    char token[32];
    fos_ota_dl_read_token(-FOS_OTA_DL_HTTP_EAGAIN, 0, token, sizeof(token));
    CHECK(strcmp(token, "timeout") == 0, "timeout: %s", token);
    fos_ota_dl_read_token(-1, 0, token, sizeof(token));
    CHECK(strcmp(token, "closed") == 0, "closed: %s", token);
    fos_ota_dl_read_token(-1, 104, token, sizeof(token));
    CHECK(strcmp(token, "read e104") == 0, "errno: %s", token);
}

static void test_summary(void)
{
    char out[160];
    fos_ota_dl_t dl;
    fos_ota_dl_init(&dl, IMAGE);
    char range[32];

    fos_ota_dl_begin_connection(&dl, range, sizeof(range));
    fos_ota_dl_wrote(&dl, 12420);
    fos_ota_dl_failed(&dl, "closed");
    fos_ota_dl_summary(&dl, out, sizeof(out));
    /* One failure keeps the shape the control planes have always shown. */
    CHECK(strcmp(out, "download-failed:closed@12420/3106000") == 0, "one try: %s", out);

    fos_ota_dl_begin_connection(&dl, range, sizeof(range));
    fos_ota_dl_failed(&dl, "timeout");
    fos_ota_dl_failed(&dl, "wifi");
    fos_ota_dl_summary(&dl, out, sizeof(out));
    CHECK(strcmp(out, "download-failed:wifi@12420/3106000 "
                      "(3 tries: closed@12420, timeout@12420, wifi@12420)") == 0,
          "three tries: %s", out);

    fos_ota_dl_t many;
    fos_ota_dl_init(&many, IMAGE);
    for (unsigned i = 0; i < 6; i++) {
        fos_ota_dl_begin_connection(&many, range, sizeof(range));
        fos_ota_dl_wrote(&many, 500000);
        fos_ota_dl_failed(&many, "read e113");
    }
    fos_ota_dl_summary(&many, out, sizeof(out));
    CHECK(strcmp(out, "download-failed:read e113@3000000/3106000 (6 tries, last 4: "
                      "read e113@1500000, read e113@2000000, read e113@2500000, "
                      "read e113@3000000)") == 0,
          "six tries: %s", out);
    CHECK(strlen(out) < 160, "fits the control planes' 160-char detail: %zu", strlen(out));

    fos_ota_dl_t none;
    fos_ota_dl_init(&none, 0);
    fos_ota_dl_summary(&none, out, sizeof(out));
    CHECK(strcmp(out, "download-failed:failed@0/0") == 0, "no tries: %s", out);

    char tiny[24];
    fos_ota_dl_summary(&many, tiny, sizeof(tiny));
    CHECK(strlen(tiny) == sizeof(tiny) - 1, "truncates, terminated: %s", tiny);
}

int main(void)
{
    test_first_connection_asks_for_everything();
    test_resume_after_a_drop();
    test_resume_answered_with_the_whole_image();
    test_stalled_connections_give_up();
    test_connection_cap();
    test_read_tokens();
    test_summary();
    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures ? 1 : 0;
}
