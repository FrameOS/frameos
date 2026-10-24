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

/* Boards with a passive buzzer FrameOS drives with PWM, and the pitch it
 * sounds best at. Seeed's reTerminal E-series puts one on GPIO45 on every
 * model (Seeed's Arduino and ESPHome cookbooks drive it at 1-2 kHz). The
 * reTerminal Sticky has a 4 kHz electromagnetic one (FUET-5018) on GPIO48
 * behind a MOSFET with a gate pulldown (Seeed's hardware overview and
 * schematic; its own demo drives it at 4000 Hz). */
static const struct {
    const char *preset;
    int pin;
    int tone_hz;
} k_buzzers[] = {
    {"seeed_reterminal_e1001", 45, 2000},
    {"seeed_reterminal_e1002", 45, 2000},
    {"seeed_reterminal_e1004", 45, 2000},
    {"seeed_reterminal_sticky", 48, 4000},
};

static int buzzer_index(const char *hardware_preset)
{
    if (!hardware_preset || !hardware_preset[0]) return -1;
    for (size_t i = 0; i < sizeof(k_buzzers) / sizeof(k_buzzers[0]); i++) {
        if (strcmp(hardware_preset, k_buzzers[i].preset) == 0) return (int)i;
    }
    return -1;
}

int fos_board_buzzer_pin(const char *hardware_preset)
{
    int index = buzzer_index(hardware_preset);
    return index < 0 ? -1 : k_buzzers[index].pin;
}

int fos_board_buzzer_tone_hz(const char *hardware_preset)
{
    int index = buzzer_index(hardware_preset);
    return index < 0 ? 0 : k_buzzers[index].tone_hz;
}

/* The reTerminal E-series front panel: a refresh key between two arrows.
 * Held, the arrows walk the frame's scene list (a short press stays the
 * scene's to hear), and on the two models with a microphone the refresh key
 * held talks to the frame (docs/voice-chat.md: `voiceChat` is the emit the
 * button task reads off the map, fos_voice_binding.c). The E1004 wires GPIO3
 * and GPIO5 the other way round from the E1001/E1002, which is why the rules
 * name labels, never pins. */
#define RETERMINAL_ARROWS \
    "{\"event\":\"button\",\"match\":{\"label\":\"LEFT\",\"action\":\"longPress\"}," \
    "\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"prev\"}}," \
    "{\"event\":\"button\",\"match\":{\"label\":\"RIGHT\",\"action\":\"longPress\"}," \
    "\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"next\"}}"
#define RETERMINAL_VOICE \
    "{\"event\":\"button\",\"match\":{\"label\":\"REFRESH\",\"action\":\"longPress\"}," \
    "\"emit\":\"voiceChat\",\"as\":{}}"
#define RETERMINAL_EVENT_MAP "[" RETERMINAL_ARROWS "]"
#define RETERMINAL_VOICE_EVENT_MAP "[" RETERMINAL_ARROWS "," RETERMINAL_VOICE "]"

static const struct {
    const char *preset;
    const char *event_map;
} k_event_maps[] = {
    {"seeed_reterminal_e1001", RETERMINAL_VOICE_EVENT_MAP},
    {"seeed_reterminal_e1002", RETERMINAL_VOICE_EVENT_MAP},
    {"seeed_reterminal_e1004", RETERMINAL_EVENT_MAP},
};

const char *fos_board_event_map(const char *hardware_preset)
{
    if (!hardware_preset || !hardware_preset[0]) return "";
    for (size_t i = 0; i < sizeof(k_event_maps) / sizeof(k_event_maps[0]); i++) {
        if (strcmp(hardware_preset, k_event_maps[i].preset) == 0) return k_event_maps[i].event_map;
    }
    return "";
}

/* Boards with a PDM microphone: the reTerminal E1001/E1002 (and the E1003,
 * no preset yet) share one MEMSensing MSM261 on PDM clock GPIO42, data
 * GPIO41, powered through a TPS22916 load switch on GPIO38 (Seeed's
 * schematics and MicRecordToSD.ino). The E1004 has no microphone: its
 * schematic has none, and 41/42 are its J2 header's UART. */
static const struct {
    const char *preset;
    int clk;
    int data;
    int pwr;
} k_mics[] = {
    {"seeed_reterminal_e1001", 42, 41, 38},
    {"seeed_reterminal_e1002", 42, 41, 38},
};

