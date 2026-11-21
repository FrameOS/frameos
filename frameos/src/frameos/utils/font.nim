import os
import pixie
import pixie/fileformats/svg as pixie_svg
import locks
import algorithm
import std/monotimes
import std/times
import tables
import strutils
import assets/fonts as fontAssets
import frameos/channels
import frameos/utils/paths
import json
const defaultFont = "Ubuntu-Regular.ttf" # its name; compiled in as an indexed font
const emojiFallbackFont = "NotoColorEmoji.ttf"
var typefaces: Table[string, Typeface] = initTable[string, Typeface]()

var typefaceLock: Lock

proc getDefaultTypeface*(): Typeface =
  ## The built-in face, read where it lies: `assets/fonts.nim` holds it as an
  ## indexed font (tools/generate_indexed_font.py) in the program's read-only
  ## data, and pixie reads its tables in place and inflates a glyph's block
  ## when the glyph cache does not have it (docs/esp32-memory.md). It used to
  ## be inflated whole and parsed: 162 KB held for good, 424 KB at the first
  ## text.
  if not typefaces.hasKey(defaultFont):
    withLock typefaceLock:
      if not typefaces.hasKey(defaultFont):
        typefaces[defaultFont] = parseIndexedTypeface(fontAssets.defaultFontData())
  return typefaces[defaultFont]

proc hasFallbackTypeface(typeface, fallback: Typeface): bool =
  for existing in typeface.fallbacks:
    if existing == fallback:
      return true
  false

proc getEmojiFallbackTypeface(assetsPath: string): Typeface =
  when defined(frameosEmbedded):
    return nil
  else:
    if assetsPath.len == 0:
      return nil

    let fontPath = assetsPath / "fonts" / emojiFallbackFont
    if not fileExists(fontPath):
      return nil

    let cacheKey = "emoji:" & normalizedPath(fontPath)
    if not typefaces.hasKey(cacheKey):
      withLock typefaceLock:
        if not typefaces.hasKey(cacheKey):
          typefaces[cacheKey] = parseTtf(readFile(fontPath))
    return typefaces[cacheKey]

proc withEmojiFallback(typeface: Typeface, assetsPath: string): Typeface =
  result = typeface
  when not defined(frameosEmbedded):
    let fallback = getEmojiFallbackTypeface(assetsPath)
    if fallback == nil or typeface.hasFallbackTypeface(fallback):
      return

    withLock typefaceLock:
      if not typeface.hasFallbackTypeface(fallback):
        typeface.fallbacks.add(fallback)

proc fontNameOk(font: string): bool =
  font.len > 0 and "/" notin font and ".." notin font and "~" notin font

const FileFacesMax = 128
  ## How many faces read in place (pixie/fontformats/filefont.nim) are kept
  ## open, by name: each is its tables' places and its path, a few hundred
  ## bytes; the one used longest ago goes first.

var fileFaces: OrderedTable[string, Typeface]
var refusedFonts: Table[string, bool] = initTable[string, bool]()

proc refuseFont(font: string, reason: string, extra: JsonNode = nil) =
  ## Say why exactly once per font name: a scene that names a missing font
  ## renders every interval, and one line per render is a log that cannot be
  ## read.
  if refusedFonts.hasKey(font):
    return
  refusedFonts[font] = true
  var payload = %*{"event": "font:fallback", "font": font, "reason": reason}
  if extra != nil:
    for key, value in extra.pairs:
      payload[key] = value
  log(payload)

proc fileTypeface*(font: string, assetsPath: string): Typeface =
  ## The font file `font` in the frame's fonts folder, read where it lies
  ## (docs/esp32-fonts.md): its table directory now, a page at a time after
  ## that through the render thread's page cache, so any number of faces cost
  ## next to nothing until they draw. nil when there is no such font or it is
  ## not a TrueType file pixie reads in place (a CFF .otf, an emoji bitmap
  ## font: frameos/tools/font_for_card.py converts the first).
  if assetsPath.len == 0 or not fontNameOk(font):
    return nil
  withLock typefaceLock:
    let kept = fileFaces.getOrDefault(font)
    if kept != nil and not kept.isStale:
      # Used now: to the end of the order, the last to go.
      fileFaces.del(font)
      fileFaces[font] = kept
      return kept
  let fontPath = assetsPath & "/fonts/" & font
  if not fileExists(fontPath):
    refuseFont(font, "not on this frame")
    return nil
  try:
    let face = openTypefaceFile(fontPath)
    withLock typefaceLock:
      fileFaces.del(font)
      while fileFaces.len >= FileFacesMax:
        for oldest in fileFaces.keys:
          fileFaces.del(oldest)
          break
      fileFaces[font] = face
    refusedFonts.del(font)
    return face
  except CatchableError as error:
    refuseFont(font, "could not be read in place", %*{"error": error.msg})
    return nil

