# ESP32 firmware size audit, 2026-10-26

*Generic `esp32-s3` image, 8 MB layout (3520K OTA slot), `EPD_7in5_V2` default
panel. Every number is a full `ci_build_image.sh` build in the
`frameos-esp32-ci-check` container, or the CI size comment where it says so.*

What grew between the v2026.10.20 release and main at 3d2c47f4d, what the open
ESP32 PRs (#622, #626, #628, #629) add on top, and what can come out. Nothing
here is applied yet: the cuts were measured on prototype trees outside the repo.

**Summary.** Main is +49,936 B over v2026.10.20 (88.7% of the slot, 398 KB
free). The open stack adds about 103 KB more (91.6%, about 297 KB free). The
cuts below, applied together to main, measured **−173,648 B**
(3,178,784 → 3,005,136 locally, 83.4% of the slot). In CI terms main would land
near 3,023,000 B, and main plus the whole open stack near 3,123,000 B: below the
v2026.10.20 release's 3,146,976.

The largest single cut needs no behaviour change: the embedded font carries
88.5 KB of tables that pixie never reads.

## Where the growth came from

### Main since v2026.10.20 (CI artifacts, one per merge)

| PR | Δ app bytes | Biggest pieces |
|---|---:|---|
| #621 reTerminal Sticky | +24,416 | `input_state.nim` +7,709 (the pointer and gesture half, until now host-only), `tables.nim` +1,281 (its `Table[int, PointerRecord]`), `event_loop.nim` +1,163, `fos_codec.c` +2,908, `fos_touch.c` +2,522, C string pool +2,725 |
| #623 outline and gradient | +6,464 | `utils/text.nim` +4,391 (`blendCoverage` 2,698 at -O2, `fillTextApproxStroke` +1,142), gradient app +1,098 |
| #624 reTerminal E1003 | +18,832 | pixie's Gray8 surface ≈ 10 KB (`images.nim` +3,620, `paths.nim` +2,102, `common.nim` +1,475, `paints.nim` +1,443), `it8951.c` +2,446, `utils/image.nim` and `asset_colors.nim` ≈ 1.8 KB |
| #630 HTTP auth gate | +224 | `fos_http.c` |
| **main** | **+49,936** | 3,196,912 B |

Most of the C is feature code with little to take out. The Gray8 surface is
required: a 1872×1404 RGBA canvas is 10.5 MB, more than the PSRAM.

### The open stack (local builds, each against the one below it)

| PR | Δ app bytes | Biggest pieces |
|---|---:|---|
| #622 SenseCAP Indicator | +17,680 | ESP-IDF's RGB LCD driver 12.4 KB (`esp_lcd_panel_rgb.c` 7,424, `lcd_st7701s_rgb.c` 3,527, gdma 1,491), C strings +1,224 |
| #626 real-time rendering | +40,352 | pixie SVG damage and fast parser +9,267 (`parseSvgXmlFast` 3,033, `damage` 1,375) plus +2,864 of SVG seq hooks in `system.nim`; `events_gen.nim` +3,421; `resample.nim` +2,877; `fos_client.c` +2,841; `fos_assets_flash.c` +2,100 |
| #628 JSX layout | ≈ +36,000 | `ui/layout.nim` +19,789 (`layoutFlex` 4,343), `ui/tailwind.nim` +10,115 (`applyClass` 3,992 + 1,916 of strings) |
| #629 JSX events | +9,232 | `ui/events.nim` +3,120, `app_runtime.nim` +2,302, `ui/layout.nim` +1,765 |
| **stack** | **+103,264** | ≈ 3,300,000 B in CI terms |

#626 contains #622's commits, and #628 was built on an earlier #626, so the
#628 row is approximate.

## Cuts, measured

| Cut | Saves | Behaviour change |
|---|---:|---|
| Font: strip hinting, `hdmx`, `VDMX`, `GSUB` and glyph names | −88,500 | none |
| QuickJS without `CONFIG_ALL_UNICODE` | ≈ −45,300 | ESP32 only: no `normalize()`, no `\p{…}` |
| QuickJS without `CONFIG_ATOMICS` | ≈ −6,200 | none in practice |
| Wi-Fi Kconfig: softAP SAE, SAE-PK, OWE off | −11,567 | rare network types only |
| mbedTLS Kconfig: unused curves and parsers off | −6,794 | obsolete TLS setups only |
| tz alias table deflated on embedded | −6,076 | none |
| PPM decoder no longer re-imported | −3,536 | none (matches `-d:pixieNoPpm`) |
| `input_state`: seq of pointers, one payload builder | −2,367 | none |
| Outline blend: 565 and gray branch out of the -O2 loop | −1,127 | check speed |
| C string pool, from the above | −1,454 | |
| **All of the above, one build** | **−173,648** | |
| #626 only: payload keys for alias names only | −3,104 | none |

### Font: −88,500

`assets/compiled/fonts/Ubuntu-Regular.ttf` (300 KB raw, 146,125 B gzipped as
`fonts.nim`) is the default font on every runtime. pixie draws outlines with
its own rasterizer and parses `cmap`, `head`, `hhea`, `maxp`, `hmtx`, `name`,
`OS/2`, `loca`, `glyf`, `kern`, `GPOS` (pair kerning, lookup type 2 only) and
the `post` header. The file also carries TrueType hinting (`fpgm`, `prep`,
`cvt `, and instructions inside every glyph), `hdmx` (35 KB of hinted device
metrics), `VDMX`, `GSUB`, `gasp` and 11 KB of glyph names. None of these is
read.

```python
from fontTools import subset
from fontTools.ttLib import TTFont

opts = subset.Options()
opts.hinting = False
opts.glyph_names = False
opts.notdef_outline = True
opts.recalc_bounds = False
opts.name_IDs = ["*"]
opts.name_languages = ["*"]
opts.legacy_kern = True
opts.layout_features = ["kern"]
opts.prune_unicode_ranges = False
opts.drop_tables = ["hdmx", "VDMX", "GSUB", "DSIG", "LTSH", "PCLT", "gasp"]
font = TTFont("Ubuntu-Regular.ttf")
sub = subset.Subsetter(opts)
sub.populate(unicodes=font.getBestCmap().keys())
sub.subset(font)
font.save("Ubuntu-Regular.stripped.ttf")
```

Result: 299,684 → 140,620 B raw, 146,125 → 57,624 B gzipped. Checked with
fontTools against the original: the same 1,194 codepoints, identical glyph
coordinates, flags and advances for every one of them, and all 56,975 kerning
pairs equal. `head.indexToLocFormat` becomes short and `numberOfHMetrics`
shrinks; pixie's `parseLocaTable` and `getAdvance` handle both per spec. The
50 glyphs dropped (1262 → 1212) were reachable only through `GSUB`.

The same file is compiled into the Linux runtime and the wasm preview, so they
shrink too, and the decompressed font every runtime holds in memory drops from
300 KB to 141 KB.

Before shipping it:

- The Ubuntu Font Licence, clause 2(c), requires a Modified Version that is not
  Substantially Changed to keep the original name with "derivative X" appended.
  Rename the family in the `name` table (for example "Ubuntu derivative
  FrameOS"). FrameOS loads the font by file name, so nothing else changes.
- `e2e/frontend-visual/scripts/seed_backend.py` draws seed images with this file
  through PIL, and FreeType does hint. Point it at
  `assets/copied/fonts/Ubuntu-Regular.ttf` (today byte-identical to the compiled
  one, and it stays the original) or its seeds change.
- The e2e scene snapshots render through pixie and should come out unchanged.
  That is the end-to-end check.

### QuickJS unicode tables: ≈ −45,300

`libunicode.h` defines `CONFIG_ALL_UNICODE` unconditionally ("40KB larger").
Without it QuickJS drops the normalization tables (`unicode_decomp_data`
9,452 and its companions), the script, category and property tables for regex
`\p{…}`, and the emoji-sequence tables. What a scene loses:

- `String.prototype.normalize` is gone (a call throws a TypeError).
- `\p{…}` and `\P{…}` in a `/u` or `/v` regex throw a SyntaxError.
- Unaffected: non-ASCII identifiers (any non-space character is accepted),
  `toUpperCase`/`toLowerCase`, case-insensitive regexes. `localeCompare` falls
  back to a code-unit comparison.

No repo app or repo scene uses either feature. Store scenes were not scanned.

What it takes:

- **A quickts release.** The source is the pinned tarball
  `quickjs-2026-06-04-quickts.1` (`frameos.nimble`,
  `tools/install_prebuilt_quickjs.py`, `tools/build_wasm.sh`), so the define
  needs to become conditional there, and the ESP32's
  `components/frameos_quickjs/CMakeLists.txt` turns it off. Linux and the
  preview keep the full tables.
- **One more guard in `libunicode.c`.** Upstream's emoji-sequence code (from
  `#define SEQ_MAX_LEN 16` to the end of the file) is outside the guard and
  does not compile without the define. Its only caller, in `libregexp.c`, is
  already inside one.
- **A line in `docs/scene-guide.md`** under small devices, since both scene AIs
  read it. This is a known host difference.

### QuickJS Atomics: ≈ −6,200

`quickjs.c` defines `CONFIG_ATOMICS` for every non-emscripten build. On the
ESP32 that links `js_atomics_op` and its friends (≈ 3 KB) plus newlib's atomic
emulation and `pthread_cond_timedwait` (`stdatomic.c` 1,541,
`stdatomic_s32c1i.c` 927, `pthread_cond_var.c` 552). The JS runtime is single
threaded and has no SharedArrayBuffer to share. This goes in the same quickts
release.

### Wi-Fi Kconfig: −11,567

```
# CONFIG_ESP_WIFI_SOFTAP_SAE_SUPPORT is not set
# CONFIG_ESP_WIFI_ENABLE_SAE_PK is not set
# CONFIG_ESP_WIFI_ENABLE_WPA3_OWE_STA is not set
# CONFIG_ESP_WIFI_ENTERPRISE_SUPPORT is not set
```

- softAP SAE: the setup hotspot is WPA2-PSK (`fos_wifi.c`, `.authmode =
  WIFI_AUTH_WPA2_PSK`). Removes `handle_auth_sae`, `sae_sm_step`, the hostap
  WPA3 task, comeback tokens and the authenticator PMKSA cache.
- SAE-PK (`sae_pk.c` 2,854 and `aes-siv.c` 657): WPA3 public-key mode for
  hotspots, rare at home. WPA3-SAE itself stays.
- OWE ("Enhanced Open", `owe_process_assoc_resp`): rare.
- Enterprise saved nothing (the EAP client was never linked) and is listed only
  to keep it out.

### mbedTLS Kconfig: −6,794

```
# CONFIG_MBEDTLS_ECP_DP_SECP192R1_ENABLED is not set
# CONFIG_MBEDTLS_ECP_DP_SECP224R1_ENABLED is not set
# CONFIG_MBEDTLS_ECP_DP_SECP192K1_ENABLED is not set
# CONFIG_MBEDTLS_ECP_DP_SECP224K1_ENABLED is not set
# CONFIG_MBEDTLS_ECP_DP_SECP256K1_ENABLED is not set
# CONFIG_MBEDTLS_ECP_DP_BP256R1_ENABLED is not set
# CONFIG_MBEDTLS_ECP_DP_BP384R1_ENABLED is not set
# CONFIG_MBEDTLS_ECP_DP_BP512R1_ENABLED is not set
# CONFIG_MBEDTLS_KEY_EXCHANGE_ECDH_ECDSA is not set
# CONFIG_MBEDTLS_KEY_EXCHANGE_ECDH_RSA is not set
# CONFIG_MBEDTLS_SSL_RENEGOTIATION is not set
# CONFIG_MBEDTLS_X509_CRL_PARSE_C is not set
# CONFIG_MBEDTLS_X509_CSR_PARSE_C is not set
# CONFIG_MBEDTLS_PKCS7_C is not set
# CONFIG_MBEDTLS_SERVER_SSL_SESSION_TICKETS is not set
```

P-256, P-384, P-521 and X25519 stay, which is what WPA3-SAE and every public
TLS server use. `ecp_curves.c` −3,199 is most of it. Server session tickets
were part of the measured set; keep them if the frame's HTTPS server (browsers
reconnecting) should resume rather than redo the handshake, at a cost of a few
hundred bytes.

