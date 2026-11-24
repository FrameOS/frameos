from __future__ import annotations

import importlib.util
import re
import shutil
import subprocess
from pathlib import Path

import pytest

# embedded/esp32/components/frameos_display/fold_panel_helpers.py, which the
# display component runs when it copies the vendor panel drivers into the
# build: a static helper several drivers write the same (SendCommand,
# SendData, the resets) calls one shared definition instead, compiled into
# DEV_Config_esp.c. About 6 KB of the firmware (2026-11-24). Checked here on
# small drivers shaped like the vendor's: what folds, what must not, that
# every line keeps its number, and that the drivers make the same calls on
# the bus in the same order before and after.

REPO_ROOT = Path(__file__).resolve().parents[4]
COMPONENT = REPO_ROOT / "embedded" / "esp32" / "components" / "frameos_display"
TOOL = COMPONENT / "fold_panel_helpers.py"

DEV_CONFIG = """\
#include <stdint.h>
#include "Debug.h"
#define UBYTE   uint8_t
#define UWORD   uint16_t
#define UDOUBLE uint32_t
extern int EPD_RST_PIN;
extern int EPD_DC_PIN;
extern int EPD_CS_PIN;
void DEV_Digital_Write(UWORD Pin, UBYTE Value);
void DEV_SPI_WriteByte(UBYTE Value);
void DEV_Delay_ms(UDOUBLE xms);
"""

DEBUG = """\
#include <stdio.h>
#define Debug(__info, ...) printf("debug " __info, ##__VA_ARGS__)
"""

# The same helpers in two drivers under each driver's names (one with its
# parameter called otherwise and its comments elsewhere), a window setter that
# calls them, and helpers that must keep their own code: one reads the
# driver's own data, one reads it under the name of a local it declares
# later, one a pin the driver #defines again.
DRIVER = """\
#include "{name}.h"

static int {upper}_count = 0;
static UBYTE late = {late};

/* send command */
static void {upper}_SendCommand(UBYTE {param})
{{
    DEV_Digital_Write(EPD_DC_PIN, 0);
    DEV_Digital_Write(EPD_CS_PIN, 0);   // select
    DEV_SPI_WriteByte({param});
    DEV_Digital_Write(EPD_CS_PIN, 1);
}}

static void {upper}_SendData(UBYTE Data)
{{
    DEV_Digital_Write(EPD_DC_PIN, 1);
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_WriteByte(Data);
    DEV_Digital_Write(EPD_CS_PIN, 1);
}}

static void {upper}_Reset(void)
{{
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(20);
    DEV_Digital_Write(EPD_RST_PIN, 0);
    Debug("reset\\n");
}}

static void {upper}_SetCursor(UWORD Xstart, UWORD Ystart)
{{
    {upper}_SendCommand(0x4E);
    {upper}_SendData(Xstart & 0xFF);
    {upper}_SendData((Ystart >> 8) & 0xFF);
}}

static void {upper}_Count(void)
{{
    {upper}_count++;
    DEV_SPI_WriteByte({upper}_count);
}}

static void {upper}_Late(void)
{{
    DEV_SPI_WriteByte(late);
    {{ UBYTE late = 5; DEV_SPI_WriteByte(late); }}
}}

void {upper}_Init(void)
{{
    {upper}_Reset();
    {upper}_SendCommand(0x12);
    {upper}_SendData(0x01);
    {upper}_SetCursor(0x1234, 0x5678);
    {upper}_Count();
    {upper}_Count();
    {upper}_Late();
}}
"""

# A driver whose header points EPD_DC_PIN somewhere else: none of its
# helpers that read it may become the shared one.
OTHER = DRIVER.replace('#include "{name}.h"', '#include "{name}.h"\n#define EPD_DC_PIN 7')

FAKE_DEV = """\
#include <stdio.h>
#include "DEV_Config.h"
int EPD_RST_PIN = 1, EPD_DC_PIN = 2, EPD_CS_PIN = 3;
void DEV_Digital_Write(UWORD Pin, UBYTE Value) { printf("pin %u=%u\\n", Pin, Value); }
void DEV_SPI_WriteByte(UBYTE Value) { printf("byte %02x\\n", Value); }
void DEV_Delay_ms(UDOUBLE xms) { printf("wait %u\\n", (unsigned)xms); }
#if __has_include("fos_epd_folded.inc")
#include "fos_epd_folded.inc"
#endif
"""

MAIN = """\
void EPD_A_Init(void); void EPD_B_Init(void); void EPD_C_Init(void);
int main(void) { EPD_A_Init(); EPD_B_Init(); EPD_C_Init(); return 0; }
"""


