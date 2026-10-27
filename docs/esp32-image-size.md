# ESP32 firmware image size analysis

*Snapshot: 2026-08-06, `build/frameos_esp32.bin` = 3,170,784 bytes (3.02 MiB).
ESP32-S3, ESP-IDF 5.5.4, dev 32MB sdkconfig, `-Os`, log level WARN, assertions on.*

> **Update (same day):** levers 1 and 2 below are now applied — the asset
> generator emits raw gzip bytes instead of base64
> (`tools/generate_compressed_asset_nim.py`), and the CA bundle is the common
> subset (`CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_DEFAULT_CMN` in
> `sdkconfig.defaults`). Measured result: font 195,060 → 146,350 bytes,
> x509 bundle 68,987 → 17,928 bytes, **bin 3,170,784 → 3,073,632 bytes
> (−97,152)**. The 8 MB layout is now ~85% full (~519 KB free). Pi builds
> shrink too: web/frame_web/repo_scenes assets lose the same 33% base64
> overhead. The table below still shows pre-fix numbers.

The image is 2.27 MB of code (`.text`) plus 0.77 MB of read-only data, all
executed/read in place from memory-mapped flash. Roughly a third is the
Nim/QuickJS application layer, a third is ESP-IDF + networking, and a third is
data blobs (font, certs, string literals, unicode tables).

## Automated tracking (CI)

Every PR build (`.github/workflows/e2e-docker.yml`, job `esp32_firmware_image`)
runs `embedded/esp32/tools/firmware_size.py measure` from `ci_build_image.sh`,
which writes `firmware-size.json` next to the binaries: totals, OTA-slot
headroom, the per-subsystem breakdown below (with the nimcache names
demangled) and a one-level drill-down *inside* each subsystem — the Nim core by
directory, the apps by app, the Nim packages by package, pixie and the stdlib
by module, the ESP-IDF halves by archive. The drill-down is computed over every
object in the map, not just the largest ones, so each table adds up to its
subsystem total; the comment renders it under "Inside each subsystem". The
subsystems our own changes move — the Nim core, the apps, pixie, the Nim
stdlib, "ESP-IDF misc" and the `fos_*` shell — are listed **in full**, every
row; the rest (Wi-Fi blobs, TLS, libc, the 80-odd panel drivers) are cut at
`render --detail-top N` (default 12) with the remainder folded into one row so
the table still adds up. Edit `DETAIL_FULL_GROUPS` in `firmware_size.py` to
move a subsystem between the two.
The `esp32_firmware_size_report` job then posts ONE sticky
"ESP32 firmware size" comment on the PR — edited in place on every push, never
a commit — comparing the build with the latest GitHub release. Releases publish
their own document as `frameos-<version>-esp32-{s3,c3}-generic-size.json`, so
the comparison is per subsystem and per object once the baseline release
carries one, and totals-only (from the release asset byte counts) before that.

```bash
# The same report locally, against the latest release:
cd embedded/esp32 && source ~/esp/esp-idf/export.sh
python tools/firmware_size.py measure --build-dir build --platform esp32-s3 \
  --app-slot-bytes $((3520*1024)) --flash-bytes $((8*1024*1024)) --out build/firmware-size.json
gh release download --repo FrameOS/frameos --pattern '*-esp32-s3-generic-size.json' --dir /tmp/base
python tools/firmware_size.py render --current build/firmware-size.json --baseline /tmp/base/*.json
```

## How to reproduce this breakdown

```bash
cd embedded/esp32
source ~/esp/esp-idf/export.sh
python -m esp_idf_size --archives build/frameos_esp32.map   # per static library
python -m esp_idf_size --files    build/frameos_esp32.map   # per object file
python -m esp_idf_size --format json --files build/frameos_esp32.map  # full names
```

Two gotchas when reading the output:

1. **Nimcache object names are mangled, and sometimes ROT13'd on top.** Nim
   flattens a module path into one filename as `@m` + path with `@s` for the
   separator (`compiler/modulepaths.nim`), so `frameos/interpreter.nim` becomes
   `@m..@sframeos@sinterpreter.nim.c.obj`. Whether that name is *also*
   ROT13-scrambled (`@z..@fsenzrbf@fvagrecergre.nim.c.obj`) depends on the Nim
   build: the official 2.2.4 tarball in the Docker/CI image emits the plain
   form, nixpkgs' Nim (the flox dev shell) applies `mangleModuleName`'s ROT13.
   ROT13 is its own inverse, so decode *only* names that start with `@z` —
   decoding unconditionally re-scrambles the CI names, and then every
   `pixie`/`nim/lib`/`apps/` bucket rule misses and the whole Nim archive lands
   in one "FrameOS core (Nim)" row. `firmware_size.py` handles both forms.
