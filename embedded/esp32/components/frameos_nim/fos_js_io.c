/*
 * The frame's one task for network work a scene asked for (docs/async-js.md):
 * a JS app's fetch() and the pictures of its `<img src="https://…">`, made
 * off the render task, so a render never waits on the network and a tap is
 * answered while a picture downloads; and the scene store's work
 * (main/fos_store.c, fos_js_io_run), so the two never hold two TLS sessions.
 *
 * The render task hands a request over (frameos/js_runtime/js_io.nim,
 * fos_js_io_submit) and takes its answer back between renders
 * (fos_js_io_take, from the pump frameos_nim_tick runs). Between the two a
 * task of its own does the request with the glue every Nim app uses
 * (fos_nim_http_request_chunked: the private-network policy, the redirects,
 * the body in PSRAM chunks), and wakes the render task's wait when it has an
 * answer. The task is made when there is work and goes when there is none,
 * like the scene store's, and makes one request at a time: a TLS session is
 * ~40 KB of internal RAM, which an ESP32-S3 runs short of first.
 *
 * Only values cross: a request is copied in here (PSRAM), an answer is the
 * glue's chunk array, which the Nim side frees once it has decoded or copied
 * it. Both queues are short arrays under a spinlock; nothing slow runs under
 * it.
 *
 * A request can ask for its answer in pieces (fetch's onChunk, "A response in
 * pieces" in docs/async-js.md): the task reads the body off the socket a
 * piece at a time (the glue's stream, a gzip body inflated as it comes) and
 * queues each as an answer of its own, two at most waiting for the render
 * task, so the body is never held and the server is read no faster than the
 * app takes it. fos_js_io_cancel stops one.
 */
#include "fos_js_io.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"

#include "frameos_nim.h"

/* main/fos_client.c: ends the render task's wait, as a key press does. */
void fos_client_wake_for_events(void);

static const char *TAG = "fos_js_io";

/* Requests waiting for the task and answers waiting for the render task. One
 * app may have 32 pending (js_async.nim MaxAsyncWaitsPerApp); a frame showing
 * one scene rarely has more than that in flight. Past it, a request is
 * refused and the app hears so at once. */
#define QUEUE_LEN 32
#define TASK_STACK 8192
#define TASK_PRIORITY 4

typedef struct {
    int id;
    void (*job)(void *); /* fos_js_io_run: run this, nothing else */
    void *job_arg;
    char *method;
    char *url;
    char *headers;
    size_t headers_len;
    void *body;
    size_t body_len;
    int timeout_ms;
    size_t max_bytes;
    size_t piece_bytes; /* > 0: the answer in pieces of this size */
} request_t;

typedef struct {
    int id;
    int status;
    /* A whole answer's chunks and their count; a piece's bytes and their
     * length; a stream's end: why it was cut short (a string), or NULL. */
    void *chunks;
    size_t count;
    char *head;   /* a stream's first answer: its URL and headers (FOS_JS_IO_HEAD_BYTES) */
    uint8_t kind; /* FOS_JS_IO_WHOLE, _PIECE or _END */
} answer_t;

/* A stream waits for the app with this many pieces queued. */
#define STREAM_QUEUE 2
#define STREAM_MAX_BYTES (16u * 1024u * 1024u)
#define STREAM_MAX_US (120LL * 1000 * 1000)

static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
/* In PSRAM, made at the first request (1.6 KB a board that never runs async
 * JavaScript does not spend, and internal RAM is the TLS session's). */
static request_t *s_requests = NULL;
static int s_request_count = 0;
static answer_t *s_answers = NULL;
static int s_answer_count = 0;
static int s_in_flight = 0; /* handed over and not taken back yet */
static bool s_task_running = false;
static int s_stream_id = 0;     /* the stream being read (one at a time, as every request) */
static int s_stream_queued = 0; /* its pieces waiting for the render task */
static bool s_stream_stop = false;

