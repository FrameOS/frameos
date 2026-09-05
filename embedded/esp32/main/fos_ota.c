#include "fos_ota.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_app_desc.h"
#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "nvs.h"
#include "sdkconfig.h"

#include "mbedtls/base64.h"
#include "monocypher.h"
#include "monocypher-ed25519.h"

#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_http.h"
#include "fos_ota_pubkey.h"
#include "fos_version.h"
#include "fos_wifi.h"
#include "frameos_nim.h"

static const char *TAG = "fos_ota";
#define FOS_OTA_BOOT_REQUEST_KEY "ota_req"
#define FOS_OTA_REBOOT_DELAY_MS 1000
#define FOS_OTA_REBOOT_TASK_STACK_SIZE 2048
#define FOS_OTA_MANIFEST_MAX (8 * 1024)
#define FOS_OTA_CHUNK (8 * 1024)
/* Transient download failures (a dropped socket, a short read) are retried
 * this many times within one run, after the Wi-Fi is back; a signature or
 * image-validation failure is final for the run. Across runs the RTC give-up
 * counter below stops a frame redialing an image it keeps failing. */
#define FOS_OTA_DOWNLOAD_ATTEMPTS 3
#define FOS_OTA_RETRY_DELAY_MS 3000
#define FOS_OTA_WIFI_RECONNECT_TIMEOUT_MS 30000
#define FOS_OTA_AUTH_LEN (FOS_CLOUD_TOKEN_LEN + 16)

static StaticSemaphore_t s_ota_lock_storage;
static SemaphoreHandle_t s_ota_lock = NULL;
static portMUX_TYPE s_ota_lock_mux = portMUX_INITIALIZER_UNLOCKED;
static portMUX_TYPE s_ota_request_mux = portMUX_INITIALIZER_UNLOCKED;
static TaskHandle_t s_ota_task_handle = NULL;
static volatile bool s_ota_busy = false;
static volatile bool s_ota_reboot_scheduled = false;
static volatile bool s_cloud_ota_running = false;

/* ----------------------------------------------------------- platform
 * The release publishes one signed app image per chip × flash layout
 * (ci_build_image.sh, .github/workflows/docker-publish-multi.yml). The
 * 8 MB S3 and 4 MB C3 layouts ARE the "generic" pair; the others carry the
 * layout in the name. Sized from what this image was built with, which is
 * also the partition table the merged image put on the board. */
const char *fos_ota_platform(void)
{
#if CONFIG_IDF_TARGET_ESP32S3
#if CONFIG_ESPTOOLPY_FLASHSIZE_4MB
    return "esp32-s3-4mb";
#elif CONFIG_ESPTOOLPY_FLASHSIZE_16MB
    return "esp32-s3-16mb";
#elif CONFIG_ESPTOOLPY_FLASHSIZE_32MB
    return "esp32-s3-32mb";
#else
    return "esp32-s3-generic";
#endif
#else
#if CONFIG_ESPTOOLPY_FLASHSIZE_8MB
    return "esp32-c3-8mb";
#elif CONFIG_ESPTOOLPY_FLASHSIZE_16MB
    return "esp32-c3-16mb";
#elif CONFIG_ESPTOOLPY_FLASHSIZE_32MB
    return "esp32-c3-32mb";
#else
    return "esp32-c3-generic";
#endif
#endif
}

/* ----------------------------------------------------------- plumbing */

static const char *wifi_state_name(fos_wifi_state_t state)
{
    switch (state) {
        case FOS_WIFI_OFFLINE: return "offline";
        case FOS_WIFI_CONNECTING: return "connecting";
        case FOS_WIFI_CONNECTED: return "connected";
        case FOS_WIFI_PORTAL: return "portal";
        default: return "unknown";
    }
}

static bool ota_supported(void)
{
    return esp_ota_get_next_update_partition(NULL) != NULL;
}

static bool load_boot_request(void)
{
    nvs_handle_t nvs;
    uint8_t value = 0;
    if (nvs_open("frameos", NVS_READONLY, &nvs) != ESP_OK) return false;
    esp_err_t err = nvs_get_u8(nvs, FOS_OTA_BOOT_REQUEST_KEY, &value);
    nvs_close(nvs);
    return err == ESP_OK && value == 1;
}

static esp_err_t store_boot_request(bool pending)
{
    nvs_handle_t nvs;
    esp_err_t err = nvs_open("frameos", NVS_READWRITE, &nvs);
    if (err != ESP_OK) return err;
    if (pending) {
        err = nvs_set_u8(nvs, FOS_OTA_BOOT_REQUEST_KEY, 1);
    } else {
        err = nvs_erase_key(nvs, FOS_OTA_BOOT_REQUEST_KEY);
        if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    }
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);
    return err;
}

