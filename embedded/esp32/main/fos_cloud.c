#include "fos_cloud.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "mbedtls/base64.h"
#include "monocypher.h"
#include "monocypher-ed25519.h"
#include "nvs.h"

#include "fos_assets_sd.h"
#include "fos_client.h"
#include "fos_config.h"
#include "fos_http.h"
#include "fos_scenes.h"
#include "fos_wifi.h"
#include "frameos_display.h"
#include "frameos_nim.h"

/* The management WebSocket needs the esp_websocket_client managed component
 * (declared in main/idf_component.yml). Guarded so an offline configure with
 * the component manager disabled still builds an enrollment-only firmware. */
#if defined(__has_include)
#if __has_include("esp_websocket_client.h")
#include "esp_websocket_client.h"
#define FOS_CLOUD_HAVE_WS 1
#endif
#endif

static const char *TAG = "fos_cloud";
static const char *NVS_NS = "frameos";

#define FOS_CLOUD_TOKEN_LEN 256
#define FOS_CLOUD_FRAME_ID_LEN 64
#define FOS_CLOUD_WS_PATH_LEN 128
#define FOS_CLOUD_HTTP_TIMEOUT_MS 20000
#define FOS_CLOUD_RESPONSE_MAX 2048
#define FOS_CLOUD_BACKOFF_MIN_MS (10 * 1000)
#define FOS_CLOUD_BACKOFF_MAX_MS (15 * 60 * 1000)
#define FOS_CLOUD_TASK_STACK 8192
/* Device cap on a single management WebSocket text frame. Deliberately well
 * under the provider-side limit: the reassembly buffer plus the cJSON tree of
 * a max-size set_scenes already crowd an ESP32, and /state itself only holds
 * SCENES_MAX_BYTES (512 KiB) of scene JSON. */
#define FOS_CLOUD_WS_MAX_MSG (512 * 1024)
#define FOS_CLOUD_NONCE_MAX 256
/* WS redial: jittered exponential backoff per docs/cloud-frames.md. */
#define FOS_CLOUD_WS_BACKOFF_MIN_MS (5 * 1000)
#define FOS_CLOUD_WS_BACKOFF_MAX_MS (5 * 60 * 1000)
/* docs/cloud-frames.md: demote to standalone after 3 consecutive auth
 * rejections (HTTP 401 on the upgrade, or a 4401 close from the provider). */
#define FOS_CLOUD_WS_AUTH_FAILURES_MAX 3
#define FOS_CLOUD_WS_AUTH_CLOSE_CODE 4401
/* How long scene_ack waits for the render task to hot-load a pushed payload. */
#define FOS_CLOUD_SCENE_ACK_TIMEOUT_MS (120 * 1000)
/* Asset verbs (docs/cloud-frames.md assets_list/asset_get). Files are read
 * off the SD card and streamed as base64 asset_chunk frames from the cloud
 * task — never from the WS event handler, which must stay responsive. The
 * caps match the reference provider: it refuses to cache anything bigger. */
#define FOS_CLOUD_ASSET_MAX_FILE_BYTES (8u * 1024u * 1024u)
#define FOS_CLOUD_ASSET_CHUNK_BYTES (24u * 1024u)
#define FOS_CLOUD_ASSET_LIST_MAX_ENTRIES 2000
#define FOS_CLOUD_ASSET_LIST_MAX_DEPTH 8
#define FOS_CLOUD_ASSET_PATH_MAX 256
#define FOS_CLOUD_ASSET_JOB_QUEUE_DEPTH 8

static fos_cloud_state_t s_state = FOS_CLOUD_NONE;
static char s_last_error[96] = "";
static char s_access_token[FOS_CLOUD_TOKEN_LEN] = "";
static char s_frame_id[FOS_CLOUD_FRAME_ID_LEN] = "";
static char s_ws_path[FOS_CLOUD_WS_PATH_LEN] = "";
/* Optional full ws(s):// URL from enrollment: where the management WebSocket
 * actually lives when that differs from {cloud_url}{ws_path} (a dev provider
 * whose frame hub is a second process on its own port). Empty = use
 * cloud_url + ws_path. */
static char s_ws_url[FOS_URL_LEN] = "";
static bool s_ws_ready = false;
static TaskHandle_t s_task = NULL;

fos_cloud_state_t fos_cloud_state(void) { return s_state; }

const char *fos_cloud_state_name(void)
{
    switch (s_state) {
        case FOS_CLOUD_PENDING: return "pending";
        case FOS_CLOUD_ENROLLED: return "enrolled";
        case FOS_CLOUD_ERROR: return "error";
        default: return "none";
    }
}

const char *fos_cloud_last_error(void) { return s_last_error; }
const char *fos_cloud_frame_id(void) { return s_frame_id; }
bool fos_cloud_ws_connected(void) { return s_ws_ready; }

static void set_last_error(const char *message)
{
    strlcpy(s_last_error, message ? message : "", sizeof(s_last_error));
}

/* ------------------------------------------------------------- NVS helpers */

static bool nvs_load_str(const char *key, char *out, size_t out_len)
{
    nvs_handle_t nvs;
    out[0] = '\0';
    if (nvs_open(NVS_NS, NVS_READONLY, &nvs) != ESP_OK) return false;
    size_t len = out_len;
    esp_err_t err = nvs_get_str(nvs, key, out, &len);
    nvs_close(nvs);
    if (err != ESP_OK) out[0] = '\0';
    return err == ESP_OK && out[0] != '\0';
}

static esp_err_t nvs_store_str(const char *key, const char *value)
{
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &nvs);
    if (err != ESP_OK) return err;
    err = nvs_set_str(nvs, key, value);
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);
    return err;
}

/* Drop a key; a missing key is success. */
static void nvs_erase_key_quiet(const char *key)
{
    nvs_handle_t nvs;
    if (nvs_open(NVS_NS, NVS_READWRITE, &nvs) != ESP_OK) return;
    esp_err_t err = nvs_erase_key(nvs, key);
    if (err == ESP_OK) nvs_commit(nvs);
    nvs_close(nvs);
}

/* ------------------------------------------------- provider URL transport */

/* Everything this link carries — the single-use claim token, the bearer
 * access token, every scene push — is forgeable by an on-path attacker over
 * plain HTTP, so http:// (and its ws:// downgrade) is accepted only for hosts
 * where there is no meaningful third party on the path. Same rule as
 * `docs/cloud-link.md` and backend/app/utils/cloud_link.py::_is_local_host:
 * localhost, `.local`/`.localhost` names, loopback, RFC1918, link-local and
 * CGNAT literals. */
