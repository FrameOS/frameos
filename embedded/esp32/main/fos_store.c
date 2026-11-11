/*
 * The scene store on the frame's own screen (docs/scene-store-on-frame.md):
 * the facts the scene switcher's store pages show (system/sceneSwitcher/
 * store.nim) and the work they ask for. The pages have the words; this file
 * has the facts.
 *
 * The Nim scene asks on the render task (embedded_runtime.nim), and nothing
 * here runs there but copying facts out: every request goes to a task of its
 * own, made for the work and gone when it is done, and the panel is drawn
 * again when the switcher is on it (fos_scenes_switcher_shown).
 *
 * - Browsing is the cloud store's short listing (/api/store/device/scenes),
 *   asked of the cloud this frame knows, else cloud.frameos.net. Its answer
 *   is kept as it came (a dozen scenes, about 1.5 KB) and handed on whole.
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
#define INFO_MAX (4 * 1024)
#define ANSWER_MAX 2048
/* A store scene's scenes.json: its scenes, each no more than a slot holds. */
#define SCENES_MAX (2 * FOS_SCENE_STORE_MAX_BYTES)
#define SPLIT_MAX 8
#define TASK_STACK 8192
#define STORE_ID_LEN 40
#define SCENE_ID_LEN FOS_SCENE_STORE_ID_LEN
#define WORD_LEN 24
#define NAME_LEN 96

typedef struct {
    char id[SCENE_ID_LEN];
    double hash;
    char store[STORE_ID_LEN];
    int v;
} origin_t;

/* What the pages show and the work asked for: one block in PSRAM (made at
 * init), not internal RAM, which TLS needs. Everything in it is under s_lock. */
typedef struct {
    char busy[WORD_LEN];
    char error[WORD_LEN];
    char done[WORD_LEN];
    char query[104];
    char category[WORD_LEN];
    int page;
    char *listing; /* the store's answer as it came, or NULL */
    char *info;    /* the store's answer for `info_id`'s scene, or NULL */
    char info_id[SCENE_ID_LEN];
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
} store_t;

static SemaphoreHandle_t s_lock;
static bool s_running;
static store_t *S;

static void lock(void) { xSemaphoreTake(s_lock, portMAX_DELAY); }
static void unlock(void) { xSemaphoreGive(s_lock); }

