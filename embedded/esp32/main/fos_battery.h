/*
 * Battery monitoring for portable e-ink frames (M4).
 *
 * Reads a single LiPo/Li-ion cell through a resistor divider on an ADC1 pin.
 * Most battery dev boards (e.g. the XIAO ESP32-S3 with its add-on charger,
 * LILYGO T5, Waveshare battery shields) tap VBAT through a 2:1 divider; the
 * divider ratio is configurable. With no pin configured the frame runs the
 * same as before — battery sensing is purely additive.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* Set up the ADC on `gpio` (an ADC1-capable pin) with the given divider ratio
 * (Vpin = Vbat / divider, so 2.0 for a classic 100k/100k tap). gpio < 0
 * disables battery sensing. Safe to call once at boot. */
void fos_battery_init(int8_t gpio, float divider);

/* True when a battery pin is configured and the ADC came up. */
bool fos_battery_present(void);

/* Cell voltage in millivolts (after divider correction), or 0 if unavailable.
 * Averages a handful of samples; safe to call from the render task. */
int fos_battery_millivolts(void);

/* Charge estimate 0..100 from a Li-ion discharge curve, or -1 if unavailable. */
int fos_battery_percent(void);
