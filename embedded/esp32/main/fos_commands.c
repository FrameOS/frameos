/* The backend's command queue, pulled and acked over HTTP. See the header. */
#include "fos_commands.h"

#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_log.h"

#include "fos_animation.h"
#include "fos_backend_http.h"
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
    char url[FOS_URL_LEN + 192];
    char path[160];
    snprintf(path, sizeof(path), "/embedded/commands%s", suffix);
    fos_backend_url(path, url, sizeof(url));
    char auth[FOS_STR_LEN + 16];
    fos_backend_auth(auth, sizeof(auth));
    fos_http_request_t request = {.url = url, .auth = auth, .body = body};
    fos_http_response_t response;
    if (out) *out = NULL;
    if (fos_http_fetch(&request, out ? limit : 0, &response) != ESP_OK) return -1;
    if (out) {
        *out = response.body; /* ours now */
    } else {
        fos_http_response_free(&response);
    }
    return response.status;
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

/* A pulled answer, as it goes from the task that pulled it to the render
 * task that runs it. */
typedef struct {
    cJSON *root;
    /* The pull that reports a sync's ETags: its own `sync` is not made. */
    bool reporting;
    /* Its sync was fetched with the pull, on the task that pulled it
     * (fos_sync_fetch_with_pull): what that brought, for the render task to
     * take before the commands. `scenes` NULL: unchanged (a 304) or the fetch
     * failed (logged); `settings` NULL likewise. */
    bool fetched;
    fos_scene_set_t *scenes;
    char scenes_etag[FOS_SCENES_ETAG_LEN];
    fos_settings_fetched_t *settings;
} answer_t;

static bool sync_pass(bool after_forced_pull);
static bool run_answer(answer_t *answer);

bool fos_commands_sync(void)
{
    return sync_pass(false);
}

/* The hello and the queue's answer, parsed; NULL without a backend, Wi-Fi or
 * an answer. The backend marks what it hands over `sent`, and hands it over
 * again only after a while (an at-most-once verb never), so whoever pulls
 * runs what came back. */
static cJSON *pull(void)
{
    const fos_config_t *config = fos_config();
    if (!config->backend_url[0] || config->frame_id == 0 || !config->api_key[0]) return NULL;
    if (fos_wifi_state() != FOS_WIFI_CONNECTED) return NULL;

    cJSON *hello = cJSON_CreateObject();
    if (hello == NULL) return NULL;
    fos_cloud_add_state_fields(hello);
    /* Where it is now, for a frame that joined another network on its own
     * screen and so said no bootup (app/utils/embedded_report.py). */
    if (fos_wifi_ip()[0]) cJSON_AddStringToObject(hello, "ip", fos_wifi_ip());
    const char *settings_etag = fos_settings_etag();
    if (settings_etag[0]) cJSON_AddStringToObject(hello, "settings_etag", settings_etag);
    /* What /state holds (fos_cloud.c reports the same in `hardware.storage`). */
    fos_scenes_add_storage_json(cJSON_AddObjectToObject(hello, "storage"));
    char *body = cJSON_PrintUnformatted(hello);
    cJSON_Delete(hello);
    if (body == NULL) return NULL;

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
    return root;
}

static bool answer_sync(const cJSON *root)
{
    return cJSON_IsTrue(cJSON_GetObjectItem(root, "sync"));
}

/* Whether an answer holds anything to run: commands, or a sync to make. */
static bool answer_has_work(const cJSON *root, bool reporting)
{
    const cJSON *commands = cJSON_GetObjectItem(root, "commands");
    return (answer_sync(root) && !reporting) || (cJSON_IsArray(commands) && cJSON_GetArraySize(commands) > 0);
}

/* What an answer holds, let go of; the struct itself is the caller's. The
 * set and the settings are taken by run_answer before the commands, so they
 * are only here when a fetch brought them and the plan took nothing (it
 * cannot: fetched means sync and not reporting). */
static void answer_release(answer_t *answer)
{
    cJSON_Delete(answer->root);
    answer->root = NULL;
    if (answer->scenes) fos_scenes_take_backend_payload(answer->scenes, answer->scenes_etag);
    answer->scenes = NULL;
    if (answer->settings) fos_settings_fetched_free(answer->settings);
    answer->settings = NULL;
}

