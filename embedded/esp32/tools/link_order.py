#!/usr/bin/env python3
"""Lay the ESP32-S3 image's code out so that callers sit near what they call.

An Xtensa CALL8 is three bytes and reaches 512 KB either way. ESP-IDF builds
with -mlongcalls, so every call is first emitted as six bytes (L32R of the
address out of a literal pool, CALLX8) and the linker shrinks it to a CALL8
when the target turns out to be in reach. The image's code is 2.6 MB, the
Nim runtime's alone 1.2 MB, and the linker places objects in the order it met
them: Nim's `system`, `tables` and `json`, which everything calls, stood at
one end of that block, and a third of all calls in the image stayed long
(24,402 of 77,206 calls between functions in flash, 2026-11-18).

`link_order.txt` beside the project's CMakeLists.txt names the objects of
FrameOS's own archives in the order they should stand: what is called from
everywhere in the middle, what calls little of it (the codecs, pixie's raster
loops, QuickJS) at the ends. CMake turns it into a script for the linker's
--section-ordering-file (`emit`). Nothing else changes: same objects, same
code, fewer bytes per call and one instruction less to run.

    link_order.py emit     --order link_order.txt --nimcache DIR --out link_order.ld
    link_order.py measure  --build-dir build
    link_order.py optimize --build-dir build --out link_order.txt   (seconds with numpy)

`emit` is what a build runs. `measure` reads a finished build and says how
many calls are still long; ci_build_image.sh prints it, so an order gone stale
shows in the log. `optimize` writes a new order from a finished build: run it
when `measure` says an update is worth it (a new big module, before a
release), build again and commit the file. An order that is out of date costs
bytes, never correctness: an object the file does not name keeps the place the
linker gives it, a name with no object matches nothing.
"""

from __future__ import annotations

import argparse
import bisect
import codecs
import collections
import random
import re
import struct
import sys
from pathlib import Path
from typing import Iterable

# CALL8's offset is 18 bits of words: 524,288 bytes either way.
CALL_REACH = 1 << 19

# The archives whose objects the order may name: FrameOS's own code, all of it
# in flash and never run with the cache off. An ESP-IDF archive can hold
# functions the linker script moves to IRAM by name; those stay where the
# script puts them and are not ours to shuffle.
OWN_ARCHIVES = (
    "libmain.a",
    "libframeos_display.a",
    "libframeos_nim.a",
    "libframeos_quickjs.a",
    "libmonocypher.a",
)
NIM_ARCHIVE = "libframeos_nim.a"

# The line of the order file that stands for every Nim module it does not
# name (a module added since the order was made): beside the hub, where a
# newcomer is most likely in reach of what it calls.
REST = "*"

SECTION_PATTERNS = "(.literal .literal.* .text .text.*)"

HEADER = """\
# The order FrameOS's own objects stand in inside the ESP32-S3 image's flash
# text, written by `tools/link_order.py optimize` from a finished build and
# read by the build (CMakeLists.txt -> `link_order.py emit`). A CALL8 reaches
# 512 KB: what everything calls stands in the middle. One object per line,
# `<archive> <object>`; a Nim module by its source path, `*` for every Nim
# module not named here. Edit by running the tool, not by hand.
"""


# --------------------------------------------------------------------------
# Names
# --------------------------------------------------------------------------


def normalize_nim_path(path: str) -> str:
    """A Nim-mangled module path as a source path that no install path moves.

    firmware_size.py's `_normalize_nim_path` with one more rule: a nimble
    package loses its version as well as its hash, so a bumped pin keeps its
    line in the order file.
    """
    path = path.replace("@m", "").replace("@s", "/")
    path = re.sub(r"^(\.\./)+", "", path)
    path = re.sub(r"^(?:.*?/)?nim(?:-\d[^/]*)?/lib/", "nim/lib/", path)
    path = re.sub(r"^.*?\.nimble/pkgs2?/", "pkgs/", path)
    path = re.sub(r"^pkgs/([^/]+?)-[0-9.]+-[0-9a-f]{40}/", r"pkgs/\1/", path)
    path = re.sub(r"^pkgs/([^/]+?)-[0-9a-f]{40}/", r"pkgs/\1/", path)
    return path


