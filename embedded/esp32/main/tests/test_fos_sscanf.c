/*
 * Host tests for fos_sscanf.c: its "%lg" (strtod) reads what the C
 * library's sscanf reads, for what cJSON prints and for what it does not;
 * tzset's five formats read what the C library reads, on every tail of TZ
 * strings and on random ones; the integer and string conversions read as
 * the C library does wherever glibc and newlib agree, and as newlib does
 * where they do not. No IDF, no mocks.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_sscanf.c main/tests/test_fos_sscanf.c \
 *      -o /tmp/test_fos_sscanf && /tmp/test_fos_sscanf
 *
 * (.github/workflows/e2e-docker.yml runs exactly that in CI.)
 *
 * The same file also passes built for the esp32s3 against newlib's own
 * sscanf (the toolchain's sys.qemu.specs, on IDF's QEMU), which is where
 * the newlib rules below were read from.
 */
#include <math.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int __wrap_sscanf(const char *str, const char *format, ...);
int __wrap_siscanf(const char *str, const char *format, ...);

static int failures = 0;

static void same_as_libc(const char *text)
{
    double ours = -12345.0, theirs = -12345.0;
    int ours_n = __wrap_sscanf(text, "%lg", &ours);
    int theirs_n = sscanf(text, "%lg", &theirs);
    int same_value = (isnan(ours) && isnan(theirs)) || memcmp(&ours, &theirs, sizeof ours) == 0;
    if (ours_n != theirs_n || !same_value) {
        printf("FAIL \"%s\": %d %.17g, libc %d %.17g\n", text, ours_n, ours, theirs_n, theirs);
        failures++;
    }
}

/* Every pointer a format can ask for, each pointing into its own slot. */
#define SLOTS 8
#define SLOT 64
static unsigned char ours_slots[SLOTS][SLOT], libc_slots[SLOTS][SLOT];
static long compared = 0;

static void same_scan_as_libc(const char *format, const char *text)
{
    memset(ours_slots, 0xa5, sizeof ours_slots);
    memset(libc_slots, 0xa5, sizeof libc_slots);
    int ours = __wrap_siscanf(text, format, ours_slots[0], ours_slots[1], ours_slots[2], ours_slots[3],
                              ours_slots[4], ours_slots[5], ours_slots[6], ours_slots[7]);
    int theirs = sscanf(text, format, libc_slots[0], libc_slots[1], libc_slots[2], libc_slots[3], libc_slots[4],
                        libc_slots[5], libc_slots[6], libc_slots[7]);
    compared++;
    if (ours != theirs || memcmp(ours_slots, libc_slots, sizeof ours_slots) != 0) {
        if (failures < 20) printf("FAIL \"%s\" on \"%s\": %d, libc %d\n", format, text, ours, theirs);
        failures++;
    }
}

static uint32_t rng = 20261124;
static uint32_t next_random(void)
{
    rng ^= rng << 13;
    rng ^= rng >> 17;
    rng ^= rng << 5;
    return rng;
}

static void random_text(char *out, size_t max, const char *alphabet)
{
    size_t len = next_random() % max;
    size_t letters = strlen(alphabet);
    for (size_t i = 0; i < len; i++) out[i] = alphabet[next_random() % letters];
    out[len] = '\0';
}

static void expect(int ok, const char *what)
{
    if (!ok) {
        printf("FAIL %s\n", what);
        failures++;
    }
}

