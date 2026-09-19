from dataclasses import dataclass
from typing import Optional

@dataclass
class Driver:
    name: str # camelCase, safe for nim code, unique within this file
    variant: Optional[str] = None # device name, e.g. "EPD_1in54b_V2"
    import_path: Optional[str] = None # nim local import path for driver
    setup_import_path: Optional[str] = None # nim local import path for setup proc
    vendor_folder: Optional[str] = None # vendor/folder to be copied to the release folder
    can_render: bool = False # add render(image)
    can_png: bool = False # add toPng(rotate)
    can_turn_on_off: bool = False # add turnOn() and turnOff()
    lines: Optional[list[str]] = None # extra config lines for drivers
    link_flags: tuple[str, ...] = () # additional linker flags required when this driver is present

DRIVERS = {
    "inkyPython": Driver(
        name="inkyPython",
        import_path="inkyPython/inkyPython",
        setup_import_path="inkyPython/inkyPython",
        vendor_folder="inkyPython",
        can_png=False, # will be set to true for the frames that support this
        can_render=True,
    ),
    "inky": Driver(
        name="inky",
        import_path="inky/inky",
        setup_import_path="inky/inky",
        can_render=True,
        can_png=True,
    ),
    "gpioButton": Driver(
        name="gpioButton",
        import_path="gpioButton/gpioButton",
    ),
    "frameBuffer": Driver(
        name="frameBuffer",
        import_path="frameBuffer/frameBuffer",
        setup_import_path="frameBuffer/frameBuffer",
        can_render=True,
        can_turn_on_off=True
    ),
    "waveshare": Driver(
        name="waveshare",
        import_path="waveshare/waveshare",
        can_render=True,
        can_png=True,
        can_turn_on_off=True,
    ),
    # The HyperPixel 2.1" Round. On a Pi 0-4: firmware DPI into /dev/fb0
    # (setup writes the dpi_* block into config.txt), the ST7701 init and the
    # backlight over GPIO — no vendor tree or Python — and touch through the
    # kernel's edt-ft5x06, on an I2C bus a small overlay from the driver's
    # setup enables over the init bus's own pins. On a Pi 5, which has no
    # firmware DPI, setup enables the kernel's vc4-kms-dpi-hyperpixel2r
    # overlay instead (no touch there). The board is detected on the device.
    # The one driver for the panel since 2026-09-12; a frame from before touch
    # gains two config.txt lines and one reboot on its next full deploy.
    "inkyHyperPixel2r": Driver(
        name="inkyHyperPixel2r",
        import_path="inkyHyperPixel2r/inkyHyperPixel2r",
        setup_import_path="inkyHyperPixel2r/inkyHyperPixel2r",
        can_render=True,
        can_turn_on_off=True,
    ),
    # The HyperPixel 4.0 and 4.0 Square, touch or not. On a Pi 0-4 the same
    # split as the Round (firmware DPI + init over GPIO), with an ILI9806E
    # behind it and touch loaded by an overlay the driver's setup installs
    # beside config.txt. On a Pi 5, which has no firmware DPI, setup enables
    # the kernel's vc4-kms-dpi-hyperpixel4* overlay instead and the driver
    # only writes fb0. The board is detected on the device, so nothing here
    # differs. Touch arrives through evdev either way.
    "hyperPixel4": Driver(
        name="hyperPixel4",
        import_path="hyperPixel4/hyperPixel4",
        setup_import_path="hyperPixel4/hyperPixel4",
        can_render=True,
        can_turn_on_off=True,
    ),
    "httpUpload": Driver(
        name="httpUpload",
        import_path="httpUpload/httpUpload",
        can_render=True,
    ),
    "evdev": Driver( # touch and mouse inputs
        name="evdev",
        import_path="evdev/evdev",
        link_flags=("-levdev",),
    ),
    "spi": Driver( # enables spi on deploy
        name="spi",
        setup_import_path="spi/spi",
    ),
    "noSpi": Driver( # disables spi on deploy
        name="noSpi",
        setup_import_path="noSpi/noSpi",
    ),
    "i2c": Driver( # enables i2c on deploy
        name="i2c",
        setup_import_path="i2c/i2c",
    ),
    "bootConfig": Driver( # assures lines in /boot/firmware/config.txt
        name="bootConfig",
        lines=[],
    )
}
