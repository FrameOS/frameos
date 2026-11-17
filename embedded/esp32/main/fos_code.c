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
 *   as they come (the prelude puts the action in them), an answer is read by
 *   its keys (fos_store_scan.c), the draft is the answer's own buffer and
 *   its id, name and summary are the answer's own JSON values.
 * - What the app and the plane already check (an empty request, a scene id,
 *   a compiled scene) is not checked again here: flash is the budget. A frame
 *   with no plane refuses a built-in scene's id, which only it would take.
 *
 * The app asks on the render task, and nothing here runs there but copying
 * facts out and reading a scene's file. The work runs on the request task
 * (fos_js_io_run), and the scene that asked is drawn again when it is done,
 * if it still shows.
 */
#include "fos_code.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

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

#define ANSWER_MAX (1024 * 1024)
#define WORD_LEN 32
#define ID_LEN FOS_SCENE_STORE_ID_LEN

/* One block in PSRAM, made when an app first asks; everything in it is under
 * s_lock. */
typedef struct {
    char busy[WORD_LEN]; /* the action running, "" when none */
    char error[WORD_LEN];
    char done[WORD_LEN];
    char asker[ID_LEN];
    char *args;  /* the running action's arguments */
    char *draft; /* the AI's last scene, its JSON text */
    char *about; /* {"id","name","summary"} of the draft, JSON text */
} code_t;

static SemaphoreHandle_t s_lock;
static code_t *S;

static void lock(void) { xSemaphoreTake(s_lock, portMAX_DELAY); }
static void unlock(void) { xSemaphoreGive(s_lock); }

void fos_code_init(void)
{
    if (s_lock == NULL) s_lock = xSemaphoreCreateMutex();
}

/* `text` copied into a big block; NULL without memory. */
static char *copy_big(const char *text)
{
    size_t n = strlen(text) + 1;
    char *copy = fos_big_malloc(n);
    if (copy != NULL) memcpy(copy, text, n);
    return copy;
}

/* A key's value as it is in `json` (a string with its quotes), or "\"\"". */
static int value_of(const char *json, size_t len, const char *key, const char **value)
{
    size_t n = 0;
    if (!fos_store_find_key(json, len, key, value, &n)) {
        *value = "\"\"";
        n = 2;
    }
    return (int)n;
}

/* ------------------------------------------------------------------- work */

/* POST the app's arguments (the action in them) to the plane. NULL when it
 * answered with no error, else the app's word for what went wrong, in
 * `refused`; `res` holds the answer either way. */
static const char *post(const char *url, const char *auth, const char *args, int timeout_ms,
                        fos_http_response_t *res, char *refused)
{
    if (fos_wifi_state() != FOS_WIFI_CONNECTED) return "plane_unavailable";
    fos_http_request_t req = {
        .url = url, .auth = auth, .body = args, .timeout_ms = timeout_ms, .buffer_size = 4096, .alloc_wait_ms = 5000};
    esp_err_t err = fos_http_fetch(&req, ANSWER_MAX, res);
    if (err != ESP_OK || res->status == 0) return "plane_unavailable";
    const char *span = NULL;
    size_t len = 0;
    bool said = fos_store_find_key(res->body, res->body ? res->body_len : 0, "error", &span, &len);
    if (res->status == 200 && !said) return NULL;
    /* The plane's own word (its letters alone), else one for its status: a
     * 404 with no word of the plane's is a plane from before the route. */
    size_t n = 0;
    for (size_t i = 0; said && i < len && n < WORD_LEN - 1; i++) {
        if (isalnum((unsigned char)span[i]) || span[i] == '_') refused[n++] = span[i];
    }
    refused[n] = '\0';
    if (n == 0) {
        snprintf(refused, WORD_LEN, "%s", res->status == 429 ? "rate_limited"
                                          : res->status == 404 ? "plane_update_required"
                                          : res->too_large     ? "no_room"
                                                               : "plane_unavailable");
    }
    ESP_LOGW(TAG, "%s (%d)", refused, res->status);
    return refused;
}

static const char *ask(const char *url, const char *auth, const char *args, char *refused)
{
    fos_http_response_t res = {0};
    const char *error = post(url, auth, args, 180000, &res, refused);
    const char *scene = NULL;
    size_t len = 0;
    if (error == NULL && (!fos_store_find_key(res.body, res.body_len, "scene", &scene, &len) || scene[0] != '{')) {
        error = "invalid_answer";
    }
    char *about = NULL;
    if (error == NULL) {
        const char *id, *name, *summary;
        int id_len = value_of(scene, len, "id", &id);
        int name_len = value_of(scene, len, "name", &name);
        int summary_len = value_of(res.body, res.body_len, "summary", &summary);
        size_t n = (size_t)(id_len + name_len + summary_len) + 32;
        about = fos_big_malloc(n);
        if (about == NULL) error = "no_room";
        else snprintf(about, n, "{\"id\":%.*s,\"name\":%.*s,\"summary\":%.*s}", id_len, id, name_len, name, summary_len, summary);
    }
    if (error == NULL) {
        /* The draft is the answer's own buffer, the scene moved to its start. */
        memmove(res.body, scene, len);
        res.body[len] = '\0';
        lock();
        free(S->draft);
        free(S->about);
        S->draft = res.body;
        S->about = about;
        unlock();
        res.body = NULL;
    }
    fos_http_response_free(&res);
    return error;
}

