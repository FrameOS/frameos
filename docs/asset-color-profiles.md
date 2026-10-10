# Per-photo color profiles (`<image>.frameos.json`)

A photo in the assets folder may sit next to a small JSON sidecar that says
how it should be graded before the panel dither sees it. The Assets panel's
**Set colors** editor writes the file and previews it; the runtime applies it
whenever it loads that photo. The editor's **Auto** is a preset: it fills the
Whites and Blacks sliders in from the photo's histogram, so a saved profile
is always plain sliders and the runtime has nothing to measure. The two implementations are mirrors and must
stay in step:

| Side | Code | Pinned by |
|---|---|---|
| Runtime (Pi, ESP32, wasm) | `frameos/src/frameos/utils/asset_colors.nim` | `utils/tests/test_asset_colors.nim` (parity vectors) |
| Editor preview | `frontend/src/utils/assetColors/{profile,adjust,dither,devicePalette}.ts` | `cloud/apps/auth-web/src/test/shared-spa/asset-colors.test.ts` (same vectors) |

## Why

A six-color Spectra panel's measured white is `#b2c1c0` (178, 193, 192).
Everything in a photo brighter than that quantises to solid white and the
diffused error is clipped away: the highlights go flat. Pulling **Whites**
down, or switching on **Auto**, keeps the photo inside the range the panel can
actually show, so the dither has something to work with. The rest is ordinary
grading, per photo, with a preview that runs the panel's own dither.

## The file

`photos/cat.jpg` → `photos/cat.jpg.frameos.json`, next to the image, in the
same folder. The name is deliberately **not** dot-prefixed: every device write
path refuses hidden names (the cloud hub's `asset_put`, the ESP32, the admin
upload sanitiser), and the sidecar must travel through the same verbs an image
does. The Assets panel hides it from the tree (it is an icon on the photo's
row), renames and deletes it with the photo, and the image apps never pick it
up as an image.

```json
{
  "version": 1,
  "colors": {
    "exposure": 0.4,
    "contrast": 25,
    "whites": -30,
    "blacks": 15,
    "saturation": 20,
    "shadows":    { "luminance": -10, "r": 0, "g": 0, "b": 20 },
    "midtones":   { "luminance": 0,   "r": 10, "g": 0, "b": 0 },
    "highlights": { "luminance": 15,  "r": 0, "g": -10, "b": 0 },
    "hues": {
      "red":   { "hue": 40, "saturation": -30, "luminance": 20 },
      "green": { "hue": -50, "saturation": 60, "luminance": -20 }
    },
    "palette": ["#191426", "#b2c1c0", "#c7bb00", "#6b1119", "#18539a", "#2a5531"]
  }
}
```

