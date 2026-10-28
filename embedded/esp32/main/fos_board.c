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
    {"seeed_reterminal_e1003", 45, 2000},
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
/* A touch screen's swipes in from an edge (`edgeSwipe`: the scene hears none
 * of it): from the right the next scene, from the left the previous one, and
 * up from the bottom the scene switcher (docs/scene-switcher.md). */
#define TOUCH_EDGE_SWIPES \
    "{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"right\"}," \
    "\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"next\"}}," \
    "{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"left\"}," \
    "\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"prev\"}}," \
    "{\"event\":\"edgeSwipe\",\"match\":{\"edge\":\"bottom\"}," \
    "\"emit\":\"sceneSwitcher\",\"as\":{}}"
#define RETERMINAL_EVENT_MAP "[" RETERMINAL_ARROWS "]"
#define RETERMINAL_VOICE_EVENT_MAP "[" RETERMINAL_ARROWS "," RETERMINAL_VOICE "]"
/* The E1003 has the E1001's keys and microphone, and a touch screen. */
#define RETERMINAL_TOUCH_EVENT_MAP "[" RETERMINAL_ARROWS "," RETERMINAL_VOICE "," TOUCH_EDGE_SWIPES "]"
/* The reTerminal Sticky's three keys: UP and DOWN held walk the scene list,
 * the AI key (Seeed's "AI/Power", GPIO4) held talks to the frame. */
#define STICKY_EVENT_MAP \
    "[{\"event\":\"button\",\"match\":{\"label\":\"UP\",\"action\":\"longPress\"}," \
    "\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"prev\"}}," \
    "{\"event\":\"button\",\"match\":{\"label\":\"DOWN\",\"action\":\"longPress\"}," \
    "\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"next\"}}," \
    "{\"event\":\"button\",\"match\":{\"label\":\"AI\",\"action\":\"longPress\"}," \
    "\"emit\":\"voiceChat\",\"as\":{}}]"
/* The Waveshare boards with a codec microphone (fos_codec.c): the one user
 * key each has, held, talks — KEY1 on the PhotoPainter, BOOT on the 13.3E6. */
#define ONE_KEY_VOICE_EVENT_MAP(label) \
    "[{\"event\":\"button\",\"match\":{\"label\":\"" label "\",\"action\":\"longPress\"}," \
    "\"emit\":\"voiceChat\",\"as\":{}}]"
/* The SenseCAP Indicator: one key and a touch screen, no microphone. The key
 * pressed switches the screen off and on, pressed twice is the next scene and
 * held the previous one; the edges swipe (TOUCH_EDGE_SWIPES). */
#define INDICATOR_EVENT_MAP \
    "[{\"event\":\"button\",\"match\":{\"label\":\"BUTTON\",\"action\":\"press\"}," \
    "\"emit\":\"toggleScreen\",\"as\":{}}," \
    "{\"event\":\"button\",\"match\":{\"label\":\"BUTTON\",\"action\":\"doublePress\"}," \
    "\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"next\"}}," \
    "{\"event\":\"button\",\"match\":{\"label\":\"BUTTON\",\"action\":\"longPress\"}," \
    "\"emit\":\"setCurrentScene\",\"as\":{\"direction\":\"prev\"}}," \
    TOUCH_EDGE_SWIPES "]"

static const struct {
    const char *preset;
    const char *event_map;
} k_event_maps[] = {
    {"waveshare_esp32_s3_photopainter", ONE_KEY_VOICE_EVENT_MAP("KEY1")},
    {"waveshare_esp32_s3_epaper_13_3e6", ONE_KEY_VOICE_EVENT_MAP("BOOT")},
    {"seeed_reterminal_sticky", STICKY_EVENT_MAP},
    {"seeed_reterminal_e1001", RETERMINAL_VOICE_EVENT_MAP},
    {"seeed_reterminal_e1002", RETERMINAL_VOICE_EVENT_MAP},
    {"seeed_reterminal_e1003", RETERMINAL_TOUCH_EVENT_MAP},
    {"seeed_reterminal_e1004", RETERMINAL_EVENT_MAP},
    {"seeed_sensecap_indicator_d1", INDICATOR_EVENT_MAP},
};

const char *fos_board_event_map(const char *hardware_preset)
{
    if (!hardware_preset || !hardware_preset[0]) return "";
    for (size_t i = 0; i < sizeof(k_event_maps) / sizeof(k_event_maps[0]); i++) {
        if (strcmp(hardware_preset, k_event_maps[i].preset) == 0) return k_event_maps[i].event_map;
    }
    return "";
}