void fos_store_init(void)
{
    if (S != NULL) return;
    S = fos_big_malloc(sizeof(store_t));
    if (S == NULL) return;
    memset(S, 0, sizeof(store_t));
    S->page = 1;
    S->origins_generation = UINT32_MAX;
    s_lock = xSemaphoreCreateMutex();
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

char *fos_store_json(void)
{
    if (!fos_config_frame_page_offered() || s_lock == NULL) return NULL;
    lock();
    /* What came from the store is read again once the scenes changed, off
     * this task. */
    if (S->origins_generation != fos_scenes_store_generation() && !s_running && !S->job[0]) start_job("scan");
    out_t out = {.cap = 1024 + (S->listing ? strlen(S->listing) : 0) + (S->info ? strlen(S->info) : 0) +
                        (size_t)S->origin_count * (SCENE_ID_LEN + STORE_ID_LEN + 32)};
    out.buf = fos_big_malloc(out.cap);
    if (out.buf != NULL) {
        out.buf[0] = '\0';
        char line[48];
        put(&out, "{");
        put_pair(&out, "busy", S->busy);
        put_pair(&out, "error", S->error);
        put_pair(&out, "done", S->done);
        put_pair(&out, "query", S->query);
        put_pair(&out, "category", S->category);
        const fos_config_t *config = fos_config();
        snprintf(line, sizeof(line), "\"page\":%d,\"removeAny\":%s,\"listing\":", S->page,
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
        put(&out, ",\"info\":{");
        put_pair(&out, "id", S->info_id);
        put(&out, "\"scene\":");
        put(&out, S->info ? S->info : "null");
        put(&out, "}}");
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

void fos_store_action(const char *action, const char *args_json)
{
    if (s_lock == NULL || action == NULL) return;
    cJSON *args = cJSON_Parse(args_json ? args_json : "{}");
    lock();
    /* One thing at a time: the page says what is running. (A re-read of
     * what came from the store does not count: it runs after.) */
    if (!S->busy[0]) {
        const char *job = action;
        static const char *const known[] = {"browse", "info", "preview", "install", "update", "remove", "discard"};
        bool ok = false;
        for (size_t i = 0; i < sizeof(known) / sizeof(known[0]); i++) ok = ok || strcmp(action, known[i]) == 0;
        if (strcmp(action, "open") == 0) {
            job = S->listing == NULL ? "browse" : NULL;
        } else if (!ok) {
            job = NULL; /* "close": the switcher's own news, fos_scenes_switcher_shown */
        } else if (strcmp(action, "browse") == 0) {
            copy_arg(args, "q", S->query, sizeof(S->query));
            copy_arg(args, "category", S->category, sizeof(S->category));
            char page[8] = "";
            copy_arg(args, "page", page, sizeof(page));
            if (page[0]) S->page = atoi(page) > 0 ? atoi(page) : 1;
        }
        S->job_store[0] = S->job_id[0] = S->job_name[0] = S->job_from[0] = '\0';
        copy_arg(args, "store", S->job_store, sizeof(S->job_store));
        copy_arg(args, "id", S->job_id, sizeof(S->job_id));
        copy_arg(args, "name", S->job_name, sizeof(S->job_name));
        copy_arg(args, "from", S->job_from, sizeof(S->job_from));
        /* A scene on the frame names its store scene by its id. */
        for (int i = 0; !S->job_store[0] && S->job_id[0] && i < S->origin_count; i++) {
            if (strcmp(S->origins[i].id, S->job_id) == 0) {
                snprintf(S->job_store, sizeof(S->job_store), "%s", S->origins[i].store);
            }
        }
        if (job != NULL && strcmp(job, "info") == 0) {
            snprintf(S->info_id, sizeof(S->info_id), "%s", S->job_id);
            free(S->info);
            S->info = NULL;
            if (!S->job_store[0]) job = NULL; /* not from the store: nothing to ask */
        }
        if (job != NULL) {
            snprintf(S->busy, sizeof(S->busy), "%s", job);
            S->error[0] = S->done[0] = '\0';
            start_job(job);
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
                             char *status, size_t status_len, char *shown, size_t shown_len)
{
    if (fos_wifi_state() != FOS_WIFI_CONNECTED) return "offline";
    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "action", action);
    cJSON_AddStringToObject(body, "scene_id", scene_id);
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
static void scan_origins(void)
{
    uint32_t generation = fos_scenes_store_generation();
    cJSON *index = fos_scenes_read_index();
    origin_t *found = fos_big_malloc(sizeof(origin_t) * FOS_SCENE_STORE_SLOTS);
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
        memcpy(S->origins, found, sizeof(origin_t) * (size_t)count);
        S->origin_count = count;
    }
    S->origins_generation = generation;
    unlock();
    free(found);
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
    char url[FOS_URL_LEN + 320];
    char auth[FOS_STR_LEN + 16];
    const char *error = NULL;
    const char *done = job;
    lock();
    char store[STORE_ID_LEN], id[SCENE_ID_LEN], name[NAME_LEN], from[SCENE_ID_LEN];
    snprintf(store, sizeof(store), "%s", S->job_store);
    snprintf(id, sizeof(id), "%s", S->job_id);
    snprintf(name, sizeof(name), "%s", S->job_name);
    snprintf(from, sizeof(from), "%s", S->job_from);
    char query[sizeof(S->query)], category[WORD_LEN];
    snprintf(query, sizeof(query), "%s", S->query);
    snprintf(category, sizeof(category), "%s", S->category);
    int page = S->page;
    if (strcmp(job, "discard") == 0) snprintf(from, sizeof(from), "%s", S->preview_from);
    unlock();

    if (strcmp(job, "browse") == 0 || strcmp(job, "info") == 0) {
        char *body = NULL;
        store_base(url, sizeof(url));
        size_t n = strlen(url);
        if (job[0] == 'b') {
            snprintf(url + n, sizeof(url) - n, "/api/store/device/scenes?categories=1&page=%d&version=%s&q=", page,
                     esp_app_get_description()->version);
            add_encoded(url, sizeof(url), query);
            n = strlen(url);
            snprintf(url + n, sizeof(url) - n, "&category=%s", category);
        } else {
            snprintf(url + n, sizeof(url) - n, "/api/store/device/scenes/%s", store);
        }
        error = fetch(url, job[0] == 'b' ? LISTING_MAX : INFO_MAX, true, &body, NULL);
        lock();
        char **slot = job[0] == 'b' ? &S->listing : &S->info;
        if (body != NULL) {
            free(*slot);
            *slot = body;
        }
        unlock();
        done = "";
    } else if (strcmp(job, "scan") != 0) {
        bool backend = false, pending = false;
        char status[WORD_LEN] = "", shown[SCENE_ID_LEN] = "";
        if (plane(url, sizeof(url), auth, sizeof(auth), &backend, &pending)) {
            /* The plane's: what it holds is the store scene's (a preview's
             * Discard goes back to the scene it covered). */
            error = pending ? "offline"
                            : ask_plane(url, auth, backend, job, strcmp(job, "discard") == 0 ? from : store,
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
            error = install_here(store, strcmp(job, "update") != 0, shown, sizeof(shown));
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
    if (strcmp(job, "scan") == 0 || fos_scenes_store_generation() != S->origins_generation) scan_origins();
    lock();
    S->busy[0] = '\0';
    snprintf(S->error, sizeof(S->error), "%s", error ? error : "");
    snprintf(S->done, sizeof(S->done), "%s", error || strcmp(job, "scan") == 0 ? "" : done);
    unlock();
    if (fos_scenes_switcher_shown()) fos_client_render_now();
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
