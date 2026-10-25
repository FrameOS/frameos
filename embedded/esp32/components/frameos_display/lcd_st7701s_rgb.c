/* ST7701S 480x480 RGB LCD (the Seeed SenseCAP Indicator's). See lcd_st7701s_rgb.h. */
#include "lcd_st7701s_rgb.h"

#include <stdbool.h>
#include <string.h>

#include "esp_log.h"
#include "soc/soc_caps.h"

static const char *TAG = "fos_lcd";

/* ---------------------------------------------------------------- boards */

typedef struct {
    const char *preset;
    /* The expander's bus, the expander's pins (the TCA9535's P0..P15, or the
     * HT8574's P0..P7 with the same numbers below 8). */
    int i2c_sda, i2c_scl;
    int exp_lcd_cs, exp_lcd_rst, exp_tp_rst;
    /* Pins held high so the rest of the board runs: the RP2040's reset and
     * the WXM's barometer power on the Indicator (-1 = none). */
    int exp_hold_high[2];
    /* The controller's 3-wire SPI (clock and data are GPIOs). */
    int spi_sck, spi_sda;
    int backlight; /* GPIO, high = on */
    /* The RGB interface. */
    int hsync, vsync, de, pclk;
    int data[16]; /* B0..B4, G0..G5, R0..R4 */
    uint32_t pclk_hz;
    uint32_t hsync_pulse, hsync_back, hsync_front;
    uint32_t vsync_pulse, vsync_back, vsync_front;
} lcd_board_t;

/* Seeed SenseCAP Indicator (sensecap_indicator_board.c in Seeed's BSP): the
 * TCA9535 at 0x20 on SDA39/SCL40 holds LCD_CS (P4), LCD_RESET (P5), TP_RESET
 * (P7), the RP2040's reset (P8) and the barometer's power (P10, WXM only);
 * the controller's SPI clock is GPIO41 and its data GPIO48; the backlight is
 * GPIO45. Data lines B0..B4 = GPIO15..11, G0..G5 = GPIO10..5, R0..R4 =
 * GPIO4..0; HSYNC 16, VSYNC 17, DE 18, PCLK 21 at 18 MHz with the GuanXian
 * glass's porches. */
static const lcd_board_t k_boards[] = {
    {
        .preset = "seeed_sensecap_indicator_d1",
        .i2c_sda = 39, .i2c_scl = 40,
        .exp_lcd_cs = 4, .exp_lcd_rst = 5, .exp_tp_rst = 7,
        .exp_hold_high = {8, 10},
        .spi_sck = 41, .spi_sda = 48,
        .backlight = 45,
        .hsync = 16, .vsync = 17, .de = 18, .pclk = 21,
        .data = {15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0},
        .pclk_hz = 18 * 1000 * 1000,
        .hsync_pulse = 8, .hsync_back = 50, .hsync_front = 10,
        .vsync_pulse = 8, .vsync_back = 20, .vsync_front = 10,
    },
};

static const lcd_board_t *s_board = &k_boards[0];

void fos_lcd_st7701s_select_board(const char *hardware_preset)
{
    s_board = &k_boards[0];
    if (!hardware_preset || !hardware_preset[0]) return;
    for (size_t i = 0; i < sizeof(k_boards) / sizeof(k_boards[0]); i++) {
        if (strcmp(hardware_preset, k_boards[i].preset) == 0) {
            s_board = &k_boards[i];
            return;
        }
    }
}

#if SOC_LCD_RGB_SUPPORTED

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_rgb.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define LCD_I2C_HZ 400000
#define LCD_I2C_TIMEOUT_MS 50
#define EXPANDER_ADDR_TCA9535 0x20
#define EXPANDER_ADDR_HT8574 0x39
/* TCA9535 registers: two bytes each, P0..P7 then P8..P15. */
#define TCA9535_REG_OUTPUT 0x02
#define TCA9535_REG_CONFIG 0x06

static bool s_ready = false;
static i2c_master_bus_handle_t s_bus = NULL;
static i2c_master_dev_handle_t s_expander = NULL;
static bool s_expander_is_8bit = false;
static uint16_t s_exp_output = 0;
static esp_lcd_panel_handle_t s_panel = NULL;

