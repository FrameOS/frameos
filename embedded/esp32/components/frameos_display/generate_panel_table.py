#!/usr/bin/env python3
"""Generate the runtime Waveshare panel table for the ESP32 display component.

Every supported panel driver is compiled into one firmware image; the active
panel is chosen at runtime from NVS ("panel" key: `set panel <key>` on the
serial console, or the setup portal dropdown). This script emits:

  frameos_panel_table.h  - fos_panel_entry_t and the table declaration
  frameos_panel_table.c  - per-panel init/clear/display/sleep wrappers + table
  panel_sources.cmake    - FRAMEOS_PANEL_SOURCES / FRAMEOS_PANEL_HEADERS lists

Panel metadata (dimensions, color format, driver function names/arguments)
comes from backend/app/drivers/waveshare.py, the same source of truth the
Linux builds use.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


PIXEL_FORMAT_BY_COLOR = {
    "Black": 1,
    "BlackWhiteRed": 2,
    "BlackWhiteYellow": 3,
    "FourGray": 4,
    "BlackWhiteYellowRed": 5,
    "SevenColor": 6,
    "SpectraSixColor": 7,
    "SixteenGray": 8,
}

# Mirrored by EMBEDDED_UNSUPPORTED_PANELS in backend/app/tasks/embedded_firmware.py.
UNSUPPORTED_PANELS = {
    # A different controller stack: the 12.48" multi-controller family. (The
    # IT8951's EPD_10in3 is in EXTRA_PANELS, driven by it8951.c.)
    "EPD_12in48",
    "EPD_12in48b",
    "EPD_12in48b_V2",
    # Legacy vendor-resync variants whose public symbols collide with their
    # successors (EPD_7in5_V2, EPD_4in2b_V2, EPD_7in5b_V2). One binary links
    # every driver, so only the current variant of each family is included.
    "EPD_7in5_V2_gray",
    "EPD_4in2b_V2_old",
    "EPD_7in5b_V2_old",
}

# Panels with a partial waveform: (init, display(new, previous), rest, changed,
# clean, owed), the driver's own functions (docs/realtime-rendering.md, "Partial
# refresh on e-paper"). Rest turns the analog supply off and keeps the
# controller awake. `changed` and `clean` are for a controller that keeps the
# picture itself (the IT8951): the display layer then keeps no copy of it.
PARTIAL_PANELS = {
    "EPD_3in97": ("EPD_3in97_Init_Partial", "EPD_3in97_Display_Partial", "EPD_3in97_Rest", "NULL", "NULL", "NULL"),
    # The Elecrow CrowPanel 5.79"'s two SSD1683s in black and white
    # (EPD_5in79_BW, below).
    "EPD_5in79_BW": (
        "EPD_5in79_Init_Partial_BW",
        "EPD_5in79_Display_Partial_BW",
        "EPD_5in79_Rest",
        "NULL",
        "NULL",
        "NULL",
    ),
    "EPD_10in3": (
        "fos_it8951_10in3_partial_init",
        "fos_it8951_10in3_partial_show",
        "fos_it8951_10in3_rest",
        "fos_it8951_10in3_changed",
        "fos_it8951_10in3_clean",
        "fos_it8951_10in3_owed",
    ),
}

# Panels without a Waveshare C driver in the panel catalog's ePaper folder:
# hand-written drivers in this component with the same init/clear/display/
# sleep shape. `bus` 1 = I2C — the display layer skips the shared SPI module
# init for those (their pins are the EPD sck/mosi lines reused as SCL/SDA).
# `bus` 2 = the shared SPI module with a read line: the IT8951 answers on
# MISO and has no D/C, so the `dc` pin slot carries MISO. `bus` 3 = a
# parallel RGB LCD on the chip's LCD peripheral, whose wiring is the
# driver's own board table (no EPD pins at all). `bus` 4 = a glass whose
# controller keeps the picture, on QSPI or one SPI lane with a D/C line
# (lcd_qspi_amoled.c), its wiring the driver's board table too; an LCD to the
# rest of the firmware. Mirrored by
# EMBEDDED_EXTRA_PANELS in backend/app/tasks/embedded_firmware.py.
EXTRA_PANELS = [
    {
        # The Elecrow CrowPanel 5.79"'s glass (GDEY0579T93, two SSD1683s) in
        # black and white on its own waveforms, as Elecrow drives it: the
        # Waveshare 5.79"'s four-grey table made its white a dark grey and
        # its two light greys black (the bench, 2026-11-26). The Waveshare
        # driver's file (EPD_5in79.c), on the shared EPD pins; partial updates
        # in PARTIAL_PANELS.
        "name": "EPD_5in79_BW",
        "width": 792,
        "height": 272,
        "format": 1,  # FOS_PIXEL_1BPP
        "bus": 0,
        "header": "EPD_5in79.h",
        "init": "EPD_5in79_Init_BW",
        "clear": "EPD_5in79_Clear",
        "display": "EPD_5in79_Display_BW",
        "sleep": "EPD_5in79_Sleep",
    },
    {
        "name": "OLED_SSD1306_72x40",
        "width": 72,
        "height": 40,
        "format": 1,  # FOS_PIXEL_1BPP
        "bus": 1,
        "header": "oled_ssd1306.h",
        "init": "fos_oled_ssd1306_72x40_init",
        "clear": "fos_oled_ssd1306_72x40_clear",
        "display": "fos_oled_ssd1306_72x40_display",
        "sleep": "fos_oled_ssd1306_72x40_sleep",
    },
    {
        # The Waveshare 10.3" HAT's key, and the Seeed reTerminal E1003's
        # panel: an ED103TC2 behind an ITE IT8951 (the board's variant comes
        # from its hardware preset, frameos_display.c).
        "name": "EPD_10in3",
        "width": 1872,
        "height": 1404,
        "format": 8,  # FOS_PIXEL_4BPP_GRAY
        "bus": 2,
        "header": "it8951.h",
        "init": "fos_it8951_10in3_init",
        "clear": "fos_it8951_10in3_clear",
        "display": "fos_it8951_10in3_display",
        "sleep": "fos_it8951_10in3_sleep",
    },
    {
        # The Seeed SenseCAP Indicator's 4" IPS glass: 16-bit colour, scanned
        # out of PSRAM by the ESP32-S3's LCD peripheral (lcd_st7701s_rgb.c).
        "name": "LCD_ST7701S_480x480",
        "width": 480,
        "height": 480,
        "format": 9,  # FOS_PIXEL_RGB565
        "bus": 3,
        "header": "lcd_st7701s_rgb.h",
        "init": "fos_lcd_st7701s_init",
        "clear": "fos_lcd_st7701s_clear",
        "display": "fos_lcd_st7701s_display",
        "sleep": "fos_lcd_st7701s_sleep",
    },
    {
        # The Sunton ESP32-8048S070's 7" IPS glass (EK9716): the same driver
        # and the same RGB565 shape, at 800x480; the board's wiring (no
        # expander, no controller SPI) comes from the hardware preset.
        "name": "LCD_EK9716_800x480",
        "width": 800,
        "height": 480,
        "format": 9,  # FOS_PIXEL_RGB565
        "bus": 3,
        "header": "lcd_st7701s_rgb.h",
        "init": "fos_lcd_st7701s_init",
        "clear": "fos_lcd_st7701s_clear",
        "display": "fos_lcd_st7701s_display",
        "sleep": "fos_lcd_st7701s_sleep",
    },
    {
        # The Elecrow CrowPanel Advance 7.0"'s 800x480 IPS glass (SC7277):
        # the same driver, its own board row (lcd_st7701s_rgb.c).
        "name": "LCD_SC7277_800x480",
        "width": 800,
        "height": 480,
        "format": 9,  # FOS_PIXEL_RGB565
        "bus": 3,
        "header": "lcd_st7701s_rgb.h",
        "init": "fos_lcd_st7701s_init",
        "clear": "fos_lcd_st7701s_clear",
        "display": "fos_lcd_st7701s_display",
        "sleep": "fos_lcd_st7701s_sleep",
    },
    {
        # The Waveshare ESP32-S3-Touch-AMOLED-1.75's round 1.75" AMOLED: a
        # CO5300 on QSPI holding its own picture (lcd_qspi_amoled.c); only
        # the circle inside the square shows.
        "name": "AMOLED_CO5300_466x466",
        "width": 466,
        "height": 466,
        "format": 9,  # FOS_PIXEL_RGB565
        "bus": 4,
        "header": "lcd_qspi_amoled.h",
        "init": "fos_lcd_qspi_init",
        "clear": "fos_lcd_qspi_clear",
        "display": "fos_lcd_qspi_display",
        "sleep": "fos_lcd_qspi_sleep",
    },
    {
        # The Elecrow CrowPanel 2.01" watch's IPS glass: a GC9309 on one SPI
        # lane holding its own picture, the same driver as the AMOLED's.
        "name": "LCD_GC9309_240x296",
        "width": 240,
        "height": 296,
        "format": 9,  # FOS_PIXEL_RGB565
        "bus": 4,
        "header": "lcd_qspi_amoled.h",
        "init": "fos_lcd_qspi_init",
        "clear": "fos_lcd_qspi_clear",
        "display": "fos_lcd_qspi_display",
        "sleep": "fos_lcd_qspi_sleep",
    },
    {
        # The Elecrow CrowPanel 1.46" rotary's round IPS glass: an ST77961 on
        # one SPI lane holding its own picture, the watch's driver.
        "name": "LCD_ST77961_360x360",
        "width": 360,
        "height": 360,
        "format": 9,  # FOS_PIXEL_RGB565
        "bus": 4,
        "header": "lcd_qspi_amoled.h",
        "init": "fos_lcd_qspi_init",
        "clear": "fos_lcd_qspi_clear",
        "display": "fos_lcd_qspi_display",
        "sleep": "fos_lcd_qspi_sleep",
    },
    {
        # The Elecrow CrowPanel Advance 2.8"'s IPS glass: an ST7789 on one
        # SPI lane holding its own picture, the watch's driver.
        "name": "LCD_ST7789_320x240",
        "width": 320,
        "height": 240,
        "format": 9,  # FOS_PIXEL_RGB565
        "bus": 4,
        "header": "lcd_qspi_amoled.h",
        "init": "fos_lcd_qspi_init",
        "clear": "fos_lcd_qspi_clear",
        "display": "fos_lcd_qspi_display",
        "sleep": "fos_lcd_qspi_sleep",
    },
]

FOS_PANEL_BUS_SPI = 0
FOS_PANEL_BUS_I2C = 1
FOS_PANEL_BUS_SPI_READ = 2
FOS_PANEL_BUS_RGB = 3
FOS_PANEL_BUS_QSPI = 4


def c_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def cmake_string(value: str) -> str:
    return '"' + value.replace("\\", "/").replace('"', '\\"') + '"'


def c_args(nim_args: str) -> str:
    if not nim_args:
        return ""
    args = []
    for arg in nim_args.split(","):
        value = arg.strip()
        value = re.sub(r"\.(u?int(8|16|32)|cint)$", "", value)
        value = value.replace("nil", "NULL")
        if value == "self":
            raise ValueError("IT8951/self-style init arguments are not supported on ESP32")
        args.append(value)
    return ", ".join(args)


def compile_source_from_nim(nim_path: Path) -> str | None:
    text = nim_path.read_text()
    match = re.search(r'\{\.compile:\s*"([^"]+)"\.\}', text)
    return match.group(1) if match else None


def panel_source(repo_root: Path, key: str, get_variant_folder) -> Path:
    waveshare_root = repo_root / "frameos" / "src" / "drivers" / "waveshare"
    folder = get_variant_folder(key)
    source_dir = waveshare_root / folder
    nim_path = source_dir / f"{key}.nim"
    # The Nim wrapper's {.compile.} pragma names the C unit (b/bc/c keys share one).
    compile_source = compile_source_from_nim(nim_path)
    if compile_source:
        candidates = [source_dir / compile_source]
    else:
        candidates = [source_dir / f"{key}.c"]
    for path in candidates:
        if path.is_file():
            return path
    raise FileNotFoundError(f"Root Waveshare source missing for {key}: {', '.join(str(p) for p in candidates)}")


def panel_wrappers(variant) -> dict[str, tuple[str, str]]:
    """Each role's wrapper: (signature with {name}, body)."""
    init_args = c_args(variant.init_args)
    clear_args = c_args(variant.clear_args)
    init_call = f"{variant.init_function}({init_args})"
    clear_call = f"{variant.clear_function}({clear_args})"
    if variant.init_returns_zero:
        init_body = f"    return (int){init_call};"
    else:
        init_body = f"    {init_call};\n    return 0;"
    display_args = variant.display_arguments or []
    if display_args in (["Black", "Red"], ["Black", "Yellow"]):
        display_body = (
            f"    size_t plane = (((size_t){variant.width} + 7u) / 8u) * (size_t){variant.height};\n"
            f"    {variant.display_function}((UBYTE *)buf, (UBYTE *)buf + plane);"
        )
    else:
        display_body = f"    {variant.display_function}((UBYTE *)buf);"
    if variant.sleep_function:
        sleep_body = f"    {variant.sleep_function}();"
    else:
        sleep_body = "    /* driver has no sleep function */"
    return {
        "init": ("FOS_PANEL_WRAPPER int {name}(void)", init_body),
        "clear": ("FOS_PANEL_WRAPPER void {name}(void)", f"    {clear_call};"),
        "show": ("FOS_PANEL_WRAPPER void {name}(uint8_t *buf)", display_body),
        "sleep": ("FOS_PANEL_WRAPPER void {name}(void)", sleep_body),
    }


