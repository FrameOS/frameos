import pixie, pixie/paths, std/[unicode, monotimes, times]
let typeface = readTypeface("tests/fonts/Roboto-Regular_1.ttf")
let image = newImage565(200, 200)
const text = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
let ink = rgba(0, 0, 0, 255)
template timeIt(label: string, n: int, body: untyped) =
  let t0 = getMonoTime()
  for k in 0 ..< n:
    body
  echo label, ": ", (getMonoTime() - t0).inNanoseconds div (n * text.len), " ns/glyph"

var outlines: seq[Path]
var glyphs: seq[Path]
for c in text:
  glyphs.add typeface.glyphPath(Rune(c), 16)
  outlines.add glyphs[^1].glyphOutline()

glyphCacheBudget = 0
timeIt("outline parse", 200):
  for g in glyphs: discard g.glyphOutline()
timeIt("glyphPath make", 200):
  for c in text: discard typeface.glyphPath(Rune(c), 16)
timeIt("direct fill of kept outline", 200):
  for o in outlines: image.fillPath(o, ink, translate(vec2(50.25, 80.5)))
timeIt("fill via outline made each time (budget 0)", 200):
  for g in glyphs: image.fillPath(g, ink, translate(vec2(50.25, 80.5)))
glyphCacheBudget = 1024 * 1024
timeIt("glyph cache miss", 200):
  clearGlyphCache()
  for g in glyphs: image.fillPath(g, ink, translate(vec2(50.25, 80.5)))
timeIt("glyph cache hit", 2000):
  for g in glyphs: image.fillPath(g, ink, translate(vec2(50.25, 80.5)))
coverageCacheBudget = 1024 * 1024
for o in outlines: o.share()
for o in outlines: image.fillPath(o, ink, translate(vec2(50.25, 80.5)))
for o in outlines: image.fillPath(o, ink, translate(vec2(50.25, 80.5)))
timeIt("coverage cache hit (shared outline)", 2000):
  for o in outlines: image.fillPath(o, ink, translate(vec2(50.25, 80.5)))