/* ---------------------------------------------------------- the expander */

static esp_err_t expander_write_output(void)
{
    if (s_expander_is_8bit) {
        uint8_t byte = (uint8_t)s_exp_output;
        return i2c_master_transmit(s_expander, &byte, 1, LCD_I2C_TIMEOUT_MS);
    }
    uint8_t frame[3] = {TCA9535_REG_OUTPUT, (uint8_t)s_exp_output, (uint8_t)(s_exp_output >> 8)};
    return i2c_master_transmit(s_expander, frame, sizeof(frame), LCD_I2C_TIMEOUT_MS);
}

static esp_err_t expander_set(int pin, bool level)
{
    if (pin < 0) return ESP_OK;
    if (level) s_exp_output |= (uint16_t)(1u << pin);
    else s_exp_output &= (uint16_t)~(1u << pin);
    esp_err_t err = expander_write_output();
    /* Seeed's driver lets the expander settle after each write. */
    esp_rom_delay_us(10);
    return err;
}

static esp_err_t expander_probe(uint8_t addr, bool eight_bit)
{
    if (s_expander) {
        i2c_master_bus_rm_device(s_expander);
        s_expander = NULL;
    }
    i2c_device_config_t dev_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = addr,
        .scl_speed_hz = LCD_I2C_HZ,
    };
    esp_err_t err = i2c_master_bus_add_device(s_bus, &dev_config, &s_expander);
    if (err != ESP_OK) return err;
    err = i2c_master_probe(s_bus, addr, LCD_I2C_TIMEOUT_MS);
    if (err != ESP_OK) return err;
    s_expander_is_8bit = eight_bit;
    return ESP_OK;
}

static esp_err_t expander_init(void)
{
    const lcd_board_t *b = s_board;
    i2c_master_bus_config_t bus_config = {
        .i2c_port = -1,
        .sda_io_num = (gpio_num_t)b->i2c_sda,
        .scl_io_num = (gpio_num_t)b->i2c_scl,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    esp_err_t err = i2c_new_master_bus(&bus_config, &s_bus);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c bus on sda=%d scl=%d failed: %s", b->i2c_sda, b->i2c_scl, esp_err_to_name(err));
        return err;
    }
    uint8_t addr = EXPANDER_ADDR_TCA9535;
    if (expander_probe(EXPANDER_ADDR_TCA9535, false) != ESP_OK) {
        addr = EXPANDER_ADDR_HT8574;
        if (expander_probe(EXPANDER_ADDR_HT8574, true) != ESP_OK) {
            ESP_LOGE(TAG, "no IO expander at 0x%02x or 0x%02x on sda=%d scl=%d", EXPANDER_ADDR_TCA9535,
                     EXPANDER_ADDR_HT8574, b->i2c_sda, b->i2c_scl);
            return ESP_ERR_NOT_FOUND;
        }
    }
    /* Everything the board needs high (the LCD's CS and reset idle high, the
     * RP2040 out of reset) with the touch controller held in reset, then the
     * pins made outputs, then the touch controller released: Seeed's order.
     * On the TCA9535 only our pins become outputs; the LoRa radio's lines on
     * P0..P3 stay inputs. The HT8574 has no direction register: a 1 is a
     * weak high, a 0 a driven low. */
    uint16_t ours = 0;
    s_exp_output = 0;
    int highs[] = {b->exp_lcd_cs, b->exp_lcd_rst, b->exp_hold_high[0], b->exp_hold_high[1]};
    for (size_t i = 0; i < sizeof(highs) / sizeof(highs[0]); i++) {
        if (highs[i] < 0 || (s_expander_is_8bit && highs[i] >= 8)) continue;
        ours |= (uint16_t)(1u << highs[i]);
        s_exp_output |= (uint16_t)(1u << highs[i]);
    }
    if (b->exp_tp_rst >= 0) ours |= (uint16_t)(1u << b->exp_tp_rst);
    if (s_expander_is_8bit) {
        /* Inputs read as weak highs on a quasi-bidirectional port: keep every
         * pin we do not drive at 1. */
        s_exp_output |= (uint16_t)~ours & 0x00FF;
    }
    err = expander_write_output();
    if (err == ESP_OK && !s_expander_is_8bit) {
        uint16_t config = (uint16_t)~ours; /* 0 = output */
        uint8_t frame[3] = {TCA9535_REG_CONFIG, (uint8_t)config, (uint8_t)(config >> 8)};
        err = i2c_master_transmit(s_expander, frame, sizeof(frame), LCD_I2C_TIMEOUT_MS);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "IO expander 0x%02x setup failed: %s", addr, esp_err_to_name(err));
        return err;
    }
    vTaskDelay(pdMS_TO_TICKS(5));
    expander_set(b->exp_tp_rst, true);
    ESP_LOGI(TAG, "IO expander %s at 0x%02x", s_expander_is_8bit ? "ht8574" : "tca9535", addr);
    return ESP_OK;
}

