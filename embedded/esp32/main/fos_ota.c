#include "fos_ota.h"

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

#include "monocypher.h"
#include "monocypher-ed25519.h"

#include "fos_backend_http.h"
#include "fos_client.h"
#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_http.h"
#include "fos_minisig.h"
#include "fos_netguard.h"
#include "fos_ota_download.h"
#include "fos_ota_pubkey.h"
#include "fos_url_guard.h"
#include "fos_version.h"
#include "fos_wifi.h"
#include "frameos_nim.h"

static const char *TAG = "fos_ota";
#define FOS_OTA_BOOT_REQUEST_KEY "ota_req"
#define FOS_OTA_REBOOT_DELAY_MS 1000
#define FOS_OTA_REBOOT_TASK_STACK_SIZE 2048
#define FOS_OTA_MANIFEST_MAX (8 * 1024)
#define FOS_OTA_CHUNK (8 * 1024)
/* A dropped socket or a short read is resumed within one run, after the
 * Wi-Fi is back, from the byte it stopped at (fos_ota_download.c holds the
 * budget: three connections in a row that add nothing, eight in all); a
 * signature or image-validation failure is final for the run. Across runs
 * the RTC give-up counter below stops a frame redialing an image it keeps
 * failing. */
#define FOS_OTA_RETRY_DELAY_MS 3000
#define FOS_OTA_WIFI_RECONNECT_TIMEOUT_MS 30000
_Static_assert(FOS_OTA_DL_HTTP_EAGAIN == ESP_ERR_HTTP_EAGAIN,
               "fos_ota_download.h names esp_http_client_read's timeout");
/* A render pass that is already under way finishes before the OTA touches
 * the network: the two would share one Wi-Fi link and the internal heap
 * (three TLS contexts on ~80 KB: the hub socket, the scene's image stream
 * and the download), which is how E1004's download died at 1 MB of 3.2 MB
 * on 2026-10-12. A 13.3" panel's pass can run five minutes (render plus
 * refresh); past this the download goes ahead regardless, logged. The
 * reverse holds too: a pass that starts while the OTA is busy skips its
 * render (fos_client.c, `render:skipped reason=ota`). */
#define FOS_OTA_RENDER_WAIT_MAX_MS (10 * 60 * 1000)
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
        ESP_LOGI(TAG, "first boot of new image on %s reached rendering: marking valid",
                 running->label);
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
 * rolls back unless it reaches its first successful render (or an orderly
 * deep sleep) — fos_ota_mark_boot_valid, called from fos_client.c. */

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

/* The last `ota:<plane>` line, kept across the restart that follows it. The
 * early-boot updater (fos_ota_run_boot_request) logs before the backend log
 * upload exists and the cloud session is up, and a verified image restarts
 * the chip right after — so on the backend plane an update left no line at
 * all (frame 70, 2026-10-12: 2026.10.8 -> 2026.10.9 in 100 s, nothing in
 * the drawer). The first pass after the boot logs it again, marked
 * `replayed`, once the uploads are live (fos_ota_replay_last_line).
 *
 * Only those two kinds of line are kept: the early-boot updater's, and
 * `verified` (a restart follows it). A line logged while the uploads were
 * live already left, and replaying it on the next wake is how an old run's
 * error would land on a deploy started since (the control planes fail a
 * firmware deploy on an `ota:error` that follows its boot). */
RTC_DATA_ATTR static char s_ota_last_plane[16];
RTC_DATA_ATTR static char s_ota_last_status[24];
RTC_DATA_ATTR static char s_ota_last_detail[160];
RTC_DATA_ATTR static uint8_t s_ota_last_pending;
static bool s_ota_in_boot_request = false;

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

/* Every exit names itself in the frame log as a structured `ota:<plane>`
 * line: "downloading" followed by silence is what a deep-sleep frame used to
 * leave behind, and the control plane's Logs panel is the only place an owner
 * can look. */
