#!/usr/bin/env python3
"""One copy of the static helpers the vendored panel drivers all write the same.

Every Waveshare driver carries its own `static void EPD_xxx_SendCommand(UBYTE
Reg)`: DC low, CS low, the byte, CS high. 67 drivers in the image have that
one, 62 the same `SendData`, and the resets, `SendData2` and window setters
repeat in smaller families: about 6 KB of the ESP32 image, the same code
under other names (2026-11-24, docs/esp32-image-size.md "Identical code").

The drivers stay as the vendor wrote them (the Pi builds the same files).
For the ESP32 build, this writes the copies the component compiles: a static
function whose body is token for token the same as another driver's, and
reads nothing but its parameters, its own locals and the shared DEV_Config
API, keeps its name and signature and calls one shared definition instead.

    static inline void EPD_2IN9_V2_SendCommand(UBYTE Reg)
    { fos_epd_SendCommand_1f3a9c(Reg); }

GCC inlines that forwarder at every call, so a call that went to the
driver's copy goes to the shared one: the same DEV_Digital_Write /
DEV_SPI_WriteByte calls in the same order, the same bytes on the bus. The
shared definitions are written into `fos_epd_folded.inc`, which
DEV_Config_esp.c includes at its end: they stand beside the drivers in the
link order and beside the DEV_ functions they call.

A body folds only when every name in it means the same in the shared file:
a C keyword or type, a parameter, a local it declares (and does not use
before that), a name the ESP32's DEV_Config.h or Debug.h declares that
neither the driver and its headers nor the host file (`--host`, where the
shared definitions are compiled) #defines again or keeps a static of, or a
helper folded in an earlier round (so `SetCursor`, which calls
`SendCommand`, can fold once `SendCommand` has). No body with a
preprocessor line folds. Line numbers stay where they were.

Usage: fold_panel_helpers.py --include-dir DIR --host FILE --out-dir DIR SOURCE...
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

C_WORDS = {
    "auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum", "extern",
    "float", "for", "goto", "if", "inline", "int", "long", "register", "return", "short", "signed", "sizeof",
    "static", "struct", "switch", "typedef", "union", "unsigned", "void", "volatile", "while", "_Bool",
    "uint8_t", "uint16_t", "uint32_t", "int8_t", "int16_t", "int32_t", "size_t", "bool", "true", "false", "NULL",
}
TYPE_WORDS = {"char", "int", "long", "short", "signed", "unsigned", "float", "double", "const", "volatile",
              "uint8_t", "uint16_t", "uint32_t", "int8_t", "int16_t", "int32_t", "size_t", "bool",
              "UBYTE", "UWORD", "UDOUBLE"}

TOKEN = re.compile(
    r'"(?:[^"\\\n]|\\.)*"|\'(?:[^\'\\\n]|\\.)*\'|[A-Za-z_]\w*|0[xX][0-9A-Fa-f]+[uUlL]*|\d+[uUlL]*|\S'
)
DEFINITION = re.compile(
    r"^static\s+(?:inline\s+)?(void|UBYTE|UWORD|UDOUBLE|int|uint8_t|uint16_t|uint32_t)\s+(\w+)\s*\(([^()]*)\)\s*\{",
    re.M,
)
DEFINES = re.compile(r"^\s*#\s*(?:define|undef)\s+(\w+)", re.M)
INCLUDES = re.compile(r'^\s*#\s*include\s+"([^"]+)"', re.M)


def mask_comments(text: str) -> str:
    """The text with each comment replaced by spaces (newlines kept), so
    offsets and line numbers stay; strings and characters untouched."""
    out = []
    at = 0
    n = len(text)
    while at < n:
        c = text[at]
        if c == "/" and text.startswith("/*", at):
            end = text.find("*/", at + 2)
            end = n if end < 0 else end + 2
            out.append(re.sub(r"[^\n]", " ", text[at:end]))
            at = end
        elif c == "/" and text.startswith("//", at):
            end = text.find("\n", at)
            end = n if end < 0 else end
            out.append(" " * (end - at))
            at = end
        elif c in "\"'":
            end = at + 1
            while end < n and text[end] != c:
                end += 2 if text[end] == "\\" else 1
            out.append(text[at : end + 1])
            at = end + 1
        else:
            out.append(c)
            at += 1
    return "".join(out)


def matching_brace(code: str, open_at: int) -> int:
    depth = 0
    at = open_at
    while at < len(code):
        c = code[at]
        if c in "\"'":
            end = at + 1
            while end < len(code) and code[end] != c:
                end += 2 if code[end] == "\\" else 1
            at = end + 1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return at
        at += 1
    raise ValueError("unbalanced braces")


def shared_api(include_dir: Path, host: Path) -> set[str]:
    """Names the ESP32's DEV_Config.h and Debug.h declare or define, less
    any the host file (where the shared definitions are compiled) defines
    again or keeps a static of."""
    names: set[str] = set()
    for header in ("DEV_Config.h", "Debug.h"):
        code = mask_comments((include_dir / header).read_text())
        names.update(DEFINES.findall(code))
        names.update(re.findall(r"\b(\w+)\s*\(", code))  # functions and function-like macros
        names.update(re.findall(r"\bextern\s+[\w\s\*]+?\b(\w+)\s*;", code))
    code = mask_comments(host.read_text(errors="surrogateescape"))
    names -= set(DEFINES.findall(code))
    names -= set(re.findall(r"^static\b[^;=({]*?\b(\w+)\s*[;=([]", code, re.M))
    if re.search(r"^\s*#\s*define\s+LOG_LOCAL_LEVEL\b", code, re.M):
        names.discard("Debug")  # its ESP_LOGD would log otherwise there
    return names


class Helper:
    def __init__(self, source: "Source", match: re.Match[str], close: int) -> None:
        self.source = source
        self.ret = match.group(1)
        self.name = match.group(2)
        self.params_text = match.group(3).strip()
        self.start = match.start()
        self.open = match.end() - 1
        self.close = close
        self.body = source.code[self.open + 1 : close]
        params = [] if self.params_text in ("", "void") else [p.strip() for p in self.params_text.split(",")]
        self.param_names = []
        self.param_types = []
        for param in params:
            words = TOKEN.findall(param)
            self.param_names.append(words[-1])
            self.param_types.append(" ".join(words[:-1]))
        self.shared: str | None = None

    def key(self, known: set[str], folded: dict[str, str]) -> str | None:
        """The body, its parameters numbered and folded helpers by their
        shared names; None when it may not fold."""
        if "#" in self.body:
            return None
        tokens = TOKEN.findall(self.body)
        declared_at: dict[str, int] = {}
        for index, token in enumerate(tokens[1:], 1):
            if tokens[index - 1] in TYPE_WORDS and re.match(r"[A-Za-z_]\w*$", token) and token not in TYPE_WORDS:
                declared_at.setdefault(token, index)
        out = []
        for index, token in enumerate(tokens):
            if token in self.param_names:
                out.append(f"$p{self.param_names.index(token)}")
            elif token in folded:
                out.append(folded[token])
            elif re.match(r"[A-Za-z_]\w*$", token):
                if token in declared_at and index < declared_at[token]:
                    return None  # the driver's own name until the local is declared
                if token in C_WORDS or token in declared_at:
                    out.append(token)
                elif token in known and token not in self.source.redefined:
                    out.append(token)
                else:
                    return None
            else:
                out.append(token)
        return "\0".join([self.ret, *self.param_types, "|", *out])


class Source:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.text = path.read_text(errors="surrogateescape")
        self.code = mask_comments(self.text)
        # What this driver, and every header beside it that it includes
        # however deep, makes mean something else (#define / #undef).
        self.redefined = set(DEFINES.findall(self.code))
        seen: set[Path] = set()
        pending = list(INCLUDES.findall(self.code))
        while pending:
            header = pending.pop()
            near = path.parent / header
            if header in ("DEV_Config.h", "Debug.h") or near in seen or not near.is_file():
                continue
            seen.add(near)
            code = mask_comments(near.read_text(errors="surrogateescape"))
            self.redefined.update(DEFINES.findall(code))
            pending.extend(INCLUDES.findall(code))
        self.helpers: list[Helper] = []
        names: dict[str, int] = defaultdict(int)
        for match in DEFINITION.finditer(self.code):
            if self.depth_at(match.start()) != 0:
                continue
            helper = Helper(self, match, matching_brace(self.code, match.end() - 1))
            names[helper.name] += 1
            self.helpers.append(helper)
        # Two definitions of one name sit in #if branches: leave both.
        self.helpers = [h for h in self.helpers if names[h.name] == 1]

    def depth_at(self, at: int) -> int:
        code = self.code[:at]
        code = re.sub(r'"(?:[^"\\\n]|\\.)*"|\'(?:[^\'\\\n]|\\.)*\'', "", code)
        return code.count("{") - code.count("}")


def plan(sources: list[Source], known: set[str]) -> list[list[Helper]]:
    """Groups of helpers that become one, in rounds until nothing more folds."""
    groups: list[list[Helper]] = []
    while True:
        by_key: dict[str, list[Helper]] = defaultdict(list)
        for source in sources:
            folded = {h.name: h.shared for h in source.helpers if h.shared}
            for helper in source.helpers:
                if helper.shared:
                    continue
                key = helper.key(known, folded)
                if key is not None:
                    by_key[key].append(helper)
        new = [members for members in by_key.values() if len({m.source.path for m in members}) > 1]
        if not new:
            return groups
        for key, members in by_key.items():
            if members not in new:
                continue
            suffix = re.sub(r"^.*?_(?=[A-Z][a-z]+\w*$)", "", members[0].name)
            digest = hashlib.sha1(key.encode("utf-8", "surrogateescape")).hexdigest()[:8]
            name = f"fos_epd_{suffix}_{digest}"
            for member in members:
                member.shared = name
            known = known | {name}
            groups.append(members)


def forwarder(helper: Helper) -> str:
    call = f"{helper.shared}({', '.join(helper.param_names)});"
    body = f"{{ {'return ' if helper.ret != 'void' else ''}{call} }}"
    # As many lines as the body had, so every line after it keeps its number.
    return body + "\n" * helper.source.text[helper.open : helper.close + 1].count("\n")


def rewrite(source: Source) -> str:
    text = source.text
    for helper in sorted((h for h in source.helpers if h.shared), key=lambda h: -h.start):
        prototype = f"{helper.ret} {helper.shared}({helper.params_text or 'void'}); "
        head = text[helper.start : helper.open]
        head = re.sub(r"^static\s+(?:inline\s+)?", "static inline ", head)
        text = text[: helper.start] + prototype + head + forwarder(helper) + text[helper.close + 1 :]
    return text


def shared_definitions(groups: list[list[Helper]]) -> str:
    lines = [
        "/* Written by fold_panel_helpers.py: the panel drivers' helpers that are\n"
        "   the same in several of them, once. Included by DEV_Config_esp.c. */\n",
    ]
    for members in groups:
        first = members[0]
        lines.append(f"{first.ret} {first.shared}({first.params_text or 'void'});\n")
    for members in groups:
        first = members[0]
        folded = {h.name: h.shared for h in first.source.helpers if h.shared and h is not first}
        body = first.source.code[first.open : first.close + 1]
        body = re.sub(r"[A-Za-z_]\w*", lambda m: folded.get(m.group(0), m.group(0)), body)
        sources = ", ".join(sorted(m.source.path.stem for m in members))
        lines.append(f"\n/* {first.name} and the same in {len(members) - 1} more: {sources} */\n")
        lines.append(f"{first.ret} {first.shared}({first.params_text or 'void'})\n{body}\n")
    return "".join(lines)


def write_if_changed(path: Path, text: str) -> None:
    """Replace the file (or the symlink an older configure left there: never
    write through it into the repository's copy)."""
    if path.is_file() and not path.is_symlink() and path.read_text(errors="surrogateescape") == text:
        return
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text, errors="surrogateescape")
    os.replace(temporary, path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--include-dir", type=Path, required=True, help="the ESP32 DEV_Config.h and Debug.h")
    parser.add_argument("--host", type=Path, required=True, help="the C file that includes fos_epd_folded.inc")
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("sources", type=Path, nargs="+")
    args = parser.parse_args(argv)

    sources = [Source(path) for path in args.sources]
    groups = plan(sources, shared_api(args.include_dir, args.host))
    args.out_dir.mkdir(parents=True, exist_ok=True)
    for source in sources:
        write_if_changed(args.out_dir / source.path.name, rewrite(source))
    write_if_changed(args.out_dir / "fos_epd_folded.inc", shared_definitions(groups))
    helpers = sum(len(g) for g in groups)
    print(f"fold_panel_helpers: {helpers} driver helpers share {len(groups)} definitions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
