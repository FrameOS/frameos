import os
import re
from dataclasses import dataclass
from typing import Optional, Dict, List, Literal, Tuple

from app.drivers.drivers import Driver

@dataclass
class WaveshareVariant:
    key: str
    prefix: str
    size: float
    code: str = ""
    width: Optional[int] = None
    height: Optional[int] = None
    init_function: Optional[str] = None
    clear_function: Optional[str] = None
    display_function: Optional[str] = None
    display_arguments: Optional[List[str]] = None
    init_returns_zero: bool = False
    color_option: Literal["Unknown", "Black", "BlackRed", "4Gray", "7Color"] = "Unknown"

# Colors if we can't autodetect
VARIANT_COLORS = {
    "EPD_1in64g": "BWYR",
    "EPD_2in36g": "BWYR",
    "EPD_2in66g": "BWYR",
    "EPD_2in13g": "BWYR",
    "EPD_3in0g": "BWYR",
    "EPD_4in37g": "BWYR",
    "EPD_7in3g": "BWYR",

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
    "EPD_5in83_V2": "Black",
    "EPD_5in84": "Black",
    "EPD_7in5": "Black",
    "EPD_13in3k": "Black",

    "EPD_10in2b": "Black", # and red

    "EPD_4in01f": "7Color",
    "EPD_7in3f": "7Color",
    "EPD_5in65f": "7Color",
}

# TODO: BYWR support https://www.waveshare.com/wiki/4.37inch_e-Paper_Module_(G)_Manual#Working_With_Raspberry_Pi
# TODO: 4Gray support
# TODO: 7Color support

def get_variant_keys() -> List[str]:
    directory = os.path.join("..", "frameos", "src", "drivers", "waveshare", "ePaper")
    return [
        filename[0:-4]
        for filename in os.listdir(directory)
        if filename.startswith("EPD_") and filename.endswith(".nim")
    ]

def get_proc_arguments(line: str, variant_key: str) -> List[str]:
    unknown_color = "4Gray" if "4Gray" in line else "Unknown"
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
    for arg in line.split('*(')[1].split(') {.')[0].split(';'):
        name = arg.strip().split(': ')[0]
        arg_names.append(argmap.get(name.lower(), name))
    return arg_names

def key_to_float(key: str) -> Tuple[Optional[float], Optional[str]]:
    match = re.search(r'(\d+)in(\d+)([a-zA-Z_0-9]*)', key)
    if match:
        whole_number = match.group(1)
        fractional_part = match.group(2)
        suffix = match.group(3)
        float_str = f"{whole_number}.{fractional_part}"
        return float(float_str), suffix.replace('_', ' ').strip()
    else:
        return None, None

def convert_waveshare_source(variant_key: str) -> WaveshareVariant:
    if not variant_key:
        raise Exception("No waveshare driver variant specified")
    if variant_key not in get_variant_keys(): # checks if a file called variant.nim exists
        raise Exception(f"Unknown waveshare driver variant {variant_key}")
    with open(os.path.join("..", "frameos", "src", "drivers", "waveshare", "ePaper", f"{variant_key}.nim"), "r") as f:
        size, code = key_to_float(variant_key)
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
            if "_WIDTH* = " in line:
                variant.width = int(line.split(" = ")[1].strip())
                variant.prefix = line.split("_WIDTH")[0].strip() # this is always the first and before any proc
            if "_HEIGHT* = " in line:
                variant.height = int(line.split(" = ")[1].strip())
            if line.startswith("proc"):
                proc_name = line.split("*(")[0].split(" ")[1]
                if proc_name.lower() == f"{variant.prefix}_Init".lower() and variant.init_function is None:
                    variant.init_function = proc_name
                    variant.init_returns_zero = "(): UBYTE" in line
                if proc_name.lower() == f"{variant.prefix}_Init_4Gray".lower():
                    variant.init_function = proc_name
                    variant.init_returns_zero = "(): UBYTE" in line
                if proc_name.lower() == f"{variant.prefix}_4Gray_Init".lower():
                    variant.init_function = proc_name
                    variant.init_returns_zero = "(): UBYTE" in line
                if proc_name.lower() == f"{variant.prefix}_Clear".lower() and variant.clear_function is None:
                    variant.clear_function = proc_name
                if proc_name.lower() == f"{variant.prefix}_4Gray_Clear".lower():
                    variant.clear_function = proc_name
                if (proc_name.lower() == f"{variant.prefix}_Display".lower() and variant.display_function is None) or (
                    proc_name.lower() == f"{variant.prefix}_4Gray_Display".lower() or proc_name.lower() == f"{variant.prefix}_Display_4Gray".lower()
                ) or (proc_name.lower() == f"{variant.prefix}_4GrayDisplay".lower()):
                    variant.display_function = proc_name
                    variant.display_arguments = get_proc_arguments(line, variant_key)
                    # print("-> " + proc_name + "(" + (", ".join(variant.display_arguments)) + ") <-")

        if variant.display_arguments == ["Black"]:
            variant.color_option = "Black"
        elif variant.display_arguments == ["Black", "Red"]:
            variant.color_option = "BlackRed"
        elif variant.display_arguments == ["BWYR"]:
            variant.color_option = "BlackWhiteYellowRed"
        elif variant.display_arguments == ["4Gray"]:
            variant.color_option = "4Gray"
        elif variant.display_arguments == ["7Color"]:
            variant.color_option = "7Color"
        else:
            print(f"Unknown color: {variant_key} - {variant.display_function} -- {variant.display_arguments}" )

        return variant

def write_waveshare_driver_nim(drivers: Dict[str, Driver]) -> str:
    driver = drivers.get("waveshare", None)
    if not driver:
        raise Exception("No waveshare driver found")

    variant = convert_waveshare_source(driver.variant)
    color_warning = ""
    if variant.color_option == "Unknown":
        color_warning = "\n\n# NOTE! We could not detect the correct color options. Assuming 1-bit Black.\n\n"

    return f"""# This file is automatically generated
    
import ePaper/DEV_Config as waveshareConfig
import ePaper/{variant.key} as waveshareDisplay
from ./types import ColorOption

let width* = waveshareDisplay.{variant.prefix}_WIDTH
let height* = waveshareDisplay.{variant.prefix}_HEIGHT

let color_option* = ColorOption.{variant.color_option}
{color_warning}
proc init*() =
  let resp = waveshareConfig.DEV_Module_Init()
  if resp != 0: raise newException(Exception, "Failed to initialize waveshare display")
  {'discard ' if variant.init_returns_zero else ''}waveshareDisplay.{variant.init_function}()

proc clear*() =
  waveshareDisplay.{variant.clear_function}()

proc renderImage*(image: seq[uint8]) =
  {f'waveshareDisplay.{variant.display_function}(addr image[0])' if variant.color_option != 'BlackRed' else 'discard'}

proc renderImageBlackRed*(image1: seq[uint8], image2: seq[uint8]) =
  {f'waveshareDisplay.{variant.display_function}(addr image1[0], addr image2[0])' if variant.color_option == 'BlackRed' else 'discard'}

"""