def panel_slots(variant, wrapper: dict[str, str]) -> tuple[str, str, str, str]:
    """The table's function slots for a panel: the driver's own function where
    its wrapper only forwards (FOS_PANEL_SLOT keeps the wrapper unless the
    function's type is the slot's), the wrapper where it does more. The first
    is `init_kind, driver_init`: how fos_panel_init calls it. `wrapper` names
    each role's wrapper (one for each body: the b, bc and c keys of a driver
    share theirs)."""
    def slot(direct: bool, function: str | None, slot_type: str, wrapper: str) -> str:
        if direct and function:
            return f"FOS_PANEL_SLOT({function}, {slot_type}, {wrapper})"
        return wrapper

    init_wrapper = wrapper["init"]
    if variant.init_args:
        init = f"FOS_PANEL_INIT_INT, (void (*)(void)){init_wrapper}"
    elif variant.init_returns_zero:
        # The wrapper returns what Init returns.
        init = f"FOS_PANEL_INIT_STATUS({variant.init_function}, {init_wrapper})"
    else:
        # The wrapper returns 0 whatever Init does.
        init = f"FOS_PANEL_INIT_QUIET({variant.init_function}, {init_wrapper})"
    display_args = variant.display_arguments or []
    two_planes = display_args in (["Black", "Red"], ["Black", "Yellow"])
    return (
        init,
        slot(not variant.clear_args, variant.clear_function, "void (*)(void)", wrapper["clear"]),
        slot(not two_planes, variant.display_function, "void (*)(uint8_t *)", wrapper["show"]),
        slot(True, variant.sleep_function, "void (*)(void)", wrapper["sleep"]),
    )


