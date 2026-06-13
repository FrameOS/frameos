#include "fos_wifi.h"

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"

#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_wifi.h"
#include "lwip/sockets.h"

#include "fos_config.h"

static const char *TAG = "fos_wifi";

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAILED_BIT BIT1
#define WIFI_MAX_RETRIES 6

static EventGroupHandle_t s_events;
static fos_wifi_state_t s_state = FOS_WIFI_OFFLINE;
static char s_ip[16] = "";
static char s_ap_ssid[32] = "";
static int s_retries = 0;
static bool s_time_synced = false;
static bool s_scan_only = false;
static esp_netif_t *s_sta_netif = NULL;
static esp_netif_t *s_ap_netif = NULL;

static const char *disconnect_reason_name(uint8_t reason)
{
    switch (reason) {
        case WIFI_REASON_BEACON_TIMEOUT:
            return "beacon_timeout";
        case WIFI_REASON_NO_AP_FOUND:
            return "no_ap_found";
        case WIFI_REASON_AUTH_FAIL:
            return "auth_fail";
        case WIFI_REASON_ASSOC_FAIL:
            return "assoc_fail";
        case WIFI_REASON_HANDSHAKE_TIMEOUT:
            return "handshake_timeout";
        case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY:
            return "no_ap_found_with_compatible_security";
        case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD:
            return "no_ap_found_in_authmode_threshold";
        case WIFI_REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD:
            return "no_ap_found_in_rssi_threshold";
        default:
            return "unknown";
    }
}

static void configure_wifi_country(void)
{
    /*
     * ESP-IDF defaults to "01" world-safe mode (channels 1-11). Many EU
     * networks use channels 12/13, which otherwise surfaces as NO_AP_FOUND.
     */
    const wifi_country_t country = {
        .cc = "01",
        .schan = 1,
        .nchan = 13,
        .max_tx_power = 20,
        .policy = WIFI_COUNTRY_POLICY_MANUAL,
    };
    esp_err_t err = esp_wifi_set_country(&country);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "wifi 2.4GHz channels set to 1-13");
    } else {
        ESP_LOGW(TAG, "failed to set wifi country/channel range: %s", esp_err_to_name(err));
    }
}

static void apply_hostname(esp_netif_t *netif)
{
    const char *hostname = fos_config()->hostname;
    if (!hostname[0]) {
        return;
    }
    esp_err_t err = esp_netif_set_hostname(netif, hostname);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "hostname set to %s", hostname);
    } else {
        ESP_LOGW(TAG, "failed to set hostname %s: %s", hostname, esp_err_to_name(err));
    }
}

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        if (!s_scan_only) {
            esp_wifi_connect();
        }
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *event = (wifi_event_sta_disconnected_t *)data;
        uint8_t reason = event ? event->reason : 0;
        s_ip[0] = '\0';
        if (s_state == FOS_WIFI_CONNECTING && s_retries++ < WIFI_MAX_RETRIES) {
            ESP_LOGW(TAG, "disconnected reason=%u (%s), retry %d/%d",
                     (unsigned)reason, disconnect_reason_name(reason), s_retries, WIFI_MAX_RETRIES);
            esp_wifi_connect();
        } else if (s_state == FOS_WIFI_CONNECTING) {
            xEventGroupSetBits(s_events, WIFI_FAILED_BIT);
        } else if (s_state == FOS_WIFI_CONNECTED) {
            ESP_LOGW(TAG, "connection lost, reconnecting");
            s_state = FOS_WIFI_CONNECTING;
            s_retries = 0;
            esp_wifi_connect();
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)data;
        snprintf(s_ip, sizeof(s_ip), IPSTR, IP2STR(&event->ip_info.ip));
        s_retries = 0;
        s_state = FOS_WIFI_CONNECTED;
        ESP_LOGI(TAG, "got ip %s", s_ip);
        xEventGroupSetBits(s_events, WIFI_CONNECTED_BIT);
    }
}

esp_err_t fos_wifi_init(void)
{
    s_events = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    configure_wifi_country();
    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                        &wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                                        &wifi_event_handler, NULL, NULL));
    return ESP_OK;
}

esp_err_t fos_wifi_connect(uint32_t timeout_ms)
{
    fos_config_t *config = fos_config();
    if (!config->wifi_ssid[0]) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!s_sta_netif) {
        s_sta_netif = esp_netif_create_default_wifi_sta();
        apply_hostname(s_sta_netif);
    }

    wifi_config_t wifi_config = {0};
    strlcpy((char *)wifi_config.sta.ssid, config->wifi_ssid, sizeof(wifi_config.sta.ssid));
    strlcpy((char *)wifi_config.sta.password, config->wifi_pass, sizeof(wifi_config.sta.password));
    wifi_config.sta.threshold.authmode = config->wifi_pass[0] ? WIFI_AUTH_WPA_PSK : WIFI_AUTH_OPEN;
    wifi_config.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;

    s_state = FOS_WIFI_CONNECTING;
    s_retries = 0;
    xEventGroupClearBits(s_events, WIFI_CONNECTED_BIT | WIFI_FAILED_BIT);
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_LOGI(TAG, "connecting to \"%s\"", config->wifi_ssid);

    EventBits_t bits = xEventGroupWaitBits(s_events, WIFI_CONNECTED_BIT | WIFI_FAILED_BIT,
                                           pdFALSE, pdFALSE, pdMS_TO_TICKS(timeout_ms));
    if (bits & WIFI_CONNECTED_BIT) {
        return ESP_OK;
    }
    s_state = FOS_WIFI_OFFLINE;
    ESP_LOGW(TAG, "failed to connect to \"%s\"", config->wifi_ssid);
    return ESP_FAIL;
}

