#!/usr/bin/env python3
"""Drop the error checks Nim writes after calls that cannot raise.

Under `--exceptions:goto` (and without `--panics:on`, which the firmware keeps
off so that a Defect fails a node, not the frame) Nim follows every call to a
proc that is not a magic, not importc and not known never to raise with

    if (NIM_UNLIKELY(*nimErr_)) goto LA1_;

The compiler marks a proc "never raises" only in a few cases: a hook it lifted
whose body calls nothing that may raise. A type that contains itself is not one
(JsonNode's destroy calls JsonNode's destroy, which is not finished when the
question is asked), and neither is any proc of ours, however small. So the
image held a check after 2,606 calls of JsonNode's destroy, 404 of pixie's
Image's, 32 of NodeId's `==`, about 7,900 in all (2026-11-24,
docs/esp32-image-size.md).

This pass asks the question again over the whole program, on the C Nim wrote:
a function is *clean* when nothing it can reach sets the error flag. The flag
is set by `raiseExceptionAux` alone (every `raise`, every failed index,
overflow, range or field check goes there), so a function is dirty when

  - it calls a dirty function,
  - it calls a function the nimcache does not define, other than the C
    library's memory, string and math functions (QuickJS, ESP-IDF and our own
    C can call back into Nim), or
  - it makes an indirect call (a closure, a proc variable, a destructor
    through a type's RTTI), or
  - its body differs from another definition of the same name.

and everything else is clean. Four functions of system's ORC are clean though
their bodies name `raiseOverflow`, on a branch that cannot be taken: the ref
count is lowered by 16 only when it is 16 or more (`nimDecRefIsLast`,
`nimDecRefIsLastDyn`), `unregisterCycle` is only called for a cell with a
root index (so the index and the root count are at least 1), and
`nimRawDispose` aligns an 8-byte header to a type's alignment.

A check is dropped when the statement before it is a call to clean functions
only (the check can only ever see what that call did), and the flag cannot be
pending from earlier: walking back from the call to the previous check, there
is no call to a function that is not clean (an importc or a compiler proc,
after which Nim writes no check), and no label (where another path joins),
unless the function makes no such unchecked call anywhere. A check in a
`finally` runs after `*nimErr_ = NIM_FALSE`; Nim's error paths destroy
without checks. So no check that could ever be taken goes, and nothing a
Defect does changes: every bounds, overflow and range check still runs and
still raises. (A flag left set by an importc call that called back into Nim
and let an exception escape would be seen at the next check instead: every
callback the runtime gives QuickJS catches what it raises.)

Usage: drop_nim_dead_checks.py <nimcache dir>   (build_nim.sh runs it)
"""

from __future__ import annotations

import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

DEF_MACRO = re.compile(
    r"^(?:static |extern |N_LIB_PRIVATE |N_LIB_EXPORT )*"
    r"(?:N_INLINE|N_NIMCALL|N_CDECL|N_NOINLINE|N_NOCONV|N_CLOSURE|N_SAFECALL|N_STDCALL|N_FASTCALL|N_SYSCALL)"
    r"\((?:.*?), ([A-Za-z_]\w*)\)\((?:.*)\) \{$"
)
# A definition Nim writes without its macros (a proc with `codegenDecl`).
DEF_PLAIN = re.compile(
    r"^(?!typedef|struct|union|if|for|while|switch|else|do)"
    r"(?:[A-Za-z_][\w\s\*\(\)]*?[\s\*])([A-Za-z_]\w*)\(([^;{}()]*)\) \{$"
)
CALL = re.compile(r"\b([A-Za-z_]\w*)\s*\(")
STRING = re.compile(r'"(?:[^"\\]|\\.)*"')
CHECK = re.compile(r"^\s*if \(NIM_UNLIKELY\(\*nimErr_\)\) goto \w+;\s*$")
LABEL = re.compile(r"^\s*\}?\s*\w+:\s*;?\s*$")
INDIRECT = re.compile(r"ClP_0|destructor|traceImpl|\(\s*\*\s*[\w\.\[\]>-]+\s*\)\s*\(|\(\s*\(\s*tyProc_\w+\s*\)")

