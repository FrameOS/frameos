/* See fos_tls_dates.h. */
#include "fos_tls_dates.h"

#include <stddef.h>

int fos_tls_release_month(const char *version)
{
    int floor = FOS_TLS_FLOOR_YEAR * 12 + FOS_TLS_FLOOR_MONTH - 1;
    if (version == NULL) return floor;
    if (*version == 'v') version++;
    int year = 0, month = 0, digits = 0;
    for (; *version >= '0' && *version <= '9' && digits < 5; version++, digits++) year = year * 10 + (*version - '0');
    if (digits != 4 || *version != '.') return floor;
    version++;
    for (digits = 0; *version >= '0' && *version <= '9' && digits < 3; version++, digits++) {
        month = month * 10 + (*version - '0');
    }
    if (digits == 0 || digits > 2 || month < 1 || month > 12 || *version != '.') return floor;
    int released = year * 12 + month - 1;
    return released > floor ? released : floor;
}

uint32_t fos_tls_date_flags(uint32_t flags, int now_month, int release_month, int valid_to_month,
                            uint32_t expired, uint32_t future)
{
    if (now_month >= release_month) return flags;
    flags &= ~(expired | future);
    if (valid_to_month < release_month) flags |= expired;
    return flags;
}
