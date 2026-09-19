#include "pk_wifi.h"

#include <stdio.h>
#include <string.h>

#include "lwip/apps/mdns.h"
#include "lwip/ip4_addr.h"
#include "lwip/netif.h"
#include "lwip/pbuf.h"
#include "lwip/udp.h"
#include "pico/cyw43_arch.h"
#include "pico/stdlib.h"

#include "pk_config.h"
#include "pk_hotspot.h"
#include "pk_log.h"
#include "pk_platform.h"

#define SCAN_TIMEOUT_MS 10000
#define JOIN_RETRY_MS 3000

static bool s_ready = false;
static bool s_portal = false;
static bool s_mdns_started = false;
static char s_portal_ssid[24];
static uint32_t s_portal_last_activity_ms = 0;
static pk_wifi_network_t s_networks[PK_WIFI_SCAN_MAX];
static size_t s_network_count = 0;
static pk_dhcp_server_t s_dhcp;
static struct udp_pcb *s_dhcp_pcb = NULL;
static struct udp_pcb *s_dns_pcb = NULL;

bool pk_wifi_init(void)
{
    if (s_ready) return true;
    if (cyw43_arch_init() != 0) {
        pk_logf("wifi: cyw43 init failed");
        return false;
    }
    cyw43_arch_enable_sta_mode();
    // DHCP announces this name; mDNS answers for it once an address is up.
    netif_set_hostname(&cyw43_state.netif[CYW43_ITF_STA], pk_config()->hostname);
    s_ready = true;
    return true;
}

bool pk_wifi_ready(void)
{
    return s_ready;
}

bool pk_wifi_connect(uint32_t timeout_ms)
{
    pk_config_t *config = pk_config();
    if (!s_ready || s_portal || !pk_config_wifi_ready()) return false;
    const char *password = config->wifi_pass[0] ? config->wifi_pass : NULL;
    uint32_t auth = password ? CYW43_AUTH_WPA2_MIXED_PSK : CYW43_AUTH_OPEN;
    pk_logf("wifi: connecting to \"%s\"", config->wifi_ssid);
    // After a link drop the driver keeps reporting JOIN and never retries by
    // itself: leave first, so the loop below sees DOWN and joins afresh.
    if (cyw43_tcpip_link_status(&cyw43_state, CYW43_ITF_STA) != CYW43_LINK_DOWN) {
        cyw43_wifi_leave(&cyw43_state, CYW43_ITF_STA);
    }

    absolute_time_t deadline = make_timeout_time_ms(timeout_ms);
    absolute_time_t rejoin_at = get_absolute_time();
    while (absolute_time_diff_us(get_absolute_time(), deadline) > 0) {
        int status = cyw43_tcpip_link_status(&cyw43_state, CYW43_ITF_STA);
        if (status == CYW43_LINK_UP) {
            pk_logf("wifi: connected, ip %s", pk_wifi_ip());
            return true;
        }
        if (status == CYW43_LINK_BADAUTH) {
            pk_logf("wifi: the network refused the password");
            return false;
        }
        // Not joined (never tried, the AP was not found, or the join failed):
        // ask again, but no faster than the radio can finish an attempt.
        bool idle = status == CYW43_LINK_DOWN || status == CYW43_LINK_NONET || status == CYW43_LINK_FAIL;
        if (idle && absolute_time_diff_us(get_absolute_time(), rejoin_at) <= 0) {
            cyw43_arch_wifi_connect_async(config->wifi_ssid, password, auth);
            rejoin_at = make_timeout_time_ms(JOIN_RETRY_MS);
        }
        pk_wait_ms(50);
    }
    pk_logf("wifi: could not join \"%s\" within %lus", config->wifi_ssid,
            (unsigned long)(timeout_ms / 1000));
    return false;
}

bool pk_wifi_connected(void)
{
    if (!s_ready || s_portal) return false;
    return cyw43_tcpip_link_status(&cyw43_state, CYW43_ITF_STA) == CYW43_LINK_UP;
}

