/* The backend's command queue, pulled and acked over HTTP. See the header. */
#include "fos_commands.h"

#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_app_desc.h"
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
/* How long the hello waits for the Nim runtime's scene snapshot (the same
 * bound the cloud hello uses); busy means the fields are left out. */
#define FOS_COMMANDS_NIM_WAIT_MS 250

typedef struct {
    char id[80];
    cJSON *state;      /* a `state` reply the handler made before its ack */
    bool acked;        /* the ack was posted */
    bool applied;      /* ...and it said ok */
} reply_ctx_t;

static bool backend_configured(const fos_config_t *config)
{
    return config->backend_url[0] && config->frame_id != 0 && config->api_key[0];
}

/* One POST of `body`, the answer (up to `limit` bytes) malloc'd into *out
 * (NULL when there was none). Returns the HTTP status, or a negative value
 * when the request never completed. */
static int post_json(const char *url, const char *auth, const char *body, size_t limit, char **out)
{
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
    size_t body_len = body ? strlen(body) : 0;
    esp_err_t err = esp_http_client_open(client, (int)body_len);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "connect failed: %s", esp_err_to_name(err));
        esp_http_client_cleanup(client);
        return -1;
    }
    if (body_len > 0 && esp_http_client_write(client, body, (int)body_len) != (int)body_len) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return -1;
    }
    int64_t content_length = esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);
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
    esp_http_client_cleanup(client);
    return status;
}

/* The scene the frame shows and its public state, when the runtime answers
 * in time: the same fields the cloud hello carries. */
static void add_snapshot_fields(cJSON *msg)
{
    const char *info = NULL;
    const char *state = NULL;
    if (!frameos_nim_available()) return;
    if (!frameos_nim_scene_snapshot_wait(FOS_COMMANDS_NIM_WAIT_MS, &info, &state)) return;
    cJSON *info_json = info && info[0] ? cJSON_Parse(info) : NULL;
    if (info_json) {
        const cJSON *current = cJSON_GetObjectItem(info_json, "currentSceneId");
        if (cJSON_IsString(current) && current->valuestring && current->valuestring[0]) {
            cJSON_AddStringToObject(msg, "active_scene", current->valuestring);
        }
        cJSON_Delete(info_json);
    }
    cJSON *states = state && state[0] ? cJSON_Parse(state) : NULL;
    if (states) {
        if (cJSON_IsObject(states)) {
            cJSON_AddItemToObject(msg, "states", states);
        } else {
            cJSON_Delete(states);
        }
    }
}

static void backend_url(const fos_config_t *config, const char *suffix, char *out, size_t out_len)
{
    snprintf(out, out_len, "%s/api/frames/%lu/embedded/commands%s", config->backend_url,
             (unsigned long)config->frame_id, suffix);
}

static void post_ack(reply_ctx_t *ctx, bool ok, const char *error)
{
    const fos_config_t *config = fos_config();
    cJSON *body = cJSON_CreateObject();
    if (body == NULL) return;
    cJSON_AddBoolToObject(body, "ok", ok);
    if (!ok && error) cJSON_AddStringToObject(body, "error", error);
    if (ctx->state != NULL) {
        /* The handler's own `state` reply (get_state) says what the frame
         * shows; move its fields over rather than asking the runtime again. */
        cJSON *active = cJSON_DetachItemFromObject(ctx->state, "active_scene");
        cJSON *states = cJSON_DetachItemFromObject(ctx->state, "states");
        if (active) cJSON_AddItemToObject(body, "active_scene", active);
        if (states) cJSON_AddItemToObject(body, "states", states);
    } else {
        add_snapshot_fields(body);
    }
    char *text = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    if (text == NULL) return;
    char suffix[112];
    snprintf(suffix, sizeof(suffix), "/%s/ack", ctx->id);
    char url[FOS_URL_LEN + 192];
    backend_url(config, suffix, url, sizeof(url));
    char auth[FOS_STR_LEN + 16];
    snprintf(auth, sizeof(auth), "Bearer %s", config->api_key);
    int status = post_json(url, auth, text, 1024, NULL);
    cJSON_free(text);
    if (status < 200 || status >= 300) {
        ESP_LOGW(TAG, "ack of %s not taken (HTTP %d)", ctx->id, status);
        return;
    }
    ctx->acked = true;
    ctx->applied = ok;
}

/* Every reply a verb handler makes while a backend command runs. The ack is
 * posted the moment it is made — before the handler goes on to reboot, for
 * the verbs that do. */
static void reply_sink(cJSON *msg, void *arg)
{
    reply_ctx_t *ctx = (reply_ctx_t *)arg;
    const cJSON *type = cJSON_GetObjectItem(msg, "type");
    const char *kind = cJSON_IsString(type) && type->valuestring ? type->valuestring : "";
    if (strcmp(kind, "state") == 0) {
        cJSON_Delete(ctx->state);
        ctx->state = cJSON_Duplicate(msg, 1);
        return;
    }
    if (strcmp(kind, "ack") != 0) return; /* log_batch, metrics: not carried */
    if (ctx->acked) return;               /* a handler answering twice */
    const cJSON *ok = cJSON_GetObjectItem(msg, "ok");
    const cJSON *error = cJSON_GetObjectItem(msg, "error");
    post_ack(ctx, cJSON_IsTrue(ok),
             cJSON_IsString(error) && error->valuestring ? error->valuestring : NULL);
}

