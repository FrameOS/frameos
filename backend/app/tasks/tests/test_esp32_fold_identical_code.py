from __future__ import annotations

import importlib.util
import shutil
import subprocess
from pathlib import Path

import pytest

# embedded/esp32/tools/fold_identical_code.py, which the frameos_nim component
# runs over its archive once it is made: functions the Nim objects hold more
# than once (hooks of types with the same shape, generics made again per
# module) are renamed to one name and made weak, so the link keeps one copy.
# About 20 KB of the firmware (2026-11-24). Checked here with the host's
# compiler and binutils (the rules are the same for x86-64 objects): what
# folds, what must not, and that a program linked from the folded archive
# does what it did.

REPO_ROOT = Path(__file__).resolve().parents[4]
TOOL = REPO_ROOT / "embedded" / "esp32" / "tools" / "fold_identical_code.py"
COMPONENT = REPO_ROOT / "embedded" / "esp32" / "components" / "frameos_nim" / "CMakeLists.txt"

HIDDEN = '__attribute__((visibility("hidden")))'

# Three modules shaped like Nim's: hidden procs named after their module,
# identical code under different names, a hook whose address a type
# descriptor holds, a callback whose address a table holds, and procs that
# read their own module's data.
MODULES = {
    "@m..@sfirst.nim.c": f"""
extern int counter;
static int own = 10;
{HIDDEN} int eqdestroy___first_u1(int* p) {{ counter += *p; return *p * 3 + 1; }}
{HIDDEN} int eqdestroy___first_u2(int* p) {{ counter += *p; return *p * 3 + 1; }}
{HIDDEN} int add__first_u3(int x) {{ return eqdestroy___first_u1(&x) + 7; }}
{HIDDEN} int callback__first_u4(int x) {{ return x * 5 - 2; }}
{HIDDEN} int ownData__first_u5(void) {{ return own; }}
int exported_twin(int x) {{ return x * 11; }}
struct TNimTypeV2 {{ void* destructor; int size; }};
__attribute__((section(".data.NTIv2__first_"))) struct TNimTypeV2 NTIv2__first_ = {{ (void*)eqdestroy___first_u2, 4 }};
int (*table_first[])(int) = {{ callback__first_u4 }};
int first(int x) {{ return eqdestroy___first_u2(&x) + add__first_u3(x) + ownData__first_u5() + table_first[0](x); }}
""",
    "@m..@ssecond.nim.c": f"""
extern int counter;
extern int (*table_first[])(int);
static int own = 20;
{HIDDEN} int eqdestroy___second_u1(int* p) {{ counter += *p; return *p * 3 + 1; }}
{HIDDEN} int add__second_u3(int x) {{ return eqdestroy___second_u1(&x) + 7; }}
{HIDDEN} int callback__second_u4(int x) {{ return x * 5 - 2; }}
{HIDDEN} int ownData__second_u5(void) {{ return own; }}
int exported_twin2(int x) {{ return x * 11; }}
int (*table_second[])(int) = {{ callback__second_u4 }};
int second(int x) {{ return add__second_u3(x) + ownData__second_u5() + table_second[0](x) + exported_twin2(x); }}
int same_callbacks(void) {{ return table_first[0] == table_second[0]; }}
""",
    "@m..@shot.nim.c": f"""
extern int counter;
{HIDDEN} int eqdestroy___hot_u1(int* p) {{ counter += *p; return *p * 3 + 1; }}
int hot(int x) {{ return eqdestroy___hot_u1(&x); }}
""",
}

MAIN = """
#include <stdio.h>
int counter;
int first(int); int second(int); int hot(int); int same_callbacks(void); int exported_twin(int);
int main(void) {
    printf("%d %d %d %d %d %d\\n", first(2), second(3), hot(4), counter, same_callbacks(), exported_twin(1));
    return 0;
}
"""

TOOLS = ("cc", "ar", "objcopy", "nm")


