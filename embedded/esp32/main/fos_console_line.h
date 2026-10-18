/*
 * Console line assembly: bytes in, whole command lines out. Header-only and
 * pure, so the over-long-line rule is host-tested
 * (main/tests/test_fos_console_line.c) while fos_console.c keeps the
 * channels, the prompt and the command table.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
    FOS_CONSOLE_LINE_NONE = 0, /* byte consumed, no line yet */
    FOS_CONSOLE_LINE_READY,    /* line holds a NUL-terminated command */
    FOS_CONSOLE_LINE_TOO_LONG, /* the line overflowed; its tail is skipped */
    FOS_CONSOLE_LINE_DROPPED,  /* the newline that ends a skipped line */
} fos_console_line_result_t;

typedef struct {
    char *buf;
    size_t cap; /* bytes in buf, NUL included */
    size_t len;
    bool discarding;
} fos_console_line_t;

/* Feed one byte. An over-long line is refused once (TOO_LONG) and every byte
 * up to its newline is dropped. Restarting the buffer at the limit instead
 * ran the line's TAIL as a command of its own at the newline — whatever a
 * provisioning script's oversized `set …` value happened to end with. CR
 * and LF both end a line; backspace/DEL edit it. */
static inline fos_console_line_result_t fos_console_line_feed(fos_console_line_t *line, uint8_t ch)
{
    if (ch == '\r' || ch == '\n') {
        if (line->discarding) {
            line->discarding = false;
            line->len = 0;
            return FOS_CONSOLE_LINE_DROPPED;
        }
        line->buf[line->len] = '\0';
        line->len = 0;
        return FOS_CONSOLE_LINE_READY;
    }
    if (line->discarding) return FOS_CONSOLE_LINE_NONE;
    if (ch == 0x08 || ch == 0x7f) {
        if (line->len > 0) line->len--;
        return FOS_CONSOLE_LINE_NONE;
    }
    if (line->len + 1 < line->cap) {
        line->buf[line->len++] = (char)ch;
        return FOS_CONSOLE_LINE_NONE;
    }
    line->len = 0;
    line->discarding = true;
    return FOS_CONSOLE_LINE_TOO_LONG;
}
