/*
 * The printf family without newlib's formatter.
 *
 * newlib formats every snprintf in the image with _svfprintf_r (13 KB, an
 * 800-byte stack frame) and prints a double through _dtoa_r and mprec's
 * bignum. The linker routes snprintf, vsnprintf, sprintf, asprintf and
 * vasprintf here (-Wl,--wrap, main/CMakeLists.txt), and the FILE ones,
 * printf, fprintf, vprintf and vfprintf (whose own copy of the formatter,
 * _vfprintf_r, went first), format into a buffer here and write it. None of
 * newlib's formatter is linked.
 *
 * What comes out is newlib's, byte for byte, for what the image formats:
 * the flags - + space # 0 and ', a width and a precision (numbers or *),
 * the lengths hh h l ll q L j z t, and d i u o x X c s p n % e E f F g G.
 * Integers are QuickJS's u64toa_radix; a double is QuickJS's js_dtoa, exact
 * like dtoa, which rounds a tie away from zero where C rounds it to even:
 * fix_tie below puts that one case right. Like newlib, an unknown conversion
 * prints its letter.
 *
 * Not newlib's: %a / %A, wide characters and strings (%lc, %ls, %C, %S),
 * %m, the D O U compat letters and positional arguments ("%1$d") print as
 * an unknown conversion, and a float's precision is held to js_dtoa's 101
 * digits. No format in the image uses any of them (docs/esp32-image-size.md
 * lists the ones it does).
 *
 * A line for a FILE that fits the stack buffer costs one pass; a longer one
 * is formatted twice, the second time into a heap block. With no heap left
 * the first FOS_PRINTF_STACK - 1 bytes are written: a log line cut short
 * beats none.
 *
 * Host test: main/tests/test_fos_printf.c.
 */
#include <errno.h>
#include <limits.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs/dtoa.h"

#define FOS_PRINTF_STACK 128

int fos_vformat(char *out, size_t room, const char *format, va_list args);

int __wrap_vsnprintf(char *str, size_t size, const char *format, va_list args);
int __wrap_snprintf(char *str, size_t size, const char *format, ...);
int __wrap_sprintf(char *str, const char *format, ...);
int __wrap_vasprintf(char **out, const char *format, va_list args);
int __wrap_asprintf(char **out, const char *format, ...);
int __wrap_vfprintf(FILE *fp, const char *format, va_list args);
int __wrap_fprintf(FILE *fp, const char *format, ...);
int __wrap_vprintf(const char *format, va_list args);
int __wrap_printf(const char *format, ...);

/* newlib's flag bits */
#define ALT 0x001
#define LADJUST 0x004
#define LONGDBL 0x008
#define LONGINT 0x010
#define QUADINT 0x020
#define SHORTINT 0x040
#define ZEROPAD 0x080
#define CHARINT 0x100

typedef struct {
    char *out;
    size_t room; /* bytes that may still be written, the NUL excluded */
    int length;  /* what the whole output takes */
} fos_sink_t;

static void put(fos_sink_t *s, const char *p, int n)
{
    for (; n > 0; n--, p++) {
        if (s->room) {
            *s->out++ = *p;
            s->room--;
        }
        s->length++;
    }
}

static void pad(fos_sink_t *s, char c, int n)
{
    for (; n > 0; n--) put(s, &c, 1);
}

/* newlib's order: blanks, sign, 0x, zero padding, precision zeros, the
 * value, blanks for a left-adjusted field. */
static void put_field(fos_sink_t *s, int flags, int width, char sign, const char *prefix, const char *body,
                      int size, int precision)
{
    int zeros = precision > size ? precision - size : 0;
    int prefix_len = prefix ? 2 : 0;
    int real = size + zeros + (sign != 0) + prefix_len;
    if (!(flags & (LADJUST | ZEROPAD))) pad(s, ' ', width - real);
    if (sign) put(s, &sign, 1);
    put(s, prefix, prefix_len);
    if ((flags & (LADJUST | ZEROPAD)) == ZEROPAD) pad(s, '0', width - real);
    pad(s, '0', zeros);
    put(s, body, size);
    if (flags & LADJUST) pad(s, ' ', width - real);
}