### tz alias table: −6,076

`lib/tz.nim` embeds `timezone_aliases.json` (8,577 B, Windows and legacy zone
names for iCal `TZID`s) as a string literal and parses it into a table on first
use. On embedded, the prototype stores it raw-deflated (2,462 B) and inflates
it with zippy's `dfDeflate`, already linked for the font. The raw format avoids
the gzip trailer check that overflows on 32-bit (see `utils/font.nim`). The
round trip is checked equal (252 aliases). The bytes should come from a
generator, as `fonts.nim` does, rather than a committed blob.

### PPM decoder: −3,536

`build_nim.sh` passes `-d:pixieNoPpm` (#407, 2026-08-28) because "no frame is
ever handed a .ppm". But `utils/image.nim`'s streaming path had imported
`pixie/fileformats/ppm` on embedded since #307 (2026-08-08), so the flag only
removed pixie's own dispatch and `decodePpmStreamScaledInto` stayed linked. The import
and the `streamablePpm` check go under `when not defined(pixieNoPpm)`; the
`when compiles(decodePpmStreamScaledInto(...))` branch in `streamDecodeInto`
already handles the decoder being absent.

### `input_state` pointer half: −2,367 of its +10.1 KB

- `pointers: seq[PointerRecord]`, the id inside the record, found by a linear
  search, instead of a `Table[int, PointerRecord]`. A frame has a handful of
  pointers. Drops the whole table instantiation (−1,287 in `tables.nim`).
- One `pointerEvent(rec, name, origin, button)` builds every pointer and
  gesture payload, in place of three `%*{…}` sites and two `payload["button"] =`
  edits. The payloads and their key order are unchanged.
- On the ESP32, `textInput` returns false from `applyNamedPointerOrKey`, so one
  sent anyway is delivered as it came. The contract gives the ESP32 no keyboard.
- One visible difference: when several pointers are cancelled together, the
  cancels come in insertion order instead of table order.

`test_input_state`, `test_event_fixtures` and `test_event_loop` pass on the
prototype.

### Outline blend: −1,127

`blendCoverage` (#623) runs at -O2, and its branch for canvases that are not
RGBX inlines pixie's `getPixel`/`setPixel` per format. Moving that branch into a
`{.noinline.}` helper keeps the RGBX loop as it is and gives the 565 and gray
canvases a call per covered pixel. `test_text` passes. This should be timed on
an LCD board or the E1003 before it lands, since #623 was a speed fix.

### #626: alias payload keys, −3,104

#626 delivers the old pointer names (`mouseMove`, `mouseDown`, `mouseUp`) on
the ESP32 as well, which brings in `eventPayloadKey` and `eventPayloadKeyCount`
(2,739 B of nested `case` chains over every event in the contract). The
dispatcher only ever asks them about alias names. A generated
`aliasPayloadKey`/`aliasPayloadKeyCount` covering only names some event lists
as `aliasOf` (three names, four keys) took back 3,104 of #626's 3,421. It
belongs in `tools/generate_events_contract.py` (its `--check` keeps the file
honest).

## Larger levers that need a decision

| Lever | Saves | Cost |
|---|---:|---|
| `--panics:on` | −147,920 (measured 2026-09-01) | An out-of-memory render reboots the frame instead of degrading (the `except Defect` containment in `embedded_main.nim` goes dead). The escape hatch is a patched `system/fatal.nim` that longjmps to a barrier at the render entry. |
| calendar, icalJson and eventsToAgenda as JS repo apps | −88,613 of Nim (50,110 + 30,003 + 8,500) | The retired-apps path (`docs/retired-apps.md`): a port, conversions on both planes, and iCal parsing in QuickJS within an ESP32's memory. |
| One XML parser | ≈ −10 KB | `parsexml`, `xmlparser`, `xmltree` and `lexbase` (12,668 B) stay because `xmlToJson` and pixie's full-SVG fallback use them, while pixie's fast parser covers markup an app writes. Making one complete (entities, CDATA, declarations, text) is parser work with correctness risk. |
| Tailwind classes as a table (#628) | ≈ −2 KB, not measured | `applyClass` is a 3,992 B `case` over class names plus 1,916 B of strings. |
| `appCapabilities` as data | ≈ −3 KB, not measured | The generated `apps/apps.nim` builds an object with five seqs per app at runtime (3,694 B of code, 1,736 B of strings). |

The remaining big blocks were measured before and stay: the 52 hash-table
instantiations (≈ 16 KB ceiling, `docs/esp32-image-size.md`), newlib's
`vfprintf` (nano formatting lacks `%lld`), IPv6, the font's Greek and Cyrillic
(after the strip, a Latin subset would buy about 25 KB more and blank those
scripts).

## Still to check

- The combined image was built, not booted: no QEMU smoke, no bench run.
- Store scenes were not scanned for `normalize()` or `\p{…}`.
- The outline change needs a timing on a 565 or gray canvas.
- The font change needs the e2e scene snapshots (expected unchanged) and the
  licence rename.

## How these were measured

- Each tree is a `git archive` of the ref (`embedded frameos docs backend/app
  repo versions.json`) plus the generated `frameos/src/assets` font module,
  `frameos/quickjs` and a `nimble.paths` pointing at the ref's locked pixie in
  `~/.nimble/pkgs2`, built with `ci_build_image.sh` in `frameos-esp32-ci-check`
  (`-v ~/.nimble:/Users/marius/.nimble:ro`, `FRAMEOS_ESP32_BUILD_DIR` inside the
  tree). Never rsync the main checkout: it holds tens of GB of caches.
- The local container builds about 18 KB smaller than CI in absolute terms
  (v2026.10.20: 3,129,248 locally, 3,146,976 released; the gap is in the Nim
  objects, so the image's Nim differs). Deltas agree: main over the release is
  +49,536 locally and +49,936 on CI.
- Per-symbol diffs come from the linker map, summing input sections per
  (object, section) with `_u<n>`, `$constprop$<n>` and `TM__<hash>_<n>`
  normalized. Merged string sections (`.rodata.*.str1.1`) are listed
  overlapping: the first carries the whole merged pool (the "efuse" row) and
  the rest their pre-merge sizes at the same address, so they must not be
  summed. Use the pre-merge sizes only to see which object added strings.
- Per-merge numbers for main come from each push's `esp32-firmware-size`
  artifact (`e2e-docker.yml`), diffed against the release's
  `-esp32-s3-generic-size.json`.