static bool wait_for_wifi_connected(uint32_t timeout_ms)
{
    int64_t deadline = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
    while (fos_wifi_state() != FOS_WIFI_CONNECTED) {
        if (esp_timer_get_time() >= deadline) return false;
        vTaskDelay(pdMS_TO_TICKS(250));
    }
    return true;
}

static SemaphoreHandle_t ota_lock(void)
{
    if (s_ota_lock != NULL) return s_ota_lock;
    taskENTER_CRITICAL(&s_ota_lock_mux);
    if (s_ota_lock == NULL) {
        s_ota_lock = xSemaphoreCreateMutexStatic(&s_ota_lock_storage);
    }
    taskEXIT_CRITICAL(&s_ota_lock_mux);
    return s_ota_lock;
}

void fos_ota_mark_boot_valid(void)
{
    if (!ota_supported()) return;

    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) == ESP_OK &&
        state == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_LOGI(TAG, "first boot of new image on %s: marking valid", running->label);
        esp_ota_mark_app_valid_cancel_rollback();
    }
}

/* ----------------------------------------------------------- the signed path
 * docs/cloud-frames.md "Signed OTA": the control plane serves a device-authed
 * manifest carrying a minisign signature (Ed25519 over BLAKE2b-512 of the
 * image, tools/sign_firmware.py). The image streams to the inactive slot
 * with incremental hashing; the boot partition switches ONLY after the
 * signature verifies against the baked release key (fos_ota_pubkey.h).
 * Rollback protection stays on top: the new image boots pending-verify and
 * rolls back unless it reaches Wi-Fi. */

/* Where one run pulls from. Both control planes fill one of these; nothing
 * below knows which plane it serves beyond the log event name. */
typedef struct {
    const char *plane;                 /* "backend" | "cloud": the `ota:<plane>` log event */
    char base_url[FOS_URL_LEN];        /* origin for a relative downloadUrl; the bearer goes here only */
    char manifest_url[FOS_URL_LEN + 192];
    char auth[FOS_OTA_AUTH_LEN];       /* "Bearer …" */
    /* The self-hosted backend may well be plain http on the LAN — the frame
     * already sends it the same bearer with every scene fetch, so an image
     * download over that origin's transport refuses nothing new. The cloud
     * path keeps the strict transport rule for every URL. */
    bool trust_base_transport;
} ota_source_t;

/* Consecutive failures for one offered version, kept across deep sleeps and
 * software resets (not a power cycle — unplugging is how a person says "try
 * again"). A frame that fails the same image this many times in a row stops
 * re-downloading it on every wake: a battery frame redialing a 3 MB image
 * each cycle only to fail again is the expensive way to report one problem.
 * Logged as status `gave-up` so the control plane shows why nothing happens;
 * a newer release, or a power cycle, resets it. */
#define FOS_OTA_MAX_FAILURES 3
RTC_DATA_ATTR static char s_ota_failed_version[32];
RTC_DATA_ATTR static uint8_t s_ota_failures;

/* Downgrade protection. The manifest's `version` is outside the signed
 * payload (the minisig covers image bytes), so anyone who can speak for the
 * control plane — a plain-http backend on the LAN, a stolen provider token —
 * could offer an OLDER signed release and roll the frame back to a known
 * hole. An offer strictly below the running release is therefore refused
 * unless the local admin asked for exactly that with `ota downgrade` on the
 * console, which arms this for one manifest fetch. RTC memory: the console
 * command may be followed by the request being served after a deep-sleep
 * wake. A dev build ("dev", no dotted version) never refuses — see
 * fos_version_is_downgrade. */
RTC_DATA_ATTR static uint8_t s_ota_allow_downgrade;

void fos_ota_allow_downgrade_once(void)
{
    s_ota_allow_downgrade = 1;
}

static void ota_note_failure(const char *version)
{
    if (strncmp(s_ota_failed_version, version, sizeof(s_ota_failed_version)) != 0) {
        strlcpy(s_ota_failed_version, version, sizeof(s_ota_failed_version));
        s_ota_failures = 0;
    }
    if (s_ota_failures < 0xFF) s_ota_failures++;
}

static bool ota_gave_up(const char *version)
{
    return strncmp(s_ota_failed_version, version, sizeof(s_ota_failed_version)) == 0 &&
           s_ota_failures >= FOS_OTA_MAX_FAILURES;
}

