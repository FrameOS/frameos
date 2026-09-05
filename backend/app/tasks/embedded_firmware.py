"""Embedded (ESP32 / Pico / virtual) frame model: platforms, flash layouts,
hardware presets, pins, panel formats — and the provisioning plan that turns
a stock release image into a specific frame.

The self-hosted backend never builds firmware. Like the cloud, it flashes the
signed generic release image published for the board's chip and flash layout
(app/api/firmware_release.py streams it from the GitHub release), tells the
board what it is over the USB console (``embedded_provisioning_plan`` →
``usb_api set <key> <value>``), and the device pulls everything else from
``GET /api/frames/{id}/embedded/settings`` (app/api/embedded_device.py). OTA
is the release OTA: the backend relays the release manifest and proxies the
signed app image, and the device verifies it against the release key baked
into every image (embedded/esp32/main/fos_ota.c). Doctrine in docs/todo.md,
"the self-hosted backend flashes what the cloud flashes".
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Optional

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.drivers.waveshare import convert_waveshare_source, get_variant_folder, get_variant_keys
from app.models.frame import (
    DEFAULT_MAX_HTTP_RESPONSE_BYTES,
    Frame,
    normalize_frame_admin_auth,
    normalize_https_proxy,
)
from app.models.log import new_log as log
from app.tasks.utils import get_fresh_frame
from app.utils.frame_http import _fetch_frame_http_bytes
from app.utils.token import secure_token

REPO_ROOT = Path(__file__).resolve().parents[3]
SUPPORTED_EMBEDDED_PLATFORM = "esp32-s3"
# Every chip the embedded firmware supports. ``family`` selects the firmware
# tree and flash story: "esp32" flashes the signed release image for the
# chip's flash layout (embedded/esp32, EMBEDDED_FLASH_PROFILES.releaseAssets)
# and is provisioned over the USB console; "pico" ships a generic UF2
# (embedded/pico) flashed over BOOTSEL and provisioned over USB serial.
# ``localRenderSupported`` gates the on-device Nim/pixie/QuickJS renderer: it
# needs PSRAM (an 800×480 RGBA compose buffer alone is 1.5MB), so PSRAM-less
# chips run thin-client only against the server-side wasm renderer.
EMBEDDED_PLATFORMS: dict[str, dict[str, Any]] = {
    "esp32-s3": {
        "label": "ESP32-S3",
        "family": "esp32",
        "idfTarget": "esp32s3",
        "aliases": {"", "esp32s3", "esp32-s3-devkitc-1"},
        "maxGpio": 48,
        "defaultPsramMB": 8,
        "localRenderSupported": True,
    },
    "esp32-c3": {
        "label": "ESP32-C3",
        "family": "esp32",
        "idfTarget": "esp32c3",
        "aliases": {"esp32c3", "esp32-c3-devkitm-1"},
        "maxGpio": 21,
        "defaultPsramMB": 0,
        "localRenderSupported": False,
    },
    "pico-w": {
        "label": "Raspberry Pi Pico W",
        "family": "pico",
        "aliases": {"pico_w", "picow", "rp2040"},
        "maxGpio": 29,
        "defaultPsramMB": 0,
        "localRenderSupported": False,
    },
    "pico-2w": {
        "label": "Raspberry Pi Pico 2 W",
        "family": "pico",
        "aliases": {"pico2_w", "pico2w", "pico-2-w", "rp2350"},
        "maxGpio": 29,
        "defaultPsramMB": 0,
        "localRenderSupported": False,
    },
    # No hardware at all: the backend renders (same wasm path as the thin
    # clients) and serves the frame as an image/page URL — for browser
    # kiosks, old tablets, or any device that can show a picture.
    # Self-hosted backends only.
    "virtual": {
        "label": "Virtual frame (backend renderer)",
        "family": "virtual",
        "aliases": {"backend-renderer", "virtual-frame"},
        "maxGpio": -1,
        "defaultPsramMB": 0,
        "localRenderSupported": False,
    },
}
EMBEDDED_PLATFORM_ALIASES = EMBEDDED_PLATFORMS[SUPPORTED_EMBEDDED_PLATFORM]["aliases"]
EMBEDDED_PROJECT_DIR = REPO_ROOT / "embedded" / "esp32"
EMBEDDED_DEFAULT_PANEL = "EPD_7in5_V2"
EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024
EMBEDDED_PIN_KEYS = ("rst", "dc", "cs", "cs2", "busy", "sck", "mosi", "pwr")
EMBEDDED_DEFAULT_PINS = {
    "rst": 5,
    "dc": 4,
    "cs": 3,
    "cs2": -1,
    "busy": 6,
    "sck": 7,
    "mosi": 9,
    "pwr": -1,
}
EMBEDDED_13IN3E_DEFAULT_PINS = {**EMBEDDED_DEFAULT_PINS, "cs2": 8}
# Waveshare ESP32-S3 PhotoPainter schematic pinout:
# EPD_DC=GPIO8, EPD_CS=GPIO9, EPD_SCK=GPIO10, EPD_DIN=GPIO11,
# EPD_RST=GPIO12, EPD_BUSY=GPIO13.
EMBEDDED_WAVESHARE_PHOTOPAINTER_PINS = {
    "rst": 12,
    "dc": 8,
    "cs": 9,
    "cs2": -1,
    "busy": 13,
    "sck": 10,
    "mosi": 11,
    "pwr": -1,
}
# Waveshare ESP32-S3 PhotoPainter back buttons:
# BOOT is ESP32 GPIO0, USER_KEY1 is GPIO4. The power key is handled by the PMIC
# power-on path and is not a plain GPIO input for the existing button driver.
EMBEDDED_WAVESHARE_PHOTOPAINTER_GPIO_BUTTONS = [
    {"pin": 0, "label": "BOOT"},
    {"pin": 4, "label": "KEY1"},
]
# Waveshare ESP32-S3 ePaper 13.3E6 GPIO table / vendor example pinout:
# EPD_PWR=GPIO1, RST_N=GPIO2, CSB_S=GPIO3, SCL=GPIO9,
# CSB_M=GPIO10, D/C=GPIO11, BUSY_N=GPIO12, SDA=GPIO46.
EMBEDDED_WAVESHARE_13IN3E6_PINS = {
    "rst": 2,
    "dc": 11,
    "cs": 10,
    "cs2": 3,
    "busy": 12,
    "sck": 9,
    "mosi": 46,
    "pwr": 1,
}
EMBEDDED_SD_CARD_ASSETS_PIN_KEYS = ("cs", "sck", "miso", "mosi")
EMBEDDED_SD_CARD_ASSETS_DEFAULT_PINS = {
    "cs": -1,
    "sck": -1,
    "miso": -1,
    "mosi": -1,
}
# Waveshare ESP32-S3 PhotoPainter TF socket, from the vendor schematic:
# TF pin 2 (DAT3/CS)=GPIO38, pin 5 (CLK)=GPIO39, pin 7 (DAT0/MISO)=GPIO40,
# pin 3 (CMD/MOSI)=GPIO41.
# Waveshare ESP32-S3 ePaper 13.3E6 TF socket: SD_D1=GPIO4,
# SD_MISO=GPIO5, SD_CLK=GPIO6, SD_MOSI=GPIO7, SD_CS=GPIO15,
# SD_D2=GPIO16. FrameOS uses SPI mode.
EMBEDDED_SD_CARD_ASSETS_PRESET_PINS = {
    "waveshare_esp32_s3_photopainter": {
        "cs": 38,
        "sck": 39,
        "miso": 40,
        "mosi": 41,
    },
    "waveshare_esp32_s3_epaper_13_3e6": {
        "cs": 15,
        "sck": 6,
        "miso": 5,
        "mosi": 7,
    },
}
EMBEDDED_SD_CARD_ASSETS_DEFAULT_MAX_FREQUENCY_KHZ = 20_000
# TRMNL OG/BWRY (ESP32-C3): EPD on SCK7/MOSI8, wake button GPIO2, battery ADC
# GPIO3. Pinout from the open usetrmnl/trmnl-firmware DEV_Config.h.
EMBEDDED_TRMNL_OG_PINS = {
    "rst": 10,
    "dc": 5,
    "cs": 6,
    "cs2": -1,
    "busy": 4,
    "sck": 7,
    "mosi": 8,
    "pwr": -1,
}
# Every ADC-sensed board in usetrmnl/trmnl-firmware reads VBAT through a 2:1
# divider (src/battery/adc_battery.cpp: pin millivolts x 2); include/config.h
# names the pin per board — PIN_BATTERY 3 on the OG/BWRY, 1 (behind a load
# switch on GPIO6, active high) on the XIAO ePaper Driver Board, 0 on the
# XTEINK X4. Hardware-unverified in FrameOS; the pins are free in each board's
# EPD/button map, so a wrong guess reads as "no battery", not a conflict.
EMBEDDED_TRMNL_OG_BATTERY = {
    "batteryPin": 3,
    "batteryDivider": 2.0,
}
EMBEDDED_XIAO_EPAPER_DRIVER_BOARD_BATTERY = {
    "batteryPin": 1,
    "batteryDivider": 2.0,
    "batteryEnablePin": 6,
}
# ESP32-C3 dev board with a 0.42" SSD1306 OLED (sold as "HW-675", the 01Space
# ESP32-C3-0.42LCD layout): I2C SDA GPIO5 / SCL GPIO6, carried on the mosi/sck
# pin slots (the firmware's I2C panels reuse them as SDA/SCL), BOOT button on
# GPIO9. 4 MB flash, no PSRAM, USB-Serial/JTAG, no battery sensing.
EMBEDDED_ESP32_C3_042_OLED_PINS = {
    "rst": -1,
    "dc": -1,
    "cs": -1,
    "cs2": -1,
    "busy": -1,
    "sck": 6,
    "mosi": 5,
    "pwr": -1,
}
EMBEDDED_XTEINK_X4_BATTERY = {
    "batteryPin": 0,
    "batteryDivider": 2.0,
}
# XTEINK X4 (ESP32-C3): SSD1677-driven 4.26" 800x480 (GDEQ0426T82). Pins from
# the open X4 firmware community (usetrmnl/trmnl-firmware BOARD_XTEINK_X4).
# The TF socket shares the display SPI bus (SCK8/MOSI10, CS12/MISO7) and the
# C3 has one general-purpose SPI host, so SD assets stay off for now.
EMBEDDED_XTEINK_X4_PINS = {
    "rst": 5,
    "dc": 4,
    "cs": 21,
    "cs2": -1,
    "busy": 6,
    "sck": 8,
    "mosi": 10,
    "pwr": -1,
}
# Seeed XIAO ePaper Driver Board (the TRMNL DIY kits): XIAO ESP32-S3 Plus
# carrier with EPD on SCK7/MOSI9, CS44, DC10, RST38, BUSY4.
EMBEDDED_XIAO_EPAPER_DRIVER_BOARD_PINS = {
    "rst": 38,
    "dc": 10,
    "cs": 44,
    "cs2": -1,
    "busy": 4,
    "sck": 7,
    "mosi": 9,
    "pwr": -1,
}
# Seeed reTerminal Sticky (ESP32-S3R8, 32MB flash): 3.97" 800x480 e-paper on
# SCK13/MOSI14, CS15, DC16, RST17, BUSY18; power button GPIO4.
EMBEDDED_SEEED_STICKY_PINS = {
    "rst": 17,
    "dc": 16,
    "cs": 15,
    "cs2": -1,
    "busy": 18,
    "sck": 13,
    "mosi": 14,
    "pwr": -1,
}
# Seeed reTerminal E1001/E1002 (ESP32-S3, 32MB flash, 8MB PSRAM): same EPD
# wiring on both — SCK7/MOSI9, CS10, DC11, RST12, BUSY13 (Zephyr board DTS
# and the open usetrmnl/trmnl-firmware agree). Buttons: GPIO3 refresh (green),
# GPIO4 left, GPIO5 right. The microSD slot's pins are not in either source,
# so SD assets stay off until confirmed from the schematic.
EMBEDDED_SEEED_RETERMINAL_E10XX_PINS = {
    "rst": 12,
    "dc": 11,
    "cs": 10,
    "cs2": -1,
    "busy": 13,
    "sck": 7,
    "mosi": 9,
    "pwr": -1,
}
EMBEDDED_SEEED_RETERMINAL_E10XX_GPIO_BUTTONS = [
    {"pin": 3, "label": "REFRESH"},
    {"pin": 4, "label": "LEFT"},
    {"pin": 5, "label": "RIGHT"},
]
# Battery through a 2:1 divider on GPIO1 (ADC1_CH0), switched on by GPIO21
# (Seeed's ESPHome cookbook: adc GPIO1, multiply 2.0, output GPIO21 "battery
# enable"; trmnl-firmware PIN_BATTERY 1 / PIN_VBAT_SWITCH 21 for the
# E1001/E1002). Verified on the E1004; the E1001/E1002 wire it the same way per
# Seeed's schematic, hardware-unverified on those two.
EMBEDDED_SEEED_RETERMINAL_E10XX_BATTERY = {
    "batteryPin": 1,
    "batteryDivider": 2.0,
    "batteryEnablePin": 21,
}
# Seeed reTerminal E1004 (ESP32-S3, 32MB flash, 8MB PSRAM): 13.3" 1200x1600
# Spectra 6 (T133A01) on the E-series SPI bus — SCK7/MOSI9, CS10, DC11,
# BUSY13 as the E1001/E1002 — but with the panel's second chip-select on
# GPIO2, reset on GPIO38 and a panel power enable on GPIO12 (the pins
# ESPHome's integrated-board definition for this model bakes in). Buttons are
# the E-series trio (GPIO3/4/5); the microSD slot's pins are still unpublished. The panel is driven as EPD_13in3e with the T133A01 tuning
# the firmware selects from this preset (components/frameos_display).
EMBEDDED_SEEED_RETERMINAL_E1004_PINS = {
    "rst": 38,
    "dc": 11,
    "cs": 10,
    "cs2": 2,
    "busy": 13,
    "sck": 7,
    "mosi": 9,
    "pwr": 12,
}
# Elecrow CrowPanel 5.79" (ESP32-S3-WROOM-1-N8R8): dual-SSD1683 792x272 panel
# on SCK12/MOSI11, CS45, DC46, RST47, BUSY48 (vendor demo code spi.h).
# Buttons: HOME=2, EXIT=1, rotary NEXT=4, OK=5, PREV=6.
EMBEDDED_ELECROW_CROWPANEL_5IN79_PINS = {
    "rst": 47,
    "dc": 46,
    "cs": 45,
    "cs2": -1,
    "busy": 48,
    "sck": 12,
    "mosi": 11,
    "pwr": -1,
}
EMBEDDED_ELECROW_CROWPANEL_5IN79_GPIO_BUTTONS = [
    {"pin": 2, "label": "HOME"},
    {"pin": 1, "label": "EXIT"},
    {"pin": 4, "label": "NEXT"},
    {"pin": 5, "label": "OK"},
    {"pin": 6, "label": "PREV"},
]
# Pimoroni Inky Frame (all sizes share the carrier wiring): EPD on SPI0
# SCK18/MOSI19, CS17, DC28, RST27; BUSY and the five front buttons read
# through a shift register on CLOCK8/LATCH9/DATA10 (busy = bit 7). The sr_*
# keys extend the ESP32 pin vocabulary; only embedded/pico consumes them.
EMBEDDED_INKY_FRAME_PINS = {
    "rst": 27,
    "dc": 28,
    "cs": 17,
    "cs2": -1,
    "busy": -1,
    "sck": 18,
    "mosi": 19,
    "pwr": -1,
    "sr_clock": 8,
    "sr_latch": 9,
    "sr_data": 10,
    "busy_bit": 7,
    # HOLD_VSYS_EN: keeps the regulator alive on battery; the pico firmware
    # asserts it first thing at boot.
    "hold_vsys": 2,
}
# Buttons A-E live behind the shift register (bits 0-4), not GPIOs; the list
# stays empty so nothing tries to configure GPIO interrupts for them.
EMBEDDED_INKY_FRAME_GPIO_BUTTONS: list[dict[str, Any]] = []
EMBEDDED_HARDWARE_PRESETS: dict[str, dict[str, Any]] = {
    "waveshare_esp32_s3_photopainter": {
        "device": "waveshare.EPD_7in3e",
        "flashSize": "16MB",
        "psramMB": 8,
        "pins": EMBEDDED_WAVESHARE_PHOTOPAINTER_PINS,
        "gpioButtons": EMBEDDED_WAVESHARE_PHOTOPAINTER_GPIO_BUTTONS,
        "sdCardAssets": {
            "enabled": True,
            "preset": "waveshare_esp32_s3_photopainter",
            "pins": EMBEDDED_SD_CARD_ASSETS_PRESET_PINS["waveshare_esp32_s3_photopainter"],
            "maxFrequencyKHz": EMBEDDED_SD_CARD_ASSETS_DEFAULT_MAX_FREQUENCY_KHZ,
            "mountPath": "/srv/assets",
        },
    },
    "waveshare_esp32_s3_epaper_13_3e6": {
        "device": "waveshare.EPD_13in3e",
        "flashSize": "32MB",
        "psramMB": 16,
        "pins": EMBEDDED_WAVESHARE_13IN3E6_PINS,
        # VBAT taps ADC1_CH7 = GPIO8 through a 1/3 divider; Waveshare's own
        # ADC examples (01_ADC_Test, Arduino + IDF) read CHANNEL_7 and
        # multiply the calibrated pin voltage by 3.
        "batteryPin": 8,
        "batteryDivider": 3.0,
        "sdCardAssets": {
            "enabled": True,
            "preset": "waveshare_esp32_s3_epaper_13_3e6",
            "pins": EMBEDDED_SD_CARD_ASSETS_PRESET_PINS["waveshare_esp32_s3_epaper_13_3e6"],
            "maxFrequencyKHz": EMBEDDED_SD_CARD_ASSETS_DEFAULT_MAX_FREQUENCY_KHZ,
            "mountPath": "/srv/assets",
        },
    },
    "trmnl_og": {
        "device": "waveshare.EPD_7in5_V2",
        "platform": "esp32-c3",
        "flashSize": "4MB",
        "psramMB": 0,
        "pins": EMBEDDED_TRMNL_OG_PINS,
        "gpioButtons": [{"pin": 2, "label": "BUTTON"}],
        **EMBEDDED_TRMNL_OG_BATTERY,
    },
    "trmnl_bwry": {
        "device": "waveshare.EPD_7in5yr",
        "platform": "esp32-c3",
        "flashSize": "4MB",
        "psramMB": 0,
        "pins": EMBEDDED_TRMNL_OG_PINS,
        "gpioButtons": [{"pin": 2, "label": "BUTTON"}],
        **EMBEDDED_TRMNL_OG_BATTERY,
    },
    "trmnl_og_diy_kit": {
        "device": "waveshare.EPD_7in5_V2",
        "flashSize": "8MB",
        "psramMB": 8,
        "pins": EMBEDDED_XIAO_EPAPER_DRIVER_BOARD_PINS,
        "gpioButtons": [{"pin": 0, "label": "BOOT"}, {"pin": 5, "label": "KEY3"}],
        **EMBEDDED_XIAO_EPAPER_DRIVER_BOARD_BATTERY,
    },
    "trmnl_4in26_diy_kit": {
        "device": "waveshare.EPD_4in26",
        "flashSize": "8MB",
        "psramMB": 8,
        "pins": EMBEDDED_XIAO_EPAPER_DRIVER_BOARD_PINS,
        "gpioButtons": [{"pin": 0, "label": "BOOT"}, {"pin": 2, "label": "KEY1"}],
        **EMBEDDED_XIAO_EPAPER_DRIVER_BOARD_BATTERY,
    },
    "xteink_x4": {
        "device": "waveshare.EPD_4in26",
        "platform": "esp32-c3",
        "flashSize": "16MB",
        "psramMB": 0,
        "pins": EMBEDDED_XTEINK_X4_PINS,
        "gpioButtons": [{"pin": 3, "label": "POWER"}],
        **EMBEDDED_XTEINK_X4_BATTERY,
    },
    "esp32_c3_042_oled": {
        "device": "oled.ssd1306_72x40",
        "platform": "esp32-c3",
        "flashSize": "4MB",
        "psramMB": 0,
        "pins": EMBEDDED_ESP32_C3_042_OLED_PINS,
        "gpioButtons": [{"pin": 9, "label": "BOOT"}],
    },
    "seeed_reterminal_sticky": {
        "device": "waveshare.EPD_3in97",
        "flashSize": "32MB",
        "psramMB": 8,
        "pins": EMBEDDED_SEEED_STICKY_PINS,
        "gpioButtons": [{"pin": 4, "label": "POWER"}],
    },
    "seeed_reterminal_e1001": {
        "device": "waveshare.EPD_7in5_V2",
        "flashSize": "32MB",
        "psramMB": 8,
        "pins": EMBEDDED_SEEED_RETERMINAL_E10XX_PINS,
        "gpioButtons": EMBEDDED_SEEED_RETERMINAL_E10XX_GPIO_BUTTONS,
        # Same switched 2:1 divider as the E1004 (GPIO1 ADC, GPIO21 enable),
        # per Seeed schematic, hardware-unverified on E1001/E1002.
        **EMBEDDED_SEEED_RETERMINAL_E10XX_BATTERY,
    },
    "seeed_reterminal_e1002": {
        "device": "waveshare.EPD_7in3e",
        "flashSize": "32MB",
        "psramMB": 8,
        "pins": EMBEDDED_SEEED_RETERMINAL_E10XX_PINS,
        "gpioButtons": EMBEDDED_SEEED_RETERMINAL_E10XX_GPIO_BUTTONS,
        # Same switched 2:1 divider as the E1004 (GPIO1 ADC, GPIO21 enable),
        # per Seeed schematic, hardware-unverified on E1001/E1002.
        **EMBEDDED_SEEED_RETERMINAL_E10XX_BATTERY,
    },
    "seeed_reterminal_e1004": {
        # 1200x1600 on an 8MB module: the 16-bit render canvas is what makes
        # this render on-device (3.7MB instead of 7.3MB RGBA).
        "device": "waveshare.EPD_13in3e",
        "flashSize": "32MB",
        "psramMB": 8,
        "pins": EMBEDDED_SEEED_RETERMINAL_E1004_PINS,
        # Same three keys as the E1001/E1002 (Seeed's ESPHome cookbook: GPIO3
        # green, GPIO4/5 white, active low).
        "gpioButtons": EMBEDDED_SEEED_RETERMINAL_E10XX_GPIO_BUTTONS,
        # 5000 mAh cell through the E-series divider (verified on hardware).
        **EMBEDDED_SEEED_RETERMINAL_E10XX_BATTERY,
        # A 5000 mAh frame: deep sleep between renders while on battery, waking
        # every 15 min for control-plane commands; stays connected on USB.
        "deepSleepOnBattery": True,
        "wakeCheckSeconds": 900,
    },
    "elecrow_crowpanel_5in79": {
        "device": "waveshare.EPD_5in79",
        "flashSize": "8MB",
        "psramMB": 8,
        "pins": EMBEDDED_ELECROW_CROWPANEL_5IN79_PINS,
        "gpioButtons": EMBEDDED_ELECROW_CROWPANEL_5IN79_GPIO_BUTTONS,
    },
    # Pimoroni Inky Frame family: Pico W (originals) / Pico 2 W (2025
    # refresh) carrier with the EPD on SPI0 and BUSY + buttons behind a
    # shift register — the extended pin keys (sr_*, busy_bit) are consumed
    # by the pico firmware's console, not the ESP32 build. The `device`
    # points at the Waveshare panel whose glass/controller matches, which
    # is what sizes the server-side thin-client render.
    "pimoroni_inky_frame_4": {
        "device": "waveshare.EPD_4in01f",
        "platform": "pico-w",
        "flashSize": "2MB",
        "psramMB": 0,
        "pins": EMBEDDED_INKY_FRAME_PINS,
        "gpioButtons": EMBEDDED_INKY_FRAME_GPIO_BUTTONS,
    },
    "pimoroni_inky_frame_5_7": {
        "device": "waveshare.EPD_5in65f",
        "platform": "pico-w",
        "flashSize": "2MB",
        "psramMB": 0,
        "pins": EMBEDDED_INKY_FRAME_PINS,
        "gpioButtons": EMBEDDED_INKY_FRAME_GPIO_BUTTONS,
    },
    "pimoroni_inky_frame_7_3": {
        "device": "waveshare.EPD_7in3f",
        "platform": "pico-w",
        "flashSize": "2MB",
        "psramMB": 0,
        "pins": EMBEDDED_INKY_FRAME_PINS,
        "gpioButtons": EMBEDDED_INKY_FRAME_GPIO_BUTTONS,
    },
    # Dec 2024 refresh: same ACeP panel, Pico 2 W aboard.
    "pimoroni_inky_frame_7_3_pico2": {
        "device": "waveshare.EPD_7in3f",
        "platform": "pico-2w",
        "flashSize": "4MB",
        "psramMB": 0,
        "pins": EMBEDDED_INKY_FRAME_PINS,
        "gpioButtons": EMBEDDED_INKY_FRAME_GPIO_BUTTONS,
    },
    # Aug 2025 refresh: Spectra 6 panel (black top border), Pico 2 W aboard.
    "pimoroni_inky_frame_7_3_spectra": {
        "device": "waveshare.EPD_7in3e",
        "platform": "pico-2w",
        "flashSize": "4MB",
        "psramMB": 0,
        "pins": EMBEDDED_INKY_FRAME_PINS,
        "gpioButtons": EMBEDDED_INKY_FRAME_GPIO_BUTTONS,
    },
}
# FOSB pixel formats. Keep in sync with fos_pixel_format_t in
# embedded/esp32/components/frameos_display/include/frameos_display.h.
FOS_PIXEL_1BPP = 1
FOS_PIXEL_DUAL_1BPP_RED = 2
FOS_PIXEL_DUAL_1BPP_YELLOW = 3
FOS_PIXEL_2BPP_GRAY = 4
FOS_PIXEL_2BPP_BWYR = 5
FOS_PIXEL_4BPP_7COLOR = 6
FOS_PIXEL_4BPP_SPECTRA6 = 7
FOS_PIXEL_4BPP_GRAY = 8
EMBEDDED_PIXEL_FORMAT_BY_COLOR = {
    "Black": FOS_PIXEL_1BPP,
    "BlackWhiteRed": FOS_PIXEL_DUAL_1BPP_RED,
    "BlackWhiteYellow": FOS_PIXEL_DUAL_1BPP_YELLOW,
    "FourGray": FOS_PIXEL_2BPP_GRAY,
    "BlackWhiteYellowRed": FOS_PIXEL_2BPP_BWYR,
    "SevenColor": FOS_PIXEL_4BPP_7COLOR,
    "SpectraSixColor": FOS_PIXEL_4BPP_SPECTRA6,
    "SixteenGray": FOS_PIXEL_4BPP_GRAY,
}
# These Waveshare variants are in the Linux catalog but not the ESP32 e-paper
# SPI component: IT8951 and the 12.48" family use different controller stacks,
# and the *_old / *_gray legacy resync variants collide at link time with
# their successors now that one firmware links every driver.
EMBEDDED_UNSUPPORTED_PANELS = {
    "EPD_10in3",
    "EPD_12in48",
    "EPD_12in48b",
    "EPD_12in48b_V2",
    "EPD_7in5_V2_gray",
    "EPD_4in2b_V2_old",
    "EPD_7in5b_V2_old",
}
EMBEDDED_PANEL_FORMATS = {
    key: EMBEDDED_PIXEL_FORMAT_BY_COLOR[convert_waveshare_source(key).color_option]
    for key in get_variant_keys()
    if key not in EMBEDDED_UNSUPPORTED_PANELS
    and get_variant_folder(key) == "ePaper"
    and convert_waveshare_source(key).color_option in EMBEDDED_PIXEL_FORMAT_BY_COLOR
}
# Must mirror components/frameos_display/generate_panel_table.py.
# Panels compiled into the firmware that are not Waveshare e-paper — mirrors
# EXTRA_PANELS in embedded/esp32/components/frameos_display/generate_panel_table.py.
EMBEDDED_EXTRA_PANELS = {
    "OLED_SSD1306_72x40": FOS_PIXEL_1BPP,
}
EMBEDDED_PANEL_FORMATS.update(EMBEDDED_EXTRA_PANELS)
# Device keys for those panels (the `waveshare.<key>` convention does not fit).
EMBEDDED_DEVICE_PANELS = {
    "oled.ssd1306_72x40": "OLED_SSD1306_72x40",
}
EMBEDDED_SUPPORTED_PANELS = {"none", *EMBEDDED_PANEL_FORMATS.keys()}
EMBEDDED_FLASH_OFFSET = "0x0"
EMBEDDED_DEFAULT_FLASH_SIZE = "8MB"
# One entry per flash layout: the partition table the release image for that
# layout carries (read for the flash report), whether it has OTA slots, and
# ``releaseAssets`` — the published release image per chip built with exactly
# that layout, which is what a board is flashed with. The asset names are the
# esp32 jobs' in .github/workflows/docker-publish-multi.yml via
# embedded/esp32/ci_build_image.sh; the generic images ARE the 8MB (S3) and
# 4MB (C3) layouts, so those entries name them. The same names come back
# from the device as the ``platform`` of its OTA manifest request
# (fos_ota_platform in embedded/esp32/main/fos_ota.c).
EMBEDDED_FLASH_PROFILES: dict[str, dict[str, Any]] = {
    # Pico W (RP2040). Informational only: pico-family firmware is a generic
    # UF2 flashed over BOOTSEL; there is no partition table to report.
    "2MB": {
        "flashSize": "2MB",
        "flashBytes": 2 * 1024 * 1024,
        "partitionTable": None,
        "otaSupported": False,
        "releaseAssets": {},
    },
    "4MB": {
        "flashSize": "4MB",
        "flashBytes": 4 * 1024 * 1024,
        "partitionTable": "partitions_4mb.csv",
        "otaSupported": False,
        "releaseAssets": {"esp32-s3": "esp32-s3-4mb", "esp32-c3": "esp32-c3-generic"},
    },
    "8MB": {
        "flashSize": "8MB",
        "flashBytes": 8 * 1024 * 1024,
        "partitionTable": "partitions.csv",
        "otaSupported": True,
        "releaseAssets": {"esp32-s3": "esp32-s3-generic", "esp32-c3": "esp32-c3-8mb"},
    },
    "16MB": {
        "flashSize": "16MB",
        "flashBytes": 16 * 1024 * 1024,
        "partitionTable": "partitions_ota_16mb.csv",
        "otaSupported": True,
        "releaseAssets": {"esp32-s3": "esp32-s3-16mb", "esp32-c3": "esp32-c3-16mb"},
    },
    "32MB": {
        "flashSize": "32MB",
        "flashBytes": 32 * 1024 * 1024,
        "partitionTable": "partitions_ota_32mb.csv",
        "otaSupported": True,
        "releaseAssets": {"esp32-s3": "esp32-s3-32mb", "esp32-c3": "esp32-c3-32mb"},
    },
}
# The published GENERIC images (release assets), and the layout each is built
# with. They carry no per-frame configuration at all: a board flashed with
# one is told what it is over the USB console afterwards
# (embedded_provisioning_plan). These are the fallback when a release predates
# the per-layout assets above, and what the cloud flasher ships. Keep in sync
# with PROVISIONING_ASSETS in app/api/firmware_release.py.
EMBEDDED_RELEASE_FIRMWARE: dict[str, dict[str, str]] = {
    "esp32-s3": {"asset": "esp32-s3-generic", "flashSize": "8MB"},
    "esp32-c3": {"asset": "esp32-c3-generic", "flashSize": "4MB"},
}


def embedded_release_asset_names() -> list[str]:
    """Every release asset the flash profiles name, generic ones first."""
    names = [release["asset"] for release in EMBEDDED_RELEASE_FIRMWARE.values()]
    for profile in EMBEDDED_FLASH_PROFILES.values():
        for asset in profile["releaseAssets"].values():
            if asset not in names:
                names.append(asset)
    return names


def embedded_release_firmware_for_frame(
    frame: Frame, published_assets: Optional[set[str]] = None
) -> Optional[dict[str, Any]]:
    """The release image to flash this frame with: the one built for its
    flash layout when the release publishes it, else the chip's generic image.

    ``published_assets`` is the set of provisioning platforms the current
    release actually carries (app/api/firmware_release.py). None means
    "unknown" (GitHub unreachable, or a caller with no listing) and resolves
    to the generic image, which every release since the flasher exists has
    shipped — the size-matched assets only started with docs/todo.md step 1,
    so an older release must keep flashing.
    """
    platform = embedded_platform_for_frame(frame)
    generic = EMBEDDED_RELEASE_FIRMWARE.get(platform)
    if generic is None:
        return None
    flash_size = embedded_flash_size_for_frame(frame)
    profile = EMBEDDED_FLASH_PROFILES[flash_size]
    asset = profile["releaseAssets"].get(platform)
    if asset and (asset == generic["asset"] or (published_assets is not None and asset in published_assets)):
        return {"asset": asset, "flashSize": flash_size, "otaSupported": bool(profile["otaSupported"])}
    generic_profile = EMBEDDED_FLASH_PROFILES[generic["flashSize"]]
    return {**generic, "otaSupported": bool(generic_profile["otaSupported"])}
# Memory guardrail (M4): the on-device renderer composites into a pixie canvas
# (frameos/src/embedded/embedded_runtime.nim `renderCanvas`), packs it to the
# selected panel format, and needs headroom for the Nim heap + QuickJS. The
# canvas is RGBX (4 B/px) when a full canvas takes at most half the module's
# PSRAM, else 16-bit RGB 5/6/5 (2 B/px) — the 800x480 boards and a 1200x1600
# panel on a 16 MB module render in full colour, 1200x1600 on 8 MB is the one
# that needs 565. Keep the rule and the reserve in sync with
# fos_render_canvas_bytes_per_pixel / FOS_RENDER_PSRAM_RESERVE in
# components/frameos_display (the firmware's boot-time fit check),
# sceneCanvasFormat in embedded_runtime.nim, and EmbeddedReserveBytes in
# frameos/src/frameos/utils/memory.nim.
EMBEDDED_RENDER_CANVAS_RGBX_MAX_PSRAM_SHARE = 2
EMBEDDED_RENDER_PSRAM_RESERVE_BYTES = 1536 * 1024
EMBEDDED_QUICKJS_HEAP_LIMIT_BYTES = 4 * 1024 * 1024
EMBEDDED_PREVIEW_SNAPSHOT_RESERVE_BYTES = 1024 * 1024
EMBEDDED_DISPLAY_STATE_BYTES = 80
EMBEDDED_RENDER_LOCAL = 0
EMBEDDED_RENDER_REMOTE = 1


def normalize_embedded_platform(platform: str | None) -> str:
    value = (platform or "").strip().lower()
    for key, spec in EMBEDDED_PLATFORMS.items():
        if value == key or value in spec["aliases"]:
            return key
    raise ValueError(f"Unsupported embedded platform: {value or '(empty)'}")


def embedded_platform_for_frame(frame: Frame) -> str:
    """Chip target for the frame. A hardware preset pins the platform (it is a
    physical property of the board); otherwise the frame's stored platform."""
    preset_key = embedded_hardware_preset_for_frame(frame)
    if preset_key:
        return normalize_embedded_platform(
            EMBEDDED_HARDWARE_PRESETS[preset_key].get("platform", SUPPORTED_EMBEDDED_PLATFORM)
        )
    for source in (frame.embedded, frame.device_config):
        if isinstance(source, dict) and source.get("platform"):
            return normalize_embedded_platform(str(source.get("platform")))
    return SUPPORTED_EMBEDDED_PLATFORM


