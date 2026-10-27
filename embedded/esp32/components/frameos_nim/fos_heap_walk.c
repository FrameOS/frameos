#include "fos_heap_walk.h"

#include "esp_heap_caps.h"
#include "esp_ipc.h"
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

size_t fos_heap_largest_free_block(uint32_t caps)
{
    heap_walk_t walk = {.caps = caps, .largest = 0};
#if CONFIG_FREERTOS_NUMBER_OF_CORES > 1 && CONFIG_ESP_IPC_ENABLE
    if (xPortGetCoreID() != 0 && !xPortInIsrContext() &&
        xTaskGetSchedulerState() == taskSCHEDULER_RUNNING &&
        esp_ipc_call_blocking(0, walk_here, &walk) == ESP_OK) {
        return walk.largest;
    }
#endif
    walk_here(&walk);
    return walk.largest;
}
