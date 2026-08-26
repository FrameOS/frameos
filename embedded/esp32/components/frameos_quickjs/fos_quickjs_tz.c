#include "fos_quickjs_tz.h"

long fos_quickjs_neg_gmtoff_seconds(const time_t *ti)
{
    struct tm loc_tm, gm_tm;
    if (ti == NULL || !localtime_r(ti, &loc_tm) || !gmtime_r(ti, &gm_tm)) return 0;
    /* mktime() reads its argument as local wall time, so the UTC fields come
     * out `offset` seconds EARLIER than *ti itself (UTC+2: 12:00Z read as
     * 12:00 local is 10:00Z) — the negated offset getTimezoneOffset() wants.
     * The local DST flag is copied over first: without it newlib's mktime
     * re-derives DST from the rule and a zone in summer time is an hour
     * short. localtime_r() is kept only for that flag; mktime(&loc_tm) would
     * merely reproduce *ti, so it is not paid for. */
    gm_tm.tm_isdst = loc_tm.tm_isdst;
    time_t gm_ti = mktime(&gm_tm);
    if (gm_ti == (time_t)-1) return 0;
    return (long)(gm_ti - *ti);
}
