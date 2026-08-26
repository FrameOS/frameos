#pragma once
/* newlib's struct tm has no tm_gmtoff, which quickjs.c's getTimezoneOffset()
 * reads as `res = -tm.tm_gmtoff / 60;`. The component's CMakeLists defines
 * tm_gmtoff so that line becomes
 *     res = -tm.tm_isdst * 0 + fos_quickjs_neg_gmtoff_seconds(&ti) / 60;
 * i.e. the same value derived from mktime(). This header is force-included
 * into quickjs.c to declare the helper. An earlier `tm_gmtoff=tm_isdst`
 * define made every JS Date on the device run on UTC. */
#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Minus the local offset from UTC, in seconds, for the instant *ti — the
 * sign getTimezoneOffset() wants before its own / 60. 0 when unknown. */
long fos_quickjs_neg_gmtoff_seconds(const time_t *ti);

#ifdef __cplusplus
}
#endif
