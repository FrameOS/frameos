from dataclasses import dataclass
from typing import Optional, Dict, Literal


@dataclass
class Driver:
    name: str # camelCase, safe for nim code, unique within this file
    variant: Optional[str] = None # device name, e.g. "7in5_V2"
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

@dataclass
class WaveshareVariant:
    keyword: str
    nim_import_path: str
    color_option: Literal["Black", "BlackRed"] = "Black"
    init_returns_zero: bool = False


waveshare_variants: Dict[str, WaveshareVariant] = {
    "epd7in5_V2": WaveshareVariant("epd7in5_V2", "EPD_7in5_V2", init_returns_zero=True),
    "epd2in13_V3": WaveshareVariant("epd2in13_V3", "EPD_2in13_V3"),
}

# SUPPORTED_DEVICES = [
#     "epd1in02", "epd1in64g", "epd2in13", "epd2in66", "epd4in2b_V2", "epd5in83", "epd7in5b_V2",
#     "epd1in54b", "epd2in13bc", "epd2in13_V2", "epd2in7b", "epd2in9bc", "epd3in0g", "epd4in2", "epd5in83_V2", "epd7in5_HD",
#     "epd1in54b_V2", "epd2in13b_V3", "epd2in13_V3", "epd2in7b_V2", "epd2in9b_V3", "epd3in52", "epd4in37g", "epd7in3f", "epd7in5",
#     "epd1in54c", "epd2in13b_V4", "epd2in13_V4", "epd2in7", "epd2in9d", "epd3in7", "epd5in65f", "epd7in3g", "epd7in5_V2_fast",
#     "epd1in54", "epd2in13d", "epd2in36g", "epd2in9", "epd4in01f", "epd5in83bc", "epd7in5bc", "epd7in5_V2",
#     "epd1in54_V2", "epd2in13g", "epd2in66b", "epd2in7_V2", "epd2in9_V2", "epd4in2bc", "epd5in83b_V2", "epd7in5b_HD",
# ]

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

def write_waveshare_driver_nim(drivers: Dict[str, Driver]) -> str:
    driver = drivers.get("waveshare", None)
    if not driver:
        raise Exception("No waveshare driver found")
    if not driver.variant:
        raise Exception("No waveshare driver variant specified")
    if driver.variant not in waveshare_variants:
        raise Exception(f"Unknown waveshare driver variant {driver.variant}")
    
    variant = waveshare_variants[driver.variant]

    
    return f"""
import ePaper/DEV_Config as waveshareConfig
import ePaper/{variant.nim_import_path} as waveshareDisplay
from ./types import ColorOption

let width* = waveshareDisplay.WIDTH
let height* = waveshareDisplay.HEIGHT

let color_option* = ColorOption.{variant.color_option}

proc init*() =
  let resp = waveshareConfig.DEV_Module_Init()
  if resp != 0: raise newException(Exception, "Failed to initialize waveshare display")
  {'discard ' if variant.init_returns_zero else ''}waveshareDisplay.Init()

proc renderOne*(image: seq[uint8]) =
  {'waveshareDisplay.Display(addr image[0])' if variant.color_option == 'Black' else 'discard'}

proc renderTwo*(image1: seq[uint8], image2: seq[uint8]) =
  {'waveshareDisplay.Display(addr image1[0], addr image2[0])' if variant.color_option == 'BlackRed' else 'discard'}

"""