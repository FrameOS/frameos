/*
 * The scene store's host on an ESP32 (docs/scene-store.md): the facts a JS
 * app reads with frameos.store() and the work it asks with
 * frameos.storeAction() (frameos/scene_store_hooks.nim; the Scene store
 * sample scene is that app). The app has the words; this file has the facts.
 *
 * The app asks on the render task (embedded_runtime.nim), and nothing here
 * runs there but copying facts out: every request goes to a task of its own,
 * made for the work and gone when it is done, and the scene that asked is
 * drawn again when the work is done, if it still shows (fos_scenes_showing).
 *
 * - Browsing is the cloud store's listing for frames
 *   (/api/store/device/scenes, with the query string the app hands over),
 *   asked of the cloud this frame knows, else cloud.frameos.net. Its answer
 *   is kept as it came and handed on whole.
 * - Install, update, remove, preview and discard are asked of the frame's
 *   control plane when it has one (`POST …/panel/scenes`, a backend first, as
 *   for the voice chat): the plane holds the scene list, and a scene added
 *   here alone would go at its next push. The push that follows is how the
 *   scene arrives. A frame with no plane does it itself: the store's
 *   scenes.json is split into its scenes, one file each (fos_scenes_put).
 * - What came from the store is read off each scene's file once (its
 *   `origin`), kept by the content hash the index has for it.
 */
#include "fos_store.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_log.h"

#include "fos_backend_http.h"
#include "fos_client.h"
#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_mem.h"
#include "fos_scene_store.h"
#include "fos_scenes.h"
#include "fos_store_scan.h"
#include "fos_wifi.h"

static const char *TAG = "fos_store";

#define DEFAULT_STORE_URL "https://cloud.frameos.net"
#define LISTING_MAX (32 * 1024)
#define ANSWER_MAX 2048
/* A store scene's scenes.json: its scenes, each no more than a slot holds. */
#define SCENES_MAX (2 * FOS_SCENE_STORE_MAX_BYTES)
#define SPLIT_MAX 8
#define TASK_STACK 8192
#define STORE_ID_LEN 40
#define SCENE_ID_LEN FOS_SCENE_STORE_ID_LEN
#define WORD_LEN 24
#define NAME_LEN 96
#define PARAMS_LEN 400 /* scene_store_hooks.nim validStoreParams */

typedef struct {
    char id[SCENE_ID_LEN];
    double hash;
    char store[STORE_ID_LEN];
    int v;
} origin_t;

/* What the app is shown and the work asked for: one block in PSRAM, made when
 * an app first asks (a board that never runs the store, the C3's thin client,
 * spends nothing), not internal RAM, which TLS needs. Everything in it is under
 * s_lock. */
typedef struct {
    char busy[WORD_LEN];
    char error[WORD_LEN];
    char done[WORD_LEN];
    char params[PARAMS_LEN]; /* what `listing` answers */
    char *listing;           /* the store's answer as it came, or NULL */
    char asker[SCENE_ID_LEN]; /* the scene to draw again on news */
    char preview_store[STORE_ID_LEN]; /* "" when nothing is previewed */
    char preview_id[SCENE_ID_LEN];
    char preview_name[NAME_LEN];
    char preview_from[SCENE_ID_LEN];
    origin_t origins[FOS_SCENE_STORE_SLOTS];
    int origin_count;
    uint32_t origins_generation;
    /* The work asked for, until the task takes it. */
    char job[WORD_LEN];
    char job_store[STORE_ID_LEN];
    char job_id[SCENE_ID_LEN];
    char job_name[NAME_LEN];
    char job_from[SCENE_ID_LEN];
    char job_params[PARAMS_LEN];
    bool job_show;
} store_t;

static SemaphoreHandle_t s_lock;
static bool s_running;
static store_t *S;

static void lock(void) { xSemaphoreTake(s_lock, portMAX_DELAY); }
static void unlock(void) { xSemaphoreGive(s_lock); }

void fos_store_init(void)
{
    if (s_lock == NULL) s_lock = xSemaphoreCreateMutex();
}

/* Under s_lock: the state, made the first time; false without memory. */
static bool ready(void)
{
    if (S == NULL) {
        S = fos_big_malloc(sizeof(store_t));
        if (S == NULL) return false;
        memset(S, 0, sizeof(store_t));
        S->origins_generation = UINT32_MAX;
    }
    return true;
}

