/* Debug shim for vendor Waveshare sources on ESP-IDF. */
#ifndef __DEBUG_H
#define __DEBUG_H

#include "esp_log.h"

/* Same shim as the Pi's Debug.h (frameos/src/drivers/waveshare/ePaper): the
 * vendor drivers report a busy-pin timeout as Debug("e-Paper busy timeout")
 * and carry on, so DEV_Debug_Vendor (DEV_Debug.c, shared) recognises that one
 * message and parks a DEV_Error — here it goes to the error log. The debug
 * print itself stays ESP_LOGD; DEV_Debug_Vendor prints nothing on this
 * platform (its printf half is behind the Pi's DEBUG gate), so only the
 * timeout's call is made: every other message is a literal that compares
 * unequal at compile time, and its call and its text leave the image. */
void DEV_Debug_Vendor(const char *fmt, ...);
#define DEV_DEBUG_BUSY_TIMEOUT_MSG "e-Paper busy timeout\r\n"
#define Debug(__info, ...) \
    do { \
        ESP_LOGD("epd", "" __info, ##__VA_ARGS__); \
        if (__builtin_strcmp("" __info, DEV_DEBUG_BUSY_TIMEOUT_MSG) == 0) \
            DEV_Debug_Vendor(__info, ##__VA_ARGS__); \
    } while (0)

#endif