/* ------------------------------------------------ the controller's SPI */

/* Seeed's lcd_panel_config.c, bit for bit: a 9-bit frame is the D/C bit then
 * the byte, MSB first, clocked at ~50 kHz; chip-select and reset are the
 * expander's, clock and data two GPIOs. The stray clocks their code leaves
 * around a frame are kept — the controller drops whatever is pending when
 * CS rises, and this is the waveform the glass is known to accept. */
#define SPI_DELAY() esp_rom_delay_us(10)

static void spi_sck(int level) { gpio_set_level((gpio_num_t)s_board->spi_sck, level); }
static void spi_sdo(int level) { gpio_set_level((gpio_num_t)s_board->spi_sda, level); }
static void spi_cs(int level) { expander_set(s_board->exp_lcd_cs, level != 0); }

static void spi_send_9bits(unsigned value)
{
    for (int n = 0; n < 9; n++) {
        spi_sdo((value & 0x0100) ? 1 : 0);
        value <<= 1;
        spi_sck(1);
        SPI_DELAY();
        spi_sck(0);
        SPI_DELAY();
    }
}

static void spi_write_command(uint8_t command)
{
    spi_cs(0);
    SPI_DELAY();
    spi_sck(0);
    SPI_DELAY();
    spi_send_9bits(0x0000); /* the high byte of a 16-bit address: a NOP */
    spi_sck(1);
    SPI_DELAY();
    spi_sck(0);
    spi_cs(1);
    SPI_DELAY();
    spi_cs(0);
    SPI_DELAY();
    spi_send_9bits(command);
    spi_cs(1);
    SPI_DELAY();
}

static void spi_write_data(uint8_t data)
{
    spi_cs(0);
    SPI_DELAY();
    spi_sck(0);
    SPI_DELAY();
    spi_send_9bits(0x0100u | data);
    spi_sck(1);
    SPI_DELAY();
    spi_sck(0);
    SPI_DELAY();
    spi_cs(1);
    SPI_DELAY();
}

/* The ST7701S bring-up Seeed ships for the Indicator's GuanXian glass
 * (lcd_panel_st7701s_init): command bytes are marked by a 0x100 bit, a
 * 0x200 entry is a delay of that many milliseconds. */