static void ota_log(const ota_source_t *src, const char *status, const char *detail)
{
    char line[320];
    snprintf(line, sizeof(line),
             "{\"event\":\"ota:%s\",\"source\":\"esp32\","
             "\"status\":\"%s\",\"detail\":\"%s\"}",
             src->plane, status, detail ? detail : "");
    frameos_nim_log_hook(line);
    frameos_nim_flush_logs();
    /* Progress is noise after a restart; every other line is the verdict. */
    if (strcmp(status, "progress") != 0 &&
        (s_ota_in_boot_request || strcmp(status, "verified") == 0)) {
        strlcpy(s_ota_last_plane, src->plane, sizeof(s_ota_last_plane));
        strlcpy(s_ota_last_status, status, sizeof(s_ota_last_status));
        strlcpy(s_ota_last_detail, detail ? detail : "", sizeof(s_ota_last_detail));
        s_ota_last_pending = 1;
    }
}

void fos_ota_replay_last_line(void)
{
    if (!s_ota_last_pending) return;
    s_ota_last_pending = 0;
    if (s_ota_last_plane[0] == '\0' || s_ota_last_status[0] == '\0') return;
    char line[352];
    snprintf(line, sizeof(line),
             "{\"event\":\"ota:%s\",\"source\":\"esp32\",\"status\":\"%s\","
             "\"detail\":\"%s\",\"replayed\":true}",
             s_ota_last_plane, s_ota_last_status, s_ota_last_detail);
    frameos_nim_log_hook(line);
}

/* Progress every 512 KB, as a structured line the Logs panel shows. */
static void ota_log_progress(const ota_source_t *src, size_t written, size_t expected)
{
    char detail[64];
    snprintf(detail, sizeof(detail), "%u/%u", (unsigned)written, (unsigned)expected);
    ota_log(src, "progress", detail);
}

/* Returns once no render pass is in flight, or after timeout_ms. Logs the
 * wait once so the control plane's row says why the download has not
 * started (`waiting` folds like `downloading`). */
