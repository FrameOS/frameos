#include "frameos_display.h"

#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"

#include "DEV_Config.h"
#include "EPD_7in5_V2.h"

static const char *TAG = "fos_display";

typedef struct {
    const char *name;
    int width;
    int height;
    fos_pixel_format_t format;
    UBYTE (*init)(void);
    void (*display)(UBYTE *);
    void (*clear)(void);
    void (*sleep)(void);
} fos_panel_t;

static const fos_panel_t PANELS[] = {
    {
        .name = "EPD_7in5_V2",
        .width = 800,
        .height = 480,
        .format = FOS_PIXEL_1BPP,
        .init = EPD_7IN5_V2_Init,
        .display = EPD_7IN5_V2_Display,
        .clear = EPD_7IN5_V2_Clear,
        .sleep = EPD_7IN5_V2_Sleep,
    },
};

static const fos_panel_t *s_panel = NULL;
static bool s_module_ready = false;

esp_err_t fos_display_init(const fos_display_config_t *config)
{
    s_panel = NULL;
    if (!config->panel || !config->panel[0] || strcmp(config->panel, "none") == 0) {
        ESP_LOGI(TAG, "no panel configured (headless)");
        return ESP_OK;
    }
    for (size_t i = 0; i < sizeof(PANELS) / sizeof(PANELS[0]); i++) {
        if (strcmp(PANELS[i].name, config->panel) == 0) {
            s_panel = &PANELS[i];
            break;
        }
    }
    if (!s_panel) {
        ESP_LOGE(TAG, "unknown panel \"%s\"", config->panel);
        return ESP_ERR_NOT_FOUND;
    }
    DEV_SetPinConfig(config->rst, config->dc, config->cs, config->busy,
                     config->sck, config->mosi, config->pwr);
    ESP_LOGI(TAG, "panel %s (%dx%d, %u byte buffer)", s_panel->name,
             s_panel->width, s_panel->height, (unsigned)fos_display_buffer_size());
    return ESP_OK;
}

bool fos_display_present(void) { return s_panel != NULL; }
int fos_display_width(void) { return s_panel ? s_panel->width : 0; }
int fos_display_height(void) { return s_panel ? s_panel->height : 0; }
fos_pixel_format_t fos_display_format(void) { return s_panel ? s_panel->format : FOS_PIXEL_1BPP; }

size_t fos_display_buffer_size(void)
{
    if (!s_panel) return 0;
    return ((size_t)(s_panel->width + 7) / 8) * s_panel->height;
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
    if (len != fos_display_buffer_size()) return ESP_ERR_INVALID_SIZE;
    esp_err_t err = ensure_module();
    if (err != ESP_OK) return err;

    int64_t start = esp_timer_get_time();
    if (s_panel->init() != 0) {
        ESP_LOGE(TAG, "panel init failed");
        return ESP_FAIL;
    }
    s_panel->display((UBYTE *)buf);
    s_panel->sleep();
    ESP_LOGI(TAG, "blit + refresh took %lld ms", (esp_timer_get_time() - start) / 1000);
    return ESP_OK;
}

esp_err_t fos_display_clear(void)
{
    if (!s_panel) return ESP_ERR_INVALID_STATE;
    esp_err_t err = ensure_module();
    if (err != ESP_OK) return err;
    if (s_panel->init() != 0) return ESP_FAIL;
    s_panel->clear();
    s_panel->sleep();
    return ESP_OK;
}
