/* Host test for fos_upload_limits.h — no IDF, plain C. Built and run by
 * e2e-docker.yml next to the contract walker. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fos_upload_limits.h"

static int failures = 0;

static void check(bool got, bool want, const char *what)
{
    if (got != want) {
        printf("FAIL %s: got %s\n", what, got ? "true" : "false");
        failures++;
    } else {
        printf("ok   %s\n", what);
    }
}

static void check_u32(uint32_t got, uint32_t lo, uint32_t hi, const char *what)
{
    if (got < lo || got > hi) {
        printf("FAIL %s: got %u, want %u..%u\n", what, (unsigned)got, (unsigned)lo, (unsigned)hi);
        failures++;
    } else {
        printf("ok   %s (%u)\n", what, (unsigned)got);
    }
}

int main(void)
{
    const long long cap = 64LL * 1024 * 1024;
    check(fos_upload_range_ok(0, 1, cap), true, "first byte");
    check(fos_upload_range_ok(0, cap, cap), true, "exactly the cap in one go");
    check(fos_upload_range_ok(cap - 1, 1, cap), true, "last byte");
    check(fos_upload_range_ok(cap, 1, cap), false, "one past the cap");
    check(fos_upload_range_ok(0, cap + 1, cap), false, "single shot over the cap");
    check(fos_upload_range_ok(-1, 1, cap), false, "negative offset");
    check(fos_upload_range_ok(0, 0, cap), false, "empty write");
    check(fos_upload_range_ok(0, -5, cap), false, "negative length");
    check(fos_upload_range_ok(0x7fffffffffffffffLL, 1, cap), false, "huge offset does not wrap");
    check(fos_upload_range_ok(1, 0x7fffffffffffffffLL, cap), false, "huge length does not wrap");
    check(fos_upload_range_ok(0, 1, 0), false, "zero cap accepts nothing");

    /* 4 MB at 115200 baud: 364 s on the wire, ×2 + 30 s floor ≈ 758 s. */
    check_u32(fos_upload_payload_timeout_ms(4u * 1024 * 1024, 115200), 750000, 770000,
              "32 MB layout scene cap at 115200 baud");
    /* 512 KB: ~45 s wire → ~121 s, comfortably above the old 180 s? No: below
     * it, which is the point — small payloads no longer wait three minutes. */
    check_u32(fos_upload_payload_timeout_ms(512u * 1024, 115200), 118000, 122000,
              "8 MB layout scene cap at 115200 baud");
    check_u32(fos_upload_payload_timeout_ms(0, 115200), 30000, 30000, "empty payload = floor");
    check_u32(fos_upload_payload_timeout_ms(200, 115200), 30000, 30100, "tiny payload ≈ floor");
    check_u32(fos_upload_payload_timeout_ms(4u * 1024 * 1024, 0), 750000, 770000,
              "unknown rate assumes 115200");
    check_u32(fos_upload_payload_timeout_ms(4u * 1024 * 1024, 921600), 118000, 122000,
              "faster link, shorter wait");

    if (failures) {
        printf("%d failure(s)\n", failures);
        return 1;
    }
    printf("all ok\n");
    return 0;
}
