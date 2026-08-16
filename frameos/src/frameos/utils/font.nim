import os
import pixie
import pixie/fileformats/svg as pixie_svg
import locks
import algorithm
import tables
import strutils
import assets/fonts as fontAssets
import frameos/channels
import frameos/utils/memory
import frameos/utils/paths
import json
when defined(frameosEmbedded) or defined(frameosWasm):
  import zippy

const defaultFont = "Ubuntu-Regular.ttf" # compiled into the binary by nimassets
const emojiFallbackFont = "NotoColorEmoji.ttf"
var typefaces: Table[string, Typeface] = initTable[string, Typeface]()

var typefaceLock: Lock

proc readEmbeddedFont(path: string): string =
  when defined(frameosEmbedded) or defined(frameosWasm):
    # zippy's gzip path verifies the trailer with `dst.len mod (1 shl 32)`,
    # and `1 shl 32` overflows a 32-bit int (Xtensa, wasm32) to 0 -> divide-by-zero.
    # The compiled assets use a plain 10-byte gzip header (flags=0), so strip
    # the header + 8-byte trailer and raw-inflate, skipping that check.
    let gz = fontAssets.getCompressedAsset(path)
    if gz.len >= 18 and gz[0] == '\x1f' and gz[1] == '\x8b' and gz[3] == '\0':
      return uncompress(gz[10 ..< gz.len - 8], dfDeflate)
    return fontAssets.getAsset(path)
  elif compiles(fontAssets.getAssetToStr(path)):
    fontAssets.getAssetToStr(path)
  else:
    fontAssets.getAsset(path)

proc getDefaultTypeface*(): Typeface =
  if not typefaces.hasKey(defaultFont):
    withLock typefaceLock:
      if not typefaces.hasKey(defaultFont):
        typefaces[defaultFont] = parseTtf(readEmbeddedFont("assets/compiled/fonts/" & defaultFont))
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

when defined(frameosEmbedded):
  ## Custom fonts on an ESP32 come off the SD card, one at a time.
  ##
  ## This used to hand back the built-in face unconditionally, because a scene
  ## authored on a desktop names fonts that were never going to be there and
  ## parsing a TTF is the kind of allocation that ends a render. Now that the
  ## backend can sync a project's fonts onto the card ("Sync fonts", which
  ## refuses on a frame with no card), the file usually IS there, and silently
  ## drawing in the wrong face made the sync a lie.
  ##
  ## Three guards keep it honest without keeping it dangerous:
  ##
  ## * exactly ONE custom face is cached, and asking for a different one drops
  ##   the previous — the same one-typeface rule the SVG bridge already
  ##   follows, for the same reason (internal heap, not PSRAM, is what runs
  ##   out);
  ## * a font file over EmbeddedMaxFontBytes is refused unparsed, because a
  ##   CJK face is tens of megabytes and the failure mode of trying is a reset,
  ##   not an exception;
  ## * the parse is skipped when the device is already short of render
  ##   headroom, and any failure falls back to the built-in face rather than
  ##   losing the drawing. Text in the wrong face still says what it says.
  const EmbeddedMaxFontBytes = 1024 * 1024
  ## Headroom demanded before parsing, over and above the file itself: pixie
  ## builds glyph tables well past the file size, and a render that is already
  ## scraping by must not be the thing that pays for a nicer typeface.
  const EmbeddedFontParseHeadroomBytes = 3 * 1024 * 1024

  var embeddedCustomFontName = ""
  var embeddedCustomTypeface: Typeface = nil
  var embeddedRefusedFonts: Table[string, bool] = initTable[string, bool]()

  proc embeddedRefuse(font: string, reason: string, extra: JsonNode = nil) =
    ## Say why exactly once per font name: a scene that names a missing font
    ## renders every interval, and one line per render is a log that cannot be
    ## read.
    if embeddedRefusedFonts.hasKey(font):
      return
    embeddedRefusedFonts[font] = true
    var payload = %*{"event": "font:embedded:fallback", "font": font,
                     "reason": reason}
    if extra != nil:
      for key, value in extra.pairs:
        payload[key] = value
    log(payload)

  proc embeddedTypeface(font: string, assetsPath: string): Typeface =
    if assetsPath.len == 0 or "/" in font or ".." in font or "~" in font:
      return getDefaultTypeface()
    if font == embeddedCustomFontName and embeddedCustomTypeface != nil:
      return embeddedCustomTypeface

    let fontPath = assetsPath & "/fonts/" & font
    if not fileExists(fontPath):
      embeddedRefuse(font, "not on this frame")
      return getDefaultTypeface()

    var fileBytes = 0
    try:
      fileBytes = int(getFileSize(fontPath))
    except CatchableError:
      fileBytes = 0
    if fileBytes <= 0 or fileBytes > EmbeddedMaxFontBytes:
      embeddedRefuse(font, "font file too large to parse on this device",
                     %*{"bytes": fileBytes, "maxBytes": EmbeddedMaxFontBytes})
      return getDefaultTypeface()

    let headroom = availableRenderHeadroomBytes()
    if headroom > 0 and headroom < fileBytes + EmbeddedFontParseHeadroomBytes:
      # Not remembered: headroom is a moment, not a property of the font, and
      # the next render may well have room.
      log(%*{"event": "font:embedded:fallback", "font": font,
             "reason": "not enough free memory to parse a font right now",
             "headroomBytes": headroom, "bytes": fileBytes})
      return getDefaultTypeface()

    withLock typefaceLock:
      if font == embeddedCustomFontName and embeddedCustomTypeface != nil:
        return embeddedCustomTypeface
      # Drop the previous custom face BEFORE parsing the new one: two parsed
      # typefaces alive at once is the allocation this whole dance avoids.
      embeddedCustomFontName = ""
      embeddedCustomTypeface = nil
      try:
        embeddedCustomTypeface = parseTtf(readFile(fontPath))
        embeddedCustomFontName = font
        embeddedRefusedFonts.del(font)
        log(%*{"event": "font:embedded:loaded", "font": font,
               "bytes": fileBytes})
      except CatchableError as error:
        embeddedCustomTypeface = nil
        embeddedCustomFontName = ""
        embeddedRefuse(font, "could not be parsed", %*{"error": error.msg})
    if embeddedCustomTypeface != nil:
      return embeddedCustomTypeface
    return getDefaultTypeface()

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
# text in the wrong face still says what it says. And it never loads much: the
# ESP32 has room for exactly one parsed typeface, so there it always answers
# with the built-in one, and even on a Pi the number of faces an SVG can pull
# into memory is capped.