const char *pk_wifi_ip(void)
{
    static char text[16];
    text[0] = '\0';
    if (!s_ready) return text;
    const struct netif *netif = &cyw43_state.netif[s_portal ? CYW43_ITF_AP : CYW43_ITF_STA];
    if (!ip4_addr_isany(netif_ip4_addr(netif))) {
        snprintf(text, sizeof(text), "%s", ip4addr_ntoa(netif_ip4_addr(netif)));
    }
    return text;
}

int pk_wifi_rssi(void)
{
    int32_t rssi = 0;
    if (!pk_wifi_connected() || cyw43_wifi_get_rssi(&cyw43_state, &rssi) != 0) return 0;
    return (int)rssi;
}

// ------------------------------------------------------------------ scan

static int on_scan_result(void *env, const cyw43_ev_scan_result_t *result)
{
    (void)env;
    if (result == NULL || result->ssid_len == 0 || result->ssid_len > 32) return 0;
    char ssid[33];
    memcpy(ssid, result->ssid, result->ssid_len);
    ssid[result->ssid_len] = '\0';

    // One row per network name: a mesh shows up once, at its strongest.
    pk_wifi_network_t *slot = NULL;
    for (size_t i = 0; i < s_network_count; i++) {
        if (strcmp(s_networks[i].ssid, ssid) == 0) {
            if (result->rssi <= s_networks[i].rssi) return 0;
            slot = &s_networks[i];
            break;
        }
    }
    if (slot == NULL) {
        if (s_network_count < PK_WIFI_SCAN_MAX) {
            slot = &s_networks[s_network_count++];
        } else {
            // Full: replace the weakest entry if this one is stronger.
            slot = &s_networks[0];
            for (size_t i = 1; i < s_network_count; i++) {
                if (s_networks[i].rssi < slot->rssi) slot = &s_networks[i];
            }
            if (result->rssi <= slot->rssi) return 0;
        }
    }
    snprintf(slot->ssid, sizeof(slot->ssid), "%s", ssid);
    slot->rssi = result->rssi;
    slot->channel = (uint8_t)result->channel;
    slot->auth = result->auth_mode;
    return 0;
}

const pk_wifi_network_t *pk_wifi_scan(size_t *count)
{
    if (s_ready && !s_portal) {
        s_network_count = 0;
        cyw43_wifi_scan_options_t options = {0};
        if (cyw43_wifi_scan(&cyw43_state, &options, NULL, on_scan_result) == 0) {
            absolute_time_t deadline = make_timeout_time_ms(SCAN_TIMEOUT_MS);
            while (cyw43_wifi_scan_active(&cyw43_state) &&
                   absolute_time_diff_us(get_absolute_time(), deadline) > 0) {
                pk_wait_ms(20);
            }
        }
        // Strongest first; twenty entries do not need a better sort.
        for (size_t i = 1; i < s_network_count; i++) {
            pk_wifi_network_t moving = s_networks[i];
            size_t j = i;
            while (j > 0 && s_networks[j - 1].rssi < moving.rssi) {
                s_networks[j] = s_networks[j - 1];
                j--;
            }
            s_networks[j] = moving;
        }
    }
    if (count) *count = s_network_count;
    return s_networks;
}

// --------------------------------------------------------------- hotspot

static void on_dhcp(void *arg, struct udp_pcb *pcb, struct pbuf *p, const ip_addr_t *addr, u16_t port)
{
    (void)arg;
    (void)addr;
    (void)port;
    static uint8_t request[600];
    static uint8_t reply[320];
    size_t len = pbuf_copy_partial(p, request, sizeof(request), 0);
    pbuf_free(p);
    size_t reply_len = pk_dhcp_handle(&s_dhcp, request, len, reply, sizeof(reply));
    if (reply_len == 0) return;
    struct pbuf *out = pbuf_alloc(PBUF_TRANSPORT, (u16_t)reply_len, PBUF_RAM);
    if (out == NULL) return;
    memcpy(out->payload, reply, reply_len);
    // The client has no address yet: the answer goes out as a broadcast on
    // the hotspot interface.
    udp_sendto_if(pcb, out, IP_ADDR_BROADCAST, 68, &cyw43_state.netif[CYW43_ITF_AP]);
    pbuf_free(out);
    pk_wifi_portal_note_activity();
}

