/*
 * Host tests for fos_printf.c: what its formatter writes and returns is the
 * C library's for every directive the firmware's strings hold, for every
 * flag, width, precision and length on every conversion, for doubles of
 * every kind (ties, powers of ten, subnormals, huge and tiny), truncated or
 * not; and newlib's where glibc and newlib differ. No IDF, no mocks.
 *
 * Build and run (from the repository root, with QuickJS's sources in
 * frameos/quickjs as the firmware build has them):
 *
 *   cc -std=c11 -O2 -w -D_GNU_SOURCE -c frameos/quickjs/dtoa.c -o /tmp/qjs_dtoa.o
 *   cc -std=c11 -O2 -w -D_GNU_SOURCE -c frameos/quickjs/cutils.c -o /tmp/qjs_cutils.o
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Iembedded/esp32/main -Iframeos \
 *      embedded/esp32/main/fos_printf.c embedded/esp32/main/tests/test_fos_printf.c \
 *      /tmp/qjs_dtoa.o /tmp/qjs_cutils.o -lm -o /tmp/test_fos_printf && /tmp/test_fos_printf
 *
 * (.github/workflows/e2e-docker.yml runs exactly that in CI.)
 *
 * The same file also passes built for the esp32s3 against newlib's own
 * snprintf (the toolchain's sys.qemu.specs, on IDF's QEMU), which is where
 * the newlib cases below were read from.
 */
#include <errno.h>
#include <float.h>
#include <limits.h>
#include <math.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int __wrap_vsnprintf(char *str, size_t size, const char *format, va_list args);
int __wrap_snprintf(char *str, size_t size, const char *format, ...);
int __wrap_sprintf(char *str, const char *format, ...);
int __wrap_asprintf(char **out, const char *format, ...);
int __wrap_fprintf(FILE *fp, const char *format, ...);

static int failures = 0;
static long compared = 0;
static char ours[1400], libc[1400];

static int ours_f(size_t n, const char *f, ...)
{
    va_list ap;
    va_start(ap, f);
    int r = __wrap_vsnprintf(ours, n, f, ap);
    va_end(ap);
    return r;
}

static int libc_f(size_t n, const char *f, ...)
{
    va_list ap;
    va_start(ap, f);
    int r = vsnprintf(libc, n, f, ap);
    va_end(ap);
    return r;
}

static void same(const char *format, int ours_n, int libc_n)
{
    compared++;
    if (ours_n != libc_n || memcmp(ours, libc, sizeof ours) != 0) {
        if (failures < 30) printf("FAIL \"%s\": %d \"%s\", libc %d \"%s\"\n", format, ours_n, ours, libc_n, libc);
        failures++;
    }
}

static void clear(void)
{
    memset(ours, 0x55, sizeof ours);
    memset(libc, 0x55, sizeof libc);
}

static uint32_t rng = 20261124;
static uint32_t next32(void)
{
    rng ^= rng << 13;
    rng ^= rng >> 17;
    rng ^= rng << 5;
    return rng;
}
static uint64_t next64(void)
{
    return ((uint64_t)next32() << 32) | next32();
}

static double random_double(void)
{
    double v;
    uint64_t bits;
    switch (next32() % 8) {
    case 0: /* any finite bit pattern */
        do {
            bits = next64();
            memcpy(&v, &bits, sizeof v);
        } while (!isfinite(v));
        return v;
    case 1: /* human sized */
        return ((double)next32() / 4294967296.0) * pow(10, (int)(next32() % 30) - 12) * ((next32() & 1) ? -1 : 1);
    case 2: /* odd / 2^(p+1): a tie for %.pf */
        return (double)(next32() | 1) / ldexp(1.0, (int)(next32() % 8) + 1);
    case 3: { /* integers ending in 5: ties for %.Ne and %.Ng */
        uint64_t n = next64() % 900000000000000ULL;
        return (double)((n - n % 10 + 5) >> (next32() % 40));
    }
    case 4: /* powers of ten and their neighbours */
        v = pow(10, (int)(next32() % 600) - 300);
        return (next32() & 1) ? nextafter(v, INFINITY) : (next32() & 1) ? nextafter(v, 0) : v;
    case 5: /* short decimals */
        return (double)((int)(next32() % 200000) - 100000) / pow(10, next32() % 7);
    case 6: /* subnormals */
        bits = next64() & 0x000fffffffffffffULL;
        memcpy(&v, &bits, sizeof v);
        return v;
    default: /* halves and quarters */
        return (double)(int)(next32() % 2000) / 2.0 + ((next32() & 1) ? 0.0 : 0.25);
    }
}

