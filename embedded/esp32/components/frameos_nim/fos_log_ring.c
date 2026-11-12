/* See fos_log_ring.h. */
#include "fos_log_ring.h"

#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

/* 16 KB holds about eight fully logged render passes; a burst of scene log
 * lines beyond that drops the newest and says so. PSRAM: the ring is read
 * and written by tasks, never by DMA. */
#define FOS_LOG_RING_BYTES (16 * 1024)
/* A record: a 16-bit length, the bytes, no terminator. Lines longer than
 * this are cut; frameos_nim_log_hook's lines are under 1.6 KB. */
#define FOS_LOG_RING_MAX_LINE 2048
#define FOS_LOG_RING_TASK_STACK 3072
/* Below the render task (5) and the console (FOS_CONSOLE_PAYLOAD_PRIORITY 6
 * while a payload is on the wire), above idle: the lines come out when
 * nothing that matters wants the core. */
#define FOS_LOG_RING_TASK_PRIORITY 2
#define FOS_LOG_RING_TASK_CORE 0

static const char *TAG = "fos_log_ring";

static uint8_t *s_ring = NULL;
static size_t s_head = 0; /* next write */
static size_t s_tail = 0; /* next read */
static size_t s_used = 0;
static size_t s_pending_lines = 0;
static uint32_t s_dropped = 0;
static uint32_t s_dropped_reported = 0;
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static TaskHandle_t s_task = NULL;
static SemaphoreHandle_t s_drained = NULL;
/* The drain's line buffers, in PSRAM with the ring: internal RAM is a few
 * tens of KB on a running frame. */
static char *s_line = NULL; /* FOS_LOG_RING_MAX_LINE */
static char *s_out = NULL;  /* FOS_LOG_RING_MAX_LINE + 2 */

static void ring_write_bytes(const uint8_t *src, size_t len)
{
    size_t first = FOS_LOG_RING_BYTES - s_head;
    if (first > len) first = len;
    memcpy(s_ring + s_head, src, first);
    if (len > first) memcpy(s_ring, src + first, len - first);
    s_head = (s_head + len) % FOS_LOG_RING_BYTES;
    s_used += len;
}

static void ring_read_bytes(uint8_t *dst, size_t len)
{
    size_t first = FOS_LOG_RING_BYTES - s_tail;
    if (first > len) first = len;
    memcpy(dst, s_ring + s_tail, first);
    if (len > first) memcpy(dst + first, s_ring, len - first);
    s_tail = (s_tail + len) % FOS_LOG_RING_BYTES;
    s_used -= len;
}

static void write_line_now(const char *line, size_t len)
{
    /* One write() per line: the UART VFS holds its lock for the whole call,
     * so a line from here never interleaves with another task's printf
     * inside the line. stdout's own buffering would split a long line. */
    if (len > FOS_LOG_RING_MAX_LINE) len = FOS_LOG_RING_MAX_LINE;
    fflush(stdout); /* whatever printf left buffered goes first, in order */
    if (s_out == NULL) {
        /* Before the ring started (early boot): two writes, as printf did. */
        write(fileno(stdout), line, len);
        write(fileno(stdout), "\n", 1);
        return;
    }
    memcpy(s_out, line, len);
    s_out[len] = '\n';
    write(fileno(stdout), s_out, len + 1);
}

static void drain_task(void *arg)
{
    (void)arg;
    char *line = s_line;
    while (true) {
        uint16_t len = 0;
        bool have = false;
        uint32_t report_dropped = 0;
        portENTER_CRITICAL(&s_lock);
        if (s_used >= sizeof(len)) {
            ring_read_bytes((uint8_t *)&len, sizeof(len));
            ring_read_bytes((uint8_t *)line, len);
            s_pending_lines--;
            have = true;
        }
        if (s_dropped != s_dropped_reported) {
            report_dropped = s_dropped - s_dropped_reported;
            s_dropped_reported = s_dropped;
        }
        portEXIT_CRITICAL(&s_lock);
        if (have) {
            write_line_now(line, len);
            continue;
        }
        if (report_dropped > 0) {
            char note[96];
            int n = snprintf(note, sizeof(note),
                             "{\"event\":\"console:dropped\",\"source\":\"esp32\",\"lines\":%lu}",
                             (unsigned long)report_dropped);
            if (n > 0) write_line_now(note, (size_t)n);
            continue;
        }
        if (s_drained != NULL) xSemaphoreGive(s_drained);
        /* Woken by a producer; a 1 s cap so a lost notification costs a
         * second, not the console. */
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
    }
}

