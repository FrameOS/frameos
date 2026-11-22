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
   **Then read in place** (2026-11-19, against the glyph cache's build): the
   image holds the indexed font (`tools/generate_indexed_font.py`), 74,500 B
   as it is, instead of the 57,645 B gzipped TTF, because the TTF was
   inflated whole and parsed into 162 KB of RAM for good. +16.9 KB of font
   bytes (the kerning pre-resolved and uncompressed, 21 KB, is most of it;
   ASCII's blocks stored raw 1.7 KB) and ~5.4 KB of reader (pixie's
   `indexedfont` ~4 KB, opentype's composite reader made generic 1.0 KB):
   **+22,416 B** over the glyph cache (esp32-s3 app 3,200,624 B, 394 KB free in the slot), for a face that holds under 1 KB of RAM
   (`docs/esp32-memory.md` "The built-in face is read where it lies", which
   has the options weighed). Its first cut was +35.2 KB: the glyf records
   kept their own boxes and each class subtable its own right-class ranges.
6. **Move the font to SPIFFS** (−88 KB per OTA slot since it is read in
   place, which would read it by `pread` there): the `state` partition
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
newlib's float-capable scanf stayed linked after FrameOS code stopped calling
`sscanf`: cJSON's `print_number` reads its own `%1.15g` back with
`sscanf(buf, "%lg", ...)`. (linenoise's call never survives the section GC.)
Since 2026-10-27 the linker routes `sscanf` to `main/fos_sscanf.c`, which
answers `%lg` with `strtod` and hands every other format to the integer-only
`vsiscanf` that `tzset` links anyway (−9.6 KB). mbedTLS' ARIA cipher (3.4 KB) has no Kconfig switch in IDF 5.5.
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

**Update (2026-11-08): the copies are shared now, without touching a call
site.** See "One probe loop for all the tables" at the end.

## Constant data

- **String literals cost about twice their text.** 4,709 payloads and 6,443
  `NimStringV2` headers — 51.5 KB of pure 8-byte header — carrying ~77 KB of
  actual text in ~159 KB of rodata. Log event names and JSON keys dominate.
  No lever short of patching the compiler.
- Dragonbox's `pow10` is 9,904 B of float printing (≈13 KB with
  `writeFloatToBufferRoundtrip`). `-d:nimLegacySprintf` routes `$float` back
  through newlib's `%.16g`, which changes how some floats stringify on the
  device: `0.1` stays `0.1`, but `0.1 + 0.2` becomes `0.3` (no longer the same
  double), `1.5e-7` prints as `1.5e-07` instead of `0.00000015`, and 17-digit
  values lose their last digit. Those strings reach scene state, text a scene
  draws and the cloud, so it needs a decision, not just a flag.

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

---

# Before the release after 2026.10.20 (2026-10-27)

*`esp32-s3`, 8 MB layout, every image a fresh `ci_build_image.sh` build in
`frameos-esp32-ci-check`. v2026.10.20 rebuilt from its tag this way comes out
at its published 3,146,976 bytes exactly.*

**Main at ea305a4f7 was 3,209,424 bytes, +62,448 over the release; the five
cuts below take it to 3,166,480 (−42,944, 87.8% of the slot).** The C3 thin
client goes 1,392,704 → 1,367,696 (−25,008, Monocypher and sscanf).

The e2e-docker job reported 3,224,688 for the same commit, and 3,224,672 for
22d8fd6e3, which builds locally at 3,209,408: its builds of current main run
about 15 KB over a fresh one of the same tree. Not explained yet; the release
job's number is the one that counts.

## Where the 62 KB came from

Per merge, from each push's `esp32-firmware-size` artifact (CI terms, so the
sum carries the 15 KB above):

| PR | Δ app bytes | What |
|---|---:|---|
| #621 reTerminal Sticky | +24,416 | `input_state` pointer half, `fos_touch`, `fos_codec` |
| #623 outline, gradient | +6,464 | `blendCoverage` at -O2 |
| #624 reTerminal E1003 | +18,832 | pixie's Gray8 surface, `it8951.c` |
| #622 SenseCAP Indicator | +17,504 | IDF RGB LCD driver, ST7701S |
| #626 real-time rendering | +38,272 | pixie SVG damage + fast parser, `resample`, `fos_animation` |
| #633 LCD splash | +11,488 | the mark and the status lines as runs, 10 KB of tables |
| #628 JSX layout | +36,960 | `ui/layout` 25.8 KB, `ui/tailwind` 10.2 KB |
| #629 JSX events | +10,448 | `ui/events`, handler calls |
| #631 JSX reconciliation | +10,960 | `ui/layout`, `svg_frames` |
| #634 SenseCAP touch, canvases | +25,328 | `jsCanvas` 3.1 KB, `jsCanvasDraw` 2.6 KB, kept images |
| #636 + #637 font, Kconfig | −123,520 | |

Almost all of it is feature code; the Nim traps above (seq hooks per type,
`%*` sites) account for a few KB at most, in `system.nim` (+9.5 KB of
`delete`/`==`/`add` instantiations for the new types).

## The cuts: −42,944

| Cut | Saves | Behaviour |
|---|---:|---|
| Monocypher `BLAKE2_NO_UNROLLING` | −15,508 | same hash; blake2b only hashes the OTA image |
| `sscanf` through `fos_sscanf.c` | −9,476 | cJSON's `%lg` read-back is `strtod`; other formats `vsiscanf` |
| zippy's CRC-32 → `esp_rom_crc32_le` | −8,447 | same checksum (zlib's), no 8 KB table |
| chroma's color names packed | −6,207 | same 148 names and colors |
| Splash lines as byte runs | −3,502 | pixel-identical |

- **Monocypher** (`components/monocypher/CMakeLists.txt`): its own switch
  rolls the twelve BLAKE2b rounds into a loop. `blake2b_compress` is 17,845 B
  of Xtensa unrolled and 2,137 rolled; on a laptop the rolled one is as fast.
- **sscanf** (`main/fos_sscanf.c`, `--wrap=sscanf` in `main/CMakeLists.txt`):
  the map's cross-reference table names cJSON's `print_number` as the one
  live caller. `test_fos_sscanf.c` checks the `%lg` path against the C
  library's on what cJSON prints and on inputs it never prints.