static const char *save(const char *url, const char *auth, bool have_plane, bool backend, char *args,
                        char *refused)
{
    if (have_plane) {
        fos_http_response_t res = {0};
        const char *error = post(url, auth, args, 30000, &res, refused);
        fos_http_response_free(&res);
        /* A backend queued the push for the frame's next pull: pull it now. */
        if (error == NULL && backend) fos_client_request_commands_sync();
        return error;
    }
    /* A frame with no plane: into its own store, replacing a scene of that id
     * (the app takes the default mark off a scene that is new). */
    const char *scene = NULL, *span = NULL;
    size_t len = 0, span_len = 0;
    size_t args_len = strlen(args);
    if (!fos_store_find_key(args, args_len, "scene", &scene, &len) || scene[0] != '{') return "invalid_scene";
    if (fos_store_find_key(scene, len, "id", &span, &span_len) && strncmp(span, "\"system/", 8) == 0) {
        return "invalid_scene";
    }
    bool show = !(fos_store_find_key(args, args_len, "show", &span, &span_len) && span[0] == 'f');
    char put_id[ID_LEN];
    esp_err_t err = fos_scenes_put(scene, len, FOS_SCENES_SOURCE_LOCAL, show, put_id, sizeof(put_id));
    if (err != ESP_OK) return err == ESP_ERR_NO_MEM ? "no_room" : "invalid_scene";
    if (show) fos_scenes_select(put_id);
    return NULL;
}

/* On the request task (fos_js_io_run): the action asked for. */
static void code_job(void *arg)
{
    (void)arg;
    char url[FOS_URL_LEN + 64];
    char auth[FOS_STR_LEN + 16];
    char action[WORD_LEN], asker[ID_LEN], refused[WORD_LEN];
    lock();
    snprintf(action, sizeof(action), "%s", S->busy);
    char *args = S->args;
    S->args = NULL;
    unlock();
    bool backend = false, pending = false;
    bool have_plane = fos_store_plane("/panel/code", url, sizeof(url), auth, sizeof(auth), &backend, &pending);
    const char *error = pending          ? "plane_unavailable"
                        : action[0] != 'a' ? save(url, auth, have_plane, backend, args, refused)
                        : have_plane       ? ask(url, auth, args, refused)
                                           : "no_plane";
    free(args);
    lock();
    S->busy[0] = '\0';
    snprintf(S->error, sizeof(S->error), "%s", error ? error : "");
    snprintf(S->done, sizeof(S->done), "%s", error ? "" : action);
    snprintf(asker, sizeof(asker), "%s", S->asker);
    unlock();
    if (fos_scenes_showing(asker)) fos_client_render_now();
}

/* Under s_lock, S made: the facts as JSON text. */
static char *facts(void)
{
    /* As fos_store_plane would find one, without copying a token. */
    bool ask = (fos_config()->backend_url[0] && fos_config()->api_key[0]) || fos_cloud_state() != FOS_CLOUD_NONE;
    const char *about = S->about ? S->about : "null";
    size_t n = strlen(about) + 3 * WORD_LEN + 80;
    char *text = malloc(n);
    if (text != NULL) {
        snprintf(text, n, "{\"busy\":\"%s\",\"error\":\"%s\",\"done\":\"%s\",\"draft\":%s,\"ask\":%s,\"save\":true}",
                 S->busy, S->error, S->done, about, ask ? "true" : "false");
    }
    return text;
}

/* Under s_lock, S made, nothing running: `op` (ask, save) started with the
 * request body `copy`, which it then owns; else its error set. */
static void start(const char *op, char *copy)
{
    if (copy == NULL) {
        snprintf(S->error, sizeof(S->error), "no_room");
        return;
    }
    snprintf(S->busy, sizeof(S->busy), "%s", op);
    S->args = copy;
    if (!fos_js_io_run(code_job, NULL)) {
        free(S->args);
        S->args = NULL;
        S->busy[0] = '\0';
        snprintf(S->error, sizeof(S->error), "no_room");
    }
}

char *fos_code(const char *asker, const char *op, const char *arg)
{
    if (s_lock == NULL || op == NULL) return NULL;
    bool read = strcmp(op, "read") == 0;
    if (!fos_config_frame_page_offered()) return read ? NULL : strdup("!settings on the frame's screen are off");
    if (strcmp(op, "source") == 0) return arg ? fos_scenes_get_json(arg, NULL) : NULL;
    bool act = strcmp(op, "ask") == 0 || strcmp(op, "save") == 0;
    /* A request body is copied before the lock: it can be a whole scene. */
    char *copy = act ? copy_big(arg ? arg : "") : NULL;
    char *answer = NULL;
    lock();
    if (S == NULL && (S = fos_big_malloc(sizeof(code_t))) != NULL) memset(S, 0, sizeof(code_t));
    if (S != NULL) {
        snprintf(S->asker, sizeof(S->asker), "%s", asker ? asker : "");
        if (read) {
            answer = facts();
        } else if (strcmp(op, "draft") == 0) {
            answer = S->draft ? copy_big(S->draft) : NULL;
        } else if (!S->busy[0]) {
            /* One thing at a time: the app says what is running. Anything
             * else (clear, or an operation this host does not know) only
             * forgets the draft and the last word. */
            S->error[0] = S->done[0] = '\0';
            if (act) {
                start(op, copy);
                copy = NULL;
            } else if (strcmp(op, "clear") == 0) {
                free(S->draft);
                free(S->about);
                S->draft = S->about = NULL;
            }
        }
        if (!read && answer == NULL && strcmp(op, "draft") != 0) answer = strdup("true");
    }
    unlock();
    free(copy);
    return answer;
}