static uint64_t random_int(void)
{
    static const uint64_t edges[] = {0, 1, 7, 8, 9, 10, 15, 16, 255, 256, 0x7fffffff, 0x80000000, 0xffffffff,
                                     0x100000000ULL, 0x7fffffffffffffffULL, 0x8000000000000000ULL, ~0ULL};
    switch (next32() % 4) {
    case 0: return edges[next32() % (sizeof edges / sizeof edges[0])];
    case 1: return next64();
    case 2: return next32() % 1000;
    default: return (uint64_t)(int64_t)(int32_t)next32();
    }
}

/* Where newlib's %g keeps trailing zeros (an integer below 1e15 with more
 * digits than the precision, fos_printf.c's dtoa_quick_gives_up) and glibc
 * does not. Checked against newlib below. */
static int newlib_g_zeros(const char *format, double v)
{
    int g = strpbrk(format, "gG") != NULL;
    v = fabs(v);
    return g && !strchr(format, '#') && v >= 1 && v < 1e15 && v == floor(v);
}

static void double_case(const char *format, double v)
{
    if (newlib_g_zeros(format, v)) return;
    clear();
    int a = ours_f(sizeof ours, format, v);
    int b = libc_f(sizeof libc, format, v);
    same(format, a, b);
}

static void int_case(const char *format, int kind, uint64_t v)
{
    clear();
    int a, b;
    if (kind == 0) {
        a = ours_f(sizeof ours, format, (int)v);
        b = libc_f(sizeof libc, format, (int)v);
    } else if (kind == 1) {
        a = ours_f(sizeof ours, format, (long)v);
        b = libc_f(sizeof libc, format, (long)v);
    } else {
        a = ours_f(sizeof ours, format, (long long)v);
        b = libc_f(sizeof libc, format, (long long)v);
    }
    same(format, a, b);
}

static void expect(const char *what, const char *got, int got_n, const char *want)
{
    compared++;
    if (strcmp(got, want) != 0 || got_n != (int)strlen(want)) {
        printf("FAIL %s: %d \"%s\", want \"%s\"\n", what, got_n, got, want);
        failures++;
    }
}

