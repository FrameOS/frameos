/*
 * Host tests for the release version ordering behind the OTA downgrade check.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Icomponents/frameos_nim/include \
 *      components/frameos_nim/fos_version.c main/tests/test_fos_version.c \
 *      -o /tmp/test_fos_version && /tmp/test_fos_version
 *
 * (backend/app/tasks/tests/test_esp32_version.py does exactly that in CI.)
 *
 * The bias under test: a wrong "downgrade" silences the update channel for a
 * board until someone types `ota downgrade` on its console; a wrong "not a
 * downgrade" lets a control plane roll a frame back to a release with a known
 * hole. So both directions are pinned, and every unparseable input must come
 * back "not a downgrade" — refusing on a naming change would be the silent
 * failure.
 */
#include <stdio.h>
#include <string.h>

#include "fos_version.h"

static int checks = 0;
static int failures = 0;

#define CHECK(cond)                                                                    \
    do {                                                                               \
        checks++;                                                                      \
        if (!(cond)) {                                                                 \
            failures++;                                                                \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);                    \
        }                                                                              \
    } while (0)

static void test_parse(void)
{
    unsigned parts[FOS_VERSION_PARTS_MAX];
    size_t count = 0;
    CHECK(fos_version_parse("2026.9.9", parts, &count));
    CHECK(count == 3 && parts[0] == 2026 && parts[1] == 9 && parts[2] == 9 && parts[3] == 0);
    CHECK(fos_version_parse("v2026.9.10", parts, &count));
    CHECK(count == 3 && parts[2] == 10);
    CHECK(fos_version_parse("2026.9", parts, &count));
    CHECK(count == 2 && parts[2] == 0);
    CHECK(fos_version_parse("2026.9.9-rc1", parts, &count));
    CHECK(count == 3 && parts[2] == 9);
    CHECK(fos_version_parse("2026.9.9+abc123", parts, &count));
    CHECK(fos_version_parse("1.2.3.4", parts, &count));
    CHECK(count == 4 && parts[3] == 4);

    CHECK(!fos_version_parse("", parts, &count));
    CHECK(!fos_version_parse(NULL, parts, &count));
    CHECK(!fos_version_parse("dev", parts, &count));
    CHECK(!fos_version_parse("2026.x.9", parts, &count));
    CHECK(!fos_version_parse("2026..9", parts, &count));
    CHECK(!fos_version_parse("2026.9.9.9.9", parts, &count));
    CHECK(!fos_version_parse("2026.9.9beta", parts, &count));
    CHECK(!fos_version_parse("v", parts, &count));
    CHECK(!fos_version_parse("-1.2", parts, &count));
}

static void test_compare(void)
{
    CHECK(fos_version_compare("2026.9.9", "2026.9.9") == 0);
    CHECK(fos_version_compare("v2026.9.9", "2026.9.9") == 0);
    CHECK(fos_version_compare("2026.9.9-rc1", "2026.9.9") == 0);
    CHECK(fos_version_compare("2026.9.10", "2026.9.9") > 0);
    CHECK(fos_version_compare("2026.9.9", "2026.9.10") < 0);
    CHECK(fos_version_compare("2026.10.0", "2026.9.99") > 0);
    CHECK(fos_version_compare("2027.1.0", "2026.12.31") > 0);
    CHECK(fos_version_compare("2026.9", "2026.9.0") == 0);
    CHECK(fos_version_compare("2026.9", "2026.9.1") < 0);
    /* Unparseable on either side: no ordering, never a downgrade. */
    CHECK(fos_version_compare("dev", "2026.9.9") == 0);
    CHECK(fos_version_compare("2026.9.9", "") == 0);
}

static void test_downgrade(void)
{
    CHECK(fos_version_is_downgrade("2026.9.8", "2026.9.9"));
    CHECK(fos_version_is_downgrade("2026.8.34", "2026.9.0"));
    CHECK(fos_version_is_downgrade("2025.12.9", "2026.1.0"));
    CHECK(!fos_version_is_downgrade("2026.9.9", "2026.9.9"));
    CHECK(!fos_version_is_downgrade("2026.9.10", "2026.9.9"));
    CHECK(!fos_version_is_downgrade("2026.9.9", "v2026.9.9"));
    /* The dev build's app version is not a release; it must still take any offer. */
    CHECK(!fos_version_is_downgrade("2026.9.9", "dev"));
    CHECK(!fos_version_is_downgrade("2026.9.9", ""));
    CHECK(!fos_version_is_downgrade("garbage", "2026.9.9"));
    CHECK(!fos_version_is_downgrade(NULL, "2026.9.9"));
}

int main(void)
{
    test_parse();
    test_compare();
    test_downgrade();
    printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