void *fos_commands_fetch(bool reporting)
{
    cJSON *root = pull();
    if (root == NULL) return NULL;
    if (!answer_has_work(root, reporting)) {
        cJSON_Delete(root);
        return NULL;
    }
    answer_t *answer = calloc(1, sizeof(*answer));
    if (answer == NULL) {
        /* Its commands are `sent` now: the backend hands them over again in
         * a few minutes. */
        ESP_LOGW(TAG, "no memory for a commands answer");
        cJSON_Delete(root);
        return NULL;
    }
    answer->root = root;
    answer->reporting = reporting;
    if (fos_sync_fetch_with_pull(answer_sync(root), reporting)) {
        /* A deploy is waiting that this frame's pulls do not hold yet: fetched
         * here, whatever the store's own rule (a USB-pushed payload skips the
         * backend pull until a deploy: this is the deploy), and the render
         * task gets the answer only with its set. It goes on drawing and
         * taking taps meanwhile: done on the render task, a 35-scene 1.48 MB
         * deploy froze a reTerminal Sticky for 42 s and dropped 33 taps
         * (2026-11-23). A set the link task's poll fetched and the render task
         * has not taken yet is what this fetch names (fos_scenes.c
         * s_fetched_etag), so it brings what changed since that one. */
        fos_client_keep_awake_ms(FOS_COMMANDS_KEEP_AWAKE_MS);
        answer->fetched = true;
        answer->scenes = fos_scenes_backend_fetch(true, answer->scenes_etag, sizeof(answer->scenes_etag), NULL);
        answer->settings = fos_settings_fetch(true);
    }
    return answer;
}

bool fos_commands_answer_fetched(const void *answer)
{
    return answer != NULL && ((const answer_t *)answer)->fetched;
}

bool fos_commands_run(void *answer)
{
    if (answer == NULL) return false;
    bool applied = run_answer((answer_t *)answer);
    free(answer);
    return applied;
}

/* One pull of the queue, on the render task. `after_forced_pull`: this is
 * the pull that reports, right after the backend asked for the scenes and
 * settings to be fetched: never a third. */
static bool sync_pass(bool after_forced_pull)
{
    cJSON *root = pull();
    if (root == NULL) return false;
    answer_t answer = {.root = root, .reporting = after_forced_pull};
    return run_answer(&answer);
}

/* What a pull answered, run on the render task; lets go of what `answer`
 * holds (answer_release), not of `answer`. */
static bool run_answer(answer_t *answer)
{
    cJSON *root = answer->root;
    cJSON *commands = cJSON_GetObjectItem(root, "commands");
    /* A deploy is waiting that this frame's pulls do not hold yet: its set
     * goes in BEFORE the commands. A switch queued behind a scenes push (the
     * editor's preview, the voice chat's show_image) names a scene this frame
     * does not hold until then: run first, it failed with apply-failed and
     * the old scene rendered (E1002, 2026-10-24). Then the ETags of what was
     * taken go back with one more pull, so the backend records the deploy on
     * this wake. */
    fos_sync_plan_t plan = fos_sync_plan(answer_sync(root), answer->reporting, answer->fetched, fos_client_link_on());
    int count = cJSON_IsArray(commands) ? cJSON_GetArraySize(commands) : 0;
    if (plan.fetch_here || plan.take_fetched) fos_client_keep_awake_ms(FOS_COMMANDS_KEEP_AWAKE_MS);
    if (plan.fetch_here) {
        /* Nobody fetched it (a frame about to deep-sleep, the voice relay's
         * pull here): on this task, now. The set the link task fetched,
         * before and after a sync that names it (it waits out a fetch in
         * flight): a 304, not the set again. */
        fos_client_take_link_payload();
        fos_scenes_sync(true);
        fos_client_take_link_payload();
        fos_scenes_apply_pending();
        fos_settings_sync(true);
    } else if (plan.take_fetched) {
        /* Fetched with the pull. A set the link task's poll fetched before
         * it goes first: the pull's fetch named that one, so what it brought
         * is the change from it. The link task polls no scenes or settings
         * until this answer has run (fos_client.c s_link_sync_running). */
        fos_client_take_link_payload();
        if (answer->scenes) fos_scenes_take_backend_payload(answer->scenes, answer->scenes_etag);
        answer->scenes = NULL;
        fos_scenes_apply_pending();
        fos_client_take_link_settings();
        if (answer->settings) fos_settings_apply(answer->settings);
        answer->settings = NULL;
    }
    int applied = 0;
    if (count > 0) {
        cJSON *command = NULL;
        cJSON_ArrayForEach(command, commands) {
            if (cJSON_IsObject(command) && run_command(command)) applied++;
            /* A switch takes effect before the next command: a state for
             * the new scene (the voice chat's activate_scene, then
             * set_scene_state) reaches that scene, not the one before. On
             * the render task, so the load may run here. */
            if (frameos_nim_available()) fos_scenes_apply_pending_selection();
        }
        char line[128];
        snprintf(line, sizeof(line),
                 "{\"event\":\"commands:sync\",\"source\":\"esp32\",\"received\":%d,\"applied\":%d}",
                 count, applied);
        frameos_nim_log_hook(line);
    }
    answer_release(answer);
    /* The ETags of what was just taken go back with one more pull, so the
     * backend records the deploy on this wake: the link task's while it has
     * the round trips, this task's before a sleep. */
    if (plan.report_here && sync_pass(true)) applied++;
    if (plan.report_on_link) fos_client_request_report_pull();
    return applied > 0;
}