- **CRC-32** (`src/embedded/patched_zippy_crc.nim`, `patchFile` in
  `config.nims`): the ROM's `crc32_le` is `~crc`, the 0xEDB88320 table,
  `~crc` (IDF's Linux reference implementation), so `esp_rom_crc32_le(0, …)`
  is zippy's `crc32`. crunchy's patch already forwards to zippy's, so PNG
  chunks and gzip trailers both use the ROM.
- **Color names** (`src/embedded/patched_chroma_names.nim`): chroma's
  compile-time `Table[string, string]` is 256 slots of hash, name and hex.
  The patch is one `name=RRGGBB;` string read in order;
  `tests/test_patched_chroma_names.nim` compares every entry with chroma's.
- **Splash** (`tools/gen_splash_mark.nim`): a status line's run is a byte,
  ((length − 1) << 5) | alpha, and a row stops at its last inked pixel:
  7,656 → 4,160 B. The mark keeps its 16-bit runs (four layers).

## Not done, needs a decision

- `-d:nimLegacySprintf`, ≈ −13 KB: see "Constant data" above.
- QuickJS without `CONFIG_ALL_UNICODE` / `CONFIG_ATOMICS`, ≈ −51 KB: the
  2026-10-26 audit, skipped then.
- pixie's QOI (2.4 KB), GIF (5.7 KB) and BMP (7.7 KB) decoders: formats a URL
  might still serve.

---

# One probe loop for all the tables (2026-11-08)

*`esp32-s3`, 8 MB layout, `EPD_7in5_V2`, fresh `ci_build_image.sh` builds of
main at 34349f181 and the branch.*

**3,257,360 → 3,235,408 bytes (−21,952). OTA slot 90.4% → 89.8% full.**

`patchFile` swaps two of std/tables' include files on `frameosEmbedded` builds
(`src/embedded/patched_hashcommon.nim`, `patched_tableimpl.nim`). What differs
per `Table[K, V]` pair turned out to be only a slot's size and where its key
sits, so those are arguments of `src/embedded/fos_table_probe.nim`:

| Change | Saves |
|---|---:|
| `enlarge`: one `fosTableRehash` loop, 45 thin `fosEnlarge` wrappers | −12,320 (first build, with the next row) |
| `rawGet`: one probe per key shape (string, machine word) | |
| One init block in `[]=` at a constant size, `mustRehash` shared, no bounds/overflow checks on masked indices, `raises: []` on the lookups | −9,632 |

- The rehash moves slots with `copyMem` and zeroes the old ones, what `move`
  did slot by slot; a zeroed slot is `wasMoved`'s state, so the old seq's
  destructor frees its block and nothing else. OrderedTable keeps its `enlarge`
  (it walks `next`), and so do `SharedTable` and `CountTable`.
- Keys that stay generic: anything not a string, a machine word or a pointer
  (`uint16` glyph ids, tuples). A distinct key must compare like its base.
- `fosEnlarge` still propagates a failed `newSeq`, before any slot has moved.
  `rawInsert` too: copying a string key can allocate.
- Compile-time tables (`when nimvm`) run the stock code. Both files refuse a
  Nim other than 2.2, to be re-derived from its `lib/pure/collections`.
- Checked: `tests/test_patched_tables.nim` (a `.nims` beside it patches the
  same two files; it refuses to build against the stock ones) churns five key
  types against a model, on the host and under AddressSanitizer. The event
  loop, dispatcher fixtures, interpreter and calendar JS app suites also pass
  built through the patch.
- Looked at and left: `nuctoUpper` / `nuctoLower` (9.9 KB of case tables) are
  live for pixie's text case. `setLen` ×144 (14.7 KB), `add` ×114 (9.6 KB) and
  `shrink` ×96 (5.9 KB) are the same shape of problem in `system/seqs_v2`; a
  third of `shrink`'s instances are plain data, the place to start, but that
  patches `system` and was not a quick change.

---

# After the ical retirement (2026-11-10)

*`esp32-s3`, 8 MB layout, `EPD_7in5_V2`, fresh `ci_build_image.sh` builds in
`frameos-esp32-ci-local`. Main at 98b3e0000 builds at 3,292,720 bytes, the
same as #719's CI comment (91.4% of the slot, 304 KB free).*

**3,292,720 → 3,225,328 bytes (−67,392; 89.5% of the slot) with the first
four cuts, and about −71.5 KB with the setup page too, no behaviour change.** Two more measured cuts need
a decision (below): QuickJS's unicode tables would take it to about
3,176,000, and `--panics:on` on top to about 3,027,000 (84%).

## Kept: the -O2 hot modules, +38.5 KB

#719 put pixie's raster modules and `resample` at -O2 in the official-Nim
builds too (until then only the ROT13 names were listed, so CI and every
release compiled them at -Os). Measured against the same tree at -Os:
+38,512 B (`images` +14,036, `paths` +12,665, `blends` +6,819, `common`
+2,924, the rest under 1 KB). **The speedups are worth it**: DVD Logo Bounce
on the SenseCAP ran ~5 ms a frame slower without them, and these loops are
every frame of an animation and most of a render. Find the bytes elsewhere
before taking a module off the list.

`pixie/paints` joined the list on 2026-11-18 with the gradient rows it holds
(`docs/perf-todo.md` "The hardware bench's slow renders"): the change as a
whole, its row job, tables and probe lines included, was about 10 KB of flash (3,140,048 to 3,149,808 B on the generic image).

## The cuts

Per-cut numbers are from the linker map of builds that also carried the
QuickJS change, so they add up to a little more than the bin's −67,392.

| Cut | Saves | Behaviour |
|---|---:|---|
| ESP-IDF Log V2 (`CONFIG_LOG_VERSION_2`) | −28,471 | same lines; a little more stack per log call |
| App loaders share `loaderParams` / `initAppRoot` / `raiseUnknownField` | −17,200 | none |
| `printf` & co through `fos_printf.c` (no `_vfprintf_r`) | −13,944 | none |
| `$float` through QuickJS's `js_dtoa` (`patched_dragonbox.nim`) | −12,882 | byte-identical |
| The setup page as one gzipped file (`main/setup_page.html`) | −4,060 | same form; values from `GET /api/setup` |

- **Log V2**: V1 bakes `"W (%lu) %s: "` into each of the 911 W/E format
  strings; V2 prints the prefix in `esp_log_format`, holding `flockfile(stdout)`
  across prefix, message and newline, so lines still come out whole. −12,955
  of the C string pool, the rest at the call sites. Check the task stack
  high-water marks on a bench before a release.
- **App loaders**: each of the 25 generated loaders carried its own config
  check, its own "Invalid config format" / "Unknown field: " literals and
  exception code, and the four AppRoot field writes: ~760 B per app.
  `backend/app/codegen/app_loader_nim.py` now calls the shared procs in
  `frameos/app_config.nim`. Loaders went from 39 KB to 22 KB.
- **printf**: newlib links two copies of its float-capable formatter, one for
  strings (`_svfprintf_r`) and one for `FILE`s (`_vfprintf_r`, what ESP-IDF's
  log `vprintf` uses). `--wrap` sends printf/fprintf/vprintf/vfprintf to
  `vsnprintf` into a 128-byte stack buffer (a longer line is formatted again
  into a heap block, or cut at 127 bytes with no heap).
- **dtoa**: Dragonbox's 9.9 KB power-of-ten table goes; `js_dtoa` (free
  format, what `Number#toString` uses) gives the shortest round-trip digits
  and the patch lays them out exactly as Dragonbox's `formatDigits`.
  `src/embedded/tests/test_patched_dragonbox.nim` compares the two (specials,
  subnormals, every power of ten ±1 ulp, random bit patterns); a 9-million
  double run found no difference.

- **Setup page**: `fos_http.c` wrote the page with 7.3 KB of C strings and a
  `send_input` per field. It is now `main/setup_page.html`, stripped and
  gzipped at build time (`tools/gzip_setup_page.py`, 3.5 KB) and sent with
  `Content-Encoding: gzip`; the current values come from `GET /api/setup`
  (same access check, no secrets: it says only whether a Wi-Fi password is
  saved). The form stays disabled until they are in, so a failed fetch never
  posts blank fields. Measured −3,680 before the stripping, which took
  another 381 off the blob.

