#include "frameos_display.h"

#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"

#include "DEV_Config.h"
#include "fos_partial_refresh.h"
#include "frameos_panel_table.h"
#include "it8951.h"
#include "lcd_st7701s_rgb.h"
#include "photo_painter_pmic.h"

static const char *TAG = "fos_display";

void EPD_7IN3E_SetPhotoPainterMode(int enabled) __attribute__((weak));
void EPD_13IN3E_SetVariant(int variant) __attribute__((weak));
#define FOS_EPD_13IN3E_VARIANT_WAVESHARE 0
#define FOS_EPD_13IN3E_VARIANT_T133A01 1

static const fos_panel_entry_t *s_panel = NULL;
static bool s_module_ready = false;
static void *(*s_lend_i2c_bus)(int sda, int scl) = NULL;

/* What a panel with a partial waveform shows, byte for byte: every picture
 * that reaches the glass goes through fos_display_blit or fos_display_update
 * and is copied here, whoever drew it (a status screen, an overlay). */
static const fos_panel_partial_t *s_partial = NULL;
static uint8_t *s_glass = NULL;
static bool s_glass_known = false;
static uint32_t s_partials_since_full = 0;
/* The panel is left awake after a partial update, its analog supply on: its
 * reset and deep sleep are 300 ms of every update, and the next tap is usually
 * moments away. A few idle seconds turn the supply off and keep the controller
 * awake, which costs the next tap under 100 ms; minutes put it in deep sleep. */
static bool s_panel_awake = false;
static bool s_panel_rested = false;
static int64_t s_last_partial_us = 0;
#define FOS_PANEL_ANALOG_US (10 * 1000000LL)
#define FOS_PANEL_AWAKE_US (300 * 1000000LL)
/* The IT8951's standby is not rested: its first waveform after one costs 600
 * ms more than the next (measured on a reTerminal E1003, 2026-11-09), so it
 * stays up until the panel is parked. */
/* The ghosts a tapping session left (fos_partial_refresh.h), once it is
 * clearly over: the refresh is seconds in which a tap would wait. */
#define FOS_PANEL_CLEAN_US (30 * 1000000LL)
/* After this long without a tap the greys a tapping session drew as a halftone
 * go up properly (it8951.c). */
#define FOS_PANEL_SETTLE_US (2500 * 1000LL)
/* A partial update sends two whole frames: the SSD1677's rated write clock. */
#define FOS_PARTIAL_SPI_HZ (20 * 1000 * 1000)

static bool is_photo_painter_hardware(const fos_display_config_t *config)
{
    return config && config->hardware_preset &&
           strcmp(config->hardware_preset, "waveshare_esp32_s3_photopainter") == 0;
}

/* Seeed reTerminal E1004 and XIAO EE02: the same 1200x1600 Spectra 6 panel
 * class as the Waveshare 13.3" E6 and driven by the same EPD_13in3e code, but
 * their T133A01 panel wants the vendor's own analogue tuning in the init
 * sequence. Like the PhotoPainter PMIC, that is a fact about the board, so
 * the preset selects it; the panel key stays EPD_13in3e everywhere else. */
static bool has_t133a01_panel(const fos_display_config_t *config)
{
    return config && config->hardware_preset &&
           (strcmp(config->hardware_preset, "seeed_reterminal_e1004") == 0 ||
            strcmp(config->hardware_preset, "seeed_xiao_ee02") == 0);
}

/* Seeed reTerminal E1003 and XIAO EE03: the Waveshare 10.3" HAT's ED103TC2
 * behind the same IT8951, panel key EPD_10in3, but Seeed's own build of it:
 * its own VCOM, columns that run right to left and a controller that must be
 * told the temperature (it8951.c; Seeed_GFX2 drives both boards the same).
 * Selected by the preset, like the T133A01 tuning. */
