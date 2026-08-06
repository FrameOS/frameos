#ifndef FOS_MEM_H
#define FOS_MEM_H

#include "esp_heap_caps.h"

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

#endif // FOS_MEM_H
