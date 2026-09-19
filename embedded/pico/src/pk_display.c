#include "pk_display.h"

#include <string.h>

#include "hardware/gpio.h"
#include "hardware/spi.h"
#include "pico/stdlib.h"

#include "pk_platform.h"
#include "pk_shiftreg.h"

// The panel table lives in the driver files.
extern const pk_panel_t pk_panel_uc8159_600x448;
extern const pk_panel_t pk_panel_uc8159_640x400;
extern const pk_panel_t pk_panel_ac073tc1a_800x480;
extern const pk_panel_t pk_panel_el673_800x480;

static const pk_panel_t *const s_panels[] = {
    &pk_panel_uc8159_600x448,
    &pk_panel_uc8159_640x400,
    &pk_panel_ac073tc1a_800x480,
    &pk_panel_el673_800x480,
};

const pk_panel_t *pk_display_find(const char *panel_key)
{
    if (panel_key == NULL || panel_key[0] == '\0') return NULL;
    for (size_t i = 0; i < sizeof(s_panels) / sizeof(s_panels[0]); i++) {
        if (strcmp(s_panels[i]->name, panel_key) == 0) {
            return s_panels[i];
        }
    }
    return NULL;
}

const pk_panel_t *pk_display_panels(size_t *count)
{
    if (count) *count = sizeof(s_panels) / sizeof(s_panels[0]);
    return s_panels[0];
}

bool pk_display_panel_known(const char *panel_key)
{
    return pk_display_find(panel_key) != NULL;
}

const pk_panel_t *pk_display_current(void)
{
    return pk_display_find(pk_config()->panel);
}

bool pk_display_show_rows(const pk_panel_t *panel, const pk_pins_t *pins,
                          pk_display_row_fn row_fn, void *ctx)
{
    static uint8_t row[512]; // widest packed row any driver here takes: 800px at 4bpp = 400
    size_t row_bytes = pk_fosb_row_bytes(panel->format, panel->width);
    if (row_bytes == 0 || row_bytes > sizeof(row)) return false;
    if (!panel->begin(panel, pins)) {
        panel->end(pins, false);
        return false;
    }
    for (int y = 0; y < panel->height; y++) {
        row_fn(ctx, y, row);
        panel->write(row, row_bytes);
    }
    return panel->end(pins, true);
}

// ---------------------------------------------------------------- SPI HAL

static spi_inst_t *spi_for_pin(int8_t sck)
{
    // RP2040/RP2350: SCK 2/6/18/22 → SPI0, SCK 10/14/26 → SPI1.
    switch (sck) {
        case 10: case 14: case 26:
            return spi1;
        default:
            return spi0;
    }
}

static spi_inst_t *s_spi = NULL;

void pk_epd_spi_init(const pk_pins_t *pins)
{
    if (s_spi != NULL) {
        spi_set_baudrate(s_spi, 20 * 1000 * 1000); // a driver may have lowered it
        return;
    }
    s_spi = spi_for_pin(pins->sck);
    spi_init(s_spi, 20 * 1000 * 1000);
    gpio_set_function(pins->sck, GPIO_FUNC_SPI);
    gpio_set_function(pins->mosi, GPIO_FUNC_SPI);
    gpio_init(pins->cs);
    gpio_set_dir(pins->cs, GPIO_OUT);
    gpio_put(pins->cs, 1);
    gpio_init(pins->dc);
    gpio_set_dir(pins->dc, GPIO_OUT);
    gpio_put(pins->dc, 0);
    if (pins->rst >= 0) {
        gpio_init(pins->rst);
        gpio_set_dir(pins->rst, GPIO_OUT);
        gpio_put(pins->rst, 1);
    }
}

void pk_epd_spi_baud(uint32_t baud_hz)
{
    if (s_spi != NULL) {
        spi_set_baudrate(s_spi, baud_hz);
    }
}

void pk_epd_command(const pk_pins_t *pins, uint8_t command)
{
    gpio_put(pins->dc, 0);
    gpio_put(pins->cs, 0);
    spi_write_blocking(s_spi, &command, 1);
    gpio_put(pins->cs, 1);
}

void pk_epd_data(const pk_pins_t *pins, const uint8_t *data, size_t len)
{
    if (len == 0) return;
    gpio_put(pins->dc, 1);
    gpio_put(pins->cs, 0);
    spi_write_blocking(s_spi, data, len);
    gpio_put(pins->cs, 1);
}

void pk_epd_data_byte(const pk_pins_t *pins, uint8_t value)
{
    pk_epd_data(pins, &value, 1);
}

void pk_epd_reset(const pk_pins_t *pins)
{
    if (pins->rst < 0) return;
    gpio_put(pins->rst, 1);
    pk_wait_ms(20);
    gpio_put(pins->rst, 0);
    pk_wait_ms(10);
    gpio_put(pins->rst, 1);
    pk_wait_ms(50);
}

bool pk_epd_wait_idle(const pk_pins_t *pins, uint32_t timeout_ms)
{
    absolute_time_t deadline = make_timeout_time_ms(timeout_ms);
    while (pk_display_busy(pins)) {
        if (absolute_time_diff_us(get_absolute_time(), deadline) < 0) {
            return false;
        }
        // A refresh is 25 s on the colour panels: the network and the USB
        // console keep turning while the panel works.
        pk_wait_ms(10);
    }
    return true;
}
