/*
 * The board's PDM microphone (docs/voice-chat.md): the MEMSensing MSM261 on
 * the Seeed reTerminal E1001/E1002/E1003 (clock GPIO42, data GPIO41, power
 * enable GPIO38), or any PDM microphone `mic_pins` names. ESP-IDF's PDM RX
 * driver on I2S0 with the hardware PDM-to-PCM filter: what comes out is
 * 16 kHz, 16-bit, mono, little-endian PCM, the shape the transcription wants.
 *
 * One microphone, one user at a time: a voice session (fos_voice.c) or the
 * console's `mic` check. The power pin is driven high for the session and
 * low after it, so the microphone draws nothing between sessions.
 *
 * An S3 only: the C3's I2S has no PDM-to-PCM filter, and no board with a
 * microphone runs the C3 image. There the calls answer ESP_ERR_NOT_SUPPORTED.
 *
 * With no PDM pins (clk / data -1) the session runs on the board's I2S codec
 * microphone instead, when it has one (fos_codec.c: the ES7210 of the
 * Waveshare PhotoPainter and 13.3E6): same DMA ring, same PCM out.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define FOS_MIC_SAMPLE_RATE_HZ 16000
#define FOS_MIC_BYTES_PER_SAMPLE 2
#define FOS_MIC_BYTES_PER_SECOND (FOS_MIC_SAMPLE_RATE_HZ * FOS_MIC_BYTES_PER_SAMPLE)

/* Power the microphone (pwr_pin, -1 when it is always on), open the PDM RX
 * channel on clk_pin / data_pin and start the clock. ESP_ERR_INVALID_STATE
 * while another user holds it, ESP_ERR_INVALID_ARG for a pin the chip
 * reserves. */
esp_err_t fos_mic_start(int clk_pin, int data_pin, int pwr_pin);
/* Up to `len` bytes of PCM into `dst`; `*got` is how many came. Blocks at
 * most `timeout_ms` for the DMA to fill. */
esp_err_t fos_mic_read(void *dst, size_t len, size_t *got, uint32_t timeout_ms);
/* Stop the clock, free the channel, power the microphone down. */
void fos_mic_stop(void);
bool fos_mic_active(void);
