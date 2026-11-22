#include "fos_usb_pads.h"

#include "sdkconfig.h"
#if CONFIG_IDF_TARGET_ESP32S3
#include "hal/usb_serial_jtag_ll.h"
#endif

/* GPIO19/20 are the ESP32-S3's USB D-/D+ pads. */
#define FOS_USB_PAD_D_MINUS 19
#define FOS_USB_PAD_D_PLUS 20

static bool s_claimed = false;

void fos_usb_pads_claim(int pin_a, int pin_b)
{
#if CONFIG_IDF_TARGET_ESP32S3
    if (pin_a != FOS_USB_PAD_D_MINUS && pin_a != FOS_USB_PAD_D_PLUS &&
        pin_b != FOS_USB_PAD_D_MINUS && pin_b != FOS_USB_PAD_D_PLUS) {
        return;
    }
    /* Detach the PHY once, before the bus or the PDM line comes up: with the
     * PHY still on the pads the peripheral reads the PHY, not the chip. */
    usb_serial_jtag_ll_phy_enable_pad(false);
    s_claimed = true;
#else
    /* No native USB pads on this chip (the C3): nothing to claim. */
    (void)pin_a;
    (void)pin_b;
#endif
}

bool fos_usb_pads_claimed(void)
{
    return s_claimed;
}
