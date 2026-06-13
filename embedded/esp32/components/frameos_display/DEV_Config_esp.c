/*
 * Waveshare DEV_Config on ESP-IDF: hardware SPI via spi_master, GPIO via
 * driver/gpio, delays via FreeRTOS. Pins live in the same module-global
 * variables the Pi version uses, set at runtime through DEV_SetPinConfig.
 */
#include "DEV_Config.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "esp_rom_sys.h"

static const char *TAG = "dev_config";

/* Defaults match fos_defaults.h (XIAO ESP32-S3); remapped via DEV_SetPinConfig. */
int EPD_RST_PIN = 5;
int EPD_DC_PIN = 4;
int EPD_CS_PIN = 3;
int EPD_BUSY_PIN = 6;
int EPD_PWR_PIN = -1;
int EPD_MOSI_PIN = 9;
int EPD_SCLK_PIN = 7;

#define EPD_SPI_HOST SPI2_HOST
#define EPD_SPI_HZ (8 * 1000 * 1000)
#define EPD_SPI_MAX_TRANSFER 4096

static spi_device_handle_t s_spi = NULL;
static bool s_initialized = false;

void DEV_SetPinConfig(int rst, int dc, int cs, int busy, int sclk, int mosi, int pwr)
{
    if (s_initialized) {
        ESP_LOGW(TAG, "pin config changed after init; call DEV_Module_Exit first");
    }
    if (rst >= 0) EPD_RST_PIN = rst;
    if (dc >= 0) EPD_DC_PIN = dc;
    if (cs >= 0) EPD_CS_PIN = cs;
    if (busy >= 0) EPD_BUSY_PIN = busy;
    if (sclk >= 0) EPD_SCLK_PIN = sclk;
    if (mosi >= 0) EPD_MOSI_PIN = mosi;
    EPD_PWR_PIN = pwr;
}

void DEV_Digital_Write(UWORD Pin, UBYTE Value)
{
    gpio_set_level(Pin, Value);
}

UBYTE DEV_Digital_Read(UWORD Pin)
{
    return (UBYTE)gpio_get_level(Pin);
}

void DEV_Delay_ms(UDOUBLE xms)
{
    if (xms == 0) return;
    if (xms < portTICK_PERIOD_MS) {
        esp_rom_delay_us(xms * 1000);
    } else {
        vTaskDelay(pdMS_TO_TICKS(xms));
    }
}

void DEV_SPI_WriteByte(UBYTE Value)
{
    spi_transaction_t t = {
        .length = 8,
        .tx_buffer = &Value,
    };
    spi_device_polling_transmit(s_spi, &t);
}

void DEV_SPI_Write_nByte(uint8_t *pData, uint32_t Len)
{
    while (Len > 0) {
        uint32_t chunk = Len > EPD_SPI_MAX_TRANSFER ? EPD_SPI_MAX_TRANSFER : Len;
        spi_transaction_t t = {
            .length = chunk * 8,
            .tx_buffer = pData,
        };
        spi_device_polling_transmit(s_spi, &t);
        pData += chunk;
        Len -= chunk;
    }
}

/* Software (bit-bang) SPI, used by a few panels for register reads. */
void DEV_SPI_SendData(UBYTE Reg)
{
    gpio_set_direction(EPD_MOSI_PIN, GPIO_MODE_OUTPUT);
    gpio_set_level(EPD_CS_PIN, 0);
    for (int i = 0; i < 8; i++) {
        gpio_set_level(EPD_SCLK_PIN, 0);
        gpio_set_level(EPD_MOSI_PIN, (Reg & 0x80) ? 1 : 0);
        Reg <<= 1;
        esp_rom_delay_us(1);
        gpio_set_level(EPD_SCLK_PIN, 1);
        esp_rom_delay_us(1);
    }
    gpio_set_level(EPD_SCLK_PIN, 0);
    gpio_set_level(EPD_CS_PIN, 1);
}

