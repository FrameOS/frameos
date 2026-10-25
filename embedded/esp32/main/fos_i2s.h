/*
 * The one I2S receiver on an ESP32-S3 (I2S0), shared by the two things that
 * read it: the PDM microphone (fos_mic.c) and the I2S codec's ADC
 * (fos_codec.c). The register sequence both need — the controller's clocks,
 * the RX unit as 16-bit samples, the RX clock dividers — lives once, in
 * fos_mic.c; each caller adds its own slot format and pins. Private to the
 * two: the HAL types in the signature are not for the rest of the firmware.
 */
#pragma once

#include <stdbool.h>

#include "soc/soc_caps.h"

#if SOC_I2S_SUPPORTS_PDM2PCM
#include "hal/hal_utils.h"

/* Power the controller, reset the receiver and set it to 16-bit samples
 * (`mono`: one slot's sample per frame), then clock it from PLL 160 MHz
 * through `mclk_div` and `bclk_div`. The MCLK binding (to the RX or the TX
 * clock) and the slot format are the caller's. */
void fos_i2s_rx_prepare(const hal_utils_clk_div_t *mclk_div, int bclk_div, bool mono);
#endif