#define C(x) (0x100u | (x))
#define D(ms) (0x200u | (ms))
static const uint16_t k_st7701s_init[] = {
    C(0xFF), 0x77, 0x01, 0x00, 0x00, 0x10,
    C(0xC0), 0x3B, 0x00,
    C(0xC1), 0x0D, 0x02,
    C(0xC2), 0x31, 0x05,
    C(0xC7), 0x04,
    C(0xCD), 0x08,
    C(0xB0), 0x00, 0x11, 0x18, 0x0E, 0x11, 0x06, 0x07, 0x08, 0x07, 0x22, 0x04, 0x12, 0x0F, 0xAA, 0x31, 0x18,
    C(0xB1), 0x00, 0x11, 0x19, 0x0E, 0x12, 0x07, 0x08, 0x08, 0x08, 0x22, 0x04, 0x11, 0x11, 0xA9, 0x32, 0x18,
    C(0xFF), 0x77, 0x01, 0x00, 0x00, 0x11,
    C(0xB0), 0x60,
    C(0xB1), 0x32,
    C(0xB2), 0x07,
    C(0xB3), 0x80,
    C(0xB5), 0x49,
    C(0xB7), 0x85,
    C(0xB8), 0x21,
    C(0xC1), 0x78,
    C(0xC2), 0x78,
    D(20),
    C(0xE0), 0x00, 0x1B, 0x02,
    C(0xE1), 0x08, 0xA0, 0x00, 0x00, 0x07, 0xA0, 0x00, 0x00, 0x00, 0x44, 0x44,
    C(0xE2), 0x11, 0x11, 0x44, 0x44, 0xED, 0xA0, 0x00, 0x00, 0xEC, 0xA0, 0x00, 0x00,
    C(0xE3), 0x00, 0x00, 0x11, 0x11,
    C(0xE4), 0x44, 0x44,
    C(0xE5), 0x0A, 0xE9, 0xD8, 0xA0, 0x0C, 0xEB, 0xD8, 0xA0, 0x0E, 0xED, 0xD8, 0xA0, 0x10, 0xEF, 0xD8, 0xA0,
    C(0xE6), 0x00, 0x00, 0x11, 0x11,
    C(0xE7), 0x44, 0x44,
    C(0xE8), 0x09, 0xE8, 0xD8, 0xA0, 0x0B, 0xEA, 0xD8, 0xA0, 0x0D, 0xEC, 0xD8, 0xA0, 0x0F, 0xEE, 0xD8, 0xA0,
    C(0xEB), 0x02, 0x00, 0xE4, 0xE4, 0x88, 0x00, 0x40,
    C(0xEC), 0x3C, 0x00,
    C(0xED), 0xAB, 0x89, 0x76, 0x54, 0x02, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x20, 0x45, 0x67, 0x98, 0xBA,
    C(0x36), 0x10,
    C(0xFF), 0x77, 0x01, 0x00, 0x00, 0x13,
    C(0xE5), 0xE4,
    C(0xFF), 0x77, 0x01, 0x00, 0x00, 0x00,
    C(0x3A), 0x60, /* RGB666 on the controller side; the bus carries 16 bits */
    C(0x21),       /* display inversion on */
    C(0x11),       /* sleep out */
    D(120),
    C(0x29),       /* display on */
    D(120),
};
#undef C
#undef D

static void controller_init(void)
{
    const lcd_board_t *b = s_board;
    gpio_config_t io_conf = {
        .pin_bit_mask = (1ULL << b->spi_sck) | (1ULL << b->spi_sda),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&io_conf);
    spi_cs(1);
    spi_sck(1);
    spi_sdo(1);
    for (size_t i = 0; i < sizeof(k_st7701s_init) / sizeof(k_st7701s_init[0]); i++) {
        uint16_t entry = k_st7701s_init[i];
        if (entry & 0x200u) vTaskDelay(pdMS_TO_TICKS(entry & 0xFF));
        else if (entry & 0x100u) spi_write_command((uint8_t)entry);
        else spi_write_data((uint8_t)entry);
    }
    spi_cs(1);
    spi_sck(1);
    spi_sdo(1);
}

/* ------------------------------------------------- the RGB peripheral */

static esp_err_t rgb_init(void)
{
    const lcd_board_t *b = s_board;
    esp_lcd_rgb_panel_config_t config = {
        .clk_src = LCD_CLK_SRC_DEFAULT,
        .timings = {
            .pclk_hz = b->pclk_hz,
            .h_res = FOS_LCD_ST7701S_WIDTH,
            .v_res = FOS_LCD_ST7701S_HEIGHT,
            .hsync_pulse_width = b->hsync_pulse,
            .hsync_back_porch = b->hsync_back,
            .hsync_front_porch = b->hsync_front,
            .vsync_pulse_width = b->vsync_pulse,
            .vsync_back_porch = b->vsync_back,
            .vsync_front_porch = b->vsync_front,
            .flags.pclk_active_neg = 0,
        },
        .data_width = 16,
        .bits_per_pixel = 16,
        .num_fbs = 1,
        /* The frame buffer lives in PSRAM and the DMA scans it from there,
         * as Seeed's firmware does. Bounce buffers would read the frame
         * buffer from an interrupt that a flash write (the cache off) turns
         * into a crash (esp_lcd_panel_rgb.c says so); without them a flash
         * write costs at most a disturbed frame. */
        .bounce_buffer_size_px = 0,
        .dma_burst_size = 64,
        .hsync_gpio_num = b->hsync,
        .vsync_gpio_num = b->vsync,
        .de_gpio_num = b->de,
        .pclk_gpio_num = b->pclk,
        .disp_gpio_num = -1,
        .flags.fb_in_psram = 1,
    };
    for (int i = 0; i < 16; i++) config.data_gpio_nums[i] = b->data[i];
    esp_err_t err = esp_lcd_new_rgb_panel(&config, &s_panel);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "RGB panel failed: %s", esp_err_to_name(err));
        return err;
    }
    err = esp_lcd_panel_reset(s_panel);
    if (err == ESP_OK) err = esp_lcd_panel_init(s_panel);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "RGB panel init failed: %s", esp_err_to_name(err));
        return err;
    }
    return ESP_OK;
}