static void on_dns(void *arg, struct udp_pcb *pcb, struct pbuf *p, const ip_addr_t *addr, u16_t port)
{
    (void)arg;
    static uint8_t query[512];
    static uint8_t reply[512 + 16];
    size_t len = pbuf_copy_partial(p, query, sizeof(query), 0);
    pbuf_free(p);
    size_t reply_len = pk_dns_hijack(query, len, reply, sizeof(reply));
    if (reply_len == 0) return;
    struct pbuf *out = pbuf_alloc(PBUF_TRANSPORT, (u16_t)reply_len, PBUF_RAM);
    if (out == NULL) return;
    memcpy(out->payload, reply, reply_len);
    udp_sendto(pcb, out, addr, port);
    pbuf_free(out);
}

static struct udp_pcb *listen_udp(u16_t port, udp_recv_fn handler)
{
    struct udp_pcb *pcb = udp_new_ip_type(IPADDR_TYPE_V4);
    if (pcb == NULL) return NULL;
    ip_set_option(pcb, SOF_BROADCAST);
    if (udp_bind(pcb, IP_ANY_TYPE, port) != ERR_OK) {
        udp_remove(pcb);
        return NULL;
    }
    udp_recv(pcb, handler, NULL);
    return pcb;
}

bool pk_wifi_start_portal(void)
{
    if (!s_ready) return false;
    if (s_portal) return true;
    pk_config_t *config = pk_config();

    // The radio cannot scan once it is an access point, so the network list
    // the setup page offers is taken now.
    pk_wifi_scan(NULL);

    if (strlen(config->ap_psk) < 8) {
        pk_hotspot_mint_psk(pk_random32, config->ap_psk);
        if (!pk_config_save()) {
            pk_logf("wifi: hotspot passphrase minted but not saved (it changes on the next boot)");
        }
    }
    uint8_t mac[6] = {0};
    cyw43_wifi_get_mac(&cyw43_state, CYW43_ITF_STA, mac);
    snprintf(s_portal_ssid, sizeof(s_portal_ssid), "FrameOS-%02X%02X", mac[4], mac[5]);

    cyw43_arch_disable_sta_mode();
    cyw43_arch_enable_ap_mode(s_portal_ssid, config->ap_psk, CYW43_AUTH_WPA2_AES_PSK);
    s_portal = true;

    pk_dhcp_init(&s_dhcp);
    cyw43_arch_lwip_begin();
    s_dhcp_pcb = listen_udp(67, on_dhcp);
    s_dns_pcb = listen_udp(53, on_dns);
    cyw43_arch_lwip_end();
    if (s_dhcp_pcb == NULL || s_dns_pcb == NULL) {
        pk_logf("wifi: hotspot DHCP/DNS could not start");
    }
    pk_logf("wifi: setup hotspot \"%s\" up at %s", s_portal_ssid, PK_HOTSPOT_IP_STRING);
    return true;
}

bool pk_wifi_portal_active(void)
{
    return s_portal;
}

const char *pk_wifi_portal_ssid(void)
{
    return s_portal_ssid;
}

const char *pk_wifi_portal_psk(void)
{
    return pk_config()->ap_psk;
}

uint32_t pk_wifi_portal_last_activity_ms(void)
{
    return s_portal_last_activity_ms;
}

void pk_wifi_portal_note_activity(void)
{
    s_portal_last_activity_ms = to_ms_since_boot(get_absolute_time());
    if (s_portal_last_activity_ms == 0) s_portal_last_activity_ms = 1;
}

// ------------------------------------------------------------------ mDNS

void pk_wifi_start_mdns(void)
{
    if (!s_ready || s_portal || s_mdns_started) return;
    const char *hostname = pk_config()->hostname;
    if (hostname[0] == '\0') return;
    cyw43_arch_lwip_begin();
    mdns_resp_init();
    struct netif *netif = &cyw43_state.netif[CYW43_ITF_STA];
    if (mdns_resp_add_netif(netif, hostname) == ERR_OK) {
        mdns_resp_add_service(netif, "FrameOS", "_http", DNSSD_PROTO_TCP, 80, NULL, NULL);
        s_mdns_started = true;
    }
    cyw43_arch_lwip_end();
    if (s_mdns_started) pk_logf("wifi: answering as %s.local", hostname);
}
