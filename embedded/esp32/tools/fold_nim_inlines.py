#!/usr/bin/env python3
"""Give each of Nim's inline helpers one out-of-line copy in the firmware.

Nim emits every `{.inline.}` proc it needs (appendString, nimDecRefIsLast,
eqStrings, a string slice's `[]`, ...) as `static N_INLINE(...)` into every C
file that calls it. Where GCC does not inline a call, each file keeps its own
private copy: 70 `appendString`s, 44 `nimDecRefIsLastCyclicDyn`s, about 21 KB
of identical code across the image (2026-10-18, docs/esp32-image-size.md).

C99 inline semantics fold them without giving up inlining. A helper whose
definition is the same in every file is rewritten as a plain `inline`
definition (still inlinable there, but no private copy) in all files but one,
which gets `extern inline`: the one external definition every call that was
not inlined goes to. `weak` would also fold them, but GCC never inlines a weak
function, and that cost more than the copies saved (+1.4 KB measured).

Only identical definitions fold, compared as text after renaming the
temporaries a body declares itself (Nim names them after the module,
`TM__<module hash>_<n>`). A body that names module data (a string literal's
`TM__...`) differs from file to file and stays as it is. A body with a static
local would break the inline-definition rules, and none has one; that is
checked too.

Usage: fold_nim_inlines.py <nimcache dir>   (build_nim.sh runs it)
"""

from __future__ import annotations

import hashlib
import re
import sys
from collections import defaultdict
from pathlib import Path

DEFINITION = re.compile(r"^static N_INLINE\(([^\n]*?), (\w+)\)\(([^\n]*)\) \{$", re.M)
DECLARATION = re.compile(r"^static N_INLINE\(([^\n]*?), (\w+)\)", re.M)
# `NI TM__x_3;`, `NimStringV2* TM__x_4;`: a type, then the name. Not
# `return TM__x_9;`, which reads the module's data.
LOCAL_TEMP = re.compile(
    r"^\s+(?!(?:return|goto|case|else|do)\b)[A-Za-z_]\w*(?:\s*\*+\s*|\s+)"
    r"(?:[A-Za-z_]\w*(?:\s*\*+\s*|\s+))*(TM__\w+);$",
    re.M,
)
STATIC_LOCAL = re.compile(r"^\s+static ", re.M)


def definition_key(body: str) -> str | None:
    """The body with its own temporaries renamed, hashed; None when it holds
    a static local (which an inline definition may not have)."""
    if STATIC_LOCAL.search(body):
        return None
    for index, name in enumerate(dict.fromkeys(LOCAL_TEMP.findall(body))):
        body = re.sub(r"\b" + re.escape(name) + r"\b", f"LOCAL_{index}", body)
    return hashlib.sha1(body.encode("utf-8", "surrogateescape")).hexdigest()


def fold(nimcache: Path) -> tuple[int, int]:
    """Rewrite the files in place. Returns (folded, left as they were)."""
    files = sorted(nimcache.glob("*.c"))
    sources = {path: path.read_text(errors="surrogateescape") for path in files}
    keys: dict[str, dict[Path, str | None]] = defaultdict(dict)
    for path, source in sources.items():
        for match in DEFINITION.finditer(source):
            end = source.find("\n}\n", match.end())
            if end >= 0:
                keys[match.group(2)][path] = definition_key(source[match.start() : end + 3])

    owner: dict[str, Path] = {}
    kept = 0
    for name, per_file in keys.items():
        if len(per_file) < 2:
            continue
        distinct = set(per_file.values())
        if len(distinct) == 1 and None not in distinct:
            owner[name] = min(per_file)
        else:
            kept += 1

    for path, source in sources.items():

        def rewrite(match: re.Match[str]) -> str:
            name = match.group(2)
            if name not in owner:
                return match.group(0)
            return ("extern " if owner[name] == path else "") + f"N_INLINE({match.group(1)}, {name})"

        folded = DECLARATION.sub(rewrite, source)
        if folded != source:
            path.write_text(folded, errors="surrogateescape")
    return len(owner), kept


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    folded, kept = fold(Path(sys.argv[1]))
    print(f"fold_nim_inlines: {folded} inline helpers folded to one copy, {kept} differ between files and stay")


if __name__ == "__main__":
    main()
