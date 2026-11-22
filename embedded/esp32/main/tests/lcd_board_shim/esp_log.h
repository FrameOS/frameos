/* Host stand-in for ESP-IDF's esp_log.h, for test_fos_lcd_board.c: the
 * C3 stub of lcd_st7701s_rgb.c logs, the test does not read it. */
#pragma once
#define ESP_LOGE(tag, ...) ((void)(tag))
#define ESP_LOGW(tag, ...) ((void)(tag))
#define ESP_LOGI(tag, ...) ((void)(tag))
