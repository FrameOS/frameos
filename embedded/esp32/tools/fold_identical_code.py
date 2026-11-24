#!/usr/bin/env python3
"""Keep one copy of each function the Nim runtime's archive holds more than once.

`ld.bfd` has no identical-code folding, and Nim writes a great deal of
identical code: the `=destroy` / `=wasMoved` / `=trace` / `=sink` hooks of
types that happen to have the same shape (system/exceptions alone holds the
same `=destroy` 24 times), and generic instances (`add`, `setLen`, `[]`, a
table's `rawGet`) made again in every module that uses them. 201 groups,
837 functions, 20.4 KB of the image (2026-11-24, docs/esp32-image-size.md).

This runs on the component's archive once it is made (a POST_BUILD step in
components/frameos_nim/CMakeLists.txt) and decides on the compiled objects,
where "the same" is exact: two functions are the same when their bytes, their
literal pools and their relocations are, a relocation naming a function
counting as the same when the functions it names are the same (refined to a
fixed point, as lld's ICF does). Every function of a group is renamed to the
group's first name with `objcopy --redefine-syms`, in every object of the
archive (so each call to any copy now names that one), and made weak: the
linker keeps the first definition it meets and `--gc-sections` drops the
rest, which nothing calls any more.

What may fold:

- A global function alone in its section (`-ffunction-sections`), that
  nothing outside the archive names: hidden (Nim's N_LIB_PRIVATE), or a
  Nim name with its number (`add__OOZ..._u454`), which changes from one
  compile to the next. A static's calls go through its section symbol,
  which a rename cannot move. (A rename that something outside did call
  would be an undefined reference at the link, never a wrong call.)
- One whose address nothing can compare: every use is a call (on the
  Xtensa, the long-call macro's L32R carries an ASM_EXPAND naming the same
  function), or the use is a Nim type descriptor's (`NTIv2__...`), whose
  `destructor` and `traceImpl` the runtime only calls or tests against nil
  (system/orc.nim, arc.nim, cyclebreaker.nim). An app table, a native's
  entry, a closure: such a function keeps its own copy.
- Nothing of an object named with `--keep` (the -O2 hot modules: their code
  stays where it is and keeps its alignment).

Usage: fold_identical_code.py --objcopy OBJCOPY --ar AR [--keep SUBSTR ...]
                              [--report] ARCHIVE
"""

from __future__ import annotations

import argparse
import hashlib
import re
import struct
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

# ---------------------------------------------------------------------------
# Archives
# ---------------------------------------------------------------------------


def read_archive(data: bytes) -> list[tuple[str, bytes]]:
    """The members of a GNU/SysV `ar` archive, in order."""
    if data[:8] != b"!<arch>\n":
        raise ValueError("not an ar archive")
    members: list[tuple[str, bytes]] = []
    longnames = b""
    at = 8
    while at + 60 <= len(data):
        header = data[at : at + 60]
        name = header[:16].decode("utf-8", "surrogateescape").rstrip()
        size = int(header[48:58].decode().strip())
        body = data[at + 60 : at + 60 + size]
        if name == "//":
            longnames = body
        elif name not in ("/", "/SYM64/"):
            if name.startswith("/") and name[1:].isdigit():
                start = int(name[1:])
                end = longnames.index(b"/\n", start)
                name = longnames[start:end].decode("utf-8", "surrogateescape")
            else:
                name = name.rstrip("/")
            members.append((name, body))
        at += 60 + size + (size & 1)
    return members


# ---------------------------------------------------------------------------
# Relocatable ELF objects (32- and 64-bit little-endian)
# ---------------------------------------------------------------------------

EM_X86_64 = 62
EM_XTENSA = 94
SHT_SYMTAB = 2
SHT_RELA = 4
SHF_EXECINSTR = 0x4
STT_FUNC = 2
STT_SECTION = 3
STB_LOCAL = 0
STV_HIDDEN = 2
SHN_UNDEF = 0
SHN_LORESERVE = 0xFF00

R_XTENSA_ASM_EXPAND = 11
R_XTENSA_SLOT0_OP = 20
R_X86_64_PC32 = 2
R_X86_64_PLT32 = 4

# The section of a Nim type descriptor (`TNimTypeV2`, `NTIv2__<hash>_`), which
# holds a type's `=destroy` and `=trace`.
NIM_TYPE_INFO = ".NTIv2__"