const svgTypefaceBudget =
  when defined(frameosEmbedded): 1
  else: 8
  ## How many fonts SVG text may pull into memory. Past it, further families
  ## answer with the default face instead of parsing another font: a scene that
  ## names a dozen fonts must not be the thing that runs a frame out of heap.
  ##
  ## Counted per font SVG itself caused to be parsed, not per entry in the
  ## shared cache: a face a text app already loaded is free to reuse, and one
  ## app's font list must not decide whether another's text renders.

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

proc setSvgFontAssetsPath*(assetsPath: string) =
  ## Points SVG font resolution at this frame's assets. Called once at config
  ## load; the cached family->file decisions are dropped, since they were made
  ## against a different directory.
  withLock typefaceLock:
    if svgFontAssetsPath != assetsPath:
      svgFontAssetsPath = assetsPath
      svgFontChoices.clear()

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

  let cacheKey = key & "|" & $weight & "|" & $italic
  if svgFontChoices.hasKey(cacheKey):
    return svgFontChoices[cacheKey]

  let variants = svgFontVariants(weight, italic)
  var
    best = ""
    bestRank = variants.len
  for file in getAvailableFonts(svgFontAssetsPath):
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
      when defined(frameosEmbedded):
        # One typeface, always. Parsing a second font would come out of the
        # internal heap the renderer needs, and the frame must still render.
        return nil
      else:
        let file = svgFontFileFor(family, weight, italic)
        if file.len == 0:
          return nil
        let alreadyParsed = typefaces.hasKey(file)
        if not alreadyParsed and svgFontsParsed >= svgTypefaceBudget:
          return nil
        result = getTypeface(file, svgFontAssetsPath, withEmoji = false)
        if not alreadyParsed:
          withLock typefaceLock:
            inc svgFontsParsed
    except CatchableError:
      # A corrupt TTF, a vanished assets directory: the drawing still renders.
      return nil

setSvgTypefaceResolver(svgTypeface)
