/* Glue between the firmware and the Nim-generated C (nimcache/).
 * Owns NimMain() (one-shot Nim module init), the log hook, and the
 * outbound-HTTP hook the Nim http_client HAL calls into. */
#include "frameos_nim.h"

#include "fos_netguard.h"

#include <ctype.h>
#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <setjmp.h>
#include <string.h>
#include <limits.h>
#include <strings.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_spiffs.h"
#include "esp_system.h"
#include "esp_vfs_fat.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

/* Nim's os module calls lstat()/readlink(); newlib/VFS has no symlinks, so
 * stat() is exact and every path is a non-symlink (EINVAL per POSIX). */
int lstat(const char *path, struct stat *st)
{
    return stat(path, st);
}

ssize_t readlink(const char *path, char *buf, size_t bufsize)
{
    (void)path; (void)buf; (void)bufsize;
    errno = EINVAL;
    return -1;
}

extern void NimMain(void);
extern bool fos_nim_init_impl(int width, int height, const char *name, int max_http_response_bytes,
                              int rotate);
extern int fos_nim_render_impl(uint8_t *buf, size_t len, int pixel_format);
extern int fos_nim_render_alloc_impl(uint8_t **buf, size_t *len, int pixel_format);
extern int fos_nim_render_1bpp_impl(uint8_t *buf, size_t len);
extern const char *fos_nim_info_impl(void);
extern const char *fos_nim_scene_info_json_impl(void);
extern const char *fos_nim_scene_state_json_impl(void);
extern bool fos_nim_set_scene_impl(const char *scene_id);
extern int fos_nim_load_scenes_impl(const char *json);
extern int fos_nim_set_scene_catalog_impl(const char *index_json);
extern int fos_nim_load_scene_impl(const char *scene_json);
extern void fos_nim_apply_service_settings_impl(const char *json);
extern void fos_nim_set_debug_impl(int enabled);
extern void fos_nim_set_fusion_impl(int enabled);
extern void fos_nim_set_scaling_mode_impl(const char *mode);
extern void fos_nim_set_status_info_impl(const char *info_json);
extern void fos_nim_set_time_zone_impl(const char *time_zone);
extern const char *fos_nim_load_tz_data_impl(const char *slice_json, const char *time_zone);
extern double fos_nim_scene_interval_impl(void);
extern double fos_nim_next_sleep_impl(void);
extern bool fos_nim_render_requested_impl(void);
extern bool fos_nim_send_event_impl(const char *event, const char *payload_json);

static bool s_nim_started = false;
static bool s_nim_ready = false;
static SemaphoreHandle_t s_nim_lock = NULL;
static char s_backend_url[256] = "";
static char s_backend_auth[192] = "";
static bool s_log_upload_configured = false;
static bool s_log_upload_enabled = false;

#define FOS_NIM_LOG_MAX_LINE 1536
#define FOS_NIM_LOG_MAX_PENDING 128
#define FOS_NIM_LOG_BATCH_MAX 8
#define FOS_NIM_LOG_BODY_MAX (8 * 1024)
/* TLS handshakes genuinely need internal-heap headroom; a plain-http POST
 * only needs the client struct + a 2K buffer. A single 48K floor silently
 * disabled log upload forever on frames that idle under it (the 13.3E6
 * with a dozen scenes loaded sits at ~16-19K internal free). */
#define FOS_NIM_LOG_MIN_INTERNAL_FREE_TLS (48 * 1024)
#define FOS_NIM_LOG_MIN_INTERNAL_BLOCK_TLS (16 * 1024)
#define FOS_NIM_LOG_MIN_INTERNAL_FREE_PLAIN (14 * 1024)
#define FOS_NIM_LOG_MIN_INTERNAL_BLOCK_PLAIN (8 * 1024)

typedef struct fos_nim_log_node {
    struct fos_nim_log_node *next;
    char *line;
} fos_nim_log_node_t;

static SemaphoreHandle_t s_log_lock = NULL;
static fos_nim_log_node_t *s_log_head = NULL;
static fos_nim_log_node_t *s_log_tail = NULL;
static size_t s_log_pending = 0;
static size_t s_log_dropped = 0;

static bool nim_lock_take(void)
{
    if (s_nim_lock == NULL) return true;
    return xSemaphoreTake(s_nim_lock, portMAX_DELAY) == pdTRUE;
}

/* Bounded variant for callers that must not park behind a render: the
 * cloud WebSocket task builds its hello from the scene state, and a hello
 * that waits 90 s for a 13.3" render to release the lock arrives long after
 * the hub's 15 s auth timeout closed the socket (seen on the E1004). */
static bool nim_lock_take_for(int timeout_ms)
{
    if (s_nim_lock == NULL) return true;
    if (timeout_ms < 0) return xSemaphoreTake(s_nim_lock, portMAX_DELAY) == pdTRUE;
    return xSemaphoreTake(s_nim_lock, pdMS_TO_TICKS(timeout_ms)) == pdTRUE;
}

static void nim_lock_give(void)
{
    if (s_nim_lock != NULL) xSemaphoreGive(s_nim_lock);
}

/* ------------------------------------------------------- the scene canvas
 *
 * One PSRAM block for the Nim renderer's scene canvas, claimed at boot and
 * never freed. A 1200x1600 canvas is a 3.7 MB contiguous run; after hours of
 * Wi-Fi, TLS and heap churn the allocator may not have one, and "largest free
 * block" is exactly the number the render budget keys on. Claiming it before
 * fos_wifi_init (main.c) is what guarantees it exists, the same way the
 * thin-client framebuffer is reserved. The Nim side wraps it with pixie's
 * newImage565Over and reuses it every render (embedded_runtime.nim). */
static void *s_canvas = NULL;
static size_t s_canvas_len = 0;

bool frameos_nim_reserve_canvas(size_t len)
{
    if (len == 0) return false;
    if (s_canvas != NULL && s_canvas_len >= len) return true;
    void *next = heap_caps_malloc(len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (next == NULL) {
        ESP_LOGW("fos_nim", "canvas: could not reserve %u KB of PSRAM (largest free block %u KB)",
                 (unsigned)(len / 1024),
                 (unsigned)(heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) / 1024));
        return false;
    }
    if (s_canvas != NULL) heap_caps_free(s_canvas);
    s_canvas = next;
    s_canvas_len = len;
    ESP_LOGI("fos_nim", "canvas: reserved %u KB of PSRAM", (unsigned)(len / 1024));
    return true;
}

void *frameos_nim_canvas_buffer(size_t len)
{
    /* Late or larger than reserved (a panel change at runtime): claim now. */
    if (!frameos_nim_reserve_canvas(len)) return NULL;
    return s_canvas;
}

size_t frameos_nim_canvas_reserved(void)
{
    return s_canvas_len;
}

/* The packed buffer allocated during fos_nim_render_alloc_impl is invisible
 * to the OOM longjmp handler, so remember the newest one here (all Nim
 * calls are serialized by s_nim_lock) and free it if the render aborts. */
static void *s_pending_render_buffer = NULL;

/* main/ owns the panel-sized buffer (fos_framebuffer.c reserves it at boot);
 * it hands the acquire/release pair down here so the packed buffer the Nim
 * render fills is that reservation, not a fresh PSRAM allocation that a
 * fragmented heap can refuse. Without the hooks the old malloc path runs. */
static void *(*s_render_buffer_acquire)(size_t len) = NULL;
static void (*s_render_buffer_release)(void *ptr) = NULL;

void frameos_nim_set_render_buffer_hooks(void *(*acquire)(size_t len),
                                         void (*release)(void *ptr))
{
    s_render_buffer_acquire = acquire;
    s_render_buffer_release = release;
}

static void render_buffer_dispose(void *ptr)
{
    if (ptr == NULL) return;
    if (s_render_buffer_release) {
        s_render_buffer_release(ptr);
    } else {
        free(ptr);
    }
}

