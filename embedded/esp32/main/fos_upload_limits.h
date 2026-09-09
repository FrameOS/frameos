/* Bounds shared by the local HTTP asset upload, the cloud asset verbs and the
 * USB console's payload reads. Plain C, no IDF: host-tested by
 * tests/test_fos_upload_limits.c (e2e-docker.yml). */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Part files an interrupted or concurrent chunked upload may leave under
 * <assets>/.uploads at once. The cloud path is one upload at a time by
 * construction; the local HTTP path was unbounded, so an authenticated LAN
 * client could fill the card with abandoned parts. */
#define FOS_UPLOAD_MAX_PENDING_PARTS 8

/* True when [offset, offset + len) is a sane, non-negative range that keeps
 * the assembled file within max_bytes. len == 0 is not a write. */
static inline bool fos_upload_range_ok(long long offset, long long len, long long max_bytes)
{
    if (offset < 0 || len <= 0 || max_bytes <= 0) return false;
    if (offset > max_bytes) return false;
    return len <= max_bytes - offset;
}

/* How long a usb_api payload of `len` bytes may take to arrive on a channel
 * that carries `bits_per_second`: a 30 s floor (host-side setup, a render
 * holding the port) plus twice the wire time, so the 32 MB layout's 4 MB
 * scene cap fits at 115200 baud (~364 s on the wire → ~758 s) where the old
 * fixed 180 s never could. 10 bits per byte: start + 8 data + stop. */
#define FOS_UPLOAD_PAYLOAD_TIMEOUT_FLOOR_MS 30000u

static inline uint32_t fos_upload_payload_timeout_ms(size_t len, uint32_t bits_per_second)
{
    if (bits_per_second == 0) bits_per_second = 115200;
    uint64_t wire_ms = ((uint64_t)len * 10u * 1000u) / bits_per_second;
    uint64_t total = (uint64_t)FOS_UPLOAD_PAYLOAD_TIMEOUT_FLOOR_MS + 2u * wire_ms;
    if (total > 0xFFFFFFFFu) total = 0xFFFFFFFFu;
    return (uint32_t)total;
}
