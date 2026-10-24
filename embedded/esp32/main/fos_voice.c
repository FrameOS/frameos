#include "fos_voice.h"

#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"

#include "fos_buzzer.h"
#include "fos_client.h"
#include "fos_cloud.h"
#include "fos_config.h"
#include "fos_mem.h"
#include "fos_mic.h"
#include "fos_wifi.h"
#include "frameos_nim.h"

static const char *TAG = "fos_voice";

/* A chunk goes up once this much is waiting: a second of speech, so the
 * upload keeps pace with the talking and a 10 s sentence is nine chunks on
 * the wire before the release. Each is one TLS record batch on a kept-alive
 * connection. The last chunk may be anything up to the planes' 64 KiB cap. */
#define VOICE_CHUNK_BYTES (1 * FOS_MIC_BYTES_PER_SECOND)
#define VOICE_CHUNK_MAX_BYTES (64 * 1024)
/* Dropped from the start of the recording: the listening sparkle
 * (fos_buzzer_voice_listening, ~305 ms) plays while the microphone opens,
 * and a buzzer a few centimetres from a microphone is loud. */
#define VOICE_DISCARD_MS 300
/* The relay waits this long for Wi-Fi before giving up: a hold on a frame
 * that just woke from deep sleep records at once and uploads once online. */
#define VOICE_WIFI_WAIT_MS 20000
/* A chunk's HTTP round trip; the last chunk waits for the transcription and
 * the chat turn behind it. */
#define VOICE_CHUNK_TIMEOUT_MS 30000
#define VOICE_DONE_TIMEOUT_MS 120000
/* Deep sleep stays off for the session and the answer. */
#define VOICE_KEEP_AWAKE_MS 150000
/* The answer the plane sends: the transcript, a short reply, tool names. */
#define VOICE_REPLY_MAX_BYTES 4096
/* What the frame log keeps of the transcript and the reply. */
#define VOICE_LOG_TEXT_MAX 300

typedef enum {
    VOICE_IDLE = 0,
    VOICE_LISTENING, /* the microphone is open; chunks go up as they fill */
    VOICE_SENDING,   /* a key let go: the rest goes up, the answer is awaited */
} voice_state_t;

static SemaphoreHandle_t s_lock = NULL;
static volatile voice_state_t s_state = VOICE_IDLE;
/* The release: the relay stops the capture and sends the rest. */
static volatile bool s_end_requested = false;
/* The capture task writes, the relay task reads behind it. */
static uint8_t *s_buf = NULL;
static size_t s_buf_cap = 0;
static volatile size_t s_written = 0;
static volatile bool s_capturing = false;
static volatile bool s_capture_done = true;

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

/* ----------------------------------------------------------------- ticks */

/* The wait after the release is audible: every two seconds a tiny high
 * tick while the rest of the recording uploads, then a low bop while the
 * plane transcribes and answers, so a frame that takes ten seconds to
 * answer is known to be working on it. Not while listening: the microphone
 * would record them. The ticks stop before the outcome sounds. */
#define VOICE_TICK_MS 2000
typedef enum { TICK_OFF = 0, TICK_UPLOADING, TICK_THINKING } tick_phase_t;
static esp_timer_handle_t s_tick_timer = NULL;
static volatile tick_phase_t s_tick_phase = TICK_OFF;

/* Ticks left before the timer gives up on its own: the wait for an answer
 * is bounded (VOICE_DONE_TIMEOUT_MS), and a relay task that never came back
 * to stop the ticks must not leave a frame bopping forever. */
static volatile int s_ticks_left = 0;

static void tick(void *arg)
{
    (void)arg;
    tick_phase_t phase = s_tick_phase;
    if (phase == TICK_OFF) return;
    if (s_ticks_left <= 0) {
        s_tick_phase = TICK_OFF;
        if (s_tick_timer) esp_timer_stop(s_tick_timer);
        return;
    }
    s_ticks_left--;
    fos_buzzer_voice_tick(phase == TICK_THINKING);
}

