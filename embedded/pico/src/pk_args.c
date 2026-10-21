#include "pk_args.h"

#include <stdbool.h>

int pk_args_split(char *line, char **argv, int max_args)
{
    if (line == NULL || argv == NULL || max_args <= 0) return 0;
    int argc = 0;
    char *in = line;
    char *out = line;
    for (;;) {
        while (*in == ' ' || *in == '\t') in++;
        if (*in == '\0') break;
        if (argc == max_args) break; // the rest is dropped, like esp_console
        argv[argc++] = out;
        bool quoted = false;
        for (;;) {
            char c = *in;
            if (c == '\0') {
                if (quoted) return -1;
                break;
            }
            in++;
            if (c == '\\' && *in != '\0') {
                *out++ = *in++;
            } else if (c == '"') {
                quoted = !quoted;
            } else if (!quoted && (c == ' ' || c == '\t')) {
                break;
            } else {
                *out++ = c;
            }
        }
        // `out` never overtakes `in` (unquoting only shrinks), so the
        // terminator lands on a byte that was already consumed — or on the
        // line's own NUL.
        *out++ = '\0';
    }
    return argc;
}