void *frameos_nim_alloc_render_buffer(size_t len)
{
    void *ptr = NULL;
    if (s_render_buffer_acquire) {
        ptr = s_render_buffer_acquire(len);
    } else {
        ptr = heap_caps_malloc(len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (!ptr) ptr = malloc(len);
    }
    s_pending_render_buffer = ptr;
    return ptr;
}

void frameos_nim_free_render_buffer(void *ptr)
{
    if (ptr != NULL && ptr == s_pending_render_buffer) {
        s_pending_render_buffer = NULL;
    }
    render_buffer_dispose(ptr);
}

/* ---------------------------------------------------------- Nim heap
 *
 * The Nim heap goes to PSRAM, deliberately and explicitly.
 *
 * ESP-IDF is built with CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=16384, so plain
 * malloc() serves everything smaller than 16 KB from INTERNAL RAM. Nearly
 * every Nim allocation is smaller than that — parsed scene graphs, strings,
 * JsonNodes, sequence spines — so the interpreter used to fill the ~300 KB
 * internal pool while megabytes of PSRAM sat idle. A frame with a dozen
 * scenes still rendered (the canvas is big enough to reach PSRAM on its own)
 * but had too little internal RAM left for a TLS handshake, so the cloud link
 * died with what looked like a network error. See the ws_start heap guard in
 * main/fos_cloud.c.
 *
 * Fixing it here rather than by lowering ALWAYSINTERNAL globally: that knob
 * would also push Wi-Fi, lwIP and driver buffers into PSRAM, where DMA cannot
 * reach them. This moves only the Nim heap, which is the actual consumer and
 * never DMAs.
 *
 * Internal RAM stays the fallback: a small allocation that PSRAM cannot serve
 * (fragmentation, or PSRAM absent on a board built with SPIRAM_IGNORE_NOTFOUND)
 * still succeeds rather than turning into a fatal OOM. free() needs no
 * counterpart — heap_caps_free/free accept pointers from either region. */
/* Zero-size requests are rounded up to one byte, and that is load-bearing
 * rather than tidy-mindedness.
 *
 * heap_caps_realloc(ptr, 0, caps) FREES ptr and returns NULL. The caller
 * here cannot tell that apart from a failed allocation, so the obvious
 * `if (next == NULL) next = realloc(ptr, size);` fallback calls realloc on
 * an already-freed pointer — a double free that corrupts the heap. The Nim
 * side compounds it by retrying the same call on the same dead pointer after
 * releasing the emergency reserve.
 *
 * Rounding up also keeps the NULL return meaning exactly one thing —
 * "allocation failed" — which is what patched_malloc.nim treats it as. A
 * zero-size malloc returning NULL would otherwise be reported as an
 * out-of-memory abort. */
void *fos_nim_heap_malloc(size_t size)
{
    if (size == 0) size = 1;
    void *ptr = heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (ptr == NULL) ptr = malloc(size);
    return ptr;
}

void *fos_nim_heap_calloc(size_t count, size_t size)
{
    if (count == 0 || size == 0) { count = 1; size = 1; }
    void *ptr = heap_caps_calloc(count, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (ptr == NULL) ptr = calloc(count, size);
    return ptr;
}

void *fos_nim_heap_realloc(void *ptr, size_t size)
{
    if (size == 0) size = 1;
    void *next = heap_caps_realloc(ptr, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    /* Safe now that size is never 0: a failed heap_caps_realloc leaves the
     * original block untouched, so the fallback gets a live pointer. */
    if (next == NULL) next = realloc(ptr, size);
    return next;
}

/* Live PSRAM headroom for the Nim side (frameos/utils/memory.nim), which
 * derives render allocation and image decode budgets from it. */
size_t fos_psram_free_bytes(void)
{
    return heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
}

size_t fos_psram_largest_free_block(void)
{
    return heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
}

/* Free bytes on the filesystem holding `path`, for the Nim side's
 * getAvailableDiskSpace (utils/system.nim): the spool checks it before
 * spilling an image, so a 1.5 MB canvas is never written onto a 1 MB state
 * partition (it filled the partition, failed, and disabled the disk tier
 * every boot on the generic 8 MB layout). newlib has no statvfs on the
 * ESP-IDF VFS, so the answer comes from the two mounts the firmware makes:
 * the SPIFFS state partition and the FAT SD card at the assets root. -1 for
 * anything else — "unknown", and the write itself stays the last check. */
int64_t fos_vfs_free_bytes(const char *path)
{
    if (path == NULL || path[0] != '/') return -1;
    if (strncmp(path, "/state", 6) == 0 && (path[6] == '\0' || path[6] == '/')) {
        size_t total = 0, used = 0;
        if (esp_spiffs_info("state", &total, &used) != ESP_OK) return -1;
        return total > used ? (int64_t)(total - used) : 0;
    }
    /* esp_vfs_fat_info wants the mount point itself; walk up from the path
     * until a mount answers (the spool dir is <assets>/.cache). */
    char base[128];
    snprintf(base, sizeof(base), "%s", path);
    for (;;) {
        uint64_t total = 0, free_bytes = 0;
        if (esp_vfs_fat_info(base, &total, &free_bytes) == ESP_OK) {
            return free_bytes > (uint64_t)INT64_MAX ? INT64_MAX : (int64_t)free_bytes;
        }
        char *slash = strrchr(base, '/');
        if (slash == NULL || slash == base) return -1;
        *slash = '\0';
    }
}

/* --------------------------------------------- emergency heap reserve
 * The Nim allocator (src/embedded/patched_malloc.nim) cannot raise from a
 * failed malloc without rebooting the device. Instead it releases this
 * PSRAM reserve and retries; the render loop checks
 * fos_nim_emergency_reserve_used() at safe points, sheds memory and
 * re-arms. A device that would previously Guru-Meditate on a large decode
 * now finishes the frame using the reserve. */

#define FOS_NIM_EMERGENCY_RESERVE_BYTES (1024u * 1024u)

static void *s_nim_emergency_reserve = NULL;
static volatile bool s_nim_emergency_used = false;
/* The request that consumed the reserve, and the heap it met: read back by
 * the Nim render loop (recoverEmergencyReserve) for its log line. Recorded
 * here, not logged here — this runs inside a failed malloc. */
static size_t s_nim_emergency_need = 0;
static size_t s_nim_emergency_free_at = 0;
static size_t s_nim_emergency_largest_at = 0;

/* Internal SRAM for the dither's working rows (utils/dither.nim). NULL when
 * internal RAM is too fragmented; the caller falls back to PSRAM. */
void *fos_nim_internal_alloc(size_t size)
{
    if (size == 0) return NULL;
    return heap_caps_malloc(size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}

void fos_nim_internal_free(void *p)
{
    if (p != NULL) heap_caps_free(p);
}

void fos_nim_arm_emergency_reserve(void)
{
    if (s_nim_emergency_reserve == NULL) {
        s_nim_emergency_reserve = heap_caps_malloc(
            FOS_NIM_EMERGENCY_RESERVE_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (s_nim_emergency_reserve == NULL) {
            ESP_LOGW("fos_nim", "could not arm %u byte emergency heap reserve",
                     (unsigned)FOS_NIM_EMERGENCY_RESERVE_BYTES);
        }
    }
    s_nim_emergency_used = false;
}

bool fos_nim_release_emergency_reserve(size_t need)
{
    void *reserve = s_nim_emergency_reserve;
    if (!s_nim_emergency_used) {
        /* First failure of this pass is the one worth naming. */
        s_nim_emergency_need = need;
        s_nim_emergency_free_at = heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        s_nim_emergency_largest_at =
            heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    }
    s_nim_emergency_used = true;
    if (reserve == NULL) {
        return false;
    }
    s_nim_emergency_reserve = NULL;
    heap_caps_free(reserve);
    ESP_LOGW("fos_nim", "heap exhausted: released %u byte emergency reserve for a %u byte "
                        "request (psram free=%u largest=%u)",
             (unsigned)FOS_NIM_EMERGENCY_RESERVE_BYTES, (unsigned)need,
             (unsigned)s_nim_emergency_free_at, (unsigned)s_nim_emergency_largest_at);
    return true;
}

void fos_nim_emergency_reserve_detail(size_t *need, size_t *free_at, size_t *largest_at)
{
    if (need) *need = s_nim_emergency_need;
    if (free_at) *free_at = s_nim_emergency_free_at;
    if (largest_at) *largest_at = s_nim_emergency_largest_at;
}

bool fos_nim_emergency_reserve_used(void)
{
    return s_nim_emergency_used;
}

/* Last-resort OOM containment: when even the reserve-backed retry fails,
 * the patched Nim allocator calls fos_nim_fatal_oom() before raising. If a
 * guarded Nim call is on the stack (all entry points below arm the guard
 * while holding the Nim lock), we longjmp back to C and fail only that
 * call. Skipped destructors leak some heap, which beats rebooting. */

static jmp_buf s_nim_oom_jmp;
static volatile bool s_nim_oom_jmp_armed = false;

void fos_nim_fatal_oom(size_t size)
{
    ESP_LOGE("fos_nim", "unrecoverable allocation failure (%u bytes, internal=%u largest=%u, psram=%u largest=%u)",
             (unsigned)size,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (s_nim_oom_jmp_armed) {
        s_nim_oom_jmp_armed = false;
        longjmp(s_nim_oom_jmp, 1);
    }
    /* No guard armed: fall through to Nim's raiseOutOfMem (log + reboot). */
}

/* A longjmp abort skips every Nim destructor on the abandoned stack, so the
 * aborted call's allocations (render canvas, decode buffers, HTTP chunks)
 * leak with their refcounts stuck — no GC pass can ever reclaim them. One
 * abort is survivable; once the leaks eat the contiguous PSRAM a render
 * canvas needs, every future render is doomed and only a reboot recovers
 * the heap. A device that stays "alive" but can never render again is worse
 * than one clean restart. */
#define FOS_NIM_OOM_ABORT_RESTART_STREAK 4

/* The streak rules above only fire when renders keep failing. A single abort
 * that leaks a big chunk but leaves enough for the decode budget's degrade
 * ladder is worse in practice: every render from then on "succeeds" at half
 * or quarter resolution, the streak resets each time, and the frame shows
 * soft images forever. Seen on a 16 MB 13.3" board: one abort took free
 * PSRAM from 8.6 MB to 4.3 MB (largest block 6 MB -> 1.9 MB) and every
 * photo after it rendered blurry for a day. Leaked memory never comes back,
 * so when one abort has eaten more than this share of what a healthy boot
 * had free, restart right away instead of rendering degraded until the next
 * power cycle. The baseline is taken after the first successful render, the
 * steady state the frame actually lives in. */
#define FOS_NIM_OOM_LEAK_RESTART_PERCENT 50

static int s_frame_width = 0;
static int s_frame_height = 0;
static unsigned s_nim_oom_abort_streak = 0;
static size_t s_psram_free_baseline = 0;

static void nim_note_healthy_render(void)
{
    s_nim_oom_abort_streak = 0;
    if (s_psram_free_baseline == 0) {
        s_psram_free_baseline = heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        ESP_LOGI("fos_nim", "PSRAM baseline after first render: %u bytes free",
                 (unsigned)s_psram_free_baseline);
    }
}

/* main/fos_scenes.c; main/ is not on this component's include path, and the
 * one symbol is not worth a dependency edge. Linked in every build that
 * links this glue (the C3 thin client links the stub, which never aborts). */
void fos_scenes_mark_oom_restart(void);

static void nim_oom_abort_note(const char *what)
{
    s_nim_oom_abort_streak++;
    size_t canvas_bytes = (size_t)s_frame_width * (size_t)s_frame_height * 4u;
    size_t largest = heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    size_t free_psram = heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    bool canvas_impossible = canvas_bytes > 0 && largest < canvas_bytes;
    bool leaked_too_much = s_psram_free_baseline > 0 &&
        free_psram < s_psram_free_baseline / 100u * FOS_NIM_OOM_LEAK_RESTART_PERCENT;
    ESP_LOGE("fos_nim", "%s aborted: out of memory (abort streak %u, PSRAM free %u largest block %u, baseline %u, canvas needs %u)",
             what, s_nim_oom_abort_streak, (unsigned)free_psram, (unsigned)largest,
             (unsigned)s_psram_free_baseline, (unsigned)canvas_bytes);
    bool restart = (s_nim_oom_abort_streak >= 2 && canvas_impossible) ||
                   s_nim_oom_abort_streak >= FOS_NIM_OOM_ABORT_RESTART_STREAK ||
                   leaked_too_much;
    /* The serial line above never reaches the cloud; this one does, so the
     * "render-cycle-failed" it precedes has a cause next to it. */
    char line[360];
    snprintf(line, sizeof(line),
             "{\"event\":\"memory:oomAbort\",\"source\":\"esp32\","
             "\"where\":\"%s\",\"streak\":%u,\"freePsram\":%u,"
             "\"largestPsramBlock\":%u,\"baselinePsram\":%u,"
             "\"status\":\"%s\"}",
             what, s_nim_oom_abort_streak, (unsigned)free_psram, (unsigned)largest,
             (unsigned)s_psram_free_baseline, restart ? "restarting" : "leaked");
    frameos_nim_log_hook(line);
    if (restart) {
        ESP_LOGE("fos_nim", "OOM aborts have leaked the Nim heap beyond recovery; restarting");
        /* Do not come back into the same scene: the boot-time restore runs
         * before the cloud session, so a scene that aborts every time would
         * loop the board with nobody able to switch it. */
        fos_scenes_mark_oom_restart();
        frameos_nim_flush_logs();
        vTaskDelay(pdMS_TO_TICKS(1500)); /* let the log lines drain, cloud included */
        esp_restart();
    }
}

bool frameos_nim_available(void) { return true; }

static void configure_backend_auth(const char *backend_url, const char *api_key)
{
    s_backend_url[0] = '\0';
    s_backend_auth[0] = '\0';
    if (backend_url == NULL || backend_url[0] == '\0') return;

    strlcpy(s_backend_url, backend_url, sizeof(s_backend_url));
    size_t len = strlen(s_backend_url);
    while (len > 0 && s_backend_url[len - 1] == '/') {
        s_backend_url[--len] = '\0';
    }
    if (s_backend_url[0] == '\0') return;

    if (api_key != NULL && api_key[0] != '\0') {
        snprintf(s_backend_auth, sizeof(s_backend_auth), "Bearer %s", api_key);
    }
}

static void ensure_log_lock(void)
{
    if (s_log_lock == NULL) {
        s_log_lock = xSemaphoreCreateMutex();
        if (s_log_lock == NULL) {
            ESP_LOGW("fos_nim_log", "failed to create log upload mutex");
        }
    }
}

static bool log_upload_heap_ready(void)
{
    bool tls = strncmp(s_backend_url, "https://", 8) == 0;
    size_t min_free = tls ? FOS_NIM_LOG_MIN_INTERNAL_FREE_TLS
                          : FOS_NIM_LOG_MIN_INTERNAL_FREE_PLAIN;
    size_t min_block = tls ? FOS_NIM_LOG_MIN_INTERNAL_BLOCK_TLS
                           : FOS_NIM_LOG_MIN_INTERNAL_BLOCK_PLAIN;
    size_t free_internal = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    size_t largest_internal = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (free_internal < min_free || largest_internal < min_block) {
        ESP_LOGD("fos_nim_log", "deferring log upload: internal=%u largest=%u",
                 (unsigned)free_internal, (unsigned)largest_internal);
        return false;
    }
    return true;
}

bool frameos_nim_init(int width, int height, const char *frame_name,
                      uint32_t max_http_response_bytes, const char *backend_url,
                      const char *api_key, bool server_send_logs, int rotate)
{
    s_frame_width = width;
    s_frame_height = height;
    configure_backend_auth(backend_url, api_key);
    s_log_upload_configured = server_send_logs;
    s_log_upload_enabled = false;
    ensure_log_lock();
    if (s_nim_lock == NULL) {
        s_nim_lock = xSemaphoreCreateMutex();
        if (s_nim_lock == NULL) {
            ESP_LOGW("fos_nim", "failed to create Nim runtime mutex");
        }
    }
    if (!nim_lock_take()) return false;
    if (!s_nim_started) {
        NimMain();
        s_nim_started = true;
    }
    s_nim_ready = fos_nim_init_impl(width, height, frame_name, (int)max_http_response_bytes,
                                    rotate);
    nim_lock_give();
    return s_nim_ready;
}

int frameos_nim_render(uint8_t *buf, size_t len, int pixel_format)
{
    if (!s_nim_ready) return -1;
    if (!nim_lock_take()) return -1;
    int result;
    if (setjmp(s_nim_oom_jmp) == 0) {
        s_nim_oom_jmp_armed = true;
        result = fos_nim_render_impl(buf, len, pixel_format);
        if (result == 0) nim_note_healthy_render();
    } else {
        nim_oom_abort_note("render");
        result = -1;
    }
    s_nim_oom_jmp_armed = false;
    nim_lock_give();
    return result;
}

int frameos_nim_render_alloc(uint8_t **buf, size_t *len, int pixel_format)
{
    if (!s_nim_ready || !buf || !len) return -1;
    if (!nim_lock_take()) return -1;
    int result;
    s_pending_render_buffer = NULL;
    if (setjmp(s_nim_oom_jmp) == 0) {
        s_nim_oom_jmp_armed = true;
        result = fos_nim_render_alloc_impl(buf, len, pixel_format);
        if (result == 0) nim_note_healthy_render();
    } else {
        nim_oom_abort_note("render");
        if (s_pending_render_buffer != NULL) {
            render_buffer_dispose(s_pending_render_buffer);
        }
        *buf = NULL;
        *len = 0;
        result = -1;
    }
    /* On success ownership of the packed buffer moves to the caller. */
    s_pending_render_buffer = NULL;
    s_nim_oom_jmp_armed = false;
    nim_lock_give();
    return result;
}

int frameos_nim_render_1bpp(uint8_t *buf, size_t len)
{
    return frameos_nim_render(buf, len, 1);
}

const char *frameos_nim_info(void)
{
    if (!s_nim_ready) return "nim runtime compiled in, not initialized";
    if (!nim_lock_take()) return "nim runtime busy";
    const char *info = fos_nim_info_impl();
    nim_lock_give();
    return info;
}

const char *frameos_nim_scene_info_json_wait(int timeout_ms)
{
    if (!s_nim_ready) return "{\"loaded\":0,\"available\":0,\"hasScene\":false,\"scenes\":[]}";
    if (!nim_lock_take_for(timeout_ms)) return NULL;
    const char *json = fos_nim_scene_info_json_impl();
    nim_lock_give();
    return json;
}

const char *frameos_nim_scene_info_json(void)
{
    const char *json = frameos_nim_scene_info_json_wait(-1);
    return json ? json : "{\"loaded\":0,\"available\":0,\"hasScene\":false,\"busy\":true,\"scenes\":[]}";
}

const char *frameos_nim_scene_state_json_wait(int timeout_ms)
{
    if (!s_nim_ready) return "{}";
    if (!nim_lock_take_for(timeout_ms)) return NULL;
    const char *json = fos_nim_scene_state_json_impl();
    nim_lock_give();
    return json;
}

const char *frameos_nim_scene_state_json(void)
{
    const char *json = frameos_nim_scene_state_json_wait(-1);
    return json ? json : "{\"busy\":true}";
}

bool frameos_nim_scene_snapshot_wait(int timeout_ms, const char **info_json,
                                     const char **state_json)
{
    if (info_json) *info_json = NULL;
    if (state_json) *state_json = NULL;
    if (!s_nim_ready) {
        if (info_json) *info_json = "{\"loaded\":0,\"available\":0,\"hasScene\":false,\"scenes\":[]}";
        if (state_json) *state_json = "{}";
        return true;
    }
    /* One acquisition for both: the two Nim procs write separate static
     * buffers (sceneInfoBuffer / sceneStateBuffer), so both stay valid after
     * the lock is released, until the next call of either. */
    if (!nim_lock_take_for(timeout_ms)) return false;
    if (info_json) *info_json = fos_nim_scene_info_json_impl();
    if (state_json) *state_json = fos_nim_scene_state_json_impl();
    nim_lock_give();
    return true;
}

bool frameos_nim_set_scene(const char *scene_id)
{
    if (!s_nim_ready || scene_id == NULL) return false;
    if (!nim_lock_take()) return false;
    bool ok;
    if (setjmp(s_nim_oom_jmp) == 0) {
        s_nim_oom_jmp_armed = true;
        ok = fos_nim_set_scene_impl(scene_id);
    } else {
        nim_oom_abort_note("scene switch");
        ok = false;
    }
    s_nim_oom_jmp_armed = false;
    nim_lock_give();
    return ok;
}

int frameos_nim_load_scenes(const char *json)
{
    if (!s_nim_ready || json == NULL) return 0;
    if (!nim_lock_take()) return 0;
    int count;
    if (setjmp(s_nim_oom_jmp) == 0) {
        s_nim_oom_jmp_armed = true;
        count = fos_nim_load_scenes_impl(json);
    } else {
        nim_oom_abort_note("scene load");
        count = 0;
    }
    s_nim_oom_jmp_armed = false;
    nim_lock_give();
    return count;
}

int frameos_nim_set_scene_catalog(const char *index_json)
{
    if (!s_nim_ready || index_json == NULL) return 0;
    if (!nim_lock_take()) return 0;
    int result = fos_nim_set_scene_catalog_impl(index_json);
    nim_lock_give();
    return result;
}

int frameos_nim_load_scene(const char *scene_json)
{
    if (!s_nim_ready || scene_json == NULL) return 0;
    if (!nim_lock_take()) return 0;
    int result = fos_nim_load_scene_impl(scene_json);
    nim_lock_give();
    return result;
}

void frameos_nim_set_fusion(int enabled)
{
    if (!s_nim_ready) return;
    if (!nim_lock_take()) return;
    fos_nim_set_fusion_impl(enabled);
    nim_lock_give();
}

void frameos_nim_set_debug(int enabled)
{
    if (!s_nim_ready) return;
    if (!nim_lock_take()) return;
    fos_nim_set_debug_impl(enabled);
    nim_lock_give();
}

void frameos_nim_set_scaling_mode(const char *mode)
{
    if (!s_nim_ready || mode == NULL || mode[0] == '\0') return;
    if (!nim_lock_take()) return;
    fos_nim_set_scaling_mode_impl(mode);
    nim_lock_give();
}

void frameos_nim_set_time_zone(const char *time_zone)
{
    if (!s_nim_ready || time_zone == NULL) return;
    if (!nim_lock_take()) return;
    fos_nim_set_time_zone_impl(time_zone);
    nim_lock_give();
}

bool frameos_nim_load_tz_data(const char *slice_json, const char *time_zone, char *rule_out, size_t rule_len)
{
    if (rule_out && rule_len) rule_out[0] = '\0';
    if (!s_nim_ready || slice_json == NULL || slice_json[0] == '\0') return false;
    if (!nim_lock_take()) return false;
    const char *rule = fos_nim_load_tz_data_impl(slice_json, time_zone ? time_zone : "");
    bool ok = rule != NULL && rule[0] != '\0';
    if (ok && rule_out && rule_len) {
        strlcpy(rule_out, rule, rule_len);
    }
    nim_lock_give();
    return ok;
}

void frameos_nim_set_status_info(const char *info_json)
{
    if (!s_nim_ready || info_json == NULL || info_json[0] == '\0') return;
    if (!nim_lock_take()) return;
    fos_nim_set_status_info_impl(info_json);
    nim_lock_give();
}

double frameos_nim_scene_interval(void)
{
    if (!s_nim_ready) return 0;
    if (!nim_lock_take()) return 0;
    double interval = fos_nim_scene_interval_impl();
    nim_lock_give();
    return interval;
}

double frameos_nim_next_sleep(void)
{
    if (!s_nim_ready) return -1;
    if (!nim_lock_take()) return -1;
    double next_sleep = fos_nim_next_sleep_impl();
    nim_lock_give();
    return next_sleep;
}

bool frameos_nim_render_requested(void)
{
    if (!s_nim_ready) return false;
    if (!nim_lock_take()) return false;
    bool requested = fos_nim_render_requested_impl();
    nim_lock_give();
    return requested;
}

bool frameos_nim_send_event(const char *event, const char *payload_json)
{
    if (!s_nim_ready || event == NULL) return false;
    if (!nim_lock_take()) return false;
    bool ok;
    if (setjmp(s_nim_oom_jmp) == 0) {
        s_nim_oom_jmp_armed = true;
        ok = fos_nim_send_event_impl(event, payload_json ? payload_json : "{}");
    } else {
        nim_oom_abort_note("event dispatch");
        ok = false;
    }
    s_nim_oom_jmp_armed = false;
    nim_lock_give();
    return ok;
}

static void note_log_drop(void)
{
    if (s_log_lock != NULL && xSemaphoreTake(s_log_lock, pdMS_TO_TICKS(5)) == pdTRUE) {
        s_log_dropped++;
        xSemaphoreGive(s_log_lock);
    }
}

static void free_log_nodes(fos_nim_log_node_t *node)
{
    while (node != NULL) {
        fos_nim_log_node_t *next = node->next;
        free(node->line);
        free(node);
        node = next;
    }
}

static void queue_log_line(const char *msg)
{
    if (!s_log_upload_enabled || s_backend_url[0] == '\0' || s_backend_auth[0] == '\0') {
        return;
    }
    ensure_log_lock();
    if (s_log_lock == NULL) return;

    if (msg == NULL) msg = "";
    size_t len = strnlen(msg, FOS_NIM_LOG_MAX_LINE + 1);
    if (len > FOS_NIM_LOG_MAX_LINE) len = FOS_NIM_LOG_MAX_LINE;

    fos_nim_log_node_t *node = heap_caps_malloc(sizeof(*node), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (node == NULL) node = malloc(sizeof(*node));
    char *line = heap_caps_malloc(len + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (line == NULL) line = malloc(len + 1);
    if (node == NULL || line == NULL) {
        free(node);
        free(line);
        note_log_drop();
        return;
    }
    memcpy(line, msg, len);
    line[len] = '\0';
    node->next = NULL;
    node->line = line;

    if (xSemaphoreTake(s_log_lock, pdMS_TO_TICKS(5)) != pdTRUE) {
        free_log_nodes(node);
        return;
    }
    if (s_log_pending >= FOS_NIM_LOG_MAX_PENDING) {
        s_log_dropped++;
        xSemaphoreGive(s_log_lock);
        free_log_nodes(node);
        return;
    }
    if (s_log_tail != NULL) {
        s_log_tail->next = node;
    } else {
        s_log_head = node;
    }
    s_log_tail = node;
    s_log_pending++;
    xSemaphoreGive(s_log_lock);
}

static void (*s_log_tap)(const char *line) = NULL;

void frameos_nim_apply_service_settings(const char *json)
{
    if (!s_nim_ready) return;
    /* A NULL payload is the revocation case: clear every cloud-owned group. */
    if (json == NULL) json = "{}";
    if (!nim_lock_take()) return;
    fos_nim_apply_service_settings_impl(json);
    nim_lock_give();
}

void frameos_nim_set_log_tap(void (*tap)(const char *line))
{
    s_log_tap = tap;
}

/* Ring of the most recent log lines, independent of the backend upload queue
 * (which drains on flush) and the cloud tap (live sessions only). Serves
 * GET /logs, the cloud get_logs verb and `usb_api logs`. Guarded by the same
 * lock as the upload queue. */
static frameos_log_entry_t s_log_ring[FOS_NIM_LOG_RING_CAP];
static size_t s_log_ring_next = 0;
static size_t s_log_ring_count = 0;

static void ring_log_line(const char *msg)
{
    ensure_log_lock();
    if (s_log_lock == NULL || msg == NULL) return;
    size_t len = strnlen(msg, FOS_NIM_LOG_MAX_LINE + 1);
    if (len > FOS_NIM_LOG_MAX_LINE) len = FOS_NIM_LOG_MAX_LINE;
    char *line = heap_caps_malloc(len + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (line == NULL) line = malloc(len + 1);
    if (line == NULL) return;
    memcpy(line, msg, len);
    line[len] = '\0';
    /* time() before SNTP reports seconds-since-boot epoch; consumers treat
     * anything before ~2001 as "no wall clock". */
    double now = (double)time(NULL);
    if (xSemaphoreTake(s_log_lock, pdMS_TO_TICKS(5)) != pdTRUE) {
        free(line);
        return;
    }
    free(s_log_ring[s_log_ring_next].line);
    s_log_ring[s_log_ring_next].line = line;
    s_log_ring[s_log_ring_next].timestamp = now;
    s_log_ring_next = (s_log_ring_next + 1) % FOS_NIM_LOG_RING_CAP;
    if (s_log_ring_count < FOS_NIM_LOG_RING_CAP) s_log_ring_count++;
    xSemaphoreGive(s_log_lock);
}

size_t frameos_nim_log_recent(frameos_log_entry_t *out, size_t max)
{
    if (out == NULL || max == 0 || s_log_lock == NULL) return 0;
    if (xSemaphoreTake(s_log_lock, pdMS_TO_TICKS(50)) != pdTRUE) return 0;
    size_t take = s_log_ring_count < max ? s_log_ring_count : max;
    /* Oldest-first of the newest `take` entries. */
    size_t start = (s_log_ring_next + FOS_NIM_LOG_RING_CAP - take) % FOS_NIM_LOG_RING_CAP;
    size_t copied = 0;
    for (size_t i = 0; i < take; i++) {
        const frameos_log_entry_t *src = &s_log_ring[(start + i) % FOS_NIM_LOG_RING_CAP];
        if (src->line == NULL) continue;
        char *copy = strdup(src->line);
        if (copy == NULL) break;
        out[copied].line = copy;
        out[copied].timestamp = src->timestamp;
        copied++;
    }
    xSemaphoreGive(s_log_lock);
    return copied;
}

void frameos_nim_log_hook(const char *msg)
{
    /* printf, not ESP_LOGI: every FrameOS profile builds with
     * CONFIG_LOG_MAXIMUM_LEVEL=WARN, so the INFO macro this used to be
     * compiled to nothing — no shipped firmware has ever put a device log
     * line on the serial console. That console is the last-resort sink, the
     * one that still works when the backend upload is off, when the cloud
     * session lacks telemetry:logs, or when there is no network at all, so it
     * has to carry these unconditionally. Interleaving with a usb_api base64
     * payload is expected and handled: the browser drops non-base64 lines,
     * verifies the declared length and retries the transfer. */
    printf("%s\n", msg ? msg : "");
    queue_log_line(msg);
    ring_log_line(msg);
    /* The tap runs on whatever task logged; the cloud client's tap only
     * copies the line into its own queue (or drops it). */
    void (*tap)(const char *) = s_log_tap;
    if (tap != NULL && msg != NULL) {
        tap(msg);
    }
}

void frameos_nim_set_log_upload_enabled(bool enabled)
{
    s_log_upload_enabled = s_log_upload_configured && enabled;
}

typedef struct {
    char *data;
    size_t len;
    size_t cap;
} json_buf_t;

static void json_buf_free(json_buf_t *buf)
{
    free(buf->data);
    buf->data = NULL;
    buf->len = 0;
    buf->cap = 0;
}

static bool json_buf_reserve(json_buf_t *buf, size_t extra)
{
    if (extra >= FOS_NIM_LOG_BODY_MAX || buf->len > FOS_NIM_LOG_BODY_MAX - extra - 1) {
        return false;
    }
    size_t need = buf->len + extra + 1;
    if (need <= buf->cap) return true;

    size_t cap = buf->cap ? buf->cap * 2 : 4096;
    while (cap < need && cap < FOS_NIM_LOG_BODY_MAX) {
        cap *= 2;
    }
    if (cap > FOS_NIM_LOG_BODY_MAX) cap = FOS_NIM_LOG_BODY_MAX;
    if (cap < need) return false;

    char *next = NULL;
    if (buf->data == NULL) {
        next = heap_caps_malloc(cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (next == NULL) next = malloc(cap);
    } else {
        next = heap_caps_realloc(buf->data, cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (next == NULL) next = realloc(buf->data, cap);
    }
    if (next == NULL) return false;
    buf->data = next;
    buf->cap = cap;
    return true;
}

static bool json_buf_append_len(json_buf_t *buf, const char *text, size_t len)
{
    if (!json_buf_reserve(buf, len)) return false;
    memcpy(buf->data + buf->len, text, len);
    buf->len += len;
    buf->data[buf->len] = '\0';
    return true;
}

static bool json_buf_append(json_buf_t *buf, const char *text)
{
    return json_buf_append_len(buf, text, strlen(text));
}

static bool json_buf_append_char(json_buf_t *buf, char c)
{
    return json_buf_append_len(buf, &c, 1);
}

static bool json_buf_append_escaped(json_buf_t *buf, const char *text)
{
    if (text == NULL) text = "";
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        switch (*p) {
            case '\\':
                if (!json_buf_append(buf, "\\\\")) return false;
                break;
            case '"':
                if (!json_buf_append(buf, "\\\"")) return false;
                break;
            case '\b':
                if (!json_buf_append(buf, "\\b")) return false;
                break;
            case '\f':
                if (!json_buf_append(buf, "\\f")) return false;
                break;
            case '\n':
                if (!json_buf_append(buf, "\\n")) return false;
                break;
            case '\r':
                if (!json_buf_append(buf, "\\r")) return false;
                break;
            case '\t':
                if (!json_buf_append(buf, "\\t")) return false;
                break;
            default:
                if (*p < 0x20) {
                    char esc[7];
                    snprintf(esc, sizeof(esc), "\\u%04x", *p);
                    if (!json_buf_append(buf, esc)) return false;
                } else if (!json_buf_append_char(buf, (char)*p)) {
                    return false;
                }
                break;
        }
    }
    return true;
}

static bool append_log_payload(json_buf_t *buf, const char *line)
{
    if (line == NULL) line = "";
    const char *start = line;
    while (*start && isspace((unsigned char)*start)) start++;
    const char *end = start + strlen(start);
    while (end > start && isspace((unsigned char)end[-1])) end--;

    if (end > start && start[0] == '{' && end[-1] == '}') {
        return json_buf_append_len(buf, start, (size_t)(end - start));
    }

    return json_buf_append(buf, "{\"event\":\"log\",\"source\":\"esp32\",\"message\":\"") &&
           json_buf_append_escaped(buf, line) &&
           json_buf_append(buf, "\"}");
}

static fos_nim_log_node_t *pop_log_batch(size_t *count, size_t *dropped)
{
    *count = 0;
    *dropped = 0;
    if (s_log_lock == NULL) return NULL;
    if (xSemaphoreTake(s_log_lock, pdMS_TO_TICKS(50)) != pdTRUE) return NULL;

    *dropped = s_log_dropped;
    s_log_dropped = 0;

    fos_nim_log_node_t *head = s_log_head;
    fos_nim_log_node_t *tail = NULL;
    while (s_log_head != NULL && *count < FOS_NIM_LOG_BATCH_MAX) {
        tail = s_log_head;
        s_log_head = s_log_head->next;
        (*count)++;
        s_log_pending--;
    }
    if (tail != NULL) {
        tail->next = NULL;
    }
    if (s_log_head == NULL) {
        s_log_tail = NULL;
    }
    xSemaphoreGive(s_log_lock);
    return head;
}

static esp_err_t post_log_body(const char *body, size_t body_len)
{
    if (body == NULL || body_len == 0 || s_backend_url[0] == '\0' || s_backend_auth[0] == '\0') {
        return ESP_ERR_INVALID_STATE;
    }

    char url[sizeof(s_backend_url) + 16];
    int written = snprintf(url, sizeof(url), "%s/api/log", s_backend_url);
    if (written <= 0 || (size_t)written >= sizeof(url)) {
        return ESP_ERR_INVALID_SIZE;
    }

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 10000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 2048,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) return ESP_FAIL;
    esp_http_client_set_header(client, "Authorization", s_backend_auth);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_header(client, "User-Agent", "FrameOS-ESP32/1");

    esp_err_t err = esp_http_client_open(client, body_len);
    if (err != ESP_OK) {
        ESP_LOGW("fos_nim_log", "POST %s connect failed: %s", url, esp_err_to_name(err));
        esp_http_client_cleanup(client);
        return err;
    }
    size_t offset = 0;
    while (offset < body_len) {
        int sent = esp_http_client_write(client, body + offset, body_len - offset);
        if (sent <= 0) {
            ESP_LOGW("fos_nim_log", "POST %s body write failed", url);
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            return ESP_FAIL;
        }
        offset += (size_t)sent;
    }
    esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    if (status < 200 || status >= 300) {
        ESP_LOGW("fos_nim_log", "POST %s returned HTTP %d", url, status);
        return ESP_FAIL;
    }
    return ESP_OK;
}

void frameos_nim_flush_logs(void)
{
    if (!s_log_upload_enabled || s_backend_url[0] == '\0' || s_backend_auth[0] == '\0') {
        return;
    }
    if (!log_upload_heap_ready()) {
        return;
    }

    while (true) {
        if (!log_upload_heap_ready()) {
            break;
        }
        size_t count = 0;
        size_t dropped = 0;
        fos_nim_log_node_t *batch = pop_log_batch(&count, &dropped);
        if (batch == NULL && dropped == 0) {
            break;
        }

        json_buf_t body = {0};
        bool ok = json_buf_append(&body, "{\"logs\":[");
        bool first = true;
        if (ok && dropped > 0) {
            char dropped_json[128];
            snprintf(dropped_json, sizeof(dropped_json),
                     "{\"event\":\"log:dropped\",\"source\":\"esp32\",\"count\":%lu}",
                     (unsigned long)dropped);
            ok = json_buf_append(&body, dropped_json);
            first = false;
        }
        for (fos_nim_log_node_t *node = batch; ok && node != NULL; node = node->next) {
            if (!first) ok = json_buf_append_char(&body, ',');
            if (ok) ok = append_log_payload(&body, node->line);
            first = false;
        }
        if (ok) ok = json_buf_append(&body, "]}");

        if (ok) {
            post_log_body(body.data, body.len);
        } else {
            ESP_LOGW("fos_nim_log", "dropping log batch: JSON body too large or out of memory");
        }
        json_buf_free(&body);
        free_log_nodes(batch);
    }
}

/* ------------------------------------------------------- outbound HTTP */

static const char *TAG = "fos_nim_http";
/* HTTP bodies are buffered in fixed-size PSRAM chunks so that no download
 * ever needs one large contiguous allocation — a fragmented heap next to a
 * full-size render canvas can still take multi-MB images. The decoders
 * consume the chunks as segments (streamed PNG/JPEG). */
#define FOS_NIM_HTTP_CHUNK_BYTES (512u * 1024u)
#define FOS_NIM_HTTP_CHUNK_MIN_BYTES (64u * 1024u)
/* Keep this much PSRAM free while buffering, for decode rows and friends.
 * Streamed decodes need well under 200KB of working memory; a bigger
 * reserve starves legitimate downloads when a render is already live. */
#define FOS_NIM_HTTP_PSRAM_RESERVE (768u * 1024u)
/* Spill-to-storage: when even the smallest chunk cannot be buffered without
 * breaching the reserve, the body can stream to a temp file instead of
 * failing with BODY_OOM (measured on the bench 2026-08-03: a ~3MB gallery
 * JPEG with 12 scenes resident left ~894KB PSRAM free). The read window is
 * small and internal-RAM-first so spilling itself adds no PSRAM pressure.
 *
 * The path is inert until the firmware registers a spill directory via
 * fos_nim_http_set_spill_dir() (TODO: wire from main.c — /srv/assets/.cache
 * when the SD card is mounted, else /state with a low cap; see
 * cloud/docs/esp32-large-image-spill.md). */
#define FOS_NIM_HTTP_SPILL_IO_BYTES (16u * 1024u)

static char s_http_spill_dir[128] = "";
static size_t s_http_spill_max_bytes = 0;
static uint32_t s_http_spill_seq = 0;
static size_t s_http_spill_force_bytes = 0;

void fos_nim_http_set_spill_dir(const char *dir, size_t max_spill_bytes)
{
    if (dir == NULL || dir[0] == '\0') {
        s_http_spill_dir[0] = '\0';
        s_http_spill_max_bytes = 0;
        return;
    }
    snprintf(s_http_spill_dir, sizeof(s_http_spill_dir), "%s", dir);
    s_http_spill_max_bytes = max_spill_bytes;
}

void fos_nim_http_set_spill_force_bytes(size_t threshold)
{
    s_http_spill_force_bytes = threshold;
}

/* ------------------------------------------------------------------------
 * Streaming fetch: the body is pulled straight off the socket by the caller
 * (pixie's windowed JPEG/PNG decoders on the Nim side) instead of being
 * buffered in PSRAM or spilled to flash first. This is what lets a board
 * whose canvas already owns most of its PSRAM (8 MB reTerminal E1004 with a
 * 1200x1600 panel) show a 2 MB gallery image at all: the buffering path had
 * ~1.5 MB free and a /state partition too small to spill into. */
struct fos_nim_http_stream {
    esp_http_client_handle_t client;
};

static esp_http_client_handle_t http_open_request(
    const char *method, const char *url,
    const void *body, size_t body_len,
    const char *headers, size_t headers_len,
    int timeout_ms, int *out_status, int64_t *out_content_length,
    char *err_buf, size_t err_buf_len);

fos_nim_http_stream *fos_nim_http_stream_open(
    const char *url, const char *headers, size_t headers_len,
    int timeout_ms, int *out_status, int64_t *out_content_length,
    char *err_buf, size_t err_buf_len)
{
    int64_t content_length = -1;
    esp_http_client_handle_t client = http_open_request(
        "GET", url, NULL, 0, headers, headers_len, timeout_ms,
        out_status, &content_length, err_buf, err_buf_len);
    *out_content_length = content_length;
    if (client == NULL) return NULL;
    fos_nim_http_stream *stream = calloc(1, sizeof(*stream));
    if (stream == NULL) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        if (err_buf != NULL && err_buf_len > 0) snprintf(err_buf, err_buf_len, "out of memory");
        return NULL;
    }
    stream->client = client;
    return stream;
}

int fos_nim_http_stream_read(fos_nim_http_stream *stream, void *buf, size_t len)
{
    if (stream == NULL || stream->client == NULL || buf == NULL) return -1;
    if (len > (size_t)INT_MAX) len = INT_MAX;
    return esp_http_client_read(stream->client, (char *)buf, (int)len);
}

void fos_nim_http_stream_close(fos_nim_http_stream *stream)
{
    if (stream == NULL) return;
    if (stream->client != NULL) {
        esp_http_client_close(stream->client);
        esp_http_client_cleanup(stream->client);
        stream->client = NULL;
    }
    free(stream);
}

typedef enum {
    FOS_NIM_BODY_OK,
    FOS_NIM_BODY_OOM,
    FOS_NIM_BODY_TOO_BIG,
    FOS_NIM_BODY_READ_FAILED,
    FOS_NIM_BODY_SPILL_FAILED,
} fos_nim_body_status_t;

void fos_nim_http_free_chunks(fos_nim_http_chunk *chunks, size_t count)
{
    if (chunks == NULL) return;
    for (size_t i = 0; i < count; i++) {
        free(chunks[i].data);
    }
    free(chunks);
}

static uint8_t *http_error_response_v(int *out_status, size_t *out_len,
                                      const char *fmt, va_list args)
{
    char message[256];
    vsnprintf(message, sizeof(message), fmt, args);

    size_t len = strlen(message);
    uint8_t *buf = heap_caps_malloc(len + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (buf == NULL) buf = malloc(len + 1);
    if (buf == NULL) {
        *out_status = 0;
        *out_len = 0;
        return NULL;
    }
    memcpy(buf, message, len + 1);
    *out_status = 599;
    *out_len = len;
    return buf;
}

static uint8_t *http_error_response(int *out_status, size_t *out_len, const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    uint8_t *buf = http_error_response_v(out_status, out_len, fmt, args);
    va_end(args);
    return buf;
}

static fos_nim_http_chunk *chunked_error(int *out_status, size_t *out_count,
                                         const char *fmt, ...)
{
    *out_count = 0;
    va_list args;
    va_start(args, fmt);
    size_t len = 0;
    uint8_t *msg = http_error_response_v(out_status, &len, fmt, args);
    va_end(args);
    if (msg == NULL) return NULL;
    fos_nim_http_chunk *chunks = malloc(sizeof(*chunks));
    if (chunks == NULL) {
        free(msg);
        return NULL;
    }
    chunks[0].data = msg;
    chunks[0].len = len;
    *out_count = 1;
    return chunks;
}

static char *trim_ascii(char *s)
{
    if (s == NULL) return s;
    while (*s == ' ' || *s == '\t' || *s == '\r' || *s == '\n') s++;
    char *end = s + strlen(s);
    while (end > s && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r' || end[-1] == '\n')) {
        *--end = '\0';
    }
    return s;
}

static bool set_extra_headers(esp_http_client_handle_t client, const char *headers, size_t headers_len)
{
    bool has_content_type = false;
    if (headers == NULL || headers_len == 0) return false;

    char *copy = malloc(headers_len + 1);
    if (copy == NULL) {
        ESP_LOGW(TAG, "failed to allocate HTTP header block");
        return false;
    }
    memcpy(copy, headers, headers_len);
    copy[headers_len] = '\0';

    char *line = copy;
    for (char *p = copy; ; p++) {
        if (*p != '\n' && *p != '\0') continue;
        bool done = (*p == '\0');
        *p = '\0';

        char *colon = strchr(line, ':');
        if (colon != NULL) {
            *colon = '\0';
            char *name = trim_ascii(line);
            char *value = trim_ascii(colon + 1);
            if (name[0] != '\0') {
                esp_http_client_set_header(client, name, value);
                if (strcasecmp(name, "Content-Type") == 0) has_content_type = true;
            }
        }

        if (done) break;
        line = p + 1;
    }

    free(copy);
    return has_content_type;
}

/* Streams the rest of an HTTP body to a temp file after PSRAM buffering
 * gave out. Takes ownership of `chunks` unconditionally: the already
 * buffered bytes are written out first and their PSRAM freed as they go.
 * On success *out_path is a malloc'd file path (caller frees with
 * fos_nim_http_free) holding the ENTIRE body and *out_total its size. On
 * failure the partial file is unlinked. */
static fos_nim_body_status_t http_spill_remaining(
    esp_http_client_handle_t client, const char *url,
    fos_nim_http_chunk *chunks, size_t chunk_count,
    size_t buffered, size_t limit,
    char **out_path, size_t *out_total, size_t *out_limit)
{
    *out_path = NULL;
    *out_total = 0;

    /* The storage cap (free /state space on SPIFFS, none on an SD card) can
     * be far below the frame's max_http_response_bytes. Report the cap that
     * actually cut the body, or the "response exceeded 6291456 bytes" error
     * blames a 6 MB limit for a 2 MB image that hit a 400 KB /state cap. */
    size_t spill_limit = limit;
    if (s_http_spill_max_bytes > 0 && s_http_spill_max_bytes < spill_limit) {
        spill_limit = s_http_spill_max_bytes;
    }
    *out_limit = spill_limit;
    if (buffered > spill_limit) {
        fos_nim_http_free_chunks(chunks, chunk_count);
        return FOS_NIM_BODY_TOO_BIG;
    }

    char path[192];
    snprintf(path, sizeof(path), "%s/http-spill-%lu.tmp",
             s_http_spill_dir, (unsigned long)(s_http_spill_seq++));

    FILE *f = fopen(path, "wb");
    if (f == NULL) {
        ESP_LOGW(TAG, "%s: cannot open spill file %s (errno=%d)", url, path, errno);
        fos_nim_http_free_chunks(chunks, chunk_count);
        return FOS_NIM_BODY_SPILL_FAILED;
    }
    /* WARN: spilling is a memory-pressure event (or the spill_force debug
     * knob) and the only runtime evidence the spill path ran — the 32MB
     * profile compiles ESP_LOGI out (CONFIG_LOG_DEFAULT_LEVEL=WARN). */
    ESP_LOGW(TAG, "%s: PSRAM exhausted after %u buffered bytes; spilling body to %s",
             url, (unsigned)buffered, path);

    bool ok = true;
    for (size_t i = 0; i < chunk_count; i++) {
        if (ok && chunks[i].len > 0 &&
            fwrite(chunks[i].data, 1, chunks[i].len, f) != chunks[i].len) {
            ok = false;
        }
        free(chunks[i].data);
        chunks[i].data = NULL;
    }
    free(chunks);

    fos_nim_body_status_t status = ok ? FOS_NIM_BODY_OK : FOS_NIM_BODY_SPILL_FAILED;
    uint8_t *io = NULL;
    if (ok) {
        /* Internal RAM first: the whole point is that PSRAM is exhausted. */
        io = heap_caps_malloc(FOS_NIM_HTTP_SPILL_IO_BYTES,
                              MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        if (io == NULL) io = malloc(FOS_NIM_HTTP_SPILL_IO_BYTES);
        if (io == NULL) {
            ok = false;
            status = FOS_NIM_BODY_SPILL_FAILED;
        }
    }

    size_t total = buffered;
    while (ok) {
        int r = esp_http_client_read(client, (char *)io, FOS_NIM_HTTP_SPILL_IO_BYTES);
        if (r < 0) {
            status = FOS_NIM_BODY_READ_FAILED;
            break;
        }
        if (r == 0) break;
        if (total + (size_t)r > spill_limit) {
            status = FOS_NIM_BODY_TOO_BIG;
            break;
        }
        if (fwrite(io, 1, (size_t)r, f) != (size_t)r) {
            ESP_LOGW(TAG, "%s: spill write failed at %u bytes (errno=%d)",
                     url, (unsigned)total, errno);
            status = FOS_NIM_BODY_SPILL_FAILED;
            break;
        }
        total += (size_t)r;
    }
    free(io);
    fclose(f);
    if (status != FOS_NIM_BODY_OK) {
        unlink(path);
        return status;
    }

    char *dup = strdup(path);
    if (dup == NULL) {
        unlink(path);
        return FOS_NIM_BODY_SPILL_FAILED;
    }
    *out_path = dup;
    *out_total = total;
    ESP_LOGW(TAG, "%s: spilled %u-byte body to %s", url, (unsigned)total, path);
    return FOS_NIM_BODY_OK;
}

/* Everything up to a readable response body, shared by the buffering fetch
 * (fos_nim_http_request_chunked_spill) and the streaming one
 * (fos_nim_http_stream_open): the private-network policy check, client
 * setup, connect, request body, and the manual redirect walk that re-checks
 * the policy on every hop. Returns the open client with the final status in
 * *out_status and the body length in *out_content_length (-1 when unknown).
 * On failure returns NULL with a short diagnostic in err_buf; the client is
 * already cleaned up. */
#define HTTP_OPEN_FAIL(...) \
    do { \
        if (err_buf != NULL && err_buf_len > 0) snprintf(err_buf, err_buf_len, __VA_ARGS__); \
        return NULL; \
    } while (0)

static esp_http_client_handle_t http_open_request(
    const char *method, const char *url,
    const void *body, size_t body_len,
    const char *headers, size_t headers_len,
    int timeout_ms, int *out_status, int64_t *out_content_length,
    char *err_buf, size_t err_buf_len)
{
    *out_status = 0;
    *out_content_length = -1;
    if (err_buf != NULL && err_buf_len > 0) err_buf[0] = '\0';
    /* Private-network policy (fos_netguard.h). This is the one funnel every
     * scene HTTP request goes through, and on a cloud-managed frame a scene is
     * something a provider installed — so it does not get to reach the owner's
     * router. Checked before the client even exists; the redirect loop below
     * re-checks every hop, because a 302 to 192.168.1.1 is the same request. */
    char netguard_reason[96];
    if (!fos_netguard_url_allowed(url, netguard_reason, sizeof(netguard_reason))) {
        ESP_LOGW(TAG, "%s %s: blocked by the local-network policy: %s",
                 method ? method : "GET", url ? url : "(null)", netguard_reason);
        HTTP_OPEN_FAIL("local network access is blocked on cloud-managed frames (%s)",
                             netguard_reason);
    }

    esp_http_client_method_t http_method = HTTP_METHOD_GET;
    if (method != NULL) {
        if (strcmp(method, "POST") == 0) http_method = HTTP_METHOD_POST;
        else if (strcmp(method, "PUT") == 0) http_method = HTTP_METHOD_PUT;
        else if (strcmp(method, "PATCH") == 0) http_method = HTTP_METHOD_PATCH;
        else if (strcmp(method, "DELETE") == 0) http_method = HTTP_METHOD_DELETE;
        else if (strcmp(method, "HEAD") == 0) http_method = HTTP_METHOD_HEAD;
    }

    esp_http_client_config_t config = {
        .url = url,
        .method = http_method,
        .timeout_ms = timeout_ms > 0 ? timeout_ms : 30000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 1024,
        .buffer_size_tx = 4096,
        .max_redirection_count = 5,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        HTTP_OPEN_FAIL("http client init failed");
    }
    esp_http_client_set_header(client, "Accept-Encoding", "identity");
    esp_http_client_set_header(client, "User-Agent", "FrameOS-ESP32/1");
    bool has_content_type = set_extra_headers(client, headers, headers_len);
    /* No implicit Authorization header here: scene HTTP is scene HTTP. The
     * only backend-authed calls the device makes are the firmware's own
     * (log upload below, fos_settings.c's settings poll), which set the
     * header themselves. */

    if (body != NULL && body_len > 0 && !has_content_type) {
        esp_http_client_set_header(client, "Content-Type", "application/json");
    }

    esp_err_t err = esp_http_client_open(client, body_len);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "%s %s: connect failed: %s", method ? method : "GET", url,
                 esp_err_to_name(err));
        esp_http_client_cleanup(client);
        HTTP_OPEN_FAIL("connect failed: %s", esp_err_to_name(err));
    }
    if (body != NULL && body_len > 0) {
        if (esp_http_client_write(client, body, body_len) < 0) {
            ESP_LOGW(TAG, "%s %s: body write failed", method, url);
            esp_http_client_cleanup(client);
            HTTP_OPEN_FAIL("request body write failed");
        }
    }

    int64_t content_length = esp_http_client_fetch_headers(client);
    *out_status = esp_http_client_get_status_code(client);

    /* Follow redirects manually: this open/read flow bypasses
     * esp_http_client_perform(), the only place ESP-IDF honors
     * max_redirection_count. Shared-album short links (photos.app.goo.gl)
     * and http->https upgrades would otherwise surface as 30x errors. */
    int redirects = 0;
    while (redirects < 5 &&
           (*out_status == 301 || *out_status == 302 || *out_status == 303 ||
            *out_status == 307 || *out_status == 308)) {
        char drain[512];
        while (esp_http_client_read(client, drain, sizeof(drain)) > 0) {}
        if (esp_http_client_set_redirection(client) != ESP_OK) break;
        /* The Location header is attacker-controlled even when the first hop
         * was not: an open redirect on a public host, or a provider-installed
         * scene pointing at one, would otherwise walk straight into the LAN.
         * esp_http_client_get_url() renders the URL set_redirection() just
         * installed as "scheme://host:port/path" — always with an explicit
         * port, and with an IPv6 host left unbracketed, which the guard reads
         * as unparseable and therefore refuses. Fine: an IPv6-literal redirect
         * target is not a thing scenes do, and the failure is closed.
         * A truncated render is refused for the same reason. */
        if (fos_netguard_policy_active()) {
            char redirect_url[256];
            bool redirect_ok = false;
            netguard_reason[0] = '\0';
            if (esp_http_client_get_url(client, redirect_url, sizeof(redirect_url)) != ESP_OK ||
                strlen(redirect_url) == sizeof(redirect_url) - 1) {
                strlcpy(netguard_reason, "redirect target unreadable", sizeof(netguard_reason));
            } else {
                redirect_ok = fos_netguard_url_allowed(redirect_url, netguard_reason,
                                                       sizeof(netguard_reason));
            }
            if (!redirect_ok) {
                ESP_LOGW(TAG, "%s %s: redirect blocked by the local-network policy: %s",
                         method ? method : "GET", url, netguard_reason);
                esp_http_client_close(client);
                esp_http_client_cleanup(client);
                HTTP_OPEN_FAIL("local network access is blocked on cloud-managed frames "
                                     "(redirect target: %s)", netguard_reason);
            }
        }
        err = esp_http_client_open(client, body_len);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "%s %s: redirect connect failed: %s", method ? method : "GET", url,
                     esp_err_to_name(err));
            esp_http_client_cleanup(client);
            HTTP_OPEN_FAIL("redirect connect failed: %s",
                                 esp_err_to_name(err));
        }
        if (body != NULL && body_len > 0) {
            if (esp_http_client_write(client, body, body_len) < 0) {
                ESP_LOGW(TAG, "%s %s: redirect body write failed", method ? method : "GET", url);
                esp_http_client_cleanup(client);
                HTTP_OPEN_FAIL("request body write failed");
            }
        }
        content_length = esp_http_client_fetch_headers(client);
        *out_status = esp_http_client_get_status_code(client);
        redirects++;
    }
    *out_content_length = content_length;
    return client;
}
#undef HTTP_OPEN_FAIL

fos_nim_http_chunk *fos_nim_http_request_chunked_spill(
                              const char *method, const char *url,
                              const void *body, size_t body_len,
                              const char *headers, size_t headers_len,
                              int timeout_ms, size_t max_bytes,
                              int *out_status, size_t *out_count,
                              char **out_spill_path, size_t *out_spill_len)
{
    *out_status = 0;
    *out_count = 0;
    if (out_spill_path != NULL) *out_spill_path = NULL;
    if (out_spill_len != NULL) *out_spill_len = 0;
    const bool spill_allowed = out_spill_path != NULL && out_spill_len != NULL &&
                               s_http_spill_dir[0] != '\0';

    char open_err[192];
    int64_t content_length = -1;
    esp_http_client_handle_t client = http_open_request(
        method, url, body, body_len, headers, headers_len, timeout_ms,
        out_status, &content_length, open_err, sizeof(open_err));
    if (client == NULL) {
        return chunked_error(out_status, out_count, "%s", open_err);
    }

    size_t limit = max_bytes ? max_bytes : 10u * 1024u * 1024u;
    if (content_length > 0 && (size_t)content_length > limit) {
        ESP_LOGW(TAG, "%s: response too large (%lld > %u)", url,
                 content_length, (unsigned)limit);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return chunked_error(out_status, out_count, "response too large: %lld > %u bytes",
                             content_length, (unsigned)limit);
    }

    /* Accumulate the body in fixed-size PSRAM chunks: no download needs one
     * contiguous allocation, no matter how fragmented PSRAM is. Only the
     * Nim-side max_bytes and a live free-PSRAM reserve bound the size. */
    fos_nim_http_chunk *chunks = NULL;
    size_t chunk_count = 0, chunk_capacity = 0;
    size_t total = 0;
    size_t cur_cap = 0, cur_len = 0;
    uint8_t *cur = NULL;
    fos_nim_body_status_t body_status = FOS_NIM_BODY_OK;
    /* Whichever bound stopped the body: max_bytes while buffering in PSRAM,
     * or the (possibly much smaller) storage cap once it spilled. */
    size_t effective_limit = limit;

    while (true) {
        if (cur == NULL || cur_len == cur_cap) {
            if (cur != NULL) {
                chunks[chunk_count - 1].len = cur_len;
                cur = NULL;
            }
            if (total >= limit) {
                body_status = FOS_NIM_BODY_TOO_BIG;
                break;
            }
            if (chunk_count == chunk_capacity) {
                size_t new_capacity = chunk_capacity ? chunk_capacity * 2u : 8u;
                fos_nim_http_chunk *new_chunks =
                    realloc(chunks, new_capacity * sizeof(*new_chunks));
                if (new_chunks == NULL) {
                    body_status = FOS_NIM_BODY_OOM;
                    break;
                }
                chunks = new_chunks;
                chunk_capacity = new_capacity;
            }
            size_t want = FOS_NIM_HTTP_CHUNK_BYTES;
            if (want > limit - total) want = limit - total;
            if (want < 1) want = 1;
            uint8_t *buf = NULL;
            /* Debug knob (`set spill_force <bytes>`): pretend PSRAM ran out
             * once this many bytes are buffered, so the spill path can be
             * exercised on a frame with memory to spare. Small bodies
             * (scene JSON, API calls) keep buffering normally. */
            bool force_spill = s_http_spill_force_bytes > 0 && spill_allowed &&
                               total >= s_http_spill_force_bytes;
            if (!force_spill) {
                while (true) {
                    size_t free_spiram =
                        heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
                    if (free_spiram >= want + 1 + FOS_NIM_HTTP_PSRAM_RESERVE) {
                        buf = heap_caps_malloc(want + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
                    }
                    if (buf != NULL) break;
                    if (want <= FOS_NIM_HTTP_CHUNK_MIN_BYTES) break;
                    want /= 2;
                }
            }
            if (buf == NULL) {
                if (spill_allowed) {
                    /* PSRAM cannot hold another chunk without breaching the
                     * reserve: stream what we have plus the rest of the body
                     * to storage. http_spill_remaining owns `chunks` from
                     * here on, success or not. */
                    char *spill_path = NULL;
                    size_t spill_total = 0;
                    body_status = http_spill_remaining(client, url, chunks,
                                                       chunk_count, total, limit,
                                                       &spill_path, &spill_total,
                                                       &effective_limit);
                    chunks = NULL;
                    chunk_count = 0;
                    chunk_capacity = 0;
                    if (body_status == FOS_NIM_BODY_OK) {
                        total = spill_total;
                        *out_spill_path = spill_path;
                        *out_spill_len = spill_total;
                    }
                    break;
                }
                body_status = FOS_NIM_BODY_OOM;
                break;
            }
            chunks[chunk_count].data = buf;
            chunks[chunk_count].len = 0;
            chunk_count++;
            cur = buf;
            cur_cap = want;
            cur_len = 0;
        }
        int r = esp_http_client_read(client, (char *)cur + cur_len, cur_cap - cur_len);
        if (r < 0) {
            ESP_LOGW(TAG, "%s %s: response read failed, internal=%u psram=%u",
                     method ? method : "GET", url,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
            body_status = FOS_NIM_BODY_READ_FAILED;
            break;
        }
        if (r == 0) break;
        cur_len += (size_t)r;
        total += (size_t)r;
    }

    if (cur != NULL) {
        chunks[chunk_count - 1].len = cur_len;
    }

    esp_http_client_close(client);
    esp_http_client_cleanup(client);

    if (body_status != FOS_NIM_BODY_OK) {
        fos_nim_http_free_chunks(chunks, chunk_count);
        switch (body_status) {
        case FOS_NIM_BODY_TOO_BIG:
            if (effective_limit < limit) {
                ESP_LOGW(TAG, "%s: response exceeded the %u byte storage spill cap "
                         "(%s, max_http_response_bytes %u; PSRAM was too full to buffer it)",
                         url, (unsigned)effective_limit, s_http_spill_dir, (unsigned)limit);
                return chunked_error(out_status, out_count,
                                     "response exceeded %u bytes: the image did not fit in "
                                     "free PSRAM and %s has only %u bytes to spare for it",
                                     (unsigned)effective_limit, s_http_spill_dir,
                                     (unsigned)effective_limit);
            }
            ESP_LOGW(TAG, "%s: response exceeded %u bytes", url, (unsigned)limit);
            return chunked_error(out_status, out_count, "response exceeded %u bytes",
                                 (unsigned)limit);
        case FOS_NIM_BODY_READ_FAILED:
            return chunked_error(out_status, out_count, "response read failed");
        case FOS_NIM_BODY_SPILL_FAILED:
            return chunked_error(out_status, out_count,
                                 "spilling HTTP response to storage failed after %u bytes",
                                 (unsigned)total);
        default:
            ESP_LOGW(TAG, "%s: out of memory buffering HTTP response: total=%u internal=%u psram=%u largest_psram=%u",
                     url, (unsigned)total,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
                     (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
            return chunked_error(out_status, out_count,
                                 "out of memory buffering HTTP response: total=%u psram_free=%u",
                                 (unsigned)total,
                                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
        }
    }

    if (chunk_count == 0) {
        /* Empty body: hand back one empty chunk so callers always get a buffer */
        chunks = malloc(sizeof(*chunks));
        if (chunks == NULL) {
            return chunked_error(out_status, out_count, "out of memory");
        }
        chunks[0].data = malloc(1);
        if (chunks[0].data == NULL) {
            free(chunks);
            return chunked_error(out_status, out_count, "out of memory");
        }
        chunks[0].len = 0;
        chunk_count = 1;
    }
    /* NUL-terminate the final chunk (its allocation reserved the byte) for
     * cstring-leaning consumers of coalesced single-chunk bodies. */
    chunks[chunk_count - 1].data[chunks[chunk_count - 1].len] = 0;

    *out_count = chunk_count;
    return chunks;
}

fos_nim_http_chunk *fos_nim_http_request_chunked(
                              const char *method, const char *url,
                              const void *body, size_t body_len,
                              const char *headers, size_t headers_len,
                              int timeout_ms, size_t max_bytes,
                              int *out_status, size_t *out_count)
{
    /* No spill out-params: this variant never spills, matching the historic
     * contract (BODY_OOM error chunk when PSRAM runs out). */
    return fos_nim_http_request_chunked_spill(method, url, body, body_len,
                                              headers, headers_len,
                                              timeout_ms, max_bytes,
                                              out_status, out_count,
                                              NULL, NULL);
}

uint8_t *fos_nim_http_request(const char *method, const char *url,
                              const void *body, size_t body_len,
                              const char *headers, size_t headers_len,
                              int timeout_ms, size_t max_bytes,
                              int *out_status, size_t *out_len)
{
    *out_len = 0;
    size_t count = 0;
    fos_nim_http_chunk *chunks = fos_nim_http_request_chunked(
        method, url, body, body_len, headers, headers_len,
        timeout_ms, max_bytes, out_status, &count);
    if (chunks == NULL) return NULL;
    if (count == 1) {
        uint8_t *buf = chunks[0].data;
        *out_len = chunks[0].len;
        free(chunks);
        return buf;
    }
    size_t total = 0;
    for (size_t i = 0; i < count; i++) total += chunks[i].len;
    uint8_t *buf = heap_caps_malloc(total + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (buf == NULL) buf = malloc(total + 1);
    if (buf == NULL) {
        fos_nim_http_free_chunks(chunks, count);
        return http_error_response(out_status, out_len,
                                   "out of memory coalescing %u byte HTTP response",
                                   (unsigned)total);
    }
    size_t pos = 0;
    for (size_t i = 0; i < count; i++) {
        memcpy(buf + pos, chunks[i].data, chunks[i].len);
        pos += chunks[i].len;
    }
    buf[total] = 0;
    fos_nim_http_free_chunks(chunks, count);
    *out_len = total;
    return buf;
}

void fos_nim_http_free(void *ptr)
{
    free(ptr); /* heap_caps allocations free through the same heap free */
}
