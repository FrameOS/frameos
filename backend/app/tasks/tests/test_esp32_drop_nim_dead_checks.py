from __future__ import annotations

import importlib.util
import shutil
import subprocess
from pathlib import Path

import pytest

# embedded/esp32/tools/drop_nim_dead_checks.py, which build_nim.sh runs over
# the nimcache: the error check Nim writes after a call goes where the callee
# provably cannot set the error flag (nothing it reaches raises, makes an
# indirect call or calls C that could run Nim), and the flag cannot be pending
# from an earlier call Nim wrote no check after. About 22 KB of the firmware
# (2026-11-24). Checked here on a small nimcache shaped like Nim's output.

REPO_ROOT = Path(__file__).resolve().parents[4]
TOOL = REPO_ROOT / "embedded" / "esp32" / "tools" / "drop_nim_dead_checks.py"
BUILD_NIM = REPO_ROOT / "embedded" / "esp32" / "build_nim.sh"

NIMBASE = """\
typedef long NI;
typedef unsigned char NIM_BOOL;
#define NIM_TRUE 1
#define NIM_FALSE 0
#define NIM_NIL 0
#define NIM_UNLIKELY(x) __builtin_expect(x, 0)
#define N_NIMCALL(rettype, name) rettype name
#define N_INLINE(rettype, name) static inline rettype name
#define N_LIB_PRIVATE
extern NIM_BOOL nimInErrorMode__system_u1;
static inline NIM_BOOL* nimErrorFlag(void) { return &nimInErrorMode__system_u1; }
"""

# The runtime: raiseExceptionAux sets the flag; a raise goes through it.
SYSTEM = """\
#include "nimbase.h"
#include <stdlib.h>
NIM_BOOL nimInErrorMode__system_u1;
N_LIB_PRIVATE N_NIMCALL(void, raiseExceptionAux__system_u2)(void* e_p0) {
\tnimInErrorMode__system_u1 += ((NI)1);
}
N_LIB_PRIVATE N_NIMCALL(void, raiseOverflow)(void) {
\traiseExceptionAux__system_u2(NIM_NIL);
}
N_LIB_PRIVATE N_NIMCALL(void, dealloc)(void* p_p0) {
\tfree(p_p0);
}
"""

