/*
 * sscanf without newlib's floating-point scanf engine.
 *
 * The linker routes every sscanf here (-Wl,--wrap=sscanf,
 * main/CMakeLists.txt). The one call the firmware keeps is cJSON's
 * print_number, which prints a double with "%1.15g" and reads it back with
 * sscanf(buf, "%lg", &d) to see whether 15 digits were enough. That one
 * call linked newlib's whole scanf with floating point (svfscanf.o, 9.6 KB).
 * "%lg" alone is strtod, already linked for cJSON's parser, so it is
 * answered with strtod here.
 *
 * Any other format goes to vsiscanf, newlib's integer-only scanf, which is
 * linked anyway (tzset reads TZ with siscanf). It does every conversion but
 * the floating-point ones: a new caller that wants a float reads it with
 * strtod, or puts its format next to "%lg" below.
 *
 * Host test: main/tests/test_fos_sscanf.c.
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef __NEWLIB__
/* The host test's libc has no integer-only variant. */
#define vsiscanf vsscanf
#endif

int __wrap_sscanf(const char *str, const char *format, ...);

int __wrap_sscanf(const char *str, const char *format, ...)
{
    va_list args;
    va_start(args, format);
    int assigned;
    if (strcmp(format, "%lg") == 0) {
        double *out = va_arg(args, double *);
        const char *at = str;
        while (*at == ' ' || (*at >= '\t' && *at <= '\r')) at++;
        char *end = NULL;
        double value = strtod(at, &end);
        if (*at == '\0') {
            assigned = EOF;
        } else if (end == at) {
            assigned = 0;
        } else {
            *out = value;
            assigned = 1;
        }
    } else {
        assigned = vsiscanf(str, format, args);
    }
    va_end(args);
    return assigned;
}
