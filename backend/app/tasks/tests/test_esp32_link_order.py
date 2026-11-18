from __future__ import annotations

import codecs
import importlib.util
import struct
from pathlib import Path

import pytest

# embedded/esp32/tools/link_order.py: the order FrameOS's objects stand in
# inside the ESP32-S3 image, so that a call reaches its target in three bytes
# (CALL8, 512 KB either way) instead of six. The build runs `emit` (order
# file -> the linker's --section-ordering-file script); `measure` and
# `optimize` read a finished build. Checked here: the names, the script, the
# instruction scan on hand-assembled bytes, the map reader, the search on a
# small layout, and the committed order file.

REPO_ROOT = Path(__file__).resolve().parents[4]
ESP32 = REPO_ROOT / "embedded" / "esp32"
TOOL = ESP32 / "tools" / "link_order.py"
ORDER = ESP32 / "link_order.txt"


def load_tool():
    spec = importlib.util.spec_from_file_location("link_order", TOOL)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_a_nim_object_is_named_by_its_source_path_whatever_wrote_it():
    tool = load_tool()
    plain = "@m..@sframeos@sinterpreter.nim.c.obj"
    assert tool.nim_key(plain) == "frameos/interpreter.nim"
    # nixpkgs' Nim writes the same name ROT13'd.
    scrambled = codecs.encode("@m..@sframeos@sinterpreter", "rot13") + ".nim.c.obj"
    assert scrambled.startswith("@z..@fsenzrbf")
    assert tool.nim_key(scrambled) == "frameos/interpreter.nim"
    # The stdlib wherever Nim is installed.
    assert tool.nim_key("@m..@s..@s..@s..@sopt@snim@slib@ssystem.nim.c.obj") == "nim/lib/system.nim"
    assert (
        tool.nim_key("@m..@s..@s..@s.choosenim@stoolchains@snim-2.2.4@slib@spure@sjson.nim.c.obj")
        == "nim/lib/pure/json.nim"
    )
    # A nimble package without its version and hash: a bumped pin keeps its line.
    sha = "0123456789abcdef0123456789abcdef01234567"
    package = f"@m..@s..@s..@sroot@s.nimble@spkgs2@sflatty-0.3.4-{sha}@sflatty@sbinny.nim.c.obj"
    assert tool.nim_key(package) == "pkgs/flatty/flatty/binny.nim"
    assert tool.nim_key("@m..@s..@spixie@ssrc@spixie@spaths.nim.c.obj") == "pixie/src/pixie/paths.nim"
    assert tool.nim_key("@membedded_main.nim.c.obj") == "embedded_main.nim"
    # The glue's C files are objects like any other.
    assert tool.nim_key("frameos_nim_glue.c.obj") is None
    assert tool.object_key("libframeos_nim.a", "frameos_nim_glue.c.obj") == "frameos_nim_glue.c.obj"
    assert tool.object_key("libmain.a", "fos_http.c.obj") == "fos_http.c.obj"
    assert tool.split_object("esp-idf/main/libmain.a(fos_http.c.obj)") == ("libmain.a", "fos_http.c.obj")
    assert tool.split_object("*fill*") is None


def write_nimcache(root: Path, names: list[str]) -> Path:
    nimcache = root / "nimcache"
    nimcache.mkdir()
    for name in names:
        (nimcache / name).write_text("/* generated */\n")
    (nimcache / "nimbase.h").write_text("")
    return nimcache


def test_emit_writes_the_objects_in_the_files_order(tmp_path):
    tool = load_tool()
    nimcache = write_nimcache(
        tmp_path,
        [
            "@m..@sframeos@sinterpreter.nim.c",
            "@m..@s..@s..@s..@sopt@snim@slib@ssystem.nim.c",
            "@m..@sframeos@snew_module.nim.c",
            "@m..@sapps@sdata@snewer@sapp.nim.c",
        ],
    )
    order = tmp_path / "link_order.txt"
    order.write_text(
        "# a comment\n"
        "libmain.a fos_http.c.obj\n"
        "libframeos_nim.a frameos/interpreter.nim   # trailing comment\n"
        "libframeos_nim.a nim/lib/system.nim\n"
        "libframeos_nim.a *\n"
        "libframeos_nim.a frameos/gone.nim\n"
        "libframeos_nim.a frameos_nim_glue.c.obj\n"
        "libframeos_quickjs.a quickjs_hot.c.obj\n"
    )
    out = tmp_path / "build" / "link_order.ld"
    assert tool.main(["emit", "--order", str(order), "--nimcache", str(nimcache), "--out", str(out)]) == 0
    sections = "(.literal .literal.* .text .text.*)"
    lines = [line.strip() for line in out.read_text().splitlines() if line.startswith("  *")]
    assert lines == [
        f"*libmain.a:fos_http.c.obj{sections}",
        # `@` is no character of a linker script's names: `?` stands for it.
        f"*libframeos_nim.a:?m..?sframeos?sinterpreter.nim.c.obj{sections}",
        f"*libframeos_nim.a:?m..?s..?s..?s..?sopt?snim?slib?ssystem.nim.c.obj{sections}",
        # `*`: the modules the file does not name, where the hub stands.
        f"*libframeos_nim.a:?m..?sapps?sdata?snewer?sapp.nim.c.obj{sections}",
        f"*libframeos_nim.a:?m..?sframeos?snew_module.nim.c.obj{sections}",
        # frameos/gone.nim has no object any more: no line.
        f"*libframeos_nim.a:frameos_nim_glue.c.obj{sections}",
        f"*libframeos_quickjs.a:quickjs_hot.c.obj{sections}",
    ]
    text = out.read_text()
    assert text.count(".flash.text : {") == 1 and text.rstrip().endswith("}")

    # The same text again leaves the file alone (the link depends on it).
    stamp = out.stat().st_mtime_ns
    assert tool.main(["emit", "--order", str(order), "--nimcache", str(nimcache), "--out", str(out)]) == 0
    assert out.stat().st_mtime_ns == stamp

    # No nimcache (the C3's thin client has no Nim runtime): no Nim module lines.
    assert tool.main(["emit", "--order", str(order), "--out", str(out)]) == 0
    lines = [line.strip() for line in out.read_text().splitlines() if line.startswith("  *")]
    assert lines == [
        f"*libmain.a:fos_http.c.obj{sections}",
        f"*libframeos_nim.a:frameos_nim_glue.c.obj{sections}",
        f"*libframeos_quickjs.a:quickjs_hot.c.obj{sections}",
    ]


