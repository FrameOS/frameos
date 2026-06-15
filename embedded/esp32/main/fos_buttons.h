/*
 * ESP32 GPIO buttons. Buttons are active-low inputs with internal pull-ups and
 * emit the same "button" events as the Linux gpioButton driver.
 */
#pragma once

#include "esp_err.h"

esp_err_t fos_buttons_start(void);
void fos_buttons_process_events(void);