## Measured, needs a decision

| Lever | Saves | Cost |
|---|---:|---|
| `--panics:on` | −149,168 | see below |
| QuickJS without `CONFIG_ALL_UNICODE` / `CONFIG_ATOMICS` | −49,054 | no `String#normalize`, no `\p{…}` on the ESP32; needs a quickts release |

**`--panics:on`, re-measured.** Spread over all Nim code (app_runtime −19.9 K,
interpreter −19.0 K, svg −6.3 K, sceneSettings −6.1 K, …): it is the
error-propagation branch after every call that can raise a Defect. The
longjmp barrier the doc of 2026-09-01 asked for exists now: every render
entry in `frameos_nim_glue.c` arms `s_nim_oom_jmp`, and
`fos_nim_recover_oom_abort_impl` puts back what the skipped `finally`s owned.
Under panics a Defect goes `raiseExceptionAux` → `reportUnhandledError`,
which calls `unhandledExceptionHook` first, so a hook that longjmps to the
armed guard (and returns, to the reboot, when none is armed) needs no
patched system file. What changes:

- A Defect in a node fails the whole render (and leaks what that render held,
  as an OOM abort does) instead of failing the node: the interpreter's
  per-node `except Exception` no longer sees Defects. Four in a row restart
  the frame (`FOS_OOM_RESTART_STREAK`, `fos_oom_policy.h`).
