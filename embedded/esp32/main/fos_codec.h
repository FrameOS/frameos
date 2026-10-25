/*
 * The I2S audio codec of the Waveshare PhotoPainter and 13.3E6: an Everest
 * ES8311 DAC driving a speaker through a power amplifier, and an ES7210 ADC
 * with the board's microphones, both slaves on one I2S bus the ESP32 clocks
 * (`codec_pins`; the chips answer on an `i2c_buses` bus, fos_i2c.c). Two
 * uses, nothing more:
 *
 *  - the microphone: a voice session (fos_voice.c) reads 16 kHz 16-bit mono
 *    PCM from the ADC's left channel through fos_mic.c, which owns the RX
 *    DMA ring and asks this module for the I2S receiver instead of the PDM
 *    one of the Seeed boards;
 *  - the speaker: the buzzer's notes (fos_buzzer.c) — a press's clicks, the
 *    voice chat's cues — play as tones here on a board without a buzzer, so
 *    the two boards sound like the rest.
 *
 * One I2S controller (I2S0) in standard Philips mode, master, 16 kHz:
 * MCLK 4.096 MHz (256 fs) on the mclk pin, BCLK 512 kHz, TX and RX sharing
 * the bit and word clocks. Driven on the HAL's register layer like fos_mic.c
 * (ESP-IDF's I2S driver is ~14 KB of flash); the codec register sequences
 * are Espressif's reference drivers' (esp-bsp components/es8311, es7210)
 * for exactly this clock. Hardware-unverified at the time of writing.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define FOS_CODEC_SAMPLE_RATE 16000

/* Once at boot, after fos_i2c_init: configures the chips that answered on
 * the bus and sets the I2S controller up (clock off until used). False
 * without `codec_pins` or without a chip. */
bool fos_codec_init(void);
/* An ES7210 answered: a microphone to talk into. */
bool fos_codec_has_mic(void);
/* An ES8311 answered: a speaker for the buzzer's notes. */
bool fos_codec_has_speaker(void);

/* The receiver for fos_mic.c: start the I2S clocks and the ADC's left slot
 * as 16-bit mono with `eof_bytes` per DMA buffer; fos_mic.c connects its
 * own GDMA channel and starts the RX unit. End releases the receiver (the
 * transmitter's clocks keep running while a tone plays). */
esp_err_t fos_codec_rx_begin(size_t eof_bytes);
void fos_codec_rx_end(void);

/* The speaker: a steady tone at `freq_hz` (0 = silence). The frequency is
 * quantized to the DMA ring's period (31.25 Hz steps, so a 2000 Hz click
 * is exact and a 70 Hz "no" lands on 62.5). Safe from any task. */
void fos_codec_tone(uint32_t freq_hz);