# `add__OOZOOZpixieZsrcZpixieZpaths_u454`: a proc, its module, its number.
NIM_NUMBERED = re.compile(r"__\w+_u\d+$")

# Sections whose relocations say nothing about how a function is used.
NOT_A_USE = (".debug", ".xt.", ".comment", ".note", ".eh_frame", ".rela")


class Section:
    __slots__ = ("index", "name", "type", "flags", "offset", "size", "link", "info", "align", "entsize")

    def __init__(self, index, name, type_, flags, offset, size, link, info, align, entsize):
        self.index = index
        self.name = name
        self.type = type_
        self.flags = flags
        self.offset = offset
        self.size = size
        self.link = link
        self.info = info
        self.align = align
        self.entsize = entsize


class Symbol:
    __slots__ = ("name", "value", "size", "bind", "type", "other", "shndx")

    def __init__(self, name, value, size, bind, type_, other, shndx):
        self.name = name
        self.value = value
        self.size = size
        self.bind = bind
        self.type = type_
        self.other = other
        self.shndx = shndx


class Object:
    """What the fold needs of one relocatable object."""

    def __init__(self, name: str, data: bytes) -> None:
        self.name = name
        self.data = data
        if data[:4] != b"\x7fELF" or data[5] != 1:
            raise ValueError(f"{name}: not a little-endian ELF object")
        self.is64 = data[4] == 2
        if self.is64:
            (self.machine,) = struct.unpack_from("<H", data, 18)
            (shoff,) = struct.unpack_from("<Q", data, 0x28)
            shentsize, shnum, shstrndx = struct.unpack_from("<HHH", data, 0x3A)
        else:
            (self.machine,) = struct.unpack_from("<H", data, 18)
            (shoff,) = struct.unpack_from("<I", data, 0x20)
            shentsize, shnum, shstrndx = struct.unpack_from("<HHH", data, 0x2E)
        raw = []
        for index in range(shnum):
            at = shoff + index * shentsize
            if self.is64:
                fields = struct.unpack_from("<IIQQQQIIQQ", data, at)
            else:
                fields = struct.unpack_from("<IIIIIIIIII", data, at)
            raw.append(fields)
        names_at = raw[shstrndx][4]
        self.sections: list[Section] = []
        for index, (name_off, type_, flags, _addr, offset, size, link, info, align, entsize) in enumerate(raw):
            self.sections.append(
                Section(index, self._cstr(names_at + name_off), type_, flags, offset, size, link, info, align, entsize)
            )
        self.by_name: dict[str, list[Section]] = defaultdict(list)
        for section in self.sections:
            self.by_name[section.name].append(section)

        self.symbols: list[Symbol] = []
        symtab = next((s for s in self.sections if s.type == SHT_SYMTAB), None)
        if symtab is not None:
            strtab = self.sections[symtab.link]
            entsize = 24 if self.is64 else 16
            for at in range(symtab.offset, symtab.offset + symtab.size, entsize):
                if self.is64:
                    name_off, info, other, shndx, value, size = struct.unpack_from("<IBBHQQ", data, at)
                else:
                    name_off, value, size, info, other, shndx = struct.unpack_from("<IIIBBH", data, at)
                self.symbols.append(
                    Symbol(self._cstr(strtab.offset + name_off), value, size, info >> 4, info & 0xF, other, shndx)
                )

        # The relocations of each section, by the index of the section they apply to.
        self.relocs: dict[int, list[tuple[int, int, int, int]]] = {}
        for section in self.sections:
            if section.type != SHT_RELA:
                continue
            entries = []
            entsize = 24 if self.is64 else 12
            for at in range(section.offset, section.offset + section.size, entsize):
                if self.is64:
                    offset, info, addend = struct.unpack_from("<QQq", data, at)
                    entries.append((offset, info & 0xFFFFFFFF, info >> 32, addend))
                else:
                    offset, info, addend = struct.unpack_from("<IIi", data, at)
                    entries.append((offset, info & 0xFF, info >> 8, addend))
            self.relocs[section.info] = entries

    def _cstr(self, at: int) -> str:
        end = self.data.index(b"\0", at)
        return self.data[at:end].decode("utf-8", "surrogateescape")

    def contents(self, section: Section) -> bytes:
        if section.type == 8:  # SHT_NOBITS
            return b""
        return self.data[section.offset : section.offset + section.size]