Every key is optional and neutral when missing; unknown keys are ignored, so
an older runtime reads a newer file. Sliders are `-100 .. 100` except
`exposure` (stops, `-3 .. 3`) and each hue range's `hue` (degrees, `-180 ..
180`). Hue ranges are `red, orange, yellow, green,
aqua, blue, purple, magenta`. An `auto` key from the first editor build is
ignored. `palette` is `["#rrggbb", …]` or `[[r, g, b],
…]`; one bad entry voids the whole override. A sidecar over 64 KB, or one that
does not parse, is treated as absent — a broken sidecar never takes the photo
down with it.

## The pipeline

Per pixel, channels as floats `0 .. 1`, in this order (`adjustPixel` in both
implementations):

1. **Exposure** — `× 2^stops`.
2. **Blacks / Whites** — `blackPoint = -blacks/100 × 0.4`, `whitePoint = 1 −
   whites/100 × 0.4`, `v = (v − blackPoint) / max(whitePoint − blackPoint,
   0.2)`. Negative whites pulls the highlights below the panel's white; a
   white point of 1.4 is what a Spectra panel needs to take a photo's full
   range, which is why the range is 0.4.
3. **Contrast** — `(v − 0.5) × max(1 + contrast/100, 0) + 0.5`, then clamp.
4. **Tones** — with `L` the luminance, weights `shadows = (1−L)²`,
   `highlights = L²`, `midtones = 1 − shadows − highlights`; each range adds
   `w × luminance/100 × 0.5` to every channel and `w × tint/100 × 0.35` to
   its own channel. Clamp.
5. **Saturation** — `L + (v − L) × max(1 + saturation/100, 0)`. Clamp.
6. **Hues** — in HSL, for pixels with saturation above 0.001: weights are a
   piecewise-linear interpolation between the neighbouring hue centres
   (0, 30, 60, 120, 180, 240, 280, 320°). `hue` rotates by that many degrees,
   `saturation` scales, `luminance` shifts by `0.3 × S × Σ w·lum/100` (greys
   are untouched). Back to RGB, clamp.
7. Round to 8 bits. Alpha is kept.

## The automatic fit (on the frame, by default)

A palette panel cannot show a photo's whites, so the frame fits every image
it draws. `frame.json`'s `colors` block:

```json
{ "autoFit": "default", "global": { "whites": -10, "hues": { "blue": { "saturation": 20 } } } }
```

* `autoFit`: `default` (on when the panel dithers to a palette, off on a
  full-color display), `on` or `off`. On a Pi the palette comes from the
  device name plus a six-color custom palette (`panelPaletteForDevice`), on
  the ESP32 from the display format at render time.
* `global`: the sidecar's slider set without a palette, applied once to the
  whole finished canvas on every display, after the fit. Neutral by default.

The fit is applied by the **consumer**, not the producer: `apps/render/image`
and the JS runtime's draw call fit the rectangle the image landed on, right
after drawing it (`applyAutoFitToDrawn`). That covers every source — a local
file, a URL, Immich, OpenAI, a JS app's own fetch — and is idempotent, since
the canvas is new each render while a producer's output is cached for
minutes. It takes the rectangle's luminance percentiles 0.5 and 99.5 and
solves for the Whites and Blacks that map that range onto the palette's
(`autoEndPoints`, the same arithmetic as the editor's Auto preset):

    scale = (dstHi − dstLo) / (srcHi − srcLo)
    blackPoint = srcLo − dstLo / scale,  whitePoint = blackPoint + 1 / scale
    blacks = −blackPoint / 0.4 × 100,    whites = (1 − whitePoint) / 0.4 × 100

A linear profile (exposure, end points, contrast — the fit always is) runs
as one 256-entry lookup table per channel (`linearLut`), three lookups per
pixel, which is what makes it affordable on every render of a 13.3" panel on
an ESP32. Nothing is allocated beyond a 1 KB histogram; there is no second
canvas and no second pass.

A photo whose sidecar the producer applied is marked (`markImageGraded`, a
ring of weak pointers cleared on a scene change) and the consumer skips the
fit for it: explicit sliders win. Non-photos drawn through `render/image`
(QR codes, icons, charts) are fitted too; pure black and white are
unaffected, mid-greys compress a little, by choice.

In the editor, a photo without a sidecar opens on the Auto preset when the
frame's fit is on for its panel: what it shows is what the frame does.
Saving it untouched changes nothing; moving a slider opts the photo out.
The Adjustments select is **None**, **Auto** or **Custom**, derived from the
sliders.

The ESP32 keeps the block as compact JSON in its config (`fos_config_t.colors`,
NVS), fed from the backend's settings poll (`frame.colors`) or the cloud's
`set_settings`, and pushes it into the Nim runtime every pass like
`scalingMode` (`fos_nim_set_colors`), so it applies live.

The cloud's scene preview (scenes.frameos.net) does the same on the finished
frame while a panel is chosen: **Auto colors** (on by default) and a
**Fine tuning** slider set run through the `beforeDither` hook of
`frameos-wasm`'s `FrameOSPreview` before the browser-side dither. The
preview has only the finished frame, so the whole picture stands in for the
photo; both are display only and remembered per browser.

## The dither palette override

`palette` replaces the colors the panel dither quantises against, for this
photo only. The runtime leaves it in `renderPaletteOverride`
(`utils/dither.nim`) when the photo is loaded; every palette dither on the
render thread picks it up through `activePalette(default)`, which also puts
the Spectra table's `(999, 999, 999)` placeholder back at index 4 for a
six-color override. It is **sticky** until the next photo without one is
loaded or the scene changes (`runner.nim`, `single_scene_host.nim`), because
the image app's output is cached for minutes and a per-pass flag would hold
only for the render that decoded the file. On a Pi the override crosses the
driver `.so` boundary through the optional `frameos_driver_set_render_palette`
symbol (`driver_abi.nim`; a library from before it keeps its built-in
palette). On the ESP32 the packer reads it directly. The wasm preview does
not dither.

Under the per-photo override sits the frame's own palette (frame.json
`palette`, the Palette section of the settings panel): the Pi driver reads it
at init, the ESP32 keeps the color list in its config (`fos_config_t.palette`,
pushed into the runtime every pass like `colors`) and fits it onto the
panel's table with the same `fitPaletteOverride` the per-photo path uses —
so a six-color list lands on a Spectra panel with the hole put back. The
automatic fit aims for that palette too (`panelPaletteForFormat`). Cloud and
backend push it from firmware 2026.10.4 on (`docs/cloud-frames-contract.json`).

## Where the runtime applies it

* `apps/data/localImage` — after decode. With a profile to apply, `contain`
  skips the decode-into-canvas path (the adjustments must not touch the
  canvas around the photo); `cover` and `stretch` adjust the canvas in place.
* The JS runtime's `loadAssetImage(path)` — same treatment.
* Thumbnails are **not** adjusted: the `.thumbs/` cache is keyed on the image
  alone, and the preview belongs in the editor.
* The panel palette the editor previews with comes from the device name
  (`devicePalette.ts`, with a six-color custom palette winning on a Spectra
  panel) — the same table as the runtime's `panelPaletteForDevice`.

## The Assets panel

* The listing is loaded a folder at a time (`GET …/assets?folder=<rel>`,
  `""` for the root; the server echoes `folder`, an older one lists
  everything). Backend, cloud and the on-device admin API all answer it; a
  backend prefers a frame's admin API for listings and thumbnails and falls
  back to SSH (one thumbnail at a time per frame — a burst of them tripped
  sshd's MaxStartups and left every thumbnail spinning).
* **Set colors** opens the editor (`?colors=<path>` in the URL); a photo that
  has a sidecar shows a swatch icon instead. Save uploads the sidecar through
  the ordinary asset upload; Remove colors deletes it.
* Settings → **Colors** (right under Palette) holds the frame's `colors`
  block on the backend, the on-device panel and the cloud (either profile on
  2026.10.2 or newer): the "Auto color correction" select, and "Fine tuning"
  (the global sliders, previewed on the frame's current image) behind a
  toggle, folded by default.
