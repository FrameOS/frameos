/* Host test of fos_tls_dates.c: when a certificate's validity dates count on
 * a frame that may not know the time. Pure C, no IDF:
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_tls_dates.c main/tests/test_fos_tls_dates.c -o t && ./t
 *
 * Run by backend/app/tasks/tests/test_esp32_tls_dates.py.
 */
#include <stdio.h>

#include "fos_tls_dates.h"

static int checks = 0;
static int failures = 0;

#define CHECK(cond) do { \
        checks++; \
        if (!(cond)) { \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            failures++; \
        } \
    } while (0)

#define MONTH(year, month) ((year) * 12 + (month) - 1)
#define EXPIRED 0x01u
#define FUTURE 0x0200u
#define NOT_TRUSTED 0x08u

int main(void)
{
    int floor = MONTH(FOS_TLS_FLOOR_YEAR, FOS_TLS_FLOOR_MONTH);

    /* A FrameOS version is a date; anything else is the floor. */
    CHECK(fos_tls_release_month("2026.11.14") == MONTH(2026, 11));
    CHECK(fos_tls_release_month("2027.3.1") == MONTH(2027, 3));
    CHECK(fos_tls_release_month("v2027.12.40+abc1234") == MONTH(2027, 12));
    CHECK(fos_tls_release_month("2031.01.2-main.e0a754bd0") == MONTH(2031, 1));
    CHECK(fos_tls_release_month("2026.9.13") == floor);     /* before the rule existed */
    CHECK(fos_tls_release_month("0.0.0-unknown") == floor); /* a build outside a checkout */
    CHECK(fos_tls_release_month("1") == floor);
    CHECK(fos_tls_release_month("2027") == floor);
    CHECK(fos_tls_release_month("2027.13.1") == floor);
    CHECK(fos_tls_release_month("2027.0.1") == floor);
    CHECK(fos_tls_release_month("2027.123.1") == floor);
    CHECK(fos_tls_release_month("20270.1.1") == floor);
    CHECK(fos_tls_release_month("2027.5") == floor);
    CHECK(fos_tls_release_month("") == floor);
    CHECK(fos_tls_release_month(NULL) == floor);

    int release = MONTH(2026, 11);

    /* The clock is at or past the release month: the dates stand as read. */
    CHECK(fos_tls_date_flags(0, MONTH(2026, 11), release, MONTH(2027, 2), EXPIRED, FUTURE) == 0);
    CHECK(fos_tls_date_flags(EXPIRED, MONTH(2027, 6), release, MONTH(2027, 2), EXPIRED, FUTURE) == EXPIRED);
    CHECK(fos_tls_date_flags(FUTURE, MONTH(2026, 12), release, MONTH(2028, 1), EXPIRED, FUTURE) == FUTURE);
    CHECK(fos_tls_date_flags(EXPIRED | NOT_TRUSTED, MONTH(2030, 1), release, MONTH(2027, 2), EXPIRED, FUTURE) ==
          (EXPIRED | NOT_TRUSTED));

    /* A frame that has never had the time counts from 1970: every
     * certificate there is looks "not valid yet". That is dropped, and it
     * still reaches its plane. */
    CHECK(fos_tls_date_flags(FUTURE, MONTH(1970, 1), release, MONTH(2027, 2), EXPIRED, FUTURE) == 0);
    CHECK(fos_tls_date_flags(FUTURE | NOT_TRUSTED, MONTH(1970, 1), release, MONTH(2027, 2), EXPIRED, FUTURE) ==
          NOT_TRUSTED);
    /* Years after its release too, with certificates issued since. */
    CHECK(fos_tls_date_flags(FUTURE, MONTH(1970, 1), release, MONTH(2031, 8), EXPIRED, FUTURE) == 0);
    /* But what ran out before this firmware was released has run out. */
    CHECK(fos_tls_date_flags(FUTURE, MONTH(1970, 1), release, MONTH(2026, 10), EXPIRED, FUTURE) == EXPIRED);
    CHECK(fos_tls_date_flags(FUTURE, MONTH(1970, 1), release, MONTH(2021, 9), EXPIRED, FUTURE) == EXPIRED);
    CHECK(fos_tls_date_flags(0, MONTH(2026, 10), release, MONTH(2026, 10), EXPIRED, FUTURE) == EXPIRED);
    /* One that runs out in the release month itself is not held to a day. */
    CHECK(fos_tls_date_flags(FUTURE, MONTH(1970, 1), release, MONTH(2026, 11), EXPIRED, FUTURE) == 0);
    /* A clock that is wrong but not from 1970 (a dead clock chip: 2000). */
    CHECK(fos_tls_date_flags(FUTURE, MONTH(2000, 1), release, MONTH(2027, 2), EXPIRED, FUTURE) == 0);
    /* The other bits are nobody's to drop here. */
    CHECK(fos_tls_date_flags(FUTURE | NOT_TRUSTED | 0x04u, MONTH(1970, 1), release, MONTH(2026, 1), EXPIRED, FUTURE) ==
          (EXPIRED | NOT_TRUSTED | 0x04u));

    printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