/* js_dtoa rounds |x| * 10^shift to an integer with ties away from zero;
 * C rounds them to even. A tie is exact: |x| = m * 2^k with m odd, and
 * 2 |x| 10^shift is an odd integer only when k = -shift - 1 and, for a
 * negative shift, 5^-shift divides m. Then an odd last digit came from
 * rounding up, and one less is the even neighbour (never a borrow). */
static void fix_tie(uint64_t bits, int shift, char *last)
{
    uint64_t m = bits & (((uint64_t)1 << 52) - 1);
    int k = (int)(bits >> 52);
    if (k) m |= (uint64_t)1 << 52;
    else k = 1;
    k -= 1075;
    if (m == 0 || !((*last - '0') & 1)) return;
    while (!(m & 1)) {
        m >>= 1;
        k++;
    }
    if (k != -shift - 1) return;
    for (; shift < 0; shift++) {
        if (m % 5) return;
        m /= 5;
    }
    (*last)--;
}

/* newlib's %g keeps trailing zeros in one case. Its _dtoa_r first makes the
 * `ilim` digits of value / 10^k in floating point and strips the zeros; when
 * the rest is too close to one half to tell, an integer below 1e15 is made
 * again exactly (its "small integer" path), and rounding down there keeps
 * them: 6907305 is "6.90730e+06". This is that first try, operation for
 * operation; true when it gives up. */
static int dtoa_quick_gives_up(double value, int k, int ilim)
{
    double ds = 1, tens = 1;
    while (k--) ds *= 10;
    while (--ilim) tens *= 10;
    double d = value / ds;
    double eps = (2 * d + 7) * 0x1p-52 * tens;
    for (;; d *= 10) {
        d -= (long)d;
        if (tens < 10) return !(d > 0.5 + eps) && !(d < 0.5 - eps);
        tens /= 10;
    }
}

/* Not inlined: its 300 bytes of js_dtoa scratch stay off the stack of a
 * line with no double in it. */