static void backlight_set(bool on)
{
    if (s_board->backlight < 0) return;
    gpio_reset_pin((gpio_num_t)s_board->backlight);
    gpio_set_direction((gpio_num_t)s_board->backlight, GPIO_MODE_OUTPUT);
    gpio_set_level((gpio_num_t)s_board->backlight, on ? 1 : 0);
}

static void fill(uint16_t color)
{
    uint16_t row[FOS_LCD_ST7701S_WIDTH];
    for (int x = 0; x < FOS_LCD_ST7701S_WIDTH; x++) row[x] = color;
    for (int y = 0; y < FOS_LCD_ST7701S_HEIGHT; y++) {
        esp_lcd_panel_draw_bitmap(s_panel, 0, y, FOS_LCD_ST7701S_WIDTH, y + 1, row);
    }
}

int fos_lcd_st7701s_init(void)
{
    if (s_ready) return 0;
    if (expander_init() != ESP_OK) return 1;
    controller_init();
    if (rgb_init() != ESP_OK) return 1;
    /* White until the first render: a dark panel reads as a dead frame. */
    fill(0xFFFF);
    backlight_set(true);
    s_ready = true;
    ESP_LOGI(TAG, "ST7701S %dx%d up: RGB565 scan-out from PSRAM, pclk %lu Hz", FOS_LCD_ST7701S_WIDTH,
             FOS_LCD_ST7701S_HEIGHT, (unsigned long)s_board->pclk_hz);
    return 0;
}

void fos_lcd_st7701s_display(uint8_t *buf)
{
    if (!s_ready || !buf) return;
    /* One copy into the frame buffer the peripheral scans; the driver syncs
     * the cache. The picture changes within a frame (~16 ms). */
    esp_lcd_panel_draw_bitmap(s_panel, 0, 0, FOS_LCD_ST7701S_WIDTH, FOS_LCD_ST7701S_HEIGHT, buf);
}

void fos_lcd_st7701s_clear(void)
{
    if (!s_ready) return;
    fill(0xFFFF);
}

void fos_lcd_st7701s_sleep(void)
{
    /* Keep showing the frame. */
}

esp_err_t fos_lcd_st7701s_i2c_bus(int sda, int scl, void **bus)
{
    if (bus) *bus = NULL;
    if (!s_bus || sda != s_board->i2c_sda || scl != s_board->i2c_scl) return ESP_ERR_NOT_FOUND;
    if (bus) *bus = s_bus;
    return ESP_OK;
}

esp_err_t fos_lcd_st7701s_backlight(bool on)
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    backlight_set(on);
    return ESP_OK;
}

#else /* !SOC_LCD_RGB_SUPPORTED: the chip has no RGB LCD peripheral (ESP32-C3) */

int fos_lcd_st7701s_init(void)
{
    ESP_LOGE(TAG, "this chip has no RGB LCD peripheral");
    return 1;
}
void fos_lcd_st7701s_display(uint8_t *buf) { (void)buf; }
void fos_lcd_st7701s_clear(void) {}
void fos_lcd_st7701s_sleep(void) {}
esp_err_t fos_lcd_st7701s_i2c_bus(int sda, int scl, void **bus)
{
    (void)sda;
    (void)scl;
    if (bus) *bus = NULL;
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t fos_lcd_st7701s_backlight(bool on)
{
    (void)on;
    return ESP_ERR_NOT_SUPPORTED;
}

#endif
