// Wall-clock time for TLS certificate validation: SNTP over lwIP, with a
// build-time floor so chains still validate sensibly when NTP is down.
#ifndef PK_TIME_H
#define PK_TIME_H

#include <stdbool.h>

void pk_time_start_sntp(void); // idempotent; call once WiFi is up
bool pk_time_synced(void);
void pk_time_set(unsigned long epoch_seconds); // called by lwIP SNTP
long long pk_time_now(long long *t);           // mbedTLS time hook

#endif // PK_TIME_H