# ---------------------------------------------------------------------------
# What may fold
# ---------------------------------------------------------------------------


class Function:
    __slots__ = ("obj", "name", "section", "literal", "size")

    def __init__(self, obj: Object, name: str, section: Section, literal: Section | None) -> None:
        self.obj = obj
        self.name = name
        self.section = section
        self.literal = literal
        self.size = section.size + (literal.size if literal else 0)


def find_functions(objects: list[Object], keep: list[str]) -> tuple[dict[str, Function], set[str]]:
    """Global functions alone in a section of their own, by name; and the
    names defined more than once (never folded: which one wins is not ours)."""
    defined: dict[str, int] = defaultdict(int)
    candidates: dict[str, Function] = {}
    for obj in objects:
        kept = any(k in obj.name for k in keep)
        for symbol in obj.symbols:
            if symbol.bind == STB_LOCAL or symbol.shndx in (SHN_UNDEF,) or symbol.shndx >= SHN_LORESERVE:
                continue
            defined[symbol.name] += 1
            if kept or symbol.type != STT_FUNC or symbol.value != 0:
                continue
            # Only what nothing outside the archive can name: hidden symbols
            # (Nim's N_LIB_PRIVATE), and Nim's numbered names, which change
            # from one compile to the next. A C function the firmware calls
            # (`frameos_nim_available`) keeps its name. (A name renamed that
            # something else did call is an undefined reference at the link,
            # never a wrong call.)
            if symbol.other & 3 != STV_HIDDEN and not NIM_NUMBERED.search(symbol.name):
                continue
            section = obj.sections[symbol.shndx]
            if not section.flags & SHF_EXECINSTR or not section.name.startswith(".text."):
                continue
            if section.size == 0 or symbol.size not in (0, section.size):
                continue
            literals = obj.by_name.get(".literal" + section.name[len(".text") :], [])
            if len(obj.by_name[section.name]) != 1 or len(literals) > 1:
                continue
            candidates[symbol.name] = Function(obj, symbol.name, section, literals[0] if literals else None)
    twice = {name for name, count in defined.items() if count > 1}
    for name in twice:
        candidates.pop(name, None)
    return candidates, twice


def section_functions(objects: list[Object], candidates: dict[str, Function]) -> dict[tuple[int, int], str]:
    """(object, section index) -> the candidate defined there."""
    where = {}
    for function in candidates.values():
        where[(id(function.obj), function.section.index)] = function.name
    return where


def taken_addresses(objects: list[Object], candidates: dict[str, Function]) -> set[str]:
    """Candidates whose address is used for anything but a call."""
    where = section_functions(objects, candidates)
    taken: set[str] = set()

    for obj in objects:

        def named(symidx: int) -> tuple[str | None, int]:
            """The candidate a relocation's symbol stands for (with the offset
            into its section, for a section symbol), or None."""
            symbol = obj.symbols[symidx]
            if symbol.type == STT_SECTION:
                return where.get((id(obj), symbol.shndx)), 0
            if symbol.bind != STB_LOCAL and symbol.name in candidates:
                return symbol.name, 0
            if symbol.bind == STB_LOCAL and 0 < symbol.shndx < SHN_LORESERVE:
                return where.get((id(obj), symbol.shndx)), symbol.value
            return None, 0

        for target_index, entries in obj.relocs.items():
            target = obj.sections[target_index]
            if target.name.startswith(NOT_A_USE):
                continue
            executable = bool(target.flags & SHF_EXECINSTR)
            if obj.machine == EM_XTENSA and target.name.startswith(".literal"):
                continue  # a literal is judged by the instruction that loads it, below
            if obj.machine == EM_XTENSA and executable:
                literal_of: dict[int, list[tuple[int, int, int, int]]] = {}
                expands = {(off, symidx) for off, typ, symidx, _ in entries if typ == R_XTENSA_ASM_EXPAND}
                expand_names = {}
                for off, symidx in expands:
                    name, _ = named(symidx)
                    expand_names.setdefault(off, set()).add(name or obj.symbols[symidx].name)
                for off, typ, symidx, addend in entries:
                    name, _ = named(symidx)
                    symbol = obj.symbols[symidx]
                    if typ == R_XTENSA_ASM_EXPAND:
                        continue
                    if typ == R_XTENSA_SLOT0_OP and symbol.type == STT_SECTION and obj.sections[symbol.shndx].name.startswith(".literal"):
                        # An L32R of a literal: a call when the same instruction
                        # (gas's long-call macro) carries an ASM_EXPAND naming
                        # what the literal holds.
                        literal = obj.sections[symbol.shndx]
                        if literal.index not in literal_of:
                            literal_of[literal.index] = obj.relocs.get(literal.index, [])
                        for loff, _ltyp, lsym, _ladd in literal_of[literal.index]:
                            if loff != addend:
                                continue
                            held, _ = named(lsym)
                            if held is None:
                                continue
                            if held not in expand_names.get(off, ()):
                                taken.add(held)
                        continue
                    if name is None:
                        continue
                    if typ == R_XTENSA_SLOT0_OP:
                        continue  # a CALL8 / J straight to it
                    taken.add(name)
                continue
            if obj.machine == EM_X86_64 and executable:
                code = obj.contents(target)
                for off, typ, symidx, _ in entries:
                    name, _ = named(symidx)
                    if name is None:
                        continue
                    if typ in (R_X86_64_PLT32, R_X86_64_PC32) and off >= 1 and code[off - 1] in (0xE8, 0xE9):
                        continue  # call / jmp rel32
                    taken.add(name)
                continue
            # Data, or code of an architecture this does not read: every
            # reference is an address. A Nim type descriptor's is not one
            # anything compares: the runtime calls `destructor` and
            # `traceImpl` or tests them against nil, nothing else
            # (system/orc.nim, arc.nim, cyclebreaker.nim).
            if NIM_TYPE_INFO in target.name:
                continue
            for _off, _typ, symidx, _ in entries:
                name, _ = named(symidx)
                if name is not None:
                    taken.add(name)
    return taken


