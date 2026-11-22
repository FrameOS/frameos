import json
from pathlib import Path

import pytest

from app.models.frame import Frame
from app.utils.device_limits import (
    describe_out_of_memory,
    esp32_canvas_is_panel_buffer,
    esp32_canvas_rotation,
    esp32_device_limits,
    esp32_palette_panel_buffer_bytes,
    frame_render_device,
)

FIXTURES = json.loads((Path(__file__).resolve().parents[4] / "docs" / "device-limits-fixtures.json").read_text())


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=lambda case: case["name"])
def test_ceiling_matches_the_preview_package(case):
    # The same numbers esp32DeviceLimits gives in frameos/wasm/src/devices.ts
    # (device-limits.test.ts replays this file there).
    limits = esp32_device_limits(
        case["width"], case["height"], case["psramBytes"], case.get("pixelFormat"), case.get("rotate")
    )
    assert limits["memoryBytes"] == case["memoryBytes"]
    assert limits["previewOverheadBytes"] == case["previewOverheadBytes"]
    assert limits["canvasBytesPerPixel"] == case["canvasBytesPerPixel"]
    assert limits["memoryReserveBytes"] == 0
    assert limits["embedded"] is True


@pytest.mark.parametrize(
    "case", FIXTURES["canvasRotation"]["cases"], ids=lambda case: f"{case['rotate']}@{case['firmwareVersion']}"
)
def test_canvas_rotation_matches_the_preview_package(case):
    assert esp32_canvas_rotation(case["rotate"], case["firmwareVersion"], case.get("pixelFormat")) == case["expected"]


def test_an_e1003_whose_firmware_shares_the_panel_buffer_has_one_buffer_more():
    """Unturned, on firmware that draws in the panel buffer, the E1003 renders
    in 1.31 MB more than one that keeps a canvas and a packed buffer apart:
    a turned one, one on older firmware, one that never said."""
    def e1003(rotate, version):
        embedded = {"hardwarePreset": "seeed_reterminal_e1003"}
        if version:
            embedded["lastBoot"] = {"frameosVersion": version}
        return Frame(id=5, mode="embedded", device="waveshare.EPD_10in3", rotate=rotate, embedded=embedded)

    shared = frame_render_device(e1003(0, "2026.11.6"))
    assert shared is not None and shared.rotate == 0
    assert shared.limits(1872, 1404)["memoryBytes"] == 16_539_040
    for rotate, version in ((90, "2026.11.6"), (0, "2026.11.5"), (0, None)):
        device = frame_render_device(e1003(rotate, version))
        assert device is not None
        assert device.limits(1872, 1404)["memoryBytes"] == 15_224_896, (rotate, version)
    # A rotation the row never set is the device's default, 0.
    assert frame_render_device(e1003(None, "2026.12.0")).rotate == 0
    # The deploy baseline's version when no boot has been heard.
    baseline = Frame(id=6, mode="embedded", device="waveshare.EPD_10in3", rotate=0,
                     embedded={"hardwarePreset": "seeed_reterminal_e1003"},
                     last_successful_deploy={"frameos_version": "2026.11.7"})
    assert frame_render_device(baseline).rotate == 0


def test_a_colour_panel_packs_in_its_canvas_only_where_memory_needs_it():
    """The E1004 (1200x1600 on 8 MB) packs its picture in its 565 canvas and
    charges no panel buffer; the E1002 (800x480 on 8 MB) keeps one of its own,
    so it renders while its panel refreshes, and is charged it."""
    def frame(preset, width, height):
        return Frame(id=7, mode="embedded", width=width, height=height, rotate=0,
                     embedded={"hardwarePreset": preset, "lastBoot": {"frameosVersion": "2026.12.0"}})

    e1004 = frame_render_device(frame("seeed_reterminal_e1004", 1200, 1600))
    assert e1004 is not None and e1004.rotate == 0 and e1004.pixel_format == 7
    assert e1004.limits(1200, 1600)["memoryBytes"] == 11_180_032
    e1002 = frame_render_device(frame("seeed_reterminal_e1002", 800, 480))
    assert e1002 is not None and e1002.rotate == 0 and e1002.pixel_format == 7
    assert e1002.limits(800, 480)["memoryBytes"] == 7_916_032
    # The four colours' buffer is a quarter of a byte a pixel (panel_buffer_size).
    assert esp32_palette_panel_buffer_bytes(800, 480, 5) == 96_000
    assert esp32_palette_panel_buffer_bytes(801, 480, 7) == 192_480
    assert not esp32_canvas_is_panel_buffer(7, 0, 2, 800, 480, 8 * 1024 * 1024)
    assert esp32_canvas_is_panel_buffer(7, 0, 2, 1200, 1600, 8 * 1024 * 1024)
    assert not esp32_canvas_is_panel_buffer(7, 0, 2, 1200, 1600, 16 * 1024 * 1024)
    assert not esp32_canvas_is_panel_buffer(7, 90, 2, 1200, 1600, 8 * 1024 * 1024)
    # The sixteen greys' rule is the size's no matter.
    assert esp32_canvas_is_panel_buffer(8, 0, 0.5, 800, 480, 16 * 1024 * 1024)