int main(void)
{
    /* Every directive in the firmware's strings, and Nim's "%#.*f". */
    static const char *ints[] = {"%08X", "%04d", "%-2d", "%4d", "%02x", "%0x", "%02X", "%X", "%d", "%04X", "%02d",
                                 "%i", "%u", "%04x", "%+07d", "%03d", "%2u", "%08x", "%x", "%c", "%8x"};
    static const char *longs[] = {"%08lX", "%lu", "%04lx", "%ld", "%08lx", "%lx", "%04zX", "%zu"};
    static const char *llongs[] = {"%+lld", "%016llx", "%llu", "%lld", "%llx"};
    static const char *doubles[] = {"%.0f", "%.1f", "%.2f", "%.3f", "%g", "%1.15g", "%1.17g"};
    for (size_t i = 0; i < sizeof ints / sizeof ints[0]; i++)
        for (int k = 0; k < 2000; k++) int_case(ints[i], 0, random_int());
    for (size_t i = 0; i < sizeof longs / sizeof longs[0]; i++)
        for (int k = 0; k < 2000; k++) int_case(longs[i], strchr(longs[i], 'z') ? sizeof(size_t) > sizeof(int) : 1, random_int());
    for (size_t i = 0; i < sizeof llongs / sizeof llongs[0]; i++)
        for (int k = 0; k < 2000; k++) int_case(llongs[i], 2, random_int());
    static const double specials[] = {0.0, -0.0, INFINITY, -INFINITY, NAN, -NAN, DBL_MAX, -DBL_MAX, DBL_MIN,
                                      5e-324, 0.5, 1.5, 2.5, -0.5, 9.5, 99.5, 0.05, 0.25, 0.125, 1e15, 1e16, 1e21,
                                      1e22, 0.1, 0.2, 0.3, 1.0 / 3.0, 2.0 / 3.0, 1e-5, 1e-4, 1e100, 1e300};
    for (size_t i = 0; i < sizeof doubles / sizeof doubles[0]; i++) {
        for (size_t s = 0; s < sizeof specials / sizeof specials[0]; s++) double_case(doubles[i], specials[s]);
        for (int k = 0; k < 30000; k++) double_case(doubles[i], random_double());
    }
    for (int k = 0; k < 20000; k++) {
        double v = random_double();
        clear();
        int a = ours_f(sizeof ours, "%#.*f", 1, v);
        int b = libc_f(sizeof libc, "%#.*f", 1, v);
        same("%#.*f", a, b);
    }
    static const char *strs[] = {"", "a", "hello", "hello world, a longer line of text", "\t\n", "\xc3\xa9t\xc3\xa9"};
    static const char *str_formats[] = {"%s", "%-14s", "%.3s", "%-16s", "%.64s", "%-9s", "%.300s", "%10s", "%c|%5c"};
    for (size_t i = 0; i < sizeof str_formats / sizeof str_formats[0]; i++) {
        for (size_t s = 0; s < sizeof strs / sizeof strs[0]; s++) {
            clear();
            int a, b;
            if (strchr(str_formats[i], 'c')) {
                a = ours_f(sizeof ours, str_formats[i], strs[s][0] ? strs[s][0] : 'z', 'q');
                b = libc_f(sizeof libc, str_formats[i], strs[s][0] ? strs[s][0] : 'z', 'q');
            } else {
                a = ours_f(sizeof ours, str_formats[i], strs[s]);
                b = libc_f(sizeof libc, str_formats[i], strs[s]);
            }
            same(str_formats[i], a, b);
        }
    }
    for (int p = -2; p < 12; p++) {
        for (size_t s = 0; s < sizeof strs / sizeof strs[0]; s++) {
            clear();
            int a = ours_f(sizeof ours, "%.*s|%0*d|%*s|", p, strs[s], p, 42, p * 3, strs[s]);
            int b = libc_f(sizeof libc, "%.*s|%0*d|%*s|", p, strs[s], p, 42, p * 3, strs[s]);
            same("%.*s|%0*d|%*s|", a, b);
        }
    }

    /* Every flag set, width, precision and length on every conversion. */
    static const char *flagsets[] = {"", "-", "+", " ", "#", "0", "-0", "+0", " 0", "#0", "-#", "+ ", "-+#0 "};
    static const char *widths[] = {"", "1", "5", "12", "25"};
    static const char *precs[] = {"", ".", ".0", ".1", ".3", ".10", ".17", ".25"};
    static const char *lens[] = {"hh", "h", "", "l", "ll"};
    char format[48];
    for (size_t f = 0; f < sizeof flagsets / sizeof flagsets[0]; f++) {
        for (size_t w = 0; w < sizeof widths / sizeof widths[0]; w++) {
            for (size_t p = 0; p < sizeof precs / sizeof precs[0]; p++) {
                for (size_t l = 0; l < sizeof lens / sizeof lens[0]; l++) {
                    for (const char *c = "diuoxX"; *c; c++) {
                        snprintf(format, sizeof format, "%%%s%s%s%s%c|", flagsets[f], widths[w], precs[p], lens[l], *c);
                        int kind = strcmp(lens[l], "ll") == 0 ? 2 : strcmp(lens[l], "l") == 0 ? 1 : 0;
                        for (int k = 0; k < 10; k++) int_case(format, kind, random_int());
                    }
                }
                for (const char *c = "eEfFgG"; *c; c++) {
                    snprintf(format, sizeof format, "%%%s%s%s%c|", flagsets[f], widths[w], precs[p], *c);
                    for (size_t s = 0; s < sizeof specials / sizeof specials[0]; s++) double_case(format, specials[s]);
                    for (int k = 0; k < 40; k++) double_case(format, random_double());
                }
                if (strchr(flagsets[f], '0')) continue; /* newlib pads these with zeros, below */
                snprintf(format, sizeof format, "%%%s%s%sc|%%%s%s%ss|", flagsets[f], widths[w], precs[p], flagsets[f],
                         widths[w], precs[p]);
                clear();
                int a = ours_f(sizeof ours, format, 'q', "text");
                int b = libc_f(sizeof libc, format, 'q', "text");
                same(format, a, b);
            }
        }
    }
    /* Long precisions, and a huge value's %f. */
    static const char *long_formats[] = {"%.30f", "%.40e", "%.50g", "%.60f", "%.100e", "%.101g", "%f", "%.99f"};
    for (size_t i = 0; i < sizeof long_formats / sizeof long_formats[0]; i++) {
        for (size_t s = 0; s < sizeof specials / sizeof specials[0]; s++) double_case(long_formats[i], specials[s]);
        for (int k = 0; k < 1500; k++) double_case(long_formats[i], random_double());
    }
    /* Cut short: what is written, the NUL, and the length it would take. */
    for (size_t n = 0; n < 14; n++) {
        clear();
        int a = ours_f(n, "%s-%d-%.2f", "abcdef", 12345, 3.14159);
        int b = libc_f(n, "%s-%d-%.2f", "abcdef", 12345, 3.14159);
        same("cut short", a, b);
    }
    clear();
    same("size 0, no buffer", __wrap_snprintf(NULL, 0, "%d", 12345), snprintf(NULL, 0, "%d", 12345));
    errno = 0;
    int r = __wrap_snprintf(ours, (size_t)INT_MAX + 1, "x");
    compared++;
    if (r != EOF || errno != EOVERFLOW) {
        printf("FAIL size above INT_MAX: %d errno %d\n", r, errno);
        failures++;
    }
    int n1 = -1, n2 = -1;
    clear();
    int a = ours_f(sizeof ours, "abc%nde%5d%hhn", &n1, 7, (signed char *)&n2);
    int b = libc_f(sizeof libc, "abc%nde%5d", &n1, 7);
    compared++;
    if (a != b || n1 != 3 || (signed char)n2 != 10) {
        printf("FAIL %%n: %d %d %d %d\n", a, b, n1, n2);
        failures++;
    }
    char big[64];
    expect("sprintf", big, __wrap_sprintf(big, "%s=%05.1f", "t", 2.25), "t=002.2");
    char *text = NULL;
    int n = __wrap_asprintf(&text, "%s %d %.3e", "asprintf", -42, 6.02214076e23);
    expect("asprintf", text ? text : "(none)", n, "asprintf -42 6.022e+23");
    free(text);

    /* A FILE gets the same bytes, a line longer than the stack buffer too. */
    FILE *fp = tmpfile();
    if (fp) {
        char line[400];
        memset(line, 'x', sizeof line - 1);
        line[sizeof line - 1] = 0;
        int w = __wrap_fprintf(fp, "%s|%d|%g\n", line, 42, 0.5);
        char back[512] = {0};
        rewind(fp);
        size_t got = fread(back, 1, sizeof back - 1, fp);
        fclose(fp);
        char want[512];
        snprintf(want, sizeof want, "%s|%d|%g\n", line, 42, 0.5);
        compared++;
        if (w != (int)strlen(want) || got != strlen(want) || strcmp(back, want) != 0) {
            printf("FAIL fprintf of a long line: %d %u\n", w, (unsigned)got);
            failures++;
        }
    }

    /* Where newlib prints otherwise than glibc, newlib's way. */
    char out[64];
    expect("%0Ns pads with zeros", out, __wrap_snprintf(out, sizeof out, "%05s|%05c|%-05s|", "ab", 'q', "ab"),
           "000ab|0000q|ab   |");
    expect("%5% pads", out, __wrap_snprintf(out, sizeof out, "%%|%5%|%-3%|"), "%|    %|%  |");
    expect("%p of NULL", out, __wrap_snprintf(out, sizeof out, "%p|%p", (void *)0, (void *)0x1234), "0x0|0x1234");
    expect("a lone % at the end", out, __wrap_snprintf(out, sizeof out, "abc%"), "abc");
    expect("an unknown conversion", out, __wrap_snprintf(out, sizeof out, "%y|%3y|%-3k|"), "y|  y|k  |");
    expect("%g of a tie, kept zero", out, __wrap_snprintf(out, sizeof out, "%g", 6907305.0), "6.90730e+06");
    expect("%.3G of a tie, kept zero", out, __wrap_snprintf(out, sizeof out, "%.3G", 3205.0), "3.20E+03");
    expect("%g of a tie, kept zeros", out, __wrap_snprintf(out, sizeof out, "%g", 1200005.0), "1.20000e+06");
    expect("%g rounding down, no tie", out, __wrap_snprintf(out, sizeof out, "%g", 1230001.0), "1.23e+06");
    expect("%g of a tie rounding up", out, __wrap_snprintf(out, sizeof out, "%g", 1234575.0), "1.23458e+06");
    expect("%g exact", out, __wrap_snprintf(out, sizeof out, "%g|%#g", 1200000.0, 1200005.0), "1.2e+06|1.20000e+06");
    expect("%g below 1e15 only", out, __wrap_snprintf(out, sizeof out, "%.3g", 1000000000000005.0), "1e+15");

    /* A precision past js_dtoa's digits is held to them, for every float
     * conversion and however large: `%.*e` at INT_MAX is `%.200e`'s output,
     * not a buffer sized from `INT_MAX + 1`. */
    {
        static char held[512], huge[512];
        static const char *const formats[][2] = {
            {"%.200e", "%.*e"}, {"%.200g", "%.*g"}, {"%.200f", "%.*f"}, {"%.200E", "%.*E"},
        };
        for (size_t i = 0; i < sizeof formats / sizeof formats[0]; i++) {
            int want_n = __wrap_snprintf(held, sizeof held, formats[i][0], 1.0 / 3.0);
            expect(formats[i][1], huge, __wrap_snprintf(huge, sizeof huge, formats[i][1], INT_MAX, 1.0 / 3.0), held);
            if (want_n < 50) {
                printf("FAIL %s: only %d characters\n", formats[i][0], want_n);
                failures++;
            }
        }
    }

    if (failures) {
        printf("%d failure(s)\n", failures);
        return 1;
    }
    printf("fos_printf: all passed (%ld compared)\n", compared);
    return 0;
}