bool fos_board_mic_pins(const char *hardware_preset, int *clk, int *data, int *pwr)
{
    if (clk) *clk = -1;
    if (data) *data = -1;
    if (pwr) *pwr = -1;
    if (!hardware_preset || !hardware_preset[0]) return false;
    for (size_t i = 0; i < sizeof(k_mics) / sizeof(k_mics[0]); i++) {
        if (strcmp(hardware_preset, k_mics[i].preset) != 0) continue;
        if (clk) *clk = k_mics[i].clk;
        if (data) *data = k_mics[i].data;
        if (pwr) *pwr = k_mics[i].pwr;
        return true;
    }
    return false;
}

/* Boards with a status LED FrameOS can light. Seeed's reTerminal E1001 and
 * E1002 have a green one on GPIO6, the E1004 on GPIO48 (ESP_IO48/LED in its
 * schematic), all three lit by pulling the pin LOW (the Arduino cookbook's
 * "inverted logic"). The red charge LED next to it belongs to the charger. */
static const struct {
    const char *preset;
    int pin;
    int type;
} k_leds[] = {
    {"seeed_reterminal_e1001", 6, 1},
    {"seeed_reterminal_e1002", 6, 1},
    {"seeed_reterminal_e1004", 48, 1},
};

bool fos_board_led(const char *hardware_preset, int *pin, int *type)
{
    if (pin) *pin = -1;
    if (type) *type = 0;
    if (!hardware_preset || !hardware_preset[0]) return false;
    for (size_t i = 0; i < sizeof(k_leds) / sizeof(k_leds[0]); i++) {
        if (strcmp(hardware_preset, k_leds[i].preset) != 0) continue;
        if (pin) *pin = k_leds[i].pin;
        if (type) *type = k_leds[i].type;
        return true;
    }
    return false;
}

/* The I2C peripherals, by board, from Seeed's schematics (E1002 V1.2, E1004
 * V1.0): every E-series model has the PCF8563 clock (0x51) and the SHT40
 * sensor (0x44) on I2C0 = SDA GPIO19 / SCL GPIO20, which is also the J2
 * header's I2C on the E1001/E1002. The SY6974B charger (0x6b) sits on
 * SDA GPIO39 / SCL GPIO40 on the E1001/E1002 and on the 19/20 bus on the
 * E1004, whose 39/40 is its J2 header instead. */
static const struct {
    const char *preset;
    const char *buses;
} k_i2c_buses[] = {
    {"seeed_reterminal_e1001", "sda=19,scl=20;sda=39,scl=40"},
    {"seeed_reterminal_e1002", "sda=19,scl=20;sda=39,scl=40"},
    {"seeed_reterminal_e1004", "sda=19,scl=20"},
};

const char *fos_board_i2c_buses(const char *hardware_preset)
{
    if (!hardware_preset || !hardware_preset[0]) return "";
    for (size_t i = 0; i < sizeof(k_i2c_buses) / sizeof(k_i2c_buses[0]); i++) {
        if (strcmp(hardware_preset, k_i2c_buses[i].preset) == 0) return k_i2c_buses[i].buses;
    }
    return "";
}

/* TF sockets. The Waveshare boards give the card a bus of its own (SPI3);
 * the reTerminal E-series hang it off the panel's SCK7/MOSI9 with MISO on
 * GPIO8 and CS on GPIO14, a card-detect contact on GPIO15 (low = seated) and
 * a TPS22916 power switch on GPIO16 (Seeed's schematics; the same three on
 * the E1001, E1002 and E1004). The XTEINK X4 shares its EPD bus too but has
 * no preset entry yet: its CS/detect/power pins are unpublished. */
static const struct {
    const char *preset;
    const char *pins;
} k_sd_pins[] = {
    {"waveshare_esp32_s3_photopainter", "cs=38,sck=39,miso=40,mosi=41"},
    {"waveshare_esp32_s3_epaper_13_3e6", "cs=15,sck=6,miso=5,mosi=7"},
    {"seeed_reterminal_e1001", "cs=14,sck=7,miso=8,mosi=9,pwr=16,det=15"},
    {"seeed_reterminal_e1002", "cs=14,sck=7,miso=8,mosi=9,pwr=16,det=15"},
    {"seeed_reterminal_e1004", "cs=14,sck=7,miso=8,mosi=9,pwr=16,det=15"},
};

const char *fos_board_sd_pins(const char *hardware_preset)
{
    if (!hardware_preset || !hardware_preset[0]) return "";
    for (size_t i = 0; i < sizeof(k_sd_pins) / sizeof(k_sd_pins[0]); i++) {
        if (strcmp(hardware_preset, k_sd_pins[i].preset) == 0) return k_sd_pins[i].pins;
    }
    return "";
}
