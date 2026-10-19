#include "fos_board_panels.h"

#include <string.h>

#include "fos_board_panels_gen.h"

#define WAVESHARE_PREFIX "waveshare."

bool fos_board_panel_name(const char *device, char *out, size_t out_len)
{
    if (!device || !out || out_len == 0) return false;
    const char *panel = device;
    for (size_t i = 0; i < sizeof(fos_panel_device_aliases) / sizeof(fos_panel_device_aliases[0]); i++) {
        if (strcmp(device, fos_panel_device_aliases[i].device) == 0) {
            panel = fos_panel_device_aliases[i].panel;
            break;
        }
    }
    if (panel == device && strncmp(device, WAVESHARE_PREFIX, strlen(WAVESHARE_PREFIX)) == 0) {
        panel = device + strlen(WAVESHARE_PREFIX);
    }
    size_t len = strlen(panel);
    if (len >= out_len) return false;
    memcpy(out, panel, len + 1);
    return true;
}

static const char *builtin_panel(const char *hardware_preset)
{
    if (!hardware_preset || !hardware_preset[0]) return NULL;
    for (size_t i = 0; i < sizeof(fos_board_builtin_panels) / sizeof(fos_board_builtin_panels[0]); i++) {
        if (strcmp(hardware_preset, fos_board_builtin_panels[i].preset) == 0) {
            return fos_board_builtin_panels[i].panel;
        }
    }
    return NULL;
}

/* The bus the wiring drives, -1 when neither set is complete. An I2C panel
 * rides the sck/mosi pins as SCL/SDA with the SPI-only pins unset (the
 * esp32_c3_042_oled preset); everything else is the EPD SPI set. */
static int wiring_bus(const fos_panel_wiring_t *w)
{
    if (w->sck < 0 || w->mosi < 0) return -1;
    if (w->rst >= 0 && w->dc >= 0 && w->cs >= 0 && w->busy >= 0) return FOS_PANEL_BUS_SPI;
    if (w->dc < 0 && w->cs < 0 && w->busy < 0) return FOS_PANEL_BUS_I2C;
    return -1;
}

const char *fos_board_panel_refusal(const char *hardware_preset, const fos_panel_wiring_t *wiring,
                                    const char *device, fos_panel_facts_fn facts)
{
    char panel[64];
    if (!device || !wiring || !facts || !fos_board_panel_name(device, panel, sizeof(panel))) {
        return "not_compiled";
    }
    if (strcmp(panel, "none") == 0) return "panel_off";
    int bus = FOS_PANEL_BUS_SPI;
    bool requires_cs2 = false;
    if (!facts(panel, &bus, &requires_cs2)) return "not_compiled";
    const char *builtin = builtin_panel(hardware_preset);
    if (builtin && strcmp(builtin, panel) != 0) return "builtin_display";
    int wired = wiring_bus(wiring);
    if (wired < 0) return "no_wiring";
    if (wired != bus) return "wrong_bus";
    if (requires_cs2 && wiring->cs2 < 0) return "needs_cs2";
    return NULL;
}
