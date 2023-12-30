from dataclasses import dataclass
from typing import Optional, Dict


@dataclass
class Driver:
    name: str # camelCase, safe for nim code, unique within this file
    import_path: str
    vendor_folder: Optional[str] = None
    has_render: bool = False

drivers = {
    "inkyPython": Driver(
        name="inkyPython",
        import_path="inkyPython/inkyPython",
        vendor_folder="inkyPython",
        has_render=True,
    ),
    "frameBuffer": Driver(
        name="frameBuffer",
        import_path="frameBuffer/frameBuffer",
        has_render=True,
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

    for driver in drivers.values():
        imports.append(f"import {driver.import_path} as {driver.name}Driver")
        vars.append(f"var {driver.name}DriverInstance: {driver.name}Driver.Driver")
        init_drivers.append(f"{driver.name}DriverInstance = {driver.name}Driver.init(frameOS)")
        if driver.has_render:
            render_drivers.append(f"{driver.name}DriverInstance.render(image)")

    if len(init_drivers) == 0:
        init_drivers.append("discard")
    if len(render_drivers) == 0:
        render_drivers.append("discard")

    newline = "\n"

    return f"""
import pixie
import frameos/types
{newline.join(imports)}
{newline.join(vars)}

proc init*(frameOS: FrameOS) =
  {(newline + '  ').join(init_drivers)}

proc render*(image: Image) =
  {(newline + '  ').join(render_drivers)}
    """
