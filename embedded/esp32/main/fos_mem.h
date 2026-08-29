#ifndef FOS_MEM_H
#define FOS_MEM_H

#include "esp_heap_caps.h"
#include "esp_log.h"

// Large-buffer allocation. On boards with PSRAM these buffers must come from
// PSRAM only: exhausting it is contained there, and internal SRAM stays free
// for the Wi-Fi/TLS stacks. On PSRAM-less chips (the ESP32-C3 thin clients)
// the same call sites use the internal heap — "no PSRAM" must mean "small
// heap", not "every allocation fails". Callers handle NULL either way.
static inline void *fos_big_malloc(size_t size)
{
    if (heap_caps_get_total_size(MALLOC_CAP_SPIRAM) > 0) {
        return heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    }
    return heap_caps_malloc(size, MALLOC_CAP_8BIT);
}

static inline void *fos_big_realloc(void *ptr, size_t size)
{
    if (heap_caps_get_total_size(MALLOC_CAP_SPIRAM) > 0) {
        return heap_caps_realloc(ptr, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    }
    return heap_caps_realloc(ptr, size, MALLOC_CAP_8BIT);
}

// Internal RAM as malloc() sees it.
//
// heap_caps_get_free_size(MALLOC_CAP_INTERNAL) sums every heap that carries
// the INTERNAL cap, including ones WITHOUT MALLOC_CAP_DEFAULT — chiefly the
// CONFIG_SPIRAM_MALLOC_RESERVE_INTERNAL pool (64 KB in sdkconfig.defaults).
// ESP-IDF carves that pool out at boot as a last-resort DMA|INTERNAL region
// (esp_psram_extram_reserve_dma_pool) that malloc(), lwIP's pbufs and the
// socket side of a TLS dial can never draw from. So the familiar "internal
// free" figure overstates what a cloud dial or an HTTPS fetch can actually
// get by up to the size of that pool. These report the DEFAULT-capable
// subset: the number the network stack lives on. Keep the plain INTERNAL
// figures too — every threshold in this firmware was calibrated against
// them on hardware, and the two are compared side by side in `status`,
// `heapinfo` and the metrics sample until the floors are re-measured.
static inline size_t fos_mem_internal_malloc_free(void)
{
    return heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_DEFAULT);
}

static inline size_t fos_mem_internal_malloc_largest(void)
{
    return heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_DEFAULT | MALLOC_CAP_8BIT);
}

// One always-on heap line per boot milestone: internal free / largest block /
// lowest-ever free, plus PSRAM free when the module has any. Cheap enough to
// keep on in shipping firmware — the point is that a field log answers "what
// ate the heap on this board" without a -DFRAMEOS_BOOTMEM=1 rebuild. On a
// PSRAM-less C3 the whole system lives in ~170 KB after static data, and the
// difference between "renders" and "httpd_start failed" is a few KB.
#define FOS_MEM_LOG_MILESTONE(tag, stage)                                              \
    ESP_LOGI(tag, "heap %-16s internal free=%u largest=%u min-ever=%u psram free=%u", \
             stage,                                                                    \
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT), \
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT), \
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT), \
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM))

#endif // FOS_MEM_H