# Not calls: keywords and Nim's macros.
NOT_CALLS = {
    "if", "while", "for", "switch", "return", "sizeof", "case", "defined", "offsetof",
    "__attribute__", "always_inline", "IL64",
}
# C functions that cannot run Nim code.
CLEAN_EXTERN = {
    "memcpy", "memset", "memmove", "memcmp", "memchr", "strlen", "strcmp", "strncmp",
    "free", "malloc", "calloc", "realloc", "nimErrorFlag",
    "nimAddInt", "nimSubInt", "nimMulInt", "nimAddInt64", "nimSubInt64", "nimMulInt64",
    "nimModInt", "nimModInt64", "nimDivInt", "nimDivInt64",
    "__builtin_expect", "__builtin_unreachable",
    "__builtin_sadd_overflow", "__builtin_ssub_overflow", "__builtin_smul_overflow",
    "__builtin_saddl_overflow", "__builtin_ssubl_overflow", "__builtin_smull_overflow",
    "__builtin_saddll_overflow", "__builtin_ssubll_overflow", "__builtin_smulll_overflow",
    "roundf", "round", "ceilf", "ceil", "floorf", "floor", "truncf", "trunc", "fabsf", "fabs",
    "sqrtf", "sqrt", "fmodf", "fmod", "powf", "pow", "expf", "exp", "logf", "log",
    "sinf", "sin", "cosf", "cos", "tanf", "tan", "asinf", "acosf", "atanf", "atan2f", "atan2",
    "hypotf", "lroundf", "llroundf",
    # QuickJS: inlines and macros of quickjs.h that only build or read a
    # value, and three getters of a field.
    "JS_MKVAL", "JS_MKPTR", "JS_VALUE_GET_TAG", "JS_VALUE_GET_NORM_TAG", "JS_VALUE_GET_INT",
    "JS_VALUE_GET_BOOL", "JS_VALUE_GET_FLOAT64", "JS_VALUE_GET_PTR", "JS_NewBool", "JS_NewInt32",
    "JS_NewInt64", "JS_NewUint32", "JS_NewFloat64", "__JS_NewFloat64", "JS_NewCatchOffset",
    "JS_IsNumber", "JS_IsBool", "JS_IsNull", "JS_IsUndefined", "JS_IsException",
    "JS_IsUninitialized", "JS_IsString", "JS_IsSymbol", "JS_IsObject", "JS_DupValue",
    "JS_DupValueRT", "JS_GetContextOpaque", "JS_GetRuntimeOpaque", "JS_GetRuntime",
}
# Clean, though they name a raise: see the docstring.
CLEAN_OVERRIDE = ("nimDecRefIsLast", "nimDecRefIsLastDyn", "unregisterCycle", "nimRawDispose")


def definition(line: str) -> str | None:
    m = DEF_MACRO.match(line)
    if m:
        return m.group(1)
    m = DEF_PLAIN.match(line)
    return m.group(1) if m else None


def calls_in(line: str) -> list[str]:
    text = STRING.sub('""', line)
    return [
        name for name in CALL.findall(text)
        if name not in NOT_CALLS and not name.startswith(("ty", "NIM_", "N_"))
    ]


def overridden(name: str) -> bool:
    return any(name == o or name.startswith(o + "__") for o in CLEAN_OVERRIDE)


def functions(sources: dict[Path, list[str]]):
    """Each definition: (file, name, first body line index, end line index)."""
    for path, lines in sources.items():
        i = 0
        while i < len(lines):
            name = definition(lines[i])
            if name:
                depth, j = 0, i
                while j < len(lines):
                    text = STRING.sub('""', lines[j])
                    depth += text.count("{") - text.count("}")
                    if depth <= 0 and j > i:
                        break
                    j += 1
                yield path, name, i + 1, j
                i = j
            i += 1


