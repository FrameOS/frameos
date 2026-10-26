/* One pixel loop's rows on both cores (frameos/utils/resample.nim: the
 * bilinear draw render/zoomPan runs every frame of a Ken Burns slideshow).
 *
 * On an RGB LCD the render task shares core 1 with the panel's refill
 * interrupt, which takes about half of that core while the panel scans, and
 * core 0 mostly waits on the network. fos_rows_run hands a job's rows out in
 * blocks to the calling task and to a helper pinned to the other core, and
 * returns when every block is drawn. Blocks are claimed one at a time, so
 * the core with more to spare draws more of them.
 *
 * The job is a C callback over raw pointers: it runs on a task the Nim
 * runtime knows nothing about, so it must not allocate, log, raise or touch
 * anything but its own rows. */
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

typedef void (*fos_rows_fn)(void *ctx, int32_t worker, int32_t first, int32_t last);

/* The callback's own frame is a few hundred bytes; internal RAM, because a
 * task stack in PSRAM faults while a flash write has the cache off. */
#define ROWS_HELPER_STACK 3072

static TaskHandle_t s_helper = NULL;
static SemaphoreHandle_t s_done = NULL;
static bool s_unavailable = false;
static atomic_bool s_busy = false;
static fos_rows_fn s_fn;
static void *s_ctx;
static int32_t s_rows;
static int32_t s_block;
static atomic_int s_next;

static void run_blocks(int32_t worker)
{
    for (;;) {
        int32_t first = atomic_fetch_add(&s_next, s_block);
        if (first >= s_rows) return;
        int32_t last = s_rows - first > s_block ? first + s_block : s_rows;
        s_fn(s_ctx, worker, first, last);
    }
}

static void helper_task(void *arg)
{
    (void)arg;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        run_blocks(1);
        xSemaphoreGive(s_done);
    }
}

/* Made by the first job, on the core its caller is not on, at its caller's
 * priority: a lower one would leave the render task waiting out whatever
 * else core 0 runs (a TLS handshake is a second of it) for one block. */
static bool helper_ready(void)
{
#if CONFIG_FREERTOS_NUMBER_OF_CORES > 1
    if (s_helper) return true;
    if (s_unavailable) return false;
    s_done = xSemaphoreCreateBinary();
    BaseType_t core = xPortGetCoreID() == 0 ? 1 : 0;
    if (s_done == NULL ||
        xTaskCreatePinnedToCore(helper_task, "fos_rows", ROWS_HELPER_STACK, NULL, uxTaskPriorityGet(NULL),
                                &s_helper, core) != pdPASS) {
        if (s_done) vSemaphoreDelete(s_done);
        s_done = NULL;
        s_helper = NULL;
        s_unavailable = true;
        return false;
    }
    return true;
#else
    return false;
#endif
}

/* How many workers a job gets, so the caller sizes per-worker scratch. */
int32_t fos_rows_workers(void)
{
    return helper_ready() ? 2 : 1;
}

/* Runs fn over rows [0, rows) in blocks of `block`, worker 0 on the calling
 * task and worker 1 on the helper. A job that fits one block, a single-core
 * chip and a call while another job runs all take every row on the caller. */
void fos_rows_run(fos_rows_fn fn, void *ctx, int32_t rows, int32_t block)
{
    if (rows <= 0) return;
    if (block <= 0 || block > rows) block = rows;
    if (rows == block || !helper_ready() || atomic_exchange(&s_busy, true)) {
        fn(ctx, 0, 0, rows);
        return;
    }
    s_fn = fn;
    s_ctx = ctx;
    s_rows = rows;
    s_block = block;
    atomic_store(&s_next, 0);
    xTaskNotifyGive(s_helper);
    run_blocks(0);
    xSemaphoreTake(s_done, portMAX_DELAY);
    atomic_store(&s_busy, false);
}
