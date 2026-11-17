/*
 * The code editor's host on an ESP32 (docs/code-editor.md): the facts a JS app
 * reads with frameos.code("read"), a scene's JSON text for
 * frameos.code("source"), and the work it asks (frameos/scene_code_hooks.nim;
 * the Code editor sample scene is that app). The Pi's twin is
 * frameos/scene_code_linux.nim; the shape is the scene store's (fos_store.c).
 *
 * - A scene's source is its file in the scene store (fos_scenes_get_json, the
 *   index read under the store lock), the draft the text the plane answered.
 * - `ask` and a save go to the frame's control plane when it has one (`POST
 *   …/panel/code`, the plane fos_store_plane finds): the plane has the AI and
 *   holds the scene list, and the push that follows a save is how the scene
 *   arrives. A frame with no plane saves into its own store (fos_scenes_put)
 *   and has no AI to ask.
 * - Nothing here builds a tree of a scene: a request is the app's arguments
 *   with the action spliced in, an answer is read by its keys
 *   (fos_store_scan.c), and the draft is the answer's own buffer.
 *
 * The app asks on the render task, and nothing here runs there but copying
 * facts out and reading a scene's file. The work runs on the request task
 * (fos_js_io_run), and the scene that asked is drawn again when it is done,
 * if it still shows.
 */
#include "fos_code.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "cJSON.h"
#include "esp_log.h"

#include "fos_backend_http.h"
#include "fos_client.h"
#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_js_io.h"
#include "fos_mem.h"
#include "fos_scene_store.h"
#include "fos_scenes.h"
#include "fos_store.h"
#include "fos_store_scan.h"
#include "fos_wifi.h"

static const char *TAG = "fos_code";

#define ROUTE "/panel/code"
#define ANSWER_MAX (1024 * 1024)
#define ASK_TIMEOUT_MS 180000 /* the plane's AI takes up to two minutes */
#define SAVE_TIMEOUT_MS 30000
#define WORD_LEN 32
#define ID_LEN FOS_SCENE_STORE_ID_LEN

/* One block in PSRAM, made when an app first asks; everything in it is under
 * s_lock. */
typedef struct {
    char busy[WORD_LEN]; /* the action running, "" when none */
    char error[WORD_LEN];
    char done[WORD_LEN];
    char asker[ID_LEN];
    char *args; /* the running action's arguments */
    char *draft; /* the AI's last scene, its JSON text */
    char *draft_id, *draft_name, *summary;
} code_t;

static SemaphoreHandle_t s_lock;
static code_t *S;

static void lock(void) { xSemaphoreTake(s_lock, portMAX_DELAY); }
static void unlock(void) { xSemaphoreGive(s_lock); }

void fos_code_init(void)
{
    if (s_lock == NULL) s_lock = xSemaphoreCreateMutex();
}

/* Under s_lock: the state, made the first time; false without memory. */
static bool ready(void)
{
    if (S == NULL) {
        S = fos_big_malloc(sizeof(code_t));
        if (S != NULL) memset(S, 0, sizeof(code_t));
    }
    return S != NULL;
}

/* Under s_lock. */
static void drop_draft(void)
{
    free(S->draft);
    free(S->draft_id);
    free(S->draft_name);
    free(S->summary);
    S->draft = S->draft_id = S->draft_name = S->summary = NULL;
}

/* `text` copied into a big block; NULL without memory. */
static char *copy_big(const char *text)
{
    size_t n = strlen(text) + 1;
    char *copy = fos_big_malloc(n);
    if (copy != NULL) memcpy(copy, text, n);
    return copy;
}

/* A JSON string's text (a value span as fos_store_find_key gives it),
 * malloc'd; NULL when it is not a string. */
static char *text_of(const char *span, size_t len)
{
    cJSON *value = span ? cJSON_ParseWithLength(span, len) : NULL;
    char *text = cJSON_IsString(value) ? copy_big(value->valuestring) : NULL;
    cJSON_Delete(value);
    return text;
}

static char *key_text(const char *json, size_t len, const char *key)
{
    const char *span = NULL;
    size_t span_len = 0;
    return fos_store_find_key(json, len, key, &span, &span_len) ? text_of(span, span_len) : NULL;
}

/* ------------------------------------------------------------------ reads */