static void *psram_alloc(size_t len)
{
    /* PSRAM where there is some: internal RAM is the TLS session's. */
    void *p = heap_caps_malloc(len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    return p != NULL ? p : malloc(len);
}

static char *copy_bytes(const void *src, size_t len)
{
    char *dst = psram_alloc(len + 1);
    if (dst == NULL) return NULL;
    if (len > 0) memcpy(dst, src, len);
    dst[len] = '\0';
    return dst;
}

static void free_request(request_t *r)
{
    free(r->method);
    free(r->url);
    free(r->headers);
    free(r->body);
    memset(r, 0, sizeof(*r));
}

static void free_answer(answer_t *a)
{
    if (a->kind == FOS_JS_IO_WHOLE) {
        if (a->chunks) fos_nim_http_free_chunks(a->chunks, a->count);
    } else {
        free(a->chunks);
    }
    free(a->head);
}

/* Queues an answer and wakes the render task. A piece waits while
 * STREAM_QUEUE of them do, any answer for a slot; false when the stream was
 * stopped meanwhile (the answer is the caller's still). */
static bool post_answer(answer_t *a)
{
    for (;;) {
        bool queued = false;
        bool stopped = false;
        taskENTER_CRITICAL(&s_mux);
        if (a->kind != FOS_JS_IO_WHOLE && s_stream_stop) {
            stopped = true;
        } else if (s_answer_count < QUEUE_LEN && (a->kind != FOS_JS_IO_PIECE || s_stream_queued < STREAM_QUEUE)) {
            s_answers[s_answer_count++] = *a;
            if (a->kind == FOS_JS_IO_PIECE) s_stream_queued++;
            queued = true;
        }
        taskEXIT_CRITICAL(&s_mux);
        if (stopped) return false;
        if (queued) {
            fos_client_wake_for_events();
            return true;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

/* A request whose answer goes over in pieces. */
static void run_stream(request_t *r)
{
    answer_t end = {.id = r->id, .kind = FOS_JS_IO_END};
    char err[224];
    err[0] = '\0';
    const char *why = NULL;
    char *head = psram_alloc(FOS_JS_IO_HEAD_BYTES);
    if (head != NULL) memset(head, 0, FOS_JS_IO_HEAD_BYTES);
    fos_nim_http_stream *stream = head == NULL ? NULL
        : fos_nim_http_stream_open_text(r->method, r->url, r->body, r->body_len, r->headers, r->headers_len,
                                        r->timeout_ms, &end.status, head, FOS_JS_IO_URL_BYTES,
                                        head + FOS_JS_IO_URL_BYTES, err, sizeof(err));
    if (stream == NULL) {
        end.status = 0;
        why = err[0] ? err : "out of memory";
    } else {
        /* The head as one text: the URL, a line break, the headers. */
        size_t url_len = strlen(head);
        head[url_len] = '\n';
        memmove(head + url_len + 1, head + FOS_JS_IO_URL_BYTES, strlen(head + FOS_JS_IO_URL_BYTES) + 1);
        int64_t until = esp_timer_get_time() + STREAM_MAX_US;
        size_t total = 0;
        for (;;) {
            char *piece = psram_alloc(r->piece_bytes);
            int n = piece == NULL ? -1 : fos_nim_http_stream_read(stream, piece, r->piece_bytes);
            if (n <= 0) {
                free(piece);
                if (piece == NULL) why = "out of memory";
                else if (n < 0) why = "the connection closed before the answer ended";
                break;
            }
            total += (size_t)n;
            answer_t a = {.id = r->id, .status = end.status, .chunks = piece, .count = (size_t)n,
                          .head = head, .kind = FOS_JS_IO_PIECE};
            if (!post_answer(&a)) {
                free(piece);
                break;
            }
            head = NULL;
            if (total >= STREAM_MAX_BYTES) why = "the answer is over 16 MB";
            else if (esp_timer_get_time() > until) why = "the answer took over two minutes";
            if (why != NULL) break;
        }
        fos_nim_http_stream_close(stream);
    }
    if (why != NULL) end.chunks = copy_bytes(why, strlen(why));
    end.head = head;
    if (!post_answer(&end)) {
        /* Stopped: nobody waits for its end. */
        free_answer(&end);
        taskENTER_CRITICAL(&s_mux);
        s_in_flight--;
        taskEXIT_CRITICAL(&s_mux);
    }
    taskENTER_CRITICAL(&s_mux);
    s_stream_id = 0;
    s_stream_stop = false;
    taskEXIT_CRITICAL(&s_mux);
}

static void js_io_task(void *arg)
{
    (void)arg;
    for (;;) {
        request_t r;
        bool have = false;
        taskENTER_CRITICAL(&s_mux);
        if (s_request_count > 0) {
            r = s_requests[0];
            memmove(&s_requests[0], &s_requests[1], sizeof(request_t) * (size_t)(s_request_count - 1));
            s_request_count--;
            have = true;
            if (r.piece_bytes > 0) s_stream_id = r.id;
        } else {
            s_task_running = false;
        }
        taskEXIT_CRITICAL(&s_mux);
        if (!have) break;

        if (r.job != NULL) {
            r.job(r.job_arg);
            continue;
        }
        if (r.piece_bytes > 0) {
            run_stream(&r);
            free_request(&r);
            continue;
        }
        answer_t a = {.id = r.id};
        a.chunks = fos_nim_http_request_chunked(r.method, r.url, r.body, r.body_len, r.headers, r.headers_len,
                                                r.timeout_ms, r.max_bytes, &a.status, &a.count);
        free_request(&r);

        bool kept = false;
        taskENTER_CRITICAL(&s_mux);
        if (s_answer_count < QUEUE_LEN) {
            s_answers[s_answer_count++] = a;
            kept = true;
        }
        taskEXIT_CRITICAL(&s_mux);
        if (!kept) {
            /* Cannot happen while QUEUE_LEN bounds what is in flight; never
             * leak the body if it does. */
            if (a.chunks) fos_nim_http_free_chunks(a.chunks, a.count);
            taskENTER_CRITICAL(&s_mux);
            s_in_flight--;
            taskEXIT_CRITICAL(&s_mux);
            ESP_LOGW(TAG, "answer %d dropped: queue full", a.id);
        }
        fos_client_wake_for_events();
    }
    vTaskDelete(NULL);
}

static bool ensure_queues(void)
{
    /* The render task alone submits, so no other task makes these. */
    if (s_requests == NULL) {
        s_requests = heap_caps_calloc(QUEUE_LEN, sizeof(request_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (s_requests == NULL) s_requests = calloc(QUEUE_LEN, sizeof(request_t));
    }
    if (s_answers == NULL) {
        s_answers = heap_caps_calloc(QUEUE_LEN, sizeof(answer_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (s_answers == NULL) s_answers = calloc(QUEUE_LEN, sizeof(answer_t));
    }
    return s_requests != NULL && s_answers != NULL;
}

/* After s_task_running was set: false (and it cleared) when there is no
 * internal RAM for the task now. */
static bool start_task(void)
{
    if (xTaskCreate(js_io_task, "fos_js_io", TASK_STACK, NULL, TASK_PRIORITY, NULL) == pdPASS) return true;
    ESP_LOGE(TAG, "no memory for the request task");
    taskENTER_CRITICAL(&s_mux);
    s_task_running = false;
    taskEXIT_CRITICAL(&s_mux);
    return false;
}

bool fos_js_io_submit(int id, const char *method, const char *url, const char *headers, size_t headers_len,
                      const void *body, size_t body_len, int timeout_ms, size_t max_bytes, size_t piece_bytes)
{
    if (url == NULL || method == NULL || !ensure_queues()) return false;
    request_t r = {
        .id = id,
        .method = copy_bytes(method, strlen(method)),
        .url = copy_bytes(url, strlen(url)),
        .headers = headers_len > 0 ? copy_bytes(headers, headers_len) : NULL,
        .headers_len = headers_len,
        .body = body_len > 0 ? copy_bytes(body, body_len) : NULL,
        .body_len = body_len,
        .timeout_ms = timeout_ms,
        .max_bytes = max_bytes,
        .piece_bytes = piece_bytes,
    };
    if (r.method == NULL || r.url == NULL || (headers_len > 0 && r.headers == NULL) ||
        (body_len > 0 && r.body == NULL)) {
        free_request(&r);
        return false;
    }
    bool queued = false;
    bool start = false;
    taskENTER_CRITICAL(&s_mux);
    if (s_request_count < QUEUE_LEN && s_in_flight < QUEUE_LEN) {
        s_requests[s_request_count++] = r;
        s_in_flight++;
        queued = true;
        if (!s_task_running) {
            s_task_running = true;
            start = true;
        }
    }
    taskEXIT_CRITICAL(&s_mux);
    if (!queued) {
        free_request(&r);
        return false;
    }
    if (start && !start_task()) {
        /* No internal RAM for a task now: this one is refused, so the app
         * hears it instead of waiting for ever (what was queued before runs
         * at the next start). */
        taskENTER_CRITICAL(&s_mux);
        s_request_count--;
        s_in_flight--;
        taskEXIT_CRITICAL(&s_mux);
        free_request(&r);
        return false;
    }
    return true;
}

bool fos_js_io_run(void (*job)(void *), void *arg)
{
    if (job == NULL || !ensure_queues()) return false;
    bool start = false;
    bool queued = false;
    taskENTER_CRITICAL(&s_mux);
    if (s_request_count < QUEUE_LEN) {
        s_requests[s_request_count++] = (request_t){.job = job, .job_arg = arg};
        queued = true;
        start = !s_task_running;
        s_task_running = true;
    }
    taskEXIT_CRITICAL(&s_mux);
    if (!queued) return false;
    if (start && !start_task()) {
        taskENTER_CRITICAL(&s_mux);
        s_request_count--;
        taskEXIT_CRITICAL(&s_mux);
        return false;
    }
    return true;
}

bool fos_js_io_take(int *id, int *status, void **chunks, size_t *count, int *kind, char **head, int wait_ms)
{
    if (s_answers == NULL) return false;
    bool have = false;
    /* The blocking fetch's wait: no lock for a look. */
    for (; wait_ms > 0 && s_answer_count == 0; wait_ms -= 10) vTaskDelay(pdMS_TO_TICKS(10));
    taskENTER_CRITICAL(&s_mux);
    if (s_answer_count > 0) {
        answer_t a = s_answers[0];
        memmove(&s_answers[0], &s_answers[1], sizeof(answer_t) * (size_t)(s_answer_count - 1));
        s_answer_count--;
        if (a.kind == FOS_JS_IO_PIECE) s_stream_queued--;
        else s_in_flight--;
        *id = a.id;
        *status = a.status;
        *chunks = a.chunks;
        *count = a.count;
        *kind = a.kind;
        *head = a.head;
        have = true;
    }
    taskEXIT_CRITICAL(&s_mux);
    return have;
}

void fos_js_io_cancel(int id)
{
    taskENTER_CRITICAL(&s_mux);
    if (s_stream_id == id) s_stream_stop = true;
    taskEXIT_CRITICAL(&s_mux);
}

int fos_js_io_in_flight(void)
{
    taskENTER_CRITICAL(&s_mux);
    int n = s_in_flight;
    taskEXIT_CRITICAL(&s_mux);
    return n;
}

void fos_js_io_wake_if_waiting(void)
{
    taskENTER_CRITICAL(&s_mux);
    bool waiting = s_answer_count > 0;
    taskEXIT_CRITICAL(&s_mux);
    if (waiting) fos_client_wake_for_events();
}
