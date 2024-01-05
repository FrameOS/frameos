import os
from dataclasses import dataclass
from typing import Optional, Dict, List


@dataclass
class Driver:
    name: str # camelCase, safe for nim code, unique within this file
    variant: Optional[str] = None # device name, e.g. "EPD_1in54b_V2"
    import_path: Optional[str] = None # nim local import path for driver
    vendor_folder: Optional[str] = None # vendor/folder to be copied to the release folder
    can_render: bool = False # add render(image)
    can_turn_on_off: bool = False # add turnOn() and turnOff()

drivers = {
    "inkyPython": Driver(
        name="inkyPython",
        import_path="inkyPython/inkyPython",
        vendor_folder="inkyPython",
        can_render=True,
    ),
    "frameBuffer": Driver(
        name="frameBuffer",
        import_path="frameBuffer/frameBuffer",
        can_render=True,
        can_turn_on_off=True
    ),
    "waveshare": Driver(
        name="waveshare",
        import_path="waveshare/waveshare",
        can_render=True,
    ),
    "inkyHyperPixel2r": Driver(
        name="inkyHyperPixel2r",
        import_path="inkyHyperPixel2r/inkyHyperPixel2r",
        vendor_folder="inkyHyperPixel2r",
        can_render=True,
        can_turn_on_off=True
    ),
    "evdev": Driver( # touch and mouse inputs
        name="evdev",
        import_path="evdev/evdev",
    ),
    "spi": Driver( # enables spi on deploy
        name="spi",
    ),
    "i2c": Driver( # enables i2c on deploy
        name="i2c",
    ),
}

def drivers_for_device(device: str) -> Dict[str, Driver]:
    device_drivers: Dict[str, Driver] = {}
    if device == "pimoroni.inky_impression":
        device_drivers = {"inkyPython": drivers["inkyPython"], "spi": drivers["spi"], "i2c": drivers["i2c"]}
    elif device == "pimoroni.hyperpixel2r":
        device_drivers = {"inkyHyperPixel2r": drivers["inkyHyperPixel2r"]}
    elif device == "framebuffer":
        device_drivers = {"frameBuffer": drivers["frameBuffer"]}
    elif device.startswith("waveshare."):
        waveshare = drivers["waveshare"]
        waveshare.variant = device.split(".")[1]
        # backwards compatibility
        if waveshare.variant == "epd7in5_V2":
            waveshare.variant = "EPD_7in5_V2"
        if waveshare.variant == "epd2in13_V3":
            waveshare.variant = "EPD_2in13_V3"

        if waveshare.variant not in get_waveshare_variants():
            raise Exception(f"Unknown waveshare driver variant {waveshare.variant}")
        device_drivers = {"waveshare": waveshare, "spi": drivers["spi"]}
    
    # Always enable evdev if not eink
    if device != "pimoroni.inky_imporession" and not device.startswith("waveshare."):
        device_drivers['evdev'] = drivers['evdev']

    return device_drivers

def write_drivers_nim(drivers: Dict[str, Driver]) -> str:
    imports = []
    vars = []
    init_drivers = []
    render_drivers = []
    on_drivers = []
    off_drivers = []

    for driver in drivers.values():
        if driver.import_path:
            imports.append(f"import {driver.import_path} as {driver.name}Driver")
            vars.append(f"var {driver.name}DriverInstance: {driver.name}Driver.Driver")
            init_drivers.append(f"{driver.name}DriverInstance = {driver.name}Driver.init(frameOS)")
            if driver.can_render:
                render_drivers.append(f"{driver.name}DriverInstance.render(image)")
            if driver.can_turn_on_off:
                on_drivers.append(f"{driver.name}DriverInstance.turnOn()")
                off_drivers.append(f"{driver.name}DriverInstance.turnOff()")

    newline = "\n"

    return f"""
import pixie
import frameos/types
{newline.join(imports)}
{newline.join(vars)}

proc init*(frameOS: FrameOS) =
  {(newline + '  ').join(init_drivers or ["discard"])}

proc render*(image: Image) =
  {(newline + '  ').join(render_drivers or ["discard"])}

proc turnOn*() =
  {(newline + '  ').join(on_drivers or ["discard"])}

proc turnOff*() =
  {(newline + '  ').join(off_drivers or ["discard"])}
    """

def get_waveshare_variants() -> List[str]:
    directory = os.path.join("..", "frameos", "src", "drivers", "waveshare", "ePaper")
    return [
        filename[0:-4]
        for filename in os.listdir(directory)
        if filename.startswith("EPD_") and filename.endswith(".nim")
    ]

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
    color_option: str = "Black"

def convert_waveshare_source(variant: str) -> WaveshareVariant:
    if not variant:
        raise Exception("No waveshare driver variant specified")
    if variant not in get_waveshare_variants(): # checks if a file called variant.nim exists
        raise Exception(f"Unknown waveshare driver variant {variant}")
    with open(os.path.join("..", "frameos", "src", "drivers", "waveshare", "ePaper", f"{variant}.nim"), "r") as f:
        variant = WaveshareVariant(key=variant, prefix='')
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