/* Parse the first signature line of a .minisig: base64(ED + keyid8 + sig64).
 * Trusted-comment lines are ignored (the device trusts only the key). */
static bool parse_minisig(const char *minisig, uint8_t sig_out[64])
{
    const char *line = minisig;
    while (line != NULL && *line != '\0') {
        while (*line == '\r' || *line == '\n' || *line == ' ') line++;
        if (strncmp(line, "untrusted comment:", 18) == 0 ||
            strncmp(line, "trusted comment:", 16) == 0) {
            line = strchr(line, '\n');
            continue;
        }
        break;
    }
    if (line == NULL || *line == '\0') return false;
    const char *end = strchr(line, '\n');
    size_t b64_len = end != NULL ? (size_t)(end - line) : strlen(line);
    while (b64_len > 0 && (line[b64_len - 1] == '\r' || line[b64_len - 1] == ' ')) b64_len--;
    uint8_t blob[80];
    size_t blob_len = 0;
    if (mbedtls_base64_decode(blob, sizeof(blob), &blob_len,
                              (const unsigned char *)line, b64_len) != 0) {
        return false;
    }
    if (blob_len != 74 || blob[0] != 'E' || blob[1] != 'D') {
        ESP_LOGW(TAG, "ota: unsupported signature format");
        return false;
    }
    if (memcmp(blob + 2, FOS_OTA_SIGNING_KEY_ID, 8) != 0) {
        ESP_LOGW(TAG, "ota: signature key id mismatch");
        return false;
    }
    memcpy(sig_out, blob + 10, 64);
    return true;
}

/* Every exit names itself in the frame log as a structured `ota:<plane>`
 * line: "downloading" followed by silence is what a deep-sleep frame used to
 * leave behind, and the control plane's Logs panel is the only place an owner
 * can look. */
static void ota_log(const ota_source_t *src, const char *status, const char *detail)
{
    char line[224];
    snprintf(line, sizeof(line),
             "{\"event\":\"ota:%s\",\"source\":\"esp32\","
             "\"status\":\"%s\",\"detail\":\"%s\"}",
             src->plane, status, detail ? detail : "");
    frameos_nim_log_hook(line);
    frameos_nim_flush_logs();
}

/* Progress every 512 KB, as a structured line the Logs panel shows. */
static void ota_log_progress(const ota_source_t *src, size_t written, size_t expected)
{
    char detail[64];
    if (expected > 0) {
        snprintf(detail, sizeof(detail), "%u/%u", (unsigned)written, (unsigned)expected);
    } else {
        snprintf(detail, sizeof(detail), "%u", (unsigned)written);
    }
    ota_log(src, "progress", detail);
}

/* "scheme://host[:port]" of an http(s)/ws(s) URL, lowercased, with ws
 * mapped onto http so a wss:// ws_url compares equal to the https:// origin
 * it serves. False for any other shape, including userinfo ("a@b"). */
static bool url_origin(const char *url, char *out, size_t out_len)
{
    const char *scheme;
    const char *rest;
    if (!url) return false;
    if (strncasecmp(url, "https://", 8) == 0) { scheme = "https://"; rest = url + 8; }
    else if (strncasecmp(url, "http://", 7) == 0) { scheme = "http://"; rest = url + 7; }
    else if (strncasecmp(url, "wss://", 6) == 0) { scheme = "https://"; rest = url + 6; }
    else if (strncasecmp(url, "ws://", 5) == 0) { scheme = "http://"; rest = url + 5; }
    else return false;
    size_t host_len = strcspn(rest, "/?#");
    if (host_len == 0 || memchr(rest, '@', host_len)) return false;
    int n = snprintf(out, out_len, "%s%.*s", scheme, (int)host_len, rest);
    if (n <= 0 || (size_t)n >= out_len) return false;
    for (char *p = out; *p; p++) *p = (char)tolower((unsigned char)*p);
    return true;
}

/* The manifest's downloadUrl may be absolute (a CDN, GitHub). The frame's
 * bearer is the control plane's credential: it goes only to that plane's own
 * origin (base_url, or the cloud's enrollment ws_url host), never wherever a
 * manifest points. */
static bool download_url_is_first_party(const char *download_url, const ota_source_t *src)
{
    char have[FOS_URL_LEN];
    char want[FOS_URL_LEN];
    if (!url_origin(download_url, have, sizeof(have))) return false;
    if (url_origin(src->base_url, want, sizeof(want)) && strcmp(want, have) == 0) return true;
    const char *ws_url = fos_cloud_ws_url();
    if (ws_url && ws_url[0] && url_origin(ws_url, want, sizeof(want)) &&
        strcmp(want, have) == 0) {
        return true;
    }
    return false;
}

