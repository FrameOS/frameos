/*
 * Host tests for the assets-path rule (fos_assets_path.c) — the traversal
 * boundary behind every asset verb: cloud `asset_*`, the local HTTP asset
 * API and the USB console. No IDF, no mocks.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_assets_path.c main/tests/test_fos_assets_path.c \
 *      -o /tmp/test_fos_assets_path && /tmp/test_fos_assets_path
 *
 * (.github/workflows/e2e-docker.yml runs exactly that in CI.)
 *
 * The bias is one-directional: a wrong "accept" lets a provider read or
 * write outside the assets root (or into the device-local dot directories),
 * a wrong "refuse" costs one oddly named file. So every input the rule
 * cannot vouch for must come back false.
 */
#include <stdio.h>
#include <string.h>

#include "fos_assets_path.h"

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

static void expect_read(const char *raw, const char *want)
{
    char out[FOS_ASSETS_PATH_MAX];
    memset(out, 'X', sizeof(out));
    bool ok = fos_assets_sanitize_path(raw, out, sizeof(out));
    g_checks++;
    if (!ok) {
        g_failures++;
        printf("FAIL read %-32s refused, want \"%s\"\n", raw, want);
    } else if (strcmp(out, want) != 0) {
        g_failures++;
        printf("FAIL read %-32s -> \"%s\", want \"%s\"\n", raw, out, want);
    }
}

static void refuse_read(const char *raw)
{
    char out[FOS_ASSETS_PATH_MAX];
    g_checks++;
    if (fos_assets_sanitize_path(raw, out, sizeof(out))) {
        g_failures++;
        printf("FAIL read %-32s accepted as \"%s\", want refused\n", raw ? raw : "(null)", out);
    }
}

static void expect_write(const char *raw, const char *want)
{
    char out[FOS_ASSETS_PATH_MAX];
    bool ok = fos_assets_sanitize_write_path(raw, out, sizeof(out));
    g_checks++;
    if (!ok) {
        g_failures++;
        printf("FAIL write %-31s refused, want \"%s\"\n", raw, want);
    } else if (strcmp(out, want) != 0) {
        g_failures++;
        printf("FAIL write %-31s -> \"%s\", want \"%s\"\n", raw, out, want);
    }
}

static void refuse_write(const char *raw)
{
    char out[FOS_ASSETS_PATH_MAX];
    g_checks++;
    if (fos_assets_sanitize_write_path(raw, out, sizeof(out))) {
        g_failures++;
        printf("FAIL write %-31s accepted as \"%s\", want refused\n", raw, out);
    }
}

/* --------------------------------------------------------------------- */

static void test_plain_relative_paths(void)
{
    expect_read("photo.jpg", "photo.jpg");
    expect_read("photos/2026/kitchen.png", "photos/2026/kitchen.png");
    expect_read("a.b/c..d/e...f", "a.b/c..d/e...f");   /* dots inside a name are names */
    expect_read("..hidden-ish", "..hidden-ish");        /* not a dot-segment */
    expect_read("with space/and,punct!.txt", "with space/and,punct!.txt");
}

static void test_leading_slash_and_dot_slash_are_stripped(void)
{
    expect_read("/photo.jpg", "photo.jpg");
    expect_read("//photo.jpg", "photo.jpg");
    expect_read("///a/b", "a/b");
    expect_read("./photo.jpg", "photo.jpg");
    expect_read("././a", "a");
    expect_read("/./a", "a");
    expect_read(".//a", "a");
}

static void test_dot_segments_are_refused(void)
{
    refuse_read("..");
    refuse_read("../photo.jpg");
    refuse_read("photos/../photo.jpg");
    refuse_read("photos/..");
    refuse_read("photos/../../etc/passwd");
    refuse_read("/..");
    refuse_read("./..");
    refuse_read(".");
    refuse_read("a/./b");
    refuse_read("a/.");
    /* A leading "../" survives the "./" stripper only as "..": still refused. */
    refuse_read("./../a");
}