char *fos_code_json(const char *asker)
{
    if (!fos_config_frame_page_offered() || s_lock == NULL) return NULL;
    char *text = NULL;
    lock();
    if (ready()) {
        snprintf(S->asker, sizeof(S->asker), "%s", asker ? asker : "");
        cJSON *facts = cJSON_CreateObject();
        cJSON_AddStringToObject(facts, "busy", S->busy);
        cJSON_AddStringToObject(facts, "error", S->error);
        cJSON_AddStringToObject(facts, "done", S->done);
        if (S->draft != NULL) {
            cJSON *draft = cJSON_AddObjectToObject(facts, "draft");
            cJSON_AddStringToObject(draft, "id", S->draft_id ? S->draft_id : "");
            cJSON_AddStringToObject(draft, "name", S->draft_name ? S->draft_name : "");
            cJSON_AddStringToObject(draft, "summary", S->summary ? S->summary : "");
        } else {
            cJSON_AddNullToObject(facts, "draft");
        }
        /* As fos_store_plane would find one, without copying a token. */
        cJSON_AddBoolToObject(facts, "ask",
                              (fos_config()->backend_url[0] && fos_config()->api_key[0]) ||
                                  fos_cloud_state() != FOS_CLOUD_NONE);
        cJSON_AddBoolToObject(facts, "save", true);
        text = cJSON_PrintUnformatted(facts);
        cJSON_Delete(facts);
    }
    unlock();
    return text;
}

char *fos_code_source(const char *what)
{
    if (what == NULL || !fos_config_frame_page_offered() || s_lock == NULL) return NULL;
    if (strcmp(what, "\x01" "draft") != 0) return fos_scenes_get_json(what, NULL);
    char *text = NULL;
    lock();
    if (S != NULL && S->draft != NULL) text = copy_big(S->draft);
    unlock();
    return text;
}

/* ------------------------------------------------------------------- work */

/* POST the action and the app's arguments to the plane. An error code for the
 * app, NULL when it answered ok; `res` holds the answer either way. */
static const char *post(const char *url, const char *auth, const char *action, const char *args, int timeout_ms,
                        fos_http_response_t *res)
{
    if (fos_wifi_state() != FOS_WIFI_CONNECTED) return "plane_unavailable";
    size_t need = fos_store_with_action(NULL, 0, action, args);
    char *body = need ? fos_big_malloc(need + 1) : NULL;
    if (body == NULL) return need ? "no_room" : "failed";
    fos_store_with_action(body, need + 1, action, args);
    fos_http_request_t req = {
        .url = url, .auth = auth, .body = body, .timeout_ms = timeout_ms, .buffer_size = 4096, .alloc_wait_ms = 5000};
    esp_err_t err = fos_http_fetch(&req, ANSWER_MAX, res);
    free(body);
    if (err != ESP_OK || res->status == 0) return "plane_unavailable";
    const char *span = NULL;
    size_t len = 0;
    size_t body_len = res->body ? res->body_len : 0;
    if (res->status == 200 && fos_store_find_key(res->body, body_len, "ok", &span, &len) && len == 4 &&
        memcmp(span, "true", 4) == 0) {
        return NULL;
    }
    /* The plane's own word, else one for its status: a 404 with no word of
     * the plane's is a plane from before the route. */
    static char refused[WORD_LEN];
    char *code = key_text(res->body, body_len, "error");
    snprintf(refused, sizeof(refused), "%s", code && code[0] ? code
                                             : res->status == 429 ? "rate_limited"
                                             : res->status == 404 ? "plane_update_required"
                                             : res->too_large     ? "no_room"
                                                                  : "plane_unavailable");
    free(code);
    ESP_LOGW(TAG, "%s: %s (%d)", action, refused, res->status);
    return refused;
}

static const char *ask(const char *url, const char *auth, const char *args)
{
    size_t args_len = strlen(args);
    char *prompt = key_text(args, args_len, "prompt");
    bool said = prompt != NULL && prompt[strspn(prompt, " \t\r\n")] != '\0';
    free(prompt);
    if (!said) return "empty_prompt";
    fos_http_response_t res = {0};
    const char *error = post(url, auth, "ask", args, ASK_TIMEOUT_MS, &res);
    const char *scene = NULL;
    size_t len = 0;
    if (error == NULL && (!fos_store_find_key(res.body, res.body_len, "scene", &scene, &len) || scene[0] != '{')) {
        error = "invalid_answer";
    }
    if (error == NULL) {
        char *summary = key_text(res.body, res.body_len, "summary");
        char *id = key_text(scene, len, "id");
        char *name = key_text(scene, len, "name");
        /* The draft is the answer's own buffer, the scene moved to its start. */
        memmove(res.body, scene, len);
        res.body[len] = '\0';
        lock();
        drop_draft();
        S->draft = res.body;
        S->draft_id = id;
        S->draft_name = name;
        S->summary = summary;
        unlock();
        res.body = NULL;
    }
    fos_http_response_free(&res);
    return error;
}

/* What no host saves (docs/code-editor.md), else NULL. `id` gets the scene's
 * id, malloc'd. */