typedef struct {
    char version[32];
    char download_url[FOS_URL_LEN + 192];
    uint8_t sig[64];
    size_t size;
} ota_manifest_t;

/* GET the manifest and pull out what the download needs. Returns ESP_OK with
 * `up_to_date` set when the offered version is the running one. */
static esp_err_t ota_fetch_manifest(const ota_source_t *src, ota_manifest_t *out, bool *up_to_date)
{
    *up_to_date = false;
    ESP_LOGI(TAG, "ota (%s): checking manifest %s", src->plane, src->manifest_url);
    esp_http_client_config_t config = {
        .url = src->manifest_url,
        .timeout_ms = 20000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 4096,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        ota_log(src, "error", "no-memory");
        return ESP_ERR_NO_MEM;
    }
    esp_http_client_set_header(client, "Authorization", src->auth);
    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        esp_http_client_cleanup(client);
        ota_log(src, "error", "manifest-connect-failed");
        return err;
    }
    int64_t content_length = esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);
    /* Dev servers (and some proxies) send chunked responses with no
     * Content-Length — read to EOF under the manifest cap either way. */
    if (status != 200 || content_length > FOS_OTA_MANIFEST_MAX) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        ESP_LOGW(TAG, "ota (%s): manifest HTTP %d (%lld bytes)", src->plane, status,
                 (long long)content_length);
        /* 404 = the release carries no OTA app image for this platform; 409 =
         * it has one but no signature. Both are "nothing to install", and
         * telling them apart in the log is the difference between waiting for
         * a release and chasing a bug. */
        ota_log(src, "error", status == 409   ? "unsigned-release"
                            : status == 404 ? "no-image-published"
                                            : "manifest-unavailable");
        return status == 404 ? ESP_ERR_NOT_FOUND : ESP_FAIL;
    }
    char *body = malloc(FOS_OTA_MANIFEST_MAX + 1);
    if (body == NULL) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        ota_log(src, "error", "no-memory");
        return ESP_ERR_NO_MEM;
    }
    size_t total = 0;
    while (total < FOS_OTA_MANIFEST_MAX) {
        int r = esp_http_client_read(client, body + total, FOS_OTA_MANIFEST_MAX - total);
        if (r <= 0) break;
        total += (size_t)r;
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    body[total] = '\0';

    cJSON *root = cJSON_ParseWithLength(body, total);
    free(body);
    if (root == NULL) {
        ota_log(src, "error", "manifest-unparseable");
        return ESP_FAIL;
    }
    const cJSON *version = cJSON_GetObjectItem(root, "version");
    const cJSON *minisig = cJSON_GetObjectItem(root, "minisig");
    const cJSON *download = cJSON_GetObjectItem(root, "downloadUrl");
    const cJSON *size_item = cJSON_GetObjectItem(root, "size");
    if (!cJSON_IsString(version) || !cJSON_IsString(minisig) || !cJSON_IsString(download) ||
        strlen(version->valuestring) >= sizeof(out->version)) {
        cJSON_Delete(root);
        ota_log(src, "error", "manifest-incomplete");
        return ESP_FAIL;
    }
    strlcpy(out->version, version->valuestring, sizeof(out->version));

    /* Same image → nothing to do. Release versions have no v prefix. */
    const char *running = esp_app_get_description()->version;
    if (running[0] == 'v') running++;
    if (strcmp(running, out->version) == 0) {
        ESP_LOGI(TAG, "ota (%s): already on %s", src->plane, out->version);
        ota_log(src, "up-to-date", out->version);
        cJSON_Delete(root);
        *up_to_date = true;
        return ESP_OK;
    }
    if (fos_version_is_downgrade(out->version, running)) {
        if (!s_ota_allow_downgrade) {
            ESP_LOGW(TAG, "ota (%s): refusing downgrade %s -> %s (console `ota downgrade` to allow once)",
                     src->plane, running, out->version);
            ota_log(src, "downgrade-refused", out->version);
            cJSON_Delete(root);
            *up_to_date = true; /* nothing to install; not a failure to count */
            return ESP_OK;
        }
        ESP_LOGW(TAG, "ota (%s): downgrade %s -> %s allowed once by the console", src->plane,
                 running, out->version);
        s_ota_allow_downgrade = 0;
    }

    if (!parse_minisig(minisig->valuestring, out->sig)) {
        cJSON_Delete(root);
        ota_log(src, "error", "bad-signature-format");
        return ESP_FAIL;
    }
    if (download->valuestring[0] == '/') {
        snprintf(out->download_url, sizeof(out->download_url), "%s%s", src->base_url,
                 download->valuestring);
    } else {
        strlcpy(out->download_url, download->valuestring, sizeof(out->download_url));
    }
    out->size = cJSON_IsNumber(size_item) ? (size_t)size_item->valuedouble : 0;
    cJSON_Delete(root);
    return ESP_OK;
}

