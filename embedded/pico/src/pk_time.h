// Wall-clock time for TLS certificate validation and log timestamps: SNTP
// over lwIP, seeded at boot from the Inky Frame's battery-backed RTC when it
// has the time, with a build-time floor so chains still validate sensibly
// when neither does.
#ifndef PK_TIME_H
#define PK_TIME_H

#include <stdbool.h>

void pk_time_start_sntp(void); // idempotent; call once WiFi is up
bool pk_time_synced(void);     // SNTP or the RTC has supplied the time
void pk_time_set(unsigned long epoch_seconds); // called by lwIP SNTP
// Seeds the clock from the RTC; an SNTP answer later still replaces it.
void pk_time_seed(unsigned long epoch_seconds);
// True once per SNTP answer: the moment to write the time back to the RTC.
bool pk_time_take_sntp_update(void);
long long pk_time_now(long long *t);           // mbedTLS time hook

#endif // PK_TIME_H
