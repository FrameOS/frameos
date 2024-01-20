from dataclasses import dataclass
from typing import Optional

@dataclass
class Driver:
    name: str # camelCase, safe for nim code, unique within this file
    variant: Optional[str] = None # device name, e.g. "EPD_1in54b_V2"
    import_path: Optional[str] = None # nim local import path for driver
    vendor_folder: Optional[str] = None # vendor/folder to be copied to the release folder
    can_render: bool = False # add render(image)
    can_png: bool = False # add toPng(rotate)
    can_turn_on_off: bool = False # add turnOn() and turnOff()

DRIVERS = {
    "inkyPython": Driver(
        name="inkyPython",
        import_path="inkyPython/inkyPython",
        vendor_folder="inkyPython",
        can_render=True,
    ),
    "gpioButton": Driver(
        name="gpioButton",
        import_path="gpioButton/gpioButton",
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
        can_png=True,
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