static void ticks_start(void)
{
    s_tick_phase = TICK_UPLOADING;
    s_ticks_left = (VOICE_DONE_TIMEOUT_MS + VOICE_CHUNK_TIMEOUT_MS) / VOICE_TICK_MS;
    if (s_tick_timer) esp_timer_start_periodic(s_tick_timer, (uint64_t)VOICE_TICK_MS * 1000);
}

static void ticks_stop(void)
{
    s_tick_phase = TICK_OFF;
    if (s_tick_timer) esp_timer_stop(s_tick_timer);
}

/* ------------------------------------------------------------------ logs */

/* One JSON line into the frame log, through the Nim log hook: the backend
 * uploader and the cloud tap both carry it, so the reply shows in the
 * workspace's logs panel on either plane. */
static void voice_log(const char *event, cJSON *fields)
{
    cJSON *line = fields ? fields : cJSON_CreateObject();
    if (!line) return;
    cJSON_AddStringToObject(line, "event", event);
    cJSON_AddStringToObject(line, "source", "esp32");
    char *text = cJSON_PrintUnformatted(line);
    cJSON_Delete(line);
    if (!text) return;
    frameos_nim_log_hook(text);
    cJSON_free(text);
}

/* The 5x7 font is ASCII: fold the punctuation a model writes (curly quotes,
 * dashes, ellipses) onto it and skip the rest, so a reply reads on the panel
 * instead of leaving gaps. */
