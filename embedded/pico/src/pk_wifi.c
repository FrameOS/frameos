#include "pk_wifi.h"

#include <stdint.h>
#include <stdio.h>

#include "pico/cyw43_arch.h"
#include "pico/stdlib.h"

#include "pk_config.h"

static bool s_ready = false;

bool pk_wifi_init(void)
{
    if (s_ready) return true;
    if (cyw43_arch_init() != 0) {
        printf("wifi: cyw43 init failed\n");
        return false;
    }
    cyw43_arch_enable_sta_mode();
    s_ready = true;
    return true;
}

bool pk_wifi_connect(uint32_t timeout_ms)
{
    pk_config_t *config = pk_config();
    if (!s_ready || !pk_config_wifi_ready()) return false;
    printf("wifi: connecting to \"%s\"\n", config->wifi_ssid);
    int err = cyw43_arch_wifi_connect_timeout_ms(
        config->wifi_ssid,
        config->wifi_pass[0] ? config->wifi_pass : NULL,
        config->wifi_pass[0] ? CYW43_AUTH_WPA2_MIXED_PSK : CYW43_AUTH_OPEN,
        timeout_ms);
    if (err != 0) {
        printf("wifi: connect failed (%d)\n", err);
        return false;
    }
    printf("wifi: connected\n");
    return true;
}

bool pk_wifi_connected(void)
{
    if (!s_ready) return false;
    return cyw43_tcpip_link_status(&cyw43_state, CYW43_ITF_STA) == CYW43_LINK_UP;
}
