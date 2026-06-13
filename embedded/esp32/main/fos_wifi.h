/*
 * Wi-Fi manager: STA with stored credentials, SoftAP provisioning portal
 * (DNS hijack + captive portal page served by fos_http) as fallback.
 */
#pragma once

#include <stdbool.h>
#include "esp_err.h"

typedef enum {
    FOS_WIFI_OFFLINE = 0,
    FOS_WIFI_CONNECTING,
    FOS_WIFI_CONNECTED,
    FOS_WIFI_PORTAL,
} fos_wifi_state_t;

esp_err_t fos_wifi_init(void);
/* Connect with stored credentials; blocks up to timeout_ms. */
esp_err_t fos_wifi_connect(uint32_t timeout_ms);
/* SoftAP "FrameOS-XXXX" + DNS hijack; portal pages come from fos_http. */
esp_err_t fos_wifi_start_portal(void);
fos_wifi_state_t fos_wifi_state(void);
/* IP as string when connected, AP IP in portal mode, else "". */
const char *fos_wifi_ip(void);
const char *fos_wifi_ap_ssid(void);
int fos_wifi_rssi(void);
/* Wait up to timeout for SNTP time sync after connecting. */
esp_err_t fos_wifi_sync_time(uint32_t timeout_ms);
bool fos_wifi_time_synced(void);
void fos_wifi_set_scan_only(bool enabled);
