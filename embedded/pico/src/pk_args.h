// Console line → argv, with the quoting rules of ESP-IDF's
// esp_console_split_argv: the browser quotes every `usb_api set` value as
// "…" with \\ and \" escaped (quoteEmbeddedUsbConsoleValue in
// frontend/src/models/embeddedUsbLogsModel.ts), and an SSID or password with a
// space in it has to arrive intact. Portable, host-tested
// (tests/test_pk_args.c).
#ifndef PK_ARGS_H
#define PK_ARGS_H

#include <stddef.h>

// Splits `line` IN PLACE (it is rewritten and NUL-separated) into at most
// `max_args` pointers. Whitespace separates arguments; "double quotes" group,
// and a backslash makes the next character literal, inside or outside quotes.
// Returns the argument count, or -1 for an unterminated quote.
int pk_args_split(char *line, char **argv, int max_args);

#endif // PK_ARGS_H