/* --- captive portal DNS hijack: answer every A query with our AP address --- */

static void dns_hijack_task(void *arg)
{
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(53),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (sock < 0 || bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        ESP_LOGE(TAG, "dns hijack: socket/bind failed");
        if (sock >= 0) close(sock);
        vTaskDelete(NULL);
        return;
    }
    ESP_LOGI(TAG, "dns hijack listening on :53");

    uint8_t buf[512];
    while (true) {
        struct sockaddr_in source;
        socklen_t source_len = sizeof(source);
        int len = recvfrom(sock, buf, sizeof(buf) - 16, 0, (struct sockaddr *)&source, &source_len);
        if (len < 12) continue;

        /* QR=1, AA=1, RCODE=0; copy the question, append one A record -> 192.168.4.1 */
        buf[2] = 0x84;
        buf[3] = 0x00;
        buf[6] = 0x00; buf[7] = 0x01; /* ANCOUNT=1 */
        buf[8] = buf[9] = buf[10] = buf[11] = 0;

        /* find end of QNAME (skip labels) to keep only the first question */
        int qend = 12;
        while (qend < len && buf[qend] != 0) qend += buf[qend] + 1;
        qend += 5; /* null + QTYPE + QCLASS */
        if (qend > len) continue;

        int pos = qend;
        buf[pos++] = 0xC0; buf[pos++] = 0x0C;             /* name: pointer to question */
        buf[pos++] = 0x00; buf[pos++] = 0x01;             /* type A */
        buf[pos++] = 0x00; buf[pos++] = 0x01;             /* class IN */
        buf[pos++] = 0; buf[pos++] = 0; buf[pos++] = 0; buf[pos++] = 30; /* TTL 30s */
        buf[pos++] = 0x00; buf[pos++] = 0x04;             /* RDLENGTH */
        buf[pos++] = 192; buf[pos++] = 168; buf[pos++] = 4; buf[pos++] = 1;
        sendto(sock, buf, pos, 0, (struct sockaddr *)&source, source_len);
    }
}

esp_err_t fos_wifi_start_portal(void)
{
    if (!s_ap_netif) {
        s_ap_netif = esp_netif_create_default_wifi_ap();
    }
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    snprintf(s_ap_ssid, sizeof(s_ap_ssid), "FrameOS-%02X%02X", mac[4], mac[5]);

    wifi_config_t ap_config = {
        .ap = {
            .channel = 1,
            .max_connection = 4,
            .authmode = WIFI_AUTH_OPEN,
        },
    };
    strlcpy((char *)ap_config.ap.ssid, s_ap_ssid, sizeof(ap_config.ap.ssid));
    ap_config.ap.ssid_len = strlen(s_ap_ssid);

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap_config));
    ESP_ERROR_CHECK(esp_wifi_start());
    s_state = FOS_WIFI_PORTAL;
    strlcpy(s_ip, "192.168.4.1", sizeof(s_ip));
    xTaskCreate(dns_hijack_task, "fos_dns", 3072, NULL, 5, NULL);
    ESP_LOGI(TAG, "provisioning portal up: ssid=%s ip=%s", s_ap_ssid, s_ip);
    return ESP_OK;
}

fos_wifi_state_t fos_wifi_state(void) { return s_state; }
const char *fos_wifi_ip(void) { return s_ip; }
const char *fos_wifi_ap_ssid(void) { return s_ap_ssid; }

int fos_wifi_rssi(void)
{
    wifi_ap_record_t ap;
    if (s_state == FOS_WIFI_CONNECTED && esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
        return ap.rssi;
    }
    return 0;
}

esp_err_t fos_wifi_sync_time(uint32_t timeout_ms)
{
    esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    esp_err_t err = esp_netif_sntp_init(&config);
    if (err != ESP_OK) return err;
    err = esp_netif_sntp_sync_wait(pdMS_TO_TICKS(timeout_ms));
    s_time_synced = err == ESP_OK;
    if (s_time_synced) {
        time_t now = time(NULL);
        ESP_LOGI(TAG, "time synced: %s", ctime(&now));
    } else {
        ESP_LOGW(TAG, "SNTP sync timed out");
    }
    return err;
}

bool fos_wifi_time_synced(void) { return s_time_synced; }

void fos_wifi_set_scan_only(bool enabled) { s_scan_only = enabled; }