2. **The linker misattributes the merged string pool.** See the "efuse" row
   below.

## Breakdown by subsystem

Flash totals (`.text` + `.rodata`) grouped from the per-object JSON output.
Sum ≈ 3.15 MB; the bin adds headers/padding.

| Subsystem | Flash | Notes |
|---|---:|---|
| FrameOS apps (Nim) | 377 KB | calendar+ical alone = 85 KB (ical 42K, app 23K, loader 21K); chart 18K, immich 16K, wikicommons 15K, openaiImage 12K, unsplash 10K, beRecycle 9K, weather 9K |
| QuickJS engine | 350 KB | quickjs.c 277K + libunicode tables 50K + regexp 14K |
| FrameOS core (Nim) | 349 KB | interpreter 80K; js_runtime ~155K (app_runtime 51K, transpiler 51K, runtime 27K, tokens 16K, parser 6K, source_map 5K); utils/image 20K; exif 9K |
| Wi-Fi stack (Espressif blobs) | 293 KB | net80211, pp, phy, wpa_supplicant |
| pixie | 241 KB | opentype 55K, webp 37K, paths 27K, svg 22K, jpeg 20K, png 18K, fonts 11K |
| Nim stdlib | 233 KB | biggest single objects 61K + 42K (system/strutils graph) |
| ESP-IDF misc | 214 KB | FreeRTOS, SPI/I2C/GPIO drivers, heap, HAL, VFS |
| Embedded font | 195 KB | one font, base64-inflated — see below |
| mbedTLS + CA bundle | 176 KB | full x509 cert bundle is 69 KB of that |
| String pool (shown as "efuse") | 161 KB | see below |
| lwIP / HTTP / WebSocket | 156 KB | |
| libc/libm/newlib | 129 KB | vfprintf family ~40 KB (float printf, two variants) |
| SPIFFS/FatFS/SD/NVS | 69 KB | |
| Display drivers (C) | 58 KB | all 81 panels; each EPD driver is only ~1–2 KB, panel table 6 KB |
| fos_* firmware shell (C) | 57 KB | fos_http 15K (includes HTML setup page), fos_cloud 11K |
| QRgen / chrono / zippy / chroma / monocypher / crunchy | 89 KB | |

## Two things that are not what they appear

**"efuse" is fake.** `esp_idf_size` shows ~160 KB of rodata in
`libefuse.a:esp_efuse_utility.c.obj`. That section is
`.rodata.write_reg.str1.1` — the linker's *merged string-literal pool for the
entire firmware*, attributed to the first object that contributes to it.
Extracting the region shows ~5,200 deduplicated C strings: mostly ESP-IDF
`E (%lu) %s: ...` log/assert messages (many with full source paths), TLS
cipher-suite names, error tables, and the fos_http setup-page HTML. Real efuse
code is ~2 KB.

**One font costs 195 KB, a third of it wasted.** `src/assets/fonts.nim`
(generated by `tools/generate_compressed_asset_nim.py`) embeds a single font —
`Ubuntu-Regular.ttf`, 300 KB raw — as gzip **then base64** (~146 KB gzip →
195 KB base64). The base64 step inflates the payload by 33% for no benefit at
runtime.

## Headroom

| Layout | OTA slot | Usage |
|---|---:|---|
| 8 MB (CI default, reference hardware) | 3520 K | **~88% full, ~430 KB free** |
| 16 MB / 32 MB | 0x3F0000 (4032 K) | ~950 KB free |

## Size levers, cheapest first

1. ~~**De-base64 the font** (−49 KB)~~ — **done**, generator now emits raw
   gzip bytes as escaped Nim string literals.
2. ~~**CA bundle → common roots** (−51 KB)~~ — **done**, common bundle covers
   ISRG/Let's Encrypt, DigiCert, Amazon, Google, GlobalSign, Sectigo, GoDaddy,
   IdenTrust etc.; private CAs were never in the full bundle either.
