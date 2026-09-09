/*
 * Host stand-in for ESP-IDF's esp_err.h, for the laptop builds of the
 * IDF-free modules that return esp_err_t (fos_config_parse.c). Only the
 * values those modules use; the numbers match the IDF's.
 */
#pragma once

typedef int esp_err_t;

#define ESP_OK 0
#define ESP_FAIL (-1)
#define ESP_ERR_INVALID_ARG 0x102
