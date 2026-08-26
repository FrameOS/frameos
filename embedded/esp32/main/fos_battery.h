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
 * disables battery sensing. `enable_gpio` >= 0 names the pin that switches
 * the divider on (boards like the Seeed reTerminal E10xx gate it through a
 * transistor so it does not drain the cell): driven high around each read,
 * low otherwise. Safe to call once at boot. */
void fos_battery_init(int8_t gpio, float divider, int8_t enable_gpio);

/* True when a battery pin is configured and the ADC came up. */
bool fos_battery_present(void);

/* One sampled read: the cell voltage in millivolts (after divider
 * correction; 0 when unavailable) and the charge estimate 0..100 from a
 * Li-ion discharge curve (-1 when unavailable), both from the SAME ADC
 * sample. Either out pointer may be NULL. Averages a handful of samples and
 * takes ~10 ms more on boards with an enable pin. Serialized by a mutex:
 * the render task, the HTTP server (/status), the console and the cloud
 * client all read it, and an unserialized caller switching the divider off
 * mid-sample turned a full cell into a ~1.9 V reading. Prefer one call per
 * pass over millivolts() + percent() back to back. */
void fos_battery_read(int *millivolts, int *percent);

/* Convenience wrappers around fos_battery_read(); each one samples. */
int fos_battery_millivolts(void);
int fos_battery_percent(void);
