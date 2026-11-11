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

/* Everything below is under s_lock. */
static SemaphoreHandle_t s_lock;
static bool s_running;
/* What the pages show. */
static char s_busy[WORD_LEN];
static char s_error[WORD_LEN];
static char s_done[WORD_LEN];
static char s_query[104];
static char s_category[WORD_LEN];
static int s_page = 1;
static char *s_listing; /* the store's answer as it came, or NULL */
static char *s_info;    /* the store's answer for `s_info_id`'s scene, or NULL */
static char s_info_id[SCENE_ID_LEN];
static char s_info_store[STORE_ID_LEN];
static char s_preview_store[STORE_ID_LEN]; /* "" when nothing is previewed */
static char s_preview_id[SCENE_ID_LEN];
static char s_preview_name[NAME_LEN];
static char s_preview_from[SCENE_ID_LEN];
static origin_t s_origins[FOS_SCENE_STORE_SLOTS];
static int s_origin_count;
static uint32_t s_origins_generation = UINT32_MAX;
/* The work asked for, until the task takes it. */
static char s_job[WORD_LEN];
static char s_job_store[STORE_ID_LEN];
static char s_job_id[SCENE_ID_LEN];
static char s_job_name[NAME_LEN];
static char s_job_from[SCENE_ID_LEN];

static void lock(void) { xSemaphoreTake(s_lock, portMAX_DELAY); }
static void unlock(void) { xSemaphoreGive(s_lock); }