# A module: a destroy that only frees (clean), a destroy that calls itself
# (clean: recursion is no raise), a proc that may raise (dirty), a proc that
# calls C nothing proves (dirty), and the callers.
MODULE = """\
#include "nimbase.h"
#include <stdio.h>
#include <stdlib.h>
N_LIB_PRIVATE N_NIMCALL(void, raiseOverflow)(void);
N_LIB_PRIVATE N_NIMCALL(void, dealloc)(void* p_p0);
extern void opaque(void);
typedef struct Node { struct Node* next; } Node;
N_LIB_PRIVATE N_NIMCALL(void, eqdestroy___m_u1)(Node* dest_p0) {
\tif (dest_p0 == NIM_NIL) return;
\teqdestroy___m_u1(dest_p0->next);
\tdealloc(dest_p0);
}
N_LIB_PRIVATE N_NIMCALL(NI, mayRaise__m_u2)(NI x_p0) {
\tif (x_p0 > 100) { raiseOverflow(); return 0; }
\treturn x_p0 + 1;
}
N_LIB_PRIVATE N_NIMCALL(void, callsC__m_u3)(void) {
\topaque();
}
N_LIB_PRIVATE N_NIMCALL(NI, straight__m_u4)(Node* a_p0, NI x_p1) {
\tNI result;
NIM_BOOL* nimErr_;
{nimErr_ = nimErrorFlag();
\tresult = mayRaise__m_u2(x_p1);
\tif (NIM_UNLIKELY(*nimErr_)) goto BeforeRet_;
\teqdestroy___m_u1(a_p0);
\tif (NIM_UNLIKELY(*nimErr_)) goto BeforeRet_;
\tresult = mayRaise__m_u2(result);
\tif (NIM_UNLIKELY(*nimErr_)) goto BeforeRet_;
\t}BeforeRet_: ;
\treturn result;
}
N_LIB_PRIVATE N_NIMCALL(NI, pending__m_u5)(Node* a_p0) {
\tNI result;
NIM_BOOL* nimErr_;
{nimErr_ = nimErrorFlag();
\tresult = 0;
\tcallsC__m_u3();
\teqdestroy___m_u1(a_p0);
\tif (NIM_UNLIKELY(*nimErr_)) goto BeforeRet_;
\tresult = 1;
\t}BeforeRet_: ;
\treturn result;
}
N_LIB_PRIVATE N_NIMCALL(NI, joined__m_u6)(Node* a_p0, NI x_p1) {
\tNI result;
NIM_BOOL* nimErr_;
{nimErr_ = nimErrorFlag();
\tresult = 0;
\tif (!(x_p1 > 0)) goto LA2_;
\tcallsC__m_u3();
LA2_: ;
\teqdestroy___m_u1(a_p0);
\tif (NIM_UNLIKELY(*nimErr_)) goto BeforeRet_;
\tresult = 2;
\t}BeforeRet_: ;
\treturn result;
}
N_LIB_PRIVATE N_NIMCALL(NI, quietJoin__m_u7)(Node* a_p0, NI x_p1) {
\tNI result;
NIM_BOOL* nimErr_;
{nimErr_ = nimErrorFlag();
\tresult = 0;
\tif (!(x_p1 > 0)) goto LA2_;
\tresult = mayRaise__m_u2(x_p1);
\tif (NIM_UNLIKELY(*nimErr_)) goto LA1_;
LA2_: ;
\teqdestroy___m_u1(a_p0);
\tif (NIM_UNLIKELY(*nimErr_)) goto BeforeRet_;
\tresult = result + 3;
\t{
\t\tLA1_:;
\t}
\t{
\t\tNode* b = NIM_NIL;
\t\teqdestroy___m_u1(b);
\t\tif (NIM_UNLIKELY(*nimErr_)) goto BeforeRet_;
\t\tresult = result + 4;
\t}
\t}BeforeRet_: ;
\treturn result;
}
"""

CALLS_C = """\
#include "nimbase.h"
void opaque(void) {}
"""


def load_tool():
    spec = importlib.util.spec_from_file_location("drop_nim_dead_checks", TOOL)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def write_nimcache(root: Path) -> Path:
    nimcache = root / "nimcache"
    nimcache.mkdir()
    (nimcache / "nimbase.h").write_text(NIMBASE)
    (nimcache / "system.c").write_text(SYSTEM)
    (nimcache / "m.c").write_text(MODULE)
    return nimcache


def checks_after(source: str, callee_line: str) -> list[bool]:
    """For each occurrence of `callee_line`, whether a check follows it."""
    lines = source.split("\n")
    return [
        "NIM_UNLIKELY(*nimErr_)" in lines[i + 1]
        for i, line in enumerate(lines)
        if line.strip() == callee_line
    ]


def test_build_nim_runs_the_pass():
    assert TOOL.is_file(), f"missing {TOOL}"
    assert "tools/drop_nim_dead_checks.py" in BUILD_NIM.read_text()


def test_what_cannot_raise_is_found(tmp_path: Path):
    nimcache = write_nimcache(tmp_path)
    tool = load_tool()
    files = {path: path.read_text().split("\n") for path in sorted(nimcache.glob("*.c"))}
    clean = tool.clean_functions(files)
    # Frees, and calls itself: clean. Reaches a raise, or C: dirty.
    assert "eqdestroy___m_u1" in clean and "dealloc" in clean
    assert "mayRaise__m_u2" not in clean and "raiseOverflow" not in clean
    assert "callsC__m_u3" not in clean
    assert "straight__m_u4" not in clean