# ---------------------------------------------------------------------------
# Which are the same
# ---------------------------------------------------------------------------


def group(candidates: dict[str, Function], foldable: set[str]) -> list[list[str]]:
    """Classes of identical functions among `foldable`, refined to a fixed point."""
    names = sorted(foldable)
    objects = {id(f.obj): f.obj for f in candidates.values()}
    where = section_functions(list(objects.values()), candidates)

    def reloc_targets(function: Function, section: Section | None) -> list[tuple]:
        if section is None:
            return []
        obj = function.obj
        out = []
        for off, typ, symidx, addend in obj.relocs.get(section.index, []):
            symbol = obj.symbols[symidx]
            if symbol.type == STT_SECTION:
                if symbol.shndx == function.section.index:
                    ident: tuple = ("self",)
                elif function.literal is not None and symbol.shndx == function.literal.index:
                    ident = ("pool",)
                else:
                    callee = where.get((id(obj), symbol.shndx))
                    ident = ("fn", callee) if callee in foldable else ("local", obj.name, obj.sections[symbol.shndx].name)
            elif symbol.bind == STB_LOCAL:
                ident = ("local", obj.name, symbol.name, symbol.shndx, symbol.value)
            elif symbol.name == function.name:
                ident = ("self",)
            elif symbol.name in foldable:
                ident = ("fn", symbol.name)
            else:
                ident = ("name", symbol.name)
            out.append((off, typ, ident, addend))
        return out

    shapes = {}
    relocs = {}
    for name in names:
        function = candidates[name]
        literal = function.literal
        shapes[name] = (
            function.obj.machine,
            function.section.flags,
            function.section.align,
            function.obj.contents(function.section),
            function.obj.contents(literal) if literal else None,
            literal.align if literal else None,
        )
        relocs[name] = (reloc_targets(function, function.section), reloc_targets(function, literal))

    klass = {name: 0 for name in names}
    count = 1
    while True:
        ids: dict[str, int] = {}
        new = {}
        for name in names:

            def resolve(entries):
                return [
                    (off, typ, ("fn", klass[ident[1]]) if ident[0] == "fn" else ident, addend)
                    for off, typ, ident, addend in entries
                ]

            text, pool = relocs[name]
            key = hashlib.sha1(repr((shapes[name], resolve(text), resolve(pool))).encode("utf-8", "surrogateescape")).hexdigest()
            new[name] = ids.setdefault(key, len(ids))
        klass = new
        if len(ids) == count:
            break
        count = len(ids)

    members: dict[int, list[str]] = defaultdict(list)
    for name in names:
        members[klass[name]].append(name)
    return [sorted(group_, key=lambda n: (candidates[n].obj.name, n)) for group_ in members.values() if len(group_) > 1]


