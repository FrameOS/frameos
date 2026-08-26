// EL673-class 800x480 Spectra 6 — Inky Frame 7.3" (2025 refresh) /
// Waveshare 7.3" E (EPD_7in3e). Init ported from the FrameOS Waveshare
// reference driver (frameos/src/drivers/waveshare/ePaper/EPD_7in3e.c).
#include "panel_seq.h"

static const pk_pins_t *s_pins;

static const uint8_t seq_7in3e_init[] = {
    7, 0xAA, 0x49, 0x55, 0x20, 0x08, 0x09, 0x18, // CMDH unlock
    2, 0x01, 0x3F,
    3, 0x00, 0x5F, 0x69,
    5, 0x03, 0x00, 0x54, 0x00, 0x44,
    5, 0x05, 0x40, 0x1F, 0x1F, 0x2C,
    5, 0x06, 0x6F, 0x1F, 0x17, 0x49,
    5, 0x08, 0x6F, 0x1F, 0x1F, 0x22,
    2, 0x30, 0x03,
    2, 0x50, 0x3F,
    3, 0x60, 0x02, 0x00,
    5, 0x61, 0x03, 0x20, 0x01, 0xE0,
    2, 0x84, 0x01,
    2, 0xE3, 0x2F,
    0,
};

static bool el673_begin(const pk_panel_t *panel, const pk_pins_t *pins)
{
    (void)panel;
    s_pins = pins;
    pk_epd_spi_init(pins);
    pk_epd_reset(pins);
    if (!panel_wait_idle(pins, 5000)) return false;
    panel_run_sequence(pins, seq_7in3e_init);
    pk_epd_command(pins, 0x04); // power on
    if (!panel_wait_idle(pins, 15000)) return false;
    pk_epd_command(pins, 0x10);
    return true;
}

static void el673_write(const uint8_t *data, size_t len)
{
    pk_epd_data(s_pins, data, len);
}

static bool el673_end(const pk_pins_t *pins)
{
    // The reference driver re-tunes the booster before refresh.
    static const uint8_t seq_refresh_booster[] = {5, 0x06, 0x6F, 0x1F, 0x17, 0x49, 0};
    panel_run_sequence(pins, seq_refresh_booster);
    pk_epd_command(pins, 0x12); // refresh
    pk_epd_data_byte(pins, 0x00);
    if (!panel_wait_idle(pins, 45000)) return false;
    pk_epd_command(pins, 0x02); // power off
    pk_epd_data_byte(pins, 0x00);
    sleep_ms(200);
    pk_epd_command(pins, 0x07); // deep sleep
    pk_epd_data_byte(pins, 0xA5);
    return true;
}

const pk_panel_t pk_panel_el673_800x480 = {
    .name = "EPD_7in3e",
    .width = 800,
    .height = 480,
    .format = PK_PIXEL_4BPP_SPECTRA6,
    .begin = el673_begin,
    .write = el673_write,
    .end = el673_end,
};