void fos_store_init(void)
{
    if (s_lock == NULL) s_lock = xSemaphoreCreateMutex();
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
    if (s_origins_generation != fos_scenes_store_generation() && !s_running && !s_job[0]) start_job("scan");
    out_t out = {.cap = 1024 + (s_listing ? strlen(s_listing) : 0) + (s_info ? strlen(s_info) : 0) +
                        (size_t)s_origin_count * (SCENE_ID_LEN + STORE_ID_LEN + 32)};
    out.buf = fos_big_malloc(out.cap);
    if (out.buf != NULL) {
        out.buf[0] = '\0';
        char line[48];
        put(&out, "{");
        put_pair(&out, "busy", s_busy);
        put_pair(&out, "error", s_error);
        put_pair(&out, "done", s_done);
        put_pair(&out, "query", s_query);
        put_pair(&out, "category", s_category);
        const fos_config_t *config = fos_config();
        snprintf(line, sizeof(line), "\"page\":%d,\"removeAny\":%s,\"listing\":", s_page,
                 config->backend_url[0] || fos_cloud_state() != FOS_CLOUD_NONE ? "false" : "true");
        put(&out, line);
        put(&out, s_listing ? s_listing : "null");
        put(&out, ",\"installed\":[");
        for (int i = 0; i < s_origin_count; i++) {
            put(&out, i ? ",{" : "{");
            put_pair(&out, "id", s_origins[i].id);
            put_pair(&out, "store", s_origins[i].store);
            snprintf(line, sizeof(line), "\"v\":%d}", s_origins[i].v);
            put(&out, line);
        }
        put(&out, "],\"preview\":");
        if (s_preview_store[0]) {
            put(&out, "{");
            put_pair(&out, "store", s_preview_store);
            put_pair(&out, "id", s_preview_id);
            put(&out, "\"name\":");
            put_string(&out, s_preview_name);
            put(&out, "}");
        } else {
            put(&out, "null");
        }
        put(&out, ",\"info\":{");
        put_pair(&out, "id", s_info_id);
        put_pair(&out, "store", s_info_store);
        put(&out, "\"scene\":");
        put(&out, s_info ? s_info : "null");
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
    if (!s_busy[0]) {
        const char *job = action;
        static const char *const known[] = {"browse", "info", "preview", "install", "update", "remove", "discard"};
        bool ok = false;
        for (size_t i = 0; i < sizeof(known) / sizeof(known[0]); i++) ok = ok || strcmp(action, known[i]) == 0;
        if (strcmp(action, "open") == 0) {
            job = s_listing == NULL ? "browse" : NULL;
        } else if (!ok) {
            job = NULL; /* "close": the switcher's own news, fos_scenes_switcher_shown */
        } else if (strcmp(action, "browse") == 0) {
            copy_arg(args, "q", s_query, sizeof(s_query));
            copy_arg(args, "category", s_category, sizeof(s_category));
            char page[8] = "";
            copy_arg(args, "page", page, sizeof(page));
            if (page[0]) s_page = atoi(page) > 0 ? atoi(page) : 1;
        } else if (strcmp(action, "info") == 0) {
            copy_arg(args, "id", s_info_id, sizeof(s_info_id));
            copy_arg(args, "store", s_info_store, sizeof(s_info_store));
            free(s_info);
            s_info = NULL;
        }
        if (job != NULL) {
            s_job_store[0] = s_job_id[0] = s_job_name[0] = s_job_from[0] = '\0';
            copy_arg(args, "store", s_job_store, sizeof(s_job_store));
            copy_arg(args, "id", s_job_id, sizeof(s_job_id));
            copy_arg(args, "name", s_job_name, sizeof(s_job_name));
            copy_arg(args, "from", s_job_from, sizeof(s_job_from));
            snprintf(s_busy, sizeof(s_busy), "%s", job);
            s_error[0] = s_done[0] = '\0';
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

/* The scene objects of a JSON array, by where they start and how long they
 * are: a store scene's scenes.json split without building its tree. -1 when
 * it is not an array of whole objects. */
static int split_scenes(const char *json, size_t len, const char **starts, size_t *lens, int max)
{
    int depth = 0, count = 0;
    bool in_string = false, escaped = false;
    const char *start = NULL;
    for (size_t i = 0; i < len; i++) {
        char c = json[i];
        if (in_string) {
            if (escaped) escaped = false;
            else if (c == '\\') escaped = true;
            else if (c == '"') in_string = false;
        } else if (c == '"') {
            in_string = true;
        } else if (c == '{' || c == '[') {
            if (depth == 1 && c == '{') start = json + i;
            if (depth == 0 && c != '[') return -1;
            depth++;
        } else if (c == '}' || c == ']') {
            depth--;
            if (depth == 1 && c == '}' && start != NULL && count < max) {
                starts[count] = start;
                lens[count++] = (size_t)(json + i + 1 - start);
                start = NULL;
            }
        }
    }
    return depth == 0 ? count : -1;
}

/* What a scene file says of where it came from: the `origin` the store
 * stamps on every scene it serves, {href, storeSceneId, version, sceneId},
 * found by its keys (no app's `origin` has a storeSceneId). */
static void read_origin(const char *json, char *store, size_t store_len, int *v)
{
    static const char key[] = "\"storeSceneId\":\"";
    store[0] = '\0';
    *v = 0;
    const char *at = json ? strstr(json, key) : NULL;
    if (at == NULL) return;
    at += sizeof(key) - 1;
    size_t n = 0;
    while (at[n] && at[n] != '"' && n + 1 < store_len) n++;
    memcpy(store, at, n);
    store[n] = '\0';
    const char *version = strstr(at + n, "\"version\":\"");
    if (version != NULL && version - (at + n) < 16) *v = atoi(version + 11);
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
        for (int i = 0; i < s_origin_count; i++) {
            if (row->hash >= 0 && s_origins[i].hash == row->hash && strcmp(s_origins[i].id, row->id) == 0) {
                *row = s_origins[i];
            }
        }
        unlock();
        if (!row->store[0]) {
            char *json = fos_scenes_get_json(row->id, NULL);
            read_origin(json, row->store, sizeof(row->store), &row->v);
            free(json);
        }
        if (row->store[0]) count++;
    }
    cJSON_Delete(index);
    lock();
    if (found != NULL) {
        memcpy(s_origins, found, sizeof(origin_t) * (size_t)count);
        s_origin_count = count;
    }
    s_origins_generation = generation;
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
    int count = error ? 0 : split_scenes(body, len, starts, lens, SPLIT_MAX);
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
    int count = s_origin_count;
    origin_t *rows = fos_big_malloc(sizeof(origin_t) * (size_t)(count + 1));
    if (rows != NULL) memcpy(rows, s_origins, sizeof(origin_t) * (size_t)count);
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
    snprintf(store, sizeof(store), "%s", s_job_store);
    snprintf(id, sizeof(id), "%s", s_job_id);
    snprintf(name, sizeof(name), "%s", s_job_name);
    snprintf(from, sizeof(from), "%s", s_job_from);
    char query[sizeof(s_query)], category[WORD_LEN];
    snprintf(query, sizeof(query), "%s", s_query);
    snprintf(category, sizeof(category), "%s", s_category);
    int page = s_page;
    if (strcmp(job, "discard") == 0) snprintf(from, sizeof(from), "%s", s_preview_from);
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
        char **slot = job[0] == 'b' ? &s_listing : &s_info;
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
            snprintf(store, sizeof(store), "%s", s_preview_store);
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
                snprintf(s_preview_store, sizeof(s_preview_store), "%s", store);
                snprintf(s_preview_id, sizeof(s_preview_id), "%s", shown);
                snprintf(s_preview_name, sizeof(s_preview_name), "%s", name);
                snprintf(s_preview_from, sizeof(s_preview_from), "%s", from);
            } else if (strcmp(job, "discard") == 0 || strcmp(s_preview_store, store) == 0) {
                s_preview_store[0] = '\0';
            }
        }
        unlock();
    }
    if (strcmp(job, "scan") == 0 || fos_scenes_store_generation() != s_origins_generation) scan_origins();
    lock();
    s_busy[0] = '\0';
    snprintf(s_error, sizeof(s_error), "%s", error ? error : "");
    snprintf(s_done, sizeof(s_done), "%s", error || strcmp(job, "scan") == 0 ? "" : done);
    unlock();
    if (fos_scenes_switcher_shown()) fos_client_render_now();
}

static void store_task(void *arg)
{
    (void)arg;
    for (;;) {
        char job[WORD_LEN];
        lock();
        snprintf(job, sizeof(job), "%s", s_job);
        s_job[0] = '\0';
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
    snprintf(s_job, sizeof(s_job), "%s", job);
    if (s_running) return;
    s_running = true;
    if (xTaskCreate(store_task, "fos_store", TASK_STACK, NULL, 4, NULL) != pdPASS) {
        ESP_LOGE(TAG, "no memory for the store task");
        s_running = false;
        s_job[0] = '\0';
        s_busy[0] = '\0';
        snprintf(s_error, sizeof(s_error), "no_room");
    }
}