static void ascii_fold(const char *src, char *dst, size_t dst_len)
{
    size_t out = 0;
    for (size_t i = 0; src[i] && out + 4 < dst_len;) {
        unsigned char c = (unsigned char)src[i];
        if (c < 0x80) {
            dst[out++] = (char)c;
            i++;
            continue;
        }
        const unsigned char *u = (const unsigned char *)src + i;
        const char *fold = NULL;
        size_t len = (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 1;
        if (len == 3 && u[0] == 0xE2 && u[1] == 0x80) {
            if (u[2] == 0x98 || u[2] == 0x99) fold = "'";
            else if (u[2] == 0x9C || u[2] == 0x9D) fold = "\"";
            else if (u[2] == 0x93 || u[2] == 0x94) fold = "-";
            else if (u[2] == 0xA6) fold = "...";
        }
        if (fold) {
            size_t n = strlen(fold);
            memcpy(dst + out, fold, n);
            out += n;
        }
        i += len;
    }
    dst[out] = '\0';
}

/* What the panel says for an error the frame can explain itself. */
static const char *error_notice(const char *error)
{
    if (strcmp(error, "nothing_heard") == 0) return "I didn't catch that. Hold both buttons and speak after the chime.";
    if (strcmp(error, "offline") == 0) return "Voice chat: no Wi-Fi.";
    if (strcmp(error, "no_control_plane") == 0) return "Voice chat: this frame has no backend or cloud to talk to.";
    if (strcmp(error, "unauthorized") == 0) return "Voice chat: the frame's key was refused by its control plane.";
    if (strcmp(error, "upload_failed") == 0) return "Voice chat: could not reach the control plane.";
    if (strcmp(error, "upload_refused") == 0) return "Voice chat: the control plane refused the recording.";
    if (strcmp(error, "no_memory") == 0) return "Voice chat: out of memory.";
    if (strcmp(error, "microphone") == 0) return "Voice chat: the microphone did not start.";
    if (strcmp(error, "bad_response") == 0) return "Voice chat: the control plane gave no answer.";
    return NULL;
}

static void voice_log_error(const char *error, const char *detail)
{
    ticks_stop();
    cJSON *fields = cJSON_CreateObject();
    if (fields) {
        cJSON_AddStringToObject(fields, "error", error);
        if (detail && detail[0]) cJSON_AddStringToObject(fields, "detail", detail);
    }
    voice_log("voice:error", fields);
    /* printf: INFO is compiled out, and this is the line a bench reads. */
    printf("voice: %s%s%s\n", error, detail && detail[0] ? ": " : "", detail ? detail : "");
    /* On the panel too: a beep says "no", this says why. The control
     * plane's own errors (no OpenAI key, a refused transcription) come with
     * a sentence for the user; the frame's are worded here. */
    char notice[VOICE_LOG_TEXT_MAX + 32];
    const char *known = error_notice(error);
    if (known) {
        strlcpy(notice, known, sizeof(notice));
    } else if (detail && detail[0]) {
        char folded[VOICE_LOG_TEXT_MAX + 1];
        ascii_fold(detail, folded, sizeof(folded));
        snprintf(notice, sizeof(notice), "Voice chat: %.300s", folded);
    } else {
        snprintf(notice, sizeof(notice), "Voice chat failed: %.64s", error);
    }
    fos_client_show_notice(notice);
    if (strcmp(error, "nothing_heard") == 0) fos_buzzer_voice_nothing();
    else fos_buzzer_voice_error();
}

/* A copy cut to the log's length, on a UTF-8 boundary. */
static void bounded_copy(char *dst, size_t dst_len, const char *src)
{
    size_t n = strlen(src);
    if (n >= dst_len) {
        n = dst_len - 1;
        while (n > 0 && (((unsigned char)src[n]) & 0xC0) == 0x80) n--;
    }
    memcpy(dst, src, n);
    dst[n] = '\0';
}

/* --------------------------------------------------------------- capture */

static void capture_task(void *arg)
{
    (void)arg;
    /* 1024 bytes = 32 ms: the DMA holds 90, so a read never waits long. */
    static uint8_t block[1024];
    size_t discard = (size_t)VOICE_DISCARD_MS * FOS_MIC_BYTES_PER_SECOND / 1000;
    while (s_capturing) {
        size_t got = 0;
        esp_err_t err = fos_mic_read(block, sizeof(block), &got, 200);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "mic read: %s", esp_err_to_name(err));
            break;
        }
        if (got == 0) continue;
        if (discard > 0) {
            size_t skip = got < discard ? got : discard;
            discard -= skip;
            if (skip == got) continue;
            memmove(block, block + skip, got - skip);
            got -= skip;
        }
        size_t room = s_buf_cap - s_written;
        if (got > room) got = room;
        memcpy(s_buf + s_written, block, got);
        s_written += got;
        if (s_written >= s_buf_cap) break; /* FOS_VOICE_MAX_SECONDS: the sentence ends here */
    }
    s_capturing = false;
    s_capture_done = true;
    vTaskDelete(NULL);
}

/* ---------------------------------------------------------------- upload */

typedef struct {
    esp_http_client_handle_t client;
    /* The longest base: a cloud URL (FOS_URL_LEN), "/api/frames/", a frame
     * id (FOS_STR_LEN), "/voice/" and the session id. Sized so GCC's
     * format-truncation check can see every %s fits. */
    char base[FOS_URL_LEN + FOS_STR_LEN + 64];
    char session[24];
    unsigned seq;
} voice_upload_t;

/* Where this frame's control plane takes voice: a configured backend first
 * (its content comes from the backend when it has one, as fos_cloud.c's
 * backend_managed refusal says), else the cloud it is enrolled with. */
static bool upload_target(voice_upload_t *up, char *auth, size_t auth_len)
{
    const fos_config_t *config = fos_config();
    if (config->backend_url[0] && config->frame_id != 0 && config->api_key[0]) {
        snprintf(up->base, sizeof(up->base), "%s/api/frames/%lu/embedded/voice/%s", config->backend_url,
                 (unsigned long)config->frame_id, up->session);
        snprintf(auth, auth_len, "Bearer %s", config->api_key);
        return true;
    }
    char cloud[FOS_URL_LEN];
    char frame_id[FOS_STR_LEN];
    if (fos_cloud_api_access(cloud, sizeof(cloud), frame_id, sizeof(frame_id), auth, auth_len)) {
        snprintf(up->base, sizeof(up->base), "%s/api/frames/%s/voice/%s", cloud, frame_id, up->session);
        return true;
    }
    return false;
}