def embedded_platform_spec_for_frame(frame: Frame) -> dict[str, Any]:
    return EMBEDDED_PLATFORMS[embedded_platform_for_frame(frame)]


def is_virtual_frame(frame: Frame) -> bool:
    """Backend-rendered frame with no hardware: assets and scene state live on
    the backend instead of a device."""
    if (frame.mode or "rpios") != "embedded":
        return False
    try:
        return embedded_platform_spec_for_frame(frame)["family"] == "virtual"
    except ValueError:
        return False


def _embedded_platform_or_default(frame: Frame) -> str:
    """The frame's chip target, tolerating malformed metadata (error paths)."""
    try:
        return embedded_platform_for_frame(frame)
    except ValueError:
        return SUPPORTED_EMBEDDED_PLATFORM


def embedded_max_gpio_for_frame(frame: Frame) -> int:
    return int(embedded_platform_spec_for_frame(frame)["maxGpio"])


def normalize_embedded_flash_size(value: object | None) -> str:
    if value is None or value == "":
        return EMBEDDED_DEFAULT_FLASH_SIZE
    if isinstance(value, bool):
        raise ValueError("Unsupported ESP32 flash size: boolean")
    if isinstance(value, (int, float)):
        normalized = f"{int(value)}MB"
    else:
        normalized = str(value).strip().upper().replace(" ", "")
        if normalized.isdigit():
            normalized = f"{normalized}MB"
        elif normalized.endswith("M") and not normalized.endswith("MB"):
            normalized = f"{normalized[:-1]}MB"
    if normalized in EMBEDDED_FLASH_PROFILES:
        return normalized
    supported = ", ".join(EMBEDDED_FLASH_PROFILES)
    raise ValueError(f"Unsupported ESP32 flash size: {value!r}. Supported sizes: {supported}.")