static esp_err_t ota_download_verify(const ota_source_t *src, const char *download_url,
                                     const char *auth_header, const uint8_t sig[64],
                                     size_t expected_size)
{
    const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);
    if (target == NULL) {
        ota_log(src, "error", "no-ota-slot");
        return ESP_ERR_NOT_FOUND;
    }
    if (expected_size > 0 && expected_size > target->size) {
        ESP_LOGE(TAG, "ota: image (%u) exceeds slot (%u)",
                 (unsigned)expected_size, (unsigned)target->size);
        char detail[64];
        snprintf(detail, sizeof(detail), "image-exceeds-slot:%u>%u",
                 (unsigned)expected_size, (unsigned)target->size);
        ota_log(src, "error", detail);
        return ESP_ERR_INVALID_SIZE;
    }

    esp_http_client_config_t config = {
        .url = download_url,
        .timeout_ms = 30000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 4096,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        ota_log(src, "error", "no-memory");
        return ESP_ERR_NO_MEM;
    }
    if (auth_header != NULL) {
        esp_http_client_set_header(client, "Authorization", auth_header);
    }

    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        esp_http_client_cleanup(client);
        char detail[80];
        snprintf(detail, sizeof(detail), "download-connect-failed:%s", esp_err_to_name(err));
        ota_log(src, "error", detail);
        return err;
    }
    int64_t content_length = esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);
    if (status != 200) {
        ESP_LOGW(TAG, "ota: download HTTP %d", status);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        char detail[48];
        snprintf(detail, sizeof(detail), "download-http-%d", status);
        ota_log(src, "error", detail);
        return ESP_FAIL;
    }

    esp_ota_handle_t ota = 0;
    err = esp_ota_begin(target, content_length > 0 ? (size_t)content_length
                                                   : OTA_SIZE_UNKNOWN, &ota);
    if (err != ESP_OK) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        char detail[80];
        snprintf(detail, sizeof(detail), "ota-begin-failed:%s", esp_err_to_name(err));
        ota_log(src, "error", detail);
        return err;
    }

    uint8_t *chunk = heap_caps_malloc(FOS_OTA_CHUNK, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (chunk == NULL) chunk = malloc(FOS_OTA_CHUNK);
    if (chunk == NULL) {
        esp_ota_abort(ota);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        ota_log(src, "error", "no-memory");
        return ESP_ERR_NO_MEM;
    }

    crypto_blake2b_ctx hash_ctx;
    crypto_blake2b_init(&hash_ctx, 64);
    size_t total = 0;
    while (true) {
        int r = esp_http_client_read(client, (char *)chunk, FOS_OTA_CHUNK);
        if (r < 0) {
            err = ESP_FAIL;
            break;
        }
        if (r == 0) break;
        crypto_blake2b_update(&hash_ctx, chunk, (size_t)r);
        err = esp_ota_write(ota, chunk, (size_t)r);
        if (err != ESP_OK) break;
        total += (size_t)r;
        if ((total % (512 * 1024)) < FOS_OTA_CHUNK) {
            ESP_LOGW(TAG, "ota: %u bytes written", (unsigned)total);
            ota_log_progress(src, total, expected_size);
        }
    }
    free(chunk);
    esp_http_client_close(client);
    esp_http_client_cleanup(client);

    if (err != ESP_OK || total == 0 ||
        (expected_size > 0 && total != expected_size)) {
        ESP_LOGE(TAG, "ota: download failed at %u bytes (%s)",
                 (unsigned)total, esp_err_to_name(err));
        char detail[96];
        snprintf(detail, sizeof(detail), "download-failed:%s@%u/%u",
                 err != ESP_OK ? esp_err_to_name(err) : "short-read",
                 (unsigned)total, (unsigned)expected_size);
        ota_log(src, "error", detail);
        esp_ota_abort(ota);
        return err != ESP_OK ? err : ESP_FAIL;
    }

    uint8_t digest[64];
    crypto_blake2b_final(&hash_ctx, digest);
    if (crypto_ed25519_check(sig, FOS_OTA_SIGNING_PUBKEY, digest, sizeof(digest)) != 0) {
        ESP_LOGE(TAG, "ota: SIGNATURE VERIFICATION FAILED — image rejected");
        esp_ota_abort(ota);
        ota_log(src, "error", "signature-rejected");
        return ESP_ERR_INVALID_CRC;
    }

    err = esp_ota_end(ota);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ota: image validation failed: %s", esp_err_to_name(err));
        char detail[80];
        snprintf(detail, sizeof(detail), "image-rejected:%s", esp_err_to_name(err));
        ota_log(src, "error", detail);
        return ESP_ERR_INVALID_CRC;
    }
    err = esp_ota_set_boot_partition(target);
    if (err != ESP_OK) {
        char detail[80];
        snprintf(detail, sizeof(detail), "set-boot-failed:%s", esp_err_to_name(err));
        ota_log(src, "error", detail);
        return err;
    }
    ESP_LOGW(TAG, "ota: %u bytes verified and staged in %s; rebooting",
             (unsigned)total, target->label);
    return ESP_OK;
}