3. ~~**Silent assertions + checks + no esp_err name table**~~ — **done**
   (`CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_SILENT`,
   `CONFIG_COMPILER_OPTIMIZATION_CHECKS_SILENT`, `ESP_ERR_TO_NAME_LOOKUP=n`).
   Measured −89.6 KB, far more than the string pool alone: 51.9 KB of it is
   pool text, the rest is the assert *branches* the compiler can now drop
   (HAL −7.2 K, lwIP −9.2 K, FreeRTOS −3.3 K, QuickJS −3.4 K, SPI −3.5 K, ...).
4. ~~**Drop pixie's PPM codec**~~ — **done**, `-d:pixieNoPpm` (FrameOS/pixie#6),
   −5.7 KB. WebP (38 K), GIF (5.9 K) and BMP (8.2 K) are still in; they at
   least correspond to formats a URL might serve. Until 2026-10-27
   `utils/image.nim` imported the PPM module for its streaming path anyway,
   which linked the streaming decoder back in (3.5 KB); it honours the flag now.
5. ~~**Strip the embedded font**~~ — **done** (2026-10-27),
   `tools/generate_embedded_font.py` makes `assets/compiled/fonts/Ubuntu-Regular.ttf`
   from the original in `assets/copied/fonts` without the TrueType hinting,
   `hdmx`, `VDMX`, `GSUB` and glyph names, none of which pixie reads:
   146,125 → 57,645 B gzipped, −88.5 KB of image, every glyph, advance and
   kerning pair unchanged (its `--check`, run by the backend suite). A Latin
   subset would take about 25 KB more, at the cost of blank glyphs for scenes
   that render Greek or Cyrillic.
6. **Move the font to SPIFFS** (−146 KB per OTA slot): the `state` partition
   has room on every profile except 4 MB. Bigger job than 5 (provisioning +
   boot-time load) but takes the weight out of *both* slots.
7. **Config-gate heavy optional apps** (~100–200 KB): calendar+ical is 97 KB;
   wikicommons/openai/unsplash/chart add up. Breaks "any scene runs on any
   frame", so this is a firmware-variant decision, not a flag.
8. ~~**Wi-Fi and TLS a frame does not use**~~ — **done** (2026-10-27),
   `sdkconfig.defaults`: no WPA3 on the setup hotspot, no SAE-PK, no OWE
   (−11.6 KB); no curves beyond P-256/P-384/P-521/X25519, no static ECDH, no
   renegotiation, no CRL/CSR/PKCS#7 parsing, no server session tickets
   (−6.8 KB).

Checked and rejected: `CONFIG_NEWLIB_NANO_FORMAT` (~26 KB in `vfprintf` +
`svfprintf`) — nano formatting has no 64-bit integer conversions and the
firmware uses `%lld`/`%llu`/`%llx` 29 times, including cloud JSON timestamps.
Dropping the last `sscanf` call from FrameOS code does *not* remove newlib's
float-capable scanf either: ESP-IDF's `console` component calls it from
`linenoise.c`. mbedTLS' ARIA cipher (3.4 KB) has no Kconfig switch in IDF 5.5.
IPv6 (≈14 KB in `nd6`/`ip6`/`mld6`) is deliberately kept.

---

# The generated-Nim pass (2026-09-01)

*`esp32-s3`, 8 MB layout, `EPD_7in5_V2` default panel. Nine full
`ci_build_image.sh` builds; every number is a measured delta between two of
them, not an estimate.*

**3,286,224 → 3,210,560 bytes (−75,664, −2.30%). OTA slot 91.2% → 89.1% full,
393 KB free.** Nim is 45% of the image (1,474,196 B of the 3,264,613 the map
attributes); hand-written C for the whole firmware is 110,687.

## Where it came from

| change | delta |
|---|---:|
| App loaders describe their config fields in data instead of code | −60,896 |
| One CRC-32 table instead of two (crunchy → zippy) | −8,445 |
| App registry: a sorted proc table instead of four `case keyword:` chains | −4,618 |
| ASCII case folding where the input is ASCII | −1,632 |

**App loaders.** `backend/app/codegen/app_loader_nim.py` used to inline a full
JSON-coercion `block:` per config field, per app: 38 loaders, ~700 fields,
131,295 B — 4.0% of the whole firmware — and the calendar loader alone was 508
lines and 20,799 B. Each loader now emits a `const` table of field descriptors
(name, kind, byte offset inside its own `AppConfig`) and hands it to the two
shared procs in `frameos/app_config.nim`. Loaders: 131,295 → 68,550. Calendar:
20,799 → 7,084 B, 508 → 171 lines. The descriptor templates check the field's
Nim type at compile time, so a mismatch between `config.json` and the app's
`AppConfig` is still a compile error, as it was when every field carried its
own typed assignment.

