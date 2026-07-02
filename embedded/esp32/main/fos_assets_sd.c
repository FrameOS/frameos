#include "fos_assets_sd.h"

#include <string.h>

#include "driver/gpio.h"
#include "driver/sdspi_host.h"
#include "driver/spi_common.h"
#include "esp_log.h"
#include "esp_vfs_fat.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdmmc_cmd.h"

static const char *TAG = "fos_assets_sd";

static bool s_mounted = false;
static sdmmc_card_t *s_card = NULL;

static bool valid_pin(int8_t pin)
{
    return pin >= 0 && pin <= 48;
}

static bool valid_config(const fos_config_t *config)
{
    if (!config || !config->assets_sd.enabled) return false;
    return config->assets_path[0] &&
        valid_pin(config->assets_sd.cs) &&
        valid_pin(config->assets_sd.sck) &&
        valid_pin(config->assets_sd.miso) &&
        valid_pin(config->assets_sd.mosi);
}

static void enable_pullup(int8_t pin)
{
    if (!valid_pin(pin)) return;
    gpio_reset_pin((gpio_num_t)pin);
    gpio_set_pull_mode((gpio_num_t)pin, GPIO_PULLUP_ONLY);
}

esp_err_t fos_assets_sd_mount(const fos_config_t *config)
{
    if (s_mounted) return ESP_OK;
    if (!config || !config->assets_sd.enabled) return ESP_OK;

    char pins[FOS_STR_LEN];
    fos_config_format_assets_sd_pins(&config->assets_sd, pins, sizeof(pins));
    if (!valid_config(config)) {
        ESP_LOGW(TAG, "SD assets enabled but config is incomplete: path=%s pins=%s",
                 config && config->assets_path[0] ? config->assets_path : "(unset)", pins);
        return ESP_ERR_INVALID_ARG;
    }

    enable_pullup(config->assets_sd.cs);
    enable_pullup(config->assets_sd.sck);
    enable_pullup(config->assets_sd.miso);
    enable_pullup(config->assets_sd.mosi);

    sdmmc_host_t host = SDSPI_HOST_DEFAULT();
    host.slot = SPI3_HOST;
    if (config->assets_sd.max_freq_khz > 0) {
        host.max_freq_khz = config->assets_sd.max_freq_khz;
    }

    spi_bus_config_t bus_cfg = {
        .mosi_io_num = config->assets_sd.mosi,
        .miso_io_num = config->assets_sd.miso,
        .sclk_io_num = config->assets_sd.sck,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = 4096,
    };
    esp_err_t err = spi_bus_initialize(host.slot, &bus_cfg, SDSPI_DEFAULT_DMA);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "SD SPI bus init failed on SPI3 (%s): %s", pins, esp_err_to_name(err));
        return err;
    }

    sdspi_device_config_t slot_config = SDSPI_DEVICE_CONFIG_DEFAULT();
    slot_config.host_id = host.slot;
    slot_config.gpio_cs = (gpio_num_t)config->assets_sd.cs;

    esp_vfs_fat_sdmmc_mount_config_t mount_config = {
        .format_if_mount_failed = false,
        .max_files = 8,
        .allocation_unit_size = 16 * 1024,
    };

    /* Card init over jumper wires can time out on the first probe; retry a
     * few times, then once more at a reduced bus clock before giving up. */
    const int max_attempts = 3;
    for (int attempt = 1; attempt <= max_attempts; attempt++) {
        err = esp_vfs_fat_sdspi_mount(config->assets_path, &host, &slot_config, &mount_config, &s_card);
        if (err == ESP_OK) break;
        ESP_LOGW(TAG, "mounting SD assets at %s failed (attempt %d/%d, %s, pins=%s, %lu kHz)",
                 config->assets_path, attempt, max_attempts, esp_err_to_name(err), pins,
                 (unsigned long)host.max_freq_khz);
        s_card = NULL;
        if (attempt == max_attempts) break;
        if (attempt == max_attempts - 1 && host.max_freq_khz > 10000) {
            host.max_freq_khz = 10000;
        }
        vTaskDelay(pdMS_TO_TICKS(250));
    }
    if (err == ESP_FAIL) {
        /* The card answers SD commands but carries no mountable FAT volume —
         * typically a blank/new card. Format it so it can serve as the assets
         * folder. esp_vfs_fat_sdspi_mount only formats on FR_NO_FILESYSTEM;
         * transient disk errors on a good card never trigger a format. */
        ESP_LOGW(TAG, "no FAT filesystem on SD card; formatting so it can hold assets (pins=%s)", pins);
        mount_config.format_if_mount_failed = true;
        err = esp_vfs_fat_sdspi_mount(config->assets_path, &host, &slot_config, &mount_config, &s_card);
        if (err == ESP_OK) {
            ESP_LOGI(TAG, "SD card formatted as FAT and mounted at %s", config->assets_path);
        } else {
            ESP_LOGW(TAG, "formatting SD card failed: %s", esp_err_to_name(err));
            s_card = NULL;
        }
    }
    if (err != ESP_OK) {
        spi_bus_free(host.slot);
        s_card = NULL;
        return err;
    }

    s_mounted = true;
    uint64_t capacity = fos_assets_sd_capacity_bytes();
    ESP_LOGI(TAG, "SD assets mounted at %s (%llu MB, pins=%s, %lu kHz)",
             config->assets_path,
             (unsigned long long)(capacity / (1024ULL * 1024ULL)),
             pins,
             (unsigned long)host.max_freq_khz);
    return ESP_OK;
}

bool fos_assets_sd_mounted(void)
{
    return s_mounted;
}

uint64_t fos_assets_sd_capacity_bytes(void)
{
    if (!s_card) return 0;
    return (uint64_t)s_card->csd.capacity * (uint64_t)s_card->csd.sector_size;
}

