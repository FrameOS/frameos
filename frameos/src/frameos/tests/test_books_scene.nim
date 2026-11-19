## The Books sample (repo/scenes/samples/Books) over a card with EPUB books:
## the library, a book's pages turned with taps, swipes and keys across the
## end of a chapter and back, the place kept across a reload and a change of
## text size, the contents, two columns on a wide screen, and a file that is
## not a book. FRAMEOS_BOOK_SHOTS=<dir> writes each picture there.

import std/[json, os, strutils, times, unittest]
import pixie
import zippy
import ../interpreter
import ../js_runtime/app_runtime
import ../scene_rhythm
import ../types

const Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"

proc le16(n: int): string =
  result = newString(2)
  result[0] = char(n and 0xFF)
  result[1] = char((n shr 8) and 0xFF)

proc le32(n: int): string =
  result = newString(4)
  for i in 0 .. 3:
    result[i] = char((n shr (8 * i)) and 0xFF)

proc makeZip(members: openArray[(string, string)], streamed = false): string =
  ## Stored mimetype first, the rest deflated, as an EPUB writer does.
  ## streamed: the sizes after each member's data (flag bit 3), as a writer
  ## that streams does; the local header has zeros.
  var central = ""
  for (name, data) in members:
    let deflate = name != "mimetype"
    let body = if deflate: compress(data, BestCompression, dfDeflate) else: data
    let offset = result.len
    let meth = if deflate: 8 else: 0
    let flags = if streamed and deflate: 8 else: 0
    if flags == 8:
      result.add le32(0x04034b50) & le16(20) & le16(flags) & le16(meth) & le16(0) & le16(0) & le32(0) &
        le32(0) & le32(0) & le16(name.len) & le16(0) & name & body &
        le32(0x08074b50) & le32(0) & le32(body.len) & le32(data.len)
    else:
      result.add le32(0x04034b50) & le16(20) & le16(0) & le16(meth) & le16(0) & le16(0) & le32(0) &
        le32(body.len) & le32(data.len) & le16(name.len) & le16(0) & name & body
    central.add le32(0x02014b50) & le16(20) & le16(20) & le16(flags) & le16(meth) & le16(0) & le16(0) &
      le32(0) & le32(body.len) & le32(data.len) & le16(name.len) & le16(0) & le16(0) & le16(0) &
      le16(0) & le32(0) & le32(offset) & name
  let at = result.len
  result.add central
  result.add le32(0x06054b50) & le16(0) & le16(0) & le16(members.len) & le16(members.len) &
    le32(central.len) & le32(at) & le16(0)

proc xhtml(title, body: string): string =
  "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n" &
    "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>" & title &
    "</title><style>p { text-indent: 1em }</style></head>\n<body>" & body & "</body></html>"

proc paragraphs(chapter, count: int): string =
  for i in 1 .. count:
    result.add "<p class=\"text\">Chapter " & $chapter & ", paragraph " & $i &
      ". It was a bright cold day in April, and the clocks were striking thirteen; " &
      "<em>the hallway</em> smelt of boiled cabbage &amp; old rag mats — at one end of it a " &
      "coloured poster, too large for indoor display, had been tacked to the wall.</p>\n"

let assets = getTempDir() / "frameos-books-scene-" & $epochTime().int
createDir(assets / "Books")

let container = "<?xml version=\"1.0\"?><container version=\"1.0\" " &
  "xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\"><rootfiles>" &
  "<rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/>" &
  "</rootfiles></container>"

