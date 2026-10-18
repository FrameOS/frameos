/*
 * Host tests for the console line assembly (fos_console_line.h): bytes in,
 * command lines out, and an over-long line refused whole instead of having
 * its tail run as a second command.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/tests/test_fos_console_line.c \
 *      -o /tmp/test_fos_console_line && /tmp/test_fos_console_line
 *
 * (.github/workflows/e2e-docker.yml runs exactly that in CI.)
 */
#include <stdio.h>
#include <string.h>

#include "fos_console_line.h"

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

/* Feed `input` and collect every READY line, joined by '|' (empty lines
 * count in `ready` but add nothing to `lines`), plus how many TOO_LONG
 * refusals were reported. */
typedef struct {
    char lines[256];
    int ready;
    int too_long;
} feed_result_t;

static feed_result_t feed(fos_console_line_t *line, const char *input)
{
    feed_result_t out = {0};
    for (const char *p = input; *p; p++) {
        switch (fos_console_line_feed(line, (uint8_t)*p)) {
            case FOS_CONSOLE_LINE_READY:
                out.ready++;
                if (!line->buf[0]) break;
                if (out.lines[0]) strncat(out.lines, "|", sizeof(out.lines) - strlen(out.lines) - 1);
                strncat(out.lines, line->buf, sizeof(out.lines) - strlen(out.lines) - 1);
                break;
            case FOS_CONSOLE_LINE_TOO_LONG:
                out.too_long++;
                break;
            case FOS_CONSOLE_LINE_DROPPED:
            case FOS_CONSOLE_LINE_NONE:
                break;
        }
    }
    return out;
}

static void test_plain_lines(void)
{
    char buf[16];
    fos_console_line_t line = {.buf = buf, .cap = sizeof(buf)};
    feed_result_t r = feed(&line, "status\nset a 1\n");
    CHECK(strcmp(r.lines, "status|set a 1") == 0, "got \"%s\"", r.lines);
    CHECK(r.too_long == 0, "too_long=%d", r.too_long);

    /* CR ends a line too; CRLF gives the command and then an empty line. */
    r = feed(&line, "render\r\n");
    CHECK(strcmp(r.lines, "render") == 0 && r.ready == 2, "got \"%s\" (%d lines)", r.lines, r.ready);
}

static void test_backspace(void)
{
    char buf[16];
    fos_console_line_t line = {.buf = buf, .cap = sizeof(buf)};
    feed_result_t r = feed(&line, "statux\x7fs\n\x08\x08ok\n");
    CHECK(strcmp(r.lines, "status|ok") == 0, "got \"%s\"", r.lines);
}

static void test_exact_fit(void)
{
    /* cap 8 = 7 characters plus the NUL. */
    char buf[8];
    fos_console_line_t line = {.buf = buf, .cap = sizeof(buf)};
    feed_result_t r = feed(&line, "1234567\n");
    CHECK(strcmp(r.lines, "1234567") == 0, "got \"%s\"", r.lines);
    CHECK(r.too_long == 0, "too_long=%d", r.too_long);
}

static void test_over_long_tail_never_runs(void)
{
    char buf[8];
    fos_console_line_t line = {.buf = buf, .cap = sizeof(buf)};
    /* The old reader restarted at the limit and ran "reboot" here. */
    feed_result_t r = feed(&line, "set x 1234567reboot\nstatus\n");
    CHECK(strcmp(r.lines, "status") == 0, "the tail ran: \"%s\"", r.lines);
    CHECK(r.too_long == 1, "refused %d times, want once per line", r.too_long);

    /* A long line ended by CR, then LF: the LF is a plain empty line. */
    r = feed(&line, "abcdefghijk\r\nok\n");
    CHECK(strcmp(r.lines, "ok") == 0 && r.ready == 2, "got \"%s\" (%d lines)", r.lines, r.ready);
    CHECK(r.too_long == 1, "too_long=%d", r.too_long);

    /* Two over-long lines in a row are two refusals and no commands. */
    r = feed(&line, "aaaaaaaaaaaa\nbbbbbbbbbbbb\n");
    CHECK(r.lines[0] == '\0', "got \"%s\"", r.lines);
    CHECK(r.too_long == 2, "too_long=%d", r.too_long);

    /* Backspace cannot pull a skipped line back under the limit. */
    r = feed(&line, "abcdefgh\x7f\x7f\x7f\x7fzz\nok\n");
    CHECK(strcmp(r.lines, "ok") == 0, "got \"%s\"", r.lines);
}

int main(void)
{
    test_plain_lines();
    test_backspace();
    test_exact_fit();
    test_over_long_tail_never_runs();
    if (g_failures) {
        printf("%d of %d checks failed\n", g_failures, g_checks);
        return 1;
    }
    printf("fos_console_line: %d checks passed\n", g_checks);
    return 0;
}