static bool has_seeed_it8951_panel(const fos_display_config_t *config)
{
    return config && config->hardware_preset &&
           (strcmp(config->hardware_preset, "seeed_reterminal_e1003") == 0 ||
            strcmp(config->hardware_preset, "seeed_xiao_ee03") == 0);
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
        case FOS_PIXEL_RGB565:
            return (size_t)width * (size_t)height * 2u;
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
    if (entry->bus == FOS_PANEL_BUS_SPI_READ && config->dc < 0) {
        ESP_LOGE(TAG, "panel %s answers on MISO: set pins.dc to the controller's MISO GPIO", entry->name);
        return ESP_ERR_INVALID_ARG;
    }

    bool photo_painter = is_photo_painter_hardware(config);
    if (EPD_7IN3E_SetPhotoPainterMode) {
        EPD_7IN3E_SetPhotoPainterMode(photo_painter ? 1 : 0);
    }
    if (EPD_13IN3E_SetVariant) {
        EPD_13IN3E_SetVariant(has_t133a01_panel(config)
                                  ? FOS_EPD_13IN3E_VARIANT_T133A01
                                  : FOS_EPD_13IN3E_VARIANT_WAVESHARE);
    }
    fos_it8951_set_variant(has_seeed_it8951_panel(config) ? FOS_IT8951_VARIANT_SEEED_E1003
                                                          : FOS_IT8951_VARIANT_WAVESHARE);

    /* The RGB LCD's control wiring (its IO expander, its 3-wire SPI, its
     * backlight) is the board's, not the panel's: the preset picks the
     * table, like the PhotoPainter's PMIC and the E1004's panel tuning. */
    fos_lcd_st7701s_select_board(config->hardware_preset);

    if (photo_painter) {
        esp_err_t pmic_err = fos_photo_painter_enable_epd_power(s_lend_i2c_bus);
        if (pmic_err != ESP_OK) {
            ESP_LOGW(TAG, "PhotoPainter PMIC EPD power init failed: %s",
                     esp_err_to_name(pmic_err));
        }
    }

    DEV_SetPinConfig(config->rst, config->dc, config->cs, config->cs2, config->busy,
                     config->sck, config->mosi, config->pwr);
    s_partial = NULL;
    for (size_t i = 0; i < FOS_PANEL_PARTIAL_COUNT; i++) {
        if (strcmp(fos_panel_partial_table[i].name, entry->name) == 0) s_partial = &fos_panel_partial_table[i];
    }
    if (entry->bus == FOS_PANEL_BUS_SPI_READ) {
        DEV_SetReadPin(config->dc);
        DEV_SetSpiClock(FOS_IT8951_SPI_HZ);
    } else {
        DEV_SetSpiClock(s_partial ? FOS_PARTIAL_SPI_HZ : 0);
    }
    s_panel = entry;
    /* An RGB LCD comes up now, not at the first blit: its scan-out starts
     * (a lit white screen instead of a dark one until Wi-Fi), and its IO
     * expander's I2C bus exists before the touch controller next to it
     * asks to join (fos_display_shared_i2c_bus, fos_touch_start). */
    if (entry->bus == FOS_PANEL_BUS_RGB) {
        s_module_ready = true;
        if (entry->driver_init() != 0) {
            ESP_LOGE(TAG, "panel %s failed to start", entry->name);
            s_panel = NULL;
            s_module_ready = false;
            return ESP_FAIL;
        }
    }
    ESP_LOGI(TAG, "panel %s (%dx%d, fmt=%d, %u byte buffer)", entry->name,
             fos_display_width(), fos_display_height(), (int)fos_display_format(),
             (unsigned)fos_display_buffer_size());
    return ESP_OK;
}

void fos_display_set_temperature_hook(bool (*read_celsius)(int *celsius))
{
    fos_it8951_set_temperature_source(read_celsius);
}