static bool host_is_local(const char *host)
{
    if (!host || !host[0]) return false;

    /* Case-insensitive suffix/exact name checks. */
    size_t len = strlen(host);
    char lower[128];
    if (len < sizeof(lower)) { /* longer than this is never a local name */
        for (size_t i = 0; i <= len; i++) {
            char c = host[i];
            lower[i] = (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
        }
        if (strcmp(lower, "localhost") == 0) return true;
        size_t n = strlen(lower);
        if (n > 6 && strcmp(lower + n - 6, ".local") == 0) return true;
        if (n > 10 && strcmp(lower + n - 10, ".localhost") == 0) return true;
    }

    /* IPv6 literals arrive without brackets here. */
    if (strchr(host, ':')) {
        if (strcmp(host, "::1") == 0) return true;
        if (strncasecmp(host, "fe80:", 5) == 0) return true;          /* link-local */
        if ((host[0] == 'f' || host[0] == 'F') &&
            (host[1] == 'c' || host[1] == 'C' || host[1] == 'd' || host[1] == 'D')) {
            return true;                                              /* ULA fc00::/7 */
        }
        return false;
    }

    unsigned a = 0, b = 0, c = 0, d = 0;
    char tail = 0;
    if (sscanf(host, "%u.%u.%u.%u%c", &a, &b, &c, &d, &tail) != 4) return false;
    if (a > 255 || b > 255 || c > 255 || d > 255) return false;
    if (a == 127) return true;                                        /* loopback */
    if (a == 10) return true;                                         /* RFC1918 */
    if (a == 172 && b >= 16 && b <= 31) return true;                  /* RFC1918 */
    if (a == 192 && b == 168) return true;                            /* RFC1918 */
    if (a == 169 && b == 254) return true;                            /* link-local */
    if (a == 100 && b >= 64 && b <= 127) return true;                 /* CGNAT */
    return false;
}

/* Split "scheme://host[:port][/path]" into scheme flag + host[:port].
 * Returns false when the URL has neither the secure nor the plain scheme,
 * or no host. */
static bool split_scheme_url(const char *url, const char *secure_scheme,
                             const char *plain_scheme, bool *is_secure,
                             char *host, size_t host_len)
{
    const char *rest;
    if (strncasecmp(url, secure_scheme, strlen(secure_scheme)) == 0) {
        *is_secure = true;
        rest = url + strlen(secure_scheme);
    } else if (strncasecmp(url, plain_scheme, strlen(plain_scheme)) == 0) {
        *is_secure = false;
        rest = url + strlen(plain_scheme);
    } else {
        return false;
    }
    strlcpy(host, rest, host_len);
    size_t cut = strcspn(host, "/?#");
    host[cut] = '\0';
    /* Anything with userinfo, or otherwise not a bare host[:port], is left
     * intact here and fails the host check below rather than being guessed. */
    return host[0] != '\0';
}

/* Strip [] and :port so host_is_local() sees a bare name or literal. */
static void host_only(const char *hostport, char *out, size_t out_len)
{
    strlcpy(out, hostport, out_len);
    if (out[0] == '[') {
        memmove(out, out + 1, strlen(out)); /* includes the NUL */
        char *close = strchr(out, ']');
        if (close) *close = '\0';
        return;
    }
    /* A bare IPv6 literal has several colons; only strip a single :port. */
    char *colon = strrchr(out, ':');
    if (colon && strchr(out, ':') == colon) *colon = '\0';
}

/* One transport rule for both wire shapes: the secure scheme (https/wss) is
 * fine anywhere; the plain one (http/ws) only for the dev hosts
 * host_is_local() accepts. */
static bool url_transport_ok(const char *url, bool ws, const char **reason)
{
    const char *why = NULL;
    bool is_secure = false;
    char hostport[FOS_URL_LEN];
    char host[FOS_URL_LEN];
    bool ok = false;

    if (!url || !url[0]) {
        why = "empty";
    } else if (!split_scheme_url(url, ws ? "wss://" : "https://",
                                 ws ? "ws://" : "http://", &is_secure,
                                 hostport, sizeof(hostport))) {
        why = ws ? "must be a ws:// or wss:// URL"
                 : "must be an http:// or https:// URL";
    } else if (is_secure) {
        ok = true;
    } else {
        host_only(hostport, host, sizeof(host));
        if (host_is_local(host)) {
            ok = true;
        } else {
            why = ws ? "ws:// is allowed only for localhost, .local and "
                       "private-network hosts (development)"
                     : "http:// is allowed only for localhost, .local and "
                       "private-network hosts (development)";
        }
    }
    if (reason) *reason = why;
    return ok;
}

bool fos_cloud_url_transport_ok(const char *url, const char **reason)
{
    return url_transport_ok(url, false, reason);
}

/* Enrollment's optional ws_url override (docs/cloud-frames.md): a full
 * WebSocket URL, held to the same rule as cloud_url. */
static bool ws_url_transport_ok(const char *url, const char **reason)
{
    return url_transport_ok(url, true, reason);
}

/* ------------------------------------------------------------------ crypto */

/* Load (or create on first use) the Ed25519 seed and derive the keypair.
 * The 32-byte seed lives in NVS blob `cloud_sk` and is never printed or
 * shipped anywhere; the provider only ever sees the public key.
 * Wipe secret_key with crypto_wipe() after use. */
static esp_err_t ensure_keypair(uint8_t secret_key[64], uint8_t public_key[32])
{
    uint8_t seed[32];
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &nvs);
    if (err != ESP_OK) return err;

    size_t len = sizeof(seed);
    err = nvs_get_blob(nvs, "cloud_sk", seed, &len);
    if (err != ESP_OK || len != sizeof(seed)) {
        esp_fill_random(seed, sizeof(seed)); /* true RNG once Wi-Fi/RF is up */
        err = nvs_set_blob(nvs, "cloud_sk", seed, sizeof(seed));
        if (err == ESP_OK) err = nvs_commit(nvs);
        if (err != ESP_OK) {
            crypto_wipe(seed, sizeof(seed));
            nvs_close(nvs);
            return err;
        }
        ESP_LOGI(TAG, "generated new Ed25519 device key");
    }
    nvs_close(nvs);

    /* crypto_ed25519_key_pair wipes the seed argument, which is exactly what
     * we want for the stack copy. */
    crypto_ed25519_key_pair(secret_key, public_key, seed);
    return ESP_OK;
}

static bool b64_encode(const uint8_t *data, size_t len, char *out, size_t out_len)
{
    size_t written = 0;
    int rc = mbedtls_base64_encode((unsigned char *)out, out_len, &written, data, len);
    if (rc != 0) return false;
    out[written] = '\0';
    return true;
}

/* --------------------------------------------------------------- enrollment */

static void add_hardware_json(cJSON *parent)
{
    const fos_config_t *config = fos_config();
    cJSON *hw = cJSON_AddObjectToObject(parent, "hardware");
    if (!hw) return;
    cJSON_AddStringToObject(hw, "platform", "esp32");
    /* docs/cloud-frames.md calls this "device" (driver name); keep "panel"
     * too so the value is unambiguous for esp32 firmware. */
    cJSON_AddStringToObject(hw, "device", config->panel);
    cJSON_AddStringToObject(hw, "panel", config->panel);
    cJSON_AddNumberToObject(hw, "width", fos_display_present() ? fos_display_width() : 0);
    cJSON_AddNumberToObject(hw, "height", fos_display_present() ? fos_display_height() : 0);
}

/* Build the /api/frames/enroll body. Caller frees with cJSON_free(). */
static char *build_enroll_json(const char *claim_token, const char *public_key_b64)
{
    const fos_config_t *config = fos_config();
    cJSON *root = cJSON_CreateObject();
    if (!root) return NULL;
    cJSON_AddStringToObject(root, "claim_token", claim_token);
    cJSON_AddStringToObject(root, "public_key", public_key_b64);
    add_hardware_json(root);
    cJSON_AddStringToObject(root, "frameos_version", esp_app_get_description()->version);
    if (config->hostname[0]) {
        cJSON_AddStringToObject(root, "name", config->hostname);
    }
    char *out = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    return out;
}

static void erase_claim_token(void)
{
    fos_config_t *config = fos_config();
    if (!config->claim_token[0]) return;
    memset(config->claim_token, 0, sizeof(config->claim_token));
    fos_config_save(); /* claim_token == "" erases the NVS key */
}

/* Copy a string-or-number JSON field.
 *
 * `out` is always left NUL-terminated, including when the field is missing or
 * of the wrong type — callers must still check the return value, but a
 * malformed provider response can never leave an uninitialized stack buffer
 * to be strlen()'d. A value that would be truncated is refused rather than
 * silently shortened: a half a frame id or bearer token is worse than none. */
static bool json_field_str(const cJSON *root, const char *key, char *out, size_t out_len)
{
    if (out_len == 0) return false;
    out[0] = '\0';
    const cJSON *item = cJSON_GetObjectItem(root, key);
    if (cJSON_IsString(item) && item->valuestring) {
        if (strlen(item->valuestring) >= out_len) return false;
        strlcpy(out, item->valuestring, out_len);
        return out[0] != '\0';
    }
    if (cJSON_IsNumber(item)) {
        int written = snprintf(out, out_len, "%.0f", item->valuedouble);
        if (written < 0 || (size_t)written >= out_len) {
            out[0] = '\0';
            return false;
        }
        return true;
    }
    return false;
}

/* One enrollment attempt. Returns ESP_OK on success. Sets *permanent when
 * retrying is pointless (the claim token is dead). */
