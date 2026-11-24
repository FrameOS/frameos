/*
 * sscanf and siscanf without newlib's scanf engine.
 *
 * The linker routes every sscanf and siscanf here (-Wl,--wrap,
 * main/CMakeLists.txt). Two callers survive the section GC:
 *
 *   - cJSON's print_number prints a double with "%1.15g" and reads it back
 *     with sscanf(buf, "%lg", &d) to see whether 15 digits were enough.
 *     "%lg" alone is strtod, already linked for cJSON's parser.
 *   - newlib's tzset reads TZ with siscanf, five formats:
 *     "%11[-+0-9A-Za-z]%n", "%11[A-Za-z]%n", "%hu%n:%hu%n:%hu%n",
 *     "M%hu%n.%hu%n.%hu%n" and "/%hu%n:%hu%n:%hu%n".
 *
 * Both used to link newlib's integer scanf engine (__ssvfiscanf_r, 8.3 KB).
 * fos_vsscanf below is that engine's integer and string part for a string,
 * with its rules kept exactly where they differ from glibc: a number is read
 * as at most 39 characters after its first leading zero, "%%" skips no
 * white space, a sign or an "x" with no digit after it is given back,
 * "[a-a]" also takes 'b', "[a-c-e]" is a to e, the value is strtol's or
 * strtoul's (errno included), and running out of input before the first
 * assignment is EOF where a mismatch is 0.
 *
 * Conversions: d i o u x X n s c [ and %%, with *, a width and hh h l ll
 * L j z t. Anything else (floats, %p, wide strings, %m, positional
 * arguments) stops the scan as a mismatch would: a new caller that wants a
 * float reads it with strtod, or puts its format next to "%lg" below.
 *
 * Host test: main/tests/test_fos_sscanf.c.
 */
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int fos_vsscanf(const char *str, const char *format, va_list args);
int __wrap_sscanf(const char *str, const char *format, ...);
int __wrap_siscanf(const char *str, const char *format, ...);

enum {
    LEN_CHAR = 1,
    LEN_SHORT,
    LEN_LONG,
    LEN_LLONG,
};

/* The integer scan's state (newlib's names). */
#define SIGNOK 0x01    /* a sign may come next */
#define NDIGITS 0x02   /* no digit yet */
#define PFXOK 0x04     /* an 0x prefix may come next */
#define NZDIGITS 0x08  /* no zero yet */
#define NNZDIGITS 0x10 /* no nonzero digit yet */

static int is_space(int c)
{
    return c == ' ' || (c >= '\t' && c <= '\r');
}

/* Whether `c` is in the scanset that starts at `set` (just after the '['),
 * read as newlib's __sccl builds its table; returns where the set ends. */
static const unsigned char *scanset(const unsigned char *set, int c, int *in_set)
{
    int negate = 0;
    int taken = 0;
    int last = *set++;
    if (last == '^') {
        negate = 1;
        last = *set++;
    }
    if (last == 0) {
        set--;
    } else {
        for (;;) {
            if (last == c) taken = 1;
            int next = *set++;
            if (next == 0) {
                set--;
                break;
            }
            if (next == ']') break;
            if (next == '-') {
                next = *set;
                if (next == ']' || next < last) {
                    last = '-';
                } else {
                    /* newlib fills last+1 .. next and always at least last+1 */
                    set++;
                    if (next <= last) next = last + 1;
                    if (c > last && c <= next) taken = 1;
                    last = next;
                }
            } else {
                last = next;
            }
        }
    }
    *in_set = taken ^ negate;
    return set;
}