__attribute__((noinline)) static void put_float(fos_sink_t *s, double value, int conv, int prec, int flags,
                                                int width, char sign)
{
    uint64_t bits;
    memcpy(&bits, &value, sizeof bits);
    if (bits >> 63) sign = '-';
    bits &= ~((uint64_t)1 << 63);
    memcpy(&value, &bits, sizeof value);
    int upper = conv <= 'G';
    conv |= 0x20;
    if ((bits >> 52) == 0x7ff) {
        const char *text = (bits << 12) ? (upper ? "NAN" : "nan") : (upper ? "INF" : "inf");
        put_field(s, flags & ~ZEROPAD, width, sign, NULL, text, 3, 0);
        return;
    }
    if (prec < 0) prec = 6;
    /* For every conversion, before anything is worked out from it: `prec + 1`
     * below wrapped for a `%.*e` given INT_MAX, and sized the buffers under
     * it from a negative number. */
    if (prec > JS_DTOA_MAX_DIGITS) prec = JS_DTOA_MAX_DIGITS;
    if (conv == 'g' && prec == 0) prec = 1;
    int alt = flags & ALT;
    JSDTOATempMem tmp;
    if (conv == 'f') {
        char text[js_dtoa_max_len(value, 10, prec, JS_DTOA_FORMAT_FRAC) + 2];
        int len = js_dtoa(text, value, 10, prec, JS_DTOA_FORMAT_FRAC, &tmp);
        fix_tie(bits, prec, &text[len - 1]);
        if (alt && prec == 0) text[len++] = '.';
        put_field(s, flags, width, sign, NULL, text, len, 0);
        return;
    }

    /* e and g: the first `digits` significant digits and the exponent */
    int digits = conv == 'e' ? prec + 1 : prec;
    if (digits > JS_DTOA_MAX_DIGITS) digits = JS_DTOA_MAX_DIGITS;
    char text[digits + 10];
    js_dtoa(text, value, 10, digits, JS_DTOA_FORMAT_FIXED | JS_DTOA_EXP_ENABLED, &tmp);
    char mantissa[digits + 1];
    const char *p = text;
    int n = 0;
    for (; *p != 'e'; p++) {
        if (*p != '.') mantissa[n++] = *p;
    }
    int exponent = atoi(p + 1);
    fix_tie(bits, digits - 1 - exponent, &mantissa[digits - 1]);

    char body[digits + 12];
    int len = 0;
    int keep = digits; /* the mantissa digits written */
    int point;         /* where the point goes, in digits written */
    int e_style = conv == 'e' || exponent < -4 || exponent >= digits;
    if (!e_style) {
        if (exponent < 0) {
            body[len++] = '0';
            body[len++] = '.';
            for (int i = -1; i > exponent; i--) body[len++] = '0';
        }
        point = exponent < 0 ? -1 : exponent + 1;
    } else {
        point = 1;
    }
    if (conv == 'g' && !alt) {
        int strip = 1;
        if (e_style && exponent < 15 && value == (double)(uint64_t)value) {
            uint64_t div = 1;
            for (int i = digits; i <= exponent; i++) div *= 10;
            if (((uint64_t)value / div) % 10 == (uint64_t)(mantissa[digits - 1] - '0') &&
                dtoa_quick_gives_up(value, exponent, digits)) {
                strip = 0; /* rounded down in newlib's exact path */
            }
        }
        while (strip && keep > 1 && keep > point && mantissa[keep - 1] == '0') keep--;
    }
    for (int i = 0; i < keep; i++) {
        if (i == point) body[len++] = '.';
        body[len++] = mantissa[i];
    }
    if (point == keep && alt) body[len++] = '.';
    if (e_style) {
        body[len++] = upper ? 'E' : 'e';
        body[len++] = exponent < 0 ? '-' : '+';
        if (exponent < 0) exponent = -exponent;
        if (exponent < 10) body[len++] = '0';
        len += (int)u32toa(body + len, (uint32_t)exponent);
    }
    put_field(s, flags, width, sign, NULL, body, len, 0);
}