/* One complete run: manifest → version check → download + verify → reboot.
 * Returns ESP_OK both when an image was staged (the device restarts before
 * the caller sees it) and when it was already up to date. */
static esp_err_t ota_run_signed(const ota_source_t *src)
{
    if (!ota_supported()) {
        ESP_LOGI(TAG, "no OTA app partition in this flash layout; skipping OTA");
        ota_log(src, "skipped", "no-ota-slot");
        return ESP_ERR_NOT_SUPPORTED;
    }
    if (fos_wifi_state() != FOS_WIFI_CONNECTED) {
        ESP_LOGW(TAG, "ota (%s): Wi-Fi state=%s; OTA requires connected station mode",
                 src->plane, wifi_state_name(fos_wifi_state()));
        return ESP_ERR_INVALID_STATE;
    }

    ota_manifest_t manifest;
    bool up_to_date = false;
    esp_err_t err = ota_fetch_manifest(src, &manifest, &up_to_date);
    if (err != ESP_OK || up_to_date) return err;

    if (ota_gave_up(manifest.version)) {
        char detail[64];
        snprintf(detail, sizeof(detail), "%s:%u-failures", manifest.version,
                 (unsigned)s_ota_failures);
        ota_log(src, "gave-up", detail);
        return ESP_FAIL;
    }

    /* Same transport rule as cloud_url itself: https anywhere, plain http
     * only to localhost / .local / private-network hosts (development) —
     * unless the download comes from the control plane's own origin and that
     * plane is trusted on its own transport (a LAN backend). A manifest
     * cannot send the image fetch over cleartext to the internet. */
    const bool first_party = download_url_is_first_party(manifest.download_url, src);
    const char *transport_why = NULL;
    if (!(first_party && src->trust_base_transport) &&
        !fos_cloud_url_transport_ok(manifest.download_url, &transport_why)) {
        ESP_LOGW(TAG, "ota (%s): refusing downloadUrl: %s", src->plane,
                 transport_why ? transport_why : "bad transport");
        ota_log(src, "error", "download-url-transport");
        ota_note_failure(manifest.version);
        return ESP_FAIL;
    }
    if (!first_party) {
        ESP_LOGI(TAG, "ota (%s): downloadUrl is off-origin; fetching without credentials", src->plane);
    }
    ESP_LOGW(TAG, "ota (%s): %s -> %s from %s", src->plane,
             esp_app_get_description()->version, manifest.version, manifest.download_url);
    ota_log(src, "downloading", manifest.version);

    err = ESP_FAIL;
    for (int attempt = 1; attempt <= FOS_OTA_DOWNLOAD_ATTEMPTS; attempt++) {
        if (attempt > 1) {
            vTaskDelay(pdMS_TO_TICKS(FOS_OTA_RETRY_DELAY_MS));
            if (!wait_for_wifi_connected(FOS_OTA_WIFI_RECONNECT_TIMEOUT_MS)) {
                ESP_LOGW(TAG, "ota: retry %d skipped, Wi-Fi %s", attempt,
                         wifi_state_name(fos_wifi_state()));
                continue;
            }
        }
        err = ota_download_verify(src, manifest.download_url, first_party ? src->auth : NULL,
                                  manifest.sig, manifest.size);
        if (err == ESP_OK || err == ESP_ERR_INVALID_CRC || err == ESP_ERR_INVALID_SIZE ||
            err == ESP_ERR_NO_MEM) {
            break; /* staged, or a failure no retry can fix */
        }
        ESP_LOGW(TAG, "ota: attempt %d/%d failed: %s", attempt, FOS_OTA_DOWNLOAD_ATTEMPTS,
                 esp_err_to_name(err));
    }
    if (err == ESP_OK) {
        s_ota_failures = 0;
        ota_log(src, "verified", "rebooting");
        vTaskDelay(pdMS_TO_TICKS(750)); /* flush the log line */
        esp_restart();
        return ESP_OK;
    }
    /* download_verify named the failure already; here it only counts. */
    ota_note_failure(manifest.version);
    return err;
}

