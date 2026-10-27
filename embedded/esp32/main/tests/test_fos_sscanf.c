/*
 * Host tests for fos_sscanf.c: its "%lg" (strtod) reads what the C
 * library's sscanf reads, for what cJSON prints and for what it does not,
 * and every other format is the C library's. No IDF, no mocks.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_sscanf.c main/tests/test_fos_sscanf.c \
 *      -o /tmp/test_fos_sscanf && /tmp/test_fos_sscanf
 *
 * (.github/workflows/e2e-docker.yml runs exactly that in CI.)
 */
#include <math.h>
#include <stdio.h>
#include <string.h>

int __wrap_sscanf(const char *str, const char *format, ...);

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

    /* Any other format is the C library's. */
    int a = 0, b = 0;
    char word[8] = {0};
    int n = __wrap_sscanf("\x1b[12;34R", "\x1b[%d;%dR", &a, &b);
    if (n != 2 || a != 12 || b != 34) {
        printf("FAIL cursor report: %d %d %d\n", n, a, b);
        failures++;
    }
    n = __wrap_sscanf("frame 7", "%7s %d", word, &a);
    if (n != 2 || strcmp(word, "frame") != 0 || a != 7) {
        printf("FAIL word and number: %d \"%s\" %d\n", n, word, a);
        failures++;
    }

    if (failures) {
        printf("%d failure(s)\n", failures);
        return 1;
    }
    printf("fos_sscanf: all passed\n");
    return 0;
}