static void format(fos_sink_t *s, const char *fmt, va_list args)
{
    for (;;) {
        const char *literal = fmt;
        while (*fmt && *fmt != '%') fmt++;
        put(s, literal, (int)(fmt - literal));
        if (*fmt == 0) return;
        fmt++;

        int flags = 0, width = 0, prec = -1;
        char sign = 0;
        int c;
    flag:
        c = *fmt++;
    again:
        switch (c) {
        case ' ':
            if (!sign) sign = ' ';
            goto flag;
        case '#':
            flags |= ALT;
            goto flag;
        case '\'': /* grouping: the C locale has no thousands separator */
            goto flag;
        case '*':
            width = va_arg(args, int);
            if (width >= 0) goto flag;
            width = -width;
            /* fall through */
        case '-':
            flags |= LADJUST;
            goto flag;
        case '+':
            sign = '+';
            goto flag;
        case '.':
            if ((c = *fmt++) == '*') {
                prec = va_arg(args, int);
                if (prec < 0) prec = -1;
                goto flag;
            }
            prec = 0;
            while (c >= '0' && c <= '9') {
                prec = prec * 10 + c - '0';
                c = *fmt++;
            }
            goto again;
        case '0':
            flags |= ZEROPAD;
            goto flag;
        case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
            width = 0;
            do {
                width = width * 10 + c - '0';
                c = *fmt++;
            } while (c >= '0' && c <= '9');
            goto again;
        case 'L':
            flags |= LONGDBL;
            goto flag;
        case 'h':
            if (*fmt == 'h') {
                fmt++;
                flags |= CHARINT;
            } else {
                flags |= SHORTINT;
            }
            goto flag;
        case 'l':
            if (*fmt == 'l') {
                fmt++;
                flags |= QUADINT;
            } else {
                flags |= LONGINT;
            }
            goto flag;
        case 'q':
            flags |= QUADINT;
            goto flag;
        case 'j':
            flags |= sizeof(intmax_t) == sizeof(long) ? LONGINT : QUADINT;
            goto flag;
        case 'z':
        case 't':
            if ((c == 'z' ? sizeof(size_t) : sizeof(ptrdiff_t)) > sizeof(int)) {
                flags |= (c == 'z' ? sizeof(size_t) : sizeof(ptrdiff_t)) <= sizeof(long) ? LONGINT : QUADINT;
            }
            goto flag;
        case 'c': {
            char ch = (char)va_arg(args, int);
            put_field(s, flags, width, 0, NULL, &ch, 1, 0);
            continue;
        }
        case 's': {
            /* newlib is built for size, which leaves out its "(null)":
             * a NULL string faults there, and here */
            const char *text = va_arg(args, const char *);
            int size;
            if (prec >= 0) {
                const char *end = memchr(text, 0, (size_t)prec);
                size = end ? (int)(end - text) : prec;
            } else {
                size = (int)strlen(text);
            }
            put_field(s, flags, width, 0, NULL, text, size, 0);
            continue;
        }
        case 'n': {
            void *at = va_arg(args, void *);
            if (flags & QUADINT) *(long long *)at = s->length;
            else if (flags & LONGINT) *(long *)at = s->length;
            else if (flags & SHORTINT) *(short *)at = (short)s->length;
            else if (flags & CHARINT) *(signed char *)at = (signed char)s->length;
            else *(int *)at = s->length;
            continue;
        }
        case 'e': case 'E': case 'f': case 'F': case 'g': case 'G': {
            double value = (flags & LONGDBL) ? (double)va_arg(args, long double) : va_arg(args, double);
            put_float(s, value, c, prec, flags, width, sign);
            continue;
        }
        case 'd': case 'i': case 'u': case 'o': case 'x': case 'X': case 'p': {
            uint64_t value;
            int base = c == 'o' ? 8 : (c == 'x' || c == 'X' || c == 'p') ? 16 : 10;
            const char *prefix = NULL;
            if (c == 'p') {
                value = (uintptr_t)va_arg(args, void *);
                prefix = "0x";
                sign = 0;
            } else if (c == 'd' || c == 'i') {
                int64_t v = (flags & QUADINT) ? va_arg(args, long long)
                          : (flags & LONGINT) ? va_arg(args, long)
                          : (flags & SHORTINT) ? (short)va_arg(args, int)
                          : (flags & CHARINT) ? (signed char)va_arg(args, int)
                          : va_arg(args, int);
                value = (uint64_t)v;
                if (v < 0) {
                    value = -value;
                    sign = '-';
                }
            } else {
                value = (flags & QUADINT) ? va_arg(args, unsigned long long)
                      : (flags & LONGINT) ? va_arg(args, unsigned long)
                      : (flags & SHORTINT) ? (unsigned short)va_arg(args, int)
                      : (flags & CHARINT) ? (unsigned char)va_arg(args, int)
                      : va_arg(args, unsigned int);
                sign = 0;
                if ((flags & ALT) && value != 0 && base == 16) prefix = c == 'X' ? "0X" : "0x";
            }
            if (prec >= 0) flags &= ~ZEROPAD;
            char text[24];
            char *digits = text + 1;
            int size = 0;
            if (value != 0 || prec != 0) {
                size = (int)u64toa_radix(digits, value, (unsigned)base);
                if (c == 'X') {
                    for (int i = 0; i < size; i++) {
                        if (digits[i] >= 'a') digits[i] -= 'a' - 'A';
                    }
                }
            }
            if (base == 8 && (flags & ALT) && (size == 0 || digits[0] != '0')) {
                *--digits = '0';
                size++;
            }
            put_field(s, flags, width, sign, prefix, digits, size, prec);
            continue;
        }
        default:
            if (c == 0) return;
            {
                char ch = (char)c;
                put_field(s, flags, width, 0, NULL, &ch, 1, 0);
            }
            continue;
        }
    }
}

int fos_vformat(char *out, size_t room, const char *format_string, va_list args)
{
    fos_sink_t s = {out, room, 0};
    format(&s, format_string, args);
    if (out) *s.out = 0;
    return s.length;
}

