// Epoch ↔ calendar for the RTC, checked against known instants and libc.
#include <time.h>

#include "pk_datetime.h"
#include "pk_test.h"

int main(void)
{
    pk_datetime_t dt;
    pk_datetime_from_epoch(0, &dt);
    CHECK(dt.year == 1970 && dt.month == 1 && dt.day == 1 && dt.hour == 0 && dt.minute == 0 && dt.second == 0);

    // 2026-09-19 12:34:56 UTC
    pk_datetime_from_epoch(1789821296, &dt);
    CHECK(dt.year == 2026 && dt.month == 9 && dt.day == 19 && dt.hour == 12 && dt.minute == 34 && dt.second == 56);
    CHECK(pk_datetime_to_epoch(&dt) == 1789821296);

    // Leap day, and the day after it; 2100 is not a leap year.
    pk_datetime_t leap = {2028, 2, 29, 23, 59, 59};
    int64_t epoch = pk_datetime_to_epoch(&leap);
    pk_datetime_from_epoch(epoch + 1, &dt);
    CHECK(dt.year == 2028 && dt.month == 3 && dt.day == 1 && dt.hour == 0);
    CHECK(pk_days_from_civil(2100, 3, 1) - pk_days_from_civil(2100, 2, 28) == 1);
    CHECK(pk_days_from_civil(2028, 3, 1) - pk_days_from_civil(2028, 2, 28) == 2);

    // Every day boundary across the RTC's range agrees with libc, both ways.
    for (int64_t t = 946684800; t < 4102444800LL; t += 86400 * 17 + 3601) {
        time_t libc_time = (time_t)t;
        struct tm tm;
        gmtime_r(&libc_time, &tm);
        pk_datetime_from_epoch(t, &dt);
        if (dt.year != tm.tm_year + 1900 || dt.month != tm.tm_mon + 1 || dt.day != tm.tm_mday ||
            dt.hour != tm.tm_hour || dt.minute != tm.tm_min || dt.second != tm.tm_sec ||
            pk_datetime_to_epoch(&dt) != t) {
            fprintf(stderr, "mismatch at %lld\n", (long long)t);
            CHECK(false);
            break;
        }
        // 1970-01-01 was a Thursday: the weekday the RTC is written with.
        CHECK((pk_days_from_civil(dt.year, dt.month, dt.day) + 4) % 7 == tm.tm_wday);
    }

    // BCD, as the PCF85063A stores it.
    CHECK(pk_bcd_encode(59) == 0x59 && pk_bcd_decode(0x59) == 59);
    CHECK(pk_bcd_encode(0) == 0x00 && pk_bcd_decode(0x07) == 7);
    for (int value = 0; value < 100; value++) CHECK(pk_bcd_decode(pk_bcd_encode(value)) == value);

    // An RTC that lost power reads back nonsense; it must not become a time.
    pk_datetime_t garbage = {2000 + 165, 25, 45, 45, 85, 85};
    CHECK(!pk_datetime_valid(&garbage));
    pk_datetime_t fine = {2026, 9, 19, 12, 0, 0};
    CHECK(pk_datetime_valid(&fine));
    pk_datetime_t before = {1999, 12, 31, 23, 59, 59};
    CHECK(!pk_datetime_valid(&before));

    return pk_test_result("test_pk_datetime");
}