static bool plane_configured(void)
{
    const fos_config_t *config = fos_config();
    if (config->backend_url[0] && config->frame_id != 0 && config->api_key[0]) return true;
    return fos_cloud_api_access(NULL, 0, NULL, 0, NULL, 0);
}

/* One chunk: open, write, read the answer. `*status` is the HTTP status (0
 * when nothing came back); `reply` (may be NULL) receives the body. The
 * connection stays open for the next chunk (keep-alive). */
static esp_err_t send_chunk(voice_upload_t *up, const uint8_t *data, size_t len, bool done,
                            int *status, char *reply, size_t reply_len)
{
    char url[sizeof(up->base) + 48];
    snprintf(url, sizeof(url), "%s?seq=%u&done=%d", up->base, up->seq, done ? 1 : 0);
    *status = 0;
    if (reply && reply_len) reply[0] = '\0';
    esp_err_t err = esp_http_client_set_url(up->client, url);
    if (err != ESP_OK) return err;
    esp_http_client_set_timeout_ms(up->client, done ? VOICE_DONE_TIMEOUT_MS : VOICE_CHUNK_TIMEOUT_MS);
    err = esp_http_client_open(up->client, (int)len);
    if (err != ESP_OK) return err;
    size_t sent = 0;
    while (sent < len) {
        int w = esp_http_client_write(up->client, (const char *)data + sent, (int)(len - sent));
        if (w <= 0) {
            esp_http_client_close(up->client);
            return ESP_FAIL;
        }
        sent += (size_t)w;
    }
    /* The last byte is up: from here the plane transcribes and answers. */
    if (done && s_tick_phase != TICK_OFF) s_tick_phase = TICK_THINKING;
    int64_t content_length = esp_http_client_fetch_headers(up->client);
    if (content_length < 0) {
        esp_http_client_close(up->client);
        return ESP_FAIL;
    }
    *status = esp_http_client_get_status_code(up->client);
    /* Read the whole body, kept or not: an unread body is what stops the
     * next request from reusing the connection. */
    size_t used = 0;
    while (true) {
        char tmp[512];
        int r = esp_http_client_read(up->client, tmp, sizeof(tmp));
        if (r <= 0) break;
        if (reply && used + 1 < reply_len) {
            size_t take = (size_t)r;
            if (take > reply_len - 1 - used) take = reply_len - 1 - used;
            memcpy(reply + used, tmp, take);
            used += take;
            reply[used] = '\0';
        }
    }
    up->seq++;
    return ESP_OK;
}

/* The same chunk twice when the first try broke on the wire (a dropped
 * keep-alive, a Wi-Fi hiccup); a status the plane sent is final. */
static esp_err_t send_chunk_retry(voice_upload_t *up, const uint8_t *data, size_t len, bool done,
                                  int *status, char *reply, size_t reply_len)
{
    esp_err_t err = send_chunk(up, data, len, done, status, reply, reply_len);
    if (err == ESP_OK) return ESP_OK;
    vTaskDelay(pdMS_TO_TICKS(500));
    return send_chunk(up, data, len, done, status, reply, reply_len);
}

/* ------------------------------------------------------------ the answer */

