from __future__ import annotations

import re
from pathlib import Path

# Reads embedded/esp32/main/fos_veneers.h, main/CMakeLists.txt and main/*.c.
#
# The firmware's calls to ROM and IRAM go through veneers in flash
# (fos_veneers.h, forced into main's C by main/CMakeLists.txt): a CALL8 to
# `l32r a9, <target>; jx a9` where a call was an L32R and a CALLX8. A veneer
# is flash code, so a file with IRAM code (an interrupt handler that runs
# while a flash write has the cache off) must not be given the header: one
# memset from such a handler would fault only while the flash is busy.

REPO_ROOT = Path(__file__).resolve().parents[4]
MAIN = REPO_ROOT / "embedded" / "esp32" / "main"
HEADER = MAIN / "fos_veneers.h"
CMAKE = MAIN / "CMakeLists.txt"
VENEERS = MAIN / "fos_printf.c"


def _excluded() -> set[str]:
    text = CMAKE.read_text()
    match = re.search(r'list\(FILTER fos_veneered_srcs EXCLUDE REGEX "[^"]*\(([^)"]*)\)', text)
    assert match, "main/CMakeLists.txt no longer leaves the IRAM files out of the veneers"
    return {f"{name}.c" for name in match.group(1).split("|")}


def test_every_file_with_iram_code_is_left_out():
    with_iram = {path.name for path in MAIN.glob("*.c") if "IRAM_ATTR" in path.read_text()}
    excluded = _excluded()
    assert with_iram - excluded == set(), (
        "these call flash veneers from IRAM code; add them to the EXCLUDE REGEX in main/CMakeLists.txt"
    )
    # And nothing is left out that no longer needs to be.
    assert excluded - with_iram == set()


def test_the_components_give_it_only_to_files_without_iram_code():
    components = REPO_ROOT / "embedded" / "esp32" / "components"
    given = {}
    for name in ("frameos_display", "frameos_nim"):
        text = (components / name / "CMakeLists.txt").read_text()
        match = re.search(r'set_property\(SOURCE ((?:"[^"]+"\s*)+)\s*APPEND PROPERTY COMPILE_OPTIONS "-include" '
                          r'"\$\{CMAKE_CURRENT_LIST_DIR\}/\.\./\.\./main/fos_veneers\.h"\)', text)
        assert match, f"{name}/CMakeLists.txt no longer names its veneered files"
        given[name] = re.findall(r'"([^"]+)"', match.group(1))
    assert given["frameos_display"] and given["frameos_nim"]
    for name, files in given.items():
        for file in files:
            source = (components / name / file).read_text()
            assert "IRAM_ATTR" not in source and "ESP_INTR_FLAG_IRAM" not in source, f"{name}/{file}"
    # The raster loops' helper on the other core keeps its direct calls.
    assert "fos_rows.c" not in given["frameos_nim"]


def test_the_header_is_forced_into_main_on_xtensa_only():
    text = CMAKE.read_text()
    block = text[text.index("if(CONFIG_IDF_TARGET_ARCH_XTENSA)\n    get_target_property(fos_veneered_srcs"):]
    block = block[: block.index("endif()")]
    assert "-include;${CMAKE_CURRENT_LIST_DIR}/fos_veneers.h" in block
    source = HEADER.read_text()
    assert "#if defined(__XTENSA__)" in source


def test_every_renamed_function_has_a_veneer_and_back():
    source = HEADER.read_text()
    listed = set(re.findall(r"^\s+X\((\w+)\)\s*\\?$", source, re.MULTILINE))
    renamed = dict(re.findall(r"^#define (\w+) (fos_v_\w+)$", source, re.MULTILINE))
    assert listed, "FOS_VENEER_IDF is empty"
    assert set(renamed) == listed
    for name, veneer in renamed.items():
        assert veneer == f"fos_v_{name}"
    libc = re.findall(r"^\s+X\([^,]+, (\w+), \(", source, re.MULTILINE)
    assert "strcmp" in libc and "memset" in libc
    assert not set(libc) & listed


def test_the_veneers_are_emitted_where_the_shell_can_reach_them():
    text = VENEERS.read_text()
    assert '#include "fos_veneers.h"' in text
    assert "FOS_VENEER_LIBC(FOS_VENEER_ASM_LIBC)" in text
    assert "FOS_VENEER_IDF(FOS_VENEER_ASM)" in text
    # a9 is the one register free between a CALL8 and the callee's ENTRY.
    assert '"l32r a9, .Lfos_v_" #name' in text and '"jx a9\\n"' in text
    # The host object must stay among the shell's in the link order, or a
    # CALL8 cannot reach it.
    order = (REPO_ROOT / "embedded" / "esp32" / "link_order.txt").read_text()
    assert re.search(r"^libmain\.a fos_printf\.c\.obj$", order, re.MULTILINE)