static esp_err_t enroll_once(bool *permanent)
{
    *permanent = false;
    fos_config_t *config = fos_config();

    /* Refuse to hand the claim token to a cleartext provider. */
    const char *why = NULL;
    if (!fos_cloud_url_transport_ok(config->cloud_url, &why)) {
        char detail[sizeof(s_last_error)];
        snprintf(detail, sizeof(detail), "cloud_url refused: %s", why ? why : "invalid");
        set_last_error(detail);
        ESP_LOGE(TAG, "%s", detail);
        /* Not "permanent": the claim token is still good and a corrected
         * cloud_url can be provisioned at any time, so let the caller back
         * off (10 s → 15 min) instead of spinning or erasing the token. */
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t secret_key[64];
    uint8_t public_key[32];
    esp_err_t err = ensure_keypair(secret_key, public_key);
    if (err != ESP_OK) {
        set_last_error("keypair unavailable");
        return err;
    }
    crypto_wipe(secret_key, sizeof(secret_key)); /* only the pubkey is needed here */

    char public_key_b64[64];
    if (!b64_encode(public_key, sizeof(public_key), public_key_b64, sizeof(public_key_b64))) {
        set_last_error("pubkey encode failed");
        return ESP_FAIL;
    }

    char *body = build_enroll_json(config->claim_token, public_key_b64);
    if (!body) {
        set_last_error("request build failed");
        return ESP_ERR_NO_MEM;
    }

    char url[FOS_URL_LEN + 32];
    snprintf(url, sizeof(url), "%s/api/frames/enroll", config->cloud_url);
    ESP_LOGI(TAG, "enrolling with %s", url);

    esp_http_client_config_t http_config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = FOS_CLOUD_HTTP_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 2048,
    };
    esp_http_client_handle_t client = esp_http_client_init(&http_config);
    if (!client) {
        cJSON_free(body);
        set_last_error("http client init failed");
        return ESP_FAIL;
    }
    esp_http_client_set_header(client, "Content-Type", "application/json");

    size_t body_len = strlen(body);
    err = esp_http_client_open(client, body_len);
    if (err == ESP_OK) {
        int written = esp_http_client_write(client, body, body_len);
        if (written != (int)body_len) err = ESP_FAIL;
    }
    cJSON_free(body);
    if (err != ESP_OK) {
        esp_http_client_cleanup(client);
        set_last_error("provider unreachable");
        return err;
    }

    esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);
    char response[FOS_CLOUD_RESPONSE_MAX];
    int total = 0;
    while (total < (int)sizeof(response) - 1) {
        int r = esp_http_client_read(client, response + total, sizeof(response) - 1 - total);
        if (r <= 0) break;
        total += r;
    }
    response[total] = '\0';
    esp_http_client_close(client);
    esp_http_client_cleanup(client);

    if (status == 200) {
        cJSON *json = cJSON_Parse(response);
        if (!json) {
            set_last_error("bad enroll response");
            return ESP_FAIL;
        }
        /* A third-party provider may answer 200 with anything; treat every
         * required field as absent until proven otherwise, and never persist
         * a half-parsed identity. */
        char token[FOS_CLOUD_TOKEN_LEN] = "";
        char frame_id[FOS_CLOUD_FRAME_ID_LEN] = "";
        char ws_path[FOS_CLOUD_WS_PATH_LEN] = "";
        const char *missing = NULL;
        if (!json_field_str(json, "access_token", token, sizeof(token))) {
            missing = "access_token";
        } else if (!json_field_str(json, "frame_id", frame_id, sizeof(frame_id))) {
            missing = "frame_id";
        }
        /* ws_path is an absolute path on the provider host; anything else
         * (missing, relative, a full URL) falls back to the documented
         * default rather than being pasted into the dial URI. */
        if (!json_field_str(json, "ws_path", ws_path, sizeof(ws_path)) ||
            ws_path[0] != '/') {
            strlcpy(ws_path, "/api/frames/ws", sizeof(ws_path));
        }
        /* Optional ws_url: a full ws(s):// URL used INSTEAD of
         * cloud_url + ws_path (dev providers whose frame hub is a separate
         * port). Same transport rule as cloud_url — an override that fails
         * it is dropped here, before it can be persisted or dialed. */
        char ws_url[FOS_URL_LEN] = "";
        if (json_field_str(json, "ws_url", ws_url, sizeof(ws_url))) {
            const char *why = NULL;
            if (!ws_url_transport_ok(ws_url, &why)) {
                ESP_LOGW(TAG, "enroll: ignoring ws_url: %s", why ? why : "invalid");
                ws_url[0] = '\0';
            }
        }
        cJSON_Delete(json);
        if (missing) {
            char detail[sizeof(s_last_error)];
            snprintf(detail, sizeof(detail), "enroll response missing %s", missing);
            set_last_error(detail);
            crypto_wipe(token, sizeof(token));
            return ESP_FAIL;
        }
        if (nvs_store_str("cloud_token", token) != ESP_OK ||
            nvs_store_str("cloud_fid", frame_id) != ESP_OK ||
            nvs_store_str("cloud_ws", ws_path) != ESP_OK ||
            (ws_url[0] && nvs_store_str("cloud_wsurl", ws_url) != ESP_OK)) {
            set_last_error("nvs write failed");
            crypto_wipe(token, sizeof(token));
            return ESP_FAIL;
        }
        /* A re-enrollment whose provider stopped sending ws_url must not
         * keep dialing a stale override from a previous life. */
        if (!ws_url[0]) nvs_erase_key_quiet("cloud_wsurl");
        strlcpy(s_access_token, token, sizeof(s_access_token));
        strlcpy(s_frame_id, frame_id, sizeof(s_frame_id));
        strlcpy(s_ws_path, ws_path, sizeof(s_ws_path));
        strlcpy(s_ws_url, ws_url, sizeof(s_ws_url));
        crypto_wipe(token, sizeof(token));
        erase_claim_token();
        set_last_error("");
        ESP_LOGI(TAG, "enrolled: frame_id=%s ws_path=%s%s%s (claim token erased)",
                 s_frame_id[0] ? s_frame_id : "?", s_ws_path,
                 s_ws_url[0] ? " ws_url=" : "", s_ws_url);
        return ESP_OK;
    }

    /* Claim tokens are single use, success or failure: any 400 means this
     * token is dead (invalid/expired/used/bad key) and retrying cannot help. */
    if (status == 400) {
        char reason[48] = "";
        const char *reason_str = "rejected";
        cJSON *json = cJSON_Parse(response);
        if (json) {
            if (json_field_str(json, "error", reason, sizeof(reason))) reason_str = reason;
            cJSON_Delete(json);
        }
        char detail[sizeof(s_last_error)];
        snprintf(detail, sizeof(detail), "enroll rejected: %s", reason_str);
        set_last_error(detail);
        ESP_LOGW(TAG, "%s; claim token erased, get a new one from the provider", detail);
        erase_claim_token();
        *permanent = true;
        return ESP_FAIL;
    }

    char detail[sizeof(s_last_error)];
    snprintf(detail, sizeof(detail), "enroll HTTP %d", status);
    set_last_error(detail);
    ESP_LOGW(TAG, "%s; will retry", detail);
    return ESP_FAIL;
}

/* --------------------------------------------------- management WebSocket */

#ifdef FOS_CLOUD_HAVE_WS

static esp_websocket_client_handle_t s_ws_client = NULL;
static char s_ws_uri[FOS_URL_LEN + FOS_CLOUD_WS_PATH_LEN + 16];
static char s_ws_headers[FOS_CLOUD_TOKEN_LEN + 32];
static char *s_ws_rx = NULL;
static size_t s_ws_rx_len = 0;
static uint32_t s_ws_backoff_ms = FOS_CLOUD_WS_BACKOFF_MIN_MS;
static bool s_ws_backoff_advanced = false;
static uint8_t s_ws_auth_failures = 0;
/* Set from the WS task, consumed by the cloud task: the client cannot be
 * destroyed from inside its own event handler. */
static volatile bool s_ws_demote_pending = false;

/* Deferred scene_ack: armed by set_scenes on the WS task, emitted by the
 * cloud task once the render task has the payload live. Only one push is
 * ever in flight (the provider drains its queue in order), so a plain
 * flag-last store is enough synchronization here. */
static char s_scene_ack_checksum[96] = "";
static uint32_t s_scene_ack_generation = 0;
static int64_t s_scene_ack_deadline_us = 0;
static volatile bool s_scene_ack_pending = false;

static void ws_backoff_reset(void);

static void ws_send_json(cJSON *msg)
{
    char *text = cJSON_PrintUnformatted(msg);
    if (!text) return;
    esp_websocket_client_send_text(s_ws_client, text, strlen(text),
                                   pdMS_TO_TICKS(10000));
    cJSON_free(text);
}

/* Attach the hello-shaped state fields to msg. */
static void add_state_fields(cJSON *msg)
{
    cJSON_AddStringToObject(msg, "frameos_version", esp_app_get_description()->version);
    add_hardware_json(msg);
    cJSON *states = NULL;
    const char *state_json = frameos_nim_scene_state_json();
    if (state_json && state_json[0]) states = cJSON_Parse(state_json);
    if (!states) states = cJSON_CreateObject();
    cJSON_AddItemToObject(msg, "states", states);
    cJSON_AddStringToObject(msg, "scenes_checksum", fos_scenes_etag());
}

static void ws_send_hello(void)
{
    cJSON *msg = cJSON_CreateObject();
    if (!msg) return;
    cJSON_AddStringToObject(msg, "type", "hello");
    add_state_fields(msg);
    ws_send_json(msg);
    cJSON_Delete(msg);
}

/* challenge → auth: sign the base64-decoded nonce bytes with the enrolled
 * Ed25519 key, proving key possession beyond the bearer token. */
static void ws_send_auth(const cJSON *root)
{
    const cJSON *nonce_item = cJSON_GetObjectItem(root, "nonce");
    if (!cJSON_IsString(nonce_item) || !nonce_item->valuestring) {
        ESP_LOGW(TAG, "challenge without nonce");
        return;
    }
    uint8_t nonce[FOS_CLOUD_NONCE_MAX];
    size_t nonce_len = 0;
    if (mbedtls_base64_decode(nonce, sizeof(nonce), &nonce_len,
                              (const unsigned char *)nonce_item->valuestring,
                              strlen(nonce_item->valuestring)) != 0 ||
        nonce_len == 0) {
        ESP_LOGW(TAG, "challenge nonce decode failed");
        return;
    }

    uint8_t secret_key[64];
    uint8_t public_key[32];
    if (ensure_keypair(secret_key, public_key) != ESP_OK) {
        ESP_LOGW(TAG, "auth: keypair unavailable");
        return;
    }
    uint8_t signature[64];
    crypto_ed25519_sign(signature, secret_key, nonce, nonce_len);
    crypto_wipe(secret_key, sizeof(secret_key));

    char signature_b64[96];
    if (!b64_encode(signature, sizeof(signature), signature_b64, sizeof(signature_b64))) {
        return;
    }
    cJSON *msg = cJSON_CreateObject();
    if (!msg) return;
    cJSON_AddStringToObject(msg, "type", "auth");
    cJSON_AddStringToObject(msg, "signature", signature_b64);
    ws_send_json(msg);
    cJSON_Delete(msg);
}

