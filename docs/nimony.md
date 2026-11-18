# Nimony (Nim 3) and FrameOS

[Nimony](https://nimony.org/) is the new Nim compiler, the implementation of
Nim 3. The question was whether anything stops FrameOS moving to it, with an
eye on the ESP32 image, where flash is the budget.

**Short answer: yes, several things, and most of them are outside FrameOS.**
Measured on 2026-11-18 against Nimony `3693daa2` (0.6.3 development):

- Nimony's runtime and stdlib do not build for the ESP32 target yet.
- None of the packages under the runtime compile (vmath, chroma, zippy,
  flatty, jsony, crunchy, nimsimd), so neither does pixie.
- FrameOS's own code leans on what Nim 3 changes most: exceptions with
  messages, the mutable `JsonNode`, nil refs, and strings handed to C as
  zero-terminated `cstring`.
- On a small program built for the ESP32-S3, Nimony's code is not smaller
  overall. Its `.text` is a third smaller and its `.rodata` twice as big.

Re-measure with `tools/nimony/probe.sh`, or run the **Nimony probe** workflow
by hand. Either way the report is a table per target with the first errors of
every module. It takes about a minute once Nimony is built, and building
Nimony takes about eight minutes.

## What the ESP32 image would need from Nimony first

The firmware compiles `src/embedded/embedded_main.nim` to C with
`--os:freertos --cpu:esp --mm:orc --exceptions:goto -d:useMalloc`
(`embedded/esp32/build_nim.sh`). Nimony accepts `--cpu:esp --os:freertos
--bits:32`, and then:

- **`std/posix` has no ABI for FreeRTOS** ("supported: Linux, macOS,
  FreeBSD, illumos"). Every module that reaches `os`, `times` or the posix
  error codes stops there. That is every package above and every FrameOS
  module except the leaves.
- **The allocator wants `mmap`** (`sys/mman.h`), which ESP-IDF does not have.
  The malloc-backed page path (`-d:nimAllocPagesViaMalloc`) does not compile
  (`c_malloc` undeclared). What does build is `-d:useLibc`, which is mimalloc
  on top of malloc: a second allocator in the image.
- **`--mm:orc` does not compile** (`system/upstream/orc.nim`). The default is
  `atomicArc`, so every refcount change is an atomic operation on the Xtensa.
- **The C does not compile with ESP-IDF's GCC 14 as written.** On the Xtensa,
  `NI32` is `long`, and the overflow builtins are handed `long*` where they
  want `int*`. GCC 14 rejects that by default, so the probe builds it with
  `-Wno-error=incompatible-pointer-types`. Both types are 32 bits there.
- **`{.emit.}` is pasted verbatim**: a backtick-quoted symbol
  (`` `result` = JS_NULL; ``) reaches the C as written. The QuickJS bridge
  (`js_runtime/burrito.nim`) has 17 of those.
- A bare `import tables` (no `std/`) resolves to a missing file inside the
  compiler's own tree. chroma's `names.nim` does this.

## The packages under the runtime

On this host, so that Nimony's stdlib is not in the way (`-d:pixieNoSimd`, as
on the ESP32):

| Package | Errors | What breaks |
|---|---:|---|
| vmath (and bumpy, pixie, everything above) | 5,280 | its generated swizzle templates (`x`/`y`/`z`/`w` on every vector type) are ambiguous calls under Nimony's overloading; `isNan`, pragmas |
| chroma | 3 | `import tables`, a `toTable` on an array, a type it cannot resolve |
| zippy | 2 | `CatchableError`, one type mismatch in the CRC code |
| crunchy | 12 | `CatchableError`, `openarray` (Nimony is case sensitive), nimsimd's `asm` |
| flatty | 68 | `var string\|seq[uint8]` parameters, its macros |
| jsony | 39 | macros (`getTypeImpl`, `NimNode`): Nim 3 replaces macros with compiler plugins |

All of these are Nim 2 libraries that FrameOS pins (`nimble.lock`) or keeps
in the tree (pixie). Moving would need Nim 3 versions of each, either upstream
or as forks in the tree as pixie is. vmath is the deep one, because
everything that draws stands on it.

## What FrameOS's own code would have to change

Counted in the 135 FrameOS and pixie modules the ESP32 image compiles
(43.6k lines; pixie is another 23.8k), and in parentheses across all of
`frameos/src` (606 files, 159k lines):

- **Exceptions become an `ErrorCode` enum.** There are no exception objects,
  no `as e`, no `e.msg`, and procs do not raise unless marked `{.raises.}`.
  The image has 271 `try` blocks and 311 raise sites, and 106 `except … as`
  lines read the exception (whole runtime: 298 and 384 `newException`). Logs
  that say why something failed would need another way to carry the text.
- **`std/json` is a different model.** Nimony's is a flat, read-only token
  tree with a cursor: no `%*`, no `[]=`, no `add`. Scene state, configs,
  events and values are mutable `JsonNode`s (548 lines in 45 image modules;
  3,881 `%*` lines in the whole runtime). Moving means either a rewrite of
  that layer or a port of Nim 2's `json` kept in the tree.
- **`ref`, `ptr`, `pointer` and proc types are not nil by default.** The image
  has 779 lines that mention `nil`. `{.feature: "lenientnils".}` per module
  is the stop-gap the porting guide offers, which is how Nimony's own stdlib
  ports are written today.
- **Strings lose their terminating zero.** A `cstring` of a string is a copy.
  The QuickJS bridge and the C edge convert constantly (200 `cstring` lines in
  20 image modules), so that is a copy per crossing on the device.
- **The borrow checker refuses `for x in someRef.items`**, because an alias
  could change the seq during the loop. The probe program had to iterate by
  index, and the runtime does this throughout.
- **Smaller ones**, each hit by the leaf modules the probe checks:
  - `set` of a plain integer is "too large" (`panel_shape.nim`'s `{1, 4, 8}`).
  - `.isNil` exists only for `cstring` (`pixel_ops.nim`).
  - A global of proc type needs an initial value (`scene_code_hooks.nim`).
  - `{.push boundChecks: off, overflowChecks: off, nimcall.}` is not accepted
    (`fos_table_probe.nim`).
  - Identifiers are case sensitive, and an unlabeled `break` does not leave a
    `block`.
- **Missing from Nimony's stdlib:** `strformat` (92 `fmt` / `&"` lines in the
  image, 280 overall), `xmltree` / `xmlparser` (the `xmlToJson` app),
  `asyncdispatch`. Async becomes "passive procs" (8 files on the Pi side).
  Threads, locks and channels have Nimony versions with other APIs (73 files).
  mummy and ws, the Pi's HTTP server and WebSocket, would need ports too.
- **Not there yet at all:** closure iterators (5 uses), and generics that
  leave out `[T]` (none in the image).

The one FrameOS module the probe checks that compiles unchanged is
`hal/entropy.nim`.

## The ESP32 image

The work that keeps the image small today is all Nim 2–specific, and a move
would start it again:

- `patched_dragonbox`, `patched_tableimpl` and `fos_table_probe.nim` (one
  probe loop instead of 47).
- `fold_nim_inlines.py` (~30 KB).
- `-d:pixieNoPpm` and the retired-apps work.

So the only fair measure today is one program written for both compilers.
`tools/nimony/probes/size_probe.nim` is the runtime's everyday shapes: a ref
object graph, strings split and built, a seq, a string-keyed `Table`, a parse
that fails, and one `exportc` entry, the way the firmware's C calls in. Both
compilers' builds print the same answer. Each build's C is compiled with the
IDF's `xtensa-esp32s3-elf-gcc -Os -ffunction-sections` and linked with
`--gc-sections` from that entry. libc stays out, because it is in the image
either way (`tools/nimony/xtensa_size.sh`).

| | Nim 2.2.4 | Nimony 0.6.3 |
|---|---:|---:|
| generated C | 13 files, 10,016 lines | 12 files, 17,785 lines |
| `.text` | 19,749 B | 13,164 B |
| `.rodata` | 11,468 B | 23,092 B |
| total | 31,385 B | 36,260 B |

- Nimony's `.text` is a third smaller. Nim 2's build carries a 3.2 KB string
  hash and a 3 KB float writer that Nimony's does not.
- Nimony adds a 10.4 KB table for parsing floats (`PowerOfFive128`), which
  would need what `patched_dragonbox` does for Nim 2.
- The probe's own procs grew: `build` from 550 to 701 bytes, `render` from 480
  to 765.
- Not counted: mimalloc (`-d:useLibc`) and the atomic refcounts' cost in
  cycles.

Nimony's design could plausibly save flash in a whole image in two places:

- An `ErrorCode` instead of exception objects with their type info and
  message strings.
- JSON as one flat buffer instead of a heap node per value, which would also
  help the PSRAM fragmentation the frames fight.

Neither can be measured until the stack compiles. Nothing measured here
suggests the move would win flash by itself.

## Where this leaves it

Not now. In order, before a port of FrameOS could even start:

1. A Nimony that targets ESP-IDF:
   - posix bindings for FreeRTOS, or a path that needs none;
   - a malloc-backed allocator that compiles;
   - `--mm:orc` or a non-atomic `arc`;
   - C that GCC 14 accepts for a 32-bit `long` target.
2. Nim 3 versions of vmath, chroma, zippy, flatty, jsony and crunchy, then
   pixie on top of them.
3. FrameOS's own port: the JSON layer, exceptions, nil annotations, the
   QuickJS string boundary, and a redo of the image's size work.

The first two are upstream's to do. The cheap thing to do here is to re-run
the probe when Nimony tags a release, and meanwhile keep shrinking the image
in Nim 2.