static void handle_reply(const char *body, int status, uint32_t recorded_ms)
{
    ticks_stop();
    cJSON *json = body[0] ? cJSON_Parse(body) : NULL;
    if (status != 200 || !json) {
        char detail[64];
        snprintf(detail, sizeof(detail), "HTTP %d", status);
        voice_log_error(status == 401 || status == 403 ? "unauthorized" : "bad_response", detail);
        cJSON_Delete(json);
        return;
    }
    const cJSON *ok = cJSON_GetObjectItem(json, "ok");
    if (!cJSON_IsTrue(ok)) {
        const cJSON *error = cJSON_GetObjectItem(json, "error");
        const cJSON *detail = cJSON_GetObjectItem(json, "detail");
        voice_log_error(cJSON_IsString(error) ? error->valuestring : "failed",
                        cJSON_IsString(detail) ? detail->valuestring : "");
        cJSON_Delete(json);
        return;
    }
    const cJSON *transcript = cJSON_GetObjectItem(json, "transcript");
    const cJSON *reply = cJSON_GetObjectItem(json, "reply");
    const cJSON *tools = cJSON_GetObjectItem(json, "tools");
    char heard[VOICE_LOG_TEXT_MAX + 1] = "";
    char said[VOICE_LOG_TEXT_MAX + 1] = "";
    if (cJSON_IsString(transcript)) bounded_copy(heard, sizeof(heard), transcript->valuestring);
    if (cJSON_IsString(reply)) bounded_copy(said, sizeof(said), reply->valuestring);
    cJSON *fields = cJSON_CreateObject();
    if (fields) {
        cJSON_AddStringToObject(fields, "transcript", heard);
        cJSON_AddStringToObject(fields, "reply", said);
        if (cJSON_IsArray(tools)) {
            cJSON_AddItemToObject(fields, "tools", cJSON_Duplicate(tools, true));
        }
        cJSON_AddNumberToObject(fields, "ms", recorded_ms);
    }
    voice_log("voice:reply", fields);
    printf("voice: heard \"%s\" -> \"%s\"\n", heard, said);
    bool acted = cJSON_IsArray(tools) && cJSON_GetArraySize(tools) > 0;
    cJSON_Delete(json);
    /* On the panel: what was heard, in quotes, and the answer. The chat's
     * scene switch, when it made one, is the render this rides along on. */
    char folded_heard[VOICE_LOG_TEXT_MAX + 1];
    char folded_said[VOICE_LOG_TEXT_MAX + 1];
    ascii_fold(heard, folded_heard, sizeof(folded_heard));
    ascii_fold(said, folded_said, sizeof(folded_said));
    char notice[2 * VOICE_LOG_TEXT_MAX + 8];
    snprintf(notice, sizeof(notice), "\"%s\"\n%s", folded_heard, folded_said);
    /* A command the chat queued that the backend's nudge did not deliver
     * (the frame is not reachable by address): on the backend plane the frame
     * pulls its commands, so ask for a pull now — the render task takes it
     * before the release that follows, so it lands in the same render. The
     * cloud delivers its own over the socket, and a sync costs nothing there. */
    fos_client_request_commands_sync();
    fos_client_show_notice(notice);
    if (acted) fos_buzzer_voice_ok();
    else fos_buzzer_voice_said();
}

/* ------------------------------------------------------------- the relay */

static void stop_capture(void)
{
    s_capturing = false;
    /* The capture task ends its current read (200 ms at most) and leaves. */
    for (int i = 0; i < 50 && !s_capture_done; i++) vTaskDelay(pdMS_TO_TICKS(10));
    fos_mic_stop();
}

