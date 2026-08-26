/*
 * Shared diagnostics for the Waveshare panel drivers, built on the DEV_Config
 * hardware layer of whichever target compiles it (Raspberry Pi DEV_Config.c,
 * ESP32 DEV_Config_esp.c). Everything here is platform-neutral: it only uses
 * DEV_Digital_Read, DEV_Delay_ms, DEV_Debug_Log/Enabled and DEV_Error.
 *
 * Events mirror what the (now retired) native Nim drivers emitted, so the
 * frame's driver debug log reads the same as before:
 *   command          {command, commandHex}
 *   data             first 16 bytes per command, then progress every 4096
 *   display:dataPreview {count, bytes:[...]}
 *   busy:wait:start / busy:wait / busy:wait:end / busy:wait:timeout
 */
#include "DEV_Config.h"

#include <stdio.h>

#define DEV_DEBUG_DATA_PREVIEW_BYTES 16
#define DEV_DEBUG_DATA_PROGRESS_BYTES 4096
#define DEV_BUSY_LOG_INTERVAL_MS 1000

static unsigned long s_data_log_counter = 0;
static unsigned long s_data_bytes_current_command = 0;

void DEV_Debug_PinStates(char *buf, size_t len)
{
    if (buf == NULL || len == 0) return;
    snprintf(buf, len,
             "\"busy\":%d,\"rst\":%d,\"dc\":%d,\"cs\":%d,\"cs2\":%d,\"pwr\":%d",
             (int)DEV_Digital_Read(EPD_BUSY_PIN),
             (int)DEV_Digital_Read(EPD_RST_PIN),
             (int)DEV_Digital_Read(EPD_DC_PIN),
             (int)DEV_Digital_Read(EPD_CS_PIN),
             EPD_CS_S_PIN >= 0 ? (int)DEV_Digital_Read(EPD_CS_S_PIN) : -1,
             EPD_PWR_PIN >= 0 ? (int)DEV_Digital_Read(EPD_PWR_PIN) : -1);
}

void DEV_Debug_LogBytes(const char *action, unsigned long totalBytes)
{
    if (!DEV_Debug_Enabled()) return;
    char buf[64];
    snprintf(buf, sizeof(buf), "\"totalBytes\":%lu", totalBytes);
    DEV_Debug_Log(action, buf);
}

void DEV_Debug_Command(UBYTE reg)
{
    s_data_log_counter = 0;
    s_data_bytes_current_command = 0;
    if (!DEV_Debug_Enabled()) return;
    char buf[64];
    snprintf(buf, sizeof(buf), "\"command\":%u,\"commandHex\":\"0x%02X\"",
             (unsigned int)reg, (unsigned int)reg);
    DEV_Debug_Log("command", buf);
}

void DEV_Debug_Data(UBYTE data)
{
    ++s_data_bytes_current_command;
    if (DEV_Debug_Enabled()) {
        char buf[128];
        if (s_data_log_counter < DEV_DEBUG_DATA_PREVIEW_BYTES) {
            snprintf(buf, sizeof(buf), "\"index\":%lu,\"data\":%u,\"dataHex\":\"0x%02X\"",
                     s_data_bytes_current_command, (unsigned int)data, (unsigned int)data);
            DEV_Debug_Log("data", buf);
        } else if (s_data_log_counter == DEV_DEBUG_DATA_PREVIEW_BYTES) {
            snprintf(buf, sizeof(buf),
                     "\"message\":\"Further data logging suppressed for this command\",\"bytesSent\":%lu",
                     s_data_bytes_current_command);
            DEV_Debug_Log("data", buf);
        } else if (s_data_bytes_current_command % DEV_DEBUG_DATA_PROGRESS_BYTES == 0) {
            snprintf(buf, sizeof(buf), "\"message\":\"Data transfer progress\",\"bytesSent\":%lu",
                     s_data_bytes_current_command);
            DEV_Debug_Log("data", buf);
        }
    }
    ++s_data_log_counter;
}

void DEV_Debug_DataBulk(const UBYTE *data, uint32_t len)
{
    if (data == NULL || len == 0) return;
    if (DEV_Debug_Enabled()) {
        char buf[128];
        unsigned long old_sent = s_data_bytes_current_command;
        unsigned long preview = 0;
        if (s_data_log_counter < DEV_DEBUG_DATA_PREVIEW_BYTES) {
            preview = DEV_DEBUG_DATA_PREVIEW_BYTES - s_data_log_counter;
            if (preview > len) preview = len;
        }
        for (unsigned long i = 0; i < preview; i++) {
            snprintf(buf, sizeof(buf), "\"index\":%lu,\"data\":%u,\"dataHex\":\"0x%02X\"",
                     old_sent + i + 1, (unsigned int)data[i], (unsigned int)data[i]);
            DEV_Debug_Log("data", buf);
        }
        unsigned long next_sent = old_sent + len;
        if (s_data_log_counter <= DEV_DEBUG_DATA_PREVIEW_BYTES &&
            s_data_log_counter + len > DEV_DEBUG_DATA_PREVIEW_BYTES) {
            snprintf(buf, sizeof(buf),
                     "\"message\":\"Further data logging suppressed for this command\",\"bytesSent\":%lu",
                     old_sent + preview);
            DEV_Debug_Log("data", buf);
        }
        if (next_sent >= DEV_DEBUG_DATA_PROGRESS_BYTES &&
            (old_sent / DEV_DEBUG_DATA_PROGRESS_BYTES) != (next_sent / DEV_DEBUG_DATA_PROGRESS_BYTES)) {
            snprintf(buf, sizeof(buf), "\"message\":\"Data transfer progress\",\"bytesSent\":%lu", next_sent);
            DEV_Debug_Log("data", buf);
        }
    }
    s_data_bytes_current_command += len;
    s_data_log_counter += len;
}

