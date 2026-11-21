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

proc fontNameOk(font: string): bool =
  font.len > 0 and "/" notin font and ".." notin font and "~" notin font

const FileFacesMax = 128
  ## How many faces read in place (pixie/fontformats/filefont.nim) are kept
  ## open, by name: each is its tables' places and its path, a few hundred
  ## bytes; the one used longest ago goes first.

var fileFaces: seq[(string, Typeface)]
  ## By name, the one used last at the end. A list, not a table: there are
  ## few, and a table's code is a kilobyte of an ESP32's flash.
var refusedFonts: seq[string] ## the names refuseFont has spoken of

proc refuseFont(font: string, reason: string, extra: JsonNode = nil) =
  ## Say why exactly once per font name: a scene that names a missing font
  ## renders every interval, and one line per render is a log that cannot be
  ## read.
  withLock typefaceLock:
    if font in refusedFonts:
      return
    if refusedFonts.len >= 64:
      refusedFonts.delete(0)
    refusedFonts.add font
  var payload = %*{"event": "font:fallback", "font": font, "reason": reason}
  if extra != nil:
    for key, value in extra.pairs:
      payload[key] = value
  try:
    log(payload) # the SVG hook that gets here raises nothing (an ESP32's log may)
  except Exception:
    discard

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
    for i in 0 ..< fileFaces.len:
      if fileFaces[i][0] == font:
        let kept = fileFaces[i][1]
        fileFaces.delete(i)
        if kept.isStale:
          break # its file changed: open it again
        fileFaces.add (font, kept) # used now: the last to go
        return kept
  let fontPath = assetsPath & "/fonts/" & font
  if not fileExists(fontPath):
    refuseFont(font, "not on this frame")
    return nil
  try:
    let face = openTypefaceFile(fontPath)
    withLock typefaceLock:
      if fileFaces.len >= FileFacesMax:
        fileFaces.delete(0)
      fileFaces.add (font, face)
      let refused = refusedFonts.find(font)
      if refused >= 0:
        refusedFonts.delete(refused)
    return face
  except CatchableError as error:
    refuseFont(font, "could not be read in place", %*{"error": error.msg})
    return nil

var
  emojiFace: Typeface
  emojiAssets: string
  emojiLookedAt: MonoTime

proc getEmojiFallbackTypeface(assetsPath: string): Typeface =
  ## The colour emoji face a text falls back to for the runes its own face
  ## lacks, when the frame's fonts folder has it: on every host it is read
  ## where it lies like a face on an ESP32's card (a CBDT font: each emoji's
  ## PNG read and decoded when it is drawn, kept at its drawn size in pixie's
  ## colour glyph cache; docs/esp32-fonts.md "Emoji"), so a Pi no longer holds
  ## the 10.7 MB font parsed whole, and the Text app, JSX and SVG text draw
  ## the same emoji on a Pi, an ESP32 and in the browser preview. Whether the
  ## folder has it is asked at most every 30 s, not at every text. Read on the
  ## render thread only.
  if assetsPath.len == 0:
    return nil
  let now = getMonoTime()
  if emojiAssets != assetsPath or (now - emojiLookedAt).inSeconds >= 30 or
      (emojiFace != nil and emojiFace.isStale):
    emojiAssets = assetsPath
    emojiLookedAt = now
    emojiFace =
      if fileExists(assetsPath & "/fonts/" & emojiFallbackFont): fileTypeface(emojiFallbackFont, assetsPath)
      else: nil
  emojiFace

proc withEmojiFallback(typeface: Typeface, assetsPath: string): Typeface =
  result = typeface
  let fallback = getEmojiFallbackTypeface(assetsPath)
  if fallback == nil or fallback == typeface or typeface.hasFallbackTypeface(fallback):
    return

  withLock typefaceLock:
    if not typeface.hasFallbackTypeface(fallback):
      typeface.fallbacks.add(fallback)

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
    let face = embeddedTypeface(font, assetsPath)
    return if withEmoji: face.withEmojiFallback(assetsPath) else: face
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

proc svgFace(family: string, weight: int, italic: bool): Typeface =
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

proc svgTypeface(family: string, weight: int, italic: bool): Typeface {.gcsafe.} =
  ## The hook pixie calls per font-family candidate. nil declines, so the next
  ## candidate — and finally the empty family, i.e. the default face — answers.
  ## A face falls back to the emoji face where the frame has one: SVG and JSX
  ## text draw emoji as pictures (pixie's colorGlyphImage), as the Text app does.
  {.cast(gcsafe).}:
    try:
      result = svgFace(family, weight, italic)
      if result != nil:
        result = result.withEmojiFallback(svgFontAssetsPath)
    except CatchableError:
      # A corrupt TTF, a vanished assets directory: the drawing still renders.
      return nil

setSvgTypefaceResolver(svgTypeface)
