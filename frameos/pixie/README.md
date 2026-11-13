<img src="docs/banner.png">

# This is the FrameOS fork of Pixie

Upstream lives at [treeform/pixie](https://github.com/treeform/pixie); its
README follows below and still describes the library accurately. This fork adds
what [FrameOS](https://github.com/FrameOS/frameos) needs to draw pictures on
hardware that does not have room for them.

A FrameOS scene renders on a Raspberry Pi Zero with 512MB of RAM, or on an
ESP32-S3 with 8MB of PSRAM and about 100KB of internal heap. Upstream pixie
decodes an image by allocating the finished image plus every intermediate the
codec wants, which is the right trade on a desktop and the difference between
rendering and rebooting on a frame. Everything below follows from that, plus a
few features FrameOS wanted along the way.

Nothing here removes or renames upstream API: this is a superset, and it tracks
upstream. `-d:frameosEmbedded` only changes defaults (a conservative decode
budget), never behaviour you did not ask for.

## What this fork adds

**A memory budget decoders actually respect** (`pixie/decodebudget.nim`).
`setDecodeBudgetBytes` sets a per-decode ceiling covering intermediates *and*
output; decoders plan their allocations before making them and raise a catchable
`PixieError` when the plan does not fit, instead of taking the process down with
them. `0` means unlimited, which is the default on hosts. An application that
knows its live free memory can refresh the budget before every decode.

**Decoding straight into the size you want.** `decodeImageScaled`,
`decodeImageScaledInto` and `readImageScaled` take a target size and a fit mode
(`fitStretch`, `fitCover`, `fitContain`, see `scaledFitRects`), and the
downscale happens *during* decoding: a 4000×3000 JPEG headed for a 800×480 panel
never exists at full size. Sampling is box-filtered rather than nearest, in the
row-streamed decoders too (`RowBoxSampler`), and JPEG chroma is interpolated
rather than point-picked, so a heavy downscale does not come out crawling with
aliasing.

**Streaming decoders that never hold the file.** Every scaled decoder has a
pull-source form — `decodePngStreamScaledInto`, `decodeJpegStreamScaledInto`,
`decodeBmpStreamScaledInto`, `decodePpmStreamScaledInto`,
`decodeWebpStreamScaledInto` — driven by an `ImageSourceProc` callback that
hands over the next chunk of input. Feed one from a file and neither the
compressed bytes nor the full-size pixels are ever resident.

**A self-contained streaming inflate** (`pixie/inflatestream.nim`, vendored from
zippy 0.10.16). PNG scanlines leave a fixed ~64KB window as they are produced,
are unfiltered in place, and multi-`IDAT` streams are inflated as segments
rather than concatenated first. The fork depends on stock zippy again as a
result.

**A 16-bit canvas.** `newImage565(w, h)` (and `newImage565Over` for a
buffer the caller owns) makes an `Image` whose pixels are packed RGB 5/6/5 —
half the memory of RGBA, no alpha. It is a *presentation surface*: the final
canvas that opaque geometry, text and decoded pictures are composited onto and
that a display driver then reads. Every drawing operation works on one —
fills, antialiased paths and text, `draw` with any blend mode, gradients,
opacity, views, copies, the scaled and streamed decoders writing straight
into it — and the result is what you would get by drawing onto RGBA and then
quantising: bit-for-bit for a single layer over a representable backdrop, one
5-bit step at most for layers over layers (`tests/test_rgb565.nim` is that
oracle). What a 565 image refuses is being used *as an alpha mask*:
`shadow`/`spread` raise, and the mask blend modes blacken rather than clear.
`Image.format` says which kind you hold; RGBA images are untouched and
remain the default everywhere — this exists for a 1200×1600 panel on a
microcontroller with 8 MB of PSRAM, where a 7.3 MB RGBA canvas does not fit
and a 3.7 MB one does.

**Images that can borrow pixels.** `view(image, x, y, w, h)` is a window onto
another image's memory rather than a copy, with `newImageFrom`,
`toContiguousSeq`, the `forEachSpan` template and `items`/`pairs` iterators as
the seams that keep flat operations fast for owners and correct for views.
`pixelsEqual` compares contents. `Image` is `{.acyclic.}` — load-bearing, not an
optimisation: without it ORC treats every image as a cycle candidate, which
crashes a host that shares images with a dynamically loaded driver.

**SVG that draws text, and draws into your buffer.** `<text>` and `<tspan>`
become glyph outlines and then ordinary paths, so fill, stroke, gradients,
opacity and transforms apply to them exactly as to a `<path>`; font-family
resolution is the application's to answer through `setSvgTypefaceResolver`,
since pixie ships no fonts. `parseSvgXml` parses markup the way `<text>` needs
it. `Svg.renderInto(target)` rasterizes into an image the caller already owns,
which for a caller that has a correctly sized canvas is the difference between
one image and two.

**Color emoji.** COLR/CPAL layered glyphs and CBDT/CBLC and sbix bitmap glyphs
render through `fillText`, with `hasColorGlyph` to ask and `Typeface.fallbacks`
to supply an emoji face behind a text face.

**Text as paths.** `Arrangement.computePath` returns a whole arrangement's
outlines as one path and `Font.baselineOffset` gives the distance from the top
of a typeset block to its first baseline — the two pieces anything that
positions text by its baseline needs.

**Fixes carried here.** EXIF orientation was silently dropped for little-endian
(`II`) JPEGs, which is what most Sony and Canon bodies write, so those photos
decoded sideways. JPEG streaming resync tolerates a window slide.

👏 👏 👏 Check out video about the library: [A full-featured 2D graphics library for Nim (NimConf 2021)](https://www.youtube.com/watch?v=8acDfUIwLnk) 👏 👏 👏

# Pixie - A full-featured 2D graphics library for Nim.

Pixie is a 2D graphics library similar to [Cairo](https://www.cairographics.org/) and [Skia](https://skia.org) written entirely in Nim.

This library is being actively developed and we'd be happy for you to use it.

`nimby install pixie`

![Github Actions](https://github.com/treeform/pixie/workflows/Github%20Actions/badge.svg)
![GitHub release (latest by date)](https://img.shields.io/github/v/release/treeform/pixie)
![GitHub Repo stars](https://img.shields.io/github/stars/treeform/pixie)
![GitHub](https://img.shields.io/github/license/treeform/pixie)
![GitHub issues](https://img.shields.io/github/issues/treeform/pixie)

[API reference](https://treeform.github.io/pixie)

[Pixie Book](https://github.com/treeform/pixiebook)

## About

Pixie includes CPU rasterization, image codecs, text layout, paths, paints, masking, blending, and SIMD-accelerated operations.

### Videos

* [Pixie 5.0 performance improvements](https://www.youtube.com/watch?v=Did21OYIrGI)
* [The details of JPEG decoding in Nim](https://www.youtube.com/watch?v=vYwD7OynFcg&t=4s)
* [A full-featured 2D graphics library for Nim (NimConf 2021)](https://www.youtube.com/watch?v=8acDfUIwLnk)

Features:
* Typesetting and rasterizing text, including styled rich text via spans.
* Drawing paths, shapes and curves with even-odd and non-zero windings.
* Pixel-perfect AA quality.
* Supported file formats are PNG, BMP, JPG, SVG + more in development.
* Strokes with joins and caps.
* Shadows, glows and blurs.
* Complex masking: Subtract, Intersect, Exclude.
* Complex blends: Darken, Multiply, Color Dodge, Hue, Luminosity... etc.
* Many operations are SIMD accelerated.

### Image file formats

Format        | Read          | Write         |
------------- | ------------- | ------------- |
PNG           | ✅           | ✅            |
JPEG          | ✅           |               |
BMP           | ✅           | ✅            |
QOI           | ✅           | ✅            |
GIF           | ✅           |               |
SVG           | ✅           |               |
PPM           | ✅           | ✅            |

### Font file formats

Format        | Read
------------- | -------------
TTF           | ✅
OTF           | ✅
SVG           | ✅

### Joins and caps

Supported Caps:
  * Butt
  * Round
  * Square

Supported Joins:
  * Miter (with miter angle limit)
  * Bevel
  * Round

### Blending & masking

Supported Blend Modes:
  * Normal
  * Darken
  * Multiply
  * ColorBurn
  * Lighten
  * Screen
  * Color Dodge
  * Overlay
  * Soft Light
  * Hard Light
  * Difference
  * Exclusion
  * Hue
  * Saturation
  * Color
  * Luminosity

Supported Mask Modes:
  * Mask
  * Overwrite
  * Subtract Mask
  * Intersect Mask
  * Exclude Mask

### SVG style paths:

Format        | Supported     | Description           |
------------- | ------------- | --------------------- |
M m           | ✅            | move to               |
L l           | ✅            | line to               |
H h           | ✅            | horizontal line to    |
V v           | ✅            | vertical line to      |
C c S s       | ✅            | cubic curve to        |
Q q T t       | ✅            | quadratic curve to    |
A a           | ✅            | arc to                |
z             | ✅            | close path            |

### Pixie + GPU

To learn how to use Pixie for realtime graphics with GPU, check out [Boxy](https://github.com/treeform/boxy).

## Testing

`nim r tests/tests.nim`

## Examples

`git clone https://github.com/treeform/pixie` to run examples.

### Text
nim c -r [examples/text.nim](examples/text.nim)
```nim
var font = readFont("examples/data/Roboto-Regular_1.ttf")
font.size = 20

let text = "Typesetting is the arrangement and composition of text in graphic design and publishing in both digital and traditional medias."

image.fillText(font.typeset(text, vec2(180, 180)), translate(vec2(10, 10)))
```
![example output](examples/text.png)

### Text spans
nim c -r [examples/text_spans.nim](examples/text_spans.nim)
```nim
let typeface = readTypeface("examples/data/Ubuntu-Regular_1.ttf")

proc newFont(typeface: Typeface, size: float32, color: Color): Font =
  result = newFont(typeface)
  result.size = size
  result.paint.color = color

let spans = @[
  newSpan("verb [with object] ",
    newFont(typeface, 12, color(0.78125, 0.78125, 0.78125, 1))),
  newSpan("strallow\n", newFont(typeface, 36, color(0, 0, 0, 1))),
  newSpan("\nstral·low\n", newFont(typeface, 13, color(0, 0.5, 0.953125, 1))),
  newSpan("\n1. free (something) from restrictive restrictions \"the regulations are intended to strallow changes in public policy\" ",
      newFont(typeface, 14, color(0.3125, 0.3125, 0.3125, 1)))
]

image.fillText(typeset(spans, vec2(180, 180)), translate(vec2(10, 10)))
```
![example output](examples/text_spans.png)

### Square
nim c -r [examples/square.nim](examples/square.nim)
```nim
let ctx = newContext(image)
ctx.fillStyle = rgba(255, 0, 0, 255)

let
  pos = vec2(50, 50)
  wh = vec2(100, 100)

ctx.fillRect(rect(pos, wh))
```
![example output](examples/square.png)

### Line
nim c -r [examples/line.nim](examples/line.nim)
```nim
let ctx = newContext(image)
ctx.strokeStyle = "#FF5C00"
ctx.lineWidth = 10

let
  start = vec2(25, 25)
  stop = vec2(175, 175)

ctx.strokeSegment(segment(start, stop))
```
![example output](examples/line.png)

### Rounded rectangle
nim c -r [examples/rounded_rectangle.nim](examples/rounded_rectangle.nim)
```nim
let ctx = newContext(image)
ctx.fillStyle = rgba(0, 255, 0, 255)

let
  pos = vec2(50, 50)
  wh = vec2(100, 100)
  r = 25.0

ctx.fillRoundedRect(rect(pos, wh), r)
```
![example output](examples/rounded_rectangle.png)

### Heart
nim c -r [examples/heart.nim](examples/heart.nim)
```nim
image.fillPath(
  """
    M 20 60
    A 40 40 90 0 1 100 60
    A 40 40 90 0 1 180 60
    Q 180 120 100 180
    Q 20 120 20 60
    z
  """,
  parseHtmlColor("#FC427B").rgba
)
```
![example output](examples/heart.png)

### Masking
nim c -r [examples/masking.nim](examples/masking.nim)
```nim
let ctx = newContext(lines)
ctx.strokeStyle = "#F8D1DD"
ctx.lineWidth = 30

ctx.strokeSegment(segment(vec2(25, 25), vec2(175, 175)))
ctx.strokeSegment(segment(vec2(25, 175), vec2(175, 25)))

mask.fillPath(
  """
    M 20 60
    A 40 40 90 0 1 100 60
    A 40 40 90 0 1 180 60
    Q 180 120 100 180
    Q 20 120 20 60
    z
  """,
  color(1, 1, 1, 1)
)
lines.draw(mask, blendMode = MaskBlend)
image.draw(lines)
```
![example output](examples/masking.png)

### Gradient
nim c -r [examples/gradient.nim](examples/gradient.nim)
```nim
let paint = newPaint(RadialGradientPaint)
paint.gradientHandlePositions = @[
  vec2(100, 100),
  vec2(200, 100),
  vec2(100, 200)
]
paint.gradientStops = @[
  ColorStop(color: color(1, 0, 0, 1), position: 0),
  ColorStop(color: color(1, 0, 0, 0.15625), position: 1.0),
]

image.fillPath(
  """
    M 20 60
    A 40 40 90 0 1 100 60
    A 40 40 90 0 1 180 60
    Q 180 120 100 180
    Q 20 120 20 60
    z
  """,
  paint
)
```
![example output](examples/gradient.png)

### Image tiled
nim c -r [examples/image_tiled.nim](examples/image_tiled.nim)
```nim
let path = newPath()
path.polygon(
  vec2(100, 100),
  70,
  sides = 8
)

let paint = newPaint(TiledImagePaint)
paint.image = readImage("examples/data/mandrill.png")
paint.imageMat = scale(vec2(0.08, 0.08))

image.fillPath(path, paint)
```
![example output](examples/image_tiled.png)

### Shadow
nim c -r [examples/shadow.nim](examples/shadow.nim)
```nim
let path = newPath()
path.polygon(vec2(100, 100), 70, sides = 8)

let polygonImage = newImage(200, 200)
polygonImage.fillPath(path, rgba(255, 255, 255, 255))

let shadow = polygonImage.shadow(
  offset = vec2(2, 2),
  spread = 2,
  blur = 10,
  color = rgba(0, 0, 0, 200)
)

image.draw(shadow)
image.draw(polygonImage)
```
![example output](examples/shadow.png)

### Blur
nim c -r [examples/blur.nim](examples/blur.nim)
```nim
let path = newPath()
path.polygon(vec2(100, 100), 70, sides = 6)

let mask = newImage(200, 200)
mask.fillPath(path, color(1, 1, 1, 1))

blur.blur(20)
blur.draw(mask, blendMode = MaskBlend)

image.draw(trees)
image.draw(blur)
```
![example output](examples/blur.png)

### Tiger
nim c -r [examples/tiger.nim](examples/tiger.nim)
```nim
let tiger = readImage("examples/data/tiger.svg")

image.draw(
  tiger,
  translate(vec2(100, 100)) *
  scale(vec2(0.2, 0.2)) *
  translate(vec2(-450, -450))
)
```
![example output](examples/tiger.png)
