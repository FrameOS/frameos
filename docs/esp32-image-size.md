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
subsystem total; the comment renders it under "Inside each subsystem"
(`render --detail-top N` controls how many rows per subsystem, default 12).
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
3. **Silent assertions** (`CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_SILENT`):
   strips assert strings from the 152 KB string pool.
4. **Config-gate heavy optional apps** (~100–200 KB): calendar+ical is 85 KB;
   wikicommons/openai/unsplash/chart add up.
5. **Drop unused pixie decoders** (−60 KB): webp + svg if not needed on-device.
6. **Move the font to SPIFFS** (−195 KB total): the `state` partition has room
   on every profile except 4 MB.
