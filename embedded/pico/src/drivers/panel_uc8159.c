// UC8159-class 7-color ACeP panels:
//   600x448 — Inky Frame 5.7" / Waveshare 5.65" F (EPD_5in65f)
//   640x400 — Inky Frame 4.0"  / Waveshare 4.01" F (EPD_4in01f)
// Init sequences ported from the FrameOS Waveshare reference drivers.
// Data flow: init → 0x61 resolution → 0x10 → stream 4bpp pixels →
// 0x04 power on → 0x12 refresh → 0x02 power off.
#include "panel_seq.h"

static const pk_pins_t *s_pins;

static const uint8_t seq_5in65f_init[] = {
    3, 0x00, 0xEF, 0x08,
    5, 0x01, 0x37, 0x00, 0x23, 0x23,
    2, 0x03, 0x00,
    4, 0x06, 0xC7, 0xC7, 0x1D,
    2, 0x30, 0x39,
    2, 0x41, 0x00,
    2, 0x50, 0x37,
    2, 0x60, 0x22,
    5, 0x61, 0x02, 0x58, 0x01, 0xC0,
    2, 0xE3, 0xAA,
    0,
};

static const uint8_t seq_4in01f_init[] = {
    3, 0x00, 0x2F, 0x00,
    5, 0x01, 0x37, 0x00, 0x05, 0x05,
    2, 0x03, 0x00,
    4, 0x06, 0xC7, 0xC7, 0x1D,
    2, 0x41, 0x00,
    2, 0x50, 0x37,
    2, 0x60, 0x22,
    5, 0x61, 0x02, 0x80, 0x01, 0x90,
    2, 0xE3, 0xAA,
    0,
};

static bool uc8159_begin(const pk_panel_t *panel, const pk_pins_t *pins)
{
    s_pins = pins;
    pk_epd_spi_init(pins);
    pk_epd_spi_baud(3 * 1000 * 1000); // Pimoroni drives the UC8159 at 3MHz
    pk_epd_reset(pins);
    if (!panel_wait_idle(pins, 5000)) return false;
    panel_run_sequence(pins, panel->width == 600 ? seq_5in65f_init : seq_4in01f_init);
    sleep_ms(100);
    // Re-assert VCOM/data interval, then resolution, then start pixel data.
    pk_epd_command(pins, 0x50);
    pk_epd_data_byte(pins, 0x37);
    pk_epd_command(pins, 0x61);
    pk_epd_data_byte(pins, (uint8_t)(panel->width >> 8));
    pk_epd_data_byte(pins, (uint8_t)(panel->width & 0xFF));
    pk_epd_data_byte(pins, (uint8_t)(panel->height >> 8));
    pk_epd_data_byte(pins, (uint8_t)(panel->height & 0xFF));
    pk_epd_command(pins, 0x10);
    return true;
}

static void uc8159_write(const uint8_t *data, size_t len)
{
    pk_epd_data(s_pins, data, len);
}

static bool uc8159_end(const pk_pins_t *pins)
{
    pk_epd_command(pins, 0x04); // power on
    if (!panel_wait_idle(pins, 15000)) return false;
    pk_epd_command(pins, 0x12); // refresh
    if (!panel_wait_idle(pins, 45000)) return false;
    pk_epd_command(pins, 0x02); // power off
    sleep_ms(200);
    pk_epd_command(pins, 0x07); // deep sleep
    pk_epd_data_byte(pins, 0xA5);
    return true;
}

const pk_panel_t pk_panel_uc8159_600x448 = {
    .name = "EPD_5in65f",
    .width = 600,
    .height = 448,
    .format = PK_PIXEL_4BPP_7COLOR,
    .begin = uc8159_begin,
    .write = uc8159_write,
    .end = uc8159_end,
};

const pk_panel_t pk_panel_uc8159_640x400 = {
    .name = "EPD_4in01f",
    .width = 640,
    .height = 400,
    .format = PK_PIXEL_4BPP_7COLOR,
    .begin = uc8159_begin,
    .write = uc8159_write,
    .end = uc8159_end,
};
