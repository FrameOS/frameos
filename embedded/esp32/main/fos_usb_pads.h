/*
 * The ESP32-S3's native USB pads (GPIO19/20) and who owns them.
 */
#pragma once

#include <stdbool.h>

/* Claim the chip's native USB pads for a peripheral that is wired to them:
 * detach the USB-Serial/JTAG PHY from the pads and remember that they are
 * spoken for, so that nobody puts the PHY back.
 *
 * The ROM leaves the USB-Serial/JTAG PHY attached to GPIO19/20, and
 * installing that driver enables the pads again
 * (`usb_serial_jtag_driver_install` calls `usb_serial_jtag_ll_phy_enable_pad
 * (true)`). A board that wires those two pads to something else — an I2C
 * bus, a touch controller, a PDM microphone — then reads the PHY instead of
 * the chip: the Sunton ESP32-8048S070's GT911 answered its first read and
 * every read after the console came up timed out, and the console flooded
 * with I2C timeouts (2026-11-22).
 *
 * `pin_a` and `pin_b` are the two pins the peripheral uses (an I2C bus's
 * sda/scl, a PDM microphone's clock/data). Nothing happens unless one of
 * them is a native USB pad.
 */
void fos_usb_pads_claim(int pin_a, int pin_b);

/* Whether some peripheral holds the native USB pads: the console then has
 * no USB-Serial/JTAG channel to offer, because its driver would take the
 * pads back. */
bool fos_usb_pads_claimed(void);
