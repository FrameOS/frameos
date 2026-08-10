#include "pk_time.h"

#include "lwip/apps/sntp.h"
#include "pico/cyw43_arch.h"
#include "pico/stdlib.h"

// Floor for "now" before SNTP answers: the UNIX epoch of 2026-01-01. Any
// currently-valid certificate is valid at this instant too, so TLS works
// offline-from-NTP; certificates that expired before the firmware was even
// built still fail.
#define PK_TIME_BUILD_FLOOR 1767225600LL

static volatile long long s_epoch = 0;
static absolute_time_t s_epoch_set_at;
static bool s_sntp_started = false;

void pk_time_set(unsigned long epoch_seconds)
{
    s_epoch = (long long)epoch_seconds;
    s_epoch_set_at = get_absolute_time();
}

bool pk_time_synced(void)
{
    return s_epoch != 0;
}

void pk_time_start_sntp(void)
{
    if (s_sntp_started) return;
    s_sntp_started = true;
    cyw43_arch_lwip_begin();
    sntp_setoperatingmode(SNTP_OPMODE_POLL);
    sntp_setservername(0, "pool.ntp.org");
    sntp_init();
    cyw43_arch_lwip_end();
}

long long pk_time_now(long long *t)
{
    long long now;
    if (s_epoch != 0) {
        now = s_epoch +
              absolute_time_diff_us(s_epoch_set_at, get_absolute_time()) / 1000000;
    } else {
        now = PK_TIME_BUILD_FLOOR + to_ms_since_boot(get_absolute_time()) / 1000;
    }
    if (t) *t = now;
    return now;
}
