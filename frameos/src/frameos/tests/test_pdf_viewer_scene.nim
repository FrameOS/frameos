## The PDF viewer sample (repo/scenes/samples/PDF viewer) over a card with
## PDFs written here: a classic one (an xref table, a standard font, vector
## shapes, a JPEG and a raw-pixel picture, bookmarks), a PDF 1.5 one (an
## object stream, an xref stream with a PNG predictor, a Type0 font read
## through its ToUnicode map, a page turned 90 degrees), one whose
## cross-references point nowhere (read by scanning the file) and a file that
## is not a PDF. The library, pages and their parts turned with taps, swipes
## and keys, the bookmarks, the keypad, the place kept across a reload.
## FRAMEOS_PDF_SHOTS=<dir> writes each picture there; FRAMEOS_PDF_FILES=
## <a.pdf>:<b.pdf> opens PDFs of your own and walks their pages.

import std/[json, os, strutils, times, unittest]
import pixie
import zippy
import ../interpreter
import ../js_runtime/app_runtime
import ../scene_rhythm
import ../types

const
  Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"
  Jpeg = currentSourcePath().parentDir() / "fixtures" / "progressive-480x720.jpg"

proc stream(dict, data: string, flate = true): string =
  let body = if flate: compress(data, BestCompression, dfZlib) else: data
  "<< " & dict & " /Length " & $body.len & (if flate: " /Filter /FlateDecode" else: "") &
    " >>\nstream\n" & body & "\nendstream"

proc pdf(objects: openArray[string], trailer: string, brokenXref = false): string =
  ## Objects 1..n, an xref table and the trailer's own entries.
  result = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
  var offsets: seq[int]
  for i, body in objects:
    offsets.add result.len
    result.add $(i + 1) & " 0 obj\n" & body & "\nendobj\n"
  let xref = result.len
  result.add "xref\n0 " & $(objects.len + 1) & "\n0000000000 65535 f \n"
  for off in offsets:
    result.add align($(if brokenXref: off + 37 else: off), 10, '0') & " 00000 n \n"
  result.add "trailer\n<< /Size " & $(objects.len + 1) & " " & trailer & " >>\nstartxref\n" &
    $(if brokenXref: xref + 5 else: xref) & "\n%%EOF\n"

proc utf16(text: string): string =
  ## A text string as UTF-16 with its byte order mark, in hex.
  result = "<FEFF"
  for c in text:
    result.add toHex(ord(c), 4)
  result.add ">"

let assets = getTempDir() / "frameos-pdf-scene-" & $epochTime().int
createDir(assets / "Docs")

# Page 1: a red band, a heading, a blue rule, a JPEG and a 2 x 2 picture in
# raw samples (green, white / white, green) with PNG filters. Pages 2 and 3:
# text alone. Bookmarks for pages 1 and 3, one of them by a named destination.
let page1 = "1 0 0 rg 50 650 500 80 re f\n" &
  "0 g BT /F1 36 Tf 60 600 Td (Hello PDF) Tj ET\n" &
  "0 0 1 RG 4 w 50 550 m 550 550 l S\n" &
  "q 200 0 0 150 60 330 cm /Im1 Do Q\n" &
  "q 150 0 0 150 330 330 cm /Im2 Do Q\n" &
  "BT /F1 14 Tf 60 300 Td 16 TL (A line of text under the pictures,) Tj T* (and another, said with T*.) Tj ET\n"
var lines = ""
for i in 1 .. 30:
  lines.add "BT /F1 12 Tf 60 " & $(740 - i * 20) & " Td (Line " & $i & " of a page of text in Helvetica.) Tj ET\n"
let rgbSamples = "\x00\x00\xff\x00\xff\xff\xff" & "\x00\xff\xff\xff\x00\xff\x00"
writeFile(assets / "Docs" / "report.pdf", pdf([
  "<< /Type /Catalog /Pages 2 0 R /Outlines 10 0 R /Names << /Dests 13 0 R >> >>",
  "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 /MediaBox [0 0 612 792] >>",
  "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 6 0 R >> /XObject << /Im1 8 0 R /Im2 9 0 R >> >> /Contents 7 0 R >>",
  "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 6 0 R >> >> /Contents 14 0 R >>",
  "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 6 0 R >> >> /Contents 15 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  stream("", page1),
  stream("/Type /XObject /Subtype /Image /Width 480 /Height 720 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
    readFile(Jpeg), flate = false),
  stream("/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 " &
    "/DecodeParms << /Predictor 15 /Colors 3 /Columns 2 >>", rgbSamples),
  "<< /Type /Outlines /First 11 0 R /Last 12 0 R /Count 2 >>",
  "<< /Title (The start) /Parent 10 0 R /Next 12 0 R /Dest [3 0 R /XYZ 0 792 0] >>",
  "<< /Title " & utf16("The end") & " /Parent 10 0 R /Prev 11 0 R /Dest (last) >>",
  "<< /Names [(last) [5 0 R /Fit]] >>",
  stream("", lines),
  stream("", "BT /F1 24 Tf 60 700 Td (The third page) Tj ET\n"),
], "/Root 1 0 R /Info << /Title (A Report) /Author (Ada) >>"))

