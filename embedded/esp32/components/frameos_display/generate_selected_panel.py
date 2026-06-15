#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


PIXEL_FORMAT_BY_COLOR = {
    "Black": 1,
    "BlackWhiteRed": 2,
    "BlackWhiteYellow": 3,
    "FourGray": 4,
    "BlackWhiteYellowRed": 5,
    "SevenColor": 6,
    "SpectraSixColor": 7,
    "SixteenGray": 8,
}

UNSUPPORTED_PANELS = {
    "EPD_10in3",
    "EPD_12in48",
    "EPD_12in48b",
    "EPD_12in48b_V2",
}

# These variants have native Nim wrappers in the root tree; the ESP32 C display
# component still uses the root C fallback until the hardware DEV_Config layer is
# shared by the Nim driver path too.
SOURCE_OVERRIDES = {
    "EPD_4in01f": ("ePaper/migrated", "EPD_4in01f.c"),
    "EPD_4in0e": ("ePaper/migrated", "EPD_4in0e.c"),
    "EPD_7in3e": ("ePaper/migrated", "EPD_7in3e.c"),
    "EPD_13in3e": ("epd13in3e", "EPD_13in3e.c"),
}


def c_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def cmake_string(value: str) -> str:
    return '"' + value.replace("\\", "/").replace('"', '\\"') + '"'


def c_args(nim_args: str) -> str:
    if not nim_args:
        return ""
    args = []
    for arg in nim_args.split(","):
        value = arg.strip()
        value = re.sub(r"\.(u?int(8|16|32)|cint)$", "", value)
        value = value.replace("nil", "NULL")
        if value == "self":
            raise ValueError("IT8951/self-style init arguments are not supported on ESP32")
        args.append(value)
    return ", ".join(args)


def compile_source_from_nim(nim_path: Path) -> str | None:
    text = nim_path.read_text()
    match = re.search(r'\{\.compile:\s*"([^"]+)"\.\}', text)
    return match.group(1) if match else None


def selected_source(repo_root: Path, key: str, get_variant_folder) -> Path:
    waveshare_root = repo_root / "frameos" / "src" / "drivers" / "waveshare"
    if key in SOURCE_OVERRIDES:
        folder, source = SOURCE_OVERRIDES[key]
        path = waveshare_root / folder / source
        if path.is_file():
            return path
        raise FileNotFoundError(f"Root Waveshare source missing for {key}: {path}")

    folder = get_variant_folder(key)
    source_dir = waveshare_root / folder
    nim_path = source_dir / f"{key}.nim"
    compile_source = compile_source_from_nim(nim_path)
    if compile_source:
        candidates = [source_dir / compile_source, source_dir / "migrated" / compile_source]
    else:
        candidates = [source_dir / f"{key}.c"]
    for path in candidates:
        if path.is_file():
            return path
    raise FileNotFoundError(f"Root Waveshare source missing for {key}: {', '.join(str(p) for p in candidates)}")


def write_none(out_dir: Path) -> None:
    (out_dir / "frameos_selected_panel.c").write_text(
        """#include <stddef.h>
#include <stdint.h>

const char *fos_selected_panel_name(void) { return "none"; }
int fos_selected_panel_width(void) { return 0; }
int fos_selected_panel_height(void) { return 0; }
int fos_selected_panel_format(void) { return 1; }
int fos_selected_panel_requires_cs2(void) { return 0; }
int fos_selected_panel_driver_init(void) { return 0; }
void fos_selected_panel_clear(void) {}
void fos_selected_panel_display(uint8_t *buf) { (void)buf; }
void fos_selected_panel_sleep(void) {}
""")
    (out_dir / "selected_panel.cmake").write_text(
        """set(FRAMEOS_SELECTED_PANEL_SOURCE "")
set(FRAMEOS_SELECTED_PANEL_HEADER "")
set(FRAMEOS_SELECTED_PANEL_SOURCE_BASENAME "")
set(FRAMEOS_SELECTED_PANEL_HEADER_BASENAME "")
""")


def write_panel(repo_root: Path, out_dir: Path, panel: str) -> None:
    sys.path.insert(0, str(repo_root / "backend"))
    from app.drivers.waveshare import convert_waveshare_source, get_variant_folder

    if panel in UNSUPPORTED_PANELS:
        raise ValueError(f"{panel} is not supported by the ESP32 SPI e-paper component")

    variant = convert_waveshare_source(panel)
    if variant.color_option not in PIXEL_FORMAT_BY_COLOR:
        raise ValueError(f"{panel} has unsupported color option {variant.color_option}")
    if not variant.width or not variant.height:
        raise ValueError(f"{panel} is missing dimensions")
    if not variant.init_function or not variant.clear_function or not variant.display_function:
        raise ValueError(f"{panel} is missing init/clear/display metadata")

    source = selected_source(repo_root, panel, get_variant_folder)
    header = source.with_suffix(".h")
    if not header.is_file():
        raise FileNotFoundError(f"Root Waveshare header missing for {panel}: {header}")

    init_args = c_args(variant.init_args)
    clear_args = c_args(variant.clear_args)
    init_call = f"{variant.init_function}({init_args})"
    clear_call = f"{variant.clear_function}({clear_args})"
    if variant.init_returns_zero:
        init_body = f"    return (int){init_call};"
    else:
        init_body = f"    {init_call};\n    return 0;"
    display_args = variant.display_arguments or []
    if display_args in (["Black", "Red"], ["Black", "Yellow"]):
        display_body = f"""    size_t plane = (((size_t){variant.width} + 7u) / 8u) * (size_t){variant.height};
    {variant.display_function}((UBYTE *)buf, (UBYTE *)buf + plane);"""
    else:
        display_body = f"    {variant.display_function}((UBYTE *)buf);"
    sleep_body = f"    {variant.sleep_function}();" if variant.sleep_function else "    /* selected driver has no sleep function */"

    source_text = f"""#include <stddef.h>
#include <stdint.h>

#include "DEV_Config.h"
#include "{header.name}"

const char *fos_selected_panel_name(void) {{ return {c_string(panel)}; }}
int fos_selected_panel_width(void) {{ return {int(variant.width)}; }}
int fos_selected_panel_height(void) {{ return {int(variant.height)}; }}
int fos_selected_panel_format(void) {{ return {PIXEL_FORMAT_BY_COLOR[variant.color_option]}; }}
int fos_selected_panel_requires_cs2(void) {{ return {1 if panel == "EPD_13in3e" else 0}; }}

int fos_selected_panel_driver_init(void)
{{
{init_body}
}}

void fos_selected_panel_clear(void)
{{
    {clear_call};
}}

void fos_selected_panel_display(uint8_t *buf)
{{
{display_body}
}}

void fos_selected_panel_sleep(void)
{{
{sleep_body}
}}
"""
    (out_dir / "frameos_selected_panel.c").write_text(source_text)

    (out_dir / "selected_panel.cmake").write_text(
        "\n".join([
            f"set(FRAMEOS_SELECTED_PANEL_SOURCE {cmake_string(str(source))})",
            f"set(FRAMEOS_SELECTED_PANEL_HEADER {cmake_string(str(header))})",
            f"set(FRAMEOS_SELECTED_PANEL_SOURCE_BASENAME {cmake_string(source.name)})",
            f"set(FRAMEOS_SELECTED_PANEL_HEADER_BASENAME {cmake_string(header.name)})",
            "",
        ])
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--panel", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    panel = args.panel.strip() or "none"

    if panel == "none":
        write_none(out_dir)
    else:
        write_panel(repo_root, out_dir, panel)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
