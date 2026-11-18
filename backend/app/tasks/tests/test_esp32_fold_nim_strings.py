from __future__ import annotations

import importlib.util
import shutil
import subprocess
from pathlib import Path

import pytest

# embedded/esp32/tools/fold_nim_strings.py, which build_nim.sh runs over the
# nimcache: a string literal that several Nim modules hold (each as a private
# constant in its own C file, which the linker cannot merge) becomes one
# external constant, and so does its eight-byte header. About 28 KB of the
# firmware (2026-11-18). Checked here on a small nimcache shaped like Nim's
# output: what folds, what stays, and that the result links and prints what
# it printed before.

REPO_ROOT = Path(__file__).resolve().parents[4]
TOOL = REPO_ROOT / "embedded" / "esp32" / "tools" / "fold_nim_strings.py"
BUILD_NIM = REPO_ROOT / "embedded" / "esp32" / "build_nim.sh"

NIMBASE = """\
typedef long NI;
typedef char NIM_CHAR;
#define NIM_STRLIT_FLAG ((NI)1 << (sizeof(NI) * 8 - 2))
typedef struct { NI cap; NIM_CHAR data[]; } NimStrPayload;
typedef struct { NI len; NimStrPayload* p; } NimStringV2;
"""


def literal(module: str, index: int, text: str, c_text: str | None = None) -> str:
    """A string constant and its header, as Nim writes them."""
    c_text = c_text if c_text is not None else f'"{text}"'
    return (
        "static const struct {\n"
        f"  NI cap; NIM_CHAR data[{len(text)}+1];\n"
        f"}} TM__{module}_{index} = {{ {len(text)} | NIM_STRLIT_FLAG, {c_text} }};\n"
        f"static const NimStringV2 TM__{module}_{index + 1} = "
        f"{{{len(text)}, (NimStrPayload*)&TM__{module}_{index}}};\n"
    )


def load_tool():
    spec = importlib.util.spec_from_file_location("fold_nim_strings", TOOL)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


# Three modules. "event" is in all of them; a long text Nim broke over two
# lines is in two; each has a text of its own; and the second holds a text
# with no header (a string only ever used through its payload).
LONG = "a line\\012" + "x" * 40
LONG_C = '"a line\\012"\n"' + "x" * 40 + '"'
LONG_LEN = len("a line\n") + 40


def long_literal(module: str, index: int) -> str:
    return (
        "static const struct {\n"
        f"  NI cap; NIM_CHAR data[{LONG_LEN}+1];\n"
        f"}} TM__{module}_{index} = {{ {LONG_LEN} | NIM_STRLIT_FLAG, {LONG_C} }};\n"
        f"static const NimStringV2 TM__{module}_{index + 1} = "
        f"{{{LONG_LEN}, (NimStrPayload*)&TM__{module}_{index}}};\n"
    )


def write_nimcache(root: Path) -> Path:
    nimcache = root / "nimcache"
    nimcache.mkdir()
    (nimcache / "nimbase.h").write_text(NIMBASE)
    modules = {
        "m0.c": literal("Aaa", 2, "event") + literal("Aaa", 4, "only in a") + long_literal("Aaa", 6),
        "m1.c": literal("Bbb", 7, "only in b")
        + literal("Bbb", 2, "event")
        + "static const struct {\n  NI cap; NIM_CHAR data[4+1];\n} TM__Bbb_9 = { 4 | NIM_STRLIT_FLAG, \"bare\" };\n",
        "m2.c": long_literal("Ccc", 2) + literal("Ccc", 4, "event") + literal("Ccc", 6, "only in c"),
    }
    for index, (name, constants) in enumerate(modules.items()):
        module = constants.split("TM__")[1].split("_")[0]
        (nimcache / name).write_text(
            '#include "nimbase.h"\n'
            + constants
            # By header, by payload address, and an array of headers by value
            # of their fields, the three ways the generated C reaches a text.
            + f"const NimStringV2* event{index}(void) {{ return &TM__{module}_{3 if name == 'm0.c' or name == 'm1.c' else 5}; }}\n"
            + f"const char* own{index}(void) {{ return ((const NimStrPayload*)&TM__{module}_{ {'m0.c': 4, 'm1.c': 7, 'm2.c': 6}[name] })->data; }}\n"
        )
    return nimcache


def test_build_nim_runs_the_fold():
    assert TOOL.is_file(), f"missing {TOOL}"
    assert "tools/fold_nim_strings.py" in BUILD_NIM.read_text()


