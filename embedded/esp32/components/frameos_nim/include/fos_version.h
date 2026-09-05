/*
 * FrameOS release version ordering, for the OTA downgrade check.
 *
 * Release versions are dotted integers ("2026.9.9", optionally "v"-prefixed,
 * optionally followed by "-…" or "+…" that the comparison ignores). The point
 * of parsing rather than strcmp'ing is that "2026.9.10" sorts after
 * "2026.9.9"; the point of refusing to guess is that an unparseable version
 * must never be called a downgrade — the release channel would go silent on a
 * naming change, which is a worse failure than accepting one odd version.
 *
 * Pure C over strings so it is host-testable (main/tests/test_fos_version.c).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define FOS_VERSION_PARTS_MAX 4

/* Parse "v2026.9.9-rc1" into {2026, 9, 9}; missing trailing parts read as 0
 * when compared. Returns false when the string is not a dotted-integer
 * version (empty, no digits, a letter where a number should be, more than
 * FOS_VERSION_PARTS_MAX parts). */
bool fos_version_parse(const char *version, unsigned parts[FOS_VERSION_PARTS_MAX], size_t *count);

/* <0 when a sorts before b, 0 when equal (or when EITHER does not parse — the
 * caller must not act on an ordering that does not exist), >0 when a is newer. */
int fos_version_compare(const char *a, const char *b);

/* True only when both parse and `offered` is strictly older than `running`. */
bool fos_version_is_downgrade(const char *offered, const char *running);

#ifdef __cplusplus
}
#endif