/* ------------------------------------------------------------------ facts */

typedef struct {
    char *buf;
    size_t len, cap;
} out_t;

static void put(out_t *out, const char *text)
{
    size_t n = strlen(text);
    if (out->buf != NULL && out->len + n < out->cap) {
        memcpy(out->buf + out->len, text, n + 1);
        out->len += n;
    }
}

static void put_string(out_t *out, const char *text)
{
    char one[8];
    put(out, "\"");
    for (const unsigned char *c = (const unsigned char *)text; *c; c++) {
        if (*c == '"' || *c == '\\') snprintf(one, sizeof(one), "\\%c", *c);
        else if (*c < 0x20) snprintf(one, sizeof(one), "\\u%04x", *c);
        else snprintf(one, sizeof(one), "%c", *c);
        put(out, one);
    }
    put(out, "\"");
}

/* `"key":"text",` */
static void put_pair(out_t *out, const char *key, const char *text)
{
    put(out, "\"");
    put(out, key);
    put(out, "\":");
    put_string(out, text);
    put(out, ",");
}

static void start_job(const char *job);

static void store_base(char *out, size_t len);

char *fos_store_json(const char *asker)
{
    if (!fos_config_frame_page_offered() || s_lock == NULL) return NULL;
    lock();
    if (!ready()) {
        unlock();
        return NULL;
    }
    snprintf(S->asker, sizeof(S->asker), "%s", asker ? asker : "");
    /* What came from the store is read again once the scenes changed, off
     * this task. */
    if (S->origins_generation != fos_scenes_store_generation() && !s_running && !S->job[0]) start_job("scan");
    out_t out = {.cap = 1536 + (S->listing ? strlen(S->listing) : 0) +
                        (size_t)S->origin_count * (SCENE_ID_LEN + STORE_ID_LEN + 32)};
    out.buf = fos_big_malloc(out.cap);
    if (out.buf != NULL) {
        out.buf[0] = '\0';
        char line[48];
        put(&out, "{");
        put_pair(&out, "busy", S->busy);
        put_pair(&out, "error", S->error);
        put_pair(&out, "done", S->done);
        put_pair(&out, "params", S->params);
        char base[FOS_URL_LEN];
        store_base(base, sizeof(base));
        put_pair(&out, "url", base);
        put_pair(&out, "version", esp_app_get_description()->version);
        const fos_config_t *config = fos_config();
        snprintf(line, sizeof(line), "\"removeAny\":%s,\"listing\":",
                 config->backend_url[0] || fos_cloud_state() != FOS_CLOUD_NONE ? "false" : "true");
        put(&out, line);
        put(&out, S->listing ? S->listing : "null");
        put(&out, ",\"installed\":[");
        for (int i = 0; i < S->origin_count; i++) {
            put(&out, i ? ",{" : "{");
            put_pair(&out, "id", S->origins[i].id);
            put_pair(&out, "store", S->origins[i].store);
            snprintf(line, sizeof(line), "\"v\":%d}", S->origins[i].v);
            put(&out, line);
        }
        put(&out, "],\"preview\":");
        if (S->preview_store[0]) {
            put(&out, "{");
            put_pair(&out, "store", S->preview_store);
            put_pair(&out, "id", S->preview_id);
            put(&out, "\"name\":");
            put_string(&out, S->preview_name);
            put(&out, "}");
        } else {
            put(&out, "null");
        }
        put(&out, "}");
    }
    unlock();
    return out.buf;
}

/* ----------------------------------------------------------------- actions */

static void copy_arg(const cJSON *args, const char *key, char *out, size_t len)
{
    const cJSON *value = cJSON_GetObjectItem(args, key);
    if (cJSON_IsString(value)) snprintf(out, len, "%s", value->valuestring);
}

/* A listing's query string as the app may hand it over (the same rule as
 * scene_store_hooks.nim validStoreParams): nothing that leaves a query. */
static bool valid_params(const char *params)
{
    if (strlen(params) >= PARAMS_LEN) return false;
    for (const char *c = params; *c; c++) {
        if (!isalnum((unsigned char)*c) && !strchr("-_.~%&=+,", *c)) return false;
    }
    return true;
}