void DEV_SPI_SendnData(UBYTE *Reg)
{
    UDOUBLE size = strlen((const char *)Reg);
    for (UDOUBLE i = 0; i < size; i++) {
        DEV_SPI_SendData(Reg[i]);
    }
}

UBYTE DEV_SPI_ReadData(void)
{
    UBYTE value = 0;
    gpio_set_direction(EPD_MOSI_PIN, GPIO_MODE_INPUT);
    gpio_set_level(EPD_CS_PIN, 0);
    for (int i = 0; i < 8; i++) {
        value <<= 1;
        gpio_set_level(EPD_SCLK_PIN, 0);
        esp_rom_delay_us(1);
        gpio_set_level(EPD_SCLK_PIN, 1);
        value |= gpio_get_level(EPD_MOSI_PIN) & 0x01;
        esp_rom_delay_us(1);
    }
    gpio_set_level(EPD_SCLK_PIN, 0);
    gpio_set_level(EPD_CS_PIN, 1);
    gpio_set_direction(EPD_MOSI_PIN, GPIO_MODE_OUTPUT);
    return value;
}

static void configure_output(int pin, int level)
{
    if (pin < 0) return;
    gpio_reset_pin(pin);
    gpio_set_direction(pin, GPIO_MODE_OUTPUT);
    gpio_set_level(pin, level);
}

UBYTE DEV_Module_Init(void)
{
    if (s_initialized) {
        return 0;
    }
    ESP_LOGI(TAG, "init: rst=%d dc=%d cs=%d busy=%d sck=%d mosi=%d pwr=%d",
             EPD_RST_PIN, EPD_DC_PIN, EPD_CS_PIN, EPD_BUSY_PIN,
             EPD_SCLK_PIN, EPD_MOSI_PIN, EPD_PWR_PIN);

    configure_output(EPD_RST_PIN, 1);
    configure_output(EPD_DC_PIN, 0);
    configure_output(EPD_CS_PIN, 1);
    configure_output(EPD_PWR_PIN, 1);

    gpio_reset_pin(EPD_BUSY_PIN);
    gpio_set_direction(EPD_BUSY_PIN, GPIO_MODE_INPUT);
    /* Pull up so a disconnected panel reads "idle" and the vendor busy-wait
     * loops fall through instead of spinning to their 120s timeout. */
    gpio_set_pull_mode(EPD_BUSY_PIN, GPIO_PULLUP_ONLY);

    spi_bus_config_t bus_config = {
        .mosi_io_num = EPD_MOSI_PIN,
        .miso_io_num = -1,
        .sclk_io_num = EPD_SCLK_PIN,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = EPD_SPI_MAX_TRANSFER,
    };
    esp_err_t err = spi_bus_initialize(EPD_SPI_HOST, &bus_config, SPI_DMA_CH_AUTO);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "spi_bus_initialize failed: %s", esp_err_to_name(err));
        return 1;
    }
    spi_device_interface_config_t dev_config = {
        .clock_speed_hz = EPD_SPI_HZ,
        .mode = 0,
        .spics_io_num = -1, /* vendor drivers toggle CS manually */
        .queue_size = 4,
    };
    err = spi_bus_add_device(EPD_SPI_HOST, &dev_config, &s_spi);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "spi_bus_add_device failed: %s", esp_err_to_name(err));
        spi_bus_free(EPD_SPI_HOST);
        return 1;
    }
    s_initialized = true;
    return 0;
}

void DEV_Module_Exit(void)
{
    if (!s_initialized) return;
    if (s_spi) {
        spi_bus_remove_device(s_spi);
        s_spi = NULL;
    }
    spi_bus_free(EPD_SPI_HOST);
    DEV_Digital_Write(EPD_CS_PIN, 0);
    if (EPD_PWR_PIN >= 0) DEV_Digital_Write(EPD_PWR_PIN, 0);
    DEV_Digital_Write(EPD_DC_PIN, 0);
    DEV_Digital_Write(EPD_RST_PIN, 0);
    s_initialized = false;
}