when defined(frameosEmbedded):
  ## Fonts on an ESP32 come off the SD card ("Sync fonts" puts FrameOS's
  ## collection there; any TrueType file a user adds counts), and every one
  ## of them is read where it lies (fileTypeface): a face open costs a few
  ## hundred bytes and drawing with it the render thread's page cache, so a
  ## scene may use as many as it likes. They used to be parsed whole, one at
  ## a time, a file of at most 1 MB with 3 MB of headroom: "never inflate a
  ## face whole into RAM on a device" holds for the card's fonts too.
  proc embeddedTypeface(font: string, assetsPath: string): Typeface =
    result = fileTypeface(font, assetsPath)
    if result.isNil:
      result = getDefaultTypeface()

proc getTypeface*(font: string, assetsPath: string,
    withEmoji = true): Typeface =
  ## `withEmoji = false` skips attaching the color-emoji fallback. Callers that
  ## cannot draw color glyphs anyway — SVG `<text>` turns into outlines, and a
  ## bitmap glyph has none — should say so rather than pay for parsing a
  ## multi-megabyte emoji font they will never use.
  if font.len == 0 or font == defaultFont:
    return if withEmoji:
      getDefaultTypeface().withEmojiFallback(assetsPath)
    else:
      getDefaultTypeface()
  when defined(frameosEmbedded):
    return embeddedTypeface(font, assetsPath)
  else:
    # sanitize input, expect only a legit file name (can't go .. or /etc/passwd)
    if "/" in font or ".." in font or "~" in font:
      raise newException(ValueError, "Invalid font name")

    # Missing custom fonts use the default face. Do this before taking the
    # typeface lock because getDefaultTypeface uses the same lock.
    let fontPath = assetsPath & "/fonts/" & font
    if not fileExists(fontPath):
      return if withEmoji:
        getDefaultTypeface().withEmojiFallback(assetsPath)
      else:
        getDefaultTypeface()

    if not typefaces.hasKey(font):
      withLock typefaceLock:
        if not typefaces.hasKey(font):
          typefaces[font] = parseTtf(readFile(fontPath))
    return if withEmoji:
      typefaces[font].withEmojiFallback(assetsPath)
    else:
      typefaces[font]

proc newFont*(typeface: Typeface, size: float, color: Color): Font =
  result = newFont(typeface)
  result.size = size
  result.paint.color = color

proc cloneFontWithColor*(f: Font, color: Color): Font =
  result = f.copy()
  result.paint.color = color

proc getAvailableFonts*(assetsPath: string): seq[string] =
  var fonts = @[""]
  if not dirExists(assetsPath & "/fonts"):
    return fonts
  for kind, path in walkDir(assetsPath & "/fonts"):
    # `._Font.ttf` AppleDouble sidecars end in .ttf but are metadata blobs
    # that blow up parseTtf; they must never be offered as a font.
    if path.endsWith(".ttf") and kind == pcFile and not isHiddenOrJunkFile(extractFilename(path)):
      fonts.add(path[assetsPath.len + 7..^1])
  fonts.sort()
  return fonts

# --- SVG <text> font bridge -------------------------------------------------
#
# pixie's SVG parser turns `<text>` into glyph outlines, but it ships no fonts
# and knows nothing about where a frame keeps its own. It asks through a hook,
# one font-family candidate at a time, and this is FrameOS's answer to it.
#
# Two rules shape the answer. It never fails: an SVG naming a font the frame has
# never heard of renders in the default face rather than losing the drawing —
# text in the wrong face still says what it says. And it never loads much: on
# an ESP32 every face is read where it lies on the card (fileTypeface), and on
# a Pi the faces an SVG may parse whole are capped, the rest read in place.
# The JSX layer's `font-[Name]` asks the same hook (ui/layout.nim).

const svgTypefaceBudget = 8
  ## How many fonts SVG text may parse whole on a Pi. Past it, further
  ## families are read in place (fileTypeface): a scene that names a dozen
  ## fonts (the Fonts sample names every one) must not be the thing that runs
  ## a frame out of heap.
  ##
  ## Counted per font SVG itself caused to be parsed, not per entry in the
  ## shared cache: a face a text app already loaded is free to reuse, and one
  ## app's font list must not decide whether another's text renders.

const svgFontListingSeconds = 30
  ## How long the fonts folder's listing (and the family choices made from
  ## it) is kept: a font synced onto the frame is found within this, and a
  ## scene naming forty families does not list the folder forty times (on an
  ## ESP32 a listing of the card's 61 fonts is a directory read, not free).

