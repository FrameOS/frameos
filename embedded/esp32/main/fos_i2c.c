#include "fos_i2c.h"

#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "soc/soc_caps.h"

#include "fos_config.h"

static const char *TAG = "fos_i2c";

#define I2C_PROBE_TIMEOUT_MS 20
#define I2C_XFER_TIMEOUT_MS 50
/* 100 kHz: every chip here speaks it, and the E-series buses carry 4.7 kΩ
 * pull-ups on the board, so no internal ones are needed; enabling them anyway
 * is harmless on a wired bus and makes a probe of an empty header bus a
 * clean NACK instead of a floating line. */
#define I2C_SPEED_HZ 100000

static const struct {
    const char *name;
    uint8_t address;
} k_chips[FOS_I2C_CHIP_COUNT] = {
    [FOS_I2C_PCF8563] = {"pcf8563", 0x51},
    [FOS_I2C_SHT4X] = {"sht4x", 0x44},
    [FOS_I2C_SY6974B] = {"sy6974b", 0x6b},
};

static SemaphoreHandle_t s_lock = NULL;
static i2c_master_bus_handle_t s_buses[FOS_I2C_BUSES_MAX];
static fos_i2c_bus_t s_bus_pins[FOS_I2C_BUSES_MAX];
static uint8_t s_bus_count = 0;
static i2c_master_dev_handle_t s_devices[FOS_I2C_CHIP_COUNT];
static int8_t s_device_bus[FOS_I2C_CHIP_COUNT]; /* which bus answered, -1 = absent */

static void teardown_locked(void)
{
    for (size_t c = 0; c < FOS_I2C_CHIP_COUNT; c++) {
        if (s_devices[c]) {
            i2c_master_bus_rm_device(s_devices[c]);
            s_devices[c] = NULL;
        }
        s_device_bus[c] = -1;
    }
    for (size_t b = 0; b < s_bus_count; b++) {
        if (s_buses[b]) {
            i2c_del_master_bus(s_buses[b]);
            s_buses[b] = NULL;
        }
    }
    s_bus_count = 0;
}

esp_err_t fos_i2c_init(void)
{
    if (!s_lock) {
        s_lock = xSemaphoreCreateMutex();
        if (!s_lock) return ESP_ERR_NO_MEM;
        for (size_t c = 0; c < FOS_I2C_CHIP_COUNT; c++) s_device_bus[c] = -1;
    }
    const fos_config_t *config = fos_config();
    xSemaphoreTake(s_lock, portMAX_DELAY);
    teardown_locked();
    esp_err_t first_err = ESP_OK;
    for (uint8_t i = 0; i < config->i2c_bus_count && i < FOS_I2C_BUSES_MAX; i++) {
        if (s_bus_count >= SOC_I2C_NUM) {
            ESP_LOGW(TAG, "this chip has %d I2C port(s); bus sda%d/scl%d not opened",
                     (int)SOC_I2C_NUM, config->i2c_buses[i].sda, config->i2c_buses[i].scl);
            break;
        }
        const char *why = fos_config_gpio_pin_reserved(config->i2c_buses[i].sda);
        if (why == NULL) why = fos_config_gpio_pin_reserved(config->i2c_buses[i].scl);
        if (why != NULL) {
            ESP_LOGW(TAG, "bus sda%d/scl%d refused: %s", config->i2c_buses[i].sda,
                     config->i2c_buses[i].scl, why);
            continue;
        }
        i2c_master_bus_config_t bus_config = {
            .i2c_port = -1, /* any free port: the PhotoPainter PMIC and the OLED take port 0 by name */
            .sda_io_num = (gpio_num_t)config->i2c_buses[i].sda,
            .scl_io_num = (gpio_num_t)config->i2c_buses[i].scl,
            .clk_source = I2C_CLK_SRC_DEFAULT,
            .glitch_ignore_cnt = 7,
            .flags = {.enable_internal_pullup = true},
        };
        i2c_master_bus_handle_t bus = NULL;
        esp_err_t err = i2c_new_master_bus(&bus_config, &bus);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "bus sda%d/scl%d: %s", config->i2c_buses[i].sda, config->i2c_buses[i].scl,
                     esp_err_to_name(err));
            if (first_err == ESP_OK) first_err = err;
            continue;
        }
        s_buses[s_bus_count] = bus;
        s_bus_pins[s_bus_count] = config->i2c_buses[i];
        for (size_t c = 0; c < FOS_I2C_CHIP_COUNT; c++) {
            if (s_devices[c]) continue; /* found on an earlier bus */
            if (i2c_master_probe(bus, k_chips[c].address, I2C_PROBE_TIMEOUT_MS) != ESP_OK) continue;
            i2c_device_config_t dev_config = {
                .dev_addr_length = I2C_ADDR_BIT_LEN_7,
                .device_address = k_chips[c].address,
                .scl_speed_hz = I2C_SPEED_HZ,
            };
            if (i2c_master_bus_add_device(bus, &dev_config, &s_devices[c]) == ESP_OK) {
                s_device_bus[c] = (int8_t)s_bus_count;
            } else {
                s_devices[c] = NULL;
            }
        }
        s_bus_count++;
    }
    xSemaphoreGive(s_lock);
    if (config->i2c_bus_count > 0) {
        char summary[128];
        fos_i2c_summary(summary, sizeof(summary));
        /* printf: WARN-only builds show it on the console too. */
        printf("i2c: %s\n", summary);
    }
    return first_err;
}

