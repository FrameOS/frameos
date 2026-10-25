"""The memory a frame renders its scenes in, for a render that should run out
of memory where the frame would (the AI chat's render_scene, docs/ai-chat.md).

An ESP32 that renders on the device renders in its PSRAM, a few megabytes: the
wasm renderer is given that ceiling and runs as an ESP32, so a scene that
would abort on the frame fails in the chat first. Everything else renders
unlimited: a Pi has hundreds of megabytes to spare, and a thin client's scenes
are rendered here, not on the device.

The ceiling is `esp32DeviceLimits` in frameos/wasm/src/devices.ts (and its
frontend copy), ported: keep the three in step. `docs/device-limits-fixtures.json`
pins them to the same numbers.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.models.frame import Frame

# FOS_NIM_EMERGENCY_RESERVE_BYTES: armed at boot, outside the render budget.
ESP32_EMERGENCY_RESERVE_BYTES = 1024 * 1024
# FOS_RENDER_CANVAS_RGBX_MAX_PSRAM_SHARE: a colour e-paper canvas is RGBX only
# while two of it fit the PSRAM heap, RGB565 past that.
ESP32_RGBX_MAX_PSRAM_SHARE = 2
# fos_pixel_format_t: the panel formats a luma canvas serves, and the RGB565
# LCD whose canvas is its own frame buffer.
ESP32_GREY_PIXEL_FORMATS = frozenset({1, 4, 8})
ESP32_PIXEL_RGB565 = 9


def esp32_canvas_bytes_per_pixel(width: int, height: int, psram_bytes: int, pixel_format: int | None = None) -> int:
    """fos_render_canvas_bytes_per_pixel: luma on a grey panel and 565 on an
    RGB565 LCD whatever the PSRAM; RGBX while it fits on any other."""
    if pixel_format in ESP32_GREY_PIXEL_FORMATS:
        return 1
    if pixel_format == ESP32_PIXEL_RGB565:
        return 2
    pixels = max(1, width) * max(1, height)
    if pixels * 4 * ESP32_RGBX_MAX_PSRAM_SHARE <= psram_bytes:
        return 4
    return 2


def esp32_device_limits(width: int, height: int, psram_bytes: int, pixel_format: int | None = None) -> dict:
    """The wasm renderer's ceiling for an ESP32 with this PSRAM at this panel
    size: the device's heap (PSRAM less the panel buffers — an e-paper panel's
    packed 4 bpp buffer, an RGB565 LCD's packed buffer and its two frame
    buffers — and the emergency reserve), plus what the renderer spends on its
    RGBX canvas that a 565- or luma-canvas device does not."""
    pixels = max(1, width) * max(1, height)
    packed_bytes = pixels * 2 * 3 if pixel_format == ESP32_PIXEL_RGB565 else -(-pixels // 2)
    device_heap = max(512 * 1024, psram_bytes - packed_bytes - ESP32_EMERGENCY_RESERVE_BYTES)
    preview_overhead = pixels * 4 - pixels * esp32_canvas_bytes_per_pixel(width, height, psram_bytes, pixel_format)
    return {
        "memoryBytes": device_heap + preview_overhead,
        "memoryReserveBytes": 0,
        "previewOverheadBytes": preview_overhead,
        "embedded": True,
    }


def describe_out_of_memory(refused_bytes: int, used_bytes: int, limits: dict) -> str:
    """describeOutOfMemory in devices.ts: in the device's own bytes."""
    overhead = limits["previewOverheadBytes"]

    def megabytes(value: int) -> str:
        return f"{max(0, value) / (1024 * 1024):.1f} MB"

    return (
        f"Out of memory: an allocation of {megabytes(refused_bytes)} was refused with "
        f"{megabytes(used_bytes - overhead)} of the device's {megabytes(limits['memoryBytes'] - overhead)} in use."
    )


@dataclass(frozen=True)
class RenderDevice:
    label: str
    psram_bytes: int
    # The panel's fos_pixel_format_t, which decides its canvas (luma on a grey
    # panel, 565 on an RGB565 LCD); None when not known.
    pixel_format: int | None = None

    def limits(self, width: int, height: int) -> dict:
        return esp32_device_limits(width, height, self.psram_bytes, self.pixel_format)


def frame_render_device(frame: Frame | None) -> RenderDevice | None:
    if frame is None or (frame.mode or "rpios") != "embedded":
        return None
    from app.tasks.embedded_firmware import (
        EMBEDDED_RENDER_LOCAL,
        embedded_module_psram_bytes,
        embedded_panel_for_frame,
        embedded_pixel_format_for_panel,
        embedded_platform_spec_for_frame,
        embedded_render_mode_for_frame,
    )

    try:
        if embedded_platform_spec_for_frame(frame)["family"] != "esp32":
            return None
        if embedded_render_mode_for_frame(frame) != EMBEDDED_RENDER_LOCAL:
            return None
        psram_bytes = embedded_module_psram_bytes(frame)
        panel = embedded_panel_for_frame(frame)
        pixel_format = None if panel == "none" else embedded_pixel_format_for_panel(panel)
    except ValueError:
        return None
    if psram_bytes <= 0:
        return None
    megabytes = round(psram_bytes / (1024 * 1024), 1)
    return RenderDevice(label=f"ESP32 with {megabytes:g} MB PSRAM", psram_bytes=psram_bytes, pixel_format=pixel_format)
