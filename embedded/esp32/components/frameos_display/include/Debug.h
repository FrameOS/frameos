/* Debug shim for vendor Waveshare sources on ESP-IDF. */
#ifndef __DEBUG_H
#define __DEBUG_H

#include "esp_log.h"

#define Debug(__info, ...) ESP_LOGD("epd", "" __info, ##__VA_ARGS__)

#endif