bool fos_i2c_present(fos_i2c_chip_t chip)
{
    if (!s_lock || chip >= FOS_I2C_CHIP_COUNT) return false;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    bool present = s_devices[chip] != NULL;
    xSemaphoreGive(s_lock);
    return present;
}

esp_err_t fos_i2c_read(fos_i2c_chip_t chip, uint8_t reg, uint8_t *buf, size_t len)
{
    if (!s_lock || chip >= FOS_I2C_CHIP_COUNT || !buf || len == 0) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    esp_err_t err = ESP_ERR_NOT_FOUND;
    if (s_devices[chip]) {
        err = i2c_master_transmit_receive(s_devices[chip], &reg, 1, buf, len, I2C_XFER_TIMEOUT_MS);
    }
    xSemaphoreGive(s_lock);
    return err;
}

esp_err_t fos_i2c_write(fos_i2c_chip_t chip, uint8_t reg, const uint8_t *buf, size_t len)
{
    if (!s_lock || chip >= FOS_I2C_CHIP_COUNT || !buf || len == 0 || len > 15) return ESP_ERR_INVALID_ARG;
    uint8_t frame[16];
    frame[0] = reg;
    memcpy(frame + 1, buf, len);
    xSemaphoreTake(s_lock, portMAX_DELAY);
    esp_err_t err = ESP_ERR_NOT_FOUND;
    if (s_devices[chip]) {
        err = i2c_master_transmit(s_devices[chip], frame, len + 1, I2C_XFER_TIMEOUT_MS);
    }
    xSemaphoreGive(s_lock);
    return err;
}

const char *fos_i2c_chip_name(fos_i2c_chip_t chip)
{
    return chip < FOS_I2C_CHIP_COUNT ? k_chips[chip].name : "?";
}

void fos_i2c_summary(char *out, size_t out_len)
{
    if (out_len == 0) return;
    out[0] = '\0';
    if (!s_lock) {
        snprintf(out, out_len, "none");
        return;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    size_t used = 0;
    for (uint8_t b = 0; b < s_bus_count; b++) {
        int n = snprintf(out + used, out_len - used, "%ssda%d/scl%d:", b ? "; " : "",
                         s_bus_pins[b].sda, s_bus_pins[b].scl);
        if (n < 0 || (size_t)n >= out_len - used) break;
        used += (size_t)n;
        bool any = false;
        for (size_t c = 0; c < FOS_I2C_CHIP_COUNT; c++) {
            if (s_device_bus[c] != (int8_t)b) continue;
            n = snprintf(out + used, out_len - used, " %s", k_chips[c].name);
            if (n < 0 || (size_t)n >= out_len - used) break;
            used += (size_t)n;
            any = true;
        }
        if (!any) {
            n = snprintf(out + used, out_len - used, " (nothing known)");
            if (n < 0 || (size_t)n >= out_len - used) break;
            used += (size_t)n;
        }
    }
    if (s_bus_count == 0) snprintf(out, out_len, "none");
    xSemaphoreGive(s_lock);
}
