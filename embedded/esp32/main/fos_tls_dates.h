#pragma once
/* When a certificate's validity dates count (docs: README "Certificate dates").
 *
 * mbedTLS is built to check them (CONFIG_MBEDTLS_HAVE_TIME_DATE): without the
 * check a certificate that ran out years ago was as good as today's, so a key
 * that leaked once never aged out. With it, a frame needs the time to make a
 * TLS connection at all, and a frame may not have it: one switched on for the
 * first time, or after its battery was out, counts from 1970 until SNTP
 * answers, and SNTP may never answer on the network it is on. Such a frame
 * must still reach its control plane and its update.
 *
 * So the rule has two halves, by what the clock says:
 *
 * - At or past the month this firmware was released in, the clock is taken
 *   for the time and the dates stand exactly as mbedTLS read them.
 * - Before it, the clock is known to be wrong. A certificate cannot be held
 *   against it: "not valid yet" is dropped, and "expired" is asked of the
 *   release month instead, the one date the firmware carries. What had run
 *   out before this firmware was released has run out now, whatever the time.
 *
 * A FrameOS version is a date: "2026.11.14" is the fourteenth release of
 * November 2026 (builds are reproducible, so the image holds no compile
 * time). A build with no such version takes FOS_TLS_FLOOR_*.
 *
 * Months are counted from year 0 (year * 12 + month - 1). Pure C, tested on
 * a laptop by main/tests/test_fos_tls_dates.c; fos_tls.c is the mbedTLS side.
 */
#include <stdint.h>

#define FOS_TLS_FLOOR_YEAR 2026
#define FOS_TLS_FLOOR_MONTH 11

/* The month `version` was released in ("2026.11.14", "v2026.12.1+abc"), or
 * the floor when it is not such a version or names an earlier month. */
int fos_tls_release_month(const char *version);

/* A certificate's date flags as they count: `flags` is what mbedTLS worked
 * out against the system clock, `expired` and `future` its two bits
 * (MBEDTLS_X509_BADCERT_EXPIRED / _FUTURE). Every other bit passes through. */
uint32_t fos_tls_date_flags(uint32_t flags, int now_month, int release_month, int valid_to_month,
                            uint32_t expired, uint32_t future);
