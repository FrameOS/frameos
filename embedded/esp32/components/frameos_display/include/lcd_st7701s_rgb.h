/*
 * ST7701S 480x480 IPS LCD on the ESP32-S3's parallel RGB interface — the 4"
 * screen of the Seeed SenseCAP Indicator (D1, D1S, D1L, D1Pro).
 *
 * Not a Waveshare panel: a hand-written entry in the runtime panel table
 * (generate_panel_table.py EXTRA_PANELS) with the same init/clear/display/
 * sleep shape. Frames on this panel are 480x480 in FOS_PIXEL_RGB565, one
 * little-endian 5/6/5 word per pixel, which the LCD peripheral scans out of
 * a PSRAM frame buffer continuously: a blit is a copy into that buffer and
 * shows at once.
 *
 * The sixteen data lines, the sync pins and the pixel clock are the chip's
 * LCD peripheral's; the controller's own setup goes over a 9-bit 3-wire SPI
 * bit-banged on two GPIOs with chip-select and reset on an I2C IO expander
 * (a TCA9535 at 0x20, an HT8574 at 0x39 on later batches), the way Seeed's
 * own firmware does it. All of that is the board's wiring, so the hardware
 * preset selects the table (fos_lcd_st7701s_select_board); the panel key
 * stays LCD_ST7701S_480x480. The one board known is the SenseCAP Indicator.
 *
 * The expander's I2C bus (SDA39/SCL40 on the Indicator) also carries the
 * FT6336U touch controller: fos_lcd_st7701s_i2c_bus hands the bus to
 * fos_touch.c instead of letting two drivers open the same pins.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#define FOS_LCD_ST7701S_WIDTH 480
#define FOS_LCD_ST7701S_HEIGHT 480

/* Pick the board's wiring by hardware preset ("seeed_sensecap_indicator_d1");
 * an unknown or empty preset keeps the Indicator's, the only one there is.
 * Called by fos_display_init before the first blit. */
void fos_lcd_st7701s_select_board(const char *hardware_preset);

/* The panel table's four: init brings the whole stack up once (expander,
 * controller, RGB peripheral, backlight) and is a no-op after; display copies
 * a packed FOS_PIXEL_RGB565 frame into the scan-out buffer; clear shows
 * white; sleep keeps the picture on (an LCD that "slept" after every refresh
 * would be dark). */
int fos_lcd_st7701s_init(void);
void fos_lcd_st7701s_clear(void);
void fos_lcd_st7701s_display(uint8_t *buf);
void fos_lcd_st7701s_sleep(void);

/* The expander's I2C bus when it runs on exactly these pins: `*bus` gets the
 * `i2c_master_bus_handle_t`; ESP_ERR_NOT_FOUND for other pins or before init,
 * ESP_ERR_NOT_SUPPORTED on a chip without an RGB LCD peripheral. */
esp_err_t fos_lcd_st7701s_i2c_bus(int sda, int scl, void **bus);

/* Backlight on or off (the Indicator's GPIO45). ESP_ERR_INVALID_STATE before init. */
esp_err_t fos_lcd_st7701s_backlight(bool on);