void fos_store_action(const char *asker, const char *action, const char *args_json)
{
    if (s_lock == NULL || action == NULL) return;
    cJSON *args = cJSON_Parse(args_json ? args_json : "{}");
    static const char *const known[] = {"browse", "preview", "install", "update", "remove", "discard"};
    bool ok = false;
    for (size_t i = 0; i < sizeof(known) / sizeof(known[0]); i++) ok = ok || strcmp(action, known[i]) == 0;
    lock();
    /* One thing at a time: the app says what is running. (A re-read of what
     * came from the store does not count: it runs after.) */
    if (ok && ready() && !S->busy[0]) {
        snprintf(S->asker, sizeof(S->asker), "%s", asker ? asker : "");
        S->job_store[0] = S->job_id[0] = S->job_name[0] = S->job_params[0] = '\0';
        copy_arg(args, "store", S->job_store, sizeof(S->job_store));
        copy_arg(args, "id", S->job_id, sizeof(S->job_id));
        copy_arg(args, "name", S->job_name, sizeof(S->job_name));
        copy_arg(args, "params", S->job_params, sizeof(S->job_params));
        /* A preview goes back to the scene it was opened from. */
        snprintf(S->job_from, sizeof(S->job_from), "%s", S->asker);
        S->job_show = !cJSON_IsFalse(cJSON_GetObjectItem(args, "show"));
        if (strcmp(action, "browse") != 0 || valid_params(S->job_params)) {
            snprintf(S->busy, sizeof(S->busy), "%s", action);
            S->error[0] = S->done[0] = '\0';
            start_job(action);
        }
    }
    unlock();
    cJSON_Delete(args);
}

/* ------------------------------------------------------------------- work */

/* The base the store is asked at: the cloud this frame knows, else ours. */
static void store_base(char *out, size_t len)
{
    const char *url = fos_config()->cloud_url;
    snprintf(out, len, "%s", url[0] ? url : DEFAULT_STORE_URL);
    size_t n = strlen(out);
    while (n > 0 && out[n - 1] == '/') out[--n] = '\0';
}

static void add_encoded(char *out, size_t len, const char *text)
{
    size_t n = strlen(out);
    for (const unsigned char *c = (const unsigned char *)text; *c && n + 4 < len; c++) {
        if (isalnum(*c) || *c == '-' || *c == '_' || *c == '.' || *c == '~') out[n++] = (char)*c;
        else n += (size_t)snprintf(out + n, len - n, "%%%02X", *c);
    }
    out[n] = '\0';
}

/* GET `url` into `*body` (malloc'd, valid JSON when `json`). An error code
 * for the page, NULL on success. */
static const char *fetch(const char *url, size_t max, bool json, char **body, size_t *len)
{
    *body = NULL;
    if (fos_wifi_state() != FOS_WIFI_CONNECTED) return "offline";
    fos_http_request_t req = {.url = url, .timeout_ms = 20000, .buffer_size = 4096};
    fos_http_response_t res = {0};
    esp_err_t err = fos_http_fetch(&req, max, &res);
    const char *error = NULL;
    if (err != ESP_OK || res.status == 0) error = "store_unavailable";
    else if (res.status == 404) error = "invalid_scene";
    else if (res.status == 429) error = "rate_limited";
    else if (res.status != 200 || res.body == NULL || res.too_large) error = res.too_large ? "no_room" : "store_unavailable";
    else if (json) {
        cJSON *check = cJSON_ParseWithLength(res.body, res.body_len);
        if (check == NULL) error = "store_unavailable";
        cJSON_Delete(check);
    }
    if (error == NULL) {
        *body = res.body;
        if (len != NULL) *len = res.body_len;
        res.body = NULL;
    } else {
        ESP_LOGW(TAG, "%s: %s (%d)", url, error, res.status);
    }
    fos_http_response_free(&res);
    return error;
}

/* The frame's control plane: a backend first, else the cloud it is enrolled
 * with (as the voice chat's upload_target). False for a frame with none;
 * `*pending` when it belongs to a cloud it cannot reach yet. */
