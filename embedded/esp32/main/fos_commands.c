/* The backend's command queue, pulled and acked over HTTP. See the header. */
#include "fos_commands.h"

#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"

#include "fos_client.h"
#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_json_guard.h"
#include "fos_scenes.h"
#include "fos_settings.h"
#include "fos_wifi.h"
#include "frameos_nim.h"

static const char *TAG = "fos_commands";

/* The queue answer: a handful of small command frames. A scene_event's
 * payload is a few fields; nothing here carries a scene bundle. */
#define FOS_COMMANDS_MAX_BYTES (64 * 1024)
#define FOS_COMMANDS_TIMEOUT_MS 15000
/* A verb arriving holds off deep sleep briefly, as a cloud verb does, so a
 * burst (switch + render) completes before the frame goes dark. */
#define FOS_COMMANDS_KEEP_AWAKE_MS 15000

typedef struct {
    const char *id;
    bool acked;   /* the ack was posted */
    bool applied; /* ...and it said ok */
} reply_ctx_t;

/* One POST of `body` to the queue route `suffix`; the answer (up to `limit`
 * bytes) malloc'd into *out when asked for. Returns the HTTP status, or a
 * negative value when the request never completed. */
static int post_json(const char *suffix, const char *body, size_t limit, char **out)
{
    const fos_config_t *config = fos_config();
    char url[FOS_URL_LEN + 192];
    snprintf(url, sizeof(url), "%s/api/frames/%lu/embedded/commands%s", config->backend_url,
             (unsigned long)config->frame_id, suffix);
    char auth[FOS_STR_LEN + 16];
    snprintf(auth, sizeof(auth), "Bearer %s", config->api_key);
    if (out) *out = NULL;
    esp_http_client_config_t http_config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = FOS_COMMANDS_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 2048,
    };
    esp_http_client_handle_t client = esp_http_client_init(&http_config);
    if (client == NULL) return -1;
    esp_http_client_set_header(client, "Authorization", auth);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    int body_len = (int)strlen(body);
    int status = -1;
    if (esp_http_client_open(client, body_len) == ESP_OK &&
        esp_http_client_write(client, body, body_len) == body_len) {
        int64_t content_length = esp_http_client_fetch_headers(client);
        status = esp_http_client_get_status_code(client);
        if (out && content_length <= (int64_t)limit) {
            size_t cap = content_length > 0 ? (size_t)content_length : limit;
            char *buf = malloc(cap + 1);
            if (buf != NULL) {
                size_t total = 0;
                while (total < cap) {
                    int r = esp_http_client_read(client, buf + total, (int)(cap - total));
                    if (r <= 0) break;
                    total += (size_t)r;
                }
                buf[total] = '\0';
                *out = buf;
            }
        }
        esp_http_client_close(client);
    }
    esp_http_client_cleanup(client);
    return status;
}

/* The ack, with what the frame shows afterwards (the cloud hello's state
 * fields), posted the moment the handler acks — before it goes on to reboot,
 * for the verbs that do. */
static void reply_sink(cJSON *msg, void *arg)
{
    reply_ctx_t *ctx = (reply_ctx_t *)arg;
    const cJSON *type = cJSON_GetObjectItem(msg, "type");
    if (ctx->acked || !cJSON_IsString(type) || strcmp(type->valuestring, "ack") != 0) return;
    bool ok = cJSON_IsTrue(cJSON_GetObjectItem(msg, "ok"));
    cJSON *body = cJSON_CreateObject();
    if (body == NULL) return;
    cJSON_AddBoolToObject(body, "ok", ok);
    const cJSON *error = cJSON_GetObjectItem(msg, "error");
    if (!ok && cJSON_IsString(error)) cJSON_AddStringToObject(body, "error", error->valuestring);
    fos_cloud_add_state_fields(body);
    char *text = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    if (text == NULL) return;
    char suffix[112];
    snprintf(suffix, sizeof(suffix), "/%s/ack", ctx->id);
    int status = post_json(suffix, text, 0, NULL);
    cJSON_free(text);
    if (status < 200 || status >= 300) {
        ESP_LOGW(TAG, "ack of %s not taken (HTTP %d)", ctx->id, status);
        return;
    }
    ctx->acked = true;
    ctx->applied = ok;
}

