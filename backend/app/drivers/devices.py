from app.models.frame import Frame
from app.drivers.drivers import Driver, DRIVERS
from app.drivers.waveshare import get_variant_keys

def drivers_for_frame(frame: Frame) -> dict[str, Driver]:
    device = frame.device
    device_drivers: dict[str, Driver] = {}
    if device == "pimoroni.inky_impression" or device == "pimoroni.inky_impression_7" or device == "pimoroni.inky_impression_13" or device == "pimoroni.inky_python":
        device_drivers = {
            "inkyPython": DRIVERS["inkyPython"],
            "spi": DRIVERS["spi"],
            "i2c": DRIVERS["i2c"],
        }
        if device == "pimoroni.inky_impression" or device == "pimoroni.inky_impression_7" or device == "pimoroni.inky_impression_13":
            device_drivers["gpioButton"] = DRIVERS["gpioButton"]
        if device == "pimoroni.inky_impression_7" or device == "pimoroni.inky_impression_13":
            device_drivers["inkyPython"].can_png = True
    elif device == "pimoroni.hyperpixel2r":
        device_drivers = {"inkyHyperPixel2r": DRIVERS["inkyHyperPixel2r"]}
    elif device == "framebuffer":
        device_drivers = {"frameBuffer": DRIVERS["frameBuffer"]}
    elif device.startswith("waveshare."):
        waveshare = DRIVERS["waveshare"]
        waveshare.variant = device.split(".")[1]
        # backwards compatibility
        if waveshare.variant == "epd7in5_V2":
            waveshare.variant = "EPD_7in5_V2"
        if waveshare.variant == "epd2in13_V3":
            waveshare.variant = "EPD_2in13_V3"
        if waveshare.variant not in get_variant_keys():
            raise Exception(f"Unknown waveshare driver variant {waveshare.variant}")

        if waveshare.variant in ("EPD_12in48", "EPD_12in48b", "EPD_12in48b_V2", "EPD_13in3e"):
            device_drivers = {"waveshare": waveshare, "noSpi": DRIVERS["noSpi"]}
        else:
            device_drivers = {"waveshare": waveshare, "spi": DRIVERS["spi"]}

        if waveshare.variant == "EPD_10in3":
            device_drivers["bootconfig"] = DRIVERS["bootConfig"]
            device_drivers["bootconfig"].lines = [
                "dtoverlay=spi0-0cs",
                "#dtparam=spi=on"
            ]
        if waveshare.variant == "EPD_13in3e":
            device_drivers["bootconfig"] = DRIVERS["bootConfig"]
            device_drivers["bootconfig"].lines = [
                "gpio=7=op,dl",
                "gpio=8=op,dl",
            ]

    # Always enable evdev if not eink
    if device != "pimoroni.inky_impression" and device != "pimoroni.inky_impression_7" and device != "pimoroni.inky_impression_13" and not device.startswith("waveshare."):
        device_drivers['evdev'] = DRIVERS['evdev']

    if frame.device == "pimoroni.inky_impression" or device == "pimoroni.inky_impression_7" or frame.device == "pimoroni.inky_impression_13":
        if frame.device == "pimoroni.inky_impression_13":
            frame.gpio_buttons = [
                {"pin": 5, "label": "A"},
                {"pin": 6, "label": "B"},
                {"pin": 25, "label": "C"},
                {"pin": 24, "label": "D"},
            ]
        else:
            frame.gpio_buttons = [
                {"pin": 5, "label": "A"},
                {"pin": 6, "label": "B"},
                {"pin": 16, "label": "C"},
                {"pin": 24, "label": "D"},
            ]
        device_drivers["bootconfig"] = DRIVERS["bootConfig"]
        device_drivers["bootconfig"].lines = [
            "dtoverlay=spi0-0cs",
        ]

    if "gpioButton" not in device_drivers and len(frame.gpio_buttons or []) > 0:
        device_drivers["gpioButton"] = DRIVERS["gpioButton"]

    return device_drivers
