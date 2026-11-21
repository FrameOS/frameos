from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

# Runs embedded/esp32/main/tests/test_fos_bus_share.c and reads
# components/frameos_display/DEV_Config_esp.c for the wiring.
#
# On the reTerminal E-series the SD card hangs off the panel's SPI bus, and
# the panel holds the bus for a whole refresh: a card read during a Spectra's
# 30 s waveform waited for all of it (two font pages, 28 s on the E1002). The
# panel now lets the bus go for each wait it sleeps through with every chip
# select high (fos_bus_share.h), and takes it back after.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32_DIR = REPO_ROOT / "embedded" / "esp32"
COMPONENT = ESP32_DIR / "components" / "frameos_display"
HEADER = COMPONENT / "include" / "fos_bus_share.h"
DEV_CONFIG = COMPONENT / "DEV_Config_esp.c"
TEST_SOURCE = ESP32_DIR / "main" / "tests" / "test_fos_bus_share.c"


def _body(text: str, name: str) -> str:
    match = re.search(r"^[A-Za-z][^;{}\n]*\b" + name + r"\([^;{}]*\)\s*\{", text, re.MULTILINE)
    assert match, f"{name} not found"
    depth = 0
    for index in range(match.end() - 1, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[match.end() - 1 : index + 1]
    raise AssertionError(f"{name} has no end")


def test_the_header_is_pure():
    source = HEADER.read_text()
    assert "esp_" not in source and "freertos" not in source


def test_dev_config_wires_the_share_as_the_model_does():
    text = DEV_CONFIG.read_text()
    assert '#include "fos_bus_share.h"' in text
    acquire = _body(text, "DEV_SPI_Acquire")
    assert acquire.index("spi_device_acquire_bus") < acquire.index("fos_bus_share_take")
    release = _body(text, "DEV_SPI_Release")
    assert release.index("fos_bus_share_give") < release.index("spi_device_release_bus")
    write = _body(text, "DEV_Digital_Write")
    for pin, line in (("EPD_CS_PIN", "FOS_BUS_CS_MAIN"), ("EPD_CS_M_PIN", "FOS_BUS_CS_M"),
                      ("EPD_CS_S_PIN", "FOS_BUS_CS_S")):
        assert re.search(rf"Pin == {pin}\) fos_bus_share_select\(&s_share, {line}, Value == 0\)", write), pin
    delay = _body(text, "DEV_Delay_ms")
    # The bus goes only on the header's word, and comes back after the wait.
    assert "fos_bus_share_may_yield(&s_share)" in delay
    assert delay.index("spi_device_release_bus") < delay.index("vTaskDelay") < delay.index("spi_device_acquire_bus")
    init = _body(text, "DEV_Module_Init")
    assert init.index("configure_output(EPD_CS_S_PIN, 1)") < init.index("fos_bus_share_deselect_all")
    share = _body(text, "DEV_SPI_Bus_Share")
    assert "s_share.shared = true" in share


def test_no_panel_driver_writes_its_chip_select_behind_the_tracking():
    """Every chip select the panel drives low goes through DEV_Digital_Write,
    or the bus could go to the card while the panel listens. The bit-banged
    reads in DEV_Config_esp.c set it directly, around microsecond delays that
    never yield."""
    text = DEV_CONFIG.read_text()
    for body_name in ("DEV_SPI_ReadData", "DEV_SPI_ReadData_Cs"):
        if re.search(rf"\b{body_name}\(", text):
            body = _body(text, body_name)
            assert "DEV_Delay_ms" not in body
    for path in COMPONENT.glob("*.c"):
        if path.name == "DEV_Config_esp.c":
            continue
        assert not re.search(r"gpio_set_level\(EPD_CS", path.read_text()), path.name


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_fos_bus_share_host_tests_pass(tmp_path: Path):
    binary = tmp_path / "test_fos_bus_share"
    compile_result = subprocess.run(
        ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-I", str(COMPONENT / "include"),
         str(TEST_SOURCE), "-o", str(binary)],
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert compile_result.returncode == 0, "bus share host tests do not compile:\n" + compile_result.stderr
    run_result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
    assert run_result.returncode == 0, "bus share host tests failed:\n" + run_result.stdout[-4000:]
    summary = re.search(r"(\d+) checks, (\d+) failures", run_result.stdout)
    assert summary is not None, run_result.stdout[-4000:]
    assert int(summary.group(2)) == 0
    assert int(summary.group(1)) >= 20