# An EPUB 3: a cover page with no text, three chapters, a nav document.
writeFile(assets / "Books" / "the-long-walk.epub", makeZip([
  ("mimetype", "application/epub+zip"),
  ("META-INF/container.xml", container),
  ("OEBPS/content.opf", "<?xml version=\"1.0\"?><package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\">" &
    "<metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>The Long Walk</dc:title>" &
    "<dc:creator>Ada Writer</dc:creator></metadata><manifest>" &
    "<item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>" &
    "<item id=\"cover\" href=\"Text/cover.xhtml\" media-type=\"application/xhtml+xml\"/>" &
    "<item id=\"c1\" href=\"Text/chapter%201.xhtml\" media-type=\"application/xhtml+xml\"/>" &
    "<item id=\"c2\" href=\"Text/chapter2.xhtml\" media-type=\"application/xhtml+xml\"/>" &
    "<item id=\"c3\" href=\"Text/chapter3.xhtml\" media-type=\"application/xhtml+xml\"/>" &
    "<item id=\"css\" href=\"style.css\" media-type=\"text/css\"/>" &
    "</manifest><spine><itemref idref=\"cover\"/><itemref idref=\"c1\"/><itemref idref=\"c2\"/>" &
    "<itemref idref=\"c3\"/></spine></package>"),
  ("OEBPS/nav.xhtml", xhtml("Contents", "<nav epub:type=\"toc\"><ol>" &
    "<li><a href=\"Text/chapter%201.xhtml\">One: Morning</a></li>" &
    "<li><a href=\"Text/chapter2.xhtml#start\">Two: The Road</a></li>" &
    "<li><a href=\"Text/chapter3.xhtml\">Three: Evening</a></li></ol></nav>")),
  ("OEBPS/Text/cover.xhtml", xhtml("Cover", "<div><img src=\"../cover.jpg\" alt=\"\"/></div>")),
  ("OEBPS/Text/chapter 1.xhtml", xhtml("One", "<h1>One: Morning</h1>\n" & paragraphs(1, 14) &
    "<hr/><ul><li>bread</li><li><p>cheese &amp; apples</p></li></ul><ol><li>first</li><li>second</li></ol>" &
    "<blockquote><p>A quote, set in.</p></blockquote>")),
  ("OEBPS/Text/chapter2.xhtml", xhtml("Two", "<h2 id=\"start\">Two: The Road</h2>\n" & paragraphs(2, 10))),
  ("OEBPS/Text/chapter3.xhtml", xhtml("Three", "<h2>Three: Evening</h2><p>Grüße aus Köln, “quoted”, " &
    "a word too long to fit any line: Pneumonoultramicroscopicsilicovolcanoconiosispneumonoultramicroscopicsilicovolcanoconiosis.</p>" &
    "<p>The last line.<br/>After a break.</p>")),
  ("OEBPS/style.css", "p { margin: 0 }"),
]))

# An EPUB 2: an NCX instead of a nav, its OPF at the root.
writeFile(assets / "Books" / "old-tales.epub", makeZip([
  ("mimetype", "application/epub+zip"),
  ("META-INF/container.xml", container.replace("OEBPS/content.opf", "tales.opf")),
  ("tales.opf", "<package version=\"2.0\"><metadata><dc:title>Old Tales</dc:title>" &
    "<dc:creator opf:role=\"aut\">B. Teller</dc:creator></metadata><manifest>" &
    "<item id=\"ncx\" href=\"toc.ncx\" media-type=\"application/x-dtbncx+xml\"/>" &
    "<item id=\"t1\" href=\"tale1.html\" media-type=\"application/xhtml+xml\"/>" &
    "<item id=\"t2\" href=\"tale2.html\" media-type=\"application/xhtml+xml\"/>" &
    "</manifest><spine toc=\"ncx\"><itemref idref=\"t1\"/><itemref idref=\"t2\"/></spine></package>"),
  ("toc.ncx", "<ncx><navMap><navPoint id=\"a\"><navLabel><text>The First Tale</text></navLabel>" &
    "<content src=\"tale1.html\"/></navPoint><navPoint id=\"b\"><navLabel><text>The Second Tale</text>" &
    "</navLabel><content src=\"tale2.html\"/></navPoint></navMap></ncx>"),
  ("tale1.html", xhtml("1", "<h3>The First Tale</h3>" & paragraphs(1, 3))),
  ("tale2.html", xhtml("2", "<h3>The Second Tale</h3>" & paragraphs(2, 3))),
], streamed = true))

# A whole book in one file, longer than the frame reads at once (2 MiB off
# an ESP32): read and paged a part at a time.
var whole = "<h1>All of It</h1>\n"
var n = 0
while whole.len < 2 * 1024 * 1024 + 300 * 1024:
  inc n
  whole.add "<p>Line " & $n & " of the one long file, with “quotes” and an é to cut in two now and then.</p>\n"