def load_tool():
    spec = importlib.util.spec_from_file_location("fold_panel_helpers", TOOL)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def write_drivers(root: Path, host_text: str = FAKE_DEV) -> tuple[Path, Path, list[Path], list[str]]:
    include = root / "include"
    include.mkdir()
    (include / "DEV_Config.h").write_text(DEV_CONFIG)
    (include / "Debug.h").write_text(DEBUG)
    vendor = root / "vendor"
    vendor.mkdir()
    sources = []
    for name, template, param, late in (
        ("EPD_a", DRIVER, "Reg", "0x11"),
        ("EPD_b", DRIVER, "Command", "0x22"),
        ("EPD_c", OTHER, "Reg", "0x33"),
    ):
        upper = name.upper()
        (vendor / f"{name}.h").write_text('#include "DEV_Config.h"\n')
        source = vendor / f"{name}.c"
        source.write_text(template.format(name=name, upper=upper, param=param, late=late))
        sources.append(source)
    host = root / "host.c"
    host.write_text(host_text)
    out = root / "out"
    args = ["--include-dir", str(include), "--host", str(host), "--out-dir", str(out), *map(str, sources)]
    return include, vendor, sources, args


def test_the_component_writes_the_drivers_through_the_fold():
    text = (COMPONENT / "CMakeLists.txt").read_text()
    assert "fold_panel_helpers.py" in text
    assert '#include "fos_epd_folded.inc"' in (COMPONENT / "DEV_Config_esp.c").read_text()


def test_what_folds_and_what_keeps_its_own_code(tmp_path: Path):
    include, vendor, sources, args = write_drivers(tmp_path)
    out = tmp_path / "out"
    tool = load_tool()
    assert tool.main(args) == 0
    a, b, c = ((out / f"EPD_{x}.c").read_text() for x in "abc")
    shared = (out / "fos_epd_folded.inc").read_text()

    # SendCommand, SendData, Reset in all three; SetCursor (which calls the
    # first two) in a and b; c's DC-pin readers stay its own.
    for source in (a, b):
        for helper in ("SendCommand", "SendData", "Reset", "SetCursor"):
            assert f"static inline void EPD_{'A' if source is a else 'B'}_{helper}(" in source
    assert "static inline void EPD_C_Reset(void)" in c
    assert "static void EPD_C_SendCommand(UBYTE Reg)" in c and "static void EPD_C_SendData(UBYTE Data)" in c
    assert "static void EPD_C_SetCursor(" in c
    # Reading the driver's own data never folds, nor under a local's name.
    for source, upper in ((a, "EPD_A"), (b, "EPD_B"), (c, "EPD_C")):
        assert f"static void {upper}_Count(void)" in source
        assert f"static void {upper}_Late(void)" in source
    # One definition each, SetCursor's calling the shared two.
    for helper in ("SendCommand", "SendData", "Reset", "SetCursor"):
        assert len(re.findall(rf"^void fos_epd_{helper}_\w+\([^;]*\)\n\{{", shared, re.M)) == 1, helper
    cursor = shared[shared.index("void fos_epd_SetCursor_", shared.index("*/\nvoid fos_epd_SetCursor_")) :]
    assert "fos_epd_SendCommand_" in cursor and "EPD_A_" not in cursor.split("}")[0]
    # Every line keeps its number.
    for path in sources:
        assert (out / path.name).read_text().count("\n") == path.read_text().count("\n")
    # The vendor files are not touched.
    assert "static inline" not in sources[0].read_text()


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
def test_the_drivers_say_the_same_on_the_bus(tmp_path: Path):
    include, vendor, sources, args = write_drivers(tmp_path)
    out = tmp_path / "out"
    load_tool().main(args)

    def build_and_run(source_dir: Path, name: str) -> str:
        build = tmp_path / name
        build.mkdir()
        (build / "dev.c").write_text(FAKE_DEV)
        (build / "main.c").write_text(MAIN)
        units = [build / "dev.c", build / "main.c", *(source_dir / s.name for s in sources)]
        binary = build / "drivers"
        compiled = subprocess.run(
            [
                "cc",
                "-std=gnu17",
                "-Os",
                "-I",
                str(include),
                "-I",
                str(source_dir),
                "-I",
                str(vendor),
                *map(str, units),
                "-o",
                str(binary),
            ],
            capture_output=True,
            text=True,
        )
        assert compiled.returncode == 0, compiled.stderr
        return subprocess.run([str(binary)], capture_output=True, text=True, check=True).stdout

    before = build_and_run(vendor, "before")
    assert before.count("byte 12\n") == 3 and "pin 7=0" in before
    assert "byte 11\nbyte 05\n" in before and "byte 22\nbyte 05\n" in before
    assert build_and_run(out, "after") == before


def test_nothing_the_host_file_defines_again_is_shared(tmp_path: Path):
    # Where the shared definitions are compiled, DEV_Delay_ms is a macro:
    # the resets, which wait, keep their own code; the rest folds.
    host = FAKE_DEV.replace('#include "DEV_Config.h"\n', '#include "DEV_Config.h"\n#define DEV_Delay_ms(x) ((void)0)\n')
    _, _, _, args = write_drivers(tmp_path, host)
    load_tool().main(args)
    a = (tmp_path / "out" / "EPD_a.c").read_text()
    assert "static void EPD_A_Reset(void)" in a
    assert "static inline void EPD_A_SendCommand(UBYTE Reg)" in a
