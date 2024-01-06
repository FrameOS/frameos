import os
from dataclasses import dataclass
from typing import Optional, Dict, List, Literal

from app.drivers.drivers import Driver

@dataclass
class WaveshareVariant:
    key: str
    prefix: str
    width: Optional[int] = None
    height: Optional[int] = None
    init_function: Optional[str] = None
    clear_function: Optional[str] = None
    display_function: Optional[str] = None
    init_returns_zero: bool = False
    color_option: str = Literal["Black", "BlackRed"]


def get_variant_keys() -> List[str]:
    directory = os.path.join("..", "frameos", "src", "drivers", "waveshare", "ePaper")
    return [
        filename[0:-4]
        for filename in os.listdir(directory)
        if filename.startswith("EPD_") and filename.endswith(".nim")
    ]

def convert_waveshare_source(variant_key: str) -> WaveshareVariant:
    if not variant_key:
        raise Exception("No waveshare driver variant specified")
    if variant_key not in get_variant_keys(): # checks if a file called variant.nim exists
        raise Exception(f"Unknown waveshare driver variant {variant_key}")
    with open(os.path.join("..", "frameos", "src", "drivers", "waveshare", "ePaper", f"{variant_key}.nim"), "r") as f:
        variant = WaveshareVariant(key=variant_key, prefix='')
        for line in f.readlines():
            if "_WIDTH* = " in line:
                variant.width = int(line.split(" = ")[1].strip())
                variant.prefix = line.split("_WIDTH")[0].strip() # this is always the first and before any proc
            if "_HEIGHT* = " in line:
                variant.height = int(line.split(" = ")[1].strip())
            if line.startswith("proc"):
                proc_name = line.split("*(")[0].split(" ")[1]
                if proc_name.lower() == f"{variant.prefix}_Init".lower():
                    variant.init_function = proc_name
                    variant.init_returns_zero = "(): UBYTE" in line
                if proc_name.lower() == f"{variant.prefix}_Init_4Gray".lower() and variant.init_function is None:
                    variant.init_function = proc_name
                    variant.init_returns_zero = "(): UBYTE" in line
                if proc_name.lower() == f"{variant.prefix}_4Gray_Init".lower() and variant.init_function is None:
                    variant.init_function = proc_name
                    variant.init_returns_zero = "(): UBYTE" in line
                if proc_name.lower() == f"{variant.prefix}_Clear".lower():
                    variant.clear_function = proc_name
                if proc_name.lower() == f"{variant.prefix}_4Gray_Clear".lower() and variant.clear_function is None:
                    variant.clear_function = proc_name
                if proc_name.lower() == f"{variant.prefix}_Display".lower():
                    variant.display_function = proc_name
                if proc_name.lower() == f"{variant.prefix}_4Gray_Display".lower() and variant.display_function is None:
                    variant.display_function = proc_name
        return variant

def write_waveshare_driver_nim(drivers: Dict[str, Driver]) -> str:
    driver = drivers.get("waveshare", None)
    if not driver:
        raise Exception("No waveshare driver found")

    variant = convert_waveshare_source(driver.variant)

    return f"""
import ePaper/DEV_Config as waveshareConfig
import ePaper/{variant.key} as waveshareDisplay
from ./types import ColorOption

let width* = waveshareDisplay.WIDTH
let height* = waveshareDisplay.HEIGHT

let color_option* = ColorOption.{variant.color_option}

proc init*() =
  let resp = waveshareConfig.DEV_Module_Init()
  if resp != 0: raise newException(Exception, "Failed to initialize waveshare display")
  {'discard ' if variant.init_returns_zero else ''}waveshareDisplay.{variant.init_function}()

proc clear*() =
  waveshareDisplay.{variant.clear_function}()

proc renderOne*(image: seq[uint8]) =
  {f'waveshareDisplay.{variant.display_function}(addr image[0])' if variant.color_option == 'Black' else 'discard'}

proc renderTwo*(image1: seq[uint8], image2: seq[uint8]) =
  {f'waveshareDisplay.{variant.display_function}(addr image1[0], addr image2[0])' if variant.color_option == 'BlackRed' else 'discard'}

"""
