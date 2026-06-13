#include "frameos_display.h"

#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"

#include "DEV_Config.h"

static const char *TAG = "fos_display";

const char *fos_selected_panel_name(void);
int fos_selected_panel_width(void);
int fos_selected_panel_height(void);
int fos_selected_panel_format(void);
int fos_selected_panel_requires_cs2(void);
int fos_selected_panel_driver_init(void);
void fos_selected_panel_clear(void);
void fos_selected_panel_display(uint8_t *buf);
void fos_selected_panel_sleep(void);

static bool s_panel_present = false;
static bool s_module_ready = false;

static size_t panel_buffer_size(int width, int height, fos_pixel_format_t format)
{
    if (width <= 0 || height <= 0) return 0;
    switch (format) {
        case FOS_PIXEL_1BPP:
            return (((size_t)width + 7u) / 8u) * (size_t)height;
        case FOS_PIXEL_DUAL_1BPP_RED:
        case FOS_PIXEL_DUAL_1BPP_YELLOW:
            return (((size_t)width + 7u) / 8u) * (size_t)height * 2u;
        case FOS_PIXEL_2BPP_GRAY:
        case FOS_PIXEL_2BPP_BWYR:
            return (((size_t)width + 3u) / 4u) * (size_t)height;
        case FOS_PIXEL_4BPP_7COLOR:
        case FOS_PIXEL_4BPP_SPECTRA6:
        case FOS_PIXEL_4BPP_GRAY:
            return (((size_t)width + 1u) / 2u) * (size_t)height;
        default:
            return 0;
    }
}

esp_err_t fos_display_init(const fos_display_config_t *config)
{
    s_panel_present = false;
    if (!config) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!config->panel || !config->panel[0] || strcmp(config->panel, "none") == 0) {
        ESP_LOGI(TAG, "no panel configured (headless)");
        return ESP_OK;
    }

    const char *selected = fos_selected_panel_name();
    if (!selected || strcmp(selected, "none") == 0 || strcmp(selected, config->panel) != 0) {
        ESP_LOGE(TAG, "panel %s is not compiled into this firmware (selected=%s)",
                 config->panel, selected ? selected : "none");
        return ESP_ERR_NOT_FOUND;
    }
    if (fos_selected_panel_requires_cs2() && config->cs2 < 0) {
        ESP_LOGE(TAG, "panel %s requires pins.cs2 for the second chip-select", selected);
        return ESP_ERR_INVALID_ARG;
    }

    DEV_SetPinConfig(config->rst, config->dc, config->cs, config->cs2, config->busy,
                     config->sck, config->mosi, config->pwr);
    s_panel_present = true;
    ESP_LOGI(TAG, "panel %s (%dx%d, fmt=%d, %u byte buffer)", selected,
             fos_display_width(), fos_display_height(), (int)fos_display_format(),
             (unsigned)fos_display_buffer_size());
    return ESP_OK;
}

bool fos_display_present(void) { return s_panel_present; }
int fos_display_width(void) { return s_panel_present ? fos_selected_panel_width() : 0; }
int fos_display_height(void) { return s_panel_present ? fos_selected_panel_height() : 0; }
fos_pixel_format_t fos_display_format(void)
{
    return s_panel_present ? (fos_pixel_format_t)fos_selected_panel_format() : FOS_PIXEL_1BPP;
}

size_t fos_display_buffer_size(void)
{
    return panel_buffer_size(fos_display_width(), fos_display_height(), fos_display_format());
}

size_t fos_display_panel_count(void)
{
    return strcmp(fos_selected_panel_name(), "none") == 0 ? 0u : 1u;
}

const char *fos_display_panel_name(size_t index)
{
    return index == 0 && fos_display_panel_count() == 1 ? fos_selected_panel_name() : "";
}

int fos_display_panel_width(size_t index)
{
    return index == 0 && fos_display_panel_count() == 1 ? fos_selected_panel_width() : 0;
}

int fos_display_panel_height(size_t index)
{
    return index == 0 && fos_display_panel_count() == 1 ? fos_selected_panel_height() : 0;
}

fos_pixel_format_t fos_display_panel_format(size_t index)
{
    return index == 0 && fos_display_panel_count() == 1
        ? (fos_pixel_format_t)fos_selected_panel_format()
        : FOS_PIXEL_1BPP;
}

/* Headroom beyond the two framebuffers for the Nim heap, QuickJS (capped at
 * 4MB but typically far less), pixie temporaries (fonts, gradients) and
 * allocator fragmentation. Empirically ~1.5MB is comfortable for the 800x480
 * scenes M2/M3 verified on an 8MB module. */
#define FOS_RENDER_PSRAM_RESERVE (1536u * 1024u)

size_t fos_display_render_psram_bytes(void)
{
    if (!s_panel_present) return 0;
    size_t rgba = (size_t)fos_display_width() * (size_t)fos_display_height() * 4u;
    return rgba + fos_display_buffer_size() + FOS_RENDER_PSRAM_RESERVE;
}

static esp_err_t ensure_module(void)
{
    if (s_module_ready) return ESP_OK;
    if (DEV_Module_Init() != 0) {
        return ESP_FAIL;
    }
    s_module_ready = true;
    return ESP_OK;
}

esp_err_t fos_display_blit(const uint8_t *buf, size_t len)
{
    if (!s_panel_present) return ESP_ERR_INVALID_STATE;
    if (!buf || len != fos_display_buffer_size()) return ESP_ERR_INVALID_SIZE;
    esp_err_t err = ensure_module();
    if (err != ESP_OK) return err;

    int64_t start = esp_timer_get_time();
    if (fos_selected_panel_driver_init() != 0) {
        ESP_LOGE(TAG, "panel init failed");
        return ESP_FAIL;
    }
    fos_selected_panel_display((uint8_t *)buf);
    fos_selected_panel_sleep();
    ESP_LOGI(TAG, "blit + refresh took %lld ms", (esp_timer_get_time() - start) / 1000);
    return ESP_OK;
}

esp_err_t fos_display_clear(void)
{
    if (!s_panel_present) return ESP_ERR_INVALID_STATE;
    esp_err_t err = ensure_module();
    if (err != ESP_OK) return err;
    if (fos_selected_panel_driver_init() != 0) return ESP_FAIL;
    fos_selected_panel_clear();
    fos_selected_panel_sleep();
    return ESP_OK;
}
