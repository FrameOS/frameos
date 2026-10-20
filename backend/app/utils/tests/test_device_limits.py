import json
from pathlib import Path

import pytest

from app.models.frame import Frame
from app.utils.device_limits import describe_out_of_memory, esp32_device_limits, frame_render_device

FIXTURES = json.loads((Path(__file__).resolve().parents[4] / "docs" / "device-limits-fixtures.json").read_text())


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=lambda case: case["name"])
def test_ceiling_matches_the_preview_package(case):
    # The same numbers esp32DeviceLimits gives in frameos/wasm/src/devices.ts
    # (device-limits.test.ts replays this file there).
    limits = esp32_device_limits(case["width"], case["height"], case["psramBytes"])
    assert limits["memoryBytes"] == case["memoryBytes"]
    assert limits["previewOverheadBytes"] == case["previewOverheadBytes"]
    assert limits["memoryReserveBytes"] == 0
    assert limits["embedded"] is True


def test_an_esp32_that_renders_on_the_device_renders_in_its_psram():
    e1004 = Frame(id=1, mode="embedded", width=1200, height=1600, embedded={"hardwarePreset": "seeed_reterminal_e1004"})
    device = frame_render_device(e1004)
    assert device is not None
    assert device.label == "ESP32 with 8 MB PSRAM"
    assert device.limits(1200, 1600)["memoryBytes"] == 10_220_032

    sixteen = Frame(id=2, mode="embedded", embedded={"platform": "esp32-s3", "psramMB": 16})
    assert frame_render_device(sixteen).label == "ESP32 with 16 MB PSRAM"


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
