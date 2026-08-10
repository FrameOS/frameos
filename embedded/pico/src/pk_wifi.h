#ifndef PK_WIFI_H
#define PK_WIFI_H

#include <stdbool.h>
#include <stdint.h>

bool pk_wifi_init(void);
// Connect with the stored credentials; returns true when associated + DHCP'd.
bool pk_wifi_connect(uint32_t timeout_ms);
bool pk_wifi_connected(void);

#endif // PK_WIFI_H