/* ----------------------------------------------------------- backend plane
 * A backend-managed frame asks its backend for the release manifest
 * (`/embedded/ota/manifest?platform=…`, bearer = the frame API key) and
 * downloads through the backend's proxy of the release asset. The backend
 * holds no signing key either: it relays the release's minisig, and the
 * device verifies against the same baked release key as the cloud path. */

static bool backend_source(ota_source_t *src)
{
    const fos_config_t *config = fos_config();
    if (!config->backend_url[0] || config->frame_id == 0) {
        ESP_LOGW(TAG, "no backend configured, skipping OTA check");
        return false;
    }
    if (!config->api_key[0]) {
        ESP_LOGW(TAG, "no frame API key configured, skipping OTA check");
        return false;
    }
    memset(src, 0, sizeof(*src));
    src->plane = "backend";
    strlcpy(src->base_url, config->backend_url, sizeof(src->base_url));
    snprintf(src->manifest_url, sizeof(src->manifest_url),
             "%s/api/frames/%lu/embedded/ota/manifest?platform=%s",
             config->backend_url, (unsigned long)config->frame_id, fos_ota_platform());
    snprintf(src->auth, sizeof(src->auth), "Bearer %s", config->api_key);
    src->trust_base_transport = true;
    return true;
}

static esp_err_t ota_check_and_apply_locked(void)
{
    ESP_LOGI(TAG, "OTA check started");
    if (!ota_supported()) {
        ESP_LOGI(TAG, "no OTA app partition in this flash layout; skipping OTA check");
        return ESP_ERR_NOT_SUPPORTED;
    }
    ota_source_t src;
    if (!backend_source(&src)) return ESP_ERR_INVALID_STATE;
    if (!wait_for_wifi_connected(5000)) {
        ESP_LOGW(TAG, "Wi-Fi state=%s; OTA requires connected station mode",
                 wifi_state_name(fos_wifi_state()));
        return ESP_ERR_INVALID_STATE;
    }

    /* The local HTTP server's sockets and the renderer's buffers are what an
     * OTA competes with for internal RAM; drop the server for the duration
     * (the early-boot request path runs before it ever starts). */
    bool stopped_http = false;
    if (fos_http_is_running()) {
        ESP_LOGI(TAG, "stopping local HTTP server for OTA headroom: internal=%u psram=%u",
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
        fos_http_stop();
        stopped_http = true;
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    esp_err_t err = ota_run_signed(&src);
    if (stopped_http) {
        fos_http_start(false);
    }
    /* "Nothing published for this layout" is not a failure of the check. */
    return err == ESP_ERR_NOT_FOUND ? ESP_OK : err;
}

esp_err_t fos_ota_check_and_apply(void)
{
    SemaphoreHandle_t lock = ota_lock();
    if (lock == NULL) {
        ESP_LOGE(TAG, "OTA lock unavailable");
        return ESP_ERR_NO_MEM;
    }
    if (xSemaphoreTake(lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGW(TAG, "OTA check already in progress; skipping concurrent request");
        return ESP_ERR_INVALID_STATE;
    }

    s_ota_busy = true;
    esp_err_t err = ota_check_and_apply_locked();
    s_ota_busy = false;
    xSemaphoreGive(lock);
    return err;
}

bool fos_ota_busy(void)
{
    return s_ota_busy;
}

bool fos_ota_boot_request_pending(void)
{
    return load_boot_request();
}

esp_err_t fos_ota_run_boot_request(void)
{
    if (!load_boot_request()) return ESP_OK;

    ESP_LOGW(TAG, "boot OTA request found; checking before runtime startup");
    esp_err_t clear_err = store_boot_request(false);
    if (clear_err != ESP_OK) {
        ESP_LOGW(TAG, "failed to clear boot OTA request: %s", esp_err_to_name(clear_err));
    }
    return fos_ota_check_and_apply();
}

static void ota_task(void *arg)
{
    uint32_t interval_hours = (uint32_t)(uintptr_t)arg;
    if (interval_hours == 0) interval_hours = 24;
    TickType_t interval_ticks = pdMS_TO_TICKS(interval_hours * 3600u * 1000u);
    while (true) {
        uint32_t notifications = ulTaskNotifyTake(pdTRUE, interval_ticks);
        bool manual = notifications > 0;
        if (manual) {
            vTaskDelay(pdMS_TO_TICKS(250));
        }
        ESP_LOGW(TAG, "%s OTA check waking", manual ? "manual" : "periodic");
        esp_err_t err = fos_ota_check_and_apply();
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "%s OTA check failed: %s",
                     manual ? "manual" : "periodic", esp_err_to_name(err));
        }
    }
}

void fos_ota_start_periodic_task(uint32_t interval_hours)
{
    if (s_ota_task_handle != NULL) return;
    if (!ota_supported()) {
        ESP_LOGI(TAG, "no OTA app partition in this flash layout; periodic OTA disabled");
        return;
    }
    BaseType_t created = xTaskCreate(ota_task, "fos_ota", 8192,
                                     (void *)(uintptr_t)interval_hours, 4,
                                     &s_ota_task_handle);
    if (created != pdPASS) {
        s_ota_task_handle = NULL;
        ESP_LOGE(TAG, "OTA task start failed: internal=%u psram=%u",
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    }
}

static void ota_reboot_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(FOS_OTA_REBOOT_DELAY_MS));
    esp_restart();
}