static void wait_for_render_idle(const ota_source_t *src, uint32_t timeout_ms)
{
    if (!fos_client_render_in_flight()) return;
    int64_t deadline = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
    ESP_LOGW(TAG, "ota (%s): render in flight; waiting for the pass to finish", src->plane);
    ota_log(src, "waiting", "render");
    while (fos_client_render_in_flight() && esp_timer_get_time() < deadline) {
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    if (fos_client_render_in_flight()) {
        ESP_LOGW(TAG, "ota (%s): render still in flight after %u s; going ahead", src->plane,
                 (unsigned)(timeout_ms / 1000));
    }
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
    fos_http_request_t request = {
        .url = src->manifest_url,
        .auth = src->auth,
        .timeout_ms = 20000,
        .buffer_size = 4096,
    };
    fos_http_response_t response;
    esp_err_t err = fos_http_fetch(&request, FOS_OTA_MANIFEST_MAX, &response);
    if (err != ESP_OK) {
        ota_log(src, "error", err == ESP_ERR_NO_MEM ? "no-memory" : "manifest-connect-failed");
        return err;
    }
    int status = response.status;
    /* Dev servers (and some proxies) send chunked responses with no
     * Content-Length — read to EOF under the manifest cap either way. */
    if (status != 200 || response.too_large) {
        fos_http_response_free(&response);
        ESP_LOGW(TAG, "ota (%s): manifest HTTP %d (%lld bytes)", src->plane, status,
                 (long long)response.content_length);
        /* 404 = the release carries no OTA app image for this platform; 409 =
         * it has one but no signature. Both are "nothing to install", and
         * telling them apart in the log is the difference between waiting for
         * a release and chasing a bug. */
        ota_log(src, "error", status == 409   ? "unsigned-release"
                            : status == 404 ? "no-image-published"
                                            : "manifest-unavailable");
        return status == 404 ? ESP_ERR_NOT_FOUND : ESP_FAIL;
    }
    if (response.body == NULL) {
        ota_log(src, "error", "no-memory");
        return ESP_ERR_NO_MEM;
    }

    cJSON *root = cJSON_ParseWithLength(response.body, response.body_len);
    fos_http_response_free(&response);
    if (root == NULL) {
        ota_log(src, "error", "manifest-unparseable");
        return ESP_FAIL;
    }
    const cJSON *version = cJSON_GetObjectItem(root, "version");
    const cJSON *minisig = cJSON_GetObjectItem(root, "minisig");
    const cJSON *download = cJSON_GetObjectItem(root, "downloadUrl");
    const cJSON *size_item = cJSON_GetObjectItem(root, "size");
    /* Both planes always send `size`: the slot check, the resume and the
     * length checks of every response read it. */
    if (!cJSON_IsString(version) || !cJSON_IsString(minisig) || !cJSON_IsString(download) ||
        strlen(version->valuestring) >= sizeof(out->version) ||
        !cJSON_IsNumber(size_item) || size_item->valuedouble < 1) {
        cJSON_Delete(root);
        ota_log(src, "error", "manifest-incomplete");
        return ESP_FAIL;
    }
    strlcpy(out->version, version->valuestring, sizeof(out->version));

    /* Same image → nothing to do. Release versions have no v prefix. */
    const char *running = esp_app_get_description()->version;
    if (running[0] == 'v') running++;
    if (fos_version_same_release(running, out->version)) {
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

    /* base64(ED + keyid8 + sig64) over the image bytes (fos_minisig.c,
     * host-tested); checked against the download in ota_download_verify. */
    const char *sig_why = NULL;
    if (!fos_minisig_parse(minisig->valuestring, FOS_OTA_SIGNING_KEY_ID, out->sig, &sig_why)) {
        ESP_LOGW(TAG, "ota (%s): signature rejected: %s", src->plane, sig_why ? sig_why : "invalid");
        cJSON_Delete(root);
        ota_log(src, "error", "bad-signature-format");
        return ESP_FAIL;
    }
    /* The signature above says "FrameOS released these bytes", not as which
     * version or for which flash layout — and the version this manifest
     * claims (the one the downgrade check just trusted) is only what the
     * control plane, or whoever uploaded the release asset, says. The
     * trusted comment names the asset the image was SIGNED as and the global
     * signature covers sig || comment, so: verify that with the release key,
     * then require the comment to name this version and this device's own
     * platform (fos_minisig_verify_binding, host-tested against a real
     * release signature). Decided before a byte of the image is downloaded. */
    char signed_as[FOS_MINISIG_COMMENT_MAX];
    if (!fos_minisig_verify_binding(minisig->valuestring, out->sig, FOS_OTA_SIGNING_PUBKEY,
                                    out->version, fos_ota_platform(), signed_as, &sig_why)) {
        ESP_LOGE(TAG, "ota (%s): signature is not for %s on %s: %s%s%s — refused", src->plane,
                 out->version, fos_ota_platform(), sig_why ? sig_why : "invalid",
                 signed_as[0] ? ", signed as " : "", signed_as);
        cJSON_Delete(root);
        ota_log(src, "error", sig_why && strcmp(sig_why, "signed-for-another-release") == 0
                                  ? "signature-for-another-release"
                                  : "signature-rejected");
        return ESP_FAIL;
    }
    if (download->valuestring[0] == '/') {
        snprintf(out->download_url, sizeof(out->download_url), "%s%s", src->base_url,
                 download->valuestring);
    } else {
        strlcpy(out->download_url, download->valuestring, sizeof(out->download_url));
    }
    out->size = (size_t)size_item->valuedouble;
    cJSON_Delete(root);
    return ESP_OK;
}

/* One connection of a download: open it (asking for the rest when
 * dl->written is past zero), then hash and write the body into the slot
 * until it ends or the link fails. ESP_OK: the body ended with the whole
 * image. ESP_FAIL: the connection failed and `token` says how; another one
 * may resume it. Anything else is final for the run (no memory, a flash
 * write that failed). */
static esp_err_t ota_download_connection(const ota_source_t *src, const char *download_url,
                                         const char *auth_header,
                                         const fos_netguard_pin_t *pin, esp_ota_handle_t ota,
                                         crypto_blake2b_ctx *hash_ctx, uint8_t *chunk,
                                         fos_ota_dl_t *dl, char *token, size_t token_len)
{
    esp_http_client_config_t config = {
        .url = download_url,
        .timeout_ms = 30000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 4096,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        snprintf(token, token_len, "no-memory");
        return ESP_ERR_NO_MEM;
    }
    if (auth_header != NULL) {
        esp_http_client_set_header(client, "Authorization", auth_header);
    }
    char range[32];
    if (fos_ota_dl_begin_connection(dl, range, sizeof(range))) {
        esp_http_client_set_header(client, "Range", range);
    }

    /* An off-origin download connects to the address its check resolved,
     * not to a second answer (fos_netguard_pin_t). */
    if (!fos_netguard_pin_for_task(pin)) {
        esp_http_client_cleanup(client);
        snprintf(token, token_len, "connect busy");
        return ESP_FAIL;
    }
    esp_err_t err = esp_http_client_open(client, 0);
    fos_netguard_unpin_for_task();
    if (err != ESP_OK) {
        esp_http_client_cleanup(client);
        snprintf(token, token_len, "connect 0x%x", (unsigned)err);
        return ESP_FAIL;
    }
    int64_t content_length = esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);
    if (!fos_ota_dl_accept(dl, status, content_length, token, token_len)) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_FAIL;
    }

    err = ESP_OK;
    while (true) {
        int r = esp_http_client_read(client, (char *)chunk, FOS_OTA_CHUNK);
        if (r < 0) {
            fos_ota_dl_read_name(r, esp_http_client_get_errno(client), token, token_len);
            err = ESP_FAIL;
            break;
        }
        if (r == 0) {
            if (dl->written != dl->expected) {
                snprintf(token, token_len, "short");
                err = ESP_FAIL;
            }
            break;
        }
        size_t drop = fos_ota_dl_drop(dl, (size_t)r);
        size_t n = (size_t)r - drop;
        if (n == 0) continue;
        crypto_blake2b_update(hash_ctx, chunk + drop, n);
        err = esp_ota_write(ota, chunk + drop, n);
        if (err != ESP_OK) {
            snprintf(token, token_len, "write 0x%x", (unsigned)err);
            break;
        }
        size_t before = dl->written;
        dl->written += n;
        if (before / (512 * 1024) != dl->written / (512 * 1024)) {
            ESP_LOGW(TAG, "ota: %u bytes written", (unsigned)dl->written);
            ota_log_progress(src, dl->written, dl->expected);
        }
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    return err;
}

static esp_err_t ota_download_verify(const ota_source_t *src, const char *download_url,
                                     const char *auth_header, const uint8_t sig[64],
                                     const char *version, size_t expected_size,
                                     const fos_netguard_pin_t *pin)
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

    /* Erase as the bytes arrive, one sector ahead of the writes. Handing
     * esp_ota_begin the size erased the whole image first: seconds of flash
     * work while the socket sat unread right after its headers, the likeliest
     * reason frame 70's download (reTerminal E1004, 2026-10-20) died 12 KB
     * in. ESP-IDF's own esp_https_ota erases this way by default. */
    esp_ota_handle_t ota = 0;
    esp_err_t err = esp_ota_begin(target, OTA_WITH_SEQUENTIAL_WRITES, &ota);
    if (err != ESP_OK) {
        char detail[80];
        snprintf(detail, sizeof(detail), "ota-begin-failed:0x%x", (unsigned)err);
        ota_log(src, "error", detail);
        return err;
    }

    uint8_t *chunk = heap_caps_malloc(FOS_OTA_CHUNK, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (chunk == NULL) chunk = malloc(FOS_OTA_CHUNK);
    if (chunk == NULL) {
        esp_ota_abort(ota);
        ota_log(src, "error", "no-memory");
        return ESP_ERR_NO_MEM;
    }

    /* The hash and the slot carry on across connections: a dropped link
     * resumes at the byte it stopped at instead of starting over. */
    crypto_blake2b_ctx hash_ctx;
    crypto_blake2b_init(&hash_ctx, 64);
    fos_ota_dl_t dl;
    fos_ota_dl_init(&dl, expected_size);
    char token[sizeof(dl.last)];
    while (true) {
        if (dl.tries > 0) {
            vTaskDelay(pdMS_TO_TICKS(FOS_OTA_RETRY_DELAY_MS));
            if (!wait_for_wifi_connected(FOS_OTA_WIFI_RECONNECT_TIMEOUT_MS)) {
                err = ESP_FAIL;
                if (!fos_ota_dl_failed(&dl, "wifi")) break;
                continue;
            }
        }
        token[0] = '\0';
        err = ota_download_connection(src, download_url, auth_header, pin, ota, &hash_ctx,
                                      chunk, &dl, token, sizeof(token));
        if (err == ESP_OK) break;
        if (!fos_ota_dl_failed(&dl, token) || err != ESP_FAIL) break;
    }
    free(chunk);

    if (err != ESP_OK) {
        char detail[160];
        fos_ota_dl_summary(&dl, detail, sizeof(detail));
        ota_log(src, "error", detail);
        esp_ota_abort(ota);
        return err;
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
        ESP_LOGE(TAG, "ota: image validation failed: 0x%x", (unsigned)err);
        char detail[80];
        snprintf(detail, sizeof(detail), "image-rejected:0x%x", (unsigned)err);
        ota_log(src, "error", detail);
        return ESP_ERR_INVALID_CRC;
    }
    /* The signature binds these bytes to a release NAME (the trusted comment,
     * matched against the manifest's version before the download); the image
     * names itself in its app descriptor. If the two disagree, the board would
     * boot a release reporting another version, be offered the signed one
     * again and re-flash on every check, so the image does not get to boot.
     * Counted as a failure by the caller, which gives up after a few. */
    esp_app_desc_t desc;
    err = esp_ota_get_partition_description(target, &desc);
    if (err != ESP_OK || !fos_version_same_release(desc.version, version)) {
        const char *said = err == ESP_OK ? desc.version : "unreadable";
        ESP_LOGE(TAG, "ota: image says %s, signed as %s — refused", said, version);
        char detail[80];
        snprintf(detail, sizeof(detail), "image-version-mismatch:%s", said);
        ota_log(src, "error", detail);
        return ESP_ERR_INVALID_CRC;
    }
    err = esp_ota_set_boot_partition(target);
    if (err != ESP_OK) {
        char detail[80];
        snprintf(detail, sizeof(detail), "set-boot-failed:0x%x", (unsigned)err);
        ota_log(src, "error", detail);
        return err;
    }
    /* A download that had to resume says after what: whether links drop
     * mid-image at all is what frame 70's failure left open. */
    char detail[128] = "rebooting";
    if (dl.tries > 0) {
        snprintf(detail, sizeof(detail), "rebooting (resumed after %s)", dl.trail);
    }
    ota_log(src, "verified", detail);
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

    /* s_ota_busy is already set by every caller, so the next render pass
     * yields to this run; a pass already rendering is waited out here. */
    wait_for_render_idle(src, FOS_OTA_RENDER_WAIT_MAX_MS);

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
    /* The manifest's downloadUrl may be absolute (a CDN, GitHub). The frame's
     * bearer is the control plane's credential: it goes only to that plane's
     * own origin (base_url, or the cloud's enrollment ws_url host), never
     * wherever a manifest points. */
    const bool first_party = fos_url_download_is_first_party(
        manifest.download_url, src->base_url, fos_cloud_ws_url());
    const char *transport_why = NULL;
    if (!(first_party && src->trust_base_transport) &&
        !fos_cloud_url_transport_ok(manifest.download_url, &transport_why)) {
        ESP_LOGW(TAG, "ota (%s): refusing downloadUrl: %s", src->plane,
                 transport_why ? transport_why : "bad transport");
        ota_log(src, "error", "download-url-transport");
        ota_note_failure(manifest.version);
        return ESP_FAIL;
    }
    /* And off-origin, a public host only: the manifest is signed, but the
     * URL in it is the control plane's word, and the frame must not be made
     * to send requests into its own LAN. The control plane's own origin may
     * be on the LAN (a self-hosted backend). */
    fos_netguard_pin_t pin = {0};
    if (!first_party) {
        char where[96];
        fos_netguard_verdict_t verdict =
            fos_netguard_check_public_url(manifest.download_url, where, sizeof(where), &pin);
        if (verdict != FOS_NETGUARD_ALLOWED) {
            ESP_LOGW(TAG, "ota (%s): refusing downloadUrl: %s", src->plane, where);
            ota_log(src, "error",
                    verdict == FOS_NETGUARD_UNRESOLVED ? "download-url-unresolved" : "download-url-private");
            if (verdict == FOS_NETGUARD_BLOCKED) ota_note_failure(manifest.version);
            return ESP_FAIL;
        }
        ESP_LOGI(TAG, "ota (%s): downloadUrl is off-origin; fetching without credentials", src->plane);
    }
    ESP_LOGW(TAG, "ota (%s): %s -> %s from %s", src->plane,
             esp_app_get_description()->version, manifest.version, manifest.download_url);
    ota_log(src, "downloading", manifest.version);

    /* Resumes within itself (fos_ota_download.c); one call is the run's download. */
    err = ota_download_verify(src, manifest.download_url, first_party ? src->auth : NULL,
                              manifest.sig, manifest.version, manifest.size, &pin);
    if (err == ESP_OK) {
        s_ota_failures = 0;
        vTaskDelay(pdMS_TO_TICKS(750)); /* flush the verified line */
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
    /* This run's lines are the ones the first pass replays; an older
     * verdict still waiting in RTC memory is not this run's to report. */
    s_ota_last_pending = 0;
    s_ota_in_boot_request = true;
    esp_err_t err = fos_ota_check_and_apply();
    s_ota_in_boot_request = false;
    return err;
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

/* The backend check (fos_ota_check_and_apply) and this task write the same
 * inactive slot, so they share ota_lock. The backend side refuses when the
 * lock is taken (its periodic/manual check comes round again); the cloud
 * request was a verb the owner just sent, so it waits for the other run —
 * which restarts the chip if it installs anything — and only gives up past
 * a download's worth of time. */
#define FOS_OTA_CLOUD_LOCK_WAIT_MS (15 * 60 * 1000)

static void cloud_ota_task(void *arg)
{
    (void)arg;
    SemaphoreHandle_t lock = ota_lock();
    if (lock == NULL || xSemaphoreTake(lock, 0) != pdTRUE) {
        if (lock != NULL) {
            ESP_LOGW(TAG, "cloud ota: another OTA is running; waiting for it");
        }
        if (lock == NULL || xSemaphoreTake(lock, pdMS_TO_TICKS(FOS_OTA_CLOUD_LOCK_WAIT_MS)) != pdTRUE) {
            ota_source_t src = {.plane = "cloud"};
            ota_log(&src, "skipped", "another-ota-running");
            s_cloud_ota_running = false;
            vTaskDelete(NULL);
            return;
        }
    }
    s_ota_busy = true;
    esp_err_t err = cloud_ota_run();
    s_ota_busy = false;
    xSemaphoreGive(lock);
    s_cloud_ota_running = false;
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "cloud ota: finished with %s", esp_err_to_name(err));
    }
    vTaskDelete(NULL);
}

void fos_ota_request_cloud_update(void)
{
    taskENTER_CRITICAL(&s_ota_request_mux);
    bool already_running = s_cloud_ota_running;
    s_cloud_ota_running = true;
    taskEXIT_CRITICAL(&s_ota_request_mux);
    if (already_running) {
        ESP_LOGW(TAG, "cloud ota: already running");
        return;
    }
    if (xTaskCreate(cloud_ota_task, "fos_cloud_ota", 8192, NULL, 5, NULL) != pdPASS) {
        s_cloud_ota_running = false;
        ESP_LOGW(TAG, "cloud ota: task create failed");
    }
}