def embedded_flash_size_for_frame(frame: Frame) -> str:
    for source in (frame.embedded, frame.device_config):
        if isinstance(source, dict):
            for key in ("flashSize", "flash_size", "flashSizeMB", "flash_size_mb"):
                if key in source:
                    return normalize_embedded_flash_size(source.get(key))
    preset_key = embedded_hardware_preset_for_frame(frame)
    if preset_key:
        return normalize_embedded_flash_size(EMBEDDED_HARDWARE_PRESETS[preset_key]["flashSize"])
    platform = embedded_platform_for_frame(frame)
    if platform == "pico-w":
        return "2MB"
    if platform == "pico-2w":
        return "4MB"
    return EMBEDDED_DEFAULT_FLASH_SIZE


def embedded_flash_profile_for_frame(frame: Frame) -> dict[str, Any]:
    return EMBEDDED_FLASH_PROFILES[embedded_flash_size_for_frame(frame)]


def embedded_ota_supported_for_frame(frame: Frame) -> bool:
    return bool(embedded_flash_profile_for_frame(frame)["otaSupported"])


def embedded_panel_for_device(device: str | None) -> str | None:
    """The firmware panel name for a device string, None when the firmware has no driver for it."""
    device = str(device or "")
    if device in EMBEDDED_DEVICE_PANELS:
        return EMBEDDED_DEVICE_PANELS[device]
    if device.startswith("waveshare."):
        panel = device.split(".", 1)[1]
        if panel in EMBEDDED_SUPPORTED_PANELS:
            return panel
    return None


