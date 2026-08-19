#include "frameos_display.h"

#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"

#include "DEV_Config.h"
#include "frameos_panel_table.h"
#include "photo_painter_pmic.h"

static const char *TAG = "fos_display";

void EPD_7IN3E_SetPhotoPainterMode(int enabled) __attribute__((weak));
void EPD_13IN3E_SetVariant(int variant) __attribute__((weak));
#define FOS_EPD_13IN3E_VARIANT_WAVESHARE 0
#define FOS_EPD_13IN3E_VARIANT_T133A01 1

static const fos_panel_entry_t *s_panel = NULL;
static bool s_module_ready = false;

static bool is_photo_painter_hardware(const fos_display_config_t *config)
{
    return config && config->hardware_preset &&
           strcmp(config->hardware_preset, "waveshare_esp32_s3_photopainter") == 0;
}

/* Seeed reTerminal E1004: the same 1200x1600 Spectra 6 panel class as the
 * Waveshare 13.3" E6 and driven by the same EPD_13in3e code, but its T133A01
 * panel wants the vendor's own analogue tuning in the init sequence. Like the
 * PhotoPainter PMIC, that is a fact about the board, so the preset selects
 * it; the panel key stays EPD_13in3e everywhere else. */
static bool is_reterminal_e1004_hardware(const fos_display_config_t *config)
{
    return config && config->hardware_preset &&
           strcmp(config->hardware_preset, "seeed_reterminal_e1004") == 0;
}

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
    s_panel = NULL;
    if (!config) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!config->panel || !config->panel[0] || strcmp(config->panel, "none") == 0) {
        ESP_LOGI(TAG, "no panel configured (headless)");
        return ESP_OK;
    }

    const fos_panel_entry_t *entry = NULL;
    for (size_t i = 0; i < fos_panel_table_count; i++) {
        if (strcmp(fos_panel_table[i].name, config->panel) == 0) {
            entry = &fos_panel_table[i];
            break;
        }
    }
    if (!entry) {
        ESP_LOGE(TAG, "panel %s is not supported by this firmware", config->panel);
        return ESP_ERR_NOT_FOUND;
    }
    if (entry->requires_cs2 && config->cs2 < 0) {
        ESP_LOGE(TAG, "panel %s requires pins.cs2 for the second chip-select", entry->name);
        return ESP_ERR_INVALID_ARG;
    }

    bool photo_painter = is_photo_painter_hardware(config);
    if (EPD_7IN3E_SetPhotoPainterMode) {
        EPD_7IN3E_SetPhotoPainterMode(photo_painter ? 1 : 0);
    }
    if (EPD_13IN3E_SetVariant) {
        EPD_13IN3E_SetVariant(is_reterminal_e1004_hardware(config)
                                  ? FOS_EPD_13IN3E_VARIANT_T133A01
                                  : FOS_EPD_13IN3E_VARIANT_WAVESHARE);
    }

    if (photo_painter) {
        esp_err_t pmic_err = fos_photo_painter_enable_epd_power();
        if (pmic_err != ESP_OK) {
            ESP_LOGW(TAG, "PhotoPainter PMIC EPD power init failed: %s",
                     esp_err_to_name(pmic_err));
        }
    }

    DEV_SetPinConfig(config->rst, config->dc, config->cs, config->cs2, config->busy,
                     config->sck, config->mosi, config->pwr);
    s_panel = entry;
    ESP_LOGI(TAG, "panel %s (%dx%d, fmt=%d, %u byte buffer)", entry->name,
             fos_display_width(), fos_display_height(), (int)fos_display_format(),
             (unsigned)fos_display_buffer_size());
    return ESP_OK;
}

bool fos_display_present(void) { return s_panel != NULL; }
const char *fos_display_selected_panel(void) { return s_panel ? s_panel->name : "none"; }
int fos_display_width(void) { return s_panel ? s_panel->width : 0; }
int fos_display_height(void) { return s_panel ? s_panel->height : 0; }
fos_pixel_format_t fos_display_format(void)
{
    return s_panel ? (fos_pixel_format_t)s_panel->format : FOS_PIXEL_1BPP;
}

size_t fos_display_buffer_size(void)
{
    return panel_buffer_size(fos_display_width(), fos_display_height(), fos_display_format());
}

size_t fos_display_panel_count(void)
{
    return fos_panel_table_count;
}

const char *fos_display_panel_name(size_t index)
{
    return index < fos_panel_table_count ? fos_panel_table[index].name : "";
}

int fos_display_panel_width(size_t index)
{
    return index < fos_panel_table_count ? fos_panel_table[index].width : 0;
}

int fos_display_panel_height(size_t index)
{
    return index < fos_panel_table_count ? fos_panel_table[index].height : 0;
}

fos_pixel_format_t fos_display_panel_format(size_t index)
{
    return index < fos_panel_table_count
        ? (fos_pixel_format_t)fos_panel_table[index].format
        : FOS_PIXEL_1BPP;
}

/* Headroom beyond the two framebuffers for the Nim heap, QuickJS (capped at
 * 4MB but typically far less), pixie temporaries (fonts, gradients) and
 * allocator fragmentation. Empirically ~1.5MB is comfortable for the 800x480
 * scenes have been verified on an 8MB module; the 2026-08-14 probe on that
 * module measured ~1.3 MB of non-canvas render peak. Keep in sync with
 * EMBEDDED_RENDER_PSRAM_RESERVE_BYTES (backend) and EmbeddedReserveBytes
 * (frameos/src/frameos/utils/memory.nim). */
#define FOS_RENDER_PSRAM_RESERVE (1536u * 1024u)

size_t fos_display_canvas_bytes(void)
{
    if (!s_panel) return 0;
    return (size_t)fos_display_width() * (size_t)fos_display_height() *
           (size_t)FOS_RENDER_CANVAS_BYTES_PER_PIXEL;
}

size_t fos_display_render_psram_bytes(void)
{
    if (!s_panel) return 0;
    return fos_display_canvas_bytes() + fos_display_buffer_size() + FOS_RENDER_PSRAM_RESERVE;
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
    if (!s_panel) return ESP_ERR_INVALID_STATE;
    if (!buf || len != fos_display_buffer_size()) return ESP_ERR_INVALID_SIZE;
    esp_err_t err = ensure_module();
    if (err != ESP_OK) return err;

    int64_t start = esp_timer_get_time();
    if (s_panel->driver_init() != 0) {
        ESP_LOGE(TAG, "panel init failed");
        return ESP_FAIL;
    }
    s_panel->display((uint8_t *)buf);
    s_panel->sleep();
    ESP_LOGI(TAG, "blit + refresh took %lld ms", (esp_timer_get_time() - start) / 1000);
    return ESP_OK;
}

esp_err_t fos_display_clear(void)
{
    if (!s_panel) return ESP_ERR_INVALID_STATE;
    esp_err_t err = ensure_module();
    if (err != ESP_OK) return err;
    if (s_panel->driver_init() != 0) return ESP_FAIL;
    s_panel->clear();
    s_panel->sleep();
    return ESP_OK;
}