def test_an_esp32_that_renders_on_the_device_renders_in_its_psram():
    e1004 = Frame(id=1, mode="embedded", width=1200, height=1600, embedded={"hardwarePreset": "seeed_reterminal_e1004"})
    device = frame_render_device(e1004)
    assert device is not None
    assert device.label == "ESP32 with 8 MB PSRAM"
    assert device.limits(1200, 1600)["memoryBytes"] == 10_220_032

    sixteen = Frame(id=2, mode="embedded", embedded={"platform": "esp32-s3", "psramMB": 16})
    assert frame_render_device(sixteen).label == "ESP32 with 16 MB PSRAM"

    # The E1003's sixteen greys: its canvas is 4-bit, so the frame has 1.3 MB
    # more to render in than a luma canvas would leave it.
    e1003 = Frame(id=3, mode="embedded", device="waveshare.EPD_10in3", embedded={"hardwarePreset": "seeed_reterminal_e1003"})
    device = frame_render_device(e1003)
    assert device is not None and device.pixel_format == 8
    assert device.limits(1872, 1404)["memoryBytes"] == 15_224_896
    assert frame_render_device(e1004).pixel_format == 7

    # The SenseCAP Indicator's LCD: a 565 canvas that is its own frame buffer,
    # one of the three it scans.
    indicator = Frame(id=4, mode="embedded", device="lcd.st7701s_480x480",
                      embedded={"hardwarePreset": "seeed_sensecap_indicator_d1"})
    device = frame_render_device(indicator)
    assert device is not None and device.pixel_format == 9
    assert device.limits(480, 480)["memoryBytes"] == 5_957_632

    # The Sunton 7" 800x480 LCD: the same three-buffer charge, and each frame
    # buffer is 768 KB, so the heap is smaller than the Indicator's.
    sunton = Frame(id=7, mode="embedded", device="lcd.ek9716_800x480",
                   embedded={"hardwarePreset": "sunton_esp32_8048s070"})
    device = frame_render_device(sunton)
    assert device is not None and device.pixel_format == 9
    assert device.label == "ESP32 with 8 MB PSRAM"
    assert device.limits(800, 480)["memoryBytes"] == 5_036_032


def test_frames_that_do_not_render_in_a_few_megabytes_render_unlimited():
    # A Pi, a PSRAM-less thin client (the backend renders it), an S3 told to
    # be a thin client, a virtual frame, and no frame at all.
    assert frame_render_device(Frame(id=1, mode="rpios")) is None
    assert frame_render_device(Frame(id=2, mode="embedded", embedded={"platform": "esp32-c3"})) is None
    assert frame_render_device(Frame(id=3, mode="embedded", embedded={"platform": "esp32-s3", "renderMode": "remote"})) is None
    assert frame_render_device(Frame(id=4, mode="embedded", embedded={"platform": "virtual"})) is None
    assert frame_render_device(None) is None


def test_out_of_memory_reads_in_the_devices_bytes():
    limits = esp32_device_limits(1200, 1600, 8 * 1024 * 1024)
    # What the wasm renderer refused for the E1004 clock scene: a second
    # 1200x1600 RGBX image, with the RGBX preview canvas already in use.
    text = describe_out_of_memory(7_680_004, 8_416_300, limits)
    assert text == "Out of memory: an allocation of 7.3 MB was refused with 4.4 MB of the device's 6.1 MB in use."
