#include "oled_ssd1306.h"

#include <string.h>

#include "driver/i2c_master.h"
#include "esp_log.h"

#include "DEV_Config.h"

static const char *TAG = "fos_oled";

#define OLED_ADDR 0x3C
#define OLED_PAGES (FOS_OLED_SSD1306_72X40_HEIGHT / 8)
/* The 72 visible columns sit at GDDRAM columns 28..99 on this module
 * (u8g2's SSD1306_72X40_ER geometry). */
#define OLED_COLUMN_OFFSET 28
#define OLED_ROW_BYTES ((FOS_OLED_SSD1306_72X40_WIDTH + 7) / 8)
#define OLED_FRAME_BYTES (FOS_OLED_SSD1306_72X40_WIDTH * OLED_PAGES)
#define OLED_I2C_HZ 400000
#define OLED_I2C_TIMEOUT_MS 100

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_dev;
static int s_sda = -1, s_scl = -1;

static esp_err_t oled_write(uint8_t control, const uint8_t *bytes, size_t len)
{
    /* One transaction: control byte (0x00 commands, 0x40 data) + payload. */
    uint8_t frame[1 + OLED_FRAME_BYTES];
    if (len > OLED_FRAME_BYTES) return ESP_ERR_INVALID_SIZE;
    frame[0] = control;
    memcpy(frame + 1, bytes, len);
    return i2c_master_transmit(s_dev, frame, len + 1, OLED_I2C_TIMEOUT_MS);
}

static esp_err_t oled_commands(const uint8_t *cmds, size_t len)
{
    return oled_write(0x00, cmds, len);
}

static esp_err_t oled_bus_ready(void)
{
    int sda = EPD_MOSI_PIN, scl = EPD_SCLK_PIN;
    if (sda < 0 || scl < 0) {
        ESP_LOGE(TAG, "OLED needs pins.mosi (SDA) and pins.sck (SCL); have sda=%d scl=%d", sda, scl);
        return ESP_ERR_INVALID_ARG;
    }
    if (s_dev && sda == s_sda && scl == s_scl) return ESP_OK;
    if (s_dev) {
        i2c_master_bus_rm_device(s_dev);
        s_dev = NULL;
    }
    if (s_bus) {
        i2c_del_master_bus(s_bus);
        s_bus = NULL;
    }
    i2c_master_bus_config_t bus_config = {
        .i2c_port = -1,
        .sda_io_num = sda,
        .scl_io_num = scl,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    esp_err_t err = i2c_new_master_bus(&bus_config, &s_bus);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c bus on sda=%d scl=%d failed: %s", sda, scl, esp_err_to_name(err));
        return err;
    }
    i2c_device_config_t dev_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = OLED_ADDR,
        .scl_speed_hz = OLED_I2C_HZ,
    };
    err = i2c_master_bus_add_device(s_bus, &dev_config, &s_dev);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c device 0x%02x failed: %s", OLED_ADDR, esp_err_to_name(err));
        i2c_del_master_bus(s_bus);
        s_bus = NULL;
        return err;
    }
    s_sda = sda;
    s_scl = scl;
    return ESP_OK;
}

int fos_oled_ssd1306_72x40_init(void)
{
    if (oled_bus_ready() != ESP_OK) return 1;
    /* SSD1306 bring-up for the 72x40 window (multiplex 40, no offset, the
     * charge pump on), then display on. Re-running it between renders is
     * harmless: GDDRAM is untouched. */
    static const uint8_t init_seq[] = {
        0xAE,       /* display off */
        0xD5, 0x80, /* clock divide / oscillator */
        0xA8, 0x27, /* multiplex ratio: 40 rows */
        0xD3, 0x00, /* display offset */
        0x40,       /* start line 0 */
        0x8D, 0x14, /* charge pump on */
        0x20, 0x00, /* horizontal addressing */
        0xA1,       /* segment remap */
        0xC8,       /* COM scan direction */
        0xDA, 0x12, /* COM pins: alternative */
        0x81, 0xCF, /* contrast */
        0xD9, 0xF1, /* pre-charge */
        0xDB, 0x40, /* VCOMH */
        0x2E,       /* no scroll */
        0xA4,       /* follow RAM */
        0xA6,       /* normal (not inverted) */
        0xAF,       /* display on */
    };
    esp_err_t err = oled_commands(init_seq, sizeof(init_seq));
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "init failed: %s (no OLED at 0x%02x on sda=%d scl=%d?)", esp_err_to_name(err),
                 OLED_ADDR, s_sda, s_scl);
        return 1;
    }
    return 0;
}

static void oled_show_frame(const uint8_t *frame)
{
    const uint8_t window[] = {
        0x21, OLED_COLUMN_OFFSET, OLED_COLUMN_OFFSET + FOS_OLED_SSD1306_72X40_WIDTH - 1, /* columns */
        0x22, 0x00, OLED_PAGES - 1,                                                   /* pages */
    };
    if (oled_commands(window, sizeof(window)) != ESP_OK) return;
    esp_err_t err = oled_write(0x40, frame, OLED_FRAME_BYTES);
    if (err != ESP_OK) ESP_LOGE(TAG, "frame write failed: %s", esp_err_to_name(err));
}

void fos_oled_ssd1306_72x40_display(uint8_t *buf)
{
    /* Packed rows (MSB first, 1 = white = lit) → SSD1306 pages: one byte per
     * column holding 8 vertical pixels, LSB = top row of the page. */
    uint8_t frame[OLED_FRAME_BYTES];
    for (int page = 0; page < OLED_PAGES; page++) {
        for (int x = 0; x < FOS_OLED_SSD1306_72X40_WIDTH; x++) {
            uint8_t column = 0;
            for (int bit = 0; bit < 8; bit++) {
                int y = page * 8 + bit;
                if (buf[y * OLED_ROW_BYTES + (x >> 3)] & (0x80 >> (x & 7))) {
                    column |= (uint8_t)(1u << bit);
                }
            }
            frame[page * FOS_OLED_SSD1306_72X40_WIDTH + x] = column;
        }
    }
    oled_show_frame(frame);
}

void fos_oled_ssd1306_72x40_clear(void)
{
    uint8_t frame[OLED_FRAME_BYTES];
    memset(frame, 0, sizeof(frame));
    oled_show_frame(frame);
}

void fos_oled_ssd1306_72x40_sleep(void)
{
    /* Keep showing the frame. */
}