def test_emit_reads_a_rot13_nimcache_with_the_same_order_file(tmp_path):
    tool = load_tool()
    scrambled = codecs.encode("@m..@sframeos@sinterpreter", "rot13") + ".nim.c"
    nimcache = write_nimcache(tmp_path, [scrambled])
    script = tool.emit_script([("libframeos_nim.a", "frameos/interpreter.nim")], nimcache)
    assert "*libframeos_nim.a:?z..?fsenzrbf?fvagrecergre.nim.c.obj(" in script


def test_an_order_file_with_a_mistake_is_refused(tmp_path):
    tool = load_tool()
    order = tmp_path / "link_order.txt"
    order.write_text("libmain.a fos_http.c.obj\nlibmain.a fos_http.c.obj\n")
    with pytest.raises(SystemExit, match="listed twice"):
        tool.read_order(order)
    order.write_text("libmain.a\n")
    with pytest.raises(SystemExit, match="expected"):
        tool.read_order(order)
    with pytest.raises(SystemExit, match="cannot name"):
        tool.ld_name("bad name(1).obj")


# Xtensa, little-endian, as the firmware's code is.
def call8(pc: int, target: int) -> bytes:
    offset = (target - ((pc & ~3) + 4)) >> 2
    offset &= (1 << 18) - 1
    return bytes([0x25 | ((offset & 3) << 6), (offset >> 2) & 0xFF, (offset >> 10) & 0xFF])


def l32r(pc: int, register: int, literal: int) -> bytes:
    offset = ((literal - ((pc + 3) & ~3)) >> 2) & 0xFFFF
    return bytes([(register << 4) | 1, offset & 0xFF, offset >> 8])


def callx8(register: int) -> bytes:
    return bytes([0xE0, register, 0x00])


MOV_N = bytes([0x2D, 0x0A])  # mov.n a2, a10: a two-byte instruction
RETW_N = bytes([0x1D, 0xF0])


def test_the_scan_finds_short_and_long_calls():
    tool = load_tool()
    base = 0x42000020
    # One literal pool (two addresses), then three functions.
    literal_at = base
    far_at = base + 8  # the callee
    near_at = base + 0x20  # calls it directly
    long_at = base + 0x40  # calls it through the pool, and calls ROM too
    rom = 0x400011F4

    text = bytearray(0x60)

    def put(address: int, data: bytes) -> int:
        text[address - base : address - base + len(data)] = data
        return address + len(data)

    put(literal_at, struct.pack("<II", far_at + 4, rom))
    put(far_at, bytes([0x36, 0x41, 0x00]) + MOV_N + RETW_N)  # entry a1, 32
    at = put(near_at, bytes([0x36, 0x41, 0x00]) + MOV_N)
    at = put(at, call8(at, far_at))
    put(at, RETW_N)
    at = put(long_at, bytes([0x36, 0x41, 0x00]))
    at = put(at, l32r(at, 8, literal_at))
    at = put(at, callx8(8))
    at = put(at, MOV_N)
    at = put(at, l32r(at, 8, literal_at + 4))
    at = put(at, callx8(8))
    # An L32R that is no call (the register is used for something else).
    at = put(at, l32r(at, 9, literal_at))
    at = put(at, callx8(8))
    put(at, RETW_N)

    def section(address, size, name, obj):
        return tool.Section(address, size, name, f"esp-idf/x/{obj}")

    sections = [
        section(literal_at, 8, ".literal.long", "libmain.a(a.c.obj)"),
        section(far_at, 8, ".text.far", "libframeos_nim.a(@m..@sframeos@sfar.nim.c.obj)"),
        section(near_at, 0x10, ".text.near", "libmain.a(a.c.obj)"),
        section(long_at, 0x20, ".text.long", "libmain.a(a.c.obj)"),
    ]
    calls, outside = tool.scan_calls(sections, base, bytes(text))
    found = [(sections[c.caller].name, sections[c.callee].name, c.callee_offset, c.long) for c in calls]
    assert found == [
        (".text.near", ".text.far", 0, False),
        (".text.long", ".text.far", 4, True),
    ]
    assert outside == 1  # the call into ROM: long whatever the order