def nim_key(member: str) -> str | None:
    """`frameos/interpreter.nim` for `@m..@sframeos@sinterpreter.nim.c.obj`.

    None for a member that is no Nim module (the glue's C files). nixpkgs'
    Nim writes the name ROT13'd (`@z..@fsenzrbf@f...`): decoded here, so one
    order file serves both.
    """
    for suffix in (".nim.c.obj", ".nim.c"):
        if member.endswith(suffix):
            stem = member[: -len(suffix)]
            break
    else:
        return None
    if not stem.startswith("@"):
        return None
    if stem.startswith("@z"):
        stem = codecs.decode(stem, "rot13")
    return normalize_nim_path(stem) + ".nim"


def object_key(archive: str, member: str) -> str:
    if archive == NIM_ARCHIVE:
        key = nim_key(member)
        if key is not None:
            return key
    return member


def split_object(obj: str) -> tuple[str, str] | None:
    """('libmain.a', 'fos_http.c.obj') for the map's `path/libmain.a(fos_http.c.obj)`."""
    match = re.match(r"^(?:.*/)?(lib[^/()]+\.a)\((.*)\)$", obj)
    if not match:
        return None
    return match.group(1), match.group(2)


# --------------------------------------------------------------------------
# The order file and the linker script
# --------------------------------------------------------------------------


def read_order(path: Path) -> list[tuple[str, str]]:
    order: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for number, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) != 2:
            raise SystemExit(f"{path}:{number}: expected `<archive> <object>`, got {raw!r}")
        entry = (parts[0], parts[1])
        if entry in seen:
            raise SystemExit(f"{path}:{number}: {parts[0]} {parts[1]} is listed twice")
        seen.add(entry)
        order.append(entry)
    return order


def write_order(path: Path, order: Iterable[tuple[str, str]], note: str = "") -> None:
    lines = [HEADER]
    if note:
        lines.append("".join(f"# {row}\n" for row in note.splitlines()))
    lines.append("\n")
    lines.extend(f"{archive} {key}\n" for archive, key in order)
    path.write_text("".join(lines))


def ld_name(member: str) -> str:
    """A member name as the linker script's lexer takes it.

    `@` is no character of a script's file names (Nim's `@m`, `@s`): `?`
    matches it, and the rest of the name keeps the pattern to one object.
    """
    bad = set(member) - set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-+@")
    if bad:
        raise SystemExit(f"cannot name {member!r} in a linker script: {sorted(bad)}")
    return member.replace("@", "?")


def nim_members(nimcache: Path | None) -> dict[str, str]:
    """{module key: archive member} for the generated C in a nimcache."""
    members: dict[str, str] = {}
    if nimcache is None or not nimcache.is_dir():
        return members
    for source in sorted(nimcache.glob("*.nim.c")):
        member = source.name + ".obj"
        key = nim_key(member)
        if key is None:
            continue
        if key in members:
            raise SystemExit(f"two Nim modules are both {key}: {members[key]} and {member}")
        members[key] = member
    return members


def emit_script(order: list[tuple[str, str]], nimcache: Path | None) -> str:
    members = nim_members(nimcache)
    named = {key for archive, key in order if archive == NIM_ARCHIVE}
    rest = [members[key] for key in sorted(members) if key not in named]
    lines = [
        "/* Written by embedded/esp32/tools/link_order.py from link_order.txt: the\n"
        "   order FrameOS's objects stand in, callers near what they call. */\n",
        ".flash.text : {\n",
    ]

    def place(archive: str, member: str) -> None:
        lines.append(f"  *{archive}:{ld_name(member)}{SECTION_PATTERNS}\n")

    for archive, key in order:
        if archive == NIM_ARCHIVE and key == REST:
            for member in rest:
                place(archive, member)
        elif archive == NIM_ARCHIVE and key.endswith(".nim"):
            # A module the tree no longer has matches nothing; without a
            # nimcache (the C3's thin client) no Nim line is written at all.
            if key in members:
                place(archive, members[key])
        else:
            place(archive, key)
    lines.append("}\n")
    return "".join(lines)


# --------------------------------------------------------------------------
# Reading a finished build
# --------------------------------------------------------------------------


