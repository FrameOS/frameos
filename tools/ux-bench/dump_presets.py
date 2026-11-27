"""Dump every ESP32/Pico hardware preset as the UX harness needs it."""
import json, re, sys
from app.tasks import embedded_firmware as ef
from app.drivers.waveshare import convert_waveshare_source  # noqa
out = {}
for key, p in ef.EMBEDDED_HARDWARE_PRESETS.items():
    device = p.get("device", "")
    panel = ef.EMBEDDED_DEVICE_PANELS.get(device) or device.split(".", 1)[-1]
    fmt = ef.EMBEDDED_PANEL_FORMATS.get(panel)
    w = h = None
    m = re.search(r"(\d+)x(\d+)", panel)
    if m:
        w, h = int(m.group(1)), int(m.group(2))
    else:
        try:
            src = convert_waveshare_source(panel.replace("_BW", ""))
            w, h = src.width, src.height
        except Exception as e:
            pass
    out[key] = {
        "device": device, "panel": panel, "pixelFormat": fmt, "width": w, "height": h,
        "rotate": p.get("rotate", 0), "touch": bool(p.get("touchPins")),
        "mic": ef.embedded_preset_has_microphone(p), "platform": p.get("platform", "esp32-s3"),
        "psramMB": p.get("psramMB"),
        "keys": ef.EMBEDDED_BOARD_KEYS.get(key, []), "gpioButtons": p.get("gpioButtons", []),
        "eventMap": p.get("eventMap", []),
    }
json.dump(out, sys.stdout, indent=1)