HEADER_TEXT = """/* Generated by generate_panel_table.py - do not edit. */
#pragma once

#include <stddef.h>
#include <stdint.h>

#define FOS_PANEL_BUS_SPI 0      /* the shared EPD SPI module, write-only */
#define FOS_PANEL_BUS_I2C 1      /* I2C on sck/mosi (the driver owns the bus) */
#define FOS_PANEL_BUS_SPI_READ 2 /* the EPD SPI module with MISO on the dc pin (IT8951) */
#define FOS_PANEL_BUS_RGB 3      /* a parallel RGB LCD on the LCD peripheral (the driver owns its pins) */
#define FOS_PANEL_BUS_QSPI 4     /* a controller that keeps its picture, on QSPI or one SPI lane (the driver owns its pins) */

/* How driver_init is called (fos_panel_init): it is the driver's own Init
 * where a wrapper would only have forwarded. */
#define FOS_PANEL_INIT_INT 0   /* int (*)(void), 0 when the panel answered */
#define FOS_PANEL_INIT_UBYTE 1 /* a Waveshare UBYTE Init(void): the same, in a byte */
#define FOS_PANEL_INIT_VOID 2  /* an Init(void) that reports nothing: 0 */

/* 28 bytes an entry: the numbers in the widths they need (40 as ints). */
typedef struct {
    const char *name;     /* Waveshare variant key, e.g. "EPD_7in5_V2" */
    uint16_t width;
    uint16_t height;
    uint8_t format;       /* fos_pixel_format_t */
    uint8_t requires_cs2; /* dual chip-select panels (EPD_13in3e) */
    uint8_t bus;          /* FOS_PANEL_BUS_* */
    uint8_t init_kind;    /* FOS_PANEL_INIT_*: driver_init's real type */
    void (*driver_init)(void);
    void (*clear)(void);
    void (*display)(uint8_t *buf);
    void (*sleep)(void);
} fos_panel_entry_t;

extern const fos_panel_entry_t fos_panel_table[];
extern const size_t fos_panel_table_count;

/* The panel's init, called as its own type: 0 when the panel answered. */
static inline int fos_panel_init(const fos_panel_entry_t *panel)
{
    switch (panel->init_kind) {
    case FOS_PANEL_INIT_UBYTE:
        return ((uint8_t (*)(void))panel->driver_init)();
    case FOS_PANEL_INIT_VOID:
        panel->driver_init();
        return 0;
    default:
        return ((int (*)(void))panel->driver_init)();
    }
}

/* A panel with a partial waveform. Its own table: three pointers on every
 * entry above were 1 KB of flash for one panel. */
typedef struct {
    const char *name;
    void (*init)(void);
    void (*show)(uint8_t *buf, uint8_t *previous); /* `previous`: what the glass shows */
    void (*rest)(void);                            /* the analog supply off, the controller awake */
    /* A controller that keeps the picture itself: no copy in memory here. */
    long (*changed)(const uint8_t *buf);           /* bytes that differ, < 0 when it cannot say */
    void (*clean)(void);                           /* a full waveform over what it holds */
    bool (*owed)(void);                            /* parts of the picture only drawn roughly so far */
} fos_panel_partial_t;

#define FOS_PANEL_PARTIAL_COUNT @PARTIAL_COUNT@
extern const fos_panel_partial_t fos_panel_partial_table[FOS_PANEL_PARTIAL_COUNT];
"""