class Section:
    __slots__ = ("addr", "size", "before", "name", "obj")

    def __init__(self, addr: int, size: int, name: str, obj: str) -> None:
        self.addr = addr
        self.size = size
        self.before = size  # its size before the linker relaxed it
        self.name = name
        self.obj = obj


def read_map(map_path: Path) -> list[Section]:
    """The input sections of .flash.text, in address order."""
    sections: list[Section] = []
    pending: str | None = None
    inside = False
    last: Section | None = None
    entry = re.compile(r"^ (\S+)\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)\s+(\S.*)$")
    name_only = re.compile(r"^ (\S+)$")
    continued = re.compile(r"^\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)\s+(\S.*)$")
    before = re.compile(r"^\s+0x([0-9a-f]+) \(size before relaxing\)")
    with map_path.open(errors="replace") as handle:
        for line in handle:
            if line.startswith(".flash.text"):
                inside = True
                continue
            if inside and re.match(r"^\.\S", line):
                inside = False
            if not inside:
                continue
            match = before.match(line)
            if match and last is not None:
                last.before = int(match.group(1), 16)
                continue
            match = entry.match(line)
            if match:
                last = Section(int(match.group(2), 16), int(match.group(3), 16), match.group(1), match.group(4).strip())
                sections.append(last)
                pending = None
                continue
            match = name_only.match(line)
            if match:
                pending = match.group(1)
                continue
            match = continued.match(line)
            if match and pending:
                last = Section(int(match.group(1), 16), int(match.group(2), 16), pending, match.group(3).strip())
                sections.append(last)
                pending = None
    sections = [s for s in sections if s.size > 0 and split_object(s.obj) is not None]
    sections.sort(key=lambda s: s.addr)
    return sections


def read_flash_text(elf_path: Path) -> tuple[int, bytes]:
    """(address, bytes) of the ELF's .flash.text."""
    data = elf_path.read_bytes()
    if data[:4] != b"\x7fELF" or data[4] != 1 or data[5] != 1:
        raise SystemExit(f"{elf_path}: not a 32-bit little-endian ELF")
    shoff = struct.unpack_from("<I", data, 0x20)[0]
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", data, 0x2E)

    def header(index: int) -> tuple[int, int, int, int]:
        name, _type, _flags, addr, offset, size = struct.unpack_from("<IIIIII", data, shoff + index * shentsize)
        return name, addr, offset, size

    _, _, str_offset, str_size = header(shstrndx)
    names = data[str_offset : str_offset + str_size]
    for index in range(shnum):
        name, addr, offset, size = header(index)
        end = names.index(b"\0", name)
        if names[name:end] == b".flash.text":
            return addr, data[offset : offset + size]
    raise SystemExit(f"{elf_path}: no .flash.text section")


class Call:
    __slots__ = ("caller", "caller_offset", "callee", "callee_offset", "long")

    def __init__(self, caller: int, caller_offset: int, callee: int, callee_offset: int, long: bool) -> None:
        self.caller = caller  # index into the sections
        self.caller_offset = caller_offset
        self.callee = callee
        self.callee_offset = callee_offset
        self.long = long


