#ifndef FOS_BOARD_PANELS_H
#define FOS_BOARD_PANELS_H

/* Which display panels this board can be pushed (the `device` setting of a
 * control plane's set_settings). The rule and its reasons are
 * docs/esp32-board-panels.json; the same rule runs on the cloud
 * (lib/esp32-board-panels.ts) and in the SPA (utils/esp32BoardPanels.ts),
 * against the `panels` cases of docs/cloud-frames-fixtures.json.
 *
 * Only a push is judged here. The USB console and the setup portal set any
 * compiled panel: someone is at the board there, and that is where a panel
 * gets put back. Pure C, no IDF: the panel facts come in through a lookup,
 * the firmware's own table on the chip, the fixture's in the host test. */

#include <stdbool.h>
#include <stddef.h>

#define FOS_PANEL_BUS_SPI 0
#define FOS_PANEL_BUS_I2C 1

/* The display pins the board runs with (fos_pins_t), -1 = not wired. */
typedef struct {
    int rst;
    int dc;
    int cs;
    int cs2;
    int busy;
    int sck;
    int mosi;
} fos_panel_wiring_t;

/* true when the firmware compiles in `panel`, with the bus it is driven on
 * and whether it needs pins.cs2. */
typedef bool (*fos_panel_facts_fn)(const char *panel, int *bus, bool *requires_cs2);

/* The firmware's panel name for a control plane's device key:
 * `waveshare.EPD_7in3e` and the bare `EPD_7in3e` are both EPD_7in3e, and a
 * panel with a key of its own (`oled.ssd1306_72x40`) maps through the
 * generated alias table. false when it does not fit `out`. */
bool fos_board_panel_name(const char *device, char *out, size_t out_len);

/* NULL when a board provisioned as `hardware_preset` (may be empty) and wired
 * as `wiring` can drive `device`; otherwise the reason token
 * (docs/esp32-board-panels.json): panel_off, not_compiled, builtin_display,
 * no_wiring, wrong_bus, needs_cs2. */
const char *fos_board_panel_refusal(const char *hardware_preset, const fos_panel_wiring_t *wiring,
                                    const char *device, fos_panel_facts_fn facts);

#endif /* FOS_BOARD_PANELS_H */
