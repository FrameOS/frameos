from dataclasses import dataclass
from typing import Optional, Dict


@dataclass
class Driver:
    name: str # camelCase, safe for nim code, unique within this file
    import_path: str # nim local import path for driver
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
}

def drivers_for_device(device: str) -> Dict[str, Driver]:
    if device == "pimoroni.inky_impression":
        return {"inkyPython": drivers["inkyPython"]}
    if device == "framebuffer":
        return {"frameBuffer": drivers["frameBuffer"]}
    return {}

def write_drivers_nim(drivers: Dict[str, Driver]) -> str:
    imports = []
    vars = []
    init_drivers = []
    render_drivers = []
    on_drivers = []
    off_drivers = []

    for driver in drivers.values():
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
