import json
from app.drivers.waveshare import get_variant_keys, convert_waveshare_source


def print_group(label: str, options: list[dict[str, str]]) -> None:
    print(f"  {{ \"label\": {json.dumps(label)}, \"options\": [")
    for output in options:
        print(f"    {json.dumps(output)},")
    print("  ] },")


if __name__ == '__main__':
    print("[")

    # Web, HDMI and HTTP upload
    generic_devices = [
        {"value": 'web_only', "label": 'Web only'},
        {"value": 'framebuffer', "label": 'HDMI / Framebuffer'},
        {"value": 'http.upload', "label": 'HTTP upload'},
    ]

    # Pimoroni
    pimoroni_devices = [
        {"value": 'pimoroni.inky_impression_4_2025', "label": 'Pimoroni Inky Impression - 4.0" 2025 edition'},
        {"value": 'pimoroni.inky_impression_4_7_color', "label": 'Pimoroni Inky Impression - 4.0" 7-colour'},
        {"value": 'pimoroni.inky_impression_5_7', "label": 'Pimoroni Inky Impression - 5.7" 7-colour'},
        {"value": 'pimoroni.inky_impression_7_3', "label": 'Pimoroni Inky Impression - 7.3" 7-colour'},
        {"value": 'pimoroni.inky_impression_7', "label": 'Pimoroni Inky Impression - 7.3" 2025 edition'},
        {"value": 'pimoroni.inky_impression_13', "label": 'Pimoroni Inky Impression - 13.3" 2025 edition'},
        {"value": 'pimoroni.inky_phat_4', "label": 'Pimoroni Inky pHAT - 2.13" 4-colour'},
        {"value": 'pimoroni.inky_phat_black', "label": 'Pimoroni Inky pHAT - 2.13" black/white'},
        {"value": 'pimoroni.inky_phat_red', "label": 'Pimoroni Inky pHAT - 2.13" black/white/red'},
        {"value": 'pimoroni.inky_phat_red_ht', "label": 'Pimoroni Inky pHAT - 2.13" black/white/red high-temp'},
        {"value": 'pimoroni.inky_phat_yellow', "label": 'Pimoroni Inky pHAT - 2.13" black/white/yellow'},
        {"value": 'pimoroni.inky_phat_ssd1608_black', "label": 'Pimoroni Inky pHAT - 2.13" black/white (SSD1608)'},
        {"value": 'pimoroni.inky_phat_ssd1608_red', "label": 'Pimoroni Inky pHAT - 2.13" black/white/red (SSD1608)'},
        {"value": 'pimoroni.inky_phat_ssd1608_yellow', "label": 'Pimoroni Inky pHAT - 2.13" black/white/yellow (SSD1608)'},
        {"value": 'pimoroni.inky_what_4', "label": 'Pimoroni Inky wHAT - 4.2" 4-colour'},
        {"value": 'pimoroni.inky_what_black', "label": 'Pimoroni Inky wHAT - 4.2" black/white'},
        {"value": 'pimoroni.inky_what_red', "label": 'Pimoroni Inky wHAT - 4.2" black/white/red'},
        {"value": 'pimoroni.inky_what_red_ht', "label": 'Pimoroni Inky wHAT - 4.2" black/white/red high-temp'},
        {"value": 'pimoroni.inky_what_yellow', "label": 'Pimoroni Inky wHAT - 4.2" black/white/yellow'},
        {"value": 'pimoroni.inky_what_ssd1683_black', "label": 'Pimoroni Inky wHAT - 4.2" black/white (SSD1683)'},
        {"value": 'pimoroni.inky_what_ssd1683_red', "label": 'Pimoroni Inky wHAT - 4.2" black/white/red (SSD1683)'},
        {"value": 'pimoroni.inky_what_ssd1683_yellow', "label": 'Pimoroni Inky wHAT - 4.2" black/white/yellow (SSD1683)'},
        {"value": 'pimoroni.inky_impression', "label": 'Pimoroni Inky Impression - all others (Python driver)'},
        {"value": 'pimoroni.inky_python', "label": 'Pimoroni Inky other (Python driver)'},
        {"value": 'pimoroni.hyperpixel2r', "label": 'Pimoroni HyperPixel 2.1" Round'},
        {"value": 'pimoroni.hyperpixel2r_native', "label": 'Pimoroni HyperPixel 2.1" Round (native)'},
    ]

    print_group("Generic", generic_devices)
    print_group("Pimoroni", pimoroni_devices)

    # Waveshare
    waveshare_devices = []
    variants = [convert_waveshare_source(key) for key in get_variant_keys()]
    variants = sorted(variants, key=lambda x: (x.size, x.width, x.height, x.code))
    for v in variants:
        color = {
            "Black": "Black/White",
            "BlackWhiteRed": "Black/White/Red",
            "BlackWhiteYellow": "Black/White/Yellow",
            "BlackWhiteYellowRed": "Black/White/Yellow/Red",
            "FourGray": "4 Grayscale",
            "SixteenGray": "16 Grayscale",
            "SevenColor": "7 Color",
            "SpectraSixColor": "Spectra 6 Color",
        }.get(v.color_option, v.color_option)
        code = "" if v.code == "" else f" ({v.code.upper()})"
        dim = f'{max(v.width or 0, v.height or 0)}x{min(v.width or 0, v.height or 0)}'
        output = {
            "value": f"waveshare.{v.key}",
            "label": f'Waveshare {v.size}"{code} {dim} {color}',
        }
        waveshare_devices.append(output)

    print_group("Waveshare", waveshare_devices)

    print("]")