def scan_calls(sections: list[Section], base: int, text: bytes) -> tuple[list[Call], int]:
    """Every call from flash code to flash code, and how many leave flash.

    Instructions are walked by length (an op0 of 8 and up is a two-byte
    density instruction, anything else three bytes); the literal pools are
    sections of their own in the map and are skipped. A long call is an L32R
    into a register and a CALLX8 through it, the pair -mlongcalls emits.
    """
    end = base + len(text)
    starts = [s.addr for s in sections]

    def section_at(address: int) -> int | None:
        index = bisect.bisect_right(starts, address) - 1
        if index >= 0 and sections[index].addr <= address < sections[index].addr + sections[index].size:
            return index
        return None

    calls: list[Call] = []
    outside = 0
    for index, section in enumerate(sections):
        if section.name.startswith(".literal"):
            continue
        if not (base <= section.addr and section.addr + section.size <= end):
            continue
        blob = text[section.addr - base : section.addr - base + section.size]
        at = 0
        loaded: tuple[int, int] | None = None  # (register, literal address) of the L32R just before
        while at < section.size:
            first = blob[at]
            op0 = first & 0xF
            length = 2 if op0 >= 8 else 3
            if at + length > section.size:
                break
            pc = section.addr + at
            now: tuple[int, int] | None = None
            target: int | None = None
            long = False
            if op0 == 5 and (first >> 4) & 3 == 2:  # CALL8
                offset = (first >> 6) | (blob[at + 1] << 2) | (blob[at + 2] << 10)
                if offset & (1 << 17):
                    offset -= 1 << 18
                target = ((pc & ~3) + 4 + (offset << 2)) & 0xFFFFFFFF
            elif op0 == 0 and blob[at + 2] == 0 and (blob[at + 1] >> 4) == 0 and (first >> 4) == 0xE:  # CALLX8
                if loaded is not None and loaded[0] == (blob[at + 1] & 0xF) and base <= loaded[1] < end - 3:
                    target = struct.unpack_from("<I", text, loaded[1] - base)[0]
                    long = True
            elif op0 == 1:  # L32R
                literal = (((pc + 3) & ~3) + (((blob[at + 1] | (blob[at + 2] << 8)) | ~0xFFFF) << 2)) & 0xFFFFFFFF
                now = (first >> 4, literal)
            if target is not None:
                callee = section_at(target) if base <= target < end else None
                if callee is None:
                    outside += 1
                else:
                    calls.append(Call(index, at, callee, target - sections[callee].addr, long))
            loaded = now
            at += length
    return calls, outside


class Build:
    """A finished build's flash text: its objects in place, and its calls."""

    def __init__(self, build_dir: Path) -> None:
        maps = sorted(build_dir.glob("*.map"))
        elfs = [p for p in sorted(build_dir.glob("*.elf")) if not p.name.startswith("bootloader")]
        if len(maps) != 1 or len(elfs) != 1:
            raise SystemExit(f"{build_dir}: expected one .map and one .elf, found {len(maps)} and {len(elfs)}")
        self.sections = read_map(maps[0])
        base, text = read_flash_text(elfs[0])
        self.calls, self.outside = scan_calls(self.sections, base, text)

        # Objects in the order they stand; a section's place inside its object
        # in the sizes the linker saw BEFORE relaxing, which is what it
        # measures a call's distance in.
        self.objects: list[tuple[str, str]] = []
        self.object_of: list[int] = []
        self.offset_in_object: list[int] = []
        self.object_size: list[int] = []
        index: dict[tuple[str, str], int] = {}
        for section in self.sections:
            split = split_object(section.obj)
            assert split is not None
            at = index.get(split)
            if at is None:
                at = index[split] = len(self.objects)
                self.objects.append(split)
                self.object_size.append(0)
            self.object_of.append(at)
            self.offset_in_object.append(self.object_size[at])
            self.object_size[at] += (section.before + 3) & ~3

    def site(self, section: int, offset: int) -> tuple[int, int]:
        """(object, offset inside it before relaxing) of a place in a section."""
        s = self.sections[section]
        scaled = offset * s.before // s.size if s.size else 0
        return self.object_of[section], self.offset_in_object[section] + scaled


def measure(args: argparse.Namespace) -> int:
    build = Build(Path(args.build_dir))
    long_calls = sum(1 for call in build.calls if call.long)
    own = sum(1 for call in build.calls if call.long and build.objects[build.object_of[call.caller]][0] in OWN_ARCHIVES)
    print(
        f"link_order: {len(build.calls):,} calls between functions in flash, {long_calls:,} of them long "
        f"({own:,} from FrameOS's own code, 3 bytes each to win); {build.outside:,} more go to ROM or IRAM, always long"
    )
    if args.order:
        order = read_order(Path(args.order))
        present = {(archive, object_key(archive, member)) for archive, member in build.objects}
        named = set(order)
        stale = sorted(entry for entry in named if entry[1] != REST and entry not in present)
        new = sorted(
            entry for entry in present if entry[0] in OWN_ARCHIVES and entry not in named and entry[0] != NIM_ARCHIVE
        )
        new_nim = sorted(
            entry for entry in present if entry[0] == NIM_ARCHIVE and entry not in named and entry[1].endswith(".nim")
        )
        if stale:
            print(f"link_order: {len(stale)} entries of {args.order} match no object now: " + ", ".join(k for _, k in stale[:8]))
        if new or new_nim:
            fresh = [k for _, k in (new + new_nim)[:8]]
            print(f"link_order: {len(new) + len(new_nim)} objects are not in {args.order} yet: " + ", ".join(fresh))
    return 0


