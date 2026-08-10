// AC073TC1A 800x480 7-color ACeP — Inky Frame 7.3" (original) /
// Waveshare 7.3" F (EPD_7in3f). Init ported from the FrameOS Waveshare
// reference driver (frameos/src/drivers/waveshare/ePaper/EPD_7in3f.c).
#include "panel_seq.h"

static const pk_pins_t *s_pins;

static const uint8_t seq_7in3f_init[] = {
    7, 0xAA, 0x49, 0x55, 0x20, 0x08, 0x09, 0x18, // CMDH unlock
    7, 0x01, 0x3F, 0x00, 0x32, 0x2A, 0x0E, 0x2A,
    3, 0x00, 0x5F, 0x69,
    5, 0x03, 0x00, 0x54, 0x00, 0x44,
    5, 0x05, 0x40, 0x1F, 0x1F, 0x2C,
    5, 0x06, 0x6F, 0x1F, 0x1F, 0x22,
    5, 0x08, 0x6F, 0x1F, 0x1F, 0x22,
    3, 0x13, 0x00, 0x04, // IPC
    2, 0x30, 0x3C,
    2, 0x41, 0x00, // TSE
    2, 0x50, 0x3F,
    3, 0x60, 0x02, 0x00,
    5, 0x61, 0x03, 0x20, 0x01, 0xE0,
    2, 0x82, 0x1E,
    2, 0x84, 0x00,
    2, 0x86, 0x00, // AGID
    2, 0xE3, 0x2F,
    2, 0xE0, 0x00, // CCSET
    2, 0xE6, 0x00, // TSSET
    0,
};

static bool ac073_begin(const pk_panel_t *panel, const pk_pins_t *pins)
{
    (void)panel;
    s_pins = pins;
    pk_epd_spi_init(pins);
    pk_epd_reset(pins);
    if (!panel_wait_idle(pins, 5000)) return false;
    panel_run_sequence(pins, seq_7in3f_init);
    pk_epd_command(pins, 0x04); // power on before data, per reference flow
    if (!panel_wait_idle(pins, 15000)) return false;
    pk_epd_command(pins, 0x10);
    return true;
}

static void ac073_write(const uint8_t *data, size_t len)
{
    pk_epd_data(s_pins, data, len);
}

static bool ac073_end(const pk_pins_t *pins)
{
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

const pk_panel_t pk_panel_ac073tc1a_800x480 = {
    .name = "EPD_7in3f",
    .width = 800,
    .height = 480,
    .format = PK_PIXEL_4BPP_7COLOR,
    .begin = ac073_begin,
    .write = ac073_write,
    .end = ac073_end,
};