static void relay_task(void *arg)
{
    (void)arg;
    fos_client_keep_awake_ms(VOICE_KEEP_AWAKE_MS);
    /* The panel holds still until the answer: the chat's switch and its
     * state are applied as they arrive and shown by one render, with the
     * notice (fos_client_release_render at the end of the session). */
    fos_client_hold_render(VOICE_KEEP_AWAKE_MS);
    const fos_config_t *config = fos_config();
    int64_t started_ms = now_ms();
    voice_upload_t up = {0};
    char auth[FOS_STR_LEN + 16];
    char *reply = NULL;

    /* The whole session's audio: 30 s, or what PSRAM has (a render holds a
     * few megabytes on a big panel), down to 5 s. */
    size_t seconds = FOS_VOICE_MAX_SECONDS;
    s_buf = NULL;
    while (seconds >= 5) {
        s_buf_cap = seconds * FOS_MIC_BYTES_PER_SECOND;
        s_buf = fos_big_malloc(s_buf_cap);
        if (s_buf) break;
        seconds /= 2;
    }
    s_written = 0;
    if (!s_buf) {
        voice_log_error("no_memory", "no PSRAM for the recording");
        goto out;
    }

    fos_buzzer_voice_listening();
    esp_err_t err = fos_mic_start(config->mic_pins.clk, config->mic_pins.data, config->mic_pins.pwr);
    if (err != ESP_OK) {
        voice_log_error("microphone", esp_err_to_name(err));
        goto out;
    }
    s_capturing = true;
    s_capture_done = false;
    if (xTaskCreate(capture_task, "fos_mic", 4096, NULL, 6, NULL) != pdPASS) {
        s_capturing = false;
        s_capture_done = true;
        fos_mic_stop();
        voice_log_error("no_memory", "capture task");
        goto out;
    }
    voice_log("voice:listening", NULL);

    /* The plane and the connection. A frame that just woke records while
     * Wi-Fi comes up; the capture goes on meanwhile. */
    uint32_t r1 = esp_random(), r2 = esp_random();
    snprintf(up.session, sizeof(up.session), "%08lx%08lx", (unsigned long)r1, (unsigned long)r2);
    if (!upload_target(&up, auth, sizeof(auth))) {
        stop_capture();
        voice_log_error("no_control_plane", "no backend or cloud configured");
        goto out;
    }
    int64_t wifi_deadline = now_ms() + VOICE_WIFI_WAIT_MS;
    while (fos_wifi_state() != FOS_WIFI_CONNECTED && now_ms() < wifi_deadline) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (fos_wifi_state() != FOS_WIFI_CONNECTED) {
        stop_capture();
        voice_log_error("offline", "no Wi-Fi");
        goto out;
    }
    esp_http_client_config_t http_config = {
        .url = up.base,
        .method = HTTP_METHOD_POST,
        .timeout_ms = VOICE_CHUNK_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .keep_alive_enable = true,
        .buffer_size = 1024,
    };
    up.client = esp_http_client_init(&http_config);
    if (!up.client) {
        stop_capture();
        voice_log_error("no_memory", "http client");
        goto out;
    }
    esp_http_client_set_header(up.client, "Authorization", auth);
    esp_http_client_set_header(up.client, "Content-Type", "audio/L16; rate=16000; channels=1");

    /* Chunks go up as the talking fills them; the release (or a full
     * buffer) sends the rest and asks for the answer. */
    size_t sent = 0;
    bool failed = false;
    reply = fos_big_malloc(VOICE_REPLY_MAX_BYTES);
    while (!failed) {
        bool ending = s_end_requested || s_capture_done;
        size_t avail = s_written - sent;
        if (!ending && avail < VOICE_CHUNK_BYTES) {
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }
        if (ending) {
            /* A full buffer ends the sentence like a release does. */
            if (!s_end_requested) fos_buzzer_voice_sent();
            s_state = VOICE_SENDING;
            stop_capture();
            ticks_start();
            avail = s_written - sent;
            /* The answer may take the transcription and a few model rounds:
             * deep sleep waits for it from here, not from the hold. */
            fos_client_keep_awake_ms(VOICE_KEEP_AWAKE_MS);
        }
        size_t take = avail > VOICE_CHUNK_MAX_BYTES ? VOICE_CHUNK_MAX_BYTES : avail;
        bool last = ending && take == avail;
        int status = 0;
        esp_err_t cerr = send_chunk_retry(&up, s_buf + sent, take, last, &status,
                                          last ? reply : NULL, last ? VOICE_REPLY_MAX_BYTES : 0);
        if (cerr != ESP_OK) {
            voice_log_error("upload_failed", esp_err_to_name(cerr));
            failed = true;
            break;
        }
        if (!last && status != 202 && status != 200) {
            char detail[64];
            snprintf(detail, sizeof(detail), "HTTP %d on chunk %u", status, up.seq - 1);
            voice_log_error(status == 401 || status == 403 ? "unauthorized" : "upload_refused", detail);
            failed = true;
            break;
        }
        sent += take;
        if (last) {
            uint32_t recorded_ms = (uint32_t)((uint64_t)s_written * 1000 / FOS_MIC_BYTES_PER_SECOND);
            cJSON *fields = cJSON_CreateObject();
            if (fields) {
                cJSON_AddNumberToObject(fields, "ms", recorded_ms);
                cJSON_AddNumberToObject(fields, "bytes", (double)s_written);
                cJSON_AddNumberToObject(fields, "chunks", up.seq);
            }
            voice_log("voice:sent", fields);
            handle_reply(reply ? reply : "", status, recorded_ms);
            break;
        }
    }
    if (reply) free(reply);
    stop_capture();
    esp_http_client_close(up.client);
    esp_http_client_cleanup(up.client);

out:
    /* Every path above left a notice (the answer or the error); this draws it. */
    fos_client_release_render();
    if (s_buf) {
        free(s_buf);
        s_buf = NULL;
    }
    s_buf_cap = 0;
    ESP_LOGI(TAG, "session over after %lld ms", (long long)(now_ms() - started_ms));
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_state = VOICE_IDLE;
    s_end_requested = false;
    xSemaphoreGive(s_lock);
    vTaskDelete(NULL);
}