Doing only the cheap half of this — replacing the inlined blocks with calls to
shared `cfgInt`/`cfgBool`/… procs — was worth just −28,864. The inlined blocks
were only ~60–90 B each; the weight was in having per-field *code* at all.

**Two CRC-32 tables.** crunchy (pixie's checksum dependency) and zippy ship the
same slicing-by-8 CRC-32, each with its own 8,192-byte compile-time table, and
both are linked. `config.nims` now `patchFile`s crunchy's `crc32` to forward to
zippy's on embedded builds only (`src/embedded/patched_crc32.nim`).

**ASCII case folding.** `std/unicode`'s `toLower`/`toUpper` were reached from
places whose input is ASCII by definition — RFC 5545 weekday tokens in
`ical.nim`, file-extension matching in `localImage` — and those are now
`toLowerAscii`/`toUpperAscii`. The filename *search* in `localImage`
deliberately still folds Unicode, so "Ä" keeps matching "ä"; that costs 1,568 B
and is worth it. The 9,872 B of `toUpperSinglets`/`toLowerSinglets` were never
going anywhere regardless: `--gc-sections` drops the procs but keeps the
tables.

## Compiler flags: measured, and mostly not levers

| variant | bin bytes | Δ |
|---|---:|---:|
| baseline | 3,286,224 | — |
| `--opt:speed` | 3,286,224 | 0 |
| `-flto` on the nimcache component | 3,281,504 | −4,720 |
| `--mm:arc` | 3,272,624 | −13,600 |
| `--panics:on` | 3,138,304 | **−147,920** |
| `-d:danger` | 3,123,760 | −162,464 |
| `-d:danger --panics:on` | 2,980,640 | −305,584 |

`--opt:speed` and `--opt:size` produce images differing in exactly 65 bytes —
the build timestamp and the appended SHA256. Under `--compileOnly` ESP-IDF
picks the optimization level and Nim's `--opt` flag never reaches a compiler.
The `--opt:size` in `build_nim.sh` is decorative.

LTO on the generated C works (the component's `-fno-lto` can simply be
dropped) and buys 4,720 B for ~75 s of build time. It notably does *not* fold
the 693 near-identical `=destroy` hooks: their addresses live in type
descriptors. Not worth it. `--mm:arc` buys 13,600 B — the whole cycle
collector — on a device where a leaked pixie `Image.root` cycle is worse than
0.4% of flash.

### Why `-d:danger` and `--panics:on` stack

Pattern counts over the generated `nimcache/*.c`:

| generated with | `if (*nimErr_) goto` | `raiseIndexError2` | `nimAddInt` | C bytes |
|---|---:|---:|---:|---:|
| baseline | 21,705 | 3,644 | 3,314 | 19,977,108 |
| `--panics:on` | 6,071 | 3,644 | 3,314 | 18,723,490 |
| `-d:danger` | 21,098 | 0 | 0 | 17,806,251 |
| `-d:danger --panics:on` | 6,072 | 0 | 0 | 16,582,020 |
| `--exceptions:quirky` | 0 | 3,644 | 3,315 | 18,138,999 |

They cut different things. `-d:danger` deletes the *checks* and still leaves
21,098 propagation sites standing — turning checks off does not make a proc
non-raising. `--panics:on` keeps every bounds, overflow and range check and
removes 72% of the propagation, at ~9.5 B per site. If only one of the two is
ever taken, it should be `--panics:on`: it is the one that keeps the checks.

**`--panics:on` is a product decision, not a safety one.** Every check stays.
What it costs is `except Defect`: `embedded_main.nim` and
`embedded_runtime.nim` wrap every C-API entry point in one — log,
`GC_fullCollect()`, re-arm the 1 MB emergency reserve, return a failure code —
and under panics those handlers go dead, so an out-of-memory render reboots the
frame instead of degrading. That containment design now has a price tag:
**148 KB**. To keep both, the escape hatch is the one already used for
`malloc`: `patchFile` `system/fatal.nim` and longjmp to a barrier at the render
entry (the shape of the wasm simulator's setjmp guard), accepting that ARC
destructors are skipped on that path and one render's allocations leak.

**`--exceptions:quirky` is a trap.** It removes all propagation and produces
the smallest C of any variant, and on the C backend a raise does not unwind at
all: `raiseExceptionAux` calls `pushCurrentException` and *returns*. Verified
on the host — execution continues past the `raise`, the proc returns garbage,
and the handler fires only after everything downstream has run on corrupt
state.

## The 52 hash tables

Nim emits a full copy of the hash-table implementation per `Table[K, V]` pair.
The image has 52 of them, `tables.nim.c.obj` is 70,601 B — about 1,358 B each.
They are genuinely different pairs, not accidents: `NI -> AppRoot*`,
`NI -> DiagramNode*`, `NI -> FrameScene*`, `NI -> ExportedScene*`,
`NI -> JsonNodeObj*`, `NI -> ImageFusionPlan*`, `NI -> ImageBoundsPlan*`,
`NimStringV2 -> ExportedInterpretedScene*`, `ptr JSContext -> JsAppRuntime*` …

Consolidating the pointer-valued ones behind a single `Table[K, RootRef]` with
typed accessors is the only real lever, and the ceiling is about **16 KB** —
0.5% of the image — for a type-erasure layer through the interpreter, the
planner, the JS runtime and the font cache. Not a good trade. Two pairs
(`NI -> NimStringV2`, `NI -> NI`) are accidental duplicates that generate
byte-identical C because a `distinct int` key makes a distinct table type;
merging those is worth ~1.4 KB each and needs the two declarations found first.

## Constant data

- **String literals cost about twice their text.** 4,709 payloads and 6,443
  `NimStringV2` headers — 51.5 KB of pure 8-byte header — carrying ~77 KB of
  actual text in ~159 KB of rodata. Log event names and JSON keys dominate.
  No lever short of patching the compiler.
- Dragonbox's `pow10` is 9,904 B of float printing. `-d:nimLegacySprintf`
  routes `$float` back through newlib, but changes how floats stringify
  (`0.1` → `0.10000000000000001`), and those strings reach scene state and the
  cloud. Not measured; not recommended without a formatting audit.

---

# The October audit and the inline-helper fold (2026-10-18)

*`esp32-s3`, 8 MB layout, `EPD_7in5_V2`. Full `ci_build_image.sh` builds in
the `esp32-ci` image; the v2026.10.15 tree rebuilt locally came out byte for
byte at the release's 3,138,272.*

**v2026.10.15 3,138,272 → main 3,154,224 (+15,952) → 3,119,504 (−34,720
against main, −18,768 against the release). OTA slot 87.5% → 86.5% full,
474 KB free.**

## What the two weeks after 2026.10.15 added

| object | Δ | PRs |
|---|---:|---|
| `frameos/utils/redacted_url.nim` (new) | +3,154 | #564 |
| `fos_panel_draw.c` (new) / `fos_status_screen.c` | +2,229 / −1,156 | #560 |
| `frameos/js_runtime/app_runtime.nim` (of it the prelude literal +1,274) | +2,216 | #553 #556 #563 #564 |
| `frameos/utils/http_client.nim` | +1,815 | #564 #565 |
| `fos_netguard.c` (DNS pinning, `fos_netguard_url_origin`) | +1,353 | #560 #564 #566 |
| `frameos/input_state.nim` | +1,313 | #554 #557 #562 |
| `fos_lan_access.c` (new) | +841 | #560 |
| `frameos_nim_glue.c` (connect reasons, retry, pins) | +820 | #564 #565 |
| `fos_client.c` (the code overlay, the button settle) | +691 | #557 #560 #565 |
| `frameos/js_runtime/burrito.nim` (the deadline message) | +603 | #565 |
| the C string pool | +595 | |
| `fos_button_timing.c` (new), `fos_buzzer.c`, `fos_buttons.c` | +434, +261, +244 | #554 #557 #562 |
| `fos_cloud.c`, `fos_ota.c`, `fos_settings.c` | +393, +172, +104 | #556 #560 #566 |
| `interpreter.nim`, `cloud/scene_guard.nim` | −284, −255 | #556 |

The C side is feature code with little to take out. Five things on the Nim
side were redundant, each changed without changing behaviour (−4,960):

- **`redactedUrl` existed twice** — in Nim (1,570 B) and as
  `fos_netguard_url_origin` in C (634 B), which the firmware needs anyway. On
  `frameosEmbedded` the Nim proc now calls the C one; the Nim test cases pass
  against it. −1,962 with the next item.
- **A string slice `s[a .. b]` is a generic, instantiated anew (~350 B) in
  every module that uses one.** `redactedUrlsIn` and `httpHostOf` use
  `substr`, system's single copy; `httpHostOf` is `redactedUrl` minus the
  scheme, so it no longer falls back to the whole URL. −788 in http_client.
- **The JS preludes shipped their indentation and comments.**
  `compactJs` (burrito.nim, compile time) trims every line and drops blank
  and `//` lines; it refuses a template literal or a trailing backslash, the
  two ways a string could run across a line. The asset and stream calls of
  `frameos` share three helpers, `console` points at `frameos.log`. −1,516.
- The status screen's SVG opened with a 330-byte comment for its readers. Cut
  at compile time.
- `input_state.button` looked up `atMs`, `durationMs` and `level` twice each
  (`isInt`, then `[]`). −347.

## The inline-helper fold: −29,760

Nim emits every `{.inline.}` proc a module needs as `static N_INLINE(...)`
into that module's C file. Wherever GCC does not inline a call, the file
keeps a private copy, so the image held 70 `appendString`s, 44
`nimDecRefIsLastCyclicDyn`s, 31 `eqStrings`, 55 `nimZeroMem`s and a dozen
copies of each string-slice `[]` — about 21.6 KB of identical code (103
same-named local-function groups, 43 KB counting genuinely different
instances).

`embedded/esp32/tools/fold_nim_inlines.py`, run by `build_nim.sh`, uses C99
inline semantics: a helper whose definition is identical in every file
becomes a plain `inline` definition (still inlined where GCC wants, no
private copy) in all files but one, which has `extern inline`, the single
external definition. 199 helpers fold; 23 whose bodies name module data stay
private. Measured −29,760, more than the copies themselves, since GCC also
inlines a little less once a helper is not file-local.

- **`__attribute__((weak))` is the wrong tool** — it folds the copies too
  (−21,610) but GCC never inlines a weak function, and losing that cost more:
  +1,392 net.
- Bodies are compared as text after renaming the temporaries a body declares
  (`TM__<module hash>_<n>`); a `TM__` the body only *reads* is module data and
  keeps the bodies apart. No folded body has a static local (an inline
  definition may not).
- Checked on the host by building seven Nim suites (interpreter, dispatcher
  fixtures, the single-scene host, the JS app runtime and all 19 repo apps'
  tests) through the same fold at `-O0`, where every call goes to the one
  copy: all pass. `test_esp32_fold_nim_inlines.py` pins the rewrite and links
  and runs a folded sample at `-O0` and `-O2`. The QEMU smoke boots it as far
  as it boots main.
- The other two ways to fold reach less or nothing: LTO on the component
  measured −4,720 in all (above), and `ld.bfd` has no identical-code folding.

The remaining same-named groups are genuinely different instances (a
`rawGet` per table type, `parseObjectInner` per jsony type): see "The 52 hash
tables".

# QRgen out (2026-10-18)

*`esp32-s3`, 8 MB layout, both images built in `frameos-esp32-ci-check`
from the same tree, main at 49948ff vs the branch.*

**3,102,656 → 3,081,712 bytes (−20,944).** The QR code app and the
runtime's own screens (the control code, the link code, the hotspot, the
index screen) drew with the QRgen package, which was 21,846 B and the only
user of pixie's `Context` (2,986 B). `frameos/utils/qr.nim` replaces both
with 6,073 B: level L only (no caller asked for another), two 40-entry
tables where QRgen carried ten 160-entry ones, and one reserved-area test
where QRgen's templates expanded one per mask.

- **The codes follow the standard**: the smallest version that fits, the
  mask with the lowest penalty. Each test vector decodes back to its text
  with zxing-cpp. The layout and the styles (`alRad`, `moRad`, `moSep`) are
  QRgen's. QRgen's numeric mode wrote a group with a leading zero in 7 or 4
  bits, where the standard says 10. Digit-only text like `0123456789`
  scanned as `0987173088`, and `007` did not scan at all.
- **Unchecked on the ESP32: −3,289** of the module's 9,362. Every index is in
  range by construction, and `qrImage` clamps the two numbers a scene can
  pass. Hosts and the tests keep every check, so the tests run the same
  code checked.
- **Not ported to JavaScript.** The app's default code is the frame control
  URL, which carries the access key, and JS apps (store scenes included)
  must not be handed that key. The Linux runtime's screens need a Nim
  encoder anyway, and every scene would have carried the encoder's source.
