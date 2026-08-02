#include "fos_cloud.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_system.h"
#include "mbedtls/base64.h"
#include "monocypher.h"
#include "monocypher-ed25519.h"
#include "nvs.h"

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
#define FOS_CLOUD_WS_MAX_MSG (512 * 1024)
#define FOS_CLOUD_NONCE_MAX 256

static fos_cloud_state_t s_state = FOS_CLOUD_NONE;
static char s_last_error[96] = "";
static char s_access_token[FOS_CLOUD_TOKEN_LEN] = "";
static char s_frame_id[FOS_CLOUD_FRAME_ID_LEN] = "";
static char s_ws_path[FOS_CLOUD_WS_PATH_LEN] = "";
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

/* Copy a string-or-number JSON field. */
static bool json_field_str(const cJSON *root, const char *key, char *out, size_t out_len)
{
    const cJSON *item = cJSON_GetObjectItem(root, key);
    if (cJSON_IsString(item) && item->valuestring) {
        strlcpy(out, item->valuestring, out_len);
        return out[0] != '\0';
    }
    if (cJSON_IsNumber(item)) {
        snprintf(out, out_len, "%.0f", item->valuedouble);
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
        char token[FOS_CLOUD_TOKEN_LEN];
        char frame_id[FOS_CLOUD_FRAME_ID_LEN];
        char ws_path[FOS_CLOUD_WS_PATH_LEN];
        bool ok = json_field_str(json, "access_token", token, sizeof(token));
        json_field_str(json, "frame_id", frame_id, sizeof(frame_id));
        if (!json_field_str(json, "ws_path", ws_path, sizeof(ws_path))) {
            strlcpy(ws_path, "/api/frames/ws", sizeof(ws_path));
        }
        cJSON_Delete(json);
        if (!ok) {
            set_last_error("enroll response missing access_token");
            return ESP_FAIL;
        }
        if (nvs_store_str("cloud_token", token) != ESP_OK ||
            nvs_store_str("cloud_fid", frame_id) != ESP_OK ||
            nvs_store_str("cloud_ws", ws_path) != ESP_OK) {
            set_last_error("nvs write failed");
            return ESP_FAIL;
        }
        strlcpy(s_access_token, token, sizeof(s_access_token));
        strlcpy(s_frame_id, frame_id, sizeof(s_frame_id));
        strlcpy(s_ws_path, ws_path, sizeof(s_ws_path));
        erase_claim_token();
        set_last_error("");
        ESP_LOGI(TAG, "enrolled: frame_id=%s ws_path=%s (claim token erased)",
                 s_frame_id[0] ? s_frame_id : "?", s_ws_path);
        return ESP_OK;
    }

    /* Claim tokens are single use, success or failure: any 400 means this
     * token is dead (invalid/expired/used/bad key) and retrying cannot help. */
    if (status == 400) {
        char reason[48] = "rejected";
        cJSON *json = cJSON_Parse(response);
        if (json) {
            json_field_str(json, "error", reason, sizeof(reason));
            cJSON_Delete(json);
        }
        char detail[sizeof(s_last_error)];
        snprintf(detail, sizeof(detail), "enroll rejected: %s", reason);
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

/* set_scenes: same code path as the USB `usb_api upload-scenes` command —
 * fos_http_store_uploaded_scenes_payload persists the interpreted-scene JSON
 * and the render task hot-loads it (compiled payloads are refused by the
 * interpreted runtime loader). */
static void ws_handle_set_scenes(const cJSON *root, const cJSON *id)
{
    const cJSON *scenes = cJSON_GetObjectItem(root, "scenes");
    if (!cJSON_IsArray(scenes)) {
        ws_ack(id, false, "not_interpreted");
        return;
    }
    char *payload = cJSON_PrintUnformatted((cJSON *)root);
    if (!payload) {
        ws_ack(id, false, "no_memory");
        return;
    }
    esp_err_t err = fos_http_store_uploaded_scenes_payload(payload, strlen(payload));
    cJSON_free(payload);
    if (err != ESP_OK) {
        const char *detail = fos_scenes_last_error();
        ws_ack(id, false, (detail && detail[0]) ? detail : "scene_store_failed");
        return;
    }
    fos_client_render_now();
    ws_ack(id, true, NULL);

    /* TODO: strictly, scene_ack should fire after the render task applied the
     * payload; for now report the received checksum immediately. */
    const cJSON *checksum = cJSON_GetObjectItem(root, "checksum");
    cJSON *msg = cJSON_CreateObject();
    if (msg) {
        cJSON_AddStringToObject(msg, "type", "scene_ack");
        if (cJSON_IsString(checksum)) {
            cJSON_AddStringToObject(msg, "checksum", checksum->valuestring);
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
}

static void ws_handle_message(const char *data, size_t len)
{
    cJSON *root = cJSON_ParseWithLength(data, len);
    if (!root) {
        ESP_LOGW(TAG, "ws: unparseable message (%u bytes)", (unsigned)len);
        return;
    }
    const cJSON *type_item = cJSON_GetObjectItem(root, "type");
    const cJSON *id = cJSON_GetObjectItem(root, "id");
    const char *type = cJSON_IsString(type_item) ? type_item->valuestring : "";

    if (strcmp(type, "challenge") == 0) {
        ws_send_auth(root);
    } else if (strcmp(type, "ready") == 0) {
        s_ws_ready = true;
        ESP_LOGI(TAG, "ws: session ready");
    } else if (strcmp(type, "get_state") == 0) {
        ws_ack(id, true, NULL);
        ws_send_state(id);
    } else if (strcmp(type, "render") == 0) {
        fos_client_render_now();
        ws_ack(id, true, NULL);
    } else if (strcmp(type, "set_current_scene") == 0) {
        char scene_id[128];
        if (json_field_str(root, "scene_id", scene_id, sizeof(scene_id)) &&
            fos_scenes_select(scene_id) == ESP_OK) {
            fos_client_render_now();
            ws_ack(id, true, NULL);
        } else {
            ws_ack(id, false, "unknown_scene");
        }
    } else if (strcmp(type, "set_scenes") == 0) {
        ws_handle_set_scenes(root, id);
    } else if (strcmp(type, "reboot") == 0 || strcmp(type, "restart_runtime") == 0) {
        /* On ESP32 the runtime IS the firmware: restart_runtime == reboot. */
        ws_ack(id, true, NULL);
        ws_schedule_reboot();
    } else if (strcmp(type, "error") == 0 || strcmp(type, "ack") == 0) {
        /* provider-side notices; nothing to do */
    } else {
        /* Audit-log and refuse everything not in the allowlist — including
         * set_schedule / set_settings / get_logs / get_metrics /
         * notify_update_available, which are TODO for the esp32 profile. */
        ESP_LOGW(TAG, "ws: refusing verb \"%s\"", type[0] ? type : "(none)");
        ws_ack(id, false, "unknown_verb");
    }
    cJSON_Delete(root);
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
            ESP_LOGI(TAG, "ws: connected, sending hello");
            ws_send_hello();
            break;
        case WEBSOCKET_EVENT_DISCONNECTED:
        case WEBSOCKET_EVENT_CLOSED:
            s_ws_ready = false;
            break;
        case WEBSOCKET_EVENT_DATA: {
            if (data->op_code != 0x01 && data->op_code != 0x00) break; /* text only */
            if ((size_t)data->payload_len > FOS_CLOUD_WS_MAX_MSG) {
                ESP_LOGW(TAG, "ws: dropping oversized message (%d bytes)", data->payload_len);
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

/* wss://{provider-host}{ws_path}; ws:// only for http:// dev providers. */
static bool build_ws_uri(void)
{
    const fos_config_t *config = fos_config();
    const char *url = config->cloud_url;
    const char *scheme = "wss";
    const char *rest = url;
    if (strncmp(url, "https://", 8) == 0) {
        rest = url + 8;
    } else if (strncmp(url, "http://", 7) == 0) {
        scheme = "ws";
        rest = url + 7;
    } else {
        ESP_LOGW(TAG, "cloud_url has no scheme: %s", url);
        return false;
    }
    char host[FOS_URL_LEN];
    strlcpy(host, rest, sizeof(host));
    char *slash = strchr(host, '/');
    if (slash) *slash = '\0'; /* ws_path is absolute; drop any base path */
    if (!host[0]) return false;
    snprintf(s_ws_uri, sizeof(s_ws_uri), "%s://%s%s", scheme, host, s_ws_path);
    return true;
}

static void ws_start(void)
{
    if (s_ws_client) return;
    if (!s_access_token[0] || !s_ws_path[0]) return;
    if (!build_ws_uri()) return;
    snprintf(s_ws_headers, sizeof(s_ws_headers), "Authorization: Bearer %s\r\n",
             s_access_token);

    esp_websocket_client_config_t config = {
        .uri = s_ws_uri,
        .headers = s_ws_headers,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .reconnect_timeout_ms = 10000,
        .network_timeout_ms = 10000,
        .buffer_size = 4096,
        .task_stack = 10240,
    };
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
    ESP_LOGI(TAG, "ws: dialing %s://…%s", strncmp(s_ws_uri, "wss", 3) == 0 ? "wss" : "ws",
             s_ws_path);
    /* TODO(cloud-frames): demote to standalone on persistent 401
     * invalid_link_token; ship log batches under telemetry:logs; apply
     * set_settings/set_schedule for the declarative allowlist. */
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

#endif /* FOS_CLOUD_HAVE_WS */

/* ------------------------------------------------------------------- task */

static void load_stored_state(void)
{
    const fos_config_t *config = fos_config();
    nvs_load_str("cloud_token", s_access_token, sizeof(s_access_token));
    nvs_load_str("cloud_fid", s_frame_id, sizeof(s_frame_id));
    nvs_load_str("cloud_ws", s_ws_path, sizeof(s_ws_path));
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
            if (!ws_started) {
                ws_start();
                ws_started = true;
            }
            vTaskDelay(pdMS_TO_TICKS(5000));
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