int main(void)
{
    /* What cJSON's print_number reads back: its own "%1.15g". */
    const double printed[] = {
        0.1, 0.1 + 0.2, 1.0 / 3.0, 2.5, -0.0, 1e300, -1e-300, 5e-324, 1.7976931348623157e308,
        123456789012345678.0, 3.14159265358979, 0.000123, -42.75, 6.02214076e23, 1e-7,
    };
    for (size_t i = 0; i < sizeof printed / sizeof printed[0]; i++) {
        char buffer[32];
        snprintf(buffer, sizeof buffer, "%1.15g", printed[i]);
        same_as_libc(buffer);
        snprintf(buffer, sizeof buffer, "%1.17g", printed[i]);
        same_as_libc(buffer);
    }
    /* And what it never prints. */
    const char *others[] = {
        "", "   ", "\t\n 7", "abc", "-", ".", "1e", "1e+", " 2.5xyz", "inf", "-INF", "nan", "0x1p3",
        "1,5", "+.5", "00012",
    };
    for (size_t i = 0; i < sizeof others / sizeof others[0]; i++) same_as_libc(others[i]);

    /* newlib's tzset reads TZ with these five, each on what is left of the
     * string at that point. */
    const char *tz_formats[] = {
        "%11[-+0-9A-Za-z]%n", "%11[A-Za-z]%n", "%hu%n:%hu%n:%hu%n", "M%hu%n.%hu%n.%hu%n", "/%hu%n:%hu%n:%hu%n",
    };
    const size_t tz_format_count = sizeof tz_formats / sizeof tz_formats[0];
    const char *tz_strings[] = {
        "CET-1CEST,M3.5.0,M10.5.0/3", "JST-9", "NST3:30NDT,M3.2.0,M11.1.0", "<+0330>-3:30",
        "<-03>3<-02>,M3.5.0/-2,M10.5.0/-1", "<+1245>-12:45<+1345>,M9.5.0/2:45,M4.1.0/3:45",
        "LHST-10:30LHDT-11,M10.1.0,M4.1.0", "EST5EDT,J60/2,J300/2:30:15", "UTC0", ":Europe/Brussels",
        "<ABCDEFGHIJK>1", "ABCDEFGHIJKL1", "EST5:99:99", "EST65536", "EST4294967296", "EST--5", "EST 5",
        "EST5EDT,M3.2.0/,M11.1.0", "EST5EDT,M 3.2.0", "EST5EDT,M+3.2.0,M-11.1.0", "AbC-01:02:03dEf-04:05:06",
        "M12.5.6/23:59:59", "/ 2", "/+2", "/-0", "M3.1", "M3.", "M", "", "<", "<>", "<-+->1<+++>",
    };
    for (size_t s = 0; s < sizeof tz_strings / sizeof tz_strings[0]; s++) {
        for (const char *tail = tz_strings[s];; tail++) {
            for (size_t f = 0; f < tz_format_count; f++) same_scan_as_libc(tz_formats[f], tail);
            if (*tail == '\0') break;
        }
    }
    char text[48];
    for (int i = 0; i < 200000; i++) {
        random_text(text, 39, "0123456789+-:.,/MJ<>ABCZabcz \tx\xc3");
        same_scan_as_libc(tz_formats[next_random() % tz_format_count], text);
    }

    /* The integer and string conversions, where glibc and newlib agree:
     * fewer than 40 characters a number, no "0x" without a hex digit after
     * it, no "%%" after white space, no range like [a-a]. */
    const char *formats[] = {
        "%d%n", "%u%n", "%o%n", "%hhd%n", "%hd%n", "%ld%n", "%lld%n", "%llu%n", "%5d%n", "%*d %d%n", "%c%n",
        "%3c%n", "%*2c%n", "%s%n", "%5s%n", "%*s%n", "%[^,]%n", "%[]a]%n", "%[a-c-e]%n", "%3[0-9]%n",
        "%*[a-z]%n", " %d%n", "%n", "x%n", "%hu%n:%hu%n", "%d,%d%n", "%u %c %s%n", "%hhn%d%hn", "%jd%zu%td%n",
    };
    for (int i = 0; i < 200000; i++) {
        random_text(text, 39, "0123456789+-:,abcdefz ]\t\n");
        same_scan_as_libc(formats[next_random() % (sizeof formats / sizeof formats[0])], text);
    }

    /* Where newlib reads otherwise than glibc, newlib's way. */
    int a = -1, b = -1, n = -1;
    char word[16];
    expect(__wrap_siscanf("0xg", "%x%n", &a, &n) == 1 && a == 0 && n == 1, "0x without a digit gives the x back");
    expect(__wrap_siscanf("0x", "%i%n", &a, &n) == 1 && a == 0 && n == 1, "a final 0x gives the x back");
    expect(__wrap_siscanf(" %5", "%%%d", &a) == 0, "%% skips no white space");
    a = -1;
    expect(__wrap_siscanf("%5", "%%%d", &a) == 1 && a == 5, "%% matches a percent sign");
    expect(__wrap_siscanf("abc", "%[a-a]%n", word, &n) == 1 && strcmp(word, "ab") == 0 && n == 2,
           "[a-a] also takes b");
    expect(__wrap_siscanf("1234567890123456789012345678901234567890123", "%d%n", &a, &n) == 1 && n == 39,
           "a number is 39 characters at most");
    expect(__wrap_siscanf("0000000000000000000000000000000000000000000000000007:", "%d%n", &a, &n) == 1 && a == 7 &&
               n == 52,
           "leading zeros do not count against the 39");
    expect(__wrap_siscanf("+", "%hu", &a) == 0, "a lone sign is a mismatch");
    expect(__wrap_siscanf("", "%hu", &a) == EOF, "no input is EOF");
    expect(__wrap_siscanf("5", "%d:%d", &a, &b) == 1, "input running out after a conversion");
    expect(__wrap_siscanf("1.5", "%f", &a) == 0, "floats stop the scan");

    /* Any other format through sscanf too. */
    a = b = 0;
    n = __wrap_sscanf("\x1b[12;34R", "\x1b[%d;%dR", &a, &b);
    if (n != 2 || a != 12 || b != 34) {
        printf("FAIL cursor report: %d %d %d\n", n, a, b);
        failures++;
    }
    memset(word, 0, sizeof word);
    n = __wrap_sscanf("frame 7", "%7s %d", word, &a);
    if (n != 2 || strcmp(word, "frame") != 0 || a != 7) {
        printf("FAIL word and number: %d \"%s\" %d\n", n, word, a);
        failures++;
    }

    if (failures) {
        printf("%d failure(s)\n", failures);
        return 1;
    }
    printf("fos_sscanf: all passed (%ld scans compared with the C library)\n", compared);
    return 0;
}
