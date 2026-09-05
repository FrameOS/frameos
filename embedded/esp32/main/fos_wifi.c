#include "fos_wifi.h"

#include <string.h>
#include <sys/time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"

#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "lwip/sockets.h"

#include "fos_config.h"
#include "esp_timer.h"

static const char *TAG = "fos_wifi";

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAILED_BIT BIT1
#define WIFI_MAX_RETRIES 12
#define WIFI_PORTAL_RETRY_LOG_INTERVAL 10

static EventGroupHandle_t s_events;
static fos_wifi_state_t s_state = FOS_WIFI_OFFLINE;
static char s_ip[16] = "";
static char s_ap_ssid[32] = "";
static int s_retries = 0;
static bool s_time_synced = false;
static bool s_scan_only = false;
static bool s_portal_active = false;
static bool s_portal_sta_retry = false;
/* While the portal is up, the station side retries the stored network in
 * APSTA mode so a router that comes back is joined without a reboot. Each
 * retry is an all-channel scan that takes the soft-AP off the air, and an
 * immediate retry loop kept it off most of the time: a phone saw the
 * hotspot in one scan out of three and lost it mid-join (2026-09-04, E1002).
 * Space the retries out instead. */
#define WIFI_PORTAL_RETRY_INTERVAL_MS 30000
static esp_timer_handle_t s_portal_retry_timer = NULL;

static void portal_retry_timer_cb(void *arg)
{
    (void)arg;
    if (s_portal_active && s_portal_sta_retry && !s_scan_only) {
        esp_wifi_connect();
    }
}

static void schedule_portal_retry(void)
{
    if (!s_portal_retry_timer) {
        const esp_timer_create_args_t args = {
            .callback = portal_retry_timer_cb,
            .name = "fos_portal_retry",
        };
        if (esp_timer_create(&args, &s_portal_retry_timer) != ESP_OK) {
            esp_wifi_connect();
            return;
        }
    }
    esp_timer_stop(s_portal_retry_timer);
    if (esp_timer_start_once(s_portal_retry_timer, (uint64_t)WIFI_PORTAL_RETRY_INTERVAL_MS * 1000) != ESP_OK) {
        esp_wifi_connect();
    }
}
static volatile bool s_dns_hijack_run = false;
static fos_wifi_portal_exit_cb s_portal_exit_cb = NULL;
static bool s_portal_exit_pending = false;
static portMUX_TYPE s_portal_exit_lock = portMUX_INITIALIZER_UNLOCKED;
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

static void disable_power_save(void)
{
    esp_err_t err = esp_wifi_set_ps(WIFI_PS_NONE);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "wifi power save disabled");
    } else {
        ESP_LOGW(TAG, "failed to disable wifi power save: %s", esp_err_to_name(err));
    }
}

/* Station power policy. A frame that deep-sleeps between renders is a
 * battery frame first and a low-latency HTTP server second: with modem
 * sleep off the radio listens continuously (~80-100 mA on an S3) for the
 * whole 60-120 s a render + Spectra-6 refresh keeps it awake, which is most
 * of the energy such a wake costs. WIFI_PS_MIN_MODEM keeps it in the AP's
 * DTIM cadence instead (~20 mA idle) and costs a little throughput and a
 * few ms of latency — the right trade while the CPU spends 20 s dithering
 * and 30 s waiting on BUSY. Stay-connected frames keep the old behaviour:
 * their local HTTP API and the workspace's live preview want the latency. */
static void apply_power_save_policy(void)
{
    fos_config_t *config = fos_config();
    bool sleeps = config->deep_sleep || config->deep_sleep_on_battery;
    if (!sleeps) {
        disable_power_save();
        return;
    }
    esp_err_t err = esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "wifi modem sleep enabled (deep-sleep frame)");
    } else {
        ESP_LOGW(TAG, "failed to enable wifi modem sleep: %s", esp_err_to_name(err));
    }
}

