from __future__ import annotations

import importlib.util
import shutil
import subprocess
from pathlib import Path

import pytest

# embedded/esp32/tools/fold_nim_inlines.py, which build_nim.sh runs over the
# nimcache: Nim's inline helpers, emitted as a private copy into every C file,
# become one external definition plus inline definitions (C99 inline). About
# 30 KB of the firmware (2026-10-18). Checked here on a small nimcache shaped
# like Nim's output: what folds, what must not, and that the result links
# and runs whether or not the compiler inlines.

REPO_ROOT = Path(__file__).resolve().parents[4]
TOOL = REPO_ROOT / "embedded" / "esp32" / "tools" / "fold_nim_inlines.py"
BUILD_NIM = REPO_ROOT / "embedded" / "esp32" / "build_nim.sh"

NIMBASE = """\
#define N_INLINE(rettype, name) inline rettype name
typedef long NI;
"""

# Two temporaries, named after each file's module the way Nim names them.
ADD_TWO = """\
static N_INLINE(NI, addTwo__system_u1)(NI x_p0);
static N_INLINE(NI, addTwo__system_u1)(NI x_p0) {
\tNI result;
\t{
\t\tNI TM__{module}_3;
\t\tNI TM__{module}_4;
\t\tTM__{module}_3 = x_p0 + 1;
\t\tTM__{module}_4 = TM__{module}_3 + 1;
\t\tresult = TM__{module}_4;
\t}
\treturn result;
}
"""

# Reads the module's own data: the same text names different objects.
MODULE_DATA = """\
static const NI TM__{module}_9 = {value};
static N_INLINE(NI, moduleValue__system_u2)(void) {
\treturn TM__{module}_9;
}
"""


def load_tool():
    spec = importlib.util.spec_from_file_location("fold_nim_inlines", TOOL)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def write_nimcache(root: Path) -> Path:
    nimcache = root / "nimcache"
    nimcache.mkdir()
    (nimcache / "nimbase.h").write_text(NIMBASE)
    for index, module in enumerate(["Aaa", "Bbb", "Ccc"]):
        (nimcache / f"m{index}.c").write_text(
            '#include "nimbase.h"\n'
            + ADD_TWO.replace("{module}", module)
            + MODULE_DATA.replace("{module}", module).replace("{value}", str(10 * (index + 1)))
            + f"NI call{index}(NI x) {{ return addTwo__system_u1(x) + moduleValue__system_u2(); }}\n"
        )
    return nimcache


def test_build_nim_runs_the_fold():
    assert TOOL.is_file(), f"missing {TOOL}"
    assert "tools/fold_nim_inlines.py" in BUILD_NIM.read_text()


def test_identical_helpers_fold_to_one_external_definition(tmp_path: Path):
    nimcache = write_nimcache(tmp_path)
    folded, kept = load_tool().fold(nimcache)
    assert (folded, kept) == (1, 1)
    first, second, third = ((nimcache / f"m{index}.c").read_text() for index in range(3))
    # The first file holds the external definition, the others inline ones.
    assert first.count("extern N_INLINE(NI, addTwo__system_u1)") == 2
    for source in (second, third):
        assert "static N_INLINE(NI, addTwo__system_u1)" not in source
        assert source.count("\nN_INLINE(NI, addTwo__system_u1)") == 2
    # Module data: identical text, different objects. Left private everywhere.
    for source in (first, second, third):
        assert "static N_INLINE(NI, moduleValue__system_u2)" in source


def test_a_static_local_is_never_folded(tmp_path: Path):
    nimcache = tmp_path / "nimcache"
    nimcache.mkdir()
    body = "static N_INLINE(NI, counter__x_u1)(void) {\n\tstatic NI n;\n\treturn ++n;\n}\n"
    for name in ("a.c", "b.c"):
        (nimcache / name).write_text(body)
    assert load_tool().fold(nimcache) == (0, 1)
    for name in ("a.c", "b.c"):
        assert (nimcache / name).read_text() == body


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
@pytest.mark.parametrize("optimization", ["-O0", "-O2"])
def test_folded_files_link_and_run(tmp_path: Path, optimization: str):
    """-O0 inlines nothing, so every call goes to the one external copy;
    -O2 inlines them and must still link."""
    nimcache = write_nimcache(tmp_path)
    load_tool().fold(nimcache)
    main = nimcache / "main.c"
    main.write_text(
        '#include <stdio.h>\n#include "nimbase.h"\n'
        "NI call0(NI); NI call1(NI); NI call2(NI);\n"
        'int main(void) { printf("%ld %ld %ld\\n", call0(1), call1(1), call2(1)); return 0; }\n'
    )
    binary = tmp_path / "folded"
    compiled = subprocess.run(
        ["cc", "-std=gnu17", optimization, "-I", str(nimcache), *sorted(map(str, nimcache.glob("*.c"))), "-o", str(binary)],
        capture_output=True,
        text=True,
    )
    assert compiled.returncode == 0, compiled.stderr
    run = subprocess.run([str(binary)], capture_output=True, text=True)
    assert run.stdout == "13 23 33\n"