static bool plane(char *url, size_t len, char *auth, size_t auth_len, bool *backend, bool *pending)
{
    *backend = fos_backend_url("/panel/scenes", url, len) && fos_config()->api_key[0];
    *pending = false;
    if (*backend) {
        fos_backend_auth(auth, auth_len);
        return true;
    }
    char cloud[FOS_URL_LEN];
    char frame_id[FOS_STR_LEN];
    if (fos_cloud_api_access(cloud, sizeof(cloud), frame_id, sizeof(frame_id), auth, auth_len)) {
        snprintf(url, len, "%s/api/frames/%s/panel/scenes", cloud, frame_id);
        return true;
    }
    *pending = fos_config()->cloud_url[0] && fos_cloud_state() != FOS_CLOUD_NONE;
    return *pending;
}

/* Ask the plane. An error code for the page, NULL when it took it;
 * `status` gets its "status" (queued, up_to_date) and `scene_id` the
 * runtime id a preview shows. */
static const char *ask_plane(const char *url, const char *auth, bool backend, const char *action, const char *scene_id,
                             bool show, char *status, size_t status_len, char *shown, size_t shown_len)
{
    if (fos_wifi_state() != FOS_WIFI_CONNECTED) return "offline";
    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "action", action);
    cJSON_AddStringToObject(body, "scene_id", scene_id);
    cJSON_AddBoolToObject(body, "show", show);
    char *text = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    if (text == NULL) return "no_room";
    fos_http_request_t req = {.url = url, .auth = auth, .body = text, .timeout_ms = 30000};
    fos_http_response_t res = {0};
    esp_err_t err = fos_http_fetch(&req, ANSWER_MAX, &res);
    cJSON_free(text);
    static char refused[WORD_LEN];
    const char *error = err != ESP_OK || res.status == 0 ? "store_unavailable" : NULL;
    cJSON *answer = res.body ? cJSON_ParseWithLength(res.body, res.body_len) : NULL;
    if (error == NULL && res.status != 200) {
        const cJSON *code = cJSON_GetObjectItem(answer, "error");
        snprintf(refused, sizeof(refused), "%s", cJSON_IsString(code) ? code->valuestring
                                                 : res.status == 429 ? "rate_limited" : "store_unavailable");
        error = refused;
    }
    copy_arg(answer, "status", status, status_len);
    copy_arg(answer, "scene_id", shown, shown_len);
    cJSON_Delete(answer);
    fos_http_response_free(&res);
    /* A backend queued what it did for the frame's next pull: pull it now. */
    if (error == NULL && backend) fos_client_request_commands_sync();
    return error;
}

/* The scenes on the frame that came from the store, read again. A scene whose
 * content is what was read last time is not opened. */
static bool scan_origins(void)
{
    bool changed = false;
    uint32_t generation = fos_scenes_store_generation();
    cJSON *index = fos_scenes_read_index();
    origin_t *found = fos_big_malloc(sizeof(origin_t) * FOS_SCENE_STORE_SLOTS);
    /* Zeroed: the rows are compared whole with the last read's. */
    if (found != NULL) memset(found, 0, sizeof(origin_t) * FOS_SCENE_STORE_SLOTS);
    int count = 0;
    const cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, cJSON_GetObjectItem(index, "scenes")) {
        const cJSON *id = cJSON_GetObjectItem(entry, "id");
        const cJSON *hash = cJSON_GetObjectItem(entry, "hash");
        if (found == NULL || count >= FOS_SCENE_STORE_SLOTS || !cJSON_IsString(id)) continue;
        origin_t *row = &found[count];
        snprintf(row->id, sizeof(row->id), "%s", id->valuestring);
        row->hash = cJSON_IsNumber(hash) ? hash->valuedouble : -1;
        row->store[0] = '\0';
        lock();
        for (int i = 0; i < S->origin_count; i++) {
            if (row->hash >= 0 && S->origins[i].hash == row->hash && strcmp(S->origins[i].id, row->id) == 0) {
                *row = S->origins[i];
            }
        }
        unlock();
        if (!row->store[0]) {
            char *json = fos_scenes_get_json(row->id, NULL);
            fos_store_read_origin(json, row->store, sizeof(row->store), &row->v);
            free(json);
        }
        if (row->store[0]) count++;
    }
    cJSON_Delete(index);
    lock();
    if (found != NULL) {
        changed = count != S->origin_count || memcmp(S->origins, found, sizeof(origin_t) * (size_t)count) != 0;
        memcpy(S->origins, found, sizeof(origin_t) * (size_t)count);
        S->origin_count = count;
    }
    S->origins_generation = generation;
    unlock();
    free(found);
    return changed;
}

