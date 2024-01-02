from dataclasses import dataclass
from typing import Optional, Dict


@dataclass
class Driver:
    name: str # camelCase, safe for nim code, unique within this file
    device: Optional[str] = None # device name, e.g. "7in5_V2"
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
    "spi": Driver( # enables spi on deploy
        name="spi",
    ),
    "i2c": Driver( # enables i2c on deploy
        name="i2c",
    ),
}

def drivers_for_device(device: str) -> Dict[str, Driver]:
    if device == "pimoroni.inky_impression":
        return {"inkyPython": drivers["inkyPython"], "spi": drivers["spi"], "i2c": drivers["i2c"]}
    elif device == "pimoroni.hyperpixel2r":
        return {"inkyHyperPixel2r": drivers["inkyHyperPixel2r"]}
    elif device == "framebuffer":
        return {"frameBuffer": drivers["frameBuffer"]}
    elif device.startswith("waveshare."):
        waveshare = drivers["waveshare"]
        waveshare.device = device.split(".")[1]
        return {"waveshare": waveshare, "spi": drivers["spi"]}
    return {}

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

def write_waveshare_driver(drivers: Dict[str, Driver]) -> str:
    driver = drivers.get("waveshare", None)
    if not driver:
        raise Exception("No waveshare driver found")
    if not driver.device:
        raise Exception("No waveshare device found")
    
    return """
import ePaper/DEV_Config as waveshareConfig
import ePaper/EPD_2in13_V3 as waveshareDisplay
from ./types import ColorOption

let width* = waveshareDisplay.WIDTH
let height* = waveshareDisplay.HEIGHT

let colorOption* = ColorOption.Black

proc init*() =
  let resp = waveshareConfig.DEV_Module_Init()
  if resp != 0: raise newException(Exception, "Failed to initialize waveshare display")
  waveshareDisplay.Init()

proc renderOne*(image: seq[uint8]) =
  waveshareDisplay.Display(addr image[0])

proc renderTwo*(image1: seq[uint8], image2: seq[uint8]) =
  discard

"""