#!/usr/bin/env python3
"""Keep one copy of each string literal the firmware's Nim modules share.

Nim writes a string literal into every C file that uses it, as a private
constant: the text with its capacity in front, and (where the string is used
as a value) an eight-byte header of length and pointer beside it.

    static const struct {
      NI cap; NIM_CHAR data[5+1];
    } TM__<module>_4 = { 5 | NIM_STRLIT_FLAG, "event" };
    static const NimStringV2 TM__<module>_5 = {5, (NimStrPayload*)&TM__<module>_4};

The linker cannot merge them: they are structs, not C strings, and each sits
in a section of its own. "event" was in the image 14 times, "name" 13, the
empty string 89, and the message of a failed variant-field check
(`field 'fields' is not accessible for type 'JsonNodeObj' using 'kind = `) 30:
28 KB of the image said what another module's constant already said
(2026-11-18, docs/esp32-image-size.md).

A literal that more than one file holds becomes one external constant, named
after its text, defined in the first of those files and declared in the rest;
each file's own name for it is a `#define` onto that one, so nothing else in
the file changes. Headers fold the same way once their text has. Literals are
never written to (NIM_STRLIT_FLAG is what tells the runtime so), and nothing
compares their addresses.

Usage: fold_nim_strings.py <nimcache dir>   (build_nim.sh runs it)
"""

from __future__ import annotations

import hashlib
import re
import sys
from collections import defaultdict
from pathlib import Path

# The text is one or more adjacent C string literals (Nim breaks a long one
# over lines).
PAYLOAD = re.compile(
    r"^static const struct \{\n"
    r"  NI cap; NIM_CHAR data\[(?P<n>\d+)\+1\];\n"
    r"\} (?P<name>TM__\w+) = \{ (?P=n) \| NIM_STRLIT_FLAG, (?P<text>(?:\"(?:[^\"\\\n]|\\.)*\"\s*)+)\};\n",
    re.M,
)
HEADER = re.compile(
    r"^static const NimStringV2 (?P<name>TM__\w+) = \{(?P<n>\d+), \(NimStrPayload\*\)&(?P<payload>TM__\w+)\};\n",
    re.M,
)


def shared_name(prefix: str, *parts: str) -> str:
    digest = hashlib.sha1("\0".join(parts).encode("utf-8", "surrogateescape")).hexdigest()
    return f"{prefix}_{digest[:20]}"


def fold(nimcache: Path) -> tuple[int, int]:
    """Rewrite the files in place. Returns (texts folded, headers folded)."""
    files = sorted(nimcache.glob("*.c"))
    sources = {path: path.read_text(errors="surrogateescape") for path in files}

    # Which files hold which text. One file never holds a text twice (Nim
    # keeps one constant per module), but count per file all the same.
    holders: dict[tuple[str, str], list[Path]] = defaultdict(list)
    for path, source in sources.items():
        seen: set[tuple[str, str]] = set()
        for match in PAYLOAD.finditer(source):
            key = (match.group("n"), match.group("text").strip())
            if key not in seen:
                seen.add(key)
                holders[key].append(path)
    shared = {key: shared_name("fosStr", *key) for key, paths in holders.items() if len(paths) > 1}
    owner = {key: min(paths) for key, paths in holders.items() if key in shared}

    # The headers: the same length over the same shared text, in more than
    # one file.
    header_holders: dict[tuple[str, str], list[Path]] = defaultdict(list)
    for path, source in sources.items():
        text_of = {
            match.group("name"): (match.group("n"), match.group("text").strip()) for match in PAYLOAD.finditer(source)
        }
        seen_headers: set[tuple[str, str]] = set()
        for match in HEADER.finditer(source):
            text = text_of.get(match.group("payload"))
            if text is None or text not in shared:
                continue
            key = (match.group("n"), shared[text])
            if key not in seen_headers:
                seen_headers.add(key)
                header_holders[key].append(path)
    shared_headers = {key: shared_name("fosStrV", *key) for key, paths in header_holders.items() if len(paths) > 1}
    header_owner = {key: min(paths) for key, paths in header_holders.items() if key in shared_headers}

    texts = headers = 0
    for path, source in sources.items():
        local_to_shared: dict[str, str] = {}
        declared: set[str] = set()

        def payload(match: re.Match[str]) -> str:
            nonlocal texts
            key = (match.group("n"), match.group("text").strip())
            name = shared.get(key)
            if name is None:
                return match.group(0)
            local_to_shared[match.group("name")] = name
            alias = f"#define {match.group('name')} {name}\n"
            if name in declared:  # a second constant of the same text in one file
                return alias
            declared.add(name)
            shape = f"const struct {{\n  NI cap; NIM_CHAR data[{key[0]}+1];\n}} {name}"
            if owner[key] == path:
                texts += 1
                return f"{shape} = {{ {key[0]} | NIM_STRLIT_FLAG, {match.group('text')}}};\n{alias}"
            return f"extern {shape};\n{alias}"

        def header(match: re.Match[str]) -> str:
            nonlocal headers
            text_name = local_to_shared.get(match.group("payload"))
            if text_name is None:
                return match.group(0)
            key = (match.group("n"), text_name)
            name = shared_headers.get(key)
            if name is None:
                return match.group(0)
            alias = f"#define {match.group('name')} {name}\n"
            if name in declared:
                return alias
            declared.add(name)
            if header_owner[key] == path:
                headers += 1
                return f"const NimStringV2 {name} = {{{key[0]}, (NimStrPayload*)&{text_name}}};\n{alias}"
            return f"extern const NimStringV2 {name};\n{alias}"

        folded = PAYLOAD.sub(payload, source)
        folded = HEADER.sub(header, folded)
        if folded != source:
            path.write_text(folded, errors="surrogateescape")
    return texts, headers


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    texts, headers = fold(Path(sys.argv[1]))
    print(f"fold_nim_strings: {texts} string literals and {headers} of their headers shared between modules")


if __name__ == "__main__":
    main()