static bool run_command(cJSON *command)
{
    const cJSON *id = cJSON_GetObjectItem(command, "id");
    const cJSON *type = cJSON_GetObjectItem(command, "type");
    if (!cJSON_IsString(id) || !id->valuestring[0] || strlen(id->valuestring) > 64 ||
        !cJSON_IsString(type)) {
        return false;
    }
    reply_ctx_t ctx = {.id = id->valuestring};
    fos_client_keep_awake_ms(FOS_COMMANDS_KEEP_AWAKE_MS);
    fos_cloud_dispatch_backend_command(command, reply_sink, &ctx);
    if (!ctx.acked) {
        /* A handler that never answered (it should not exist): say so rather
         * than let the backend redeliver forever. */
        char suffix[112];
        snprintf(suffix, sizeof(suffix), "/%s/ack", ctx.id);
        post_json(suffix, "{\"ok\":false,\"error\":\"no_ack\"}", 0, NULL);
    }
    return ctx.applied;
}

static bool sync_pass(bool after_forced_pull);

bool fos_commands_sync(void)
{
    return sync_pass(false);
}

/* One pull of the queue. `after_forced_pull`: this is the second pull of a
 * pass, right after the backend asked for the scenes and settings to be
 * fetched — never a third. */
static bool sync_pass(bool after_forced_pull)
{
    const fos_config_t *config = fos_config();
    if (!config->backend_url[0] || config->frame_id == 0 || !config->api_key[0]) return false;
    if (fos_wifi_state() != FOS_WIFI_CONNECTED) return false;

    cJSON *hello = cJSON_CreateObject();
    if (hello == NULL) return false;
    fos_cloud_add_state_fields(hello);
    const char *settings_etag = fos_settings_etag();
    if (settings_etag[0]) cJSON_AddStringToObject(hello, "settings_etag", settings_etag);
    char *body = cJSON_PrintUnformatted(hello);
    cJSON_Delete(hello);
    if (body == NULL) return false;

    char *answer = NULL;
    int status = post_json("", body, FOS_COMMANDS_MAX_BYTES, &answer);
    cJSON_free(body);
    cJSON *root = NULL;
    /* 404: an older backend without the queue. Nothing to pull, nothing to say. */
    if (status >= 200 && status < 300 && answer != NULL &&
        fos_json_depth_ok(answer, strlen(answer), FOS_JSON_MAX_DEPTH)) {
        root = cJSON_Parse(answer);
    } else if (status != 404) {
        ESP_LOGW(TAG, "commands pull failed (HTTP %d)", status);
    }
    free(answer);
    if (root == NULL) return false;

    cJSON *commands = cJSON_GetObjectItem(root, "commands");
    /* A deploy is waiting that this frame's pulls do not hold yet: fetch
     * them now, whatever the store's own rule (a USB-pushed payload skips the
     * backend pull until a deploy — this is the deploy), and report the new
     * ETags with one more pull so the backend can record it on this wake. */
    bool sync_now = cJSON_IsTrue(cJSON_GetObjectItem(root, "sync")) && !after_forced_pull;
    int count = cJSON_IsArray(commands) ? cJSON_GetArraySize(commands) : 0;
    int applied = 0;
    if (count > 0) {
        cJSON *command = NULL;
        cJSON_ArrayForEach(command, commands) {
            if (cJSON_IsObject(command) && run_command(command)) applied++;
        }
        char line[128];
        snprintf(line, sizeof(line),
                 "{\"event\":\"commands:sync\",\"source\":\"esp32\",\"received\":%d,\"applied\":%d}",
                 count, applied);
        frameos_nim_log_hook(line);
    }
    cJSON_Delete(root);
    if (sync_now) {
        fos_client_keep_awake_ms(FOS_COMMANDS_KEEP_AWAKE_MS);
        fos_scenes_sync(true);
        fos_scenes_apply_pending();
        fos_settings_sync(true);
        if (sync_pass(true)) applied++;
    }
    return applied > 0;
}