# --------------------------------------------------------------------------
# Finding an order
# --------------------------------------------------------------------------


def search(
    sizes: list[int],
    rows: dict[tuple[int, int, int, int], int],
    movable: list[int],
    fixed: list[int],
    reach: int,
    steps: int,
    seed: int,
    temperature: float = 6.0,
    from_scratch: bool = False,
) -> tuple[list[int], int, int]:
    """An order of `movable` that leaves few calls out of reach.

    `sizes` is each object's bytes; `rows` counts the calls between two
    objects, keyed (caller object, offset in it, callee object, offset in it);
    the movable objects stand first in the image, the fixed ones after them in
    the order given. Returns (order, long calls before, long calls after).
    Simulated annealing: move one object, move a run of neighbours, swap two.
    Seeded, so the same build gives the same file.
    """
    import math

    try:
        import numpy as np
    except ImportError:  # the same sums in plain Python: minutes, not seconds, on a real image
        np = None

    count = len(sizes)
    table = [(*key, weight) for key, weight in sorted(rows.items())]
    if np is not None:
        size = np.array(sizes, dtype=np.int64)
        columns = np.array(table, dtype=np.int64).reshape(len(table), 5)
        caller_object, caller_at, callee_object, callee_at, weight = (columns[:, i] for i in range(5))

        def long_calls(order_of_movable: list[int]) -> int:
            order = np.array(order_of_movable + fixed, dtype=np.int64)
            position = np.zeros(count, dtype=np.int64)
            position[order] = np.concatenate(([0], np.cumsum(size[order])[:-1]))
            distance = np.abs(position[caller_object] + caller_at - position[callee_object] - callee_at)
            return int(weight[distance >= reach].sum())

    else:

        def long_calls(order_of_movable: list[int]) -> int:
            position = [0] * count
            at = 0
            for index in order_of_movable + fixed:
                position[index] = at
                at += sizes[index]
            return sum(
                weight
                for caller, caller_at, callee, callee_at, weight in table
                if abs(position[caller] + caller_at - position[callee] - callee_at) >= reach
            )

    incoming = [0] * count
    for row in table:
        incoming[row[2]] += row[4]

    current = list(movable)
    before = long_calls(current)
    if from_scratch:
        # What is called most, 200 KB of it, in the middle of the rest.
        hub: list[int] = []
        hub_bytes = 0
        for index in sorted(movable, key=lambda i: (-incoming[i], i)):
            if hub_bytes >= 200_000:
                break
            hub.append(index)
            hub_bytes += sizes[index]
        in_hub = set(hub)
        rest = [i for i in movable if i not in in_hub]
        half = (sum(sizes[i] for i in movable) - hub_bytes) // 2
        left: list[int] = []
        taken = 0
        while rest and taken < half:
            taken += sizes[rest[0]]
            left.append(rest.pop(0))
        current = left + hub + rest

    rng = random.Random(seed)
    current_count = long_calls(current)
    best, best_count = list(current), current_count
    for step in range(steps):
        heat = temperature * (1 - step / steps) + 0.01
        candidate = list(current)
        kind = rng.random()
        if kind < 0.6:
            item = candidate.pop(rng.randrange(len(candidate)))
            candidate.insert(rng.randrange(len(candidate) + 1), item)
        elif kind < 0.9:
            start = rng.randrange(len(candidate))
            stop = min(len(candidate), start + rng.randrange(2, 13))
            run = candidate[start:stop]
            del candidate[start:stop]
            at = rng.randrange(len(candidate) + 1)
            candidate[at:at] = run
        else:
            a, b = rng.randrange(len(candidate)), rng.randrange(len(candidate))
            candidate[a], candidate[b] = candidate[b], candidate[a]
        candidate_count = long_calls(candidate)
        if candidate_count <= current_count or rng.random() < math.exp((current_count - candidate_count) / heat):
            current, current_count = candidate, candidate_count
            if candidate_count < best_count:
                best, best_count = list(candidate), candidate_count
    return best, before, best_count


