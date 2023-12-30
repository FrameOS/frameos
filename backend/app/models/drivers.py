from dataclasses import dataclass
from typing import Optional, List


@dataclass
class Driver:
    name: str # camelCase, safe for nim code, unique within this file
    import_path: str
    vendor_folder: Optional[str] = None
    has_init: bool = False
    has_render: bool = False

drivers = {
    "inkyPython": Driver(
        name="inkyPython",
        import_path="inkyPython/inkyPython",
        vendor_folder="inkyPython",
        has_init=True,
        has_render=True,
    ),
    "frameBuffer": Driver(
        name="frameBuffer",
        import_path="frameBuffer/frameBuffer",
        has_render=True,
    ),
}

def drivers_for_device(device: str) -> List[Driver]:
    if device == "pimoroni.inky_impression":
        return [drivers["inkyPython"]]
    if device == "framebuffer":
        return [drivers["frameBuffer"]]
    return []

def write_drivers_nim(drivers: List[Driver]) -> str:
    imports = []
    init_drivers = []
    render_drivers = []

    for driver in drivers:
        imports.append(f"import {driver.import_path} as {driver.name}Driver")
        if driver.has_init:
            init_drivers.append(f"{driver.name}Driver.init(frameOS)")
        if driver.has_render:
            render_drivers.append(f"{driver.name}Driver.render(frameOS, image)")

    if len(init_drivers) == 0:
        init_drivers.append("discard")
    if len(render_drivers) == 0:
        render_drivers.append("discard")

    newline = "\n"

    return f"""
import pixie
import frameos/types
{newline.join(imports)}

proc init*(frameOS: FrameOS) =
  {(newline + '  ').join(init_drivers)}

proc render*(frameOS: FrameOS, image: Image) =
  {(newline + '  ').join(render_drivers)}
    """