static void portal_exit_task(void *arg);

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
        } else if (s_portal_active && s_portal_sta_retry && !s_scan_only) {
            s_state = FOS_WIFI_PORTAL;
            strlcpy(s_ip, "192.168.4.1", sizeof(s_ip));
            s_retries++;
            if (s_retries == 1 || (s_retries % WIFI_PORTAL_RETRY_LOG_INTERVAL) == 0) {
                ESP_LOGW(TAG, "portal STA disconnected reason=%u (%s), background retry #%d in %d s",
                         (unsigned)reason, disconnect_reason_name(reason), s_retries,
                         WIFI_PORTAL_RETRY_INTERVAL_MS / 1000);
            }
            schedule_portal_retry();
        } else if (s_state == FOS_WIFI_CONNECTING) {
            xEventGroupSetBits(s_events, WIFI_FAILED_BIT);
        } else if (s_state == FOS_WIFI_CONNECTED) {
            /* A scan-initiated disconnect must not race the scan with an
             * immediate reconnect ("STA is connecting, scan not allowed");
             * the scanner reconnects when it is done. */
            if (s_scan_only) {
                s_state = s_portal_active ? FOS_WIFI_PORTAL : FOS_WIFI_CONNECTING;
                s_retries = 0;
            } else {
                ESP_LOGW(TAG, "connection lost, reconnecting");
                s_state = s_portal_active ? FOS_WIFI_PORTAL : FOS_WIFI_CONNECTING;
                s_retries = 0;
                esp_wifi_connect();
            }
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)data;
        snprintf(s_ip, sizeof(s_ip), IPSTR, IP2STR(&event->ip_info.ip));
        s_retries = 0;
        s_state = FOS_WIFI_CONNECTED;
        ESP_LOGI(TAG, "got ip %s", s_ip);
        xEventGroupSetBits(s_events, WIFI_CONNECTED_BIT);
        if (s_portal_active) {
            /* The stored network answered after all: the open AP has no job
             * left and must not stay in radio range as a second front door.
             * Cleared here so a later disconnect follows the plain station
             * path; the teardown itself needs a real stack (httpd restart,
             * SNTP wait in the callback), not the event task's. */
            s_portal_active = false;
            s_portal_sta_retry = false;
            if (s_portal_retry_timer) esp_timer_stop(s_portal_retry_timer);
            if (xTaskCreate(portal_exit_task, "fos_portal_exit", 6144, NULL, 5, NULL) != pdPASS) {
                ESP_LOGW(TAG, "portal teardown task failed to start");
            }
        }
    }
}

esp_err_t fos_wifi_init(void)
{
    s_events = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    /* The driver mirrors every setting it is given (~45 `nvs.net80211` items:
     * ap.*, sta.*, PMK cache) into NVS, next to the copy FrameOS already
     * keeps in its own namespace and re-applies below on every boot. On the
     * 16 KB NVS of the 4 MB / 8 MB layouts that mirror plus a backend TLS
     * certificate and key (~2.9 KB of PEM) filled the partition: the driver
     * logged `wifi_nvs_set fail ... ret=4357` (ESP_ERR_NVS_NOT_ENOUGH_SPACE),
     * `wifi <ssid>` no longer persisted, and the PHY calibration store failed
     * (4 MB C3, 2026-09-05). RAM storage drops the mirror; the credentials
     * FrameOS stores are the only copy, as they always effectively were. */
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
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
    /* Mesh networks broadcast the SSID from several nodes; the default fast
     * scan joins the first one heard, which can be a distant node that then
     * drops the link with low-ack disconnects (reason 34). Scan everything
     * and join the strongest BSSID instead. */
    wifi_config.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    wifi_config.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;

    s_state = FOS_WIFI_CONNECTING;
    s_retries = 0;
    s_portal_active = false;
    s_portal_sta_retry = false;
    if (s_portal_retry_timer) esp_timer_stop(s_portal_retry_timer);
    xEventGroupClearBits(s_events, WIFI_CONNECTED_BIT | WIFI_FAILED_BIT);
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());
    apply_power_save_policy();
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
    /* Wake every half second so the loop notices the portal going away. */
    struct timeval poll = { .tv_sec = 0, .tv_usec = 500000 };
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &poll, sizeof(poll));
    ESP_LOGI(TAG, "dns hijack listening on :53");

    uint8_t buf[512];
    while (s_dns_hijack_run) {
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
    close(sock);
    ESP_LOGI(TAG, "dns hijack stopped");
    vTaskDelete(NULL);
}

/* Station recovered while the portal was up: drop the AP (APSTA -> STA keeps
 * the station associated), stop answering DNS for it, put the modem back on
 * the frame's power policy, then hand over to whoever registered for it. */
static void portal_exit_task(void *arg)
{
    s_dns_hijack_run = false;
    esp_err_t err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "failed to stop the portal AP: %s", esp_err_to_name(err));
    }
    apply_power_save_policy();
    ESP_LOGI(TAG, "station recovered (%s); provisioning portal %s stopped", s_ip, s_ap_ssid);

    fos_wifi_portal_exit_cb cb;
    taskENTER_CRITICAL(&s_portal_exit_lock);
    cb = s_portal_exit_cb;
    if (!cb) s_portal_exit_pending = true;
    taskEXIT_CRITICAL(&s_portal_exit_lock);
    if (cb) cb();
    vTaskDelete(NULL);
}