def embedded_panel_for_frame(frame: Frame) -> str:
    """Map the frame's device string to a firmware panel name."""
    preset_key = embedded_hardware_preset_for_frame(frame)
    if preset_key and not frame.device:
        panel = embedded_panel_for_device(EMBEDDED_HARDWARE_PRESETS[preset_key]["device"])
        if panel:
            return panel
    return embedded_panel_for_device(frame.device) or "none"


def embedded_module_psram_bytes(frame: Frame) -> int:
    """PSRAM on the target module. Defaults to 8MB (current ESP32-S3 dev modules);
    override per-frame with ``device_config.psramMB`` / ``embedded.psramMB``."""
    for source in (frame.device_config, frame.embedded):
        if isinstance(source, dict):
            mb = source.get("psramMB", source.get("psram_mb"))
            if isinstance(mb, (int, float)) and not isinstance(mb, bool) and mb > 0:
                return int(mb * 1024 * 1024)
    preset_key = embedded_hardware_preset_for_frame(frame)
    if preset_key:
        return int(EMBEDDED_HARDWARE_PRESETS[preset_key]["psramMB"] * 1024 * 1024)
    return int(embedded_platform_spec_for_frame(frame)["defaultPsramMB"] * 1024 * 1024)


def embedded_render_mode_for_frame(frame: Frame) -> int:
    """Default render mode baked into the firmware image: local unless opted
    into remote/thin-client mode in device_config or embedded metadata.
    Platforms without local-render support (no PSRAM) are always remote."""
    if not embedded_platform_spec_for_frame(frame)["localRenderSupported"]:
        return EMBEDDED_RENDER_REMOTE
    for source in (frame.device_config, frame.embedded):
        if isinstance(source, dict):
            value = source.get("renderMode", source.get("render_mode"))
            if isinstance(value, str):
                normalized = value.strip().lower().replace("-", "_")
                if normalized in {"remote", "thin_client", "thinclient", "backend"}:
                    return EMBEDDED_RENDER_REMOTE
                if normalized in {"local", "on_device", "ondevice"}:
                    return EMBEDDED_RENDER_LOCAL
            elif isinstance(value, int) and not isinstance(value, bool):
                return EMBEDDED_RENDER_REMOTE if value == EMBEDDED_RENDER_REMOTE else EMBEDDED_RENDER_LOCAL
    return EMBEDDED_RENDER_LOCAL