static void ws_ack(const cJSON *id, bool ok, const char *error)
{
    cJSON *msg = cJSON_CreateObject();
    if (!msg) return;
    if (id) cJSON_AddItemToObject(msg, "id", cJSON_Duplicate(id, 1));
    cJSON_AddStringToObject(msg, "type", "ack");
    cJSON_AddBoolToObject(msg, "ok", ok);
    if (!ok && error) cJSON_AddStringToObject(msg, "error", error);
    ws_send_json(msg);
    cJSON_Delete(msg);
}

static void ws_send_state(const cJSON *id)
{
    cJSON *msg = cJSON_CreateObject();
    if (!msg) return;
    if (id) cJSON_AddItemToObject(msg, "id", cJSON_Duplicate(id, 1));
    cJSON_AddStringToObject(msg, "type", "state");
    add_state_fields(msg);
    ws_send_json(msg);
    cJSON_Delete(msg);
}

static void ws_reboot_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(750)); /* let the ack flush first */
    esp_restart();
}

static void ws_schedule_reboot(void)
{
    if (xTaskCreate(ws_reboot_task, "fos_cloud_reboot", 2048, NULL, 5, NULL) != pdPASS) {
        esp_restart();
    }
}

/* Emit the scene_ack for the last accepted set_scenes, once the render task
 * has actually hot-loaded the payload. Called from the cloud task.
 *
 * Silence is meaningful: a hot-load failure (or a render task that never gets
 * to it) leaves the provider showing this frame as out of sync, which is the
 * truth. The command itself was already acked — that ack means "accepted and
 * persisted", scene_ack means "live". */
static void ws_poll_scene_ack(void)
{
    if (!s_scene_ack_pending) return;

    if (fos_scenes_apply_generation() == s_scene_ack_generation) {
        if (esp_timer_get_time() < s_scene_ack_deadline_us) return;
        s_scene_ack_pending = false;
        ESP_LOGW(TAG, "set_scenes: payload not applied within %d s; no scene_ack sent",
                 FOS_CLOUD_SCENE_ACK_TIMEOUT_MS / 1000);
        return;
    }
    s_scene_ack_pending = false;
    if (!fos_scenes_apply_succeeded()) {
        ESP_LOGW(TAG, "set_scenes: hot-load failed; no scene_ack sent");
        return;
    }
    if (!s_ws_client || !s_ws_ready) {
        /* Socket went away between the push and the apply; the next hello
         * carries scenes_checksum, so the provider resyncs from there. */
        ESP_LOGI(TAG, "set_scenes: applied while offline; scene_ack deferred to hello");
        return;
    }

    cJSON *msg = cJSON_CreateObject();
    if (!msg) return; /* out of memory: stay silent, provider retries */
    cJSON_AddStringToObject(msg, "type", "scene_ack");
    if (s_scene_ack_checksum[0]) {
        cJSON_AddStringToObject(msg, "checksum", s_scene_ack_checksum);
    }
    char scene_id[128] = "";
    const char *info = frameos_nim_scene_info_json();
    cJSON *info_json = info && info[0] ? cJSON_Parse(info) : NULL;
    if (info_json) {
        json_field_str(info_json, "currentSceneId", scene_id, sizeof(scene_id));
        cJSON_Delete(info_json);
    }
    cJSON_AddStringToObject(msg, "active_scene", scene_id);
    ws_send_json(msg);
    cJSON_Delete(msg);
}

/* ------------------------------------------------------------- asset verbs */

typedef enum { ASSET_JOB_LIST = 0, ASSET_JOB_GET = 1, ASSET_JOB_IMAGE = 2 } asset_job_kind_t;

typedef struct {
    uint8_t kind;
    char id[48]; /* command uuid, echoed on every reply frame */
    char path[FOS_CLOUD_ASSET_PATH_MAX];
} asset_job_t;

static QueueHandle_t s_asset_jobs = NULL;

/* Relative, inside the assets root, no dot-segments. Returns false on
 * anything a provider should never send (the provider validates too, but the
 * device is the enforcement point). */
static bool asset_path_sanitize(const char *raw, char *out, size_t out_len)
{
    if (!raw) return false;
    while (raw[0] == '/' || (raw[0] == '.' && raw[1] == '/')) {
        raw += (raw[0] == '/') ? 1 : 2;
    }
    size_t len = strlen(raw);
    if (len == 0 || len >= out_len) return false;
    const char *p = raw;
    while (*p) {
        const char *slash = strchr(p, '/');
        size_t seg = slash ? (size_t)(slash - p) : strlen(p);
        if (seg == 0) return false;                       /* "a//b" */
        if (seg == 2 && p[0] == '.' && p[1] == '.') return false;
        p += seg;
        if (*p == '/') p++;
    }
    memcpy(out, raw, len + 1);
    return true;
}

static const char *asset_content_type(const char *path)
{
    const char *dot = strrchr(path, '.');
    if (!dot) return "application/octet-stream";
    if (!strcasecmp(dot, ".png")) return "image/png";
    if (!strcasecmp(dot, ".jpg") || !strcasecmp(dot, ".jpeg")) return "image/jpeg";
    if (!strcasecmp(dot, ".gif")) return "image/gif";
    if (!strcasecmp(dot, ".bmp")) return "image/bmp";
    if (!strcasecmp(dot, ".webp")) return "image/webp";
    if (!strcasecmp(dot, ".svg")) return "image/svg+xml";
    if (!strcasecmp(dot, ".txt") || !strcasecmp(dot, ".log")) return "text/plain";
    if (!strcasecmp(dot, ".json")) return "application/json";
    return "application/octet-stream";
}

static void asset_full_path(char *out, size_t out_len, const char *rel)
{
    const fos_config_t *config = fos_config();
    const char *root = config->assets_path[0] ? config->assets_path : "/srv/assets";
    snprintf(out, out_len, "%s/%s", root, rel);
}

/* Recursive SD walk for assets_list. Dotfiles stay local (same rule as the
 * Linux firmware); entries beyond the cap flip `truncated` instead of
 * silently stopping. Returns false only on allocation failure. */
static bool asset_list_walk(cJSON *assets, char *rel, size_t rel_cap,
                            int depth, int *count, bool *truncated)
{
    if (depth > FOS_CLOUD_ASSET_LIST_MAX_DEPTH) return true;
    char full[FOS_CLOUD_ASSET_PATH_MAX + 128];
    asset_full_path(full, sizeof(full), rel);
    DIR *dir = opendir(rel[0] ? full : full); /* rel=="" walks the root */
    if (!dir) return true;
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        if (entry->d_name[0] == '.') continue;
        if (*count >= FOS_CLOUD_ASSET_LIST_MAX_ENTRIES) {
            *truncated = true;
            break;
        }
        size_t rel_len = strlen(rel);
        size_t name_len = strlen(entry->d_name);
        if (rel_len + name_len + 2 >= rel_cap) continue;
        if (rel_len > 0) {
            rel[rel_len] = '/';
            memcpy(rel + rel_len + 1, entry->d_name, name_len + 1);
        } else {
            memcpy(rel, entry->d_name, name_len + 1);
        }
        asset_full_path(full, sizeof(full), rel);
        struct stat st;
        if (stat(full, &st) == 0) {
            cJSON *item = cJSON_CreateObject();
            if (!item) {
                closedir(dir);
                rel[rel_len] = '\0';
                return false;
            }
            cJSON_AddStringToObject(item, "path", rel);
            bool is_dir = S_ISDIR(st.st_mode);
            cJSON_AddNumberToObject(item, "size", is_dir ? 0 : (double)st.st_size);
            cJSON_AddNumberToObject(item, "mtime", (double)st.st_mtime);
            cJSON_AddBoolToObject(item, "is_dir", is_dir);
            cJSON_AddItemToArray(assets, item);
            (*count)++;
            if (is_dir &&
                !asset_list_walk(assets, rel, rel_cap, depth + 1, count, truncated)) {
                closedir(dir);
                rel[rel_len] = '\0';
                return false;
            }
        }
        rel[rel_len] = '\0';
    }
    closedir(dir);
    return true;
}

static void asset_job_run_list(const asset_job_t *job)
{
    cJSON *msg = cJSON_CreateObject();
    if (!msg) return;
    if (job->id[0]) cJSON_AddStringToObject(msg, "id", job->id);
    cJSON_AddStringToObject(msg, "type", "assets");
    cJSON *assets = cJSON_AddArrayToObject(msg, "assets");
    bool truncated = false;
    if (assets && fos_assets_sd_mounted()) {
        char rel[FOS_CLOUD_ASSET_PATH_MAX] = "";
        int count = 0;
        asset_list_walk(assets, rel, sizeof(rel), 0, &count, &truncated);
    }
    if (truncated) cJSON_AddBoolToObject(msg, "truncated", true);
    ws_send_json(msg);
    cJSON_Delete(msg);
}

