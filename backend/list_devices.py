import json
from gevent import monkey
monkey.patch_all()

from app.drivers.waveshare import get_variant_keys, convert_waveshare_source

if __name__ == '__main__':
    print("[")

    # Web, HDMI and Pimoroni
    list = [
        {"value": 'web_only', "label": 'Web only'},
        {"value": 'framebuffer', "label": 'HDMI / Framebuffer'},
        {"value": 'pimoroni.inky_impression', "label": 'Pimoroni Inky Impression e-ink frames'},
        {"value": 'pimoroni.hyperpixel2r', "label": 'Pimoroni HyperPixel 2.1" Round'},
    ]
    for output in list:
        print(f"    {json.dumps(output)},")

    # Waveshare
    variants = [convert_waveshare_source(key) for key in get_variant_keys()]
    variants = sorted(variants, key=lambda x: (x.size, x.width, x.height, x.code))
    for v in variants:
        color = {
            "Black": "Black/White",
            "BlackWhiteRed": "Black/White/Red",
            "BlackWhiteYellowRed": "Black/White/Yellow/Red (not implemented)",
            "FourGray": "4 Grayscale (not implemented!)",
            "SevenColor": "7 Color (not implemented!)",
        }.get(v.color_option, v.color_option)
        code = "" if v.code == "" else f" ({v.code.upper()})"
        output = {
            "value": f"waveshare.{v.key}",
            "label": f'Waveshare {v.size}"{code} {max(v.width, v.height)}x{min(v.width, v.height)} {color}',
        }
        print(f"    {json.dumps(output)},")

    print("]")