int __wrap_vsnprintf(char *str, size_t size, const char *format_string, va_list args)
{
    if (size > INT_MAX) {
        errno = EOVERFLOW;
        return EOF;
    }
    return fos_vformat(size ? str : NULL, size ? size - 1 : 0, format_string, args);
}

int __wrap_snprintf(char *str, size_t size, const char *format_string, ...)
{
    va_list args;
    va_start(args, format_string);
    int n = __wrap_vsnprintf(str, size, format_string, args);
    va_end(args);
    return n;
}

int __wrap_sprintf(char *str, const char *format_string, ...)
{
    va_list args;
    va_start(args, format_string);
    int n = fos_vformat(str, INT_MAX, format_string, args);
    va_end(args);
    return n;
}

int __wrap_vasprintf(char **out, const char *format_string, va_list args)
{
    va_list again;
    va_copy(again, args);
    int n = fos_vformat(NULL, 0, format_string, args);
    char *text = malloc((size_t)n + 1);
    if (text == NULL) {
        errno = ENOMEM;
        n = EOF;
    } else {
        fos_vformat(text, (size_t)n, format_string, again);
        *out = text;
    }
    va_end(again);
    return n;
}

int __wrap_asprintf(char **out, const char *format_string, ...)
{
    va_list args;
    va_start(args, format_string);
    int n = __wrap_vasprintf(out, format_string, args);
    va_end(args);
    return n;
}

int __wrap_vfprintf(FILE *fp, const char *format_string, va_list args)
{
    char line[FOS_PRINTF_STACK];
    va_list again;
    va_copy(again, args);
    int n = fos_vformat(line, sizeof(line) - 1, format_string, args);
    if ((size_t)n < sizeof(line)) {
        fwrite(line, 1, (size_t)n, fp);
    } else {
        char *big = malloc((size_t)n + 1);
        if (big != NULL) {
            fos_vformat(big, (size_t)n, format_string, again);
            fwrite(big, 1, (size_t)n, fp);
            free(big);
        } else {
            fwrite(line, 1, sizeof(line) - 1, fp);
        }
    }
    va_end(again);
    return n;
}

int __wrap_fprintf(FILE *fp, const char *format_string, ...)
{
    va_list args;
    va_start(args, format_string);
    int n = __wrap_vfprintf(fp, format_string, args);
    va_end(args);
    return n;
}

int __wrap_vprintf(const char *format_string, va_list args)
{
    return __wrap_vfprintf(stdout, format_string, args);
}

int __wrap_printf(const char *format_string, ...)
{
    va_list args;
    va_start(args, format_string);
    int n = __wrap_vfprintf(stdout, format_string, args);
    va_end(args);
    return n;
}

/* The veneers fos_veneers.h sends the firmware's calls to ROM and IRAM
 * through: `l32r a9, <target>; jx a9` in flash, one per function, here
 * because this object stands among the shell's (link_order.txt), within a
 * CALL8 of all of them. */
#if defined(__XTENSA__)
#include "fos_veneers.h"

#define FOS_VENEER_ASM(name)                                                  \
    __asm__(".pushsection .text.fos_v_" #name ",\"ax\",@progbits\n"           \
            ".literal_position\n"                                             \
            ".literal .Lfos_v_" #name ", " #name "\n"                         \
            ".align 4\n"                                                      \
            ".global fos_v_" #name "\n"                                       \
            ".type fos_v_" #name ", @function\n"                              \
            "fos_v_" #name ":\n"                                              \
            "l32r a9, .Lfos_v_" #name "\n"                                    \
            "jx a9\n"                                                         \
            ".size fos_v_" #name ", . - fos_v_" #name "\n"                    \
            ".popsection\n");
#define FOS_VENEER_ASM_LIBC(ret, name, params) FOS_VENEER_ASM(name)
FOS_VENEER_LIBC(FOS_VENEER_ASM_LIBC)
FOS_VENEER_IDF(FOS_VENEER_ASM)
#endif