/* A frame with no control plane installs a store scene itself: its
 * scenes.json split into one file a scene, the first shown when `show`. */
static const char *install_here(const char *store, bool show, char *first, size_t first_len)
{
    char url[FOS_URL_LEN + 96];
    store_base(url, sizeof(url));
    snprintf(url + strlen(url), sizeof(url) - strlen(url), "/api/store/scenes/%s/scenes.json", store);
    char *body = NULL;
    size_t len = 0;
    const char *error = fetch(url, SCENES_MAX, false, &body, &len);
    const char *starts[SPLIT_MAX];
    size_t lens[SPLIT_MAX];
    int count = error ? 0 : fos_store_split_scenes(body, len, starts, lens, SPLIT_MAX);
    if (error == NULL && count <= 0) error = "store_unavailable";
    first[0] = '\0';
    for (int i = 0; i < count && error == NULL; i++) {
        char id[SCENE_ID_LEN];
        /* The frame's default stays the owner's. */
        fos_store_clear_default((char *)starts[i], lens[i]);
        esp_err_t err = fos_scenes_put(starts[i], lens[i], FOS_SCENES_SOURCE_LOCAL, show, id, sizeof(id));
        if (err != ESP_OK) error = err == ESP_ERR_NO_MEM ? "no_room" : "store_unavailable";
        else if (!first[0]) snprintf(first, first_len, "%s", id);
    }
    free(body);
    if (error == NULL && show && first[0]) fos_scenes_select(first);
    return error;
}

/* Every scene on the frame from store scene `store`, removed. */
static const char *remove_here(const char *store, const char *id)
{
    const char *error = NULL;
    lock();
    int count = S->origin_count;
    origin_t *rows = fos_big_malloc(sizeof(origin_t) * (size_t)(count + 1));
    if (rows != NULL) memcpy(rows, S->origins, sizeof(origin_t) * (size_t)count);
    unlock();
    if (rows == NULL) return "no_room";
    int removed = 0;
    for (int i = 0; i < count && error == NULL; i++) {
        if (store[0] && strcmp(rows[i].store, store) == 0) {
            if (fos_scenes_delete(rows[i].id, FOS_SCENES_SOURCE_LOCAL) != ESP_OK) error = "last_scene";
            else removed++;
        }
    }
    /* Not from the store: the scene alone. */
    if (error == NULL && removed == 0 && id[0] && fos_scenes_delete(id, FOS_SCENES_SOURCE_LOCAL) != ESP_OK) {
        error = "last_scene";
    }
    free(rows);
    return error;
}