const genericFontFamilies = [
  "sansserif", "serif", "monospace", "cursive", "fantasy", "systemui",
  "uisansserif", "uiserif", "uimonospace", "uirounded", "applesystem",
  "blinkmacsystemfont", "inherit", "initial", "unset", "auto", "emoji", "math",
  "fangsong"
]

var svgFontAssetsPath = "/srv/assets"
  ## Where to look for fonts. The embedded and wasm runtimes never read from
  ## disk, and the Pi's config sets this at load time.
var svgFontChoices: Table[string, string] = initTable[string, string]()
  ## family|weight|italic -> font file name, "" meaning the default face. The
  ## alternative is walking the fonts directory once per text run.
var svgFontsParsed = 0
  ## How many fonts SVG text has caused to be parsed, against svgTypefaceBudget.
var svgFontListing: seq[string]
var svgFontListedAt: MonoTime

proc setSvgFontAssetsPath*(assetsPath: string) =
  ## Points SVG font resolution at this frame's assets. Called once at config
  ## load; the cached family->file decisions are dropped, since they were made
  ## against a different directory.
  withLock typefaceLock:
    if svgFontAssetsPath != assetsPath:
      svgFontAssetsPath = assetsPath
      svgFontChoices.clear()
      svgFontListing = @[]

proc normalizedFontKey(name: string): string =
  ## CSS family names and font file names spell the same font differently:
  ## "Comic Sans MS" vs "ComicSansMS-Regular.ttf". Compare them with everything
  ## but the letters and digits removed.
  for c in name:
    if c in {'a' .. 'z', '0' .. '9'}:
      result.add c
    elif c in {'A' .. 'Z'}:
      result.add chr(ord(c) + 32)

proc svgFontVariants(weight: int, italic: bool): seq[string] =
  ## Suffixes to try after the family name, best match first.
  if weight >= 600 and italic:
    result.add ["bolditalic", "boldoblique"]
  if weight >= 600:
    result.add ["bold", "semibold"]
  if italic:
    result.add ["italic", "oblique"]
  if weight <= 300:
    result.add ["light", "thin"]
  result.add ["", "regular", "book", "medium"]

proc svgFontFileFor*(family: string, weight = 400, italic = false): string =
  ## The font file an SVG `font-family` resolves to, or "" for the default face.
  # FrameOS names fonts by file elsewhere, and scenes copy that into SVG, so
  # `font-family="Ubuntu-Regular.ttf"` has to mean the same as `"Ubuntu"`.
  var name = family
  for ext in [".ttf", ".otf", ".ttc"]:
    if name.toLowerAscii().endsWith(ext):
      name.setLen(name.len - ext.len)
      break

  let key = normalizedFontKey(name)
  if key.len == 0 or key in genericFontFamilies:
    return ""

  let now = getMonoTime()
  if svgFontListing.len == 0 or (now - svgFontListedAt).inSeconds >= svgFontListingSeconds:
    let listing = getAvailableFonts(svgFontAssetsPath)
    withLock typefaceLock:
      svgFontListing = listing
      svgFontListedAt = now
      svgFontChoices.clear()

  let cacheKey = key & "|" & $weight & "|" & $italic
  if svgFontChoices.hasKey(cacheKey):
    return svgFontChoices[cacheKey]

  let variants = svgFontVariants(weight, italic)
  var
    best = ""
    bestRank = variants.len
  for file in svgFontListing:
    if file.len == 0:
      continue
    let base = normalizedFontKey(file.changeFileExt(""))
    for rank, variant in variants:
      if rank < bestRank and base == key & variant:
        best = file
        bestRank = rank

  withLock typefaceLock:
    svgFontChoices[cacheKey] = best
  best

proc svgTypeface(family: string, weight: int, italic: bool): Typeface {.gcsafe.} =
  ## The hook pixie calls per font-family candidate. nil declines, so the next
  ## candidate — and finally the empty family, i.e. the default face — answers.
  {.cast(gcsafe).}:
    try:
      if family.len == 0:
        return getDefaultTypeface()
      let file = svgFontFileFor(family, weight, italic)
      if file.len == 0:
        return nil
      when defined(frameosEmbedded):
        # Read where it lies on the card, as every face there is.
        return fileTypeface(file, svgFontAssetsPath)
      else:
        let alreadyParsed = typefaces.hasKey(file)
        if not alreadyParsed and svgFontsParsed >= svgTypefaceBudget:
          return fileTypeface(file, svgFontAssetsPath)
        result = getTypeface(file, svgFontAssetsPath, withEmoji = false)
        if not alreadyParsed:
          withLock typefaceLock:
            inc svgFontsParsed
    except CatchableError:
      # A corrupt TTF, a vanished assets directory: the drawing still renders.
      return nil

setSvgTypefaceResolver(svgTypeface)
