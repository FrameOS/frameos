from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Literal

from app.drivers.drivers import Driver

REPO_ROOT = Path(__file__).resolve().parents[3]
FRAMEOS_ROOT = REPO_ROOT / "frameos"

@dataclass
class WaveshareVariant:
    key: str
    prefix: str
    size: float
    code: str = ""
    width: Optional[int] = None
    height: Optional[int] = None
    init_function: Optional[str] = None
    init_args: str = ""
    clear_function: Optional[str] = None
    clear_args: str = ""
    sleep_function: Optional[str] = None
    display_function: Optional[str] = None
    display_arguments: Optional[list[str]] = None
    init_returns_zero: bool = False
    color_option: Literal["Unknown", "Black", "BlackWhiteRed", "BlackWhiteYellow", "FourGray", "SpectraSixColor", "SevenColor", "BlackWhiteYellowRed", "SixteenGray"] = "Unknown"

# Colors if we can't autodetect
VARIANT_COLORS = {
    "EPD_1in64g": "BlackWhiteYellowRed",
    "EPD_2in13g": "BlackWhiteYellowRed",
    "EPD_2in13g_V2": "BlackWhiteYellowRed",
    "EPD_2in15g": "BlackWhiteYellowRed",
    "EPD_2in36g": "BlackWhiteYellowRed",
    "EPD_2in66g": "BlackWhiteYellowRed",
    "EPD_3in0g": "BlackWhiteYellowRed",
    "EPD_4in37g": "BlackWhiteYellowRed",
    "EPD_5in79g": "BlackWhiteYellowRed",
    "EPD_7in3g": "BlackWhiteYellowRed",

    "EPD_1in02d": "Black",
    "EPD_1in54": "Black",
    "EPD_1in54_V2": "Black",
    "EPD_1in54_DES": "Black",
    "EPD_2in9": "Black",
    "EPD_2in9_DES": "Black",
    "EPD_2in9d": "Black",
    "EPD_2in13": "Black",
    "EPD_2in13_DES": "Black",
    "EPD_2in13d": "Black",
    "EPD_2in13_V2": "Black",
    "EPD_2in13_V3": "Black",
    "EPD_2in13_V4": "Black",
    "EPD_2in66": "Black",
    "EPD_3in52": "Black",
    "EPD_5in83": "Black",
    "EPD_5in83_V2": "FourGray",
    "EPD_5in84": "Black",
    "EPD_7in5": "Black",
    "EPD_13in3k": "FourGray",

    "EPD_10in2b": "Black", # and red
    "EPD_12in48": "Black",

    "EPD_4in01f": "SevenColor",
    "EPD_7in3f": "SevenColor",
    "EPD_5in65f": "SevenColor",

    "EPD_4in0e": "SpectraSixColor",
    "EPD_7in3e": "SpectraSixColor",
    "EPD_13in3e": "SpectraSixColor",

    "EPD_10in3": "SixteenGray",
}

NO_SPI_VARIANTS = {
    "EPD_12in48",
    "EPD_12in48b",
    "EPD_12in48b_V2",
    "EPD_13in3e",
}

BOOT_CONFIG_SPI_VARIANTS = {
    "EPD_10in3",
}

BOOT_CONFIG_LINES_BY_VARIANT = {
    "EPD_10in3": [
        "dtoverlay=spi0-0cs",
        "#dtparam=spi=on",
    ],
    "EPD_13in3e": [
        "gpio=7=op,dl",
        "gpio=8=op,dl",
    ],
}

PARTIAL_REFRESH_VARIANTS = {
    "EPD_7in5_V2",
    "EPD_13in3b",
}

PARTIAL_REFRESH_MAX_BEFORE_FULL = {
    "EPD_7in5_V2": 30,
}

PARTIAL_REFRESH_MAX_AREA_PERCENT = {
    "EPD_7in5_V2": 20.0,
}

FAST_PARTIAL_SESSION_VARIANTS = {
    "EPD_7in5_V2",
}


def get_variant_keys_for(folder: str) -> list[str]:
    directory = FRAMEOS_ROOT / "src" / "drivers" / "waveshare" / folder
    return [
        filename[0:-4]
        for filename in os.listdir(directory)
        if filename.startswith("EPD_") and filename.endswith(".nim")
    ]

def get_variant_keys() -> list[str]:
    return [
        *get_variant_keys_for("ePaper"),
        *get_variant_keys_for("it8951"),
        *get_variant_keys_for("epd12in48"),
        *get_variant_keys_for("epd13in3e"),
    ]

def get_variant_folder(variant_key: str) -> str:
    if variant_key in get_variant_keys_for("ePaper") :
        return "ePaper"
    elif variant_key == "EPD_13in3e":
        return "epd13in3e"
    elif variant_key == "EPD_10in3":
        return "it8951"
    else:
        return "epd12in48"

