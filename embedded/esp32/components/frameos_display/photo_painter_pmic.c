#include "photo_painter_pmic.h"

#include <stdbool.h>
#include <stdint.h>

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "photo_painter_pmic";

#define AXP2101_ADDR 0x34
#define AXP2101_CHIP_ID 0x4A

#define AXP2101_REG_IC_TYPE 0x03
#define AXP2101_REG_INPUT_CUR_LIMIT 0x16
#define AXP2101_REG_LDO_ONOFF_CTRL0 0x90
#define AXP2101_REG_LDO_VOL3_CTRL 0x95

#define AXP2101_ALDO4_ENABLE_BIT 3
#define AXP2101_ALDO4_3300MV_VALUE ((3300 - 500) / 100)
#define AXP2101_VBUS_CUR_LIMIT_2000MA 5

#define PHOTO_PAINTER_I2C_SDA GPIO_NUM_47
#define PHOTO_PAINTER_I2C_SCL GPIO_NUM_48

static i2c_master_bus_handle_t s_bus = NULL;
static i2c_master_dev_handle_t s_dev = NULL;
static bool s_ready = false;

static esp_err_t pmic_bus_init(void)
{
    if (s_ready) return ESP_OK;

    i2c_master_bus_config_t bus_config = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = PHOTO_PAINTER_I2C_SDA,
        .scl_io_num = PHOTO_PAINTER_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags = {
            .enable_internal_pullup = true,
        },
    };
    esp_err_t err = i2c_new_master_bus(&bus_config, &s_bus);
    if (err == ESP_ERR_INVALID_STATE) {
        err = i2c_master_get_bus_handle(I2C_NUM_0, &s_bus);
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "i2c bus init failed: %s", esp_err_to_name(err));
        return err;
    }

    i2c_device_config_t dev_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = AXP2101_ADDR,
        .scl_speed_hz = 100000,
    };
    err = i2c_master_bus_add_device(s_bus, &dev_config, &s_dev);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "AXP2101 device init failed: %s", esp_err_to_name(err));
        return err;
    }

    s_ready = true;
    return ESP_OK;
}

static esp_err_t pmic_read_u8(uint8_t reg, uint8_t *value)
{
    for (int attempt = 0; attempt < 3; attempt++) {
        esp_err_t err = i2c_master_transmit_receive(s_dev, &reg, 1, value, 1, 200);
        if (err == ESP_OK) return ESP_OK;
        vTaskDelay(pdMS_TO_TICKS(20));
        if (attempt == 2) return err;
    }
    return ESP_FAIL;
}

static esp_err_t pmic_write_u8(uint8_t reg, uint8_t value)
{
    uint8_t data[] = {reg, value};
    for (int attempt = 0; attempt < 3; attempt++) {
        esp_err_t err = i2c_master_transmit(s_dev, data, sizeof(data), 200);
        if (err == ESP_OK) return ESP_OK;
        vTaskDelay(pdMS_TO_TICKS(20));
        if (attempt == 2) return err;
    }
    return ESP_FAIL;
}

esp_err_t fos_photo_painter_enable_epd_power(void)
{
    esp_err_t err = pmic_bus_init();
    if (err != ESP_OK) return err;

    uint8_t chip_id = 0;
    err = pmic_read_u8(AXP2101_REG_IC_TYPE, &chip_id);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "AXP2101 chip id read failed: %s", esp_err_to_name(err));
        return err;
    }
    if (chip_id != AXP2101_CHIP_ID) {
        ESP_LOGW(TAG, "unexpected PMIC chip id: 0x%02x", chip_id);
        return ESP_ERR_NOT_FOUND;
    }

    uint8_t input_before = 0;
    uint8_t input_after = 0;
    if (pmic_read_u8(AXP2101_REG_INPUT_CUR_LIMIT, &input_before) == ESP_OK) {
        input_after = (uint8_t)((input_before & 0xF8) | AXP2101_VBUS_CUR_LIMIT_2000MA);
        if (input_after != input_before) {
            ESP_ERROR_CHECK_WITHOUT_ABORT(pmic_write_u8(AXP2101_REG_INPUT_CUR_LIMIT, input_after));
        }
    }

    uint8_t ldo_vol_before = 0;
    ESP_RETURN_ON_ERROR(pmic_read_u8(AXP2101_REG_LDO_VOL3_CTRL, &ldo_vol_before), TAG,
                        "read ALDO4 voltage");
    uint8_t ldo_vol_after = (uint8_t)((ldo_vol_before & 0xE0) | AXP2101_ALDO4_3300MV_VALUE);
    ESP_RETURN_ON_ERROR(pmic_write_u8(AXP2101_REG_LDO_VOL3_CTRL, ldo_vol_after), TAG,
                        "set ALDO4 voltage");

    uint8_t ldo_on_before = 0;
    ESP_RETURN_ON_ERROR(pmic_read_u8(AXP2101_REG_LDO_ONOFF_CTRL0, &ldo_on_before), TAG,
                        "read LDO enable");
    uint8_t ldo_on_after = (uint8_t)(ldo_on_before | (1u << AXP2101_ALDO4_ENABLE_BIT));
    ESP_RETURN_ON_ERROR(pmic_write_u8(AXP2101_REG_LDO_ONOFF_CTRL0, ldo_on_after), TAG,
                        "enable ALDO4");

    uint8_t ldo_vol_readback = 0;
    uint8_t ldo_on_readback = 0;
    uint8_t input_readback = 0;
    (void)pmic_read_u8(AXP2101_REG_LDO_VOL3_CTRL, &ldo_vol_readback);
    (void)pmic_read_u8(AXP2101_REG_LDO_ONOFF_CTRL0, &ldo_on_readback);
    (void)pmic_read_u8(AXP2101_REG_INPUT_CUR_LIMIT, &input_readback);

    ESP_LOGI(TAG,
             "AXP2101 EPD_VCC on: chip=0x%02x ALDO4_VOL 0x%02x->0x%02x rb=0x%02x "
             "LDO_ON 0x%02x->0x%02x rb=0x%02x VBUS 0x%02x->0x%02x rb=0x%02x",
             chip_id, ldo_vol_before, ldo_vol_after, ldo_vol_readback,
             ldo_on_before, ldo_on_after, ldo_on_readback,
             input_before, input_after, input_readback);
    return ESP_OK;
}