static const char *refusal(const char *scene, size_t len, char **id)
{
    *id = key_text(scene, len, "id");
    if (*id == NULL || !(*id)[0] || strlen(*id) >= ID_LEN || strncmp(*id, "system/", 7) == 0) {
        return "invalid_scene";
    }
    const char *settings = NULL;
    size_t settings_len = 0;
    char *execution = fos_store_find_key(scene, len, "settings", &settings, &settings_len)
                          ? key_text(settings, settings_len, "execution")
                          : NULL;
    bool compiled = execution != NULL && strcmp(execution, "interpreted") != 0;
    free(execution);
    return compiled ? "scene_requires_compilation" : NULL;
}

/* A frame with no plane: into its own store, replacing a scene of that id.
 * Only the frame's default scene keeps a default mark. */
static const char *save_here(char *scene, size_t len, const char *id, bool show)
{
    cJSON *index = fos_scenes_read_index();
    const cJSON *fallback = cJSON_GetObjectItem(index, "default");
    if (!cJSON_IsString(fallback) || strcmp(fallback->valuestring, id) != 0) fos_store_clear_default(scene, len);
    cJSON_Delete(index);
    char put_id[ID_LEN];
    esp_err_t err = fos_scenes_put(scene, len, FOS_SCENES_SOURCE_LOCAL, show, put_id, sizeof(put_id));
    if (err != ESP_OK) return err == ESP_ERR_NO_MEM ? "no_room" : "failed";
    if (show) fos_scenes_select(put_id);
    return NULL;
}

static const char *save(const char *url, const char *auth, bool have_plane, bool backend, char *args)
{
    const char *scene = NULL, *show_span = NULL;
    size_t len = 0, show_len = 0;
    size_t args_len = strlen(args);
    if (!fos_store_find_key(args, args_len, "scene", &scene, &len) || scene[0] != '{') return "invalid_scene";
    char *id = NULL;
    const char *error = refusal(scene, len, &id);
    bool show = !(fos_store_find_key(args, args_len, "show", &show_span, &show_len) && show_len == 5 &&
                  memcmp(show_span, "false", 5) == 0);
    if (error == NULL && have_plane) {
        fos_http_response_t res = {0};
        error = post(url, auth, "save", args, SAVE_TIMEOUT_MS, &res);
        fos_http_response_free(&res);
        /* A backend queued the push for the frame's next pull: pull it now. */
        if (error == NULL && backend) fos_client_request_commands_sync();
    } else if (error == NULL) {
        error = save_here((char *)scene, len, id, show);
    }
    free(id);
    return error;
}

/* On the request task (fos_js_io_run): the action asked for. */
static void code_job(void *arg)
{
    (void)arg;
    char url[FOS_URL_LEN + 64];
    char auth[FOS_STR_LEN + 16];
    char action[WORD_LEN], asker[ID_LEN];
    lock();
    snprintf(action, sizeof(action), "%s", S->busy);
    char *args = S->args;
    S->args = NULL;
    unlock();
    bool backend = false, pending = false;
    bool have_plane = fos_store_plane(ROUTE, url, sizeof(url), auth, sizeof(auth), &backend, &pending);
    const char *error = NULL;
    if (pending) error = "plane_unavailable";
    else if (strcmp(action, "ask") == 0) error = have_plane ? ask(url, auth, args) : "no_plane";
    else error = save(url, auth, have_plane, backend, args);
    free(args);
    lock();
    S->busy[0] = '\0';
    snprintf(S->error, sizeof(S->error), "%s", error ? error : "");
    snprintf(S->done, sizeof(S->done), "%s", error ? "" : action);
    snprintf(asker, sizeof(asker), "%s", S->asker);
    unlock();
    if (fos_scenes_showing(asker)) fos_client_render_now();
}

void fos_code_action(const char *asker, const char *action, const char *args)
{
    if (s_lock == NULL || action == NULL || !fos_config_frame_page_offered()) return;
    bool clear = strcmp(action, "clear") == 0;
    if (!clear && strcmp(action, "ask") != 0 && strcmp(action, "save") != 0) return;
    char *copy = clear ? NULL : copy_big(args ? args : "");
    lock();
    /* One thing at a time: the app says what is running. */
    if (ready() && !S->busy[0]) {
        snprintf(S->asker, sizeof(S->asker), "%s", asker ? asker : "");
        S->error[0] = S->done[0] = '\0';
        if (clear) {
            drop_draft();
        } else if (copy == NULL) {
            snprintf(S->error, sizeof(S->error), "no_room");
        } else {
            snprintf(S->busy, sizeof(S->busy), "%s", action);
            S->args = copy;
            copy = NULL;
            if (!fos_js_io_run(code_job, NULL)) {
                copy = S->args;
                S->args = NULL;
                S->busy[0] = '\0';
                snprintf(S->error, sizeof(S->error), "no_room");
            }
        }
    }
    unlock();
    free(copy);
}