# ---------------------------------------------------------------------------
# The rewrite
# ---------------------------------------------------------------------------


def plan(members: list[tuple[str, bytes]], keep: list[str]) -> tuple[list[list[str]], dict[str, Function], list[Object]]:
    objects = [Object(name, data) for name, data in members if data[:4] == b"\x7fELF"]
    candidates, _ = find_functions(objects, keep)
    taken = taken_addresses(objects, candidates)
    foldable = {name for name in candidates if name not in taken}
    return group(candidates, foldable), candidates, objects


def fold(archive: Path, objcopy: str, ar: str, keep: list[str], report: bool = False) -> tuple[int, int, int]:
    """Rewrite the archive in place (only list the groups with `report`).
    Returns (groups, functions folded away, bytes they held before linking)."""
    members = read_archive(archive.read_bytes())
    groups, candidates, objects = plan(members, keep)

    rename: dict[str, str] = {}
    for group_ in groups:
        for name in group_[1:]:
            rename[name] = group_[0]
    folded = sum(len(g) - 1 for g in groups)
    held = sum(candidates[n].size for g in groups for n in g[1:])
    if report:
        for group_ in sorted(groups, key=lambda g: -candidates[g[0]].size * (len(g) - 1)):
            print(f"{candidates[group_[0]].size * (len(group_) - 1):6d} {len(group_):3d}x {group_[0]}")
        return len(groups), folded, held
    if not rename:
        return len(groups), folded, held

    # Every object that defines a member or names one gets the renames; the
    # ones that define a group's function make that name weak.
    weak_names = {g[0] for g in groups}
    names_in = {}
    for obj in objects:
        names_in[obj.name] = {s.name for s in obj.symbols if s.bind != STB_LOCAL}
    by_name = {name: data for name, data in members}
    if len(by_name) != len(members):
        # `ar r` replaces members by name: with two of one name it could not
        # say which.
        print(f"fold_identical_code: {archive.name} has two members of one name, not folding", file=sys.stderr)
        return 0, 0, 0

    with tempfile.TemporaryDirectory(prefix="fold_identical_") as tmp:
        work = Path(tmp)
        changed: list[str] = []
        for obj in objects:
            names = names_in[obj.name]
            mine = {old: new for old, new in rename.items() if old in names}
            defines = {
                s.name if s.name not in rename else rename[s.name]
                for s in obj.symbols
                if s.bind != STB_LOCAL and s.shndx != SHN_UNDEF and (s.name in rename or s.name in weak_names)
            }
            if not mine and not defines:
                continue
            index = len(changed)
            target = work / obj.name
            target.write_bytes(by_name[obj.name])
            # objcopy takes one old name per new name in a pass: a module
            # that holds three copies of one hook takes three.
            passes: list[dict[str, str]] = []
            for old, new in sorted(mine.items()):
                for renames in passes:
                    if new not in renames.values():
                        renames[old] = new
                        break
                else:
                    passes.append({old: new})
            for step, renames in enumerate(passes or [{}]):
                command = [objcopy]
                if renames:
                    syms = work / f"syms{index}_{step}.txt"
                    syms.write_text("".join(f"{old} {new}\n" for old, new in renames.items()))
                    command.append(f"--redefine-syms={syms}")
                if step == len(passes or [{}]) - 1:
                    command += [f"--weaken-symbol={name}" for name in sorted(defines)]
                subprocess.run([*command, str(target)], check=True)
            changed.append(obj.name)
        # `ar r` replaces each member where it stands and rewrites the index.
        for start in range(0, len(changed), 200):
            subprocess.run([ar, "r", str(archive.resolve()), *changed[start : start + 200]], check=True, cwd=work)
    return len(groups), folded, held


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--objcopy", required=True)
    parser.add_argument("--ar", required=True)
    parser.add_argument("--keep", action="append", default=[], help="leave the objects whose name contains this alone")
    parser.add_argument("--report", action="store_true", help="list the groups")
    parser.add_argument("archive", type=Path)
    args = parser.parse_args(argv)
    groups, folded, held = fold(args.archive, args.objcopy, args.ar, args.keep, args.report)
    print(f"fold_identical_code: {folded} functions in {groups} groups folded to one copy each ({held} bytes before linking)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