static void run(const char *job)
{
    char url[FOS_URL_LEN + PARAMS_LEN + 160];
    char auth[FOS_STR_LEN + 16];
    const char *error = NULL;
    const char *done = job;
    lock();
    char store[STORE_ID_LEN], id[SCENE_ID_LEN], name[NAME_LEN], from[SCENE_ID_LEN], asker[SCENE_ID_LEN];
    snprintf(store, sizeof(store), "%s", S->job_store);
    snprintf(id, sizeof(id), "%s", S->job_id);
    snprintf(name, sizeof(name), "%s", S->job_name);
    snprintf(from, sizeof(from), "%s", S->job_from);
    bool show = S->job_show;
    char *params = fos_big_malloc(PARAMS_LEN);
    if (params != NULL) snprintf(params, PARAMS_LEN, "%s", S->job_params);
    if (strcmp(job, "discard") == 0) snprintf(from, sizeof(from), "%s", S->preview_from);
    bool stale = S->origins_generation != fos_scenes_store_generation();
    unlock();
    /* A scene on the frame names its store scene by its id: read off the
     * scenes as they are now (a push may have landed since the last read). */
    bool changed = false;
    if (!store[0] && id[0]) {
        if (stale) changed = scan_origins();
        lock();
        for (int i = 0; !store[0] && i < S->origin_count; i++) {
            if (strcmp(S->origins[i].id, id) == 0) snprintf(store, sizeof(store), "%s", S->origins[i].store);
        }
        unlock();
    }

    if (strcmp(job, "browse") == 0) {
        char *body = NULL;
        store_base(url, sizeof(url));
        size_t n = strlen(url);
        snprintf(url + n, sizeof(url) - n, "/api/store/device/scenes?version=%s%s%s", esp_app_get_description()->version,
                 params && params[0] ? "&" : "", params ? params : "");
        error = params == NULL ? "no_room" : fetch(url, LISTING_MAX, true, &body, NULL);
        lock();
        if (body != NULL) {
            free(S->listing);
            S->listing = body;
            body = NULL;
            snprintf(S->params, sizeof(S->params), "%s", params);
        }
        unlock();
        free(body);
        done = "";
    } else if (strcmp(job, "scan") != 0) {
        bool backend = false, pending = false;
        char status[WORD_LEN] = "", shown[SCENE_ID_LEN] = "";
        if (plane(url, sizeof(url), auth, sizeof(auth), &backend, &pending)) {
            /* The plane's: what it holds is the store scene's (a preview's
             * Discard goes back to the scene it covered). */
            error = pending ? "offline"
                            : ask_plane(url, auth, backend, job, strcmp(job, "discard") == 0 ? from : store, show,
                                        status, sizeof(status), shown, sizeof(shown));
            if (strcmp(status, "up_to_date") == 0) done = "uptodate";
        } else if (strcmp(job, "remove") == 0) {
            error = remove_here(store, id);
        } else if (strcmp(job, "discard") == 0) {
            lock();
            snprintf(store, sizeof(store), "%s", S->preview_store);
            unlock();
            error = remove_here(store, "");
            if (error == NULL && from[0]) fos_scenes_select(from);
        } else {
            /* install, update, preview: the newest version, written here. */
            error = install_here(store, strcmp(job, "preview") == 0 || (show && strcmp(job, "install") == 0), shown,
                                 sizeof(shown));
        }
        lock();
        if (error == NULL) {
            if (strcmp(job, "preview") == 0) {
                snprintf(S->preview_store, sizeof(S->preview_store), "%s", store);
                snprintf(S->preview_id, sizeof(S->preview_id), "%s", shown);
                snprintf(S->preview_name, sizeof(S->preview_name), "%s", name);
                snprintf(S->preview_from, sizeof(S->preview_from), "%s", from);
            } else if (strcmp(job, "discard") == 0 || strcmp(S->preview_store, store) == 0) {
                S->preview_store[0] = '\0';
            }
        }
        unlock();
    }
    bool scan = strcmp(job, "scan") == 0;
    if (scan || fos_scenes_store_generation() != S->origins_generation) changed = scan_origins() || changed;
    lock();
    /* A re-read is nobody's: what the page says, and a tap waiting behind
     * it, stay as they are. */
    if (!scan) {
        S->busy[0] = '\0';
        snprintf(S->error, sizeof(S->error), "%s", error ? error : "");
        snprintf(S->done, sizeof(S->done), "%s", error ? "" : done);
    }
    snprintf(asker, sizeof(asker), "%s", S->asker);
    unlock();
    free(params);
    /* A re-read that found what the app shows already draws nothing. */
    if ((!scan || changed) && fos_scenes_showing(asker)) fos_client_render_now();
}

static void store_task(void *arg)
{
    (void)arg;
    for (;;) {
        char job[WORD_LEN];
        lock();
        snprintf(job, sizeof(job), "%s", S->job);
        S->job[0] = '\0';
        if (!job[0]) s_running = false;
        unlock();
        if (!job[0]) break;
        run(job);
    }
    vTaskDelete(NULL);
}

/* Under s_lock. */
static void start_job(const char *job)
{
    snprintf(S->job, sizeof(S->job), "%s", job);
    if (s_running) return;
    s_running = true;
    if (xTaskCreate(store_task, "fos_store", TASK_STACK, NULL, 4, NULL) != pdPASS) {
        ESP_LOGE(TAG, "no memory for the store task");
        s_running = false;
        S->job[0] = '\0';
        S->busy[0] = '\0';
        snprintf(S->error, sizeof(S->error), "no_room");
    }
}