MAP = """\
.iram0.text     0x40374404    0x18ed7
 .text.elsewhere
                0x40374404       0x10 esp-idf/main/libmain.a(a.c.obj)

.flash.text     0x42000020   0x285e90
                0x42000020                        _stext = .
 *libmain.a:a.c.obj(.literal .literal.* .text .text.*)
 .literal.short
                0x42000020        0x4 esp-idf/main/libmain.a(a.c.obj)
                                  0x8 (size before relaxing)
 .text.short    0x42000024       0x1e esp-idf/main/libmain.a(a.c.obj)
                                 0x24 (size before relaxing)
                0x42000024                short
 .text.a_function_with_a_name_too_long_for_the_column
                0x42000044       0x10 esp-idf/frameos_nim/libframeos_nim.a(@m..@sframeos@sfar.nim.c.obj)
 .text.empty    0x42000054        0x0 esp-idf/main/libmain.a(b.c.obj)
 *fill*         0x42000054        0x2
 .text          0x42000058        0x8 /opt/esp/tools/lib/libc.a(libc_a-memchr.o)

.flash.rodata   0x3c290020    0x78000
 .rodata.str    0x3c290020       0x10 esp-idf/main/libmain.a(a.c.obj)
"""


def test_the_map_reader_takes_flash_text_with_its_sizes_before_relaxing(tmp_path):
    tool = load_tool()
    path = tmp_path / "firmware.map"
    path.write_text(MAP)
    sections = tool.read_map(path)
    assert [(s.name, s.addr, s.size, s.before, tool.split_object(s.obj)) for s in sections] == [
        (".literal.short", 0x42000020, 4, 8, ("libmain.a", "a.c.obj")),
        (".text.short", 0x42000024, 0x1E, 0x24, ("libmain.a", "a.c.obj")),
        (
            ".text.a_function_with_a_name_too_long_for_the_column",
            0x42000044,
            0x10,
            0x10,
            ("libframeos_nim.a", "@m..@sframeos@sfar.nim.c.obj"),
        ),
        (".text", 0x42000058, 8, 8, ("libc.a", "libc_a-memchr.o")),
    ]


def test_the_search_puts_what_everyone_calls_in_the_middle():
    # With numpy where there is one, in plain Python otherwise: the same sums.
    tool = load_tool()
    # Four callers of 300 KB each and a hub they all call, the hub last: the
    # first two callers are over 512 KB away from it.
    sizes = [300_000, 300_000, 300_000, 300_000, 20_000]
    hub = 4
    rows = {(caller, 150_000, hub, 1_000): 10 for caller in range(4)}
    order, before, after = tool.search(sizes, rows, [0, 1, 2, 3, 4], [], tool.CALL_REACH, steps=400, seed=1)
    assert before == 20
    assert after == 0
    assert sorted(order) == [0, 1, 2, 3, 4]
    at = order.index(hub)
    assert at == 2, "two callers on each side of the hub"
    # The same seed gives the same order: the file is reproducible.
    again, _, _ = tool.search(sizes, rows, [0, 1, 2, 3, 4], [], tool.CALL_REACH, steps=400, seed=1)
    assert again == order
    # What cannot move is left after the movable objects, in its order.
    order, before, after = tool.search(sizes + [50_000], rows, [0, 1, 2, 3, 4], [5], tool.CALL_REACH, steps=400, seed=1)
    assert sorted(order) == [0, 1, 2, 3, 4] and after == 0


def test_the_committed_order_file_is_one_the_build_can_use(tmp_path):
    tool = load_tool()
    order = tool.read_order(ORDER)
    assert len(order) > 100
    assert {archive for archive, _ in order} <= set(tool.OWN_ARCHIVES)
    # One place for the Nim modules a later tree adds.
    assert [entry for entry in order if entry == ("libframeos_nim.a", "*")] == [("libframeos_nim.a", "*")]
    # The modules everything calls are in it by a path no install moves.
    nim = [key for archive, key in order if archive == "libframeos_nim.a"]
    assert "nim/lib/system.nim" in nim and "frameos/interpreter.nim" in nim
    assert not [key for key in nim if "@" in key or key.startswith("..")]
    script = tool.emit_script(order, None)
    assert script.count("(.literal .literal.* .text .text.*)") == len(
        [entry for entry in order if not entry[1].endswith(".nim") and entry[1] != "*"]
    )


def test_the_build_is_wired_to_the_order():
    cmake = (ESP32 / "CMakeLists.txt").read_text()
    assert "tools/link_order.py" in cmake and "--section-ordering-file=" in cmake
    assert "link_order.txt" in cmake
    assert "link_order.py\" measure" in (ESP32 / "ci_build_image.sh").read_text()