int fos_vsscanf(const char *str, const char *format, va_list args)
{
    const unsigned char *in = (const unsigned char *)str;
    const unsigned char *fmt = (const unsigned char *)format;
    int assigned = 0;

    for (;;) {
        int c = *fmt++;
        if (c == 0) return assigned;
        if (is_space(c)) {
            while (is_space(*in)) in++;
            continue;
        }
        if (c == '%') {
            int suppress = 0, length = 0;
            unsigned width = 0;
            for (;;) {
                c = *fmt++;
                if (c >= '0' && c <= '9') {
                    if (length) return assigned;
                    width = width * 10 + (unsigned)(c - '0');
                } else if (c == '*') {
                    if (length || suppress || width) return assigned;
                    suppress = 1;
                } else if (c == 'h' || c == 'l' || c == 'L' || c == 'j' || c == 'z' || c == 't') {
                    if (length) return assigned;
                    if (c == 'h') {
                        length = LEN_SHORT;
                        if (*fmt == 'h') fmt++, length = LEN_CHAR;
                    } else if (c == 'l') {
                        length = LEN_LONG;
                        if (*fmt == 'l') fmt++, length = LEN_LLONG;
                    } else if (c == 'L') {
                        length = LEN_LLONG;
                    } else {
                        /* by size, as newlib picks them: on the ESP32 j is
                         * long long and z and t are int (no length) */
                        size_t size = c == 'j' ? sizeof(intmax_t) : c == 'z' ? sizeof(size_t) : sizeof(ptrdiff_t);
                        if (size > sizeof(long)) length = LEN_LLONG;
                        else if (size > sizeof(int) || (c == 'j' && size == sizeof(long))) length = LEN_LONG;
                    }
                } else {
                    break;
                }
            }
            if (c == '%') goto literal;
            if (c == 'n') {
                if (!suppress) {
                    long count = (long)(in - (const unsigned char *)str);
                    void *out = va_arg(args, void *);
                    if (length == LEN_CHAR) *(char *)out = (char)count;
                    else if (length == LEN_SHORT) *(short *)out = (short)count;
                    else if (length == LEN_LONG) *(long *)out = count;
                    else if (length == LEN_LLONG) *(long long *)out = count;
                    else *(int *)out = (int)count;
                }
                continue;
            }
            int base;
            if (c == 'd') base = 10;
            else if (c == 'i') base = 0;
            else if (c == 'o') base = 8;
            else if (c == 'u') base = 10;
            else if (c == 'x' || c == 'X') base = 16;
            else if ((c == 's' || c == 'c' || c == '[') && length != LEN_LONG) base = -1;
            else return assigned;
            if (*in == 0) goto input_failure;
            if (c != 'c' && c != '[') {
                while (is_space(*in)) in++;
                if (*in == 0) goto input_failure;
            }

            if (c == 'c') {
                if (width == 0) width = 1;
                char *out = suppress ? NULL : va_arg(args, char *);
                while (width-- && *in) {
                    if (out) *out++ = (char)*in;
                    in++;
                }
                if (out) assigned++;
                continue;
            }
            if (c == 's' || c == '[') {
                const unsigned char *set = fmt;
                int member = 0;
                if (c == '[') fmt = scanset(set, -1, &member);
                char *out = suppress ? NULL : va_arg(args, char *);
                const unsigned char *start = in;
                while (*in) {
                    if (c == 's') {
                        member = !is_space(*in);
                    } else {
                        scanset(set, *in, &member);
                    }
                    if (!member) break;
                    if (out) *out++ = (char)*in;
                    in++;
                    if (--width == 0) break;
                }
                if (c == '[' && in == start) return assigned;
                if (out) {
                    *out = 0;
                    assigned++;
                }
                continue;
            }

            /* An integer, read as newlib reads one: up to 39 characters into
             * buf (leading zeros after the first do not count), then strtol
             * or strtoul over them. */
            char buf[40];
            char *p = buf;
            unsigned width_left = 0;
            if (width - 1 > sizeof(buf) - 2) {
                width_left = width - (unsigned)(sizeof(buf) - 1);
                width = sizeof(buf) - 1;
            }
            int flags = SIGNOK | NDIGITS | NZDIGITS | NNZDIGITS | (base == 16 ? PFXOK : 0);
            for (; width; width--) {
                int ch = *in;
                if (ch == '0') {
                    if (flags & NNZDIGITS) {
                        if (base == 0) {
                            base = 8;
                            flags |= PFXOK;
                        }
                        if (flags & NZDIGITS) {
                            flags &= ~(SIGNOK | NZDIGITS | NDIGITS);
                        } else {
                            flags &= ~(SIGNOK | PFXOK | NDIGITS);
                            if (width_left) {
                                width_left--;
                                width++;
                            }
                            in++;
                            continue;
                        }
                    }
                } else if (ch >= '1' && ch <= '9') {
                    if (base == 0) base = 10;
                    if (ch >= '8' && base <= 8) break;
                    flags &= ~(SIGNOK | PFXOK | NDIGITS | NNZDIGITS);
                } else if ((ch >= 'A' && ch <= 'F') || (ch >= 'a' && ch <= 'f')) {
                    if (base <= 10) break;
                    flags &= ~(SIGNOK | PFXOK | NDIGITS | NNZDIGITS);
                } else if (ch == '+' || ch == '-') {
                    if (!(flags & SIGNOK)) break;
                    flags &= ~SIGNOK;
                } else if (ch == 'x' || ch == 'X') {
                    if ((flags & (PFXOK | NZDIGITS)) != PFXOK) break;
                    base = 16;
                    flags &= ~PFXOK;
                    flags |= NZDIGITS | NDIGITS;
                } else {
                    break;
                }
                *p++ = (char)ch;
                in++;
            }
            if (flags & NDIGITS) {
                /* only a sign, or [sign] 0 x: give the last one back */
                if (p > buf) {
                    p--;
                    in--;
                }
                if (p == buf) return assigned;
            }
            if (!suppress) {
                *p = 0;
                void *out = va_arg(args, void *);
                int is_signed = c == 'd' || c == 'i';
                /* newlib converts with the long one first even for ll, so
                 * errno can say ERANGE for a value long long holds */
                unsigned long value = is_signed ? (unsigned long)strtol(buf, NULL, base)
                                                : strtoul(buf, NULL, base);
                if (length == LEN_LLONG) {
                    *(long long *)out = is_signed ? strtoll(buf, NULL, base)
                                                  : (long long)strtoull(buf, NULL, base);
                } else {
                    if (length == LEN_CHAR) *(char *)out = (char)value;
                    else if (length == LEN_SHORT) *(short *)out = (short)value;
                    else if (length == LEN_LONG) *(long *)out = (long)value;
                    else *(int *)out = (int)value;
                }
                assigned++;
            }
            continue;
        }
    literal:
        if (*in == 0) goto input_failure;
        if (*in != c) return assigned;
        in++;
    }
input_failure:
    return assigned ? assigned : EOF;
}

int __wrap_sscanf(const char *str, const char *format, ...)
{
    va_list args;
    va_start(args, format);
    int assigned;
    if (strcmp(format, "%lg") == 0) {
        double *out = va_arg(args, double *);
        const char *at = str;
        while (is_space((unsigned char)*at)) at++;
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
        assigned = fos_vsscanf(str, format, args);
    }
    va_end(args);
    return assigned;
}

int __wrap_siscanf(const char *str, const char *format, ...)
{
    va_list args;
    va_start(args, format);
    int assigned = fos_vsscanf(str, format, args);
    va_end(args);
    return assigned;
}