static void test_empty_segments_and_root(void)
{
    refuse_read(NULL);
    refuse_read("");
    refuse_read("/");
    refuse_read("//");
    refuse_read("./");
    refuse_read("a//b");
    /* A trailing slash is NOT an empty segment: `asset_mkdir photos/` is a
     * normal request, and the path stays inside the root either way. */
    expect_read("a/b/", "a/b/");
    expect_read("a/", "a/");
    expect_write("a/", "a/");
}

static void test_backslash_is_refused_outright(void)
{
    /* FatFS accepts '\\' as a separator, so it must never reach the walk. */
    refuse_read("photos\\..\\.cache");
    refuse_read("a\\b");
    refuse_read("\\a");
    refuse_read("a\\");
}

static void test_length_bounds(void)
{
    char raw[FOS_ASSETS_PATH_MAX + 8];
    char out[FOS_ASSETS_PATH_MAX];

    memset(raw, 'a', sizeof(raw));
    raw[FOS_ASSETS_PATH_MAX - 1] = '\0';                     /* 255 chars: the longest allowed */
    CHECK(fos_assets_sanitize_path(raw, out, sizeof(out)), "255-char path refused");
    CHECK(strcmp(out, raw) == 0, "255-char path mangled");

    memset(raw, 'a', sizeof(raw));
    raw[FOS_ASSETS_PATH_MAX] = '\0';                         /* 256 chars: over */
    CHECK(!fos_assets_sanitize_path(raw, out, sizeof(out)), "256-char path accepted");

    /* The caller's buffer bounds it too, independently of the constant. */
    char small[8];
    CHECK(fos_assets_sanitize_path("abcdefg", small, sizeof(small)), "7 chars into 8 refused");
    CHECK(!fos_assets_sanitize_path("abcdefgh", small, sizeof(small)), "8 chars into 8 accepted");

    /* Leading slashes do not count against the length. */
    memset(raw, 'a', sizeof(raw));
    raw[0] = '/';
    raw[FOS_ASSETS_PATH_MAX] = '\0';                         /* "/" + 255 chars */
    CHECK(fos_assets_sanitize_path(raw, out, sizeof(out)), "slash + 255 chars refused");
}

static void test_nul_terminates_the_path(void)
{
    /* The rule sees C strings: whatever a transport lets through after a NUL
     * is not part of the path, on either side of this check. */
    expect_read("photo.jpg\0/../x", "photo.jpg");
    refuse_read("\0photo.jpg");
}

static void test_write_rule_refuses_dot_components(void)
{
    expect_write("photo.jpg", "photo.jpg");
    expect_write("photos/a.jpg", "photos/a.jpg");
    expect_write("/photos/a.jpg", "photos/a.jpg");
    expect_write("a.b/c.d", "a.b/c.d");
}

static void test_write_rule_refuses_any_leading_dot(void)
{
    /* Device-local state lives in dot directories (.uploads, .cache, …):
     * a provider may not write into one, nor create a dotfile anywhere. */
    refuse_write(".hidden");
    refuse_write(".uploads/x.part");
    refuse_write("photos/.cache/thumb.png");
    refuse_write("photos/.DS_Store");
    refuse_write("a/..b");
    refuse_write("/.hidden");
    refuse_write("./.hidden");
    /* And everything the read rule refuses. */
    refuse_write("..");
    refuse_write("a/../b");
    refuse_write("a//b");
    refuse_write("a\\b");
    refuse_write("");
}

static void test_read_rule_lets_dotfiles_be_named_directly(void)
{
    /* The walk skips them (like the Linux runtime); a direct read is fine. */
    expect_read(".hidden", ".hidden");
    expect_read("photos/.cache/thumb.png", "photos/.cache/thumb.png");
}

int main(void)
{
    test_plain_relative_paths();
    test_leading_slash_and_dot_slash_are_stripped();
    test_dot_segments_are_refused();
    test_empty_segments_and_root();
    test_backslash_is_refused_outright();
    test_length_bounds();
    test_nul_terminates_the_path();
    test_write_rule_refuses_dot_components();
    test_write_rule_refuses_any_leading_dot();
    test_read_rule_lets_dotfiles_be_named_directly();

    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
