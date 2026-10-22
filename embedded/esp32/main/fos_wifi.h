/*
 * Wi-Fi manager: STA with stored credentials, SoftAP provisioning portal
 * (DNS hijack + captive portal page served by fos_http) as fallback.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>
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
/* SoftAP "FrameOS-XXXX" (WPA2, per-device passphrase — see fos_wifi_ap_psk)
 * + DNS hijack; portal pages come from fos_http. */
esp_err_t fos_wifi_start_portal(void);
/* The provisioning portal keeps retrying the stored network in APSTA mode.
 * Once the station gets an address the open AP is stopped and this callback
 * runs (from a worker task, never the event loop) so the caller can restart
 * its services in station mode. Registering after the recovery already
 * happened runs the callback right away. */
typedef void (*fos_wifi_portal_exit_cb)(void);
void fos_wifi_set_portal_exit_cb(fos_wifi_portal_exit_cb cb);
fos_wifi_state_t fos_wifi_state(void);
/* IP as string when connected, AP IP in portal mode, else "". */
const char *fos_wifi_ip(void);
/* True when `local_addr` (an IPv4 address in network byte order, as
 * getsockname() returns it for an accepted socket) is the provisioning
 * soft-AP's own address — i.e. the connection arrived over the hotspot, not
 * the station link. False when the AP is not up, or when the station holds
 * the same address (a LAN numbered like the hotspot), so a LAN peer can
 * never pass for a hotspot one. */
bool fos_wifi_addr_is_portal_ap(uint32_t local_addr);
const char *fos_wifi_ap_ssid(void);
/* The portal AP passphrase. Minted from hardware entropy and stored in NVS
 * the first time it is needed (this call or the portal start), so it is the
 * same every boot and can be read off the status screen or the console. */
const char *fos_wifi_ap_psk(void);
int fos_wifi_rssi(void);
/* Drops of an established station link since boot: how many, the 802.11
 * reason code of the last one (WIFI_REASON_*), and how long the last one
 * that came back stayed down (0 until one has). */
void fos_wifi_drop_stats(uint32_t *drops, uint8_t *last_reason, uint32_t *last_down_ms);
/* Keeps the radio out of modem sleep while held (calls nest): the scene's
 * downloads hold it from connect to close (frameos_nim's HTTP busy hook).
 * No effect on frames whose power policy keeps modem sleep off anyway. */
void fos_wifi_hold_awake(bool hold);
/* Wait up to timeout for SNTP time sync after connecting. */
esp_err_t fos_wifi_sync_time(uint32_t timeout_ms);
bool fos_wifi_time_synced(void);
void fos_wifi_set_scan_only(bool enabled);