static void asset_chunk_send_error(const char *id, const char *error)
{
    cJSON *msg = cJSON_CreateObject();
    if (!msg) return;
    if (id[0]) cJSON_AddStringToObject(msg, "id", id);
    cJSON_AddStringToObject(msg, "type", "asset_chunk");
    cJSON_AddStringToObject(msg, "error", error);
    cJSON_AddBoolToObject(msg, "done", true);
    ws_send_json(msg);
    cJSON_Delete(msg);
}

static void asset_job_run_get(const asset_job_t *job)
{
    char full[FOS_CLOUD_ASSET_PATH_MAX + 128];
    asset_full_path(full, sizeof(full), job->path);
    struct stat st;
    if (!fos_assets_sd_mounted() || stat(full, &st) != 0) {
        asset_chunk_send_error(job->id, "not_found");
        return;
    }
    FILE *file = fopen(full, "rb");
    if (!file) {
        asset_chunk_send_error(job->id, "not_found");
        return;
    }
    size_t total = (size_t)st.st_size;
    uint8_t *raw = heap_caps_malloc(FOS_CLOUD_ASSET_CHUNK_BYTES,
                                    MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    /* +2 for base64 rounding, +1 for NUL */
    size_t b64_cap = ((FOS_CLOUD_ASSET_CHUNK_BYTES + 2) / 3) * 4 + 8;
    char *b64 = heap_caps_malloc(b64_cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!raw || !b64) {
        free(raw);
        free(b64);
        fclose(file);
        asset_chunk_send_error(job->id, "no_memory");
        return;
    }
    size_t sent = 0;
    int seq = 0;
    bool failed = false;
    do {
        size_t r = fread(raw, 1, FOS_CLOUD_ASSET_CHUNK_BYTES, file);
        if (ferror(file)) {
            asset_chunk_send_error(job->id, "read_failed");
            failed = true;
            break;
        }
        size_t b64_len = 0;
        if (mbedtls_base64_encode((unsigned char *)b64, b64_cap, &b64_len,
                                  raw, r) != 0) {
            asset_chunk_send_error(job->id, "no_memory");
            failed = true;
            break;
        }
        b64[b64_len] = '\0';
        sent += r;
        bool done = sent >= total || r == 0;
        cJSON *msg = cJSON_CreateObject();
        if (!msg) {
            asset_chunk_send_error(job->id, "no_memory");
            failed = true;
            break;
        }
        if (job->id[0]) cJSON_AddStringToObject(msg, "id", job->id);
        cJSON_AddStringToObject(msg, "type", "asset_chunk");
        cJSON_AddNumberToObject(msg, "seq", seq);
        cJSON_AddStringToObject(msg, "data", b64);
        cJSON_AddBoolToObject(msg, "done", done);
        if (seq == 0) {
            cJSON_AddNumberToObject(msg, "size", (double)total);
            cJSON_AddNumberToObject(msg, "mtime", (double)st.st_mtime);
            cJSON_AddStringToObject(msg, "content_type", asset_content_type(job->path));
        }
        if (!s_ws_client || !s_ws_ready) {
            /* Socket went away mid-stream: the provider discards partials and
             * the command redelivers on the next session. */
            cJSON_Delete(msg);
            failed = true;
            break;
        }
        ws_send_json(msg);
        cJSON_Delete(msg);
        seq++;
        if (done) break;
    } while (true);
    (void)failed;
    free(raw);
    free(b64);
    fclose(file);
}

/* Stream one in-memory payload as asset_chunk frames (image_get). */
static void asset_stream_buffer(const char *id, const uint8_t *data, size_t total,
                                const char *content_type)
{
    size_t b64_cap = ((FOS_CLOUD_ASSET_CHUNK_BYTES + 2) / 3) * 4 + 8;
    char *b64 = heap_caps_malloc(b64_cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!b64) {
        asset_chunk_send_error(id, "no_memory");
        return;
    }
    size_t offset = 0;
    int seq = 0;
    do {
        size_t chunk = total - offset;
        if (chunk > FOS_CLOUD_ASSET_CHUNK_BYTES) chunk = FOS_CLOUD_ASSET_CHUNK_BYTES;
        size_t b64_len = 0;
        if (mbedtls_base64_encode((unsigned char *)b64, b64_cap, &b64_len,
                                  data + offset, chunk) != 0) {
            asset_chunk_send_error(id, "no_memory");
            break;
        }
        b64[b64_len] = '\0';
        offset += chunk;
        bool done = offset >= total;
        cJSON *msg = cJSON_CreateObject();
        if (!msg) {
            asset_chunk_send_error(id, "no_memory");
            break;
        }
        if (id[0]) cJSON_AddStringToObject(msg, "id", id);
        cJSON_AddStringToObject(msg, "type", "asset_chunk");
        cJSON_AddNumberToObject(msg, "seq", seq);
        cJSON_AddStringToObject(msg, "data", b64);
        cJSON_AddBoolToObject(msg, "done", done);
        if (seq == 0) {
            cJSON_AddNumberToObject(msg, "size", (double)total);
            cJSON_AddNumberToObject(msg, "mtime", (double)(esp_timer_get_time() / 1000000));
            cJSON_AddStringToObject(msg, "content_type", content_type);
        }
        if (!s_ws_client || !s_ws_ready) {
            cJSON_Delete(msg);
            break;
        }
        ws_send_json(msg);
        cJSON_Delete(msg);
        seq++;
        if (done) break;
    } while (true);
    free(b64);
}

/* image_get: the current render, packed to BMP by the same path the USB
 * `usb_api image` command uses. Runs on the cloud task; the pack allocates
 * from PSRAM and is freed before the next job. */
static void asset_job_run_image(const asset_job_t *job)
{
    uint8_t *bmp = NULL;
    size_t bmp_len = 0;
    char scene_id[128] = "";
    if (fos_http_preview_bmp_alloc(&bmp, &bmp_len, scene_id, sizeof(scene_id)) != ESP_OK ||
        !bmp || bmp_len == 0) {
        free(bmp);
        asset_chunk_send_error(job->id, "no_image");
        return;
    }
    asset_stream_buffer(job->id, bmp, bmp_len, "image/bmp");
    free(bmp);
}

/* Drain queued asset jobs. Called from the cloud task — file reads over SPI
 * plus multi-frame sends must never run inside the WS event handler. */
static bool ws_process_asset_jobs(void)
{
    if (!s_asset_jobs) return false;
    bool worked = false;
    asset_job_t job;
    while (s_ws_client && s_ws_ready &&
           xQueueReceive(s_asset_jobs, &job, 0) == pdTRUE) {
        if (job.kind == ASSET_JOB_LIST) {
            asset_job_run_list(&job);
        } else if (job.kind == ASSET_JOB_IMAGE) {
            asset_job_run_image(&job);
        } else {
            asset_job_run_get(&job);
        }
        worked = true;
    }
    return worked;
}

/* WS-handler side: validate cheaply (a stat, no reads), ack, and hand the
 * heavy part to the cloud task. A full queue is an honest `busy` — the
 * provider's queue redelivers or the browser retries. */
static void ws_handle_asset_verb(asset_job_kind_t kind, const cJSON *root, const cJSON *id)
{
    asset_job_t job = { .kind = (uint8_t)kind, .id = "", .path = "" };
    if (cJSON_IsString(id) && id->valuestring &&
        strlen(id->valuestring) < sizeof(job.id)) {
        strlcpy(job.id, id->valuestring, sizeof(job.id));
    }
    if (kind == ASSET_JOB_GET) {
        const cJSON *path_item = cJSON_GetObjectItem(root, "path");
        const char *raw = cJSON_IsString(path_item) ? path_item->valuestring : NULL;
        if (!asset_path_sanitize(raw, job.path, sizeof(job.path))) {
            ws_ack(id, false, "invalid_path");
            return;
        }
        if (!fos_assets_sd_mounted()) {
            ws_ack(id, false, "not_found");
            return;
        }
        char full[FOS_CLOUD_ASSET_PATH_MAX + 128];
        asset_full_path(full, sizeof(full), job.path);
        struct stat st;
        if (stat(full, &st) != 0) {
            ws_ack(id, false, "not_found");
            return;
        }
        if (S_ISDIR(st.st_mode)) {
            ws_ack(id, false, "is_directory");
            return;
        }
        if ((size_t)st.st_size > FOS_CLOUD_ASSET_MAX_FILE_BYTES) {
            ws_ack(id, false, "too_large");
            return;
        }
        /* `thumb` is accepted and ignored: no thumbnailer on this profile,
         * the original bytes are the reply (docs/cloud-frames.md). */
    }
    if (!s_asset_jobs) {
        s_asset_jobs = xQueueCreate(FOS_CLOUD_ASSET_JOB_QUEUE_DEPTH, sizeof(asset_job_t));
    }
    if (!s_asset_jobs || xQueueSend(s_asset_jobs, &job, 0) != pdTRUE) {
        ws_ack(id, false, "busy");
        return;
    }
    ws_ack(id, true, NULL);
}

/* set_scenes: same storage the USB `usb_api upload-scenes` command uses —
 * fos_scenes_set_json persists the interpreted-scene JSON and the render task
 * hot-loads it (compiled payloads are refused by the interpreted runtime
 * loader).
 *
 * Heap discipline: a max-size push already costs the reassembly buffer plus
 * the cJSON tree, so only the `scenes` array is reprinted here and handed
 * straight to the storage layer. Going through
 * fos_http_store_uploaded_scenes_payload() would reprint the whole envelope,
 * then parse and print it a second time inside that function — four to five
 * copies live at once on a device whose scene store tops out at 512 KiB. */
static void ws_handle_set_scenes(const cJSON *root, const cJSON *id)
{
    const cJSON *scenes = cJSON_GetObjectItem(root, "scenes");
    if (!cJSON_IsArray(scenes)) {
        ws_ack(id, false, "not_interpreted");
        return;
    }
    char *payload = cJSON_PrintUnformatted((cJSON *)scenes);
    if (!payload) {
        ws_ack(id, false, "no_memory");
        return;
    }
    uint32_t generation = fos_scenes_apply_generation();
    esp_err_t err = fos_scenes_set_json(payload, strlen(payload));
    cJSON_free(payload);
    if (err != ESP_OK) {
        const char *detail = fos_scenes_last_error();
        ws_ack(id, false, (detail && detail[0]) ? detail : "scene_store_failed");
        return;
    }
    /* Optional scene_id names which pushed scene to activate (the workspace's
     * "preview on frame" flow). Queued now, applied by the render task AFTER
     * the payload loads — fos_client.c applies pending scenes before pending
     * selection, so the id exists by then. Unknown ids are dropped there. */
    const cJSON *scene_id = cJSON_GetObjectItem(root, "scene_id");
    if (cJSON_IsString(scene_id) && scene_id->valuestring && scene_id->valuestring[0]) {
        fos_scenes_select(scene_id->valuestring);
    }
    fos_client_render_now();
    ws_ack(id, true, NULL);

    /* scene_ack waits for the render task; see ws_poll_scene_ack(). */
    const cJSON *checksum = cJSON_GetObjectItem(root, "checksum");
    s_scene_ack_checksum[0] = '\0';
    if (cJSON_IsString(checksum) && checksum->valuestring) {
        strlcpy(s_scene_ack_checksum, checksum->valuestring, sizeof(s_scene_ack_checksum));
    }
    s_scene_ack_generation = generation;
    s_scene_ack_deadline_us =
        esp_timer_get_time() + (int64_t)FOS_CLOUD_SCENE_ACK_TIMEOUT_MS * 1000;
    s_scene_ack_pending = true;
}

/* Skip one JSON value starting at *i (which points at its first byte).
 * Purely structural: it never allocates and never reads past `len`. */
static void raw_skip_value(const char *data, size_t len, size_t *i)
{
    if (*i >= len) return;
    char c = data[*i];
    if (c == '"') {
        (*i)++;
        while (*i < len && data[*i] != '"') {
            if (data[*i] == '\\' && *i + 1 < len) (*i)++;
            (*i)++;
        }
        if (*i < len) (*i)++;
        return;
    }
    if (c == '{' || c == '[') {
        int depth = 0;
        bool in_string = false;
        while (*i < len) {
            char k = data[*i];
            if (in_string) {
                if (k == '\\' && *i + 1 < len) (*i)++;
                else if (k == '"') in_string = false;
            } else if (k == '"') {
                in_string = true;
            } else if (k == '{' || k == '[') {
                depth++;
            } else if (k == '}' || k == ']') {
                depth--;
                if (depth == 0) { (*i)++; return; }
            }
            (*i)++;
        }
        return;
    }
    while (*i < len && data[*i] != ',' && data[*i] != '}' && data[*i] != ']') (*i)++;
}

/* Pull the top-level `id` out of a message without building a cJSON tree, so
 * a payload too large or too malformed for cJSON_ParseWithLength() can still
 * be acked as a failure instead of leaving a durable provider command hanging
 * until its timeout. Only depth-1 keys are considered, so an `id` nested
 * inside scene JSON cannot be mistaken for the message id. */
static bool ws_raw_message_id(const char *data, size_t len, char *out, size_t out_len,
                              bool *is_number)
{
    size_t i = 0;
    out[0] = '\0';
    *is_number = false;
    while (i < len && (unsigned char)data[i] <= ' ') i++;
    if (i >= len || data[i] != '{') return false;
    i++;

    while (i < len) {
        while (i < len && ((unsigned char)data[i] <= ' ' || data[i] == ',')) i++;
        if (i >= len || data[i] == '}') return false;
        if (data[i] != '"') return false; /* not an object key: give up */
        size_t key_start = ++i;
        while (i < len && data[i] != '"') {
            if (data[i] == '\\' && i + 1 < len) i++;
            i++;
        }
        if (i >= len) return false;
        size_t key_len = i - key_start;
        i++; /* closing quote */
        while (i < len && (unsigned char)data[i] <= ' ') i++;
        if (i >= len || data[i] != ':') return false;
        i++;
        while (i < len && (unsigned char)data[i] <= ' ') i++;
        if (i >= len) return false;

        if (key_len == 2 && strncmp(data + key_start, "id", 2) == 0) {
            size_t value_start = i;
            raw_skip_value(data, len, &i);
            size_t value_len = i - value_start;
            /* A string id must be quoted at both ends: an unterminated one
             * means the message was truncated, and half an id is not an id. */
            if (value_len >= 2 && data[value_start] == '"' &&
                data[value_start + value_len - 1] == '"') {
                value_start++;
                value_len -= 2; /* ids carry no escapes; reject any that do */
                if (value_len == 0 || value_len >= out_len) return false;
                memcpy(out, data + value_start, value_len);
                out[value_len] = '\0';
                return strchr(out, '\\') == NULL;
            }
            while (value_len > 0 && (unsigned char)data[value_start + value_len - 1] <= ' ') {
                value_len--; /* the number scan stops on the delimiter, not the space */
            }
            if (value_len == 0 || value_len >= out_len) return false;
            for (size_t k = 0; k < value_len; k++) {
                char v = data[value_start + k];
                if (!((v >= '0' && v <= '9') || v == '-' || v == '+' || v == '.' ||
                      v == 'e' || v == 'E')) {
                    return false;
                }
            }
            memcpy(out, data + value_start, value_len);
            out[value_len] = '\0';
            *is_number = true;
            return true;
        }
        raw_skip_value(data, len, &i);
    }
    return false;
}

/* Ack a message we could not parse, so the provider's durable queue moves on. */
static void ws_ack_unparseable(const char *data, size_t len)
{
    char id[80];
    bool is_number = false;
    if (!ws_raw_message_id(data, len, id, sizeof(id), &is_number)) return;
    cJSON *id_item = is_number ? cJSON_CreateNumber(strtod(id, NULL))
                               : cJSON_CreateString(id);
    if (!id_item) return;
    ws_ack(id_item, false, "invalid_json");
    cJSON_Delete(id_item);
}

static void ws_handle_message(const char *data, size_t len)
{
    cJSON *root = cJSON_ParseWithLength(data, len);
    if (!root) {
        ESP_LOGW(TAG, "ws: unparseable message (%u bytes)", (unsigned)len);
        ws_ack_unparseable(data, len);
        return;
    }
    const cJSON *type_item = cJSON_GetObjectItem(root, "type");
    const cJSON *id = cJSON_GetObjectItem(root, "id");
    const char *type = cJSON_IsString(type_item) ? type_item->valuestring : "";

    if (strcmp(type, "challenge") == 0) {
        ws_send_auth(root);
    } else if (strcmp(type, "ready") == 0) {
        s_ws_ready = true;
        s_ws_auth_failures = 0; /* a completed handshake clears the streak */
        ws_backoff_reset();
        ESP_LOGI(TAG, "ws: session ready");
    } else if (strcmp(type, "get_state") == 0) {
        ws_ack(id, true, NULL);
        ws_send_state(id);
    } else if (strcmp(type, "render") == 0) {
        fos_client_render_now();
        ws_ack(id, true, NULL);
    } else if (strcmp(type, "set_current_scene") == 0) {
        char scene_id[128] = "";
        if (json_field_str(root, "scene_id", scene_id, sizeof(scene_id)) &&
            fos_scenes_select(scene_id) == ESP_OK) {
            fos_client_render_now();
            ws_ack(id, true, NULL);
        } else {
            ws_ack(id, false, "unknown_scene");
        }
    } else if (strcmp(type, "set_scenes") == 0) {
        ws_handle_set_scenes(root, id);
    } else if (strcmp(type, "assets_list") == 0) {
        ws_handle_asset_verb(ASSET_JOB_LIST, root, id);
    } else if (strcmp(type, "asset_get") == 0) {
        ws_handle_asset_verb(ASSET_JOB_GET, root, id);
    } else if (strcmp(type, "image_get") == 0) {
        ws_handle_asset_verb(ASSET_JOB_IMAGE, root, id);
    } else if (strcmp(type, "reboot") == 0 || strcmp(type, "restart_runtime") == 0) {
        /* On ESP32 the runtime IS the firmware: restart_runtime == reboot. */
        ws_ack(id, true, NULL);
        ws_schedule_reboot();
    } else if (strcmp(type, "error") == 0 || strcmp(type, "ack") == 0) {
        /* provider-side notices; nothing to do */
    } else if (strcmp(type, "set_schedule") == 0 || strcmp(type, "set_settings") == 0 ||
               strcmp(type, "get_logs") == 0 || strcmp(type, "get_metrics") == 0 ||
               strcmp(type, "notify_update_available") == 0 ||
               strcmp(type, "asset_put") == 0 || strcmp(type, "asset_mkdir") == 0 ||
               strcmp(type, "asset_delete") == 0 || strcmp(type, "asset_rename") == 0) {
        /* Documented verbs the esp32 profile does not implement. Answering
         * `unsupported_verb` (not `unknown_verb`) lets a provider tell "this
         * device profile is smaller" apart from "you sent something that is
         * not in the protocol at all". See docs/cloud-frames.md. */
        ESP_LOGW(TAG, "ws: verb \"%s\" not supported on the esp32 profile", type);
        ws_ack(id, false, "unsupported_verb");
    } else {
        /* Audit-log and refuse everything not in the allowlist. */
        ESP_LOGW(TAG, "ws: refusing verb \"%s\"", type[0] ? type : "(none)");
        ws_ack(id, false, "unknown_verb");
    }
    cJSON_Delete(root);
}

/* Jittered exponential backoff for the redial, as promised by
 * docs/cloud-frames.md. esp_websocket_client owns the retry loop, so the
 * schedule is applied by rewriting its reconnect timeout from the
 * disconnect/error events — the place the component documents for it.
 * The delay is drawn uniformly from [next/2, next], so a fleet that lost the
 * provider at the same moment does not come back in lockstep. */
static void ws_backoff_reset(void)
{
    s_ws_backoff_ms = FOS_CLOUD_WS_BACKOFF_MIN_MS;
    s_ws_backoff_advanced = false;
    if (s_ws_client) {
        esp_websocket_client_set_reconnect_timeout(s_ws_client, (int)s_ws_backoff_ms);
    }
}

/* One failed attempt can raise both ERROR and DISCONNECTED (and a clean close
 * raises CLOSED), so the advance is made idempotent per attempt instead of
 * per event — otherwise the delay would double two or three times per retry. */
static void ws_backoff_advance(void)
{
    if (!s_ws_client || s_ws_backoff_advanced) return;
    s_ws_backoff_advanced = true;
    uint32_t half = s_ws_backoff_ms / 2;
    uint32_t delay_ms = half + (esp_random() % (half + 1));
    esp_websocket_client_set_reconnect_timeout(s_ws_client, (int)delay_ms);
    ESP_LOGI(TAG, "ws: reconnecting in %lu ms", (unsigned long)delay_ms);
    if (s_ws_backoff_ms < FOS_CLOUD_WS_BACKOFF_MAX_MS) {
        s_ws_backoff_ms *= 2;
        if (s_ws_backoff_ms > FOS_CLOUD_WS_BACKOFF_MAX_MS) {
            s_ws_backoff_ms = FOS_CLOUD_WS_BACKOFF_MAX_MS;
        }
    }
}

/* A revoked or unknown frame is rejected the same way every redial, so count
 * the rejections and stop dialling: docs/cloud-frames.md demotes the device to
 * standalone after 3 consecutive authentication rejections. The actual
 * teardown happens on the cloud task (a client cannot be destroyed from its
 * own event handler). */
static void ws_note_auth_rejected(const char *how)
{
    if (s_ws_auth_failures < 0xFF) s_ws_auth_failures++;
    ESP_LOGW(TAG, "ws: authentication rejected (%s), %u of %d", how,
             (unsigned)s_ws_auth_failures, FOS_CLOUD_WS_AUTH_FAILURES_MAX);
    if (s_ws_auth_failures >= FOS_CLOUD_WS_AUTH_FAILURES_MAX) {
        s_ws_demote_pending = true;
    }
}

static void ws_event_handler(void *arg, esp_event_base_t base, int32_t event_id,
                             void *event_data)
{
    (void)arg;
    (void)base;
    esp_websocket_event_data_t *data = (esp_websocket_event_data_t *)event_data;
    switch (event_id) {
        case WEBSOCKET_EVENT_CONNECTED:
            s_ws_ready = false;
            s_ws_backoff_advanced = false; /* a new attempt got this far */
            ESP_LOGI(TAG, "ws: connected, sending hello");
            ws_send_hello();
            break;
        case WEBSOCKET_EVENT_ERROR:
            /* A rejected upgrade never reaches CONNECTED; the bearer token is
             * checked there, so 401/403 is an authentication rejection. */
            if (data && (data->error_handle.esp_ws_handshake_status_code == 401 ||
                         data->error_handle.esp_ws_handshake_status_code == 403)) {
                ws_note_auth_rejected("handshake 401/403");
            }
            ws_backoff_advance();
            break;
        case WEBSOCKET_EVENT_DISCONNECTED:
        case WEBSOCKET_EVENT_CLOSED:
            s_ws_ready = false;
            /* 4401: the provider closed an established socket because the
             * signature failed, the auth timed out, or the frame was revoked. */
            if (data && data->close_status_code == FOS_CLOUD_WS_AUTH_CLOSE_CODE) {
                ws_note_auth_rejected("close 4401");
            }
            ws_backoff_advance();
            /* DISCONNECTED/CLOSED is the last event of an attempt. Re-arm the
             * per-attempt guard HERE, not only on CONNECTED: a transport-level
             * failure never reaches CONNECTED, and with the guard stuck the
             * backoff advanced exactly once and then hammered the provider at
             * the minimum delay forever (observed: a dev frame redialing a
             * dead port every ~3s for half an hour). */
            s_ws_backoff_advanced = false;
            break;
        case WEBSOCKET_EVENT_DATA: {
            if (data->op_code != 0x01 && data->op_code != 0x00) break; /* text only */
            if ((size_t)data->payload_len > FOS_CLOUD_WS_MAX_MSG) {
                ESP_LOGW(TAG, "ws: dropping oversized message (%d bytes)", data->payload_len);
                /* The first fragment still carries the message id, so the
                 * provider's durable command gets a failure instead of
                 * waiting out its timeout. */
                if (data->payload_offset == 0 && data->data_ptr && data->data_len > 0) {
                    char id[80];
                    bool is_number = false;
                    if (ws_raw_message_id(data->data_ptr, (size_t)data->data_len, id,
                                          sizeof(id), &is_number)) {
                        cJSON *id_item = is_number ? cJSON_CreateNumber(strtod(id, NULL))
                                                   : cJSON_CreateString(id);
                        if (id_item) {
                            ws_ack(id_item, false, "message_too_large");
                            cJSON_Delete(id_item);
                        }
                    }
                }
                break;
            }
            /* Reassemble fragmented frames (payload_offset/payload_len). */
            if (data->payload_offset == 0) {
                free(s_ws_rx);
                s_ws_rx = heap_caps_malloc((size_t)data->payload_len + 1,
                                           MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
                if (!s_ws_rx) s_ws_rx = malloc((size_t)data->payload_len + 1);
                s_ws_rx_len = 0;
                if (!s_ws_rx) {
                    ESP_LOGW(TAG, "ws: rx allocation failed (%d bytes)", data->payload_len);
                    break;
                }
            }
            if (!s_ws_rx) break;
            if ((size_t)data->payload_offset + (size_t)data->data_len >
                (size_t)data->payload_len) {
                break;
            }
            memcpy(s_ws_rx + data->payload_offset, data->data_ptr, data->data_len);
            s_ws_rx_len = (size_t)data->payload_offset + (size_t)data->data_len;
            if (s_ws_rx_len == (size_t)data->payload_len) {
                s_ws_rx[s_ws_rx_len] = '\0';
                ws_handle_message(s_ws_rx, s_ws_rx_len);
                free(s_ws_rx);
                s_ws_rx = NULL;
                s_ws_rx_len = 0;
            }
            break;
        }
        default:
            break;
    }
}

/* wss://{provider-host}{ws_path}; ws:// only for the plaintext dev hosts
 * fos_cloud_url_transport_ok() allows, so the bearer token and the whole
 * management session cannot silently go over the open internet in the clear. */
static bool build_ws_uri(void)
{
    const char *why = NULL;
    /* Enrollment's ws_url override wins when present. It was validated once
     * at enrollment, but it also survives reboots in NVS — re-check at every
     * dial so a corrupted or tampered value still cannot carry the bearer
     * token over the open internet in the clear. */
    if (s_ws_url[0]) {
        if (!ws_url_transport_ok(s_ws_url, &why)) {
            ESP_LOGE(TAG, "ws: refusing to dial ws_url: %s", why ? why : "invalid");
            set_last_error("ws_url refused (needs wss)");
            return false;
        }
        strlcpy(s_ws_uri, s_ws_url, sizeof(s_ws_uri));
        return true;
    }
    const fos_config_t *config = fos_config();
    if (!fos_cloud_url_transport_ok(config->cloud_url, &why)) {
        ESP_LOGE(TAG, "ws: refusing to dial cloud_url: %s", why ? why : "invalid");
        set_last_error("cloud_url refused (needs https)");
        return false;
    }
    bool is_https = false;
    char host[FOS_URL_LEN];
    if (!split_scheme_url(config->cloud_url, "https://", "http://", &is_https,
                          host, sizeof(host))) {
        return false;
    }
    /* host keeps its :port; ws_path is absolute so any base path is dropped. */
    snprintf(s_ws_uri, sizeof(s_ws_uri), "%s://%s%s", is_https ? "wss" : "ws", host,
             s_ws_path);
    return true;
}

static void ws_start(void)
{
    if (s_ws_client) return;
    if (!s_access_token[0] || (!s_ws_path[0] && !s_ws_url[0])) return;
    if (!build_ws_uri()) return;
    snprintf(s_ws_headers, sizeof(s_ws_headers), "Authorization: Bearer %s\r\n",
             s_access_token);

    s_ws_backoff_ms = FOS_CLOUD_WS_BACKOFF_MIN_MS;
    esp_websocket_client_config_t config = {
        .uri = s_ws_uri,
        .headers = s_ws_headers,
        .crt_bundle_attach = esp_crt_bundle_attach,
        /* Starting point only: ws_backoff_advance() rewrites this after every
         * failed attempt (jittered exponential, 5 s → 5 min). */
        .reconnect_timeout_ms = FOS_CLOUD_WS_BACKOFF_MIN_MS,
        .network_timeout_ms = 10000,
        .buffer_size = 4096,
        .task_stack = 10240,
    };
    /* The transport layers emit a two-line E-spam for every failed dial; our
     * own "ws: dialing …" / "ws: reconnecting in … ms" lines carry the
     * signal. Beyond noise, a misconfigured dev setup redialing forever
     * floods the USB console — and interleaves into USB-API payloads being
     * read over the same serial stream. */
    esp_log_level_set("transport_ws", ESP_LOG_NONE);
    esp_log_level_set("websocket_client", ESP_LOG_NONE);
    s_ws_client = esp_websocket_client_init(&config);
    if (!s_ws_client) {
        ESP_LOGE(TAG, "ws: client init failed");
        return;
    }
    esp_websocket_register_events(s_ws_client, WEBSOCKET_EVENT_ANY,
                                  ws_event_handler, NULL);
    if (esp_websocket_client_start(s_ws_client) != ESP_OK) {
        ESP_LOGE(TAG, "ws: start failed");
        esp_websocket_client_destroy(s_ws_client);
        s_ws_client = NULL;
        return;
    }
    {
        /* Host elided (it may be a private admin detail); scheme + path only. */
        bool wss = strncmp(s_ws_uri, "wss", 3) == 0;
        const char *dial_path = strchr(s_ws_uri + (wss ? 6 : 5), '/');
        ESP_LOGI(TAG, "ws: dialing %s://…%s", wss ? "wss" : "ws",
                 dial_path ? dial_path : "");
    }
    /* TODO(cloud-frames): ship log batches under telemetry:logs; apply
     * set_settings/set_schedule for the declarative allowlist. */
}

/* Cloud task only: the websocket task must not be torn down from inside its
 * own event handler. */
static void ws_stop(void)
{
    if (!s_ws_client) return;
    esp_websocket_client_stop(s_ws_client);
    esp_websocket_client_destroy(s_ws_client);
    s_ws_client = NULL;
    s_ws_ready = false;
    s_scene_ack_pending = false;
    free(s_ws_rx); /* the ws task is gone; nothing else touches this */
    s_ws_rx = NULL;
    s_ws_rx_len = 0;
}

static bool ws_demote_requested(void) { return s_ws_demote_pending; }

static void ws_clear_demote_request(void)
{
    s_ws_demote_pending = false;
    s_ws_auth_failures = 0;
}

#else /* !FOS_CLOUD_HAVE_WS */

static void ws_start(void)
{
    static bool warned = false;
    if (!warned) {
        warned = true;
        ESP_LOGW(TAG, "esp_websocket_client component not available; "
                      "enrolled but management WS disabled in this build");
    }
}

static void ws_stop(void) {}
static void ws_poll_scene_ack(void) {}
static bool ws_process_asset_jobs(void) { return false; }
static bool ws_demote_requested(void) { return false; }
static void ws_clear_demote_request(void) {}

#endif /* FOS_CLOUD_HAVE_WS */

/* Return to standalone: drop the provider credentials, keep the device key
 * (docs/cloud-frames.md — a revoked frame still needs a fresh claim token to
 * re-enroll) and keep rendering the last pushed scenes. Local admin surfaces
 * are untouched, so this can never lock the owner out of the device. */
static void cloud_demote(const char *reason)
{
    ws_stop();
    nvs_erase_key_quiet("cloud_token");
    nvs_erase_key_quiet("cloud_fid");
    nvs_erase_key_quiet("cloud_ws");
    nvs_erase_key_quiet("cloud_wsurl");
    crypto_wipe(s_access_token, sizeof(s_access_token));
    memset(s_frame_id, 0, sizeof(s_frame_id));
    memset(s_ws_path, 0, sizeof(s_ws_path));
    memset(s_ws_url, 0, sizeof(s_ws_url));
    s_state = FOS_CLOUD_ERROR;
    set_last_error(reason);
    ESP_LOGW(TAG, "cloud link demoted to standalone: %s", reason);
}

/* ------------------------------------------------------------------- task */

static void load_stored_state(void)
{
    const fos_config_t *config = fos_config();
    nvs_load_str("cloud_token", s_access_token, sizeof(s_access_token));
    nvs_load_str("cloud_fid", s_frame_id, sizeof(s_frame_id));
    nvs_load_str("cloud_ws", s_ws_path, sizeof(s_ws_path));
    nvs_load_str("cloud_wsurl", s_ws_url, sizeof(s_ws_url));
    if (s_access_token[0]) {
        s_state = FOS_CLOUD_ENROLLED;
    } else if (config->cloud_url[0] && config->claim_token[0]) {
        s_state = FOS_CLOUD_PENDING;
    } else {
        s_state = FOS_CLOUD_NONE;
    }
    if (s_state != FOS_CLOUD_NONE) {
        ESP_LOGI(TAG, "cloud state at boot: %s", fos_cloud_state_name());
    }
}

static void cloud_task(void *arg)
{
    (void)arg;
    load_stored_state();
    uint32_t backoff_ms = FOS_CLOUD_BACKOFF_MIN_MS;
    bool ws_started = false;

    while (true) {
        if (fos_wifi_state() != FOS_WIFI_CONNECTED) {
            vTaskDelay(pdMS_TO_TICKS(2000));
            continue;
        }

        fos_config_t *config = fos_config();
        if (s_state == FOS_CLOUD_ENROLLED) {
            if (ws_demote_requested()) {
                ws_clear_demote_request();
                cloud_demote("link rejected 3x; returned to standalone");
                ws_started = false;
                continue;
            }
            if (!ws_started) {
                ws_start();
                ws_started = true;
            }
            ws_poll_scene_ack();
            /* Streamed asset replies run here, off the WS task. A 1 s idle
             * tick keeps browse-the-SD latency humane; both polls are cheap
             * flag/queue checks. */
            ws_process_asset_jobs();
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }

        /* A claim token provisioned over USB/portal after boot re-arms the
         * flow, including after a previous permanent error. */
        if (config->cloud_url[0] && config->claim_token[0]) {
            if (s_state != FOS_CLOUD_PENDING) s_state = FOS_CLOUD_PENDING;
            bool permanent = false;
            if (enroll_once(&permanent) == ESP_OK) {
                s_state = FOS_CLOUD_ENROLLED;
                backoff_ms = FOS_CLOUD_BACKOFF_MIN_MS;
                continue;
            }
            if (permanent) {
                s_state = FOS_CLOUD_ERROR;
                backoff_ms = FOS_CLOUD_BACKOFF_MIN_MS;
                continue;
            }
            ESP_LOGI(TAG, "enroll retry in %lu s", (unsigned long)(backoff_ms / 1000));
            vTaskDelay(pdMS_TO_TICKS(backoff_ms));
            backoff_ms *= 2;
            if (backoff_ms > FOS_CLOUD_BACKOFF_MAX_MS) backoff_ms = FOS_CLOUD_BACKOFF_MAX_MS;
            continue;
        }

        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}

esp_err_t fos_cloud_start(void)
{
    if (s_task != NULL) return ESP_OK;
    if (xTaskCreate(cloud_task, "fos_cloud", FOS_CLOUD_TASK_STACK, NULL, 3, &s_task) != pdPASS) {
        s_task = NULL;
        ESP_LOGE(TAG, "cloud task start failed");
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}