def load_tool():
    spec = importlib.util.spec_from_file_location("fold_identical_code", TOOL)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def build_archive(root: Path) -> Path:
    objects = []
    for name, source in MODULES.items():
        path = root / name
        path.write_text(source)
        obj = root / f"{name}.o"
        # No inlining and no GCC folding of its own, so the copies are there
        # to be found, each in a section of its own as on the ESP32.
        compiled = subprocess.run(
            [
                "cc",
                "-O1",
                "-fno-inline",
                "-fno-ipa-icf",
                "-ffunction-sections",
                "-fdata-sections",
                "-c",
                str(path),
                "-o",
                str(obj),
            ],
            capture_output=True,
            text=True,
        )
        assert compiled.returncode == 0, compiled.stderr
        objects.append(obj)
    archive = root / "libnim.a"
    subprocess.run(["ar", "qc", str(archive), *map(str, objects)], check=True)
    return archive


def link_and_run(root: Path, archive: Path, name: str) -> tuple[str, str]:
    main = root / "main.c"
    main.write_text(MAIN)
    binary = root / name
    linked = subprocess.run(
        [
            "cc",
            "-O1",
            str(main),
            "-Wl,--whole-archive",
            str(archive),
            "-Wl,--no-whole-archive",
            "-Wl,--gc-sections",
            "-o",
            str(binary),
        ],
        capture_output=True,
        text=True,
    )
    assert linked.returncode == 0, linked.stderr
    symbols = subprocess.run(["nm", str(binary)], capture_output=True, text=True, check=True).stdout
    return subprocess.run([str(binary)], capture_output=True, text=True, check=True).stdout, symbols


def test_the_component_runs_the_fold():
    assert TOOL.is_file(), f"missing {TOOL}"
    text = COMPONENT.read_text()
    assert "tools/fold_identical_code.py" in text
    # The hot modules keep their own copies.
    assert '"--keep=${hot}"' in text


@pytest.mark.skipif(any(shutil.which(tool) is None for tool in TOOLS), reason="no host C toolchain")
def test_what_folds_and_what_keeps_its_own_copy(tmp_path: Path):
    archive = build_archive(tmp_path)
    tool = load_tool()
    groups, _, _ = tool.plan(tool.read_archive(archive.read_bytes()), keep=["@shot.nim.c"])
    by_first = {group[0]: group for group in groups}
    # The hook: three copies, one a type descriptor holds (that address is
    # only ever called). The hot module's copy is not among them.
    assert by_first["eqdestroy___first_u1"] == ["eqdestroy___first_u1", "eqdestroy___first_u2", "eqdestroy___second_u1"]
    # Calls to copies of one function are the same call.
    assert by_first["add__first_u3"] == ["add__first_u3", "add__second_u3"]
    # Two callbacks in tables: their addresses can be compared, so not.
    # Two readers of their own module's data, and two C functions the rest
    # of the firmware may call by name: not either.
    assert len(groups) == 2


@pytest.mark.skipif(any(shutil.which(tool) is None for tool in TOOLS), reason="no host C toolchain")
def test_a_folded_archive_links_and_does_the_same(tmp_path: Path):
    archive = build_archive(tmp_path)
    before, symbols_before = link_and_run(tmp_path, archive, "before")
    tool = load_tool()
    groups, folded, _ = tool.fold(archive, "objcopy", "ar", keep=["@shot.nim.c"])
    assert (groups, folded) == (2, 3)
    after, symbols_after = link_and_run(tmp_path, archive, "after")
    assert after == before
    # The callbacks' addresses still differ.
    assert after.split()[4] == "0"
    for gone in ("eqdestroy___first_u2", "eqdestroy___second_u1", "add__second_u3"):
        assert gone in symbols_before and gone not in symbols_after
    for kept in (
        "eqdestroy___first_u1",
        "eqdestroy___hot_u1",
        "callback__first_u4",
        "callback__second_u4",
        "exported_twin",
        "exported_twin2",
    ):
        assert kept in symbols_after
    # Folding the folded archive again changes nothing.
    assert tool.fold(archive, "objcopy", "ar", keep=["@shot.nim.c"])[1] == 0