/* Boards with a PDM microphone: the reTerminal E1001/E1002/E1003 share one
 * MEMSensing MSM261 on PDM clock GPIO42, data GPIO41, powered through a
 * TPS22916 load switch on GPIO38 (Seeed's schematics and MicRecordToSD.ino;
 * the E1003's board config in Seeed's SenseCraft HMI firmware has the same
 * three). The E1004 has no microphone: its
 * schematic has none, and 41/42 are its J2 header's UART. The reTerminal
 * Sticky's MSM261 is on PDM_CLK GPIO19 / PDM_DATA GPIO20 — the S3's native
 * USB pads, which its CH343 UART bridge leaves free (fos_mic.c detaches the
 * USB PHY from them) — powered through PDM_EN GPIO38 (Seeed's porting
 * specification). The Waveshare boards' microphones are their codec's
 * (k_codecs), not PDM pins. */
static const struct {
    const char *preset;
    int clk;
    int data;
    int pwr;
} k_mics[] = {
    {"seeed_reterminal_sticky", 19, 20, 38},
    {"seeed_reterminal_e1001", 42, 41, 38},
    {"seeed_reterminal_e1002", 42, 41, 38},
    {"seeed_reterminal_e1003", 42, 41, 38},
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
 * E1002 have a green one on GPIO6, lit by pulling the pin LOW (the Arduino
 * cookbook's "inverted logic"); the E1004's is on GPIO48 behind an NPN
 * transistor (ESP_IO48/LED, Q4 in its schematic) and lit HIGH — the
 * cookbook says inverted for it too, the board says otherwise (idled lit
 * and blinked dark on the bench, 2026-10-25). The E1003's is on GPIO16, lit
 * low (Seeed's SenseCraft HMI board config, Zephyr's board file; GPIO16 is
 * the TF socket's power switch on the other three). The red charge LED next
 * to it belongs to the charger. */
static const struct {
    const char *preset;
    int pin;
    int type;
} k_leds[] = {
    {"seeed_reterminal_e1001", 6, 1},
    {"seeed_reterminal_e1002", 6, 1},
    {"seeed_reterminal_e1003", 16, 1},
    {"seeed_reterminal_e1004", 48, 0},
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
 * E1004, whose 39/40 is its J2 header instead. The E1003 has all three on
 * 19/20 too, with its GT911 touch controller (0x5d) beside them
 * (k_touch_pins; Zephyr's board file, Seeed's SenseCraft HMI config). */
static const struct {
    const char *preset;
    const char *buses;
} k_i2c_buses[] = {
    /* The Waveshare boards' codec chips (fos_codec.c): the ES8311 and the
     * ES7210 on SDA47/SCL48 on the PhotoPainter — the bus its AXP2101 PMIC
     * is on too (components/frameos_display/photo_painter_pmic.c shares the
     * port) — and on SDA41/SCL42 on the 13.3E6 (Waveshare's examples). */
    {"waveshare_esp32_s3_photopainter", "sda=47,scl=48"},
    {"waveshare_esp32_s3_epaper_13_3e6", "sda=41,scl=42"},
    /* The reTerminal Sticky's MISC/BFG bus (Seeed's porting specification):
     * SDA GPIO1 / SCL GPIO0 with the PCF8563 clock, the SHT40 sensor, the
     * LSM6DS3TR-C IMU (0x6a) and the BQ27220 fuel gauge (0x55). GPIO0 is a
     * strapping pin; the bus's pull-ups keep it high through a reset. */
    {"seeed_reterminal_sticky", "sda=1,scl=0"},
    {"seeed_reterminal_e1001", "sda=19,scl=20;sda=39,scl=40"},
    {"seeed_reterminal_e1002", "sda=19,scl=20;sda=39,scl=40"},
    {"seeed_reterminal_e1003", "sda=19,scl=20"},
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
 * the E1001, E1002 and E1004). The E1003's switch is GPIO39 instead (its
 * GPIO16 is the LED), and its IT8951 answers on the card's MISO, GPIO8
 * (Seeed's SenseCraft HMI config, Zephyr's board file). The XTEINK X4 shares
 * its EPD bus too but has no preset entry yet: its CS/detect/power pins are
 * unpublished. */
static const struct {
    const char *preset;
    const char *pins;
} k_sd_pins[] = {
    {"waveshare_esp32_s3_photopainter", "cs=38,sck=39,miso=40,mosi=41"},
    {"waveshare_esp32_s3_epaper_13_3e6", "cs=15,sck=6,miso=5,mosi=7"},
    /* The reTerminal Sticky's socket on its panel's SCK13/MOSI14 with MISO
     * on GPIO12 and CS on GPIO8, a TPS22916 switch on GPIO10 and the detect
     * contact on GPIO11 (Seeed's porting specification; SPI mode only, D1/D2
     * are not wired). */
    {"seeed_reterminal_sticky", "cs=8,sck=13,miso=12,mosi=14,pwr=10,det=11"},
    {"seeed_reterminal_e1001", "cs=14,sck=7,miso=8,mosi=9,pwr=16,det=15"},
    {"seeed_reterminal_e1002", "cs=14,sck=7,miso=8,mosi=9,pwr=16,det=15"},
    {"seeed_reterminal_e1003", "cs=14,sck=7,miso=8,mosi=9,pwr=39,det=15"},
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

/* Touch panels. The reTerminal Sticky's Goodix GT911 (0x5d or 0x14, chosen
 * by the reset sequence) on its own bus — TP_I2C_SDA GPIO3 / TP_I2C_SCL
 * GPIO2 — with TP_INT GPIO21 (an RTC IO: a touch can wake the chip), TP_RSTn
 * GPIO41 and the TPS22916 load switch TP_PWR_EN GPIO42 (Seeed's porting
 * specification). The reTerminal E1003's GT911 sits on the I2C0 bus with the
 * clock (SDA19/SCL20, which fos_i2c.c lends it), INT GPIO2, reset GPIO48, no
 * load switch (Seeed's E1003_TouchDraw example and SenseCraft HMI config,
 * Zephyr's board file). The SenseCAP Indicator's FocalTech FT6336U (0x48)
 * sits on the LCD's bus, SDA GPIO39 / SCL GPIO40, next to the IO expander
 * that holds its reset; its interrupt line goes to that expander too,
 * unwired to the chip, so the driver polls it (Seeed's BSP,
 * sensecap_indicator_board.c). */
static const struct {
    const char *preset;
    const char *pins;
} k_touch_pins[] = {
    {"seeed_reterminal_sticky", "sda=3,scl=2,int=21,rst=41,en=42"},
    {"seeed_reterminal_e1003", "sda=19,scl=20,int=2,rst=48"},
    {"seeed_sensecap_indicator_d1", "sda=39,scl=40,int=-1,rst=-1,en=-1"},
};

/* A glass mounted against its panel. The Indicator's sits upside down: a tap
 * at the top left read as the bottom right (2026-10-25, the touch test). */
static const struct {
    const char *preset;
    int mirror; /* FOS_BOARD_TOUCH_MIRROR_* */
} k_touch_mirror[] = {
    {"seeed_sensecap_indicator_d1", FOS_BOARD_TOUCH_MIRROR_X | FOS_BOARD_TOUCH_MIRROR_Y},
};

int fos_board_touch_mirror(const char *hardware_preset)
{
    if (!hardware_preset || !hardware_preset[0]) return 0;
    for (size_t i = 0; i < sizeof(k_touch_mirror) / sizeof(k_touch_mirror[0]); i++) {
        if (strcmp(hardware_preset, k_touch_mirror[i].preset) == 0) return k_touch_mirror[i].mirror;
    }
    return 0;
}

const char *fos_board_touch_pins(const char *hardware_preset)
{
    if (!hardware_preset || !hardware_preset[0]) return "";
    for (size_t i = 0; i < sizeof(k_touch_pins) / sizeof(k_touch_pins[0]); i++) {
        if (strcmp(hardware_preset, k_touch_pins[i].preset) == 0) return k_touch_pins[i].pins;
    }
    return "";
}

/* Audio codecs: an ES8311 DAC behind a power amplifier and an ES7210 ADC
 * for the microphones, on one I2S bus. The PhotoPainter: MCLK14, BCLK15,
 * WS16, the ADC's data on GPIO18, the DAC's on GPIO17, the amplifier on
 * GPIO7 (Waveshare's xiaozhi board config). The 13.3E6: MCLK14, BCLK21,
 * WS47, ADC data GPIO48, DAC data GPIO45, amplifier GPIO13 (Waveshare's
 * 02_Audio_out example and the codec_board table). */
static const struct {
    const char *preset;
    const char *pins;
} k_codec_pins[] = {
    {"waveshare_esp32_s3_photopainter", "mclk=14,bclk=15,ws=16,din=18,dout=17,pa=7"},
    {"waveshare_esp32_s3_epaper_13_3e6", "mclk=14,bclk=21,ws=47,din=48,dout=45,pa=13"},
};

const char *fos_board_codec_pins(const char *hardware_preset)
{
    if (!hardware_preset || !hardware_preset[0]) return "";
    for (size_t i = 0; i < sizeof(k_codec_pins) / sizeof(k_codec_pins[0]); i++) {
        if (strcmp(hardware_preset, k_codec_pins[i].preset) == 0) return k_codec_pins[i].pins;
    }
    return "";
}