def embedded_device_config(frame: Frame) -> dict[str, Any]:
    return frame.device_config if isinstance(frame.device_config, dict) else {}


def normalize_embedded_hardware_preset(value: object | None) -> str:
    normalized = str(value or "").strip().replace("-", "_").replace(".", "_").lower()
    if normalized in {"", "custom", "none"}:
        return ""
    if normalized in EMBEDDED_HARDWARE_PRESETS:
        return normalized
    supported = ", ".join(["custom", *EMBEDDED_HARDWARE_PRESETS])
    raise ValueError(f"Unsupported ESP32 hardware preset: {value!r}. Supported presets: {supported}.")


def embedded_hardware_preset_for_frame(frame: Frame) -> str:
    for source in (frame.embedded, frame.device_config):
        if isinstance(source, dict):
            for key in ("hardwarePreset", "hardware_preset", "boardPreset", "board_preset"):
                if key in source:
                    return normalize_embedded_hardware_preset(source.get(key))
    return ""


# Preset keys that are user-editable afterwards (the frame's Power section):
# apply_embedded_hardware_preset fills them in only while they are unset under
# either spelling (device_config carries camelCase or snake_case, see
# _embedded_device_config_value).
EMBEDDED_PRESET_SEED_ONLY_KEYS = (
    ("batteryPin", "battery_pin"),
    ("batteryDivider", "battery_divider"),
    ("batteryEnablePin", "battery_enable_pin"),
    ("deepSleepOnBattery", "deep_sleep_on_battery"),
    ("wakeCheckSeconds", "wake_check_seconds"),
)


def apply_embedded_hardware_preset(frame: Frame) -> str:
    preset_key = embedded_hardware_preset_for_frame(frame)
    if not preset_key:
        return ""
    preset = EMBEDDED_HARDWARE_PRESETS[preset_key]

    frame.device = preset["device"]
    preset_gpio_buttons = preset.get("gpioButtons")
    if frame.gpio_buttons is None and isinstance(preset_gpio_buttons, list):
        frame.gpio_buttons = [dict(button) for button in preset_gpio_buttons]

    embedded = dict(frame.embedded or {})
    embedded["hardwarePreset"] = preset_key
    embedded["flashSize"] = preset["flashSize"]
    embedded["platform"] = normalize_embedded_platform(
        preset.get("platform", SUPPORTED_EMBEDDED_PLATFORM)
    )
    frame.embedded = embedded

    device_config = dict(embedded_device_config(frame))
    device_config["hardwarePreset"] = preset_key
    device_config["psramMB"] = preset["psramMB"]
    device_config["pins"] = dict(preset["pins"])
    sd_card_assets = preset.get("sdCardAssets")
    if isinstance(sd_card_assets, dict):
        device_config["sdCardAssets"] = {
            **sd_card_assets,
            "pins": dict(sd_card_assets["pins"]),
        }
    else:
        device_config.pop("sdCardAssets", None)
    # Battery wiring and the power policy the board ships with are seeds, not
    # overrides: the Power section (SPA and cloud) edits these keys, and this
    # runs again on every PATCH and before every build, so a value the user
    # already set has to survive — the same rule as gpio_buttons above.
    for key, snake_key in EMBEDDED_PRESET_SEED_ONLY_KEYS:
        if key in preset and device_config.get(key) is None and device_config.get(snake_key) is None:
            device_config[key] = preset[key]
    frame.device_config = device_config
    return preset_key


EMBEDDED_SCALING_MODES = ("contain", "cover", "stretch", "center")


def embedded_scaling_mode_for_frame(frame: Frame) -> str:
    """The fallback fit sent to embedded devices. Default "cover" — what the
    embedded runtime always hardcoded — deliberately NOT the Pi's "contain"
    default, so the config path shipping does not change how existing
    embedded frames render. Unknown values fall back rather than reaching
    the device."""
    value = str(getattr(frame, "scaling_mode", None) or "").strip().lower()
    return value if value in EMBEDDED_SCALING_MODES else "cover"


def embedded_max_http_response_bytes_for_frame(frame: Frame) -> int:
    value = getattr(frame, "max_http_response_bytes", None)
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        return EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES
    if value == DEFAULT_MAX_HTTP_RESPONSE_BYTES:
        return EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES
    return value


def embedded_default_pins_for_panel(panel: str) -> dict[str, int]:
    if panel == "EPD_13in3e":
        return dict(EMBEDDED_13IN3E_DEFAULT_PINS)
    return dict(EMBEDDED_DEFAULT_PINS)


def embedded_default_pins_for_frame(frame: Frame) -> dict[str, int]:
    preset_key = embedded_hardware_preset_for_frame(frame)
    if preset_key:
        return dict(EMBEDDED_HARDWARE_PRESETS[preset_key]["pins"])
    return embedded_default_pins_for_panel(embedded_panel_for_frame(frame))


def embedded_pins_for_frame(frame: Frame) -> dict[str, int]:
    pins = embedded_default_pins_for_frame(frame)
    raw_pins = embedded_device_config(frame).get("pins")
    if not isinstance(raw_pins, dict):
        return pins
    max_gpio = embedded_max_gpio_for_frame(frame)
    for key in EMBEDDED_PIN_KEYS:
        raw_value = raw_pins.get(key)
        if raw_value is None and key == "sck":
            raw_value = raw_pins.get("sclk")
        if isinstance(raw_value, int) and not isinstance(raw_value, bool) and -1 <= raw_value <= max_gpio:
            pins[key] = raw_value
    return pins