def nim_string_seq_literal(values: list[str]) -> str:
    return "@[" + ", ".join(json.dumps(value) for value in values) + "]"

def waveshare_setup_imports_nim(variant_key: str) -> str:
    setup_driver = waveshare_setup_driver(variant_key)
    imports = [
        "import frameos/device_setup",
        "import frameos/driver_context",
    ]
    if setup_driver:
        imports.append(f"import drivers/{setup_driver}/{setup_driver} as {setup_driver}SetupDriver")
    return "\n".join(imports)

def waveshare_setup_driver(variant_key: str) -> str | None:
    if variant_key in BOOT_CONFIG_SPI_VARIANTS:
        return None
    return "noSpi" if variant_key in NO_SPI_VARIANTS else "spi"

def waveshare_setup_body_nim(variant_key: str) -> str:
    setup_driver = waveshare_setup_driver(variant_key)
    setup_calls = []
    if setup_driver:
        setup_calls.append(
            f'addSetupResult(result, runSetupStep("{setup_driver}", proc(): SetupResult = {setup_driver}SetupDriver.setup()))'
        )
    boot_config_lines = BOOT_CONFIG_LINES_BY_VARIANT.get(variant_key, [])
    if boot_config_lines:
        setup_calls.append(
            'addSetupResult(result, runSetupStep("bootConfig", proc(): SetupResult = '
            f"setupBootConfig({nim_string_seq_literal(boot_config_lines)})))"
        )
    return "\n  ".join(setup_calls or ["result = setupOk()"])

def get_proc_arguments(line: str, variant_key: str) -> list[str]:
    unknown_color = "FourGray" if "4Gray" in line else "Unknown"
    argmap = {
        "blackimage": "Black",
        "imageblack": "Black",
        "redimage": "Red",
        "imagered": "Red",
        "ryimage": "Red",
        "image": VARIANT_COLORS.get(variant_key, unknown_color),
        "picdata": VARIANT_COLORS.get(variant_key, unknown_color),
    }
    arg_names = []
    for arg in get_proc_parameters(line):
        name = arg.strip().split(': ')[0]
        arg_names.append(argmap.get(name.lower(), name))
    return arg_names

def get_proc_parameters(line: str) -> list[str]:
    if "*(" not in line:
        return []
    parameters = line.split("*(", 1)[1].split(")", 1)[0].strip()
    if not parameters:
        return []
    return [parameter.strip() for parameter in parameters.split(";")]

def get_default_proc_arguments(line: str) -> str:
    default_args = []
    for parameter in get_proc_parameters(line):
        parameter_type = parameter.split(": ", 1)[1].strip() if ": " in parameter else ""
        if parameter_type == "UBYTE":
            default_args.append("0.uint8")
        elif parameter_type == "UWORD":
            default_args.append("0.uint16")
        elif parameter_type == "UDOUBLE":
            default_args.append("0.uint32")
        elif parameter_type.startswith("ptr "):
            default_args.append("nil")
        else:
            default_args.append("0")
    return ", ".join(default_args)

def key_to_float(key: str) -> tuple[Optional[float], Optional[str]]:
    match = re.search(r'(\d+)in(\d+)([a-zA-Z_0-9]*)', key)
    if match:
        whole_number = match.group(1)
        fractional_part = match.group(2)
        suffix = match.group(3)
        float_str = f"{whole_number}.{fractional_part}"
        return float(float_str), suffix.replace('_', ' ').strip()
    else:
        return None, None