def optimize(args: argparse.Namespace) -> int:
    try:
        import numpy  # noqa: F401
    except ImportError:
        print("link_order: no numpy here, this will take a quarter of an hour (uv run --with numpy ... is seconds)")

    build = Build(Path(args.build_dir))
    count = len(build.objects)
    movable = [i for i, (archive, _) in enumerate(build.objects) if archive in OWN_ARCHIVES]
    in_movable = set(movable)
    fixed = [i for i in range(count) if i not in in_movable]

    # A call inside one object never changes; calls between the same two
    # places (to the kilobyte) are one row with a weight.
    rows: collections.Counter[tuple[int, int, int, int]] = collections.Counter()
    incoming: collections.Counter[int] = collections.Counter()
    for call in build.calls:
        caller_object, caller_at = build.site(call.caller, call.caller_offset)
        callee_object, callee_at = build.site(call.callee, call.callee_offset)
        if caller_object == callee_object:
            continue
        rows[(caller_object, caller_at >> 10 << 10, callee_object, callee_at >> 10 << 10)] += 1
        incoming[callee_object] += 1

    in_image = sum(1 for call in build.calls if call.long)
    best, before, after = search(
        build.object_size, rows, movable, fixed, args.reach, args.steps, args.seed, args.temperature, args.from_scratch
    )
    print(f"link_order: {in_image:,} long calls in this image; the model counts {before:,} for its order (reach {args.reach:,})")
    print(f"link_order: after {args.steps:,} steps the model counts {after:,}")

    # The file: every own object by its key; `*` after the most-called Nim
    # object, for the modules a later tree adds.
    nim = [i for i in best if build.objects[i][0] == NIM_ARCHIVE]
    hub_object = max(nim, key=lambda i: (incoming[i], -i)) if nim else None
    order: list[tuple[str, str]] = []
    for index in best:
        archive, member = build.objects[index]
        order.append((archive, object_key(archive, member)))
        if index == hub_object:
            order.append((NIM_ARCHIVE, REST))
    note = f"From a build with {len(build.calls):,} calls between functions in flash; the model leaves {after:,} long."
    write_order(Path(args.out), order, note)
    print(f"link_order: wrote {args.out} ({len(order)} lines); build again and run `measure` for the real count")
    return 0


def emit(args: argparse.Namespace) -> int:
    order = read_order(Path(args.order))
    script = emit_script(order, Path(args.nimcache) if args.nimcache else None)
    out = Path(args.out)
    # Unchanged text keeps its timestamp: the link depends on this file.
    if not out.exists() or out.read_text() != script:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(script)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    emit_parser = commands.add_parser("emit", help="write the linker's section ordering script from the order file")
    emit_parser.add_argument("--order", required=True)
    emit_parser.add_argument("--nimcache", help="the generated Nim C files (their names give the Nim objects)")
    emit_parser.add_argument("--out", required=True)
    emit_parser.set_defaults(run=emit)

    measure_parser = commands.add_parser("measure", help="count the calls a finished build left long")
    measure_parser.add_argument("--build-dir", required=True)
    measure_parser.add_argument("--order", help="also say what the order file misses")
    measure_parser.set_defaults(run=measure)

    optimize_parser = commands.add_parser("optimize", help="write a new order file from a finished build (quick with numpy)")
    optimize_parser.add_argument("--build-dir", required=True)
    optimize_parser.add_argument("--out", required=True)
    optimize_parser.add_argument("--steps", type=int, default=250_000)
    optimize_parser.add_argument("--seed", type=int, default=20261118)
    optimize_parser.add_argument("--temperature", type=float, default=6.0)
    # In the sizes before relaxing, with room for the image to grow before a
    # call near the limit goes long again.
    optimize_parser.add_argument("--reach", type=int, default=CALL_REACH - 32 * 1024)
    optimize_parser.add_argument("--from-scratch", action="store_true", help="ignore the build's own order as a start")
    optimize_parser.set_defaults(run=optimize)

    args = parser.parse_args(argv)
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
