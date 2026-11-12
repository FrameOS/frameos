/*
 * printf to a FILE without newlib's second formatting engine.
 *
 * newlib links two copies of its full vfprintf: _svfprintf_r for the string
 * functions (snprintf & co, which everything uses) and _vfprintf_r for the
 * FILE ones (printf, fprintf, vprintf: ESP-IDF's log, the console, QuickJS'
 * dump helpers), 11.4 KB each. The linker routes the four FILE entry points
 * here (-Wl,--wrap, main/CMakeLists.txt), which format with vsnprintf and
 * write the bytes, so _vfprintf_r is never linked.
 *
 * A line that fits the stack buffer costs one vsnprintf; a longer one is
 * formatted twice, the second time into a heap block. With no heap left the
 * first FOS_PRINTF_STACK - 1 bytes are written: a log line cut short beats
 * none.
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>

#define FOS_PRINTF_STACK 128

int __wrap_vfprintf(FILE *fp, const char *format, va_list args);
int __wrap_fprintf(FILE *fp, const char *format, ...);
int __wrap_vprintf(const char *format, va_list args);
int __wrap_printf(const char *format, ...);

int __wrap_vfprintf(FILE *fp, const char *format, va_list args)
{
    char line[FOS_PRINTF_STACK];
    va_list again;
    va_copy(again, args);
    int n = vsnprintf(line, sizeof(line), format, args);
    if (n < 0) {
        va_end(again);
        return n;
    }
    if ((size_t)n < sizeof(line)) {
        fwrite(line, 1, (size_t)n, fp);
    } else {
        char *big = malloc((size_t)n + 1);
        if (big != NULL) {
            vsnprintf(big, (size_t)n + 1, format, again);
            fwrite(big, 1, (size_t)n, fp);
            free(big);
        } else {
            fwrite(line, 1, sizeof(line) - 1, fp);
        }
    }
    va_end(again);
    return n;
}

int __wrap_fprintf(FILE *fp, const char *format, ...)
{
    va_list args;
    va_start(args, format);
    int n = __wrap_vfprintf(fp, format, args);
    va_end(args);
    return n;
}

int __wrap_vprintf(const char *format, va_list args)
{
    return __wrap_vfprintf(stdout, format, args);
}

int __wrap_printf(const char *format, ...)
{
    va_list args;
    va_start(args, format);
    int n = __wrap_vfprintf(stdout, format, args);
    va_end(args);
    return n;
}
