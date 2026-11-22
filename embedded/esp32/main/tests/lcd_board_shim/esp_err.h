/* Host stand-in for ESP-IDF's esp_err.h, for test_fos_lcd_board.c: the
 * values the C3 stub of lcd_st7701s_rgb.c returns; the numbers match the
 * IDF's. */
#pragma once
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL (-1)
#define ESP_ERR_INVALID_ARG 0x102
#define ESP_ERR_INVALID_STATE 0x103
#define ESP_ERR_NOT_SUPPORTED 0x106