void fos_log_ring_start(void)
{
    if (s_task != NULL) return;
    uint8_t *ring = heap_caps_malloc(FOS_LOG_RING_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    char *line = heap_caps_malloc(FOS_LOG_RING_MAX_LINE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    char *out = heap_caps_malloc(FOS_LOG_RING_MAX_LINE + 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (ring == NULL || line == NULL || out == NULL) {
        /* No PSRAM (a C3): the lines print on the logging task, as before. */
        heap_caps_free(ring);
        heap_caps_free(line);
        heap_caps_free(out);
        ESP_LOGW(TAG, "no PSRAM for the log ring; lines print on the logging task");
        return;
    }
    s_line = line;
    s_out = out;
    s_drained = xSemaphoreCreateBinary();
    TaskHandle_t task = NULL;
    if (xTaskCreatePinnedToCore(drain_task, "log_ring", FOS_LOG_RING_TASK_STACK, NULL,
                                FOS_LOG_RING_TASK_PRIORITY, &task, FOS_LOG_RING_TASK_CORE) != pdPASS) {
        ESP_LOGW(TAG, "log ring task failed; lines print on the logging task");
        heap_caps_free(ring);
        s_line = NULL;
        s_out = NULL;
        heap_caps_free(line);
        heap_caps_free(out);
        return;
    }
    portENTER_CRITICAL(&s_lock);
    s_ring = ring;
    s_head = s_tail = s_used = 0;
    s_pending_lines = 0;
    portEXIT_CRITICAL(&s_lock);
    s_task = task;
}

void fos_log_ring_puts(const char *line)
{
    if (line == NULL) line = "";
    size_t len = strnlen(line, FOS_LOG_RING_MAX_LINE);
    if (s_task == NULL || s_ring == NULL) {
        write_line_now(line, len);
        return;
    }
    if (xPortInIsrContext()) return; /* never from an interrupt */
    bool queued = false;
    portENTER_CRITICAL(&s_lock);
    if (s_ring != NULL && s_used + sizeof(uint16_t) + len <= FOS_LOG_RING_BYTES) {
        uint16_t len16 = (uint16_t)len;
        ring_write_bytes((const uint8_t *)&len16, sizeof(len16));
        ring_write_bytes((const uint8_t *)line, len);
        s_pending_lines++;
        queued = true;
    } else {
        s_dropped++;
    }
    portEXIT_CRITICAL(&s_lock);
    if (queued) xTaskNotifyGive(s_task);
}

int fos_log_ring_printf(const char *fmt, ...)
{
    char line[512];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    if (n < 0) return n;
    /* A trailing newline is the record's own; printf callers wrote one. */
    size_t len = (size_t)n < sizeof(line) ? (size_t)n : sizeof(line) - 1;
    while (len > 0 && line[len - 1] == '\n') len--;
    line[len] = '\0';
    fos_log_ring_puts(line);
    return n;
}

bool fos_log_ring_flush(uint32_t timeout_ms)
{
    if (s_task == NULL) {
        fflush(stdout);
        return true;
    }
    TickType_t deadline = xTaskGetTickCount() + pdMS_TO_TICKS(timeout_ms);
    while (true) {
        portENTER_CRITICAL(&s_lock);
        bool empty = s_used == 0;
        portEXIT_CRITICAL(&s_lock);
        if (empty) return true;
        xTaskNotifyGive(s_task);
        TickType_t now = xTaskGetTickCount();
        if ((int32_t)(deadline - now) <= 0) return false;
        TickType_t wait = deadline - now;
        if (wait > pdMS_TO_TICKS(20)) wait = pdMS_TO_TICKS(20);
        if (s_drained != NULL) xSemaphoreTake(s_drained, wait);
        else vTaskDelay(wait);
    }
}

uint32_t fos_log_ring_dropped(void)
{
    return s_dropped;
}

size_t fos_log_ring_pending(void)
{
    portENTER_CRITICAL(&s_lock);
    size_t pending = s_pending_lines;
    portEXIT_CRITICAL(&s_lock);
    return pending;
}