def clean_functions(sources: dict[Path, list[str]]) -> set[str]:
    bodies: dict[str, list[str]] = {}
    shapes: dict[str, list[str]] = {}
    dirty: set[str] = set()
    for path, name, start, end in functions(sources):
        body = sources[path][start:end]
        # Copies of an inline proc differ only in their temporaries' names.
        shape = [re.sub(r"TM__\w+?_\d+", "TM", line) for line in body]
        if name not in bodies:
            bodies[name], shapes[name] = body, shape
        elif shapes[name] != shape:
            dirty.add(name)
    callees: dict[str, set[str]] = {}
    for name, body in bodies.items():
        if overridden(name):
            callees[name] = set()
            dirty.discard(name)
            continue
        found: set[str] = set()
        for line in body:
            text = STRING.sub('""', line)
            if INDIRECT.search(text) or re.search(r"nimInErrorMode__\w*\s*(\+=|=[^=])", text):
                dirty.add(name)
            found.update(calls_in(line))
        callees[name] = found
        if any(c not in bodies and c not in CLEAN_EXTERN for c in found):
            dirty.add(name)
    callers: dict[str, set[str]] = defaultdict(set)
    for name, found in callees.items():
        for c in found:
            callers[c].add(name)
    work = list(dirty)
    while work:
        for caller in callers.get(work.pop(), ()):
            if caller not in dirty and not overridden(caller):
                dirty.add(caller)
                work.append(caller)
    return set(bodies) - dirty


def drop(nimcache: Path) -> Counter:
    """Rewrite the files in place. Returns the checks dropped, by callee."""
    files = sorted(nimcache.glob("*.c"))
    sources = {path: path.read_text(errors="surrogateescape").split("\n") for path in files}
    clean = clean_functions(sources)

    def fine(line: str) -> bool:
        return not INDIRECT.search(STRING.sub('""', line)) and all(
            c in clean or c in CLEAN_EXTERN for c in calls_in(line))

    def unchecked_dirty_call(lines: list[str], k: int) -> bool:
        # A call Nim writes no check after (importc, a compiler proc) to a
        # function that may set the flag. A raise is followed by its goto.
        return not fine(lines[k]) and calls_in(lines[k]) and not (
            k + 1 < len(lines) and CHECK.match(lines[k + 1])) and "goto" not in lines[k]

    dropped: Counter = Counter()
    for path, lines in sources.items():
        remove: set[int] = set()
        for _, _, start, end in functions({path: lines}):
            # A function with no such call cannot have the flag pending on a
            # path that did not come through a check; one with one can, on
            # any path that joins here (a label, a loop's head, a case).
            quiet = not any(unchecked_dirty_call(lines, k) for k in range(start, end))
            # Where a set flag goes: after them the flag is set until a check.
            error_labels = {
                m.group(1)
                for k in range(start, end)
                if "nimErr_" in lines[k] or "raise" in lines[k]
                for m in re.finditer(r"goto (\w+);", lines[k])
            }
            for i in range(start + 1, end):
                if not CHECK.match(lines[i]):
                    continue
                call = lines[i - 1]
                names = calls_in(call)
                if not names or not call.rstrip().endswith(";") or not fine(call):
                    continue
                ok = True
                k = i - 2
                while k >= start:
                    line = lines[k]
                    if CHECK.match(line) or "nimErr_ = nimErrorFlag()" in line:
                        break
                    label = LABEL.match(line)
                    if label and any(re.search(rf"\b{re.escape(e)}:", line) for e in error_labels):
                        ok = False
                        break
                    joins = label or re.match(r"^\s*(while|for|do|case|default)\b", line)
                    if not quiet and ((joins and "BeforeRet_" not in line) or (calls_in(line) and not fine(line))):
                        ok = False
                        break
                    k -= 1
                if ok:
                    remove.add(i)
                    dropped[names[0]] += 1
        if remove:
            path.write_text("\n".join(line for i, line in enumerate(lines) if i not in remove),
                            errors="surrogateescape")
    return dropped


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    dropped = drop(Path(argv[1]))
    print(f"drop_nim_dead_checks: {sum(dropped.values())} error checks after {len(dropped)} procs that cannot raise")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