void DEV_Debug_Preview(const UBYTE *image, unsigned long totalBytes)
{
    if (image == NULL || totalBytes == 0 || !DEV_Debug_Enabled()) return;
    int count = totalBytes < DEV_DEBUG_DATA_PREVIEW_BYTES ? (int)totalBytes : DEV_DEBUG_DATA_PREVIEW_BYTES;
    char bytes[128];
    int offset = snprintf(bytes, sizeof(bytes), "[");
    for (int i = 0; i < count && offset < (int)sizeof(bytes) - 8; i++) {
        offset += snprintf(bytes + offset, sizeof(bytes) - (size_t)offset, "%s%u",
                           i == 0 ? "" : ",", (unsigned int)image[i]);
    }
    snprintf(bytes + offset, sizeof(bytes) - (size_t)offset, "]");
    char buf[192];
    snprintf(buf, sizeof(buf), "\"count\":%d,\"bytes\":%s", count, bytes);
    DEV_Debug_Log("display:dataPreview", buf);
}

int DEV_Busy_Wait(const char *stage, int busy_level, UDOUBLE poll_ms)
{
    const char *name = stage ? stage : "wait";
    if (poll_ms == 0) poll_ms = 10;
    char pins[128];
    char buf[320];
    UDOUBLE start_ms = DEV_Millis();
    UDOUBLE elapsed_ms = 0;
    UDOUBLE last_log_ms = 0;
    unsigned long loops = 0;
    UBYTE initial = DEV_Digital_Read(EPD_BUSY_PIN);
    int observed_busy = (initial == busy_level);
    UDOUBLE busy_start_ms = 0;
    int timed_out = 0;

    if (DEV_Debug_Enabled()) {
        DEV_Debug_PinStates(pins, sizeof(pins));
        snprintf(buf, sizeof(buf), "\"stage\":\"%s\",\"initialState\":%u,\"busyLevel\":%d,\"timeoutMs\":%lu,%s",
                 name, (unsigned int)initial, busy_level, (unsigned long)EPD_BUSY_TIMEOUT_MS, pins);
        DEV_Debug_Log("busy:wait:start", buf);
    }

    while (DEV_Digital_Read(EPD_BUSY_PIN) == busy_level) {
        if (!observed_busy) {
            observed_busy = 1;
            busy_start_ms = elapsed_ms;
        }
        if (elapsed_ms >= EPD_BUSY_TIMEOUT_MS) {
            timed_out = 1;
            break;
        }
        DEV_Delay_ms(poll_ms);
        elapsed_ms = DEV_Millis() - start_ms;
        ++loops;
        if (DEV_Debug_Enabled() && elapsed_ms - last_log_ms >= DEV_BUSY_LOG_INTERVAL_MS) {
            last_log_ms = elapsed_ms;
            DEV_Debug_PinStates(pins, sizeof(pins));
            snprintf(buf, sizeof(buf), "\"stage\":\"%s\",\"loops\":%lu,\"elapsedMs\":%lu,%s",
                     name, loops, (unsigned long)elapsed_ms, pins);
            DEV_Debug_Log("busy:wait", buf);
        }
    }

    if (DEV_Debug_Enabled()) {
        DEV_Debug_PinStates(pins, sizeof(pins));
        snprintf(buf, sizeof(buf),
                 "\"stage\":\"%s\",\"durationMs\":%lu,\"loops\":%lu,\"finalState\":%u,\"observedBusy\":%s,"
                 "\"waitedForBusyMs\":%lu,\"waitedForIdleMs\":%lu,\"timedOut\":%s,%s",
                 name, (unsigned long)elapsed_ms, loops, (unsigned int)DEV_Digital_Read(EPD_BUSY_PIN),
                 observed_busy ? "true" : "false",
                 (unsigned long)(observed_busy ? busy_start_ms : 0),
                 (unsigned long)(observed_busy ? elapsed_ms - busy_start_ms : 0),
                 timed_out ? "true" : "false", pins);
        DEV_Debug_Log(timed_out ? "busy:wait:timeout" : "busy:wait:end", buf);
    }
    if (timed_out) {
        DEV_Error("e-Paper busy timeout during %s after %lu ms", name, (unsigned long)elapsed_ms);
        return -1;
    }
    return observed_busy;
}