def generate(repo_root: Path, out_dir: Path) -> None:
    sys.path.insert(0, str(repo_root / "backend"))
    from app.drivers.waveshare import (
        convert_waveshare_source,
        get_variant_folder,
        get_variant_keys,
        key_to_float,
    )

    keys = [
        key
        for key in get_variant_keys()
        if key not in UNSUPPORTED_PANELS
        and get_variant_folder(key) == "ePaper"
    ]
    # Sorted by physical size then name, so the portal <select> reads naturally.
    keys.sort(key=lambda key: (key_to_float(key)[0] or 0.0, key))

    variants = {}
    # Shared driver diagnostics (DEV_Debug.c) are built with the panels, on
    # top of this component's DEV_Config_esp.c.
    sources: dict[Path, None] = {
        repo_root / "frameos" / "src" / "drivers" / "waveshare" / "ePaper" / "DEV_Debug.c": None
    }
    headers: dict[Path, None] = {}
    for key in keys:
        variant = convert_waveshare_source(key)
        if variant.color_option not in PIXEL_FORMAT_BY_COLOR:
            raise ValueError(f"{key} has unsupported color option {variant.color_option}")
        if not variant.width or not variant.height:
            raise ValueError(f"{key} is missing dimensions")
        if not variant.init_function or not variant.clear_function or not variant.display_function:
            raise ValueError(f"{key} is missing init/clear/display metadata")
        source = panel_source(repo_root, key, get_variant_folder)
        header = source.with_suffix(".h")
        if not header.is_file():
            raise FileNotFoundError(f"Root Waveshare header missing for {key}: {header}")
        variants[key] = variant
        sources[source] = None  # several b/bc/c keys share one compile unit
        headers[header] = None

    parts = [
        "/* Generated by generate_panel_table.py - do not edit.",
        " *",
        " * Every supported Waveshare panel driver is linked into the firmware;",
        " * frameos_display.c picks the active entry at runtime from the",
        ' * configured panel name (NVS "panel" key).',
        " */",
        "#include <stddef.h>",
        "#include <stdint.h>",
        "",
        '#include "DEV_Config.h"',
        '#include "frameos_panel_table.h"',
        "",
    ]
    parts.extend(f'#include "{header.name}"' for header in headers)
    parts.extend(f'#include "{panel["header"]}"' for panel in EXTRA_PANELS)
    parts.extend([
        "",
        "/* A wrapper that only forwards is not in the table: the driver's own",
        " * function is, when its type is the slot's (a function that returns a",
        " * UBYTE, or takes a const buffer, keeps its wrapper). One that is not",
        " * referenced is not emitted. */",
        "#define FOS_PANEL_WRAPPER static __attribute__((unused))",
        "#define FOS_PANEL_IS(fn, type) __builtin_types_compatible_p(__typeof__(&(fn)), type)",
        "#define FOS_PANEL_SLOT(fn, type, wrapper) \\",
        "    __builtin_choose_expr(FOS_PANEL_IS(fn, type), (type)&(fn), &(wrapper))",
        "/* `init_kind, driver_init` for an Init(void) whose status the wrapper returns. */",
        "#define FOS_PANEL_INIT_STATUS(fn, wrapper) \\",
        "    __builtin_choose_expr(FOS_PANEL_IS(fn, UBYTE (*)(void)), FOS_PANEL_INIT_UBYTE, FOS_PANEL_INIT_INT), \\",
        "    __builtin_choose_expr(FOS_PANEL_IS(fn, UBYTE (*)(void)) || FOS_PANEL_IS(fn, int (*)(void)), \\",
        "                          (void (*)(void))&(fn), (void (*)(void))&(wrapper))",
        "/* ... and for one whose wrapper returns 0 whatever it does. */",
        "#define FOS_PANEL_INIT_QUIET(fn, wrapper) \\",
        "    __builtin_choose_expr(FOS_PANEL_IS(fn, void (*)(void)), FOS_PANEL_INIT_VOID, FOS_PANEL_INIT_INT), \\",
        "    __builtin_choose_expr(FOS_PANEL_IS(fn, void (*)(void)), (void (*)(void))&(fn), (void (*)(void))&(wrapper))",
        "",
    ])
    # The b, bc and c keys of one driver (and panels whose sleep is the same
    # call) would get wrappers that are one function under several names: one
    # for each body, named after the first panel that has it.
    wrapper_of: dict[tuple[str, str], str] = {}
    table_names: dict[str, dict[str, str]] = {}
    for key in keys:
        parts.append(f"/* {key} */")
        names = table_names.setdefault(key, {})
        for role, (signature, body) in panel_wrappers(variants[key]).items():
            name = wrapper_of.setdefault((role, body), f"fos_{role}_{key}")
            names[role] = name
            if name == f"fos_{role}_{key}":
                parts.append(f"{signature.format(name=name)}\n{{\n{body}\n}}")
        parts.append("")
    parts.append("const fos_panel_entry_t fos_panel_table[] = {")
    for key in keys:
        variant = variants[key]
        parts.append(
            "    { %s, %d, %d, %d, %d, %d,\n      %s,\n      %s,\n      %s,\n      %s },"
            % (
                c_string(key),
                int(variant.width),
                int(variant.height),
                PIXEL_FORMAT_BY_COLOR[variant.color_option],
                1 if key == "EPD_13in3e" else 0,
                FOS_PANEL_BUS_SPI,
                *panel_slots(variant, table_names[key]),
            )
        )
    for panel in EXTRA_PANELS:
        parts.append(
            "    { %s, %d, %d, %d, 0, %d, FOS_PANEL_INIT_INT, (void (*)(void))%s, %s, %s, %s },"
            % (
                c_string(panel["name"]),
                int(panel["width"]),
                int(panel["height"]),
                int(panel["format"]),
                int(panel["bus"]),
                panel["init"], panel["clear"], panel["display"], panel["sleep"],
            )
        )
    parts.append("};")
    parts.extend(
        f'_Static_assert(FOS_PANEL_IS({init}, int (*)(void)), "{init} is called as int (*)(void)");'
        for init in dict.fromkeys(panel["init"] for panel in EXTRA_PANELS)
    )
    parts.append("const size_t fos_panel_table_count = sizeof(fos_panel_table) / sizeof(fos_panel_table[0]);")
    parts.append("const fos_panel_partial_t fos_panel_partial_table[FOS_PANEL_PARTIAL_COUNT] = {")
    parts.extend(
        f"    {{ {c_string(key)}, {init}, {show}, {rest}, {changed}, {clean}, {owed} }},"
        for key, (init, show, rest, changed, clean, owed) in PARTIAL_PANELS.items()
    )
    parts.append("};")
    parts.append("")

    (out_dir / "frameos_panel_table.h").write_text(HEADER_TEXT.replace("@PARTIAL_COUNT@", str(len(PARTIAL_PANELS))))
    (out_dir / "frameos_panel_table.c").write_text("\n".join(parts))

    cmake_lines = ["set(FRAMEOS_PANEL_SOURCES"]
    cmake_lines.extend(f"    {cmake_string(str(source))}" for source in sources)
    cmake_lines.append(")")
    cmake_lines.append("set(FRAMEOS_PANEL_HEADERS")
    cmake_lines.extend(f"    {cmake_string(str(header))}" for header in headers)
    cmake_lines.append(")")
    cmake_lines.append("")
    (out_dir / "panel_sources.cmake").write_text("\n".join(cmake_lines))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    generate(repo_root, out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