# PDF 1.5: pages, fonts and the catalog inside an object stream, found
# through an xref stream whose rows go through PNG's Up filter. The font is a
# Type0 with two-byte codes and a ToUnicode map; the second page is turned.
proc modernPdf(): string =
  let cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n" &
    "1 begincodespacerange <0000> <FFFF> endcodespacerange\n" &
    "2 beginbfchar <0024> <004D> <0025> <0057> endbfchar\n" &
    "1 beginbfrange <0030> <0039> <0030> endbfrange\n" &
    "endcmap CMapName currentdict /CMap defineresource pop end end"
  let content = "BT /F1 60 Tf 72 600 Td <00240024002500250024> Tj ET\n" &
    "BT /F1 40 Tf 72 400 Td <003100320033> Tj ET\n" &
    "0 0 0 rg 72 300 400 20 re f\n"
  let turned = "0 1 0 rg 100 100 200 200 re f\nBT /F1 30 Tf 100 500 Td <00240025> Tj ET\n"
  # Objects 1-6 in object stream 7; 8, 9 and 10 are streams of their own.
  let inner = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 8 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> /Contents 9 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Sans-Bold /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 10 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Sans-Bold /DW 600 /W [36 [900 950] 48 57 556] >>",
  ]
  var header = ""
  var body = ""
  for i, obj in inner:
    header.add $(i + 1) & " " & $body.len & " "
    body.add obj & "\n"
  result = "%PDF-1.5\n%\xe2\xe3\xcf\xd3\n"
  var offsets = newSeq[int](11)
  offsets[7] = result.len
  result.add "7 0 obj\n" & stream("/Type /ObjStm /N 6 /First " & $header.len, header & body) & "\nendobj\n"
  offsets[8] = result.len
  result.add "8 0 obj\n" & stream("", content) & "\nendobj\n"
  offsets[9] = result.len
  result.add "9 0 obj\n" & stream("", turned) & "\nendobj\n"
  offsets[10] = result.len
  result.add "10 0 obj\n" & stream("", cmap) & "\nendobj\n"
  let xrefAt = result.len
  # Rows of type (1 byte), offset or stream (4), index (2); object 11 is the xref stream.
  var rows: seq[string]
  proc row(kind, a, b: int): string =
    char(kind) & char((a shr 24) and 255) & char((a shr 16) and 255) & char((a shr 8) and 255) &
      char(a and 255) & char((b shr 8) and 255) & char(b and 255)
  rows.add row(0, 0, 65535)
  for i in 1 .. 6: rows.add row(2, 7, i - 1)
  for i in 7 .. 10: rows.add row(1, offsets[i], 0)
  rows.add row(1, xrefAt, 0)
  var filtered = ""
  var prev = "\x00\x00\x00\x00\x00\x00\x00"
  for r in rows:
    filtered.add '\x02'
    for k in 0 ..< 7:
      filtered.add char((ord(r[k]) - ord(prev[k])) and 255)
    prev = r
  result.add "11 0 obj\n" & stream("/Type /XRef /Size 12 /W [1 4 2] /Root 1 0 R " &
    "/Info << /Title " & utf16("Modern") & " >> /DecodeParms << /Predictor 12 /Columns 7 >>", filtered) &
    "\nendobj\nstartxref\n" & $xrefAt & "\n%%EOF\n"

writeFile(assets / "Docs" / "modern.pdf", modernPdf())
writeFile(assets / "Docs" / "scanned-wrong.pdf", pdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << >> /Contents 4 0 R >>",
  stream("", "0 0 1 rg 0 0 400 300 re f\n"),
], "/Root 1 0 R", brokenXref = true))
writeFile(assets / "Docs" / "not-a.pdf", "this is not a PDF at all, just some text")
writeFile(assets / "notes.txt", "not a PDF")

