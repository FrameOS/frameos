import json
from app.drivers.devices import WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_DEVICE
from app.drivers.waveshare import get_variant_keys, convert_waveshare_source


def print_group(label: str, options: list[dict[str, str]]) -> None:
    print(f"  {{ \"label\": {json.dumps(label)}, \"options\": [")
    for output in options:
        print(f"    {json.dumps(output)},")
    print("  ] },")


def build_groups():
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
        if v.key == "EPD_7in3e":
            waveshare_devices.append({
                "value": WAVESHARE_RPI_ZERO_PHOTOPAINTER_7IN3E_DEVICE,
                "label": 'Waveshare 7.3" RPi Zero PhotoPainter -800x480 Spectra 6 Color',
            })

    return [
        {"label": "Generic", "options": generic_devices},
        {"label": "Pimoroni", "options": pimoroni_devices},
        {"label": "Waveshare", "options": waveshare_devices},
    ]


# Panels the generic ESP32 firmware compiles in. Keep the filter in sync with
# EMBEDDED_UNSUPPORTED_PANELS / EMBEDDED_PANEL_FORMATS in
# app/tasks/embedded_firmware.py and generate_panel_table.py.
ESP32_UNSUPPORTED = {
    "EPD_10in3", "EPD_12in48", "EPD_12in48b", "EPD_12in48b_V2",
    "EPD_7in5_V2_gray", "EPD_4in2b_V2_old", "EPD_7in5b_V2_old",
}


def build_esp32_panels():
    from app.drivers.waveshare import get_variant_folder
    panels = []
    variants = [convert_waveshare_source(key) for key in get_variant_keys()]
    variants = sorted(variants, key=lambda x: (x.size, x.width, x.height, x.code))
    for v in variants:
        if v.key in ESP32_UNSUPPORTED:
            continue
        if not (get_variant_folder(v.key) == "ePaper" or v.key == "EPD_13in3e"):
            continue
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
        dim = f"{max(v.width or 0, v.height or 0)}x{min(v.width or 0, v.height or 0)}"
        panels.append({
            "key": v.key,
            "label": f'Waveshare {v.size}"{code} {dim} {color}',
        })
    return panels


def write_cloud_ts(path: str) -> None:
    from app.drivers.devices import device_dimensions
    groups = []
    for group in build_groups():
        options = []
        for option in group["options"]:
            entry = dict(option)
            dims = device_dimensions(option["value"])
            if dims:
                entry["width"], entry["height"] = dims
            options.append(entry)
        groups.append({"label": group["label"], "options": options})
    lines = [
        "// Generated by `cd backend && python3 list_devices.py --cloud-ts <path>`.",
        "// Do not edit by hand — the backend device registry is the source of truth.",
        "export interface DeviceOption {",
        "  height?: number",
        "  label: string",
        "  value: string",
        "  width?: number",
        "}",
        "",
        "export interface DeviceGroup {",
        "  label: string",
        "  options: DeviceOption[]",
        "}",
        "",
        f"export const piDeviceGroups: DeviceGroup[] = {json.dumps(groups, indent=2)}",
        "",
        "// Panels compiled into the generic ESP32 firmware (runtime `set panel`).",
        f"export const esp32Panels: {{ key: string; label: string }}[] = {json.dumps(build_esp32_panels(), indent=2)}",
        "",
    ]
    with open(path, "w") as handle:
        handle.write("\n".join(lines))


if __name__ == '__main__':
    import sys
    if len(sys.argv) > 2 and sys.argv[1] == "--cloud-ts":
        write_cloud_ts(sys.argv[2])
        sys.exit(0)
    print("[")
    groups = build_groups()
    for group in groups:
        print_group(group["label"], group["options"])
    print("]")
