// Wi-Fi: station mode for normal operation, a WPA2 setup hotspot
// ("FrameOS-XXXX", 192.168.4.1, captive portal) when there is no network to
// join — the same first-boot story as the ESP32 firmware (fos_wifi.c).
#ifndef PK_WIFI_H
#define PK_WIFI_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PK_WIFI_SCAN_MAX 20

typedef struct {
    char ssid[33];
    int16_t rssi;
    uint8_t channel;
    uint8_t auth; // CYW43 auth_mode bits; 0 = open
} pk_wifi_network_t;

bool pk_wifi_init(void);
bool pk_wifi_ready(void);

// Joins the configured network, keeping pk_poll() turning while it waits.
bool pk_wifi_connect(uint32_t timeout_ms);
bool pk_wifi_connected(void);
// Dotted quad, "" when there is no address.
const char *pk_wifi_ip(void);
int pk_wifi_rssi(void);

// Scans (station mode only; ~3 s) and returns the strongest-first list, which
// stays valid until the next scan. In hotspot mode the list from the scan
// taken just before the hotspot came up is returned instead.
const pk_wifi_network_t *pk_wifi_scan(size_t *count);

// Setup hotspot. Mints and persists the passphrase on first use.
bool pk_wifi_start_portal(void);
bool pk_wifi_portal_active(void);
const char *pk_wifi_portal_ssid(void);
const char *pk_wifi_portal_psk(void);
// When a hotspot client last talked to us (ms since boot); 0 = never.
uint32_t pk_wifi_portal_last_activity_ms(void);
void pk_wifi_portal_note_activity(void);

// Announces <hostname>.local (mDNS) — the backend addresses an embedded
// frame as frame<N>.local unless told otherwise.
void pk_wifi_start_mdns(void);

#endif // PK_WIFI_H
