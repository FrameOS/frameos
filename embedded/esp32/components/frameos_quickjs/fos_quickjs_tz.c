#include "fos_quickjs_tz.h"

long fos_quickjs_neg_gmtoff_seconds(const time_t *ti)
{
    struct tm loc_tm, gm_tm;
    if (ti == NULL || !localtime_r(ti, &loc_tm) || !gmtime_r(ti, &gm_tm)) return 0;
    /* mktime() reads both as local wall time. With the local DST flag
     * copied over, the UTC broken-down time lands offset seconds earlier
     * than the local one — without it a zone in summer time is an hour
     * short. */
    gm_tm.tm_isdst = loc_tm.tm_isdst;
    time_t loc_ti = mktime(&loc_tm);
    time_t gm_ti = mktime(&gm_tm);
    if (loc_ti == (time_t)-1 || gm_ti == (time_t)-1) return 0;
    return (long)(gm_ti - loc_ti);
}