writeFile(assets / "Books" / "zz-one-file.epub", makeZip([
  ("mimetype", "application/epub+zip"),
  ("META-INF/container.xml", container),
  ("OEBPS/content.opf", "<package><metadata><dc:title>One File</dc:title></metadata><manifest>" &
    "<item id=\"all\" href=\"all.xhtml\" media-type=\"application/xhtml+xml\"/>" &
    "<item id=\"after\" href=\"after.xhtml\" media-type=\"application/xhtml+xml\"/>" &
    "</manifest><spine><itemref idref=\"all\"/><itemref idref=\"after\"/></spine></package>"),
  ("OEBPS/all.xhtml", xhtml("All", whole)),
  ("OEBPS/after.xhtml", xhtml("After", "<p>What comes after.</p>")),
]))

# A picture book: a cover (EPUB 2's <meta name="cover">), and a chapter with
# a line drawing on nothing (a transparent PNG, as Standard Ebooks ship
# Tenniel's), an <svg><image> page and a picture that is not there.
let drawing = newImage(300, 200)
drawing.fill(rgbx(0, 0, 0, 0))
let pen = newContext(drawing)
pen.fillStyle = rgba(0, 0, 0, 255)
pen.fillRect(rect(vec2(0, 0), vec2(300, 40)))
let coverImage = newImage(120, 180)
coverImage.fill(rgba(200, 30, 30, 255))
writeFile(assets / "Books" / "zy-pictures.epub", makeZip([
  ("mimetype", "application/epub+zip"),
  ("META-INF/container.xml", container),
  ("OEBPS/content.opf", "<package version=\"2.0\"><metadata><dc:title>Pictures</dc:title>" &
    "<meta name=\"cover\" content=\"cov\"/></metadata><manifest>" &
    "<item id=\"cov\" href=\"img/cover.png\" media-type=\"image/png\"/>" &
    "<item id=\"t\" href=\"text/one.xhtml\" media-type=\"application/xhtml+xml\"/>" &
    "<item id=\"u\" href=\"text/two.xhtml\" media-type=\"application/xhtml+xml\"/>" &
    "</manifest><spine><itemref idref=\"t\"/><itemref idref=\"u\"/></spine></package>"),
  ("OEBPS/img/cover.png", encodeImage(coverImage, PngFormat)),
  ("OEBPS/img/drawing.png", encodeImage(drawing, PngFormat)),
  ("OEBPS/text/one.xhtml", xhtml("One", "<p>Above the drawing.</p><figure><img src=\"../img/drawing.png\" alt=\"A bar\"/>" &
    "<figcaption>A bar, drawn.</figcaption></figure><p><img src=\"../img/missing.png\" alt=\"Gone\"/></p>")),
  ("OEBPS/text/two.xhtml", xhtml("Two", "<div><svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 180\">" &
    "<image width=\"120\" height=\"180\" xlink:href=\"../img/cover.png\"/></svg></div>")),
]))

writeFile(assets / "Books" / "broken.epub", "this is not a zip file at all")
writeFile(assets / "notes.txt", "not a book")