void fos_display_set_i2c_lender(void *(*lend_bus)(int sda, int scl))
{
    s_lend_i2c_bus = lend_bus;
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

int fos_display_bus(void)
{
    return s_panel ? s_panel->bus : FOS_PANEL_BUS_SPI;
}

bool fos_display_is_lcd(void)
{
    return s_panel && s_panel->bus == FOS_PANEL_BUS_RGB;
}

esp_err_t fos_display_power(bool on)
{
    if (!fos_display_is_lcd()) return ESP_ERR_NOT_SUPPORTED;
    return fos_lcd_st7701s_backlight(on);
}

void fos_display_boot_status(fos_lcd_splash_status_t status)
{
    if (fos_display_is_lcd()) fos_lcd_st7701s_splash_status(status);
}

uint8_t *fos_display_render_target(size_t *len, uint32_t *generation)
{
    if (len) *len = 0;
    if (generation) *generation = 0;
    if (!fos_display_is_lcd()) return NULL;
    uint8_t *target = fos_lcd_st7701s_back_buffer(generation);
    if (target && len) *len = fos_display_buffer_size();
    return target;
}

void fos_display_mark_written(const uint8_t *buf)
{
    if (fos_display_is_lcd()) fos_lcd_st7701s_mark_written(buf);
}

int64_t fos_display_buffer_generation(const uint8_t *buf)
{
    return fos_display_is_lcd() ? fos_lcd_st7701s_buffer_generation(buf) : -1;
}

void fos_display_release_render_target(void)
{
    if (fos_display_is_lcd()) fos_lcd_st7701s_release_back_buffer();
}

void fos_display_set_before_write_hook(void (*hook)(const uint8_t *buf))
{
    fos_lcd_st7701s_set_before_write_hook(hook);
}

esp_err_t fos_display_shared_i2c_bus(int sda, int scl, void **bus)
{
    if (bus) *bus = NULL;
    if (!s_panel || s_panel->bus != FOS_PANEL_BUS_RGB || sda < 0 || scl < 0) return ESP_ERR_NOT_FOUND;
    return fos_lcd_st7701s_i2c_bus(sda, scl, bus);
}

size_t fos_display_panel_count(void)
{
    return fos_panel_table_count;
}

bool fos_display_panel_known(const char *name)
{
    if (!name) return false;
    if (strcmp(name, "none") == 0) return true;
    for (size_t i = 0; i < fos_panel_table_count; i++) {
        if (strcmp(fos_panel_table[i].name, name) == 0) return true;
    }
    return false;
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

bool fos_pixel_format_is_grey(fos_pixel_format_t format)
{
    return format == FOS_PIXEL_1BPP || format == FOS_PIXEL_2BPP_GRAY || format == FOS_PIXEL_4BPP_GRAY;
}

size_t fos_render_canvas_bytes_per_pixel(int width, int height, size_t psram_total_bytes,
                                         fos_pixel_format_t format)
{
    if (width <= 0 || height <= 0) return 0;
    if (fos_pixel_format_is_grey(format)) return 1;
    if (format == FOS_PIXEL_RGB565) return 2;
    size_t rgbx = (size_t)width * (size_t)height * 4u;
    if (psram_total_bytes > 0 && rgbx * FOS_RENDER_CANVAS_RGBX_MAX_PSRAM_SHARE <= psram_total_bytes) {
        return 4;
    }
    return 2;
}

size_t fos_display_canvas_bytes_per_pixel(void)
{
    if (!s_panel) return 0;
    return fos_render_canvas_bytes_per_pixel(fos_display_width(), fos_display_height(),
                                             heap_caps_get_total_size(MALLOC_CAP_SPIRAM),
                                             fos_display_format());
}

size_t fos_display_canvas_bytes(void)
{
    if (!s_panel) return 0;
    return (size_t)fos_display_width() * (size_t)fos_display_height() *
           fos_display_canvas_bytes_per_pixel();
}

size_t fos_display_render_psram_bytes(void)
{
    if (!s_panel) return 0;
    /* An RGB LCD scans three frame buffers of its own (lcd_st7701s_rgb.c). */
    size_t lcd_fbs = s_panel->bus == FOS_PANEL_BUS_RGB ? 3u * fos_display_buffer_size() : 0u;
    return fos_display_canvas_bytes() + fos_display_buffer_size() + lcd_fbs + FOS_RENDER_PSRAM_RESERVE;
}

static esp_err_t ensure_module(void)
{
    if (s_module_ready) return ESP_OK;
    /* I2C panels (the SSD1306 OLED) own their bus and reuse the sck/mosi pins
     * as SCL/SDA; bringing up the EPD SPI module on the same GPIOs would take
     * them away. An RGB LCD brings up its own peripheral and has no SPI pins
     * at all. */
    if (s_panel && (s_panel->bus == FOS_PANEL_BUS_I2C || s_panel->bus == FOS_PANEL_BUS_RGB)) {
        s_module_ready = true;
        return ESP_OK;
    }
    if (DEV_Module_Init() != 0) {
        return ESP_FAIL;
    }
    s_module_ready = true;
    return ESP_OK;
}

esp_err_t fos_display_spi_bus_share(int miso_pin, int *host)
{
    if (s_panel && (s_panel->bus == FOS_PANEL_BUS_I2C || s_panel->bus == FOS_PANEL_BUS_RGB)) {
        return ESP_ERR_INVALID_STATE;
    }
    int shared = DEV_SPI_Bus_Share(miso_pin);
    if (shared < 0) return ESP_ERR_INVALID_STATE;
    if (host) *host = shared;
    return ESP_OK;
}

esp_err_t fos_display_blit(const uint8_t *buf, size_t len)
{
    if (!s_panel) return ESP_ERR_INVALID_STATE;
    if (!buf || len != fos_display_buffer_size()) return ESP_ERR_INVALID_SIZE;
    esp_err_t err = ensure_module();
    if (err != ESP_OK) return err;

    fos_display_park();
    int64_t start = esp_timer_get_time();
    /* The whole sequence under one bus hold: the drivers toggle CS by hand,
     * so a shared card may not get a word in until the panel sleeps. */
    DEV_SPI_Acquire();
    if (s_panel->driver_init() != 0) {
        DEV_SPI_Release();
        ESP_LOGE(TAG, "panel init failed");
        return ESP_FAIL;
    }
    s_panel->display((uint8_t *)buf);
    s_panel->sleep();
    DEV_SPI_Release();
    s_panel_awake = false;
    ESP_LOGI(TAG, "blit + refresh took %lld ms", (esp_timer_get_time() - start) / 1000);
    if (fos_display_supports_partial()) {
        if (!s_partial->changed) {
            if (!s_glass) s_glass = heap_caps_malloc(len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
            if (s_glass && s_glass != buf) memcpy(s_glass, buf, len);
            s_glass_known = s_glass != NULL;
        }
        s_partials_since_full = 0;
    }
    return ESP_OK;
}

bool fos_display_supports_partial(void)
{
    return s_partial != NULL;
}

esp_err_t fos_display_update(const uint8_t *buf, size_t len, bool same_scene, bool input_recent,
                             bool *partial)
{
    if (partial) *partial = false;
    if (!s_panel) return ESP_ERR_INVALID_STATE;
    if (!buf || len != fos_display_buffer_size()) return ESP_ERR_INVALID_SIZE;
    /* A controller that keeps the picture says what changed itself. */
    bool controller_keeps = s_partial && s_partial->changed;
    if (controller_keeps) fos_it8951_10in3_set_interactive(input_recent);
    long controller_changed = controller_keeps ? s_partial->changed(buf) : -1;
    bool known = controller_keeps ? controller_changed >= 0 : s_glass_known;
    fos_partial_refresh_input_t input = {
        .supported = fos_display_supports_partial(),
        .glass_known = known,
        .same_scene = same_scene,
        .input_recent = input_recent,
        .partials_since_full = s_partials_since_full,
        .changed_bytes = !known ? len : controller_keeps ? (size_t)controller_changed
                                                         : fos_partial_changed_bytes(buf, s_glass, len),
        .total_bytes = len,
    };
    if (!fos_partial_refresh_wanted(&input)) return fos_display_blit(buf, len);
    esp_err_t err = ensure_module();
    if (err != ESP_OK) return err;

    /* One bus hold, as a full refresh. */
    DEV_SPI_Acquire();
    if (!s_panel_awake) s_partial->init();
    s_partial->show((uint8_t *)buf, s_glass);
    DEV_SPI_Release();
    s_last_partial_us = esp_timer_get_time();
    s_panel_awake = true;
    s_panel_rested = false;
    if (!controller_keeps) memcpy(s_glass, buf, len);
    s_partials_since_full++;
    if (partial) *partial = true;
    return ESP_OK;
}

bool fos_display_settle_due(int64_t now_us)
{
    if (!s_partial || !s_partial->owed || !s_partial->owed()) return false;
    if (now_us - s_last_partial_us < FOS_PANEL_SETTLE_US) return false;
    /* Whether or not it works out, not again for a while. */
    s_last_partial_us = now_us;
    return true;
}

void fos_display_park(void)
{
    if (!s_panel || !s_panel_awake) return;
    DEV_SPI_Acquire();
    s_panel->sleep();
    DEV_SPI_Release();
    s_panel_awake = false;
}

void fos_display_park_if_idle(int64_t now_us)
{
    if (!s_panel_awake) return;
    int64_t idle_us = now_us - s_last_partial_us;
    if (idle_us >= FOS_PANEL_CLEAN_US && s_partial->clean && s_partials_since_full > 0 &&
        s_partials_since_full >= FOS_PARTIAL_MAX_BEFORE_FULL) {
        DEV_SPI_Acquire();
        s_partial->clean();
        s_partial->rest();
        DEV_SPI_Release();
        s_panel_awake = false;
        s_partials_since_full = 0;
    } else if (idle_us >= FOS_PANEL_CLEAN_US && s_glass_known &&
               s_partials_since_full >= FOS_PARTIAL_MAX_BEFORE_FULL) {
        fos_display_blit(s_glass, fos_display_buffer_size());
    } else if (idle_us >= FOS_PANEL_AWAKE_US) {
        fos_display_park();
    } else if (idle_us >= FOS_PANEL_ANALOG_US && !s_panel_rested && !s_partial->changed) {
        DEV_SPI_Acquire();
        s_partial->rest();
        DEV_SPI_Release();
        s_panel_rested = true;
    }
}

void *fos_display_alloc_psram(size_t len)
{
    return heap_caps_malloc(len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
}

esp_err_t fos_display_clear(void)
{
    if (!s_panel) return ESP_ERR_INVALID_STATE;
    esp_err_t err = ensure_module();
    if (err != ESP_OK) return err;
    fos_display_park();
    DEV_SPI_Acquire();
    if (s_panel->driver_init() != 0) {
        DEV_SPI_Release();
        return ESP_FAIL;
    }
    s_panel->clear();
    s_panel->sleep();
    DEV_SPI_Release();
    s_panel_awake = false;
    s_glass_known = false;
    return ESP_OK;
}