esp_err_t fos_ota_request_check(void)
{
    if (!ota_supported()) return ESP_ERR_NOT_SUPPORTED;
    esp_err_t err = store_boot_request(true);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "failed to store OTA request: %s", esp_err_to_name(err));
        return err;
    }

    taskENTER_CRITICAL(&s_ota_request_mux);
    bool already_scheduled = s_ota_reboot_scheduled;
    s_ota_reboot_scheduled = true;
    taskEXIT_CRITICAL(&s_ota_request_mux);
    if (already_scheduled) return ESP_OK;

    BaseType_t created = xTaskCreate(ota_reboot_task, "fos_ota_reboot",
                                     FOS_OTA_REBOOT_TASK_STACK_SIZE, NULL, 5, NULL);
    if (created != pdPASS) {
        taskENTER_CRITICAL(&s_ota_request_mux);
        s_ota_reboot_scheduled = false;
        taskEXIT_CRITICAL(&s_ota_request_mux);
        ESP_LOGW(TAG, "failed to schedule OTA reboot: internal=%u",
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
        return ESP_ERR_NO_MEM;
    }

    /* Reboot from a separate task so HTTP and USB callers can flush their
     * success response before the connection disappears. */
    ESP_LOGW(TAG, "OTA requested; rebooting into early updater in %d ms",
             FOS_OTA_REBOOT_DELAY_MS);
    return ESP_OK;
}

/* ----------------------------------------------------------- cloud plane */

static esp_err_t cloud_ota_run(void)
{
    ota_source_t src;
    memset(&src, 0, sizeof(src));
    src.plane = "cloud";
    char frame_id[64];
    if (!fos_cloud_api_access(src.base_url, sizeof(src.base_url), frame_id, sizeof(frame_id),
                              src.auth, sizeof(src.auth))) {
        ota_log(&src, "skipped", "not-enrolled");
        return ESP_ERR_INVALID_STATE;
    }
    snprintf(src.manifest_url, sizeof(src.manifest_url),
             "%s/api/frames/%s/firmware/manifest?platform=%s",
             src.base_url, frame_id, fos_ota_platform());
    src.trust_base_transport = false;
    return ota_run_signed(&src);
}

static void cloud_ota_task(void *arg)
{
    (void)arg;
    s_ota_busy = true;
    esp_err_t err = cloud_ota_run();
    s_ota_busy = false;
    s_cloud_ota_running = false;
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "cloud ota: finished with %s", esp_err_to_name(err));
    }
    vTaskDelete(NULL);
}

void fos_ota_request_cloud_update(void)
{
    if (s_cloud_ota_running) {
        ESP_LOGW(TAG, "cloud ota: already running");
        return;
    }
    s_cloud_ota_running = true;
    if (xTaskCreate(cloud_ota_task, "fos_cloud_ota", 8192, NULL, 5, NULL) != pdPASS) {
        s_cloud_ota_running = false;
        ESP_LOGW(TAG, "cloud ota: task create failed");
    }
}