static bool run_command(cJSON *command)
{
    const cJSON *id = cJSON_GetObjectItem(command, "id");
    const cJSON *type = cJSON_GetObjectItem(command, "type");
    if (!cJSON_IsString(id) || !id->valuestring || !id->valuestring[0] ||
        !cJSON_IsString(type) || !type->valuestring) {
        ESP_LOGW(TAG, "command without id or type; skipped");
        return false;
    }
    reply_ctx_t ctx = {0};
    if (strlen(id->valuestring) >= sizeof(ctx.id)) {
        ESP_LOGW(TAG, "command id too long; skipped");
        return false;
    }
    strcpy(ctx.id, id->valuestring);
    fos_client_keep_awake_ms(FOS_COMMANDS_KEEP_AWAKE_MS);
    fos_cloud_dispatch_backend_command(command, reply_sink, &ctx);
    if (!ctx.acked) {
        /* A handler that never answered (it should not exist): say so rather
         * than let the backend redeliver forever. */
        post_ack(&ctx, false, "no_ack");
    }
    cJSON_Delete(ctx.state);
    char line[256];
    snprintf(line, sizeof(line),
             "{\"event\":\"command:%s\",\"source\":\"esp32\",\"type\":\"%.32s\",\"id\":\"%.40s\"}",
             ctx.applied ? "applied" : "refused", type->valuestring, ctx.id);
    frameos_nim_log_hook(line);
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
    if (!backend_configured(config)) return false;
    if (fos_wifi_state() != FOS_WIFI_CONNECTED) return false;

    cJSON *hello = cJSON_CreateObject();
    if (hello == NULL) return false;
    cJSON_AddStringToObject(hello, "frameos_version", esp_app_get_description()->version);
    const char *scenes_etag = fos_scenes_etag();
    if (scenes_etag && scenes_etag[0]) cJSON_AddStringToObject(hello, "scenes_etag", scenes_etag);
    const char *settings_etag = fos_settings_etag();
    if (settings_etag && settings_etag[0]) cJSON_AddStringToObject(hello, "settings_etag", settings_etag);
    add_snapshot_fields(hello);
    char *body = cJSON_PrintUnformatted(hello);
    cJSON_Delete(hello);
    if (body == NULL) return false;

    char url[FOS_URL_LEN + 128];
    backend_url(config, "", url, sizeof(url));
    char auth[FOS_STR_LEN + 16];
    snprintf(auth, sizeof(auth), "Bearer %s", config->api_key);
    char *answer = NULL;
    int status = post_json(url, auth, body, FOS_COMMANDS_MAX_BYTES, &answer);
    cJSON_free(body);
    if (status == 404) {
        /* An older backend without the queue: nothing to pull, nothing to say. */
        free(answer);
        return false;
    }
    if (status < 200 || status >= 300 || answer == NULL) {
        ESP_LOGW(TAG, "commands pull failed (HTTP %d)", status);
        free(answer);
        return false;
    }
    if (!fos_json_depth_ok(answer, strlen(answer), FOS_JSON_MAX_DEPTH)) {
        ESP_LOGW(TAG, "commands answer nests too deep; dropped");
        free(answer);
        return false;
    }
    cJSON *root = cJSON_Parse(answer);
    free(answer);
    if (root == NULL) {
        ESP_LOGW(TAG, "commands answer unparseable");
        return false;
    }
    cJSON *commands = cJSON_GetObjectItem(root, "commands");
    const cJSON *pending = cJSON_GetObjectItem(root, "pending");
    /* A deploy is waiting that this frame's pulls do not hold yet: fetch
     * them now, whatever the store's own rule (a USB-pushed payload skips the
     * backend pull until a deploy — this is the deploy), and report the new
     * ETags with one more pull so the backend can record it on this wake. */
    bool sync_now = cJSON_IsTrue(cJSON_GetObjectItem(root, "sync")) && !after_forced_pull;
    int count = cJSON_IsArray(commands) ? cJSON_GetArraySize(commands) : 0;
    int applied = 0;
    if (count > 0) {
        char line[160];
        snprintf(line, sizeof(line),
                 "{\"event\":\"commands:sync\",\"source\":\"esp32\",\"received\":%d,\"pending\":%d}",
                 count, cJSON_IsNumber(pending) ? (int)pending->valuedouble : count);
        frameos_nim_log_hook(line);
        cJSON *command = NULL;
        cJSON_ArrayForEach(command, commands) {
            if (!cJSON_IsObject(command)) continue;
            if (run_command(command)) applied++;
        }
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
