// Force-included into quickjs.c by tools/build_wasm.sh (together with
// -Dlocaltime_r=fos_quickjs_localtime_r): the one place QuickJS asks libc for
// local time — getTimezoneOffset() — is redirected to the frame's configured
// time zone, resolved by the Nim runtime's tz data (lib/tz.nim + chrono).
//
// Without this the wasm preview's JS `Date` follows emscripten's localtime_r,
// i.e. the *browser's* zone, while the Nim side (clock app, chrono formats)
// uses the frame's zone — a JS clock scene and a Nim clock scene disagreed.
// Same idea as the ESP32 build's fos_quickjs_tz.c, but via localtime_r since
// emscripten's struct tm already has tm_gmtoff.
#ifndef FOS_QUICKJS_TZ_H
#define FOS_QUICKJS_TZ_H
#include <time.h>

struct tm *fos_quickjs_localtime_r(const time_t *ti, struct tm *out);

#endif