def test_only_dead_checks_go(tmp_path: Path):
    nimcache = write_nimcache(tmp_path)
    dropped = load_tool().drop(nimcache)
    source = (nimcache / "m.c").read_text()
    body = lambda name: source.split(name + ")(")[1].split("\nN_LIB_PRIVATE")[0]  # noqa: E731
    # After the clean destroy, between two checks: gone. After a call that may
    # raise: kept.
    straight = body("straight__m_u4")
    assert checks_after(straight, "eqdestroy___m_u1(a_p0);") == [False]
    assert checks_after(straight, "result = mayRaise__m_u2(x_p1);") == [True]
    assert checks_after(straight, "result = mayRaise__m_u2(result);") == [True]
    # A call Nim writes no check after came first: the flag may be pending, and
    # the check after the destroy is the one that sees it.
    assert checks_after(body("pending__m_u5"), "eqdestroy___m_u1(a_p0);") == [True]
    # Joined by a path that passed such a call: kept.
    assert checks_after(body("joined__m_u6"), "eqdestroy___m_u1(a_p0);") == [True]
    # Joined only by paths through checks: gone; after the error label (the
    # flag is set there): kept.
    quiet = body("quietJoin__m_u7")
    assert checks_after(quiet, "eqdestroy___m_u1(a_p0);") == [False]
    assert checks_after(quiet, "eqdestroy___m_u1(b);") == [True]
    assert sum(dropped.values()) == 2
    # Nothing left to drop the second time.
    assert sum(load_tool().drop(nimcache).values()) == 0


@pytest.mark.skipif(shutil.which("cc") is None, reason="no C compiler on PATH")
@pytest.mark.parametrize("optimization", ["-O0", "-O2"])
def test_the_program_does_what_it_did(tmp_path: Path, optimization: str):
    nimcache = write_nimcache(tmp_path)
    (nimcache / "c.c").write_text(CALLS_C)
    main = (
        '#include <stdio.h>\n#include <stdlib.h>\n#include "nimbase.h"\n'
        "typedef struct Node { struct Node* next; } Node;\n"
        "NI straight__m_u4(Node*, NI); NI pending__m_u5(Node*); NI joined__m_u6(Node*, NI);\n"
        "NI quietJoin__m_u7(Node*, NI);\n"
        "static Node* list(int n) { Node* h = 0; while (n--) { Node* x = malloc(sizeof(Node)); x->next = h; h = x; } return h; }\n"
        "static void run(NI value) { printf(\"%ld %d|\", value, nimInErrorMode__system_u1); nimInErrorMode__system_u1 = 0; }\n"
        "int main(void) {\n"
        "  run(straight__m_u4(list(3), 5)); run(straight__m_u4(list(2), 100)); run(straight__m_u4(list(2), 500));\n"
        "  run(pending__m_u5(list(1))); run(joined__m_u6(list(1), 1));\n"
        "  run(quietJoin__m_u7(list(2), 1)); run(quietJoin__m_u7(list(1), 0)); run(quietJoin__m_u7(list(1), 500));\n"
        "  printf(\"\\n\");\n"
        "  return 0;\n}\n"
    )

    def build_and_run(name: str) -> str:
        (nimcache / "main.c").write_text(main)
        binary = tmp_path / name
        compiled = subprocess.run(
            ["cc", "-std=gnu17", "-w", optimization, "-I", str(nimcache), *sorted(map(str, nimcache.glob("*.c"))),
             "-o", str(binary)],
            capture_output=True,
            text=True,
        )
        assert compiled.returncode == 0, compiled.stderr
        return subprocess.run([str(binary)], capture_output=True, text=True).stdout

    before = build_and_run("before")
    assert before == "7 0|0 1|0 1|1 0|2 0|9 0|7 0|0 1|\n"
    load_tool().drop(nimcache)
    assert build_and_run("after") == before