def embedded_sd_card_assets_for_frame(frame: Frame) -> dict[str, Any]:
    device_config = embedded_device_config(frame)
    raw = device_config.get("sdCardAssets", device_config.get("sd_card_assets"))
    preset_key = embedded_hardware_preset_for_frame(frame)
    if not isinstance(raw, dict) and preset_key:
        raw = EMBEDDED_HARDWARE_PRESETS[preset_key].get("sdCardAssets")
    if not isinstance(raw, dict):
        raw = {}

    preset = str(raw.get("preset") or "custom").strip() or "custom"
    normalized_preset = preset.replace("-", "_").lower()
    pins = dict(
        EMBEDDED_SD_CARD_ASSETS_PRESET_PINS.get(
            normalized_preset,
            EMBEDDED_SD_CARD_ASSETS_DEFAULT_PINS,
        )
    )

    raw_pins = raw.get("pins")
    if not isinstance(raw_pins, dict):
        raw_pins = raw
    max_gpio = embedded_max_gpio_for_frame(frame)
    for key in EMBEDDED_SD_CARD_ASSETS_PIN_KEYS:
        raw_value = raw_pins.get(key)
        if isinstance(raw_value, int) and not isinstance(raw_value, bool) and -1 <= raw_value <= max_gpio:
            pins[key] = raw_value

    raw_frequency = raw.get("maxFrequencyKHz", raw.get("max_frequency_khz"))
    max_frequency_khz = EMBEDDED_SD_CARD_ASSETS_DEFAULT_MAX_FREQUENCY_KHZ
    if isinstance(raw_frequency, (int, float)) and not isinstance(raw_frequency, bool):
        max_frequency_khz = int(max(400, min(40_000, raw_frequency)))

    enabled = raw.get("enabled") is True
    if enabled and any(pins[key] < 0 for key in EMBEDDED_SD_CARD_ASSETS_PIN_KEYS):
        enabled = False

    return {
        "enabled": enabled,
        "preset": normalized_preset if normalized_preset in EMBEDDED_SD_CARD_ASSETS_PRESET_PINS else "custom",
        "mountPath": "/srv/assets",
        "pins": pins,
        "maxFrequencyKHz": max_frequency_khz,
    }


def embedded_pixel_format_for_panel(panel: str) -> int:
    return EMBEDDED_PANEL_FORMATS.get(panel, FOS_PIXEL_1BPP)


