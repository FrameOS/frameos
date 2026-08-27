#include "fos_quickjs_tz.h"

/* Seconds east of UTC for the frame's configured zone at `epoch`; exported
 * by src/wasm/wasm_main.nim (frameos_wasm_tz_offset_seconds). */
extern long long frameos_wasm_tz_offset_seconds(long long epoch);

/* localtime_r for QuickJS: the wall time of *ti in the frame's zone. Only
 * tm_gmtoff (and the broken-down fields) matter to quickjs.c, which reads
 * `-tm.tm_gmtoff / 60` in getTimezoneOffset(). DST is already folded into
 * the offset by the tz data, so tm_isdst stays 0. */
struct tm *fos_quickjs_localtime_r(const time_t *ti, struct tm *out)
{
    if (ti == NULL || out == NULL) return NULL;
    long long offset = frameos_wasm_tz_offset_seconds((long long)*ti);
    time_t local = (time_t)(*ti + offset);
    if (!gmtime_r(&local, out)) return NULL;
    out->tm_gmtoff = (long)offset;
    out->tm_isdst = 0;
    return out;
}