/* --------------------------------------------------------------- the API */

void fos_voice_init(void)
{
    if (!s_lock) s_lock = xSemaphoreCreateMutex();
    if (!s_tick_timer) {
        const esp_timer_create_args_t args = {.callback = tick, .name = "fos_voice_tick"};
        if (esp_timer_create(&args, &s_tick_timer) != ESP_OK) s_tick_timer = NULL;
    }
}

static bool mic_configured(void)
{
    const fos_config_t *config = fos_config();
    return config->mic_pins.clk >= 0 && config->mic_pins.data >= 0;
}

bool fos_voice_available(void)
{
    if (!s_lock) return false;
    const fos_config_t *config = fos_config();
    if (!config->voice_chat || !mic_configured()) return false;
    if (fos_mic_active()) return false; /* the console's `mic` check holds it */
    if (!plane_configured()) return false;
    return s_state == VOICE_IDLE;
}

bool fos_voice_begin(void)
{
    if (!fos_voice_available()) return false;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    bool started = false;
    if (s_state == VOICE_IDLE) {
        s_state = VOICE_LISTENING;
        s_end_requested = false;
        /* Internal stack: the relay runs TLS, which mbedTLS wants off a
         * PSRAM stack. Created per session, so it costs nothing between.
         * Above the render task (5) and the button task (4), level with the
         * capture task: below the render task's priority the answer sat
         * unread while a render and its e-paper refresh ran (24 s on the
         * E1002), the progress bop going the whole time, and the notice
         * missed that refresh. */
        if (xTaskCreate(relay_task, "fos_voice", 8192, NULL, 6, NULL) == pdPASS) {
            started = true;
        } else {
            s_state = VOICE_IDLE;
        }
    }
    xSemaphoreGive(s_lock);
    if (!started) ESP_LOGW(TAG, "could not start the relay task");
    return started;
}

void fos_voice_end(void)
{
    if (s_state != VOICE_LISTENING) return;
    s_end_requested = true;
    /* The release sounds now, from the button task: the upload's last
     * round trip and the answer take seconds. */
    fos_buzzer_voice_sent();
}

bool fos_voice_busy(void)
{
    return s_state != VOICE_IDLE;
}