def test_a_text_several_modules_hold_becomes_one_constant(tmp_path: Path):
    nimcache = write_nimcache(tmp_path)
    tool = load_tool()
    texts, headers = tool.fold(nimcache)
    # "event" and the long text; their two headers.
    assert (texts, headers) == (2, 2)
    first, second, third = ((nimcache / f"m{index}.c").read_text() for index in range(3))

    event = tool.shared_name("fosStr", "5", '"event"')
    # Defined once, in the first file that holds it; declared in the others.
    assert f"\nconst struct {{\n  NI cap; NIM_CHAR data[5+1];\n}} {event} = {{ 5 | NIM_STRLIT_FLAG, \"event\" }};\n" in first
    for source in (second, third):
        assert f"\nextern const struct {{\n  NI cap; NIM_CHAR data[5+1];\n}} {event};\n" in source
        assert f"{event} = " not in source
    # Each file's own name is an alias, so the rest of the file is as it was.
    assert f"#define TM__Aaa_2 {event}\n" in first
    assert f"#define TM__Bbb_2 {event}\n" in second
    assert f"#define TM__Ccc_4 {event}\n" in third

    header = tool.shared_name("fosStrV", "5", event)
    assert f"\nconst NimStringV2 {header} = {{5, (NimStrPayload*)&{event}}};\n#define TM__Aaa_3 {header}\n" in first
    assert f"\nextern const NimStringV2 {header};\n#define TM__Bbb_3 {header}\n" in second
    assert f"\nextern const NimStringV2 {header};\n#define TM__Ccc_5 {header}\n" in third

    # A text broken over two lines keeps both pieces, in the first file that had it.
    assert LONG_C + " };" in first and LONG_C not in third
    # What only one module holds is untouched, header and all.
    assert literal("Aaa", 4, "only in a") in first
    assert literal("Bbb", 7, "only in b") in second
    assert 'TM__Bbb_9 = { 4 | NIM_STRLIT_FLAG, "bare" };' in second
    assert literal("Ccc", 6, "only in c") in third

    # Running it again finds nothing left to share.
    before = [first, second, third]
    assert tool.fold(nimcache) == (0, 0)
    assert [(nimcache / f"m{index}.c").read_text() for index in range(3)] == before


def test_the_same_text_at_two_lengths_is_two_constants(tmp_path: Path):
    # "ab" with its NUL and "ab\0" declared one longer are different objects.
    nimcache = tmp_path / "nimcache"
    nimcache.mkdir()
    for name, module in (("a.c", "Aaa"), ("b.c", "Bbb")):
        (nimcache / name).write_text(literal(module, 2, "ab") + literal(module, 4, "abc", '"ab"'))
    tool = load_tool()
    assert tool.fold(nimcache) == (2, 2)
    source = (nimcache / "a.c").read_text()
    assert tool.shared_name("fosStr", "2", '"ab"') in source
    assert tool.shared_name("fosStr", "3", '"ab"') in source


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
@pytest.mark.parametrize("optimization", ["-O0", "-O2"])
def test_folded_files_link_and_say_the_same(tmp_path: Path, optimization: str):
    nimcache = write_nimcache(tmp_path)
    main = (
        '#include <stdio.h>\n#include "nimbase.h"\n'
        "const NimStringV2* event0(void); const NimStringV2* event1(void); const NimStringV2* event2(void);\n"
        "const char* own0(void); const char* own1(void); const char* own2(void);\n"
        "int main(void) {\n"
        '  printf("%s %s %s %ld|", event0()->p->data, event1()->p->data, event2()->p->data, event2()->len);\n'
        '  printf("%s|%s|%s|", own0(), own1(), own2());\n'
        '  printf("%d\\n", (event0() == event1()) + (event1() == event2()) + (event0()->p == event2()->p));\n'
        "  return 0;\n}\n"
    )

    def build_and_run(name: str) -> str:
        (nimcache / "main.c").write_text(main)
        binary = tmp_path / name
        compiled = subprocess.run(
            ["cc", "-std=gnu17", optimization, "-I", str(nimcache), *sorted(map(str, nimcache.glob("*.c"))), "-o", str(binary)],
            capture_output=True,
            text=True,
        )
        assert compiled.returncode == 0, compiled.stderr
        return subprocess.run([str(binary)], capture_output=True, text=True).stdout

    before = build_and_run("before")
    assert before == "event event event 5|only in a|only in b|only in c|0\n"
    load_tool().fold(nimcache)
    # The same text everywhere, and now the same object: one header, one payload.
    assert build_and_run("after") == "event event event 5|only in a|only in b|only in c|3\n"
