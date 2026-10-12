#include "fos_board.h"

#include <stddef.h>
#include <string.h>

#ifdef ESP_PLATFORM
#include "sdkconfig.h"
#endif

/* Every target ESP-IDF can build for today. A chip missing from this table
 * reports its raw IDF spelling ("esp32c5") rather than a wrong dashed guess,
 * which is still readable and still honest — but add the row when FrameOS
 * starts building for it, because the rest of the stack (the backend's
 * `platform` keys, the hardware presets) uses the dashed form. */
static const struct {
    const char *idf;
    const char *frameos;
} k_targets[] = {
    {"esp32", "esp32"},
    {"esp32s2", "esp32-s2"},
    {"esp32s3", "esp32-s3"},
    {"esp32c2", "esp32-c2"},
    {"esp32c3", "esp32-c3"},
    {"esp32c5", "esp32-c5"},
    {"esp32c6", "esp32-c6"},
    {"esp32c61", "esp32-c61"},
    {"esp32h2", "esp32-h2"},
    {"esp32p4", "esp32-p4"},
};

const char *fos_board_target_name(const char *idf_target)
{
    if (!idf_target || !idf_target[0]) return "unknown";
    for (size_t i = 0; i < sizeof(k_targets) / sizeof(k_targets[0]); i++) {
        if (strcmp(idf_target, k_targets[i].idf) == 0) return k_targets[i].frameos;
    }
    return idf_target;
}

const char *fos_board_target(void)
{
#ifdef CONFIG_IDF_TARGET
    return fos_board_target_name(CONFIG_IDF_TARGET);
#else
    return "unknown";
#endif
}

const char *fos_board_module(const char *hardware_preset)
{
    /* Provisioning (`set hardware` over the console, the setup portal) stores
     * the preset key in NVS, so on any board provisioned through FrameOS this
     * is the exact answer: "xteink_x4", "trmnl_og",
     * "waveshare_esp32_s3_photopainter". A board nobody has provisioned has
     * no preset, so fall back to the chip. */
    if (hardware_preset && hardware_preset[0]) return hardware_preset;
    return fos_board_target();
}

/* Seeed's reTerminal E-series puts a passive buzzer on GPIO45 on every model
 * (Seeed's Arduino and ESPHome cookbooks drive it with PWM at 1-2 kHz). */
static const struct {
    const char *preset;
    int pin;
} k_buzzers[] = {
    {"seeed_reterminal_e1001", 45},
    {"seeed_reterminal_e1002", 45},
    {"seeed_reterminal_e1004", 45},
};

int fos_board_buzzer_pin(const char *hardware_preset)
{
    if (!hardware_preset || !hardware_preset[0]) return -1;
    for (size_t i = 0; i < sizeof(k_buzzers) / sizeof(k_buzzers[0]); i++) {
        if (strcmp(hardware_preset, k_buzzers[i].preset) == 0) return k_buzzers[i].pin;
    }
    return -1;
}
