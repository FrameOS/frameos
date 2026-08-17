#include "fos_framebuffer.h"

#ifdef ESP_PLATFORM
#include <stdlib.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "fos_mem.h"

static const char *TAG = "fos_fb";
#endif

bool fos_framebuffer_should_reserve(size_t len, size_t psram_total, size_t internal_free)
{
    if (len == 0) return false;
    /* PSRAM boards allocate these buffers from PSRAM, where a per-render
     * malloc has never been the failing step. Leave that path alone. */
    if (psram_total > 0) return false;
    if (internal_free < len) return false;
    return internal_free - len >= FOS_FRAMEBUFFER_MIN_HEAP_AFTER_RESERVE;
}

#ifdef ESP_PLATFORM

static uint8_t *s_reserved;
static size_t s_reserved_len;
static SemaphoreHandle_t s_lock;

void fos_framebuffer_reserve(size_t len)
{
    if (s_reserved) return;

    size_t psram_total = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);
    size_t internal_free = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!fos_framebuffer_should_reserve(len, psram_total, internal_free)) {
        if (psram_total == 0 && len > 0) {
            ESP_LOGW(TAG, "framebuffer not reserved: the panel needs %u bytes, %u internal "
                          "bytes are free and %u must stay for Wi-Fi/TLS. Renders will "
                          "allocate per cycle and can fail once the heap fragments.",
                     (unsigned)len, (unsigned)internal_free,
                     (unsigned)FOS_FRAMEBUFFER_MIN_HEAP_AFTER_RESERVE);
        }
        return;
    }

    if (!s_lock) s_lock = xSemaphoreCreateMutex();
    if (!s_lock) {
        ESP_LOGW(TAG, "framebuffer not reserved: no memory for the lock");
        return;
    }

    uint8_t *buf = heap_caps_malloc(len, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!buf) {
        /* should_reserve() said it fits, so this means the largest free block
         * is already smaller than the total — i.e. we are being called later
         * than intended. Say so; the fix is the call site, not the size. */
        ESP_LOGW(TAG, "framebuffer not reserved: %u bytes free but no block that big "
                      "(largest=%u) — reserve earlier in boot",
                 (unsigned)internal_free,
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
        return;
    }

    s_reserved = buf;
    s_reserved_len = len;
    ESP_LOGI(TAG, "framebuffer reserved: %u bytes held for the panel (no PSRAM on this "
                  "module), %u internal bytes left for the rest of the system",
             (unsigned)len,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
}

uint8_t *fos_framebuffer_acquire(size_t len)
{
    if (len == 0) return NULL;
    /* Non-blocking on purpose: a console `display_test` asking for the buffer
     * mid-render should fail immediately and say so, not stall the console for
     * the twenty seconds an e-paper refresh takes. */
    if (s_reserved && len == s_reserved_len && s_lock &&
        xSemaphoreTake(s_lock, 0) == pdTRUE) {
        return s_reserved;
    }
    uint8_t *buf = fos_big_malloc(len);
    if (!buf) buf = malloc(len);
    return buf;
}

void fos_framebuffer_release(uint8_t *buf)
{
    if (!buf) return;
    if (buf == s_reserved) {
        xSemaphoreGive(s_lock);
        return;
    }
    free(buf);
}

size_t fos_framebuffer_reserved_bytes(void)
{
    return s_reserved ? s_reserved_len : 0;
}

#endif /* ESP_PLATFORM */
