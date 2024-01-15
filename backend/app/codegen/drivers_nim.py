from typing import Dict

from app.drivers.drivers import Driver


def write_drivers_nim(drivers: Dict[str, Driver]) -> str:
    imports = []
    vars = []
    init_drivers = []
    render_drivers = []
    png_drivers = []
    on_drivers = []
    off_drivers = []

    for driver in drivers.values():
        if driver.import_path:
            imports.append(f"import {driver.import_path} as {driver.name}Driver")
            vars.append(f"var {driver.name}DriverInstance: {driver.name}Driver.Driver")
            init_drivers.append(f"{driver.name}DriverInstance = {driver.name}Driver.init(frameOS)")
            if driver.can_render:
                render_drivers.append(f"{driver.name}DriverInstance.render(image)")
            if driver.can_png and len(png_drivers) == 0:
                png_drivers.append(f"return {driver.name}Driver.toPng(rotate)")
            if driver.can_turn_on_off:
                on_drivers.append(f"{driver.name}DriverInstance.turnOn()")
                off_drivers.append(f"{driver.name}DriverInstance.turnOff()")

    newline = "\n"

    code = f"""
import pixie
import frameos/types
{newline.join(imports)}
{newline.join(vars)}

proc init*(frameOS: FrameOS) =
  {(newline + '  ').join(init_drivers or ["discard"])}

proc render*(image: Image) =
  {(newline + '  ').join(render_drivers or ["discard"])}

proc toPng*(rotate: int): string =
  {(newline + '  ').join(png_drivers or ['result = ""'])}

proc turnOn*() =
  {(newline + '  ').join(on_drivers or ["discard"])}

proc turnOff*() =
  {(newline + '  ').join(off_drivers or ["discard"])}
    """

    return code