suite "the PDF viewer scene":
  setup:
    rhythmClockOverride = 1000.0
    rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 0

  var problems: seq[string]
  var logger = Logger(frameConfig: nil, enabled: true)
  logger.log = proc(payload: JsonNode) =
    if payload{"event"}.getStr().contains("error") or payload{"level"}.getStr() == "error":
      problems.add($payload)
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false

  proc frame(width, height: int, path = assets, device = "framebuffer"): FrameConfig =
    FrameConfig(name: "pdf", mode: "rpios", device: device, width: width, height: height, rotate: 0,
      scalingMode: "cover", debug: false, settings: %*{}, renderScale: 1.0, saveAssets: %*false,
      assetsPath: path)

  var shot = 0
  proc draw(scene: FrameScene, config: FrameConfig, name: string): Image =
    result = newImage(config.width, config.height)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: result,
      hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    result = render(scene, context)
    inc shot
    let dir = getEnv("FRAMEOS_PDF_SHOTS")
    if dir.len > 0 and name.len > 0:
      createDir(dir)
      result.writeFile(dir / ($shot & "-" & name & ".png"))
    rhythmClockOverride += 1.0

  proc send(scene: FrameScene, event: string, payload: JsonNode) =
    runEvent(scene, ExecutionContext(scene: scene, event: event, payload: payload, loopIndex: 0,
      loopKey: ".", nextSleep: -1))

  proc tap(scene: FrameScene, x, y: int) =
    scene.send("tap", %*{"x": x, "y": y, "pointerId": 0, "pointerType": "touch"})

  proc press(scene: FrameScene, label: string) =
    scene.send("button", %*{"pin": 5, "label": label, "role": "", "action": "press"})

  proc key(scene: FrameScene, key: string) =
    scene.send("keyDown", %*{"key": key})

  proc load(config: FrameConfig): FrameScene =
    setUploadedInterpretedScenes(parseInterpretedScenes($(%*[parseFile(Samples / "PDF viewer" /
      "scenes.json")[0]])))
    resetInterpretedScenes()
    logger.frameConfig = config
    init("pdf-viewer".SceneId, config, logger, %*{})

  proc spot(scene: FrameScene): JsonNode =
    let s = scene.state{"spot"}
    if s != nil and s.kind == JString: parseJson(s.getStr()) else: s

  proc place(scene: FrameScene): (int, int) =
    let left = scene.spot{"docs"}{scene.spot{"doc"}.getStr()}
    (left{"page"}.getInt(), left{"part"}.getInt())

  proc count(image: Image, test: proc(c: ColorRGBX): bool, y0 = 0, y1 = -1): int =
    let last = if y1 < 0: image.height else: y1
    for y in y0 ..< last:
      for x in 0 ..< image.width:
        if test(image[x, y]): inc result

  proc isRed(c: ColorRGBX): bool = c.r > 200 and c.g < 60 and c.b < 60
  proc isGreen(c: ColorRGBX): bool = c.g > 200 and c.r < 60 and c.b < 60
  proc isBlue(c: ColorRGBX): bool = c.b > 200 and c.r < 60 and c.g < 60
  proc isDark(c: ColorRGBX): bool = c.r < 90 and c.g < 90 and c.b < 90
  proc isPhoto(c: ColorRGBX): bool =
    # The fixture's colours: neither the page's white nor a pure colour.
    not (c.r > 240 and c.g > 240 and c.b > 240) and not isRed(c) and not isGreen(c) and not isBlue(c) and not isDark(c)

  proc noProblems() =
    check problems.len == 0
    if problems.len > 0: echo problems

  # The library's rows: 60 px under the 56 px header, the last read first,
  # then by name: modern, not-a, report, scanned-wrong.
  proc openRow(scene: FrameScene, config: FrameConfig, row: int) =
    scene.state["spot"] = %*{"view": "library"}
    discard draw(scene, config, "library")
    scene.tap(300, 56 + 60 * row + 30)

  test "is the PDF viewer scene, a sample with an icon":
    let scene = parseFile(Samples / "PDF viewer" / "scenes.json")[0]
    check scene["id"].getStr() == "pdf-viewer"
    check scene["settings"]["icon"].getStr().len > 0
    check scene["settings"]["category"].getStr() == "System"
    check parseFile(Samples / "PDF viewer" / "template.json")["name"].getStr() == "PDF viewer"

  test "the library lists the card's PDFs by title and length, and says what is not one":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    discard draw(scene, config, "library")
    check scene.spot{"view"}.getStr() == "library"
    let shelf = scene.spot{"shelf"}
    check shelf{"assets:Docs/report.pdf"}{"title"}.getStr() == "A Report"
    check shelf{"assets:Docs/report.pdf"}{"n"}.getInt() == 3
    check shelf{"assets:Docs/modern.pdf"}{"title"}.getStr() == "Modern"
    check shelf{"assets:Docs/modern.pdf"}{"n"}.getInt() == 2
    check shelf{"assets:Docs/scanned-wrong.pdf"}{"n"}.getInt() == 1
    check shelf{"assets:Docs/not-a.pdf"}{"error"}.getStr() == "Not a PDF"
    check not shelf.hasKey("assets:notes.txt")
    # Opening the file that is not a PDF stays in the library and says why.
    scene.tap(300, 56 + 60 * 1 + 30)
    discard draw(scene, config, "not-a-pdf")
    check scene.spot{"view"}.getStr() == "library"
    check scene.spot{"problem"}.getStr().contains("Not a PDF")
    noProblems()

  test "opens the .pdf files another scene hands it (settings.opens), where each was left":
    problems = @[]
    let sample = parseFile(Samples / "PDF viewer" / "scenes.json")[0]
    check sample["settings"]["opens"].getStr() == "pdf"
    let config = frame(800, 480)
    let scene = load(config)
    discard draw(scene, config, "library")
    # What the Files app sends: the public field `file`, applied with the switch.
    scene.state["file"] = %"assets:Docs/report.pdf"
    discard draw(scene, config, "handed")
    check scene.spot{"view"}.getStr() == "doc"
    check scene.spot{"doc"}.getStr() == "assets:Docs/report.pdf"
    check scene.state{"file"}.getStr() == ""
    # One that is no PDF: the library, saying why.
    scene.state["file"] = %"assets:Docs/not-a.pdf"
    discard draw(scene, config, "handed-not-a-pdf")
    check scene.spot{"view"}.getStr() == "library"
    check scene.spot{"problem"}.getStr().contains("Not a PDF")
    noProblems()

  test "a page at the screen's width, read a part at a time, with its shapes, words and pictures":
    problems = @[]
    let config = frame(800, 480)
    var scene = load(config)
    scene.openRow(config, 2)
    let first = draw(scene, config, "report-1")
    check scene.spot{"view"}.getStr() == "doc"
    check scene.spot{"doc"}.getStr() == "assets:Docs/report.pdf"
    check scene.place == (0, 0)
    # A portrait page on a landscape screen: by its width, so its top part
    # shows the band, the heading and the rule.
    check first.count(isRed) > 20_000
    check first.count(isDark, 260, 300) > 300
    check first.count(isBlue) > 1000
    # Forward: the pictures, the photo and the green squares.
    scene.tap(700, 240)
    let second = draw(scene, config, "report-1-part-2")
    check scene.place == (0, 1)
    check second.count(isPhoto) > 10_000
    check second.count(isGreen) > 5_000
    check second.count(isRed) < first.count(isRed)
    # On to the next page by swipes and keys, and back.
    scene.send("swipe", %*{"x": 400, "y": 240, "direction": "left", "pointerId": 0, "pointerType": "touch"})
    discard draw(scene, config, "report-1-part-3")
    check scene.place == (0, 2)
    scene.press("DOWN")
    let page2 = draw(scene, config, "report-2")
    check scene.place == (1, 0)
    check page2.count(isDark) > 2_000
    scene.key("ArrowLeft")
    discard draw(scene, config, "report-1-last-part")
    check scene.place == (0, 2)
    scene.tap(60, 240)
    discard draw(scene, config, "report-1-part-2-again")
    check scene.place == (0, 1)

    # The place is kept across a reload of the scene.
    let kept = scene.spot
    scene = load(config)
    scene.state["spot"] = kept
    discard draw(scene, config, "reloaded")
    check scene.place == (0, 1)
    check scene.spot{"view"}.getStr() == "doc"
    noProblems()

  test "the whole page, the bookmarks and the keypad":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    scene.openRow(config, 2)
    discard draw(scene, config, "report")
    check scene.spot{"doc"}.getStr() == "assets:Docs/report.pdf"
    # The tools from the right: contents, fit, the page number.
    scene.tap(800 - 8 - 18, 20)
    discard draw(scene, config, "contents")
    check scene.spot{"view"}.getStr() == "contents"
    # The second bookmark, a named destination: the third page.
    scene.tap(300, 56 + 46 + 23)
    discard draw(scene, config, "bookmark")
    check scene.spot{"view"}.getStr() == "doc"
    check scene.place == (2, 0)
    # Whole page: one part, the page smaller.
    let fit = scene.spot{"fit"}.getStr()
    scene.tap(800 - 8 - 36 - 8 - 18, 20)
    discard draw(scene, config, "whole-page")
    check scene.spot{"fit"}.getStr() != fit
    scene.press("UP")
    discard draw(scene, config, "whole-page-2")
    check scene.place == (1, 0)
    # The keypad: a digit opens it, Enter goes.
    scene.key("3")
    discard draw(scene, config, "keypad")
    check scene.spot{"view"}.getStr() == "goto"
    check scene.spot{"typed"}.getStr() == "3"
    scene.key("Enter")
    discard draw(scene, config, "page-3")
    check scene.place == (2, 0)
    # A number past the end does not go.
    scene.key("9")
    scene.key("Enter")
    discard draw(scene, config, "keypad-9")
    check scene.spot{"view"}.getStr() == "goto"
    scene.key("Escape")
    scene.key("Escape")
    discard draw(scene, config, "back")
    check scene.spot{"view"}.getStr() == "doc"
    # Any other button goes to the library.
    scene.press("A")
    discard draw(scene, config, "library")
    check scene.spot{"view"}.getStr() == "library"
    noProblems()

  test "PDF 1.5: an object stream, an xref stream, a Type0 font and a turned page":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    scene.openRow(config, 0)
    let page = draw(scene, config, "modern-1")
    check scene.spot{"doc"}.getStr() == "assets:Docs/modern.pdf"
    # The words through the ToUnicode map, and the black bar.
    check page.count(isDark) > 5_000
    var parts = 0
    while scene.place[0] == 0 and parts < 8:
      scene.press("DOWN")
      discard draw(scene, config, "modern-turning")
      inc parts
    let turned = draw(scene, config, "modern-2-turned")
    check scene.place == (1, 0)
    # Turned, the page is landscape and fits whole: its green square shows.
    check turned.count(isGreen) > 3_000
    noProblems()

  test "a file whose cross-references are wrong is read by scanning it":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    scene.openRow(config, 3)
    let page = draw(scene, config, "scanned")
    check scene.spot{"doc"}.getStr() == "assets:Docs/scanned-wrong.pdf"
    check page.count(isBlue) > 50_000
    noProblems()

  test "on e-paper: black on white, a portrait screen reads a page whole":
    problems = @[]
    let config = frame(480, 800, device = "waveshare.EPD_7in5_V2")
    let scene = load(config)
    scene.openRow(config, 2)
    let page = draw(scene, config, "paper-report")
    check scene.spot{"doc"}.getStr() == "assets:Docs/report.pdf"
    # A portrait page on a portrait screen: one part.
    check scene.place == (0, 0)
    scene.tap(400, 400)
    discard draw(scene, config, "paper-report-2")
    check scene.place == (1, 0)
    check page.count(isRed) > 2_000
    noProblems()

  test "an empty card says where PDFs go":
    problems = @[]
    let empty = getTempDir() / "frameos-pdf-empty-" & $epochTime().int
    createDir(empty)
    defer: removeDir(empty)
    let config = frame(480, 800, empty)
    let scene = load(config)
    discard draw(scene, config, "empty")
    check scene.spot{"view"}.getStr() == "library"
    noProblems()

  test "PDFs of your own (FRAMEOS_PDF_FILES)":
    let files = getEnv("FRAMEOS_PDF_FILES")
    if files.len == 0:
      skip()
    else:
      let own = getTempDir() / "frameos-pdf-own-" & $epochTime().int
      createDir(own)
      defer: removeDir(own)
      for file in files.split(':'):
        copyFile(file, own / file.extractFilename)
      let config = frame(parseInt(getEnv("FRAMEOS_PDF_WIDTH", "800")), parseInt(getEnv("FRAMEOS_PDF_HEIGHT", "480")), own)
      for file in files.split(':'):
        problems = @[]
        let scene = load(config)
        scene.state["spot"] = %*{"view": "doc", "doc": "assets:" & file.extractFilename}
        var turns = 0
        let started = epochTime()
        while turns < parseInt(getEnv("FRAMEOS_PDF_TURNS", "12")):
          let before = epochTime()
          discard draw(scene, config, file.extractFilename.changeFileExt("") & "-" & $turns)
          echo file.extractFilename, " ", scene.place, " ", int((epochTime() - before) * 1000), " ms"
          scene.press("DOWN")
          inc turns
        echo file.extractFilename, ": ", int((epochTime() - started) * 1000), " ms for ", turns, " turns"
        noProblems()

removeDir(assets)