- A Defect in a Nim bridge function called from JS no longer becomes a JS
  `RangeError` / `Error` (`burrito.nim`'s `except RangeDefect`); it aborts the
  render. The bridge's number conversions would want clamping first.
- Entry points that are not guarded today (scene load, catalog, events, the
  tick, settings) reboot on a Defect unless the guard is armed in every
  glue entry, which is mechanical.

**QuickJS unicode/atomics, re-measured**: libunicode −43,958, quickjs −3,808,
libregexp −736, `pthread_cond_var` −552. The quickts change is three guards
(`CONFIG_NO_ALL_UNICODE` around the define in `libunicode.h` and around the
emoji-sequence code at the end of `libunicode.c`, `CONFIG_NO_ATOMICS` in
`quickjs.c`); then the two defines go into
`components/frameos_quickjs/CMakeLists.txt` and a line into the scene guide's
small-devices section.

## Looked at, not done

- **Apps in one file, or as JS.** After the loader change the 24 Nim apps are
  22 KB of loaders (4.3 KB of it `split`'s seq fields) and 49 KB of app code,
  most of it in the renderers (localImage 9.2 K, zoomPan 6.2 K, split 5.3 K,
  xmlToJson 4.1 K, text 3.6 K, svg 3.4 K). One file would only merge a few
  hundred bytes of module literals. A JS port moves no bytes worth having:
  the small ones (ifElse, clock, parseJson, log) are 0.5–1.5 KB each, and as
  JS apps every scene using them would start an interpreter.
- jsony for scenes and the seq hooks: done, see "Four cuts after 2026.11.7"
  below.
- **The font to the state partition**: −57.9 KB per slot, but it must be there
  before provisioning (the merged image's SPIFFS image) and survive OTA.
- `appCapabilities` built at run time (~3 KB), the float-32 libm copies
  (~4 KB; double is soft-float on the S3, so slower), QuickJS's TS/JSX syntax
  (~7 KB).

---

# Four cuts after 2026.11.7 (2026-11-14)

*`esp32-s3`, 8 MB layout, `EPD_7in5_V2`, native `ci_build_image.sh` builds of
`git archive` snapshots. Main at 3b9e14ad0 builds at 3,263,488 bytes, within
0.5 KB of its CI artifact (3,263,984 for cf429a155). The release was
3,239,408; main had gained 24.6 KB since (#744's QuickJS at -O2 +8.2 KB,
#666 +7.3 KB, #745 and what landed with it +8.0 KB).*

**3,263,488 → 3,223,680 bytes (−39,808). OTA slot 90.5% → 89.4% full.** No
behaviour change.

| Cut | Saves |
|---|---:|
| The scene loader reads with jsony's untyped pieces, a loop per type | −13,984 |
| `add` / `setLen` / `shrink` grow through one proc (`patched_seqs_v2.nim`) | −15,744 |
| runNode's eight input-failure lines and two graph stops, one builder each; the five options parsers in `app_runtime`, one | −5,900 |
| An ESP32 runtime's bytes kept in its own account, no `JS_ComputeMemoryUsage` | −3,957 |

- **Scene loader** (`interpreter.nim`, "Reading scenes.json"): jsony's generic
  typed parse of `seq[FrameSceneInput]` was 27 KB, all for this one call
  (the config's jsony path is not linked on the ESP32). Now each type is a loop
  over its keys with a `case`, built on jsony's string, number, `JsonNode` and
  `skipValue` (7.9 KB of jsony remains, the loops are 7.6 KB). It reads as
  jsony did: snake_case keys, `type` renamed, the last repeated key wins, node
  ids numbered in document order, `__frameosSourceNodeId` stamped. Where jsony
  refused a value of the wrong type the loop takes the default. A tree from
  `std/json` walked afterwards would have dropped jsony altogether (about 8 KB
  more, not built) but was three times slower to parse on the host (121 ms
  against 41 ms for the corpus ×10), which a deep sleeper pays on every wake;
  jsony's own tree, walked, was 1.6× slower. The loops run at jsony's speed
  (45 ms against 44). `tests/test_scene_reader.nim`
  keeps the old hooks and reads all 46 repo and 83 e2e scenes both ways,
  field by field.
- **Seqs** (`src/embedded/patched_seqs_v2.nim`, `patchFile` in `config.nims`):
  Nim copies the three into the image per element type, each with its own
  capacity check, call to grow the block and overflow checks (29.2 KB in 338
  copies). `fosSeqGrow` / `fosSeqSlot` do the growing for every type; `add`
  is left with the move into its slot, `setLen` zeroes the new slots when zero
  bytes are the type's default (references, strings, seqs, numbers, enums: never
  an object or tuple, which can have field defaults or a type header) and
  stores `default(T)` per slot otherwise, and `shrink` keeps its reset loop,
  without index checks. 15.6 KB left. `tests/test_patched_seqs.nim` (with its
  `.nims`, under AddressSanitizer too) checks defaults, growth at odd sizes and
  alignments, literal seqs, destructor counts and a churn against an array; the
  scene reader, event loop, event fixtures and interpreter suites also pass
  built through the patch. Tuples (57 of the `setLen` copies) could take the
  zero path too, but `fields` is not visible yet where `system` includes this
  file.
- **Log builders**: `runNode` 29.1 KB → 22.9 KB, `logInputError` and
  `logGraphStop` 1.1 KB; every line has the keys it had, in the same order.
  The other `%*` sites in `app_runtime` are one shape each: folding them would
  move code, not remove it.
- **heapBytes**: it read `malloc_size` by walking the whole heap. The glue's
  malloc opaque is now a per-runtime `fos_js_runtime_account_t` (the scene
  budget pointer and the runtime's bytes, kept with `malloc_size`), freed after
  `JS_FreeRuntime`. Host and wasm builds still ask QuickJS.

---

# Scenes as compiled programs (2026-11-14)

*Same recipe, same paths. Main at 17bc7fbc6 builds at 3,223,680 bytes.*

**3,223,680 → 3,216,560 bytes (−7,120).** A scene's graph runs as one
JavaScript program written by `scene_compiler.nim` (docs/scene-compiler.md)
instead of being walked by `runNode`.

| | Bytes |
|---|---:|
| `interpreter.nim` gone: `runNode` (−22,905), the wiring in `init`, the listener loop, `withCache`, `eventNodeMatchesPayload`, the lazy inline compile | −38,827 |
| `js_runtime/runtime.nim` gone: the code-node envelope (`callCompiledFn`, `buildEnvelopeFunctionWithMap`, `compileCodeFn`, `envelopeToValue`, the per-scene eviction) | −21,462 |
| `scene_compiler.nim`: the compiler, its analysis and its generics | +22,586 |
| `interpreter.nim` added: the natives (`programOp` 6,574), and out of `runNode` as they were: the image hints, the cache lookup and store, the debug profile, the dispatch node; `compileFailure`, `ensureProgram`, the program's entries | +27,257 |
| string literals (the program's head and glue, 2.4 KB of them) | +1,552 |
| the rest | +135 |
| where a scene's program runs: a runtime of its own with room, a realm in one shared runtime on an 8 MB board (`newContextIn`, `closeContext`, `applyLimits`, `fos_psram_total_bytes`) | +744 |

Moving the walk into JavaScript saves little flash by itself: what `runNode`
did per node (the image hints, the cache tiers, an error painted into an
image field) is still Nim, as natives, and the compiler costs about what the
walk did. What made the difference: the program writes its own log lines
(the 2 KB of JavaScript around them costs the program's memory, not a
`%*{…}` per line in flash), and the nested edge tables became one list.
The compiler itself in JavaScript, shipped as bytecode like the preludes,
would be the next 8–12 KB (estimated, not built).

---

# After the desktops, async JS and the books (2026-11-17)

*Same recipe. 17bc7fbc6 builds at 3,224,448 bytes, main at 4bba999d6 at
3,304,752 (+80.3 KB in three days, 91.7% of the slot). Nothing in it was an
accident: the compiled scenes, async JavaScript (#747), the desktops' JSX UI
(selection, links, themes), the EPUB reader's zip members and the storages
are each a few KB. One function was not: `jsAssets` grew 9.3 KB to 14.8 KB.*

**3,304,752 → 3,285,312 bytes (−19,440).** QuickJS's Unicode tables stay
(the owner's call, 2026-11-17: frames will show Chinese text, and
`normalize` / `\p{Script=Han}` are what handling it in a scene may want).

| Cut | Saves | Behaviour |
|---|---:|---|
| Nim's `toUpper` / `toLower` (Rune) answered from QuickJS's case tables (`fos_unicode_case.c`, `--wrap`) | −11,300 | the same rune wherever std/unicode maps one; 281 more code points map (newer Unicode: Roman numerals, circled letters), as in the frame's JS |
| `jsAssets` and `jsStreams`: one proc per op, `jsAssets`' options read once into plain values | −7,900 | none |

- **Where the bytes in `jsAssets` were**: 371 `=destroy` and 254 `dealloc`
  calls. Each `options{"x"}` is a JsonNode alive to the end of the proc, and
  under `--exceptions:goto` every `return` (about twenty) destroys everything
  alive. A proc per op keeps each exit's list short. Others with the same
  shape, smaller (cleanup calls / bytes): `jsStreams` before this 225 / 4.6 K,
  `imageFromSpec` 168 / 3.4 K, `downloadImageStreamingInto` 132 / 3.7 K,
  `jsCanvas` 101 / 3.4 K, `get` of `data/localImage` 98 / 4.2 K, the scene
  settings' `row` 95 / 4.0 K. `jsStreams` gave a quarter back, so the rest
  are worth about 0.5–1 KB each.
- **The case wrap**: the callers are pixie's text-transform (the JSX
  `uppercase` / `lowercase` / `capitalize` classes) and `data/localImage`'s
  search, which now lowercases a rune at a time (a string's `toLower` calls
  `nuctoLower` inside std/unicode, where no wrap reaches). Where QuickJS's
  full mapping is several letters the wrap gives std/unicode's simple one
  (ß stays ß, İ → i, ᾀ → ᾈ). `src/embedded/tests/test_unicode_case_wrap.nim`
  compares every code point with std/unicode.
- Still on the table: `--panics:on` (−149 KB, "Measured, needs a decision"
  above).

---

# Program apps (2026-11-17)

*Same recipe; main at 6a1aec4b9 builds at 3,285,312 bytes.*

**3,285,312 → 3,280,448 bytes (−4,864).** Seven small built-in apps
(`logic/ifElse`, `breakIfRendering`, `nextSleepDuration`, `setAsState`,
`data/log`, `parseJson`, `prettyJson`) are run by the scene's program as
JavaScript and left out of the registry (docs/scene-compiler.md "Program
apps").

| | Bytes |
|---|---:|
| the seven apps: loaders, code, destroy hooks, literals, registry rows, `toPretty` | −8,650 |
| the kit's `AP` (all seven apps' JavaScript, bytecode) | +1,760 |
| the compiler: a config constant, an input as a key, one call per node | +1,690 |
| three natives (`sw`, `ns`, `ir`) | +340 |

- **The first version cost bytes** (+720 net): the compiler resolved each
  app's config, converted its inputs and wrote its lines from Nim, 7.4 KB of
  emitter for 6.7 KB of apps. Written once in the kit, the same work is
  1.8 KB of bytecode. A program app is worth it only when its work is a few
  lines of JavaScript.
- `data/clock` stayed here: its `HH:mm` patterns would have needed a
  translator in the kit. It is retired to JavaScript apps instead (below).

---

# The clock retired to JavaScript (2026-11-17)

*Same recipe, on top of the program apps (3,280,448 bytes).*

**3,280,448 → 3,264,288 bytes (−16,160).** `data/clock` is retired
(docs/retired-apps.json) to `repo/apps/text/clockStdTimes`, a JavaScript port
of std/times' `format` that keeps the scenes' `HH:mm` patterns; a new scene
uses `repo/apps/text/clock`, whose format is chrono's. Both are scene data, no
flash. The Nim clock was the last ESP32 user of std/times' calendar and
formatter, so most of that module goes with it: `formatPattern` (−3,841),
`stringToPattern`, `initTimeFormat`, the epoch-day and local-zone helpers,
the locale table and their literals.

- What it costs instead is memory, not flash: a JS app node runs in a QuickJS
  runtime of its own on an ESP32 (docs/scene-compiler.md "Next"), so a scene
  whose only JS app is its clock now starts one.
- A first take kept the clock in the program (a kit case) and had both
  planes add each clock's pattern translated to chrono's on delivery
  (−15,520): three translators and a delivery rule for one app. Retiring it
  is what the other Nim apps with a JS replacement did.

---

# Calls, alignment and strings: how the image is laid out (2026-11-18)

*Same recipe (`esp32-s3`, 8 MB layout, `EPD_7in5_V2`, `ci_build_image.sh` in
`frameos-esp32-ci-local`). Main at 93522727d builds at 3,264,288 bytes, 90.6%
of the slot. Link-only variants are relinks of that build: its link line with
one more flag, `esptool elf2image` after it, which gives back the build's own
image byte for byte when nothing is added.*

**3,264,288 → 3,125,904 bytes (−138,384, −4.2%). OTA slot 90.6% → 86.7%
full, 467 KB free.** No source of the runtime changed for the first three
rows: the same objects, placed and assembled differently, and on a board the
image is a little faster, not slower.

| Cut | Saves | Behaviour |
|---|---:|---|
| Objects in an order that keeps callers near what they call (`link_order.txt`) | −54,256 | none; a call is one instruction shorter |
| No branch-target alignment outside the -O2 modules (`-mno-target-align`) | −15,856 | none; see "On a board" |
| The linker does not keep it either (`--size-opt`) | −31,248 | none; see "On a board" |
| String literals that several Nim modules hold, one copy (`fold_nim_strings.py`) | −28,437 | none |
| The console's `help` and command table our own, not `esp_console`'s | −8,587 | `help` lists a line per command; `help -v` is gone |

## A third of the calls were six bytes long

ESP-IDF compiles everything with `-mlongcalls`: a call is written as an
`L32R` of the target's address out of a literal pool and a `CALLX8` through
it, six bytes and a four-byte literal, and the linker shrinks it to a
three-byte `CALL8` when the target is in reach. `CALL8` reaches 512 KB either
way. The image's code is 2.6 MB and the Nim runtime's alone 1.24 MB in one
block, and the linker places objects in the order it meets them: by name, so
Nim's `system`, `tables` and `json`, which everything calls, stood at the
start of that block and half of it could not reach them.

| | calls between functions in flash | of them long |
|---|---:|---:|
| main | 76,200 | 24,402 |
| this change | 76,578 | 7,275 |

The callees say what happened: 1,957 long calls to `JsonNode`'s destructor,
1,863 to `dealloc`, 1,673 to `nimZeroMem`, 973 to `appendString`. Another
15,009 calls go to ROM (`memcpy`, `memset`, the soft-float `__muldf3` and
friends) or IRAM (`free`, `esp_log`, FreeRTOS): out of reach from flash
whatever the order.

`embedded/esp32/link_order.txt` names the 367 objects of FrameOS's own
archives (libmain, the display drivers, the Nim runtime, QuickJS, Monocypher)
in the order they should stand: `system` and `tables` in the middle of the
Nim modules that call them most, and what calls them least at the ends
(QuickJS, the JPEG and WebP decoders, pixie's raster loops, the firmware's C).
CMake turns it into a script for the linker's `--section-ordering-file`
(binutils 2.43; `tools/link_order.py emit`), which puts the named sections
first in `.flash.text`, after `_text_start`, so the MMU's symbols stay where
ESP-IDF expects them.

- **The order is written by a tool, from a finished build**:
  `tools/link_order.py optimize --build-dir <build> --out link_order.txt`
  reads the map and the ELF, finds every call (instructions walked by length,
  the literal pools skipped by their sections in the map) and searches an
  order by simulated annealing, seeded, 250,000 steps in half a minute with
  numpy. It measures distances in the sizes *before* relaxing, which is what
  the linker does, and leaves 32 KB of reach unused so the image can grow
  before a call near the limit goes long again. A second pass from the
  ordered build changed nothing (3,210,032 → 3,210,384).
- **It goes stale gracefully.** A module the file does not name stands where
  the file's `*` line is (beside `system`); a name with no object matches
  nothing; a call that drifts out of reach costs three bytes. Every
  `ci_build_image.sh` prints the count (`link_order: … calls between
  functions in flash, … of them long`) and what the file no longer matches:
  run `optimize` again when that climbs, or before a release.
- **Written again after 2026.11.14** (2026-11-22): the file named eight
  objects #959 had removed (zippy, qoi, flatty's encoder) and missed three
  new ones (`file_slice`, pixie's `filefont` and `indexedfont`). From that
  release's build: 7,624 → 7,297 long calls, 3,176,736 → 3,175,568 bytes
  (−1,168). On four boards' benchmark, JSON 1.5-3.7 % faster and the SVG
  raster 0.7-2.1 % slower: placement moves both, and neither is what the
  order is for. A second pass from the ordered build came out worse (7,341,
  +512 bytes) and was not kept.
- A Nim object is named by its source path (`frameos/interpreter.nim`,
  `nim/lib/system.nim`, `pkgs/flatty/flatty/binny.nim`), not by the file Nim
  writes, so the Docker image's Nim, a choosenim one and nixpkgs' ROT13 names
  read the same file.
- The centre-out order a greedy pass gives (most-called first, alternating
  sides) left 10,380 long calls in the model where the search leaves 5,239:
  the search is worth its half minute.
- Listing every object of the image, ESP-IDF's included, was 3.9 KB better
  still and is not done: an ESP-IDF archive can hold functions its linker
  fragments move to IRAM, and its objects are not ours to name.

## Alignment

The Xtensa assembler widens two-byte instructions to three so that branch
targets land on a word boundary (a taken branch to an instruction that
straddles one costs a cycle), and the linker keeps those targets aligned when
it shrinks a call, by widening something else. Two switches, measured alone
on main and together:

| | bytes | Δ |
|---|---:|---:|
| main | 3,264,288 | |
| `-mno-target-align` on everything compiled | 3,243,600 | −20,688 |
| `-Wl,--size-opt` (the linker stops preserving it) | 3,229,520 | −34,768 |
| both | 3,219,168 | −45,120 |

Both are on. `-mno-target-align` is for the image, with `-mtarget-align` back
on the files that are at -O2 because their loops are the frame rate
(`FRAMEOS_NIM_HOT_MODULES`, and `quickjs_hot.c` whole, since a flag cannot
follow six functions): what the assembler aligned there stays aligned unless
the linker shrinks a call in the same function before it. `--size-opt` is one
flag for the whole link; it is most of what the prebuilt libraries (Wi-Fi,
libc) give, which no compiler flag of ours reaches.

## On a board

The SenseCAP Indicator (480×480 RGB LCD, 8 MB), twelve scenes, the bench's
`scenes` suite, each image written to the slot the board was not running:
main; the order with `-mno-target-align` (A); A with `--size-opt` (B); and
the image of this change, everything above. A warm render is the median of
five, in ms; an animation is frames per second over ten seconds.

| scene | main | A | B | all of it |
|---|---:|---:|---:|---:|
| DVD Logo Bounce, warm | 273 | 271 | 272 | 266 |
| DVD Logo Bounce, fps | 18.9 | 19.2 | 20.9 | 21.4 |
| Slideshow with motion, warm | 347 | 338 | 336 | 340 |
| Kitchen sink, warm | 296 | 289 | 279 | 286 |
| Chart, warm | 283 | 273 | 272 | 271 |
| Pixel toys, warm | 50 | 47 | 47 | 51 |
| Pixel toys, fps | 21.1 | 22.1 | 23.6 | 20.5 |
| Color cycling, warm | 48 | 47 | 52 | 47 |
| Color cycling, fps | 19.0 | 19.1 | 20.3 | 20.3 |
| Low Poly Animals, warm | 4,702 | 4,775 | 4,784 | 4,691 |
| Home / Calculator / Form showcase, warm | 32 / 31 / 32 | 32 / 31 / 31 | 32 / 32 / 32 | 33 / 32 / 32 |

One run each, and the spread of a run shows in the rows that go both ways
(Pixel toys 20.5 to 23.6 fps, Color cycling's render 47 to 52 ms): nothing
under 5% is a finding. What holds in every image is that nothing got slower
and the scenes that draw the most got 2–4% faster (DVD Logo Bounce, Kitchen
sink, Chart; a direct call is one instruction where a long one was two and a
load, and denser code misses the instruction cache less). The switcher, the
settings, a drag, a switch storm and a restart ran clean on the last image.
Not benched: an e-paper board, where a render is a small part of a refresh.

## String literals

Nim writes a string literal into every C file that uses it as a private
constant (the text behind its capacity, and an eight-byte header where the
string is used as a value). The linker cannot merge them: they are structs in
sections of their own. In the image: 3,841 texts, 168.6 KB (the font and the
preludes' bytecode are two of them, 72 KB), of which 19.2 KB said what
another module's constant already said: "event" 14 times, "name" 13, the
empty string 89, and the message of a failed variant-field check
(`field 'fields' is not accessible for type 'JsonNodeObj' using 'kind = `)
30 times.

`tools/fold_nim_strings.py`, run by `build_nim.sh` after the inline fold:
a text more than one file holds becomes one external constant named after
its text, defined in the first of those files and declared in the rest, and
each file's own name for it is a `#define` onto that one, so nothing else in
the file changes. Headers fold the same way once their text has. 467 texts
and 403 headers; −26,720 of rodata and −1,700 of literal pools.
`test_esp32_fold_nim_strings.py` folds a small nimcache and links it before
and after.

`-fmerge-all-constants` would do a part of this in the compiler (constants of
8, 16 and 32 bytes without a pointer in them); not tried once the fold was in.

## The console

`esp_console_register_help_command` parses `help`'s two options with
argtable3 and `getopt_long`; `esp_console_cmd_register` draws argtable3 in
again for the hints no FrameOS command has. The table of commands is
`fos_console.c`'s own now, `help [command]` prints a line per command, and a
line is still split by `esp_console_split_argv` (quotes and backslashes as
before). `libconsole.a` 6,613 → 166 bytes, `getopt` 1,757 → 0.

## Measured, needs a decision

| Lever | Saves | Cost |
|---|---:|---|
| QuickJS without `Atomics` | −6,976 | the `Atomics` object is gone on the ESP32; one thread, no shared buffer to use it on. `#define CONFIG_ATOMICS` is unconditional in quickts: a guard there, or one more line in the copy `components/frameos_quickjs` already makes. |
| QuickJS without `Proxy` | −5,968 | `JS_NewContextRaw` and the intrinsics by hand; a scene that uses `Proxy` fails on the ESP32 alone |
| QuickJS without `WeakRef` / `FinalizationRegistry` | −2,176 | the same |
| (QuickJS without `String#normalize`) | (−19,872) | kept: the Unicode tables stay (2026-11-17) |

Still open from before: `--panics:on` (−149 KB) stays off the table. A
Defect must fail a node or a window, not the frame, and with the desktops
that is one scene of several.

## Rethinking the fundamentals: what each would buy

**No compiler on the device.** Three steps, each a different amount of
"final":

| Step | Saves | How it was counted |
|---|---:|---|
| The plane compiles the scene's graph and sends the program's text | −27 KB | `scene_compiler.nim` is 26,937 B in the image; its natives stay |
| ...and strips TypeScript and JSX to plain JavaScript | −7 KB | quickts' syntax, the 2026-11-10 estimate, not built |
| ...and sends bytecode: no parser in the image at all | −69,392 | built: a QuickJS whose contexts are given no `eval` (`JS_AddIntrinsicEval` left out, the linker drops the parser and the bytecode emitter). Includes the row above. |

About 96 KB for all of it. What it costs:

- **Bytecode is not checked.** `JS_ReadObject` trusts what it reads; crafted
  bytecode is memory corruption. Today the only native code a frame runs is
  the signed image: a plane, or whoever answers for a backend over plain
  HTTP on a LAN, can hand it a scene but not a way out of the interpreter.
  Bytecode from the plane moves that line to the plane. A verifier would
  give some of the bytes back and is not a small thing to get right.
- A frame with no plane installs scenes by itself, the Code editor scene
  changes a scene's files on the frame, and `eval` / `new Function` exist:
  each needs a plane to compile for it, or goes.
- Bytecode belongs to one build of quickts, so a plane needs a compiler for
  every firmware version in the field (the program's text has the same
  problem in a milder form: the natives and the kit it calls).
- What speaks for it besides flash: a deep sleeper parses its scene at every
  wake. That part can be had without the plane and without the risk: bytecode
  the device compiled itself, kept beside the scene on `/state`.

**Rewriting the runtime in C.** Nim is 1.49 MB of the image (46%): the
runtime 813 KB, pixie 372 KB, the stdlib 158 KB, the apps 65 KB, packages
26 KB, the font 58 KB. What of that is Nim's way of doing things rather than
the work itself can be counted:

| | Bytes |
|---|---:|
| Error propagation after every call that can raise a Defect (`--panics:on` is this number) | 148 KB |
| String literals: capacity words, headers and padding around about 72 KB of text | ~50 KB |
| Hooks and generics that are byte for byte another type's (the identical-code count below) | 22 KB |
| One hash-table and one seq implementation per type, after the sharing patches | ~58 KB |

A careful C version would keep the checks in some form and most of the
tables, so perhaps 150–250 KB less, for a rewrite of everything three hosts
share (the Pi, the ESP32 and the browser preview run the same Nim), or a fork
of the ESP32's half of it. Not recommended. What has paid, per byte of
effort, is the opposite direction: cold code as JavaScript bytecode in the
kit, which is about five times denser than what Nim compiles to (the program
apps: 8,650 B of Nim, 1,760 B of bytecode). The candidates by size are the
scene settings (37 KB), the scene switcher (15.6 KB) and the status screen
(12.7 KB): they are UI trees built in Nim so that they work with no
interpreter to hand, which is the thing to decide.

**Modular drivers.** Every panel is in every image so that one signed image
flashes any board and the panel is a setting. What a board never uses:

| | Bytes |
|---|---:|
| The 80 e-paper panel drivers and their table | ~62 KB |
| The LCD path in C (ST7701S, the splash, ESP-IDF's RGB panel driver) | ~21 KB |
| IT8951 (the E1003 alone) | 4.6 KB |
| Touch, codec, microphone, voice | ~14 KB |
| The SD card (FatFS, sdmmc, sdspi, the probe) | ~41 KB |

An image per board would be 70–120 KB smaller and an image per family
(e-paper, LCD) 25–65 KB, at the price of the one-image model: release assets
per family, an OTA manifest that knows the family, a reflash to change a
panel across families. Drivers loaded from `/state` keep one image but need
an ELF loader, position-independent drivers and signatures on them: not less
than 10 KB of loader for about 60 KB of drivers, and a new way to brick a
frame. The part that needs neither is below: 67 of the panel drivers carry
the same `SendCommand`, 62 the same `SendData`.

**The slot, not the image.** The limit is the 8 MB layout's two 3520 KB OTA
slots. The image compresses to 60% (xz 1,958,544 B, gzip 2,202,668): one
app slot of about 5 MB and a 2.5 MB slot for a compressed update would end
the problem, with a bootloader that unpacks, no previous version to roll back
to, and no way to move the frames already in the field (a partition table is
not changed over the air). A layout for new boards only does not lift the
limit while the old layout gets the same image.

## Counted, not built

- **Identical code.** `ld.bfd` folds none. Hashing every function that
  survives into the image (its bytes and what its relocations name): 294
  groups, 36,089 B to win: 22.4 KB in Nim (`=destroy` / `=wasMoved` /
  `=trace` hooks of types that happen to have the same shape, `[]` and `add`
  instantiated again per module), 10.5 KB in the panel drivers, 1.3 KB in
  `main`. For the Nim ones the route is `objcopy`: every copy renamed to one
  name and weakened, and the linker's garbage collection drops the rest. The
  drivers' copies are `static`, so theirs is a change to the vendored files
  or a fold like the inline one.
- **Calls into ROM and IRAM.** About 15,000 of them, 8,100 from FrameOS's own
  code, six bytes each for ever. A veneer in flash (`l32r a9, target; jx a9`: `a9`
  is free between a `CALL8` and the callee's `ENTRY`, ten bytes a target)
  within reach of the callers would make each a `CALL8`: up to 23 KB, less
  what the veneers cost and the hot modules left alone. The plain-C half of
  it is `memcpy` and `memset` in the generated Nim (1,758 calls, 5 KB).
- **newlib.** `tzset` parses `TZ` with `siscanf`, which is the only thing
  keeping the scanf engine (8,270 B); a TZ parser of our own would be about
  1 KB. `_svfprintf_r`, `_dtoa_r` and the bignum behind them are 19.9 KB for
  formatting, where QuickJS's `dtoa.c` already prints doubles; `strtod` is
  5.6 KB beside `js_atod`; `strerror`'s table 3.1 KB.

## A scene set as big as `/state`: +6,672, and what came back

A set bounded by the partition, not by a 512 KB constant (#891: scenes
written to slot files as they arrive and the index switched once, 128
scenes in 256 slots, one listing of the directory for a lookup a slot, a
collector that walks the partition once) took the 8 MB S3 image from
3,163,408 to 3,170,080. By object, before the linker:

| object | bytes | what |
|---|---:|---|
| `fos_scene_store.c` | +3,631 | the staging (`stage_begin` / `_write` / `_end` / `_open` / `_drop`, 1.9 KB), `make_entry` and `pick_slot` out of line now that two callers have them, the listing, a set written at once |
| `fos_scenes.c` | +3,444 | the fetch's three ways to read an answer and their retry (1.6 KB), the sink (0.6 KB), the commit in the take |
| `fos_scene_meta.c` | +1,029 | new: the index's fields read off a scene's bytes |
| `fos_spiffs_gc.c` | +252 | the one-walk eraser |
| `fos_scene_pieces.c`, `fos_backend_http.c` | +309 | scenes to a sink, an answer skipped by its ETag |

What came back without taking any of it away, a commit each:

| cut | image |
|---|---:|
| `scenes:toStore` is a `log_scene_event` line; no timer around every open, write and close of the sink | −576 |
| the commit of a staged set shares the patch's tail in the take; the staging's counters are the host test's | −176 |
| the fetch names a refusal in the store's words (`fos_scene_store_err_str`), no `ESP_LOGE` beside the event line, `/state` asked once | −256 |
| the store's three slot bitmaps set by one `slot_is(slot, what)` | −128 |
| one `big_alloc`, one staging check, "stored already" by the hash alone | −96 |
| one hand-off to the store task for a split and a sweep, one block for a set's scene starts | −84 of its own code |
| the scene reader tells `"settings"` and its commas off the text it kept | −80 |
| one call into the pieces reader from the HTTP body | −48 |

Together 3,170,080 → 3,168,784 (−1,296). Then the link order, written
again from that build (`link_order.py optimize`: the new object had no line,
and the file was 485 long calls staler than when it was written, 7,760 of
77,620 against 7,275): 7,394 left long and 3,168,784 → 3,167,232 (−1,552).
The change stands at +3,824 over main, and main gets the order's part of
that for nothing the next time the file is written from its own build.

The tool wants numpy, and `uv run --with numpy` picks an interpreter whose
numpy cannot load `libstdc++` on the dev box (the tool says so and runs a
quarter of an hour in plain Python): `uv run --python /usr/bin/python3
--with numpy python3 embedded/esp32/tools/link_order.py optimize ...` is
half a minute.

- **A cut's image number is its own bytes give or take 150.** The hand-off
  helper took 84 bytes out of `fos_scenes.c` in the linked image
  (`firmware-size.json`'s `files`) and the image grew 64: the functions
  behind it moved, and calls to them from other objects went long. Read a
  small cut off the object (`readelf -S`, a section a function) or the
  per-file number, and the image at the end.
- **A diagnostic line with its own format is 400 bytes.** A JSON line of
  nine fields, its `snprintf`, and a pair of `esp_timer_get_time()` calls
  around three call sites. Through the helper every scene line uses it is 100.
- Not done: the store's "a kept scene must still be that scene" check at
  commit (the hash of each scene found stored, kept until the index
  switches). Ending the staging on any other change would do without it,
  about 150 bytes, and changes what a tested guard does.
- Not done: the put path through the staging (one way to write a scene to
  a new slot). A put is parsed whole before it is stored; a staged scene is
  read for its index fields only.
- Not done: the tables in PSRAM as statics (`EXT_RAM_BSS_ATTR`) for the
  `fos_big_malloc`-else-`malloc` blocks: `CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY`
  is off, and a board without PSRAM would hold 17 KB of slot rows in DRAM.
- Counted, not built: the combined scenes file. A producer's whole payload
  (the cloud, HTTP, USB) is still written as one file and split by the
  store task, beside a per-scene store that takes a set as changes or as it
  arrives: `split_puts_locked`, `ensure_split_locked`, `store_split_stored`,
  the split's no-room record and `fos_scene_store_write_set` are 1.3 KB by
  name, with more inside `fos_scenes_set_json_from`, `store_backend_payload`
  and the apply's whole-file load. A frame in the field may hold a combined
  file, so the reader stays whatever the writers do.

## Fonts on the card read in place: −32,704, and emoji +3.3 KB back

Every font on the SD card is read where it lies (pixie's
`fontformats/filefont.nim`, docs/esp32-fonts.md) instead of one at a time
parsed whole, so nothing on an ESP32 calls pixie's OpenType parser any more
and it leaves the image: 3,207,904 → 3,175,200 on the S3 (EPD_7in5_V2,
against main at f257c8244 built the same way, 2026-11-20). Colour emoji from
the card's CBDT font came after, about +3.3 KB by symbol (CBLC searched in
place 1.4 KB, the colour glyph cache and its draw 1.4 KB, the fallback
0.4 KB; pixie's PNG decoder and image draw were in the image): the branch
then stood at 3,209,584 → 3,181,504 against main at 9afaa9ac8 (−28,080). By
symbol (`nm -S`, before the linker's alignment), the fonts:

| | bytes | what |
|---|---:|---|
| `opentype.nim` | −35,365 | the whole parse: CFF charstrings, cmap, hmtx, name, OS/2, GPOS pair tables built in RAM, COLR/CPAL, CBLC/CBDT, sbix |
| its constants | −6,354 | CFF's standard strings (4 KB) and the parse's literals |
| `filefont.nim` | +7,648 | the open 1.4 KB, its own `parseCompositeGlyph` 1.0 KB, kerning and the subtable index 1.7 KB, the page cache and its three tables 1.4 KB |
| `utils/font.nim` | +2,197 | the family resolver and the folder's listing, on the ESP32 now, and `fileTypeface` |
| `fonts.nim` | +496 | a `file` branch in each accessor |

The first cut was 2.6 KB bigger: the faces by name in an `OrderedTable` and
the refused names in a `Table` (a list each now: there are few, and each
table instance is about a kilobyte), the table tags computed at every
comparison (compile-time constants now).

- Not done: `parseCompositeGlyph` is generic, an instance per font kind
  (on the ESP32 now the indexed font's and this one, opentype's gone): one
  over a "read this glyph" proc would save about 1 KB.

## Emoji in JSX and SVG text, and the bus lent: +1,920

Against main at 78332f32c built the same way (2026-11-21): 3,191,664 →
3,193,584. By symbol: the JSX layer's emoji `<image>` (`emitColorGlyph`,
0.5 KB, and 0.2 KB in `emitText` / `emitGlyphs`), the SVG reader's
(`addColorGlyphs` 0.7 KB, 0.1 KB in `parseSvgText`), the colour glyph cache
taking a whole-parsed face's bitmap too (+0.1 KB net) and `colorGlyphImage`
(0.1 KB); the shared bus lent during the panel's waits, 0.15 KB
(`DEV_Delay_ms`, `DEV_Digital_Write`).

## What the dependencies still carried: −47,232 (2026-11-21)

Against main at 2032552e5 built the same way (`ci_build_image.sh`,
`EPD_7in5_V2`, 8 MB layout): **3,214,144 → 3,166,912 bytes**, the OTA slot
89.2% → 87.9% full. The way in: host `readelf -rW` reads the xtensa objects
of the build's nimcache, each `.rela.text.<fn>` lists what `<fn>` calls, and
with the map's sizes that is a call graph: cut the edges of a branch that
cannot run on a frame and see what nothing reaches any more. By module, from
the two maps:

| Cut | Saves | How |
|---|---:|---|
| The rest of pixie's OpenType reader | ≈ −14,100 | #943 took `parseOpenType` out, but `fonts.nim` asked every typeface for its `opentype` in fifteen accessors, which kept the CFF charstring parse, the sbix/CBDT/COLR glyph paths, `glyphBox`, kerning and an instance of `parseCompositeGlyph` (opentype −13,343 with the fold below, fonts −1,659). `-d:pixieNoOpenType` takes the field and its branches out; `readTypeface` / `parseTtf` do not exist on the ESP32 now, and a Context opens its font file in place. |
| `fillPath` / `strokePath` made for `string` | −8,697 | `SomePath = Path \| string`, and the SVG reader handed its late path data (`lateData`, solid paint only) straight in: a second `fillPath` (3.8 KB), `strokePath` (4.0 KB), `fillGradientBox` (1.7 KB). `fillPathText` / `strokePathText` draw one colour from the commands' flattening (anything else through a Path), and the stroke's batch loop is one non-generic `strokeSolidShapes`. |
| One inflater | −5,315 | zippy's inflate, gzip, adler32 and their helpers (−5,992) beside pixie's `inflatestream`: PNG's interlaced decode, the built-in face's blocks and the time zone aliases go through `uncompressZlib` / `uncompressDeflate` (+677). An output of known size under the window is inflated in a buffer its own size, so a font block is no 64 KB allocation; the IDAT chunks are read where they lie, not joined first. zippy's `crc32` stays (PNG). |
| Strings hashed with murmur (`-d:nimStringHash2`) | −3,220 | `hash(string)` inlined FarmHash, 64-bit arithmetic on a 32-bit core. No string hash leaves the runtime; a string-keyed `Table` iterates in another order. Part of the tables' −2,413 below is this too. |
| chrono's time zones without `json.to` | −3,282 | `loadTzData`'s `to(seq[TimeZone])` / `to(seq[DstChange])` was the only user of std/json's typed reader (json −4,086, chrono −397); `tz.nim` reads the two shapes itself (+1,201). |
| QOI (`-d:pixieNoQoi`) | −2,542 | as PPM: no web fetch, scene asset or upload produces one. The extension lists follow: `localImage` and the Files scene leave QOI and PPM out on an ESP32, the SPA's path picker too (`utils/pathExtensions.ts`), and WebP, which every runtime decodes, is on the lists now. |
| `parsePngStructure` once | −1,903 | the contiguous parser is the segmented one over one segment (4,098 → 2,195 by symbol). |
| std/uri for one host | −2,106 | `embeddedSizedRemoteImageUrl` cut the Unsplash URL at `?` and `#` with `parseUri` and `$` (uri −2,314, parseutils −521, image +729). |
| `parseCompositeGlyph` once | ≈ −900 | the generic is a reader proc and one non-generic body (`parseCompositeGlyphWith`), for the indexed face and the card's fonts (3,082 → 1,148 by symbol, opentype's copy included). |

The rest is what went with them: table and seq instances, hooks, strings
(tables −2,413, system −1,347, about −1.5 KB scattered). Behaviour is
unchanged except where the table says (a QOI on an ESP32, a Table's order).

Looked at and kept: blend modes (a field of render/image and render/svg),
chrono's `format` / `parseTs` (the JS chrono bindings), `zip_entry` (the JS
assets API), GIF and BMP (decision 2026-11-21). Not done, needs work: std/xml
(`parsexml`, `xmlparser`, `xmltree`, `strtabs`, about 10 KB) leaves only if
the SVG reader's fast parser learns entities, text and CDATA and the Nim
`xmlToJson` app is retired to JavaScript; kept for now (2026-11-21).

## Dead ends

- **Jump tables** (`-fjump-tables -ftree-switch-conversion` on the Nim
  runtime and QuickJS; ESP-IDF turns them off for code that may run with the
  cache off, which neither does): text −8.3 KB, rodata +11.3 KB, the image
  +2,992 bytes.
- Literal pools are not the problem they look like: 79 KB of them, of which
  16 KB repeat a value another pool in reach already holds. The linker merges
  what it can.