def convert_waveshare_source(variant_key: Optional[str]) -> WaveshareVariant:
    if not variant_key:
        raise Exception("No waveshare driver variant specified")
    if variant_key not in get_variant_keys(): # checks if a file called variant.nim exists
        raise Exception(f"Unknown waveshare driver variant {variant_key}")
    size, code = key_to_float(variant_key)
    if size is None or code is None:
        raise Exception(f"Invalid waveshare driver variant {variant_key}")

    source_path = FRAMEOS_ROOT / "src" / "drivers" / "waveshare" / get_variant_folder(variant_key) / f"{variant_key}.nim"
    with open(source_path, "r") as f:
        variant = WaveshareVariant(key=variant_key, prefix='', size=size, code=code)
        lines = []
        in_proc = False
        for line in f.readlines():
            if line.strip() == "":
                continue
            if line.startswith("proc"):
                in_proc = True
                lines.append(line)
            elif in_proc and line.startswith("  "):
                if len(lines) > 0:
                    lines[-1] = lines[-1].strip() + " " + line.strip()
                else:
                    lines.append(line)
            else:
                in_proc = False
                lines.append(line)

        for line in lines:
            if variant.width is None:
                if "_MAX_WIDTH* = " in line:
                    variant.width = int(line.split(" = ")[1].strip())
                    variant.prefix = line.split("_MAX_WIDTH")[0].strip() # this is always the first and before any proc
                elif "_WIDTH* = " in line:
                    variant.width = int(line.split(" = ")[1].strip())
                    variant.prefix = line.split("_WIDTH")[0].strip() # this is always the first and before any proc
            if variant.height is None:
                if "_MAX_HEIGHT* = " in line:
                    variant.height = int(line.split(" = ")[1].strip())
                elif "_HEIGHT* = " in line:
                    variant.height = int(line.split(" = ")[1].strip())
            if line.startswith("proc"):
                proc_name = line.split("*(")[0].split(" ")[1]
                if proc_name.lower() == f"{variant.prefix}_Init".lower() and variant.init_function is None:
                    variant.init_function = proc_name
                    variant.init_args = get_default_proc_arguments(line)
                    variant.init_returns_zero = "): UBYTE" in line
                if proc_name.lower() == f"{variant.prefix}_Init_4Gray".lower():
                    variant.init_function = proc_name
                    variant.init_args = get_default_proc_arguments(line)
                    variant.init_returns_zero = "): UBYTE" in line
                if proc_name.lower() == f"{variant.prefix}_4Gray_Init".lower():
                    variant.init_function = proc_name
                    variant.init_args = get_default_proc_arguments(line)
                    variant.init_returns_zero = "): UBYTE" in line
                if proc_name.lower() == f"{variant.prefix}_Clear".lower() and variant.clear_function is None:
                    variant.clear_function = proc_name
                    if "color: UBYTE" in line:
                        variant.clear_args = "1.uint8"
                if proc_name.lower() == f"{variant.prefix}_4Gray_Clear".lower():
                    variant.clear_function = proc_name
                if proc_name.lower() == f"{variant.prefix}_Sleep".lower():
                    variant.sleep_function = proc_name
                if (proc_name.lower() == f"{variant.prefix}_Display".lower() and variant.display_function is None) or (
                    proc_name.lower() == f"{variant.prefix}_4Gray_Display".lower() or proc_name.lower() == f"{variant.prefix}_Display_4Gray".lower()
                ) or (proc_name.lower() == f"{variant.prefix}_4GrayDisplay".lower()):
                    variant.display_function = proc_name
                    variant.display_arguments = get_proc_arguments(line, variant_key)
                    # print("-> " + proc_name + "(" + (", ".join(variant.display_arguments)) + ") <-")
                if (proc_name.lower() == f"{variant.prefix}_16Gray_Display".lower()):
                    variant.display_function = proc_name
                    variant.display_arguments = get_proc_arguments(line, variant_key)

        if variant.display_arguments == ["Black"]:
            variant.color_option = "Black"
        elif variant.display_arguments == ["Black", "Red"]:
            if variant_key.endswith("c"):
                variant.color_option = "BlackWhiteYellow"
            else:
                variant.color_option = "BlackWhiteRed"
        elif variant.display_arguments == ["BlackWhiteYellowRed"]:
            variant.color_option = "BlackWhiteYellowRed"
        elif variant.display_arguments == ["FourGray"]:
            variant.color_option = "FourGray"
        elif variant.display_arguments == ["SevenColor"]:
            variant.color_option = "SevenColor"
        elif variant.display_arguments == ["SpectraSixColor"]:
            variant.color_option = "SpectraSixColor"
        elif variant_key == "EPD_10in3":
            variant.color_option = "SixteenGray"
            variant.init_args = "self"
            variant.init_returns_zero = True
        else:
            print(f"Unknown color: {variant_key} - {variant.display_function} -- {variant.display_arguments}" )

        return variant

