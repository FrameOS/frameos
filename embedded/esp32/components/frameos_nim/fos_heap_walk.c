#include "fos_heap_walk.h"

#include "esp_heap_caps.h"
#include "esp_ipc.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

typedef struct {
    uint32_t caps;
    size_t largest;
} heap_walk_t;

static void walk_here(void *arg)
{
    heap_walk_t *walk = (heap_walk_t *)arg;
    walk->largest = heap_caps_get_largest_free_block(walk->caps);
}

/* The newest PSRAM reading, for fos_heap_psram_largest_cached. */
static volatile size_t s_psram_largest;
static volatile uint32_t s_psram_largest_at_ms;
static volatile bool s_psram_largest_known;

size_t fos_heap_largest_free_block(uint32_t caps)
{
    heap_walk_t walk = {.caps = caps, .largest = 0};
#if CONFIG_FREERTOS_NUMBER_OF_CORES > 1 && CONFIG_ESP_IPC_ENABLE
    if (!(xPortGetCoreID() != 0 && !xPortInIsrContext() &&
          xTaskGetSchedulerState() == taskSCHEDULER_RUNNING &&
          esp_ipc_call_blocking(0, walk_here, &walk) == ESP_OK))
#endif
        walk_here(&walk);
    if (caps == (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)) {
        s_psram_largest = walk.largest;
        s_psram_largest_at_ms = (uint32_t)(esp_timer_get_time() / 1000);
        s_psram_largest_known = true;
    }
    return walk.largest;
}

size_t fos_heap_psram_largest_cached(uint32_t max_age_ms)
{
    if (s_psram_largest_known &&
        (uint32_t)(esp_timer_get_time() / 1000) - s_psram_largest_at_ms <= max_age_ms) {
        return s_psram_largest;
    }
    return fos_heap_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
}