def embedded_buffer_size(width: int, height: int, pixel_format: int) -> int:
    if pixel_format in (FOS_PIXEL_1BPP,):
        return ((width + 7) // 8) * height
    if pixel_format in (FOS_PIXEL_DUAL_1BPP_RED, FOS_PIXEL_DUAL_1BPP_YELLOW):
        return ((width + 7) // 8) * height * 2
    if pixel_format in (FOS_PIXEL_2BPP_GRAY, FOS_PIXEL_2BPP_BWYR):
        return ((width + 3) // 4) * height
    if pixel_format in (FOS_PIXEL_4BPP_7COLOR, FOS_PIXEL_4BPP_SPECTRA6, FOS_PIXEL_4BPP_GRAY):
        return ((width + 1) // 2) * height
    raise ValueError(f"Unsupported embedded pixel format: {pixel_format}")


def embedded_render_canvas_bytes_per_pixel(width: int, height: int, psram_bytes: int) -> int:
    """Bytes per pixel of the scene canvas on a module with ``psram_bytes`` of PSRAM:
    4 (RGBX) when a full canvas takes at most half of it, else 2 (RGB 5/6/5)."""
    if width <= 0 or height <= 0:
        return 0
    rgbx = width * height * 4
    if psram_bytes > 0 and rgbx * EMBEDDED_RENDER_CANVAS_RGBX_MAX_PSRAM_SHARE <= psram_bytes:
        return 4
    return 2


def embedded_render_psram_bytes(
    width: int, height: int, pixel_format: int = FOS_PIXEL_1BPP, psram_bytes: int = 8 * 1024 * 1024
) -> int:
    """PSRAM the on-device renderer needs for a width×height panel on a module with
    ``psram_bytes`` of PSRAM (the canvas format depends on it)."""
    canvas = width * height * embedded_render_canvas_bytes_per_pixel(width, height, psram_bytes)
    packed = embedded_buffer_size(width, height, pixel_format)
    return canvas + packed + EMBEDDED_RENDER_PSRAM_RESERVE_BYTES


def _parse_embedded_size(value: str) -> int:
    raw = value.strip()
    if not raw:
        return 0
    if raw.lower().startswith("0x"):
        return int(raw, 16)
    suffix = raw[-1:].upper()
    number = raw[:-1] if suffix in {"K", "M"} else raw
    multiplier = 1024 if suffix == "K" else 1024 * 1024 if suffix == "M" else 1
    return int(number, 10) * multiplier


def _embedded_partition_table_rows(table_name: str | None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not table_name:  # pico family: no ESP-IDF partition table
        return rows
    table_path = EMBEDDED_PROJECT_DIR / table_name
    next_offset = 0
    if not table_path.is_file():
        return rows
    for line in table_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = [part.strip() for part in stripped.split(",")]
        if len(parts) < 5:
            continue
        name, partition_type, subtype, offset_raw, size_raw = parts[:5]
        offset = _parse_embedded_size(offset_raw) if offset_raw else next_offset
        size = _parse_embedded_size(size_raw)
        rows.append({
            "name": name,
            "type": partition_type,
            "subtype": subtype,
            "offset": offset,
            "size": size,
            "end": offset + size,
        })
        next_offset = offset + size
    return rows


def _embedded_bmp_preview_bytes(width: int, height: int, pixel_format: int) -> int:
    if width <= 0 or height <= 0:
        return 0
    bit_count = 1 if pixel_format == FOS_PIXEL_1BPP else 4
    palette_entries = 2 if bit_count == 1 else 16
    row_stride = (((width * bit_count) + 31) // 32) * 4
    return 54 + palette_entries * 4 + row_stride * height


def _pixel_format_name(pixel_format: int) -> str:
    return {
        FOS_PIXEL_1BPP: "1bpp black/white",
        FOS_PIXEL_DUAL_1BPP_RED: "dual 1bpp black/red",
        FOS_PIXEL_DUAL_1BPP_YELLOW: "dual 1bpp black/yellow",
        FOS_PIXEL_2BPP_GRAY: "2bpp grayscale",
        FOS_PIXEL_2BPP_BWYR: "2bpp black/white/yellow/red",
        FOS_PIXEL_4BPP_7COLOR: "4bpp 7-color",
        FOS_PIXEL_4BPP_SPECTRA6: "4bpp Spectra 6",
        FOS_PIXEL_4BPP_GRAY: "4bpp grayscale",
    }.get(pixel_format, f"format {pixel_format}")


def embedded_firmware_layout_for_frame(frame: Frame) -> dict[str, Any]:
    """The board's flash layout (from the release image's partition table)
    and the on-device memory plan for its panel — what the deploy drawer
    draws. Byte counts of the image itself are not known here: the image is
    a release asset, not something this backend built."""
    flash_profile = embedded_flash_profile_for_frame(frame)

    partitions = [
        {
            "name": "bootloader",
            "type": "system",
            "subtype": "bootloader",
            "offset": 0,
            "size": 0x8000,
            "end": 0x8000,
            "usedBytes": None,
        },
        {
            "name": "partition_table",
            "type": "system",
            "subtype": "partition_table",
            "offset": 0x8000,
            "size": 0x1000,
            "end": 0x9000,
            "usedBytes": None,
        },
    ]
    app_slot_names = {"factory"} if not flash_profile["otaSupported"] else {"ota_0", "ota_1"}
    for partition in _embedded_partition_table_rows(flash_profile["partitionTable"]):
        if partition["name"] in app_slot_names:
            partition = {**partition, "appSlot": True, "usedBytes": None}
        partitions.append(partition)

    from app.drivers.devices import device_dimensions

    panel = embedded_panel_for_frame(frame)
    dims = device_dimensions(frame.device) or (0, 0)
    width, height = dims
    pixel_format = embedded_pixel_format_for_panel(panel)
    psram_bytes = embedded_module_psram_bytes(frame)
    canvas_bytes_per_pixel = embedded_render_canvas_bytes_per_pixel(width, height, psram_bytes)
    canvas_bytes = width * height * canvas_bytes_per_pixel
    packed_bytes = embedded_buffer_size(width, height, pixel_format) if width > 0 and height > 0 else 0
    render_mode = embedded_render_mode_for_frame(frame)
    render_working_bytes = (
        canvas_bytes + packed_bytes + EMBEDDED_RENDER_PSRAM_RESERVE_BYTES
        if render_mode == EMBEDDED_RENDER_LOCAL and panel != "none"
        else 0
    )
    preview_bmp_bytes = _embedded_bmp_preview_bytes(width, height, pixel_format)
    return {
        "flash": {
            "flashSize": flash_profile["flashSize"],
            "flashBytes": flash_profile["flashBytes"],
            "partitionTable": flash_profile["partitionTable"],
            "otaSupported": flash_profile["otaSupported"],
            "flashOffset": EMBEDDED_FLASH_OFFSET,
            "partitions": partitions,
        },
        "ram": {
            "psramBytes": psram_bytes,
            "panel": panel,
            "width": width,
            "height": height,
            "pixelFormat": pixel_format,
            "pixelFormatName": _pixel_format_name(pixel_format),
            "renderMode": "local" if render_mode == EMBEDDED_RENDER_LOCAL else "remote",
            # Historical key name: the canvas is RGBX or 16-bit RGB, never RGBA.
            "rgbaBufferBytes": canvas_bytes,
            "canvasBufferBytes": canvas_bytes,
            "canvasBytesPerPixel": canvas_bytes_per_pixel,
            "packedBufferBytes": packed_bytes,
            "renderReserveBytes": EMBEDDED_RENDER_PSRAM_RESERVE_BYTES,
            "renderWorkingBytes": render_working_bytes,
            "quickJsHeapLimitBytes": EMBEDDED_QUICKJS_HEAP_LIMIT_BYTES,
            "previewSnapshotBytes": packed_bytes,
            "previewSnapshotReserveBytes": EMBEDDED_PREVIEW_SNAPSHOT_RESERVE_BYTES,
            "previewBmpBytes": preview_bmp_bytes,
            "displayStateBytes": EMBEDDED_DISPLAY_STATE_BYTES,
            "httpResponseLimitBytes": embedded_max_http_response_bytes_for_frame(frame),
        },
    }


def check_embedded_panel_fits_memory(frame: Frame) -> None:
    """Refuse a panel that can't be rendered on-device within the module PSRAM.

    The firmware applies the same check at boot and falls back to thin-client
    mode; saying so in the provisioning plan gives the user a clear,
    actionable warning instead of a frame that silently never renders locally.
    """
    panel = embedded_panel_for_frame(frame)
    if panel == "none" or embedded_render_mode_for_frame(frame) == EMBEDDED_RENDER_REMOTE:
        return
    from app.drivers.devices import device_dimensions

    dims = device_dimensions(frame.device)
    if not dims:
        return
    width, height = dims
    have = embedded_module_psram_bytes(frame)
    need = embedded_render_psram_bytes(width, height, embedded_pixel_format_for_panel(panel), have)
    if need > have:
        raise ValueError(
            f"Panel {panel} ({width}x{height}) needs ~{need / (1024 * 1024):.1f} MB PSRAM to "
            f"render on-device but the target module has ~{have // (1024 * 1024)} MB. Pick a "
            f"smaller panel, a module with more PSRAM (set device_config.psramMB), or run the "
            f"frame in thin-client mode."
        )


def embedded_wifi_credentials(frame: Frame) -> tuple[str, str]:
    """Wi-Fi from the frame's network settings (same shape as the Pi flows)."""
    network = frame.network if isinstance(frame.network, dict) else {}
    ssid = str(network.get("wifiSSID") or "").strip()
    password = str(network.get("wifiPassword") or "")
    if "\n" in ssid or "\r" in ssid:
        raise ValueError("WiFi network cannot contain line breaks")
    if "\n" in password or "\r" in password:
        raise ValueError("WiFi password cannot contain line breaks")
    return ssid, password


def embedded_hostname_for_frame(frame: Frame) -> str:
    """Hostname baked into ESP32 firmware from frame_host.

    The UI stores user-facing hosts like "kitchen.local". ESP-IDF wants a DHCP
    hostname, not an mDNS name or IP literal, so strip common wrappers and keep
    it to a conservative 31-byte label.
    """
    raw = str(frame.frame_host or "").strip()
    if "://" in raw:
        raw = raw.split("://", 1)[1]
    raw = raw.split("/", 1)[0].split("?", 1)[0]
    if "@" in raw:
        raw = raw.rsplit("@", 1)[1]
    raw = raw.strip().lower()
    if raw.endswith(".local"):
        raw = raw[:-6]
    if raw.startswith("[") and "]" in raw:
        raw = ""
    elif raw.count(":") == 1:
        raw = raw.rsplit(":", 1)[0]
    if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", raw):
        raw = ""

    hostname = re.sub(r"[^a-z0-9-]+", "-", raw)
    hostname = re.sub(r"-+", "-", hostname).strip("-")
    if not hostname:
        hostname = f"frame{int(frame.id)}" if getattr(frame, "id", None) else "frameos"
    return hostname[:31].rstrip("-") or "frameos"


def embedded_gpio_buttons_for_frame(frame: Frame) -> list[tuple[int, str]]:
    buttons: list[tuple[int, str]] = []
    raw_buttons = frame.gpio_buttons
    preset_key = embedded_hardware_preset_for_frame(frame)
    if raw_buttons is None and preset_key:
        raw_buttons = EMBEDDED_HARDWARE_PRESETS[preset_key].get("gpioButtons")
    for raw_button in raw_buttons or []:
        if not isinstance(raw_button, dict):
            continue
        try:
            pin = int(raw_button.get("pin"))
        except (TypeError, ValueError):
            continue
        if pin < 0 or pin > 48:
            continue
        label = str(raw_button.get("label") or f"Pin {pin}")
        label = re.sub(r"[\s:]+", " ", label).strip()
        buttons.append((pin, label[:31] or f"Pin {pin}"))
    return buttons[:8]


def embedded_gpio_buttons_config(frame: Frame) -> str:
    return "\n".join(f"{pin}:{label}" for pin, label in embedded_gpio_buttons_for_frame(frame))


def embedded_backend_url_for_frame(frame: Frame) -> str:
    """Where the device reaches this backend: what console provisioning sends
    as `set backend`. Empty when the frame has no server host yet."""
    server_host = str(frame.server_host or "")
    if not server_host:
        return ""
    server_port = int(frame.server_port or 8989)
    scheme = "https" if server_port == 443 else "http"
    if server_port in (80, 443):
        return f"{scheme}://{server_host}"
    return f"{scheme}://{server_host}:{server_port}"


def _embedded_device_config_value(frame: Frame, *keys: str) -> object:
    """First present of ``keys`` in the frame's device_config (camel or snake)."""
    device_config = embedded_device_config(frame)
    for key in keys:
        if key in device_config:
            return device_config[key]
    return None


def _provisioning_setting(key: str, value: object, secret: bool = False) -> dict[str, Any]:
    return {"key": key, "value": str(value), "secret": secret}


def embedded_provisioning_plan(frame: Frame, published_assets: Optional[set[str]] = None) -> dict[str, Any]:
    """What the published firmware has to be told to become this frame.

    All panel drivers are compiled into every release image
    (embedded/esp32/main/fos_defaults.h) and every per-frame value has a
    `set` key on the device's USB console (cmd_set in fos_console.c), so the
    stock release image plus this command list is the frame — the shape the
    cloud's enrollment flasher has always used
    (cloud-frontend/src/components/Esp32CloudFlasher.tsx). The two things a
    console line cannot carry, the frame's own HTTPS certificate and key,
    reach the device through its first settings pull instead
    (app/api/embedded_device.py, ``embedded_frame_settings``).

    ``settings`` are `usb_api set <key> <value>` pairs IN ORDER: `hardware`
    first because a preset applies a whole board bundle (panel, EPD wiring,
    buttons, TF socket, battery sensing) that this frame's own values must be
    able to override.

    ``blockers`` are reasons the frame cannot be provisioned at all (no
    backend to talk to, no published image for the chip). ``warnings`` are
    differences the user should know about but that still leave a working
    frame.

    ``published_assets`` — which provisioning images the current release
    carries — picks the image built for this frame's flash layout over the
    generic one (embedded_release_firmware_for_frame).
    """
    platform = embedded_platform_for_frame(frame)
    release = embedded_release_firmware_for_frame(frame, published_assets)
    blockers: list[str] = []
    warnings: list[str] = []
    settings: list[dict[str, Any]] = []

    if release is None:
        label = embedded_platform_spec_for_frame(frame)["label"]
        blockers.append(f"FrameOS publishes no generic {label} firmware image, so there is nothing to provision.")

    preset = embedded_hardware_preset_for_frame(frame)
    if preset:
        settings.append(_provisioning_setting("hardware", preset))

    panel = embedded_panel_for_frame(frame)
    if panel == "none":
        warnings.append(
            "This frame has no e-paper panel selected, so the board will come up without a display driver."
        )
    else:
        settings.append(_provisioning_setting("panel", panel))
        try:
            check_embedded_panel_fits_memory(frame)
        except ValueError as exc:
            warnings.append(f"{exc} Until then the board renders as a thin client.")

    pins = embedded_pins_for_frame(frame)
    settings.append(_provisioning_setting("pins", ",".join(f"{key}={pins[key]}" for key in EMBEDDED_PIN_KEYS)))

    # The console takes the newline-separated button spec with commas instead.
    buttons = embedded_gpio_buttons_config(frame).replace("\n", ",")
    if buttons:
        settings.append(_provisioning_setting("gpio_buttons", buttons))
    elif preset and EMBEDDED_HARDWARE_PRESETS[preset].get("gpioButtons"):
        # `set gpio_buttons ""` is not a thing — the console's argument parser
        # rejects an empty value — so the preset's buttons stay wired.
        warnings.append(
            f"This frame defines no buttons, but the {preset} preset does; the device keeps the preset's buttons."
        )

    backend_url = embedded_backend_url_for_frame(frame)
    if backend_url:
        settings.append(_provisioning_setting("backend", backend_url))
    else:
        blockers.append("This frame has no server host set, so the device would have no backend to talk to.")

    api_key = str(frame.server_api_key or "")
    if api_key:
        settings.append(_provisioning_setting("api_key", api_key, secret=True))
    else:
        blockers.append("This frame has no API key, so the device could not authenticate against this backend.")

    settings.append(_provisioning_setting("frame_id", int(frame.id)))
    if frame.frame_host:
        settings.append(_provisioning_setting("hostname", embedded_hostname_for_frame(frame)))
    settings.append(_provisioning_setting(
        "render_mode",
        "remote" if embedded_render_mode_for_frame(frame) == EMBEDDED_RENDER_REMOTE else "local",
    ))
    settings.append(_provisioning_setting("interval", max(5, int(frame.interval or 300))))
    settings.append(_provisioning_setting("rotate", int(frame.rotate or 0) % 360))
    settings.append(_provisioning_setting("scaling_mode", embedded_scaling_mode_for_frame(frame)))
    settings.append(_provisioning_setting("server_send_logs", 1 if frame.server_send_logs is not False else 0))
    max_http = embedded_max_http_response_bytes_for_frame(frame)
    if max_http != EMBEDDED_DEFAULT_MAX_HTTP_RESPONSE_BYTES:
        settings.append(_provisioning_setting("max_http_response_bytes", max_http))

    # The device's own web UI login. Every embedded frame gets a generated
    # one (ensure_embedded_frame_defaults); the credentials go first and the
    # switch last, because the console refuses to enable it without both.
    admin_auth = normalize_frame_admin_auth(frame.frame_admin_auth)
    if admin_auth["user"] and admin_auth["pass"]:
        settings.append(_provisioning_setting("admin_user", admin_auth["user"]))
        settings.append(_provisioning_setting("admin_pass", admin_auth["pass"], secret=True))
    settings.append(_provisioning_setting(
        "admin_auth", 1 if admin_auth["enabled"] and admin_auth["user"] and admin_auth["pass"] else 0
    ))

    sd_card_assets = embedded_sd_card_assets_for_frame(frame)
    if sd_card_assets["enabled"]:
        sd_pins = sd_card_assets["pins"]
        settings.append(_provisioning_setting(
            "assets_sd_pins",
            ",".join(f"{key}={sd_pins[key]}" for key in EMBEDDED_SD_CARD_ASSETS_PIN_KEYS),
        ))
        settings.append(_provisioning_setting("assets_sd_freq", sd_card_assets["maxFrequencyKHz"]))
    # Sent either way: a hardware preset enables the socket it knows about, and
    # a frame that turned SD assets off must be able to turn it back off.
    settings.append(_provisioning_setting("assets_sd", 1 if sd_card_assets["enabled"] else 0))

    deep_sleep = _embedded_device_config_value(frame, "deepSleep", "deep_sleep")
    if isinstance(deep_sleep, bool):
        settings.append(_provisioning_setting("deep_sleep", 1 if deep_sleep else 0))
    deep_sleep_on_battery = _embedded_device_config_value(frame, "deepSleepOnBattery", "deep_sleep_on_battery")
    if isinstance(deep_sleep_on_battery, bool):
        settings.append(_provisioning_setting("deep_sleep_on_battery", 1 if deep_sleep_on_battery else 0))
    wake_schedule = _embedded_device_config_value(frame, "wakeSchedule", "wake_schedule")
    if isinstance(wake_schedule, bool):
        settings.append(_provisioning_setting("wake_schedule", 1 if wake_schedule else 0))
    wake_check_seconds = _embedded_device_config_value(frame, "wakeCheckSeconds", "wake_check_seconds")
    if isinstance(wake_check_seconds, int) and not isinstance(wake_check_seconds, bool):
        settings.append(_provisioning_setting("wake_check", max(0, wake_check_seconds)))
    battery_pin = _embedded_device_config_value(frame, "batteryPin", "battery_pin")
    if isinstance(battery_pin, int) and not isinstance(battery_pin, bool):
        settings.append(_provisioning_setting("battery_pin", battery_pin))
    battery_divider = _embedded_device_config_value(frame, "batteryDivider", "battery_divider")
    if isinstance(battery_divider, (int, float)) and not isinstance(battery_divider, bool):
        settings.append(_provisioning_setting("battery_divider", float(battery_divider)))
    battery_enable_pin = _embedded_device_config_value(frame, "batteryEnablePin", "battery_enable_pin")
    if isinstance(battery_enable_pin, int) and not isinstance(battery_enable_pin, bool):
        settings.append(_provisioning_setting("battery_enable_pin", battery_enable_pin))

    # The frame's own certificate is not a console value: it rides the first
    # settings pull once the board is on Wi-Fi and talking to this backend.
    https_proxy = normalize_https_proxy(frame.https_proxy)
    if https_proxy.get("enable"):
        warnings.append(
            "HTTPS on the frame turns on after its first settings sync with this backend, "
            "which delivers the certificate and key; the board answers over plain HTTP until then."
        )

    if release is not None:
        frame_flash_size = embedded_flash_size_for_frame(frame)
        if frame_flash_size != release["flashSize"]:
            warnings.append(
                f"The published image uses the {release['flashSize']} partition layout; this frame is configured "
                f"for {frame_flash_size} flash, so the rest of the chip stays unused."
            )
        if embedded_ota_supported_for_frame(frame) and not release["otaSupported"]:
            warnings.append(
                "The published image has no OTA slot, so future firmware updates need the USB cable again."
            )

    wifi_ssid, wifi_password = embedded_wifi_credentials(frame)
    if not wifi_ssid:
        warnings.append(
            "This frame has no Wi-Fi network configured, so the board starts its setup portal instead of connecting."
        )

    return {
        "supported": not blockers,
        "platform": platform,
        "releasePlatform": release["asset"] if release else None,
        "releaseFlashSize": release["flashSize"] if release else None,
        "blockers": blockers,
        "warnings": warnings,
        "settings": settings,
        "wifi": {"ssid": wifi_ssid, "password": wifi_password} if wifi_ssid else None,
    }


def ensure_embedded_frame_defaults(frame: Frame, platform: str | None = None) -> None:
    normalized_platform = normalize_embedded_platform(
        platform or (frame.embedded or {}).get("platform") or SUPPORTED_EMBEDDED_PLATFORM
    )

    frame.mode = "embedded"
    if apply_embedded_hardware_preset(frame):
        # The preset knows the board's chip; it overrides a caller-supplied platform.
        normalized_platform = embedded_platform_for_frame(frame)
    if EMBEDDED_PLATFORMS[normalized_platform]["family"] == "virtual":
        # Nothing must ever try to reach a virtual frame over the network.
        frame.frame_host = ""
    elif not frame.frame_host:
        frame.frame_host = f"frame{frame.id}.local" if frame.id else "frame.local"
    if not frame.frame_port or frame.frame_port == 8787:
        frame.frame_port = 80

    # No SSH or agent on a microcontroller. HTTPS uses the same frame
    # certificate model as Pi frames, but is served natively by ESP-IDF instead
    # of through Caddy.
    frame.https_proxy = normalize_https_proxy(frame.https_proxy)
    agent = dict(frame.agent or {})
    agent["agentEnabled"] = False
    agent["agentRunCommands"] = False
    agent["deployWithAgent"] = False
    frame.agent = agent
    frame.log_to_file = None

    raw_admin_auth = frame.frame_admin_auth if isinstance(frame.frame_admin_auth, dict) else {}
    admin_auth = normalize_frame_admin_auth(raw_admin_auth)
    should_generate_admin_auth = not raw_admin_auth or (
        admin_auth["enabled"] and (not admin_auth["user"] or not admin_auth["pass"])
    )
    if should_generate_admin_auth:
        frame.frame_admin_auth = {
            "enabled": True,
            "user": admin_auth["user"] or "admin",
            "pass": admin_auth["pass"] or secure_token(24),
        }

    embedded = dict(frame.embedded or {})
    embedded["platform"] = normalized_platform
    embedded["flashSize"] = embedded_flash_size_for_frame(frame)
    frame.embedded = embedded

    # The device authenticates its render/OTA pulls with the server API key
    if not frame.server_api_key:
        frame.server_api_key = secure_token(32)
    if not frame.device or frame.device == "web_only":
        if EMBEDDED_PLATFORMS[normalized_platform]["family"] == "virtual":
            frame.device = "virtual"
        else:
            frame.device = f"waveshare.{EMBEDDED_DEFAULT_PANEL}"

    frame.max_http_response_bytes = embedded_max_http_response_bytes_for_frame(frame)

    device_config = dict(embedded_device_config(frame))
    if EMBEDDED_PLATFORMS[normalized_platform]["family"] == "virtual" and not device_config.get("viewToken"):
        # View-only credential for the image/page URLs — deliberately not the
        # server_api_key, so a shared kiosk URL grants nothing but the picture
        # and can be rotated without touching the device identity.
        device_config["viewToken"] = secure_token(32)
    device_config["pins"] = embedded_pins_for_frame(frame)
    if "sdCardAssets" in device_config or "sd_card_assets" in device_config:
        device_config.pop("sd_card_assets", None)
        device_config["sdCardAssets"] = embedded_sd_card_assets_for_frame(frame)
    frame.device_config = device_config


async def request_embedded_firmware_update(db: Session, redis: Redis, frame: Frame) -> Any:
    """Ask a backend-managed board to check this backend's OTA manifest now.

    The device answers, reboots into its early updater, fetches
    ``/embedded/ota/manifest`` (app/api/embedded_device.py — the release
    manifest, relayed), and installs the release app image for its flash
    layout if the version differs, verifying the release signature first.
    Progress arrives as ``ota:backend`` log lines. The backend holds no image
    and no key: the release is the only thing it can offer.
    """
    frame = get_fresh_frame(db, int(frame.id)) or frame
    if not embedded_ota_supported_for_frame(frame):
        raise ValueError("OTA updates are not available for the selected ESP32 flash size")
    await log(db, redis, int(frame.id), "stdout", "Asking the frame to check for a firmware update")
    try:
        status, body, headers = await _fetch_frame_http_bytes(
            frame,
            redis,
            path="/api/action/ota",
            method="POST",
        )
    except Exception as exc:
        error = str(exc)
        await log(db, redis, int(frame.id), "stderr", f"Failed to request the firmware update: {error}")
        raise ValueError(error)
    if status != 200:
        detail = body.decode("utf-8", errors="replace").strip()
        if len(detail) > 240:
            detail = f"{detail[:240]}..."
        error = f"HTTP {status}: {detail or 'no response body'}"
        await log(db, redis, int(frame.id), "stderr", f"Failed to request the firmware update: {error}")
        raise ValueError(error)
    await log(db, redis, int(frame.id), "stdout", "Firmware update check requested; the frame reboots into its updater")
    if headers.get("content-type", "").startswith("application/json"):
        try:
            return json.loads(body.decode("utf-8", errors="replace"))
        except ValueError:
            pass
    return body.decode("utf-8", errors="replace")