suite "the Books scene":
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

  proc frame(width, height: int, device = "framebuffer"): FrameConfig =
    FrameConfig(name: "books", mode: "rpios", device: device, width: width, height: height, rotate: 0,
      scalingMode: "cover", debug: false, settings: %*{}, renderScale: 1.0, saveAssets: %*false,
      assetsPath: assets)

  var shot = 0
  proc draw(scene: FrameScene, config: FrameConfig, name: string): Image =
    result = newImage(config.width, config.height)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: result,
      hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    result = render(scene, context)
    inc shot
    let dir = getEnv("FRAMEOS_BOOK_SHOTS")
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

  proc load(config: FrameConfig): FrameScene =
    setUploadedInterpretedScenes(parseInterpretedScenes($(%*[parseFile(Samples / "Books" /
      "scenes.json")[0]])))
    resetInterpretedScenes()
    logger.frameConfig = config
    init("books".SceneId, config, logger, %*{})

  proc spot(scene: FrameScene): JsonNode =
    let s = scene.state{"spot"}
    if s != nil and s.kind == JString: parseJson(s.getStr()) else: s

  proc at(scene: FrameScene): (int, int, int) =
    let a = scene.spot{"at"}
    (a{"s"}.getInt(), a{"b"}.getInt(), a{"c"}.getInt())

  proc noProblems() =
    check problems.len == 0
    if problems.len > 0: echo problems

  test "is the ePub reader scene, a sample with an icon":
    let scene = parseFile(Samples / "Books" / "scenes.json")[0]
    check scene["id"].getStr() == "books"
    check scene["settings"]["icon"].getStr().len > 0
    check parseFile(Samples / "Books" / "template.json")["name"].getStr() == "ePub reader"

  test "the library lists the card's books by title, and says what is not one":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    discard draw(scene, config, "library")
    check scene.spot{"view"}.getStr() == "library"
    noProblems()
    # A tap on each row: the broken file stays in the library and says why.
    scene.tap(300, 56 + 30)
    discard draw(scene, config, "library-after-tap")
    let first = scene.spot{"book"}.getStr()
    check first.len == 0 or first.endsWith(".epub")

  test "opens a book past its cover, turns pages forward and back to the same page":
    problems = @[]
    let config = frame(800, 480)
    var scene = load(config)
    scene.state["spot"] = %*{"view": "library"}
    discard draw(scene, config, "library")
    # Rows are 60 px under the 56 px header, sorted by name: broken, old-tales, the-long-walk.
    scene.tap(300, 56 + 60 * 2 + 30)
    discard draw(scene, config, "opened")
    check scene.spot{"book"}.getStr() == "assets:Books/the-long-walk.epub"
    check scene.spot{"view"}.getStr() == "book"
    check scene.at[0] == 1 # the cover has no text
    let first = scene.at
    scene.tap(700, 240) # the right of the page: forward
    discard draw(scene, config, "page-2")
    let second = scene.at
    check second != first
    check second[1] > 0 or second[2] > 0
    scene.press("DOWN")
    discard draw(scene, config, "page-3")
    let third = scene.at
    check third[1] > second[1] or (third[1] == second[1] and third[2] > second[2])
    scene.tap(60, 240) # the left third: back
    discard draw(scene, config, "page-2-again")
    check scene.at == second
    scene.press("UP")
    discard draw(scene, config, "page-1-again")
    check scene.at == first
    noProblems()

    # Forward to the next chapter, then back to the last page of this one.
    var pages = 0
    while scene.at[0] == 1 and pages < 60:
      scene.send("swipe", %*{"x": 400, "y": 240, "direction": "left", "pointerId": 0, "pointerType": "touch"})
      discard draw(scene, config, "walk")
      inc pages
    check scene.at == (2, 0, 0)
    check pages > 2
    scene.send("keyDown", %*{"key": "ArrowLeft"})
    discard draw(scene, config, "back-into-chapter-1")
    check scene.at[0] == 1
    check scene.at[1] > 10

    # The place is kept across a reload of the scene.
    let kept = scene.spot
    let place = scene.at
    scene = load(config)
    scene.state["spot"] = kept
    discard draw(scene, config, "reloaded")
    check scene.at == place
    noProblems()

  test "a bigger text keeps the paragraph it was on, and the contents jump":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    scene.state["spot"] = %*{"view": "library"}
    discard draw(scene, config, "library")
    scene.tap(300, 56 + 60 * 2 + 30)
    discard draw(scene, config, "opened")
    for i in 0 ..< 4:
      scene.press("DOWN")
      discard draw(scene, config, "forward")
    let before = scene.at
    let size = scene.spot{"size"}.getInt()
    # A+ is the second tool from the right in the top bar.
    var bigger = false
    for x in countdown(790, 560, 6):
      scene.tap(x, 17)
      if scene.spot{"size"}.getInt() == size + 1:
        bigger = true
        break
    check bigger
    discard draw(scene, config, "bigger")
    let after = scene.at
    check after[0] == before[0]
    check after[1] <= before[1]
    check after[1] >= before[1] - 2
    # Contents: the last tool; the third entry opens chapter three.
    var shown = false
    for x in countdown(796, 700, 4):
      scene.tap(x, 17)
      if scene.spot{"view"}.getStr() == "contents":
        shown = true
        break
    check shown
    discard draw(scene, config, "contents")
    scene.tap(300, 56 + 46 * 2 + 23)
    discard draw(scene, config, "chapter-3")
    check scene.spot{"view"}.getStr() == "book"
    check scene.at == (3, 0, 0)
    # To the end, where it stops.
    for i in 0 ..< 6:
      scene.press("DOWN")
      discard draw(scene, config, "end")
    check scene.at[0] == 3
    # A key that is not a page turn: back to the library, and Enter opens it again.
    scene.press("AI")
    discard draw(scene, config, "library-by-key")
    check scene.spot{"view"}.getStr() == "library"
    scene.send("keyDown", %*{"key": "Enter"})
    discard draw(scene, config, "reopened-by-key")
    check scene.spot{"view"}.getStr() == "book"
    check scene.at[0] == 3
    noProblems()

  test "an EPUB 2 with an NCX, in two columns on a wide screen":
    problems = @[]
    let config = frame(1600, 600)
    let scene = load(config)
    scene.state["spot"] = %*{"view": "library"}
    discard draw(scene, config, "wide-library")
    var opened = false
    for y in countup(80, 400, 20):
      scene.tap(400, y)
      if scene.spot{"book"}.getStr() == "assets:Books/old-tales.epub":
        opened = true
        break
      if scene.spot{"view"}.getStr() == "book":
        scene.press("AI")
        discard draw(scene, config, "back")
    check opened
    discard draw(scene, config, "wide-book")
    check scene.spot{"pg"}{"key"}.getStr().endsWith("|2")
    check scene.at[0] == 0
    scene.press("RIGHT")
    discard draw(scene, config, "wide-next")
    check scene.at[0] == 1
    noProblems()

  test "a chapter longer than one read goes on into its next part, and back":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    # Past the end of the first part's text: its last page.
    scene.state["spot"] = %*{"view": "book", "book": "Books/zz-one-file.epub",
      "at": {"s": 0, "p": 0, "b": n, "c": 0}}
    discard draw(scene, config, "deep-in")
    check scene.spot{"at"}{"p"}.getInt() == 0
    check scene.spot{"at"}{"b"}.getInt() > 1000
    scene.press("DOWN")
    discard draw(scene, config, "next-part")
    check scene.spot{"at"}{"s"}.getInt() == 0
    check scene.spot{"at"}{"p"}.getInt() == 1
    scene.press("UP")
    discard draw(scene, config, "back-a-part")
    check scene.spot{"at"}{"p"}.getInt() == 0
    check scene.spot{"at"}{"b"}.getInt() > 1000
    noProblems()

  test "e-paper reads black on white, the library and a page":
    problems = @[]
    let config = frame(800, 480, "waveshare.EPD_7in5_V2")
    let scene = load(config)
    scene.state["spot"] = %*{"view": "library"}
    let library = draw(scene, config, "paper-library")
    check library[400, 300] == rgbx(255, 255, 255, 255)
    scene.tap(300, 56 + 60 * 2 + 30)
    let page = draw(scene, config, "paper-page")
    check scene.spot{"view"}.getStr() == "book"
    check page[400, 470] == rgbx(255, 255, 255, 255)
    noProblems()

  test "a book's pictures: on the page at their shape, over the page's colour, and its cover in the library":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    scene.state["spot"] = %*{"view": "library"}
    let library = draw(scene, config, "pictures-library")
    # Sorted by name: broken, old-tales, the-long-walk, zy-pictures, zz-one-file.
    # The cover sits at the left of its row, red.
    let cover = library[16 + 10 + 20, 56 + 60 * 3 + 30]
    check cover.r > 150 and cover.g < 80
    scene.tap(400, 56 + 60 * 3 + 30)
    let page = draw(scene, config, "pictures-page")
    check scene.spot{"book"}.getStr() == "assets:Books/zy-pictures.epub"
    # The drawing is 300x200 laid out centred under one line of text: its bar
    # black, the rest of it the page's colour (never black from no alpha).
    var black = 0
    var paperBelow = 0
    for y in 60 ..< 400:
      let p = page[400, y]
      if p.r < 40 and p.g < 40 and p.b < 40: inc black
      elif p.r > 230 and p.g > 230: inc paperBelow
    check black >= 35
    check black <= 60
    check paperBelow > 200
    # The next part: the <svg><image> page, the cover alone on it, as tall
    # as the page.
    scene.press("DOWN")
    let second = draw(scene, config, "pictures-svg-page")
    for y in [70, 240, 400]:
      let red = second[400, y]
      check red.r > 150 and red.g < 80
    noProblems()

  test "a frame with a TF card and internal storage lists both, each under its name":
    problems = @[]
    let internal = getTempDir() / "frameos-books-internal-" & $epochTime().int
    createDir(internal / "Books")
    writeFile(internal / "Books" / "inner.epub", makeZip([
      ("mimetype", "application/epub+zip"),
      ("META-INF/container.xml", container),
      ("OEBPS/content.opf", "<package><metadata><dc:title>Inside the Frame</dc:title></metadata><manifest>" &
        "<item id=\"a\" href=\"a.xhtml\" media-type=\"application/xhtml+xml\"/></manifest>" &
        "<spine><itemref idref=\"a\"/></spine></package>"),
      ("OEBPS/a.xhtml", xhtml("A", "<p>Kept in the frame's own flash.</p>")),
    ]))
    storageInternalPath = internal
    storageCardMounted = true
    defer:
      storageInternalPath = ""
      storageCardMounted = false
      removeDir(internal)
    let config = frame(800, 480)
    let scene = load(config)
    scene.state["spot"] = %*{"view": "library"}
    discard draw(scene, config, "two-storages")
    # The card's five books under "TF card", then "Internal storage" and its
    # one, on the next page: the keys walk past the heading.
    for i in 0 ..< 5:
      scene.press("DOWN")
      discard draw(scene, config, "two-storages-walk")
    check scene.spot{"sel"}.getInt() == 5
    check scene.spot{"page"}.getInt() == 1
    scene.press("AI")
    discard draw(scene, config, "internal-book")
    check scene.spot{"book"}.getStr() == "internal:Books/inner.epub"
    check scene.spot{"view"}.getStr() == "book"
    noProblems()

  test "real books (FRAMEOS_BOOK_FILES=<a.epub>:<b.epub>, else skipped)":
    # Books from elsewhere, read through: every chapter's first pages, the
    # contents, timings on the way. For trying a change on books nobody made
    # for this test; CI has none.
    let files = getEnv("FRAMEOS_BOOK_FILES")
    if files.len == 0:
      skip()
    else:
      createDir(assets / "Real")
      for file in files.split(':'):
        copyFile(file, assets / "Real" / file.extractFilename)
      for file in files.split(':'):
        problems = @[]
        let config = frame(800, 480)
        let scene = load(config)
        let path = "Real/" & file.extractFilename
        scene.state["spot"] = %*{"view": "book", "book": path}
        var started = epochTime()
        discard draw(scene, config, file.extractFilename & "-open")
        echo "  ", file.extractFilename, ": opened in ", int((epochTime() - started) * 1000), " ms"
        check scene.spot{"view"}.getStr() == "book"
        var slowest = 0.0
        var turns = 0
        var chapters = 0
        var last = -1
        started = epochTime()
        while turns < 2000:
          let before = scene.at
          let t0 = epochTime()
          scene.press("DOWN")
          discard draw(scene, config, if turns < 30: file.extractFilename & "-page" else: "")
          slowest = max(slowest, epochTime() - t0)
          inc turns
          if scene.at[0] != last:
            inc chapters
            last = scene.at[0]
          if scene.at == before: break
        echo "  ", file.extractFilename, ": ", turns, " pages, ", chapters, " chapters, ",
          int((epochTime() - started) * 1000 / max(1, turns).float), " ms a page, slowest ",
          int(slowest * 1000), " ms"
        # Back across a chapter's start, then the contents.
        for i in 0 ..< 3:
          scene.press("UP")
          discard draw(scene, config, "")
        scene.send("keyDown", %*{"key": "Escape"})
        discard draw(scene, config, file.extractFilename & "-library")
        noProblems()

removeDir(assets)