def write_waveshare_driver_nim(drivers: dict[str, Driver]) -> str:
    driver = drivers.get("waveshare", None)
    if not driver:
        raise Exception("No waveshare driver found")

    variant = convert_waveshare_source(driver.variant)
    variant_folder = get_variant_folder(variant.key)

    color_warning = ""
    if variant.color_option == "Unknown":
        color_warning = "\n\n# NOTE! We could not detect the correct color options. Assuming 1-bit Black.\n\n"

    supports_partial_refresh = variant.key in PARTIAL_REFRESH_VARIANTS
    max_partial_refreshes_before_full = PARTIAL_REFRESH_MAX_BEFORE_FULL.get(variant.key, 5)
    max_partial_refresh_area_percent = PARTIAL_REFRESH_MAX_AREA_PERCENT.get(variant.key, 100.0)
    supports_fast_partial_session = variant.key in FAST_PARTIAL_SESSION_VARIANTS
    start_partial_code = "start(self)"
    if variant.key == "EPD_13in3b":
        render_partial_code = f"""
proc renderImageBlackWhiteRedBase*(image1: seq[uint8], image2: seq[uint8]) =
  if image1.len == 0 or image2.len == 0:
    return
  waveshareDisplay.{variant.prefix}_Display_Base(addr image1[0], addr image2[0])

proc renderImagePartialBase*(image: seq[uint8]) =
  if image.len == 0:
    return
  waveshareDisplay.{variant.prefix}_Display_PartialBase(addr image[0])

proc renderImagePartial*(image: seq[uint8], xStart: int, yStart: int, xEnd: int, yEnd: int) =
  if image.len == 0:
    return
  waveshareDisplay.{variant.prefix}_Display_Partial(addr image[0], xStart.uint16, yStart.uint16, xEnd.uint16, yEnd.uint16)
"""
    elif variant.key == "EPD_7in5_V2":
        start_partial_code = f"discard waveshareDisplay.{variant.prefix}_Init_Partial()"
        render_partial_code = f"""
proc renderImageBlackWhiteRedBase*(image1: seq[uint8], image2: seq[uint8]) =
  discard image1
  discard image2

proc renderImagePartialBase*(image: seq[uint8]) =
  if image.len == 0:
    return
  waveshareDisplay.{variant.prefix}_Display_PartialBase(addr image[0])

proc renderImagePartial*(image: seq[uint8], xStart: int, yStart: int, xEnd: int, yEnd: int) =
  if image.len == 0:
    return
  waveshareDisplay.{variant.prefix}_Display_Partial(addr image[0], xStart.uint32, yStart.uint32, xEnd.uint32, yEnd.uint32)
"""
    else:
        render_partial_code = """
proc renderImageBlackWhiteRedBase*(image1: seq[uint8], image2: seq[uint8]) =
  discard image1
  discard image2

proc renderImagePartialBase*(image: seq[uint8]) =
  discard image

proc renderImagePartial*(image: seq[uint8], xStart: int, yStart: int, xEnd: int, yEnd: int) =
  discard image
  discard xStart
  discard yStart
  discard xEnd
  discard yEnd
"""

    if variant_folder == "ePaper":
        pin_overrides_code = (
            "proc setPinOverrides*(pins: PinOverrides) =\n"
            "  waveshareConfig.DEV_SetPinConfig(pins.rst.cint, pins.dc.cint, pins.cs.cint,\n"
            "    pins.busy.cint, pins.sclk.cint, pins.mosi.cint, pins.pwr.cint)"
        )
    else:
        # GPIO remap layer only covers the ePaper DEV_Config family so far
        pin_overrides_code = (
            "proc setPinOverrides*(pins: PinOverrides) =\n"
            "  discard pins"
        )

    code = f"""# This file is automatically generated

import {variant_folder}/DEV_Config as waveshareConfig
import {variant_folder}/{variant.key} as waveshareDisplay
{waveshare_setup_imports_nim(variant.key)}
import drivers/waveshare/types

let width* = waveshareDisplay.{variant.prefix}_WIDTH
let height* = waveshareDisplay.{variant.prefix}_HEIGHT

let color_option* = ColorOption.{variant.color_option}
let supportsPartialRefresh* = {str(supports_partial_refresh).lower()}
let maxPartialRefreshesBeforeFull* = {max_partial_refreshes_before_full}
let maxPartialRefreshAreaPercent* = {max_partial_refresh_area_percent}
let supportsFastPartialSession* = {str(supports_fast_partial_session).lower()}
{color_warning}

proc setup*(frameOS: DriverContext = nil): SetupResult =
  discard frameOS
  {waveshare_setup_body_nim(variant.key)}

{pin_overrides_code}

proc init*() =
  let resp = waveshareConfig.DEV_Module_Init()
  if resp != 0: raise newException(Exception, "Failed to initialize waveshare display")

proc start*(self: Driver) =
  {'discard ' if variant.init_returns_zero else ''}waveshareDisplay.{variant.init_function}({variant.init_args})

proc startPartial*(self: Driver) =
  {start_partial_code}

proc clear*() =
  waveshareDisplay.{variant.clear_function}({variant.clear_args})

proc sleep*() =
  waveshareDisplay.{variant.sleep_function}()

proc renderImage*(image: seq[uint8]) =
  {f'waveshareDisplay.{variant.display_function}(addr image[0])' if variant.color_option not in ('BlackWhiteRed', 'BlackWhiteYellow') else 'discard'}

proc renderImageBlackWhiteRed*(image1: seq[uint8], image2: seq[uint8]) =
  {f'waveshareDisplay.{variant.display_function}(addr image1[0], addr image2[0])' if variant.color_option in ('BlackWhiteRed', 'BlackWhiteYellow') else 'discard'}

{render_partial_code}
"""
    return code