void fos_wifi_set_portal_exit_cb(fos_wifi_portal_exit_cb cb)
{
    bool run_now;
    taskENTER_CRITICAL(&s_portal_exit_lock);
    s_portal_exit_cb = cb;
    run_now = cb != NULL && s_portal_exit_pending;
    if (run_now) s_portal_exit_pending = false;
    taskEXIT_CRITICAL(&s_portal_exit_lock);
    if (run_now) cb();
}

/* Readable and unambiguous on a small e-paper panel: no 0/O, 1/l/I. 31
 * symbols, so bytes >= 248 (= 8 * 31) are rejected rather than folded, which
 * would make the first few symbols likelier — this is a WPA2 passphrase. */
static const char AP_PSK_ALPHABET[] = "abcdefghjkmnpqrstuvwxyz23456789";
#define AP_PSK_LENGTH 10

const char *fos_wifi_ap_psk(void)
{
    fos_config_t *config = fos_config();
    if (config->ap_psk[0]) return config->ap_psk;
    size_t n = 0;
    while (n < AP_PSK_LENGTH) {
        uint32_t word = esp_random();
        for (int i = 0; i < 4 && n < AP_PSK_LENGTH; i++) {
            uint8_t byte = (uint8_t)(word >> (8 * i));
            if (byte >= 248) continue;
            config->ap_psk[n++] = AP_PSK_ALPHABET[byte % (sizeof(AP_PSK_ALPHABET) - 1)];
        }
    }
    config->ap_psk[n] = '\0';
    esp_err_t err = fos_config_save();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "portal passphrase minted but not saved: %s (it changes on the next boot)",
                 esp_err_to_name(err));
    }
    return config->ap_psk;
}

esp_err_t fos_wifi_start_portal(void)
{
    if (!s_ap_netif) {
        s_ap_netif = esp_netif_create_default_wifi_ap();
    }
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    snprintf(s_ap_ssid, sizeof(s_ap_ssid), "FrameOS-%02X%02X", mac[4], mac[5]);
    const char *psk = fos_wifi_ap_psk();

    wifi_config_t ap_config = {
        .ap = {
            .channel = 1,
            .max_connection = 4,
            .authmode = WIFI_AUTH_WPA2_PSK,
            .pmf_cfg = { .required = false },
        },
    };
    strlcpy((char *)ap_config.ap.ssid, s_ap_ssid, sizeof(ap_config.ap.ssid));
    ap_config.ap.ssid_len = strlen(s_ap_ssid);
    strlcpy((char *)ap_config.ap.password, psk, sizeof(ap_config.ap.password));

    bool keep_sta_retrying = fos_config_wifi_ready();
    ESP_ERROR_CHECK(esp_wifi_set_mode(keep_sta_retrying ? WIFI_MODE_APSTA : WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap_config));
    ESP_ERROR_CHECK(esp_wifi_start());
    disable_power_save();
    s_portal_active = true;
    s_portal_sta_retry = keep_sta_retrying;
    s_state = FOS_WIFI_PORTAL;
    strlcpy(s_ip, "192.168.4.1", sizeof(s_ip));
    if (keep_sta_retrying) {
        s_retries = 0;
        esp_err_t err = esp_wifi_connect();
        if (err == ESP_OK) {
            ESP_LOGI(TAG, "provisioning portal up; station will keep retrying \"%s\" in APSTA mode",
                     fos_config()->wifi_ssid);
        } else {
            ESP_LOGW(TAG, "failed to start portal station retry: %s", esp_err_to_name(err));
        }
    }
    s_dns_hijack_run = true;
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

/* SNTP keeps polling in the background after the boot-time wait; a pool
 * that answered late used to leave s_time_synced false for the whole boot —
 * hub-stamped logs, no wake-check schedule, no wall-clock alignment — even
 * though the clock had long been set (12 h of it on an awake E1004). */
static void on_sntp_synced(struct timeval *tv)
{
    (void)tv;
    s_time_synced = true;
}

esp_err_t fos_wifi_sync_time(uint32_t timeout_ms)
{
    esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    config.sync_cb = on_sntp_synced;
    esp_err_t err = esp_netif_sntp_init(&config);
    if (err != ESP_OK) return err;
    /* Back from deep sleep with the RTC still counting: the clock is the
     * one we set last boot, off by at most the RTC oscillator's drift over
     * one sleep — and the sleep timer that woke us ran on that same
     * oscillator, so the wake-check bookkeeping (s_next_render_due) agrees
     * with it either way. Don't sit on the boot path for a round trip to the
     * pool (or the full timeout when it is slow); let SNTP correct the clock
     * in the background while the render already runs. */
    time_t kept = time(NULL);
    if (esp_reset_reason() == ESP_RST_DEEPSLEEP && kept > 1000000000) {
        s_time_synced = true;
        ESP_LOGI(TAG, "clock kept through deep sleep: %s", ctime(&kept));
        return ESP_OK;
    }
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
