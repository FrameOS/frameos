// Unix epoch ↔ calendar fields, for the PCF85063A RTC which keeps BCD
// year/month/day/h/m/s (2000-2099). Proleptic Gregorian, UTC, no libc time
// zone machinery. Portable, header-only, host-tested
// (tests/test_pk_datetime.c).
#ifndef PK_DATETIME_H
#define PK_DATETIME_H

#include <stdbool.h>
#include <stdint.h>

typedef struct {
    int year;   // full, e.g. 2026
    int month;  // 1-12
    int day;    // 1-31
    int hour;
    int minute;
    int second;
} pk_datetime_t;

// Days since 1970-01-01 (Howard Hinnant's days_from_civil).
static inline int64_t pk_days_from_civil(int year, int month, int day)
{
    year -= month <= 2;
    int64_t era = (year >= 0 ? year : year - 399) / 400;
    unsigned yoe = (unsigned)(year - era * 400);
    unsigned doy = (153u * (unsigned)(month + (month > 2 ? -3 : 9)) + 2u) / 5u + (unsigned)day - 1u;
    unsigned doe = yoe * 365u + yoe / 4u - yoe / 100u + doy;
    return era * 146097 + (int64_t)doe - 719468;
}

static inline int64_t pk_datetime_to_epoch(const pk_datetime_t *dt)
{
    return pk_days_from_civil(dt->year, dt->month, dt->day) * 86400 + dt->hour * 3600 +
           dt->minute * 60 + dt->second;
}

static inline void pk_datetime_from_epoch(int64_t epoch, pk_datetime_t *dt)
{
    int64_t days = epoch / 86400;
    int64_t rem = epoch % 86400;
    if (rem < 0) {
        rem += 86400;
        days -= 1;
    }
    days += 719468;
    int64_t era = (days >= 0 ? days : days - 146096) / 146097;
    unsigned doe = (unsigned)(days - era * 146097);
    unsigned yoe = (doe - doe / 1460u + doe / 36524u - doe / 146096u) / 365u;
    unsigned doy = doe - (365u * yoe + yoe / 4u - yoe / 100u);
    unsigned mp = (5u * doy + 2u) / 153u;
    dt->day = (int)(doy - (153u * mp + 2u) / 5u + 1u);
    dt->month = (int)(mp < 10 ? mp + 3 : mp - 9);
    dt->year = (int)(yoe + era * 400) + (dt->month <= 2 ? 1 : 0);
    dt->hour = (int)(rem / 3600);
    dt->minute = (int)((rem % 3600) / 60);
    dt->second = (int)(rem % 60);
}

static inline bool pk_datetime_valid(const pk_datetime_t *dt)
{
    return dt->year >= 2000 && dt->year <= 2099 && dt->month >= 1 && dt->month <= 12 &&
           dt->day >= 1 && dt->day <= 31 && dt->hour >= 0 && dt->hour <= 23 && dt->minute >= 0 &&
           dt->minute <= 59 && dt->second >= 0 && dt->second <= 59;
}

static inline uint8_t pk_bcd_encode(int value)
{
    return (uint8_t)(((value / 10) << 4) | (value % 10));
}

static inline int pk_bcd_decode(uint8_t value)
{
    return ((value >> 4) & 0x0F) * 10 + (value & 0x0F);
}

#endif // PK_DATETIME_H
