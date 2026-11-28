## The Books sample (repo/scenes/samples/Books), a book reader, over a card
## with EPUB books: the library (filters, sorting, the book being read on
## top), a book's pages turned with taps, swipes and keys across the end of a
## chapter and back, the place kept across a reload and a change of text
## size, the book's menu and contents, bookmarks, highlights and notes made
## with a finger and with the keys, find in the book, go to a place, the text
## and layout settings, the reading stats, the notes exported (Markdown, a
## Kindle "My Clippings.txt", a backup) and imported again, and free books
## from Project Gutenberg (through Gutendex) and an OPDS catalog downloaded a
## range at a time (the network is jsHttpRequestHook). Two columns on a wide
## screen, e-paper, pictures, a file that is not a book, two storages.
## FRAMEOS_BOOK_SHOTS=<dir> writes each picture there.

import std/[base64, json, os, strutils, times, unittest]
import pixie
import zippy
import ../interpreter
import ../js_runtime/app_runtime
import ../scene_rhythm
import ../types
import ../ui/events
import ../ui/layout
import ../utils/http_client
import ../utils/memory

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


# ---- The network: Gutendex, Gutenberg (its own server down, its mirror up),
# an OPDS catalog, and covers. ----

let downloaded = makeZip([
  ("mimetype", "application/epub+zip"),
  ("META-INF/container.xml", container),
  ("OEBPS/content.opf", "<package><metadata><dc:title>A Downloaded Tale</dc:title><dc:creator>Ada Writer</dc:creator>" &
    "</metadata><manifest><item id=\"a\" href=\"a.xhtml\" media-type=\"application/xhtml+xml\"/></manifest>" &
    "<spine><itemref idref=\"a\"/></spine></package>"),
  ("OEBPS/a.xhtml", xhtml("A", "<h1>A Downloaded Tale</h1>" & paragraphs(1, 30))),
])
let opdsBook = downloaded.replace("A Downloaded Tale", "From the Shelf  ")

# Covers as data: URLs (a picture the runtime decodes at once, with no request).
proc coverUrl(color: ColorRGBA): string =
  let picture = newImage(60, 90)
  picture.fill(color)
  "data:image/png;base64," & encode(encodeImage(picture, PngFormat))

let gutendex = """{"count": 2, "next": null, "previous": null, "results": [
  {"id": 777, "title": "A Downloaded Tale", "authors": [{"name": "Writer, Ada", "birth_year": 1800, "death_year": 1880}],
   "summaries": ["A tale told for this test, of a frame that reads. (This is an automatically generated summary.)"],
   "subjects": ["Frames -- Fiction"], "bookshelves": ["Category: Novels", "Best Books Ever Listings"], "languages": ["en"],
   "copyright": false, "media_type": "Text", "formats": {"application/epub+zip": "https://www.gutenberg.org/ebooks/777.epub3.images",
   "image/jpeg": "COVER_777"}, "download_count": 4321},
  {"id": 778, "title": "Only as Text", "authors": [], "summaries": [], "bookshelves": [], "languages": ["en"],
   "formats": {"text/plain; charset=us-ascii": "https://www.gutenberg.org/ebooks/778.txt.utf-8"}, "download_count": 3}]}""".replace(
    "COVER_777", coverUrl(rgba(46, 94, 140, 255)))

const OpdsRoot = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <title>Home library</title>
  <link rel="search" type="application/atom+xml" href="/opds/search?q={searchTerms}"/>
  <entry><title>New books</title><id>new</id>
    <link rel="subsection" type="application/atom+xml;profile=opds-catalog;kind=acquisition" href="/opds/new"/></entry>
</feed>"""

let opdsNew = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>New books</title>
  <entry><title>From the Shelf</title><id>urn:9</id><author><name>Shelf Keeper</name></author>
    <summary>A book that a home library serves &amp; this test downloads.</summary>
    <link rel="http://opds-spec.org/image/thumbnail" type="image/png" href="COVER_9"/>
    <link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="../books/9.epub" length="4000"/></entry>
</feed>""".replace("COVER_9", coverUrl(rgba(150, 60, 40, 255)))

var requests: seq[string]

proc serve(url, httpMethod, body: string, headers: seq[SimpleHttpHeader]): tuple[code: int, body: string] =
  requests.add url
  jsHttpHookHeaders = ""
  if url.startsWith("https://gutendex.com/books/"): return (200, gutendex)
  if url.startsWith("https://www.gutenberg.org/"): return (503, "Temporarily Down for Maintenance")
  if url == "https://books.example/opds": return (200, OpdsRoot)
  if url == "https://books.example/opds/new": return (200, opdsNew)
  let file = if url == "https://gutenberg.pglaf.org/cache/epub/777/pg777-images-3.epub": downloaded
    elif url == "https://books.example/books/9.epub": opdsBook
    else: ""
  if file.len == 0: return (404, "")
  for (name, value) in headers:
    if name.toLowerAscii() == "range":
      let span = value["bytes=".len .. ^1].split('-')
      let a = parseInt(span[0])
      let b = min(parseInt(span[1]), file.len - 1)
      jsHttpHookHeaders = "content-range: bytes " & $a & "-" & $b & "/" & $file.len & "\n"
      return (206, file[a .. b])
  (200, file)


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

  proc tap(scene: FrameScene, x, y: float) =
    scene.send("tap", %*{"x": x, "y": y, "pointerId": 0, "pointerType": "touch"})

  proc tap(scene: FrameScene, at: (float32, float32)) =
    scene.tap(at[0].float, at[1].float)

  proc hold(scene: FrameScene, x, y: float) =
    scene.send("longPress", %*{"x": x, "y": y, "pointerId": 0, "pointerType": "touch"})

  proc press(scene: FrameScene, label: string, role = "") =
    scene.send("button", %*{"pin": 5, "label": label, "role": role, "action": "press"})

  proc typeIn(scene: FrameScene, text: string) =
    scene.send("textInput", %*{"text": text})

  proc load(config: FrameConfig, state = %*{}): FrameScene =
    setUploadedInterpretedScenes(parseInterpretedScenes($(%*[parseFile(Samples / "Books" /
      "scenes.json")[0]])))
    resetInterpretedScenes()
    logger.frameConfig = config
    init("books".SceneId, config, logger, state)

  proc target(): UiTarget =
    for node in 0 .. 64:
      result = uiTarget("books", node, create = false)
      if not result.isNil: return

  # Where each element that takes a tap is (its middle), in the tree's order.
  proc taps(): seq[(float32, float32)] =
    let ui = target()
    if ui.isNil: return
    for r in ui.regions:
      if r.handlers[ueClick] > 0 or r.field > 0:
        result.add((r.x + r.w / 2 + ui.offsetX, r.y + r.h / 2 + ui.offsetY))

  proc tapsIn(x0, x1, y0, y1: float32): seq[(float32, float32)] =
    for t in taps():
      if t[0] >= x0 and t[0] < x1 and t[1] >= y0 and t[1] < y1:
        result.add t

  proc fields(): seq[(float32, float32)] =
    let ui = target()
    for r in ui.regions:
      if r.field > 0:
        result.add((r.x + r.w / 2 + ui.offsetX, r.y + r.h / 2 + ui.offsetY))

  proc json(scene: FrameScene, name: string): JsonNode =
    let s = scene.state{name}
    if s != nil and s.kind == JString: parseJson(s.getStr()) else: s

  proc spot(scene: FrameScene): JsonNode = scene.json("spot")

  proc marksOf(scene: FrameScene, key: string): JsonNode =
    let m = scene.json("marks")
    if m.isNil or m{key}.isNil: newJArray() else: m{key}{"list"}

  proc at(scene: FrameScene): (int, int, int) =
    let a = scene.spot{"at"}
    (a{"s"}.getInt(), a{"b"}.getInt(), a{"c"}.getInt())

  proc view(scene: FrameScene): string = scene.spot{"view"}.getStr()

  proc noProblems() =
    check problems.len == 0
    if problems.len > 0: echo problems

  # The library's rows at 800x480: under the 56 px bar and the 40 px row of
  # filters, 62 px each, above the 46 px foot.
  proc rows(): seq[(float32, float32)] = tapsIn(0, 800, 96, 434)
  # A list's rows with no filters over them.
  proc listRows(): seq[(float32, float32)] = tapsIn(0, 800, 56, 434)

  # The reader's top bar: Library, the title (contents), Aa, the ribbon, the menu.
  proc tools(): seq[(float32, float32)] = tapsIn(0, 2000, 0, 34)

  proc openBook(scene: FrameScene, config: FrameConfig, key: string) =
    scene.state["spot"] = %*{"view": "book", "book": key}
    discard scene.draw(config, "")

  test "is the ePub reader scene, a sample with an icon, that may write its notes and downloads":
    let scene = parseFile(Samples / "Books" / "scenes.json")[0]
    check scene["id"].getStr() == "books"
    check scene["settings"]["icon"].getStr().len > 0
    check parseFile(Samples / "Books" / "template.json")["name"].getStr() == "ePub reader"
    let config = parseJson(scene["apps"]["books"]["sources"]["config.json"].getStr())
    check config["permissions"] == %*["assets", "assets-write"]
    var names: seq[string]
    for field in scene["fields"]: names.add field["name"].getStr()
    for name in ["folder", "file", "fullScreen", "languages", "catalogs", "marks", "spot"]:
      check name in names

  test "the library lists the card's books by title, filters them, and says what is not one":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    discard scene.draw(config, "library")
    check scene.view == "library"
    noProblems()
    # The bar's buttons (Get books, Reading, Refresh), the four filters, then
    # a row a book: broken, old-tales, the-long-walk, zy-pictures, zz-one-file.
    check rows().len >= 5
    scene.tap(rows()[0])
    discard scene.draw(config, "library-after-tap")
    check scene.view == "library"
    check scene.spot{"problem"}.getStr().contains("not an EPUB")
    # Finished: none yet.
    scene.tap(tapsIn(150, 260, 56, 96)[0])
    discard scene.draw(config, "library-finished")
    check scene.spot{"filter"}.getStr() == "done"
    # No book rows: Get free books and the stats.
    check rows().len == 2
    noProblems()

  test "opens a book past its cover, turns pages forward and back to the same page":
    problems = @[]
    let config = frame(800, 480)
    var scene = load(config)
    scene.state["spot"] = %*{"view": "library"}
    discard scene.draw(config, "library")
    scene.tap(rows()[2])
    discard scene.draw(config, "opened")
    check scene.spot{"book"}.getStr() == "assets:Books/the-long-walk.epub"
    check scene.view == "book"
    check scene.at[0] == 1 # the cover has no text
    let first = scene.at
    scene.tap(700, 240) # the right of the page: forward
    discard scene.draw(config, "page-2")
    let second = scene.at
    check second != first
    check second[1] > 0 or second[2] > 0
    scene.press("DOWN")
    discard scene.draw(config, "page-3")
    let third = scene.at
    check third[1] > second[1] or (third[1] == second[1] and third[2] > second[2])
    scene.tap(60, 240) # the left third: back
    discard scene.draw(config, "page-2-again")
    check scene.at == second
    scene.press("UP")
    discard scene.draw(config, "page-1-again")
    check scene.at == first
    noProblems()

    # Forward to the next chapter, then back to the last page of this one.
    var pages = 0
    while scene.at[0] == 1 and pages < 60:
      scene.send("swipe", %*{"x": 400, "y": 240, "direction": "left", "pointerId": 0, "pointerType": "touch"})
      discard scene.draw(config, "walk")
      inc pages
    check scene.at == (2, 0, 0)
    check pages > 2
    scene.send("keyDown", %*{"key": "ArrowLeft"})
    discard scene.draw(config, "back-into-chapter-1")
    check scene.at[0] == 1
    check scene.at[1] > 10

    # The place is kept across a reload of the scene, and the library shows
    # the book on top, how far it is.
    let kept = scene.spot
    let place = scene.at
    scene = load(config)
    scene.state["spot"] = kept
    discard scene.draw(config, "reloaded")
    check scene.at == place
    scene.send("keyDown", %*{"key": "Escape"})
    discard scene.draw(config, "library-continue")
    check scene.view == "library"
    let book = scene.spot{"books"}{"assets:Books/the-long-walk.epub"}
    check book{"f"}.getFloat() > 0.2
    check book{"f"}.getFloat() < 0.6
    # The first row is the book being read: a tap opens it where it was.
    scene.tap(rows()[0])
    discard scene.draw(config, "continued")
    check scene.view == "book"
    check scene.at == place
    noProblems()

  test "opens the .epub files another scene hands it (settings.opens), where each was left":
    problems = @[]
    check parseFile(Samples / "Books" / "scenes.json")[0]["settings"]["opens"].getStr() == "epub"
    let config = frame(800, 480)
    let scene = load(config)
    discard scene.draw(config, "library")
    scene.state["file"] = %"assets:Books/old-tales.epub"
    discard scene.draw(config, "handed")
    check scene.view == "book"
    check scene.spot{"book"}.getStr() == "assets:Books/old-tales.epub"
    check scene.state{"file"}.getStr() == ""
    noProblems()

  test "text and layout: a bigger text keeps the paragraph it was on, justified, a dark page":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    scene.openBook(config, "assets:Books/the-long-walk.epub")
    for i in 0 ..< 4:
      scene.press("DOWN")
      discard scene.draw(config, "forward")
    let before = scene.at
    let size = scene.spot{"prefs"}{"size"}.getInt()
    scene.tap(tools()[2]) # Aa
    discard scene.draw(config, "type-sheet")
    check scene.spot{"sheet"}.getStr() == "type"
    # The sheet's buttons, in its order: Done, A-, A+, then a row each.
    let sheet = tapsIn(0, 800, 34, 480)
    let aPlus = sheet[sheet.len - 17]
    scene.tap(aPlus)
    discard scene.draw(config, "bigger")
    check scene.spot{"prefs"}{"size"}.getInt() == size + 1
    let after = scene.at
    check after[0] == before[0]
    check after[1] <= before[1]
    check after[1] >= before[1] - 2
    # Justified, then a dark page.
    scene.tap(tapsIn(0, 800, 34, 480)[^9]) # Justified
    discard scene.draw(config, "justified")
    check scene.spot{"prefs"}{"justify"}.getBool()
    scene.tap(tapsIn(0, 800, 34, 480)[^6]) # Dark
    discard scene.draw(config, "dark-sheet")
    check scene.spot{"prefs"}{"theme"}.getStr() == "dark"
    scene.tap(tapsIn(0, 800, 34, 480)[^19]) # Done
    let dark = scene.draw(config, "dark-page")
    check scene.spot{"sheet"}.kind == JNull
    check dark[400, 460].r < 40
    noProblems()

  test "the book's menu with the keys, the contents, and the end of the book":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    scene.openBook(config, "assets:Books/the-long-walk.epub")
    # Action: the book's menu; its second row is the contents.
    scene.press("AI")
    discard scene.draw(config, "menu")
    check scene.view == "menu"
    scene.press("DOWN")
    discard scene.draw(config, "")
    scene.press("AI")
    discard scene.draw(config, "contents")
    check scene.view == "contents"
    # The third entry opens chapter three.
    scene.press("DOWN")
    discard scene.draw(config, "")
    scene.press("DOWN")
    discard scene.draw(config, "")
    scene.press("AI")
    discard scene.draw(config, "chapter-3")
    check scene.view == "book"
    check scene.at == (3, 0, 0)
    # To the end, where it stops and says so.
    for i in 0 ..< 6:
      scene.press("DOWN")
      discard scene.draw(config, "end")
    check scene.at[0] == 3
    check scene.spot{"sheet"}.getStr() == "end"
    check scene.spot{"books"}{"assets:Books/the-long-walk.epub"}{"done"}.getFloat() > 0
    # The library's Finished has it.
    scene.send("keyDown", %*{"key": "Escape"})
    discard scene.draw(config, "")
    scene.send("keyDown", %*{"key": "Escape"})
    discard scene.draw(config, "library")
    check scene.view == "library"
    scene.tap(tapsIn(150, 260, 56, 96)[0])
    discard scene.draw(config, "library-finished")
    check rows().len == 3 # the book, Get free books, the stats
    noProblems()

  test "bookmarks, and highlights with notes, by finger":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    let key = "assets:Books/the-long-walk.epub"
    scene.openBook(config, key)
    scene.press("DOWN")
    discard scene.draw(config, "")
    # The ribbon: a bookmark, drawn in the page's corner.
    scene.tap(tools()[3])
    let marked = scene.draw(config, "bookmarked")
    check scene.marksOf(key).len == 1
    check scene.marksOf(key)[0]{"k"}.getStr() == "b"
    check scene.marksOf(key)[0]{"t"}.getStr().len > 20
    let ribbon = marked[800 - 18, 40]
    check ribbon.r > 150 and ribbon.g < 90
    # A long press on a word starts a passage, a tap further on ends it.
    scene.hold(120, 100)
    discard scene.draw(config, "picking")
    check scene.spot{"selm"}.kind == JObject
    scene.tap(500, 250)
    let picking = scene.draw(config, "picked")
    # Highlight, with a note.
    scene.tap(taps()[^2]) # Note
    discard scene.draw(config, "note")
    check scene.view == "note"
    scene.tap(fields()[0])
    scene.typeIn("Cabbage again")
    discard scene.draw(config, "note-typed")
    scene.tap(taps()[^1]) # Save
    discard scene.draw(config, "mark")
    check scene.view == "mark"
    let list = scene.marksOf(key)
    check list.len == 2
    var highlight: JsonNode
    for m in list:
      if m{"k"}.getStr() == "h": highlight = m
    check highlight{"n"}.getStr() == "Cabbage again"
    check highlight{"t"}.getStr().len > 40
    check highlight{"b2"}.getInt() >= highlight{"b"}.getInt()
    # Go to it: the page shows it marked.
    scene.tap(taps()[1]) # Go to it
    let page = scene.draw(config, "highlighted")
    check scene.view == "book"
    var yellow = 0
    for y in 60 ..< 300:
      for x in countup(40, 760, 8):
        let p = page[x, y]
        if p.r > 220 and p.g > 200 and p.b < 170: inc yellow
    check yellow > 40
    discard picking
    # The marks list has both; the bookmark taken off again from the ribbon.
    scene.tap(tools()[3])
    discard scene.draw(config, "")
    check scene.marksOf(key).len == 1
    noProblems()

  test "a passage picked with the keys, from the menu":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    let key = "assets:Books/old-tales.epub"
    scene.openBook(config, key)
    scene.press("AI")
    discard scene.draw(config, "")
    for i in 0 ..< 4:
      scene.press("DOWN")
      discard scene.draw(config, "")
    scene.press("AI") # Highlight a passage
    discard scene.draw(config, "keys-start")
    check scene.view == "book"
    check scene.spot{"selm"}{"phase"}.getStr() == "start"
    scene.press("DOWN") # the next sentence
    discard scene.draw(config, "")
    scene.press("AI") # the start is picked
    discard scene.draw(config, "")
    scene.press("DOWN") # the end a sentence further
    discard scene.draw(config, "keys-end")
    scene.press("AI") # highlighted
    discard scene.draw(config, "keys-highlighted")
    check scene.spot{"selm"}.kind == JNull
    let list = scene.marksOf(key)
    check list.len == 1
    # From the paragraph's first sentence (the start moved past the title)
    # to the end of its second.
    check list[0]{"t"}.getStr().startsWith("Chapter 1, paragraph 1.")
    check list[0]{"t"}.getStr().endsWith("tacked to the wall.")
    noProblems()

  test "find in the book, and go to a place":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    scene.openBook(config, "assets:Books/the-long-walk.epub")
    scene.press("AI")
    discard scene.draw(config, "")
    for i in 0 ..< 5:
      scene.press("DOWN")
      discard scene.draw(config, "")
    scene.press("AI") # Find in the book
    discard scene.draw(config, "find")
    check scene.view == "find"
    scene.tap(fields()[0])
    scene.typeIn("Köln")
    discard scene.draw(config, "")
    scene.tap(tapsIn(600, 800, 56, 96)[0]) # Find
    discard scene.draw(config, "found")
    check scene.spot{"find"}{"hits"}.len == 1
    check scene.spot{"find"}{"hits"}[0]{"s"}.getInt() == 3
    scene.tap(rows()[0])
    discard scene.draw(config, "at-the-find")
    check scene.view == "book"
    check scene.at[0] == 3
    # The status bar opens Go to; the line's middle is half the book.
    scene.tap(400, 465)
    discard scene.draw(config, "goto")
    check scene.spot{"sheet"}.getStr() == "goto"
    scene.tap(400, taps()[^7][1]) # the line
    discard scene.draw(config, "")
    scene.tap(taps()[^1]) # Go
    discard scene.draw(config, "gone-to")
    check scene.spot{"sheet"}.kind == JNull
    check scene.at[0] == 1
    noProblems()

  test "reading stats, and the notes exported and imported again":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    let key = "assets:Books/the-long-walk.epub"
    scene.openBook(config, key)
    # Two minutes on a page, then a turn: counted, and the pace measured.
    var s = scene.spot
    s["last"] = %*{"key": key, "t": (epochTime() - 120) * 1000}
    scene.state["spot"] = s
    scene.press("DOWN")
    discard scene.draw(config, "")
    check scene.spot{"books"}{key}{"secs"}.getFloat() >= 119
    check scene.spot{"totals"}{"pages"}.getInt() == 1
    scene.tap(tools()[3]) # a bookmark to export
    discard scene.draw(config, "")
    scene.send("keyDown", %*{"key": "Escape"})
    discard scene.draw(config, "")
    scene.tap(tapsIn(650, 760, 0, 56)[1]) # the chart
    discard scene.draw(config, "stats")
    check scene.view == "stats"
    removeDir(assets / "Books" / "Notes")
    scene.tap(taps()[^2]) # Export notes
    discard scene.draw(config, "exported")
    let notes = assets / "Books" / "Notes"
    check fileExists(notes / "The Long Walk.md")
    check readFile(notes / "The Long Walk.md").contains("# The Long Walk")
    check readFile(notes / "My Clippings.txt").contains("The Long Walk (Ada Writer)\n- Your Bookmark at location")
    let backup = parseJson(readFile(notes / "FrameOS books backup.json"))
    check backup["format"].getStr() == "frameos-books"
    check backup["marks"][key]["list"].len == 1
    # Forgotten here, and imported again.
    scene.state["marks"] = %*{}
    scene.tap(taps()[^1]) # Import
    discard scene.draw(config, "imported")
    check scene.marksOf(key).len == 1
    check scene.spot{"notice"}.getStr().contains("Imported 1 mark")
    noProblems()

  test "free books: Project Gutenberg's popular shelf, downloaded from its mirror and opened":
    problems = @[]
    requests = @[]
    asyncPumped = false # useFetch answers in the render, through httpRequest
    setSimulatedEmbedded(true) # 64 KB a request, as on an ESP32
    jsHttpRequestHook = serve
    defer:
      jsHttpRequestHook = nil
      asyncPumped = true
      setSimulatedEmbedded(false)
    removeFile(assets / "Books" / "Ada Writer - A Downloaded Tale.epub")
    let config = frame(800, 480)
    let scene = load(config)
    scene.state["spot"] = %*{"view": "library"}
    discard scene.draw(config, "")
    scene.tap(tapsIn(600, 700, 0, 56)[0]) # Get books
    discard scene.draw(config, "catalogs")
    check scene.view == "catalog"
    scene.press("AI") # Project Gutenberg
    discard scene.draw(config, "shelves")
    check scene.view == "shelves"
    scene.press("DOWN")
    discard scene.draw(config, "")
    scene.press("AI") # Most popular
    discard scene.draw(config, "popular")
    check scene.view == "feed"
    check requests[^1].startsWith("https://gutendex.com/books/?sort=popular&languages=en")
    # The book with no EPUB is left out.
    check listRows().len == 1
    scene.tap(listRows()[0])
    discard scene.draw(config, "entry")
    check scene.view == "entry"
    scene.tap(taps()[^1]) # Download
    var renders = 0
    while scene.spot{"dl"}{"state"}.getStr() == "busy" and renders < 50:
      discard scene.draw(config, if renders == 0: "downloading" else: "")
      inc renders
    check scene.spot{"dl"}{"state"}.getStr() == "done"
    let path = assets / "Books" / "Ada Writer - A Downloaded Tale.epub"
    check fileExists(path)
    check readFile(path) == downloaded
    # Its own server was down: the mirror gave it.
    check "https://www.gutenberg.org/cache/epub/777/pg777-images-3.epub" in requests
    discard scene.draw(config, "downloaded")
    scene.tap(taps()[^1]) # Read it
    discard scene.draw(config, "reading-downloaded")
    check scene.view == "book"
    check scene.spot{"book"}.getStr() == "assets:Books/Ada Writer - A Downloaded Tale.epub"
    noProblems()
    removeFile(path)

  test "free books: an OPDS catalog from the catalogs field, a catalog in it, a book from it":
    problems = @[]
    requests = @[]
    asyncPumped = false
    jsHttpRequestHook = serve
    defer:
      jsHttpRequestHook = nil
      asyncPumped = true
    let config = frame(800, 480)
    let scene = load(config, %*{"catalogs": "# a comment\nHome library | https://books.example/opds"})
    scene.state["spot"] = %*{"view": "catalog"}
    discard scene.draw(config, "catalogs-with-yours")
    check listRows().len == 5
    scene.tap(listRows()[2]) # Home library
    discard scene.draw(config, "opds-root")
    check scene.view == "feed"
    scene.tap(listRows()[0]) # New books, a catalog
    discard scene.draw(config, "opds-new")
    check scene.spot{"cat"}{"url"}.getStr() == "https://books.example/opds/new"
    scene.tap(listRows()[0])
    discard scene.draw(config, "opds-entry")
    check scene.spot{"cat"}{"entry"}{"urls"}[0].getStr() == "https://books.example/books/9.epub"
    check scene.spot{"cat"}{"entry"}{"cover"}.getStr().startsWith("data:image/png;base64,")
    scene.tap(taps()[^1]) # Download
    for i in 0 ..< 20:
      discard scene.draw(config, "")
      if scene.spot{"dl"}{"state"}.getStr() != "busy": break
    check scene.spot{"dl"}{"state"}.getStr() == "done"
    check fileExists(assets / "Books" / "Shelf Keeper - From the Shelf.epub")
    removeFile(assets / "Books" / "Shelf Keeper - From the Shelf.epub")
    # Back: the catalog before, then the catalogs.
    scene.send("back", %*{})
    discard scene.draw(config, "")
    check scene.view == "feed"
    scene.send("back", %*{})
    discard scene.draw(config, "")
    check scene.spot{"cat"}{"url"}.getStr() == "https://books.example/opds"
    noProblems()

  test "an EPUB 2 with an NCX, in two columns on a wide screen":
    problems = @[]
    let config = frame(1600, 600)
    let scene = load(config)
    scene.openBook(config, "assets:Books/old-tales.epub")
    discard scene.draw(config, "wide-book")
    check scene.spot{"pg"}{"key"}.getStr().endsWith("|2")
    check scene.at[0] == 0
    scene.press("RIGHT")
    discard scene.draw(config, "wide-next")
    check scene.at[0] == 1
    noProblems()

  test "a chapter longer than one read goes on into its next part, and back":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    # Past the end of the first part's text: its last page.
    scene.state["spot"] = %*{"view": "book", "book": "Books/zz-one-file.epub",
      "at": {"s": 0, "p": 0, "b": n, "c": 0}}
    discard scene.draw(config, "deep-in")
    check scene.spot{"at"}{"p"}.getInt() == 0
    check scene.spot{"at"}{"b"}.getInt() > 1000
    scene.press("DOWN")
    discard scene.draw(config, "next-part")
    check scene.spot{"at"}{"s"}.getInt() == 0
    check scene.spot{"at"}{"p"}.getInt() == 1
    scene.press("UP")
    discard scene.draw(config, "back-a-part")
    check scene.spot{"at"}{"p"}.getInt() == 0
    check scene.spot{"at"}{"b"}.getInt() > 1000
    noProblems()

  test "e-paper reads black on white, the library and a page":
    problems = @[]
    let config = frame(800, 480, "waveshare.EPD_7in5_V2")
    let scene = load(config)
    scene.state["spot"] = %*{"view": "library"}
    let library = scene.draw(config, "paper-library")
    check library[400, 300] == rgbx(255, 255, 255, 255)
    scene.tap(rows()[2])
    let page = scene.draw(config, "paper-page")
    check scene.view == "book"
    check page[400, 470] == rgbx(255, 255, 255, 255)
    noProblems()

  test "a book's pictures: on the page at their shape, over the page's colour, and its cover in the library":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    scene.state["spot"] = %*{"view": "library"}
    let library = scene.draw(config, "pictures-library")
    # Sorted by name: broken, old-tales, the-long-walk, zy-pictures, zz-one-file.
    # The cover sits at the left of its row, red.
    let cover = library[12 + 10 + 18, 96 + 62 * 3 + 31]
    check cover.r > 150 and cover.g < 80
    scene.tap(rows()[3])
    let page = scene.draw(config, "pictures-page")
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
    let second = scene.draw(config, "pictures-svg-page")
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
    discard scene.draw(config, "two-storages")
    # The card's five books under "TF card", then "Internal storage" and its
    # one, on the next page: the keys walk past the heading.
    for i in 0 ..< 5:
      scene.press("DOWN")
      discard scene.draw(config, "two-storages-walk")
    check scene.spot{"sel"}.getInt() == 5
    check scene.spot{"page"}.getInt() == 1
    scene.press("AI")
    discard scene.draw(config, "internal-book")
    check scene.spot{"book"}.getStr() == "internal:Books/inner.epub"
    check scene.view == "book"
    noProblems()

  test "a gallery for the eye (FRAMEOS_BOOK_GALLERY=<dir> with FRAMEOS_BOOK_FILES, else skipped)":
    # Real books on the panels a frame has, every page of the app, for the
    # eye and for a pull request: FRAMEOS_BOOK_FILES=<a.epub>:<b.epub> (the
    # first one with pictures is opened at one), FRAMEOS_BOOK_CATALOG=<dir>
    # with a Gutendex answer (gutendex.json) and Standard Ebooks' feed
    # (se.xml) to show the catalogs with. Nothing here checks; CI skips it.
    let dir = getEnv("FRAMEOS_BOOK_GALLERY")
    let files = getEnv("FRAMEOS_BOOK_FILES")
    if dir.len == 0 or files.len == 0:
      skip()
    else:
      createDir(dir)
      let shelf = assets / "Gallery"
      createDir(shelf)
      var keys: seq[string]
      for file in files.split(':'):
        copyFile(file, shelf / file.extractFilename)
        keys.add "assets:Gallery/" & file.extractFilename
      let catalog = getEnv("FRAMEOS_BOOK_CATALOG")
      asyncPumped = false
      jsHttpRequestHook = proc(url, httpMethod, body: string, headers: seq[SimpleHttpHeader]): tuple[code: int, body: string] =
        jsHttpHookHeaders = ""
        if catalog.len > 0 and url.startsWith("https://gutendex.com/") and fileExists(catalog / "gutendex.json"):
          return (200, readFile(catalog / "gutendex.json"))
        if catalog.len > 0 and url.startsWith("https://standardebooks.org/feeds/") and fileExists(catalog / "se.xml"):
          return (200, readFile(catalog / "se.xml"))
        (404, "")
      defer:
        jsHttpRequestHook = nil
        asyncPumped = true
      let panels = @[
        ("lcd-800x480", 800, 480, "framebuffer", 1.0),
        ("lcd-480x480", 480, 480, "framebuffer", 1.0),
        ("paper-800x480", 800, 480, "waveshare.EPD_7in5_V2", 1.0),
        ("lcd-1280x800", 1280, 800, "framebuffer", 1.0),
        ("paper-1872x1404", 1872, 1404, "waveshare.EPD_7in5_V2", 2.0),
      ]
      for (name, w, h, device, scale) in panels:
        problems = @[]
        var config = frame(w, h, device)
        config.renderScale = scale
        let scene = load(config, %*{"folder": "Gallery", "catalogs": ""})
        var n = 0
        proc snap(what: string) =
          inc n
          scene.draw(config, "").writeFile(dir / (name & "-" & (if n < 10: "0" else: "") & $n & "-" & what & ".png"))
        proc keysDown(count: int) =
          for i in 0 ..< count:
            scene.press("DOWN")
            discard scene.draw(config, "")
        proc menuItem(index: int) =
          # The book's menu: Action, then down to the row, Action.
          scene.press("AI")
          discard scene.draw(config, "")
          keysDown(index)
          scene.press("AI")
        proc setSpot(change: JsonNode) =
          var s = scene.spot
          for k, v in change: s[k] = v
          scene.state["spot"] = s
        # Read a while in each book: a few pages, some time on them.
        for i, key in keys:
          setSpot(%*{"view": "book", "book": key, "at": nil, "pg": nil})
          discard scene.draw(config, "")
          for page in 0 ..< [14, 40, 6, 3, 22, 9][i mod 6]:
            setSpot(%*{"last": {"key": key, "t": (epochTime() - 70) * 1000}})
            scene.press("DOWN")
            discard scene.draw(config, "")
          scene.send("keyDown", %*{"key": "Escape"})
          discard scene.draw(config, "")
        var s = scene.spot
        s["books"][keys[^1]]["done"] = %((epochTime() - 86400 * 3) * 1000)
        s["days"] = %*{}
        let today = now()
        for back in 0 ..< 7:
          let day = (today - initDuration(days = back)).format("yyyy-MM-dd")
          s["days"][day] = %([1500, 2400, 600, 0, 3100, 1800, 900][back])
        s["view"] = %"library"
        s["sel"] = %0
        s["page"] = %0
        s["keys"] = %false
        scene.state["spot"] = s
        snap("library")
        # A book with pictures, at one.
        setSpot(%*{"view": "book", "book": keys[0], "at": {"s": 2, "p": 0, "b": 0, "c": 0}, "pg": nil, "keys": false})
        snap("page")
        keysDown(1)
        snap("page-next")
        # A highlight with the keys, a note, a bookmark.
        setSpot(%*{"view": "book", "book": keys[1], "at": nil, "pg": nil})
        discard scene.draw(config, "")
        keysDown(3)
        menuItem(4)
        discard scene.draw(config, "")
        keysDown(1)
        scene.press("AI")
        discard scene.draw(config, "")
        keysDown(2)
        snap("picking")
        scene.press("AI")
        discard scene.draw(config, "")
        menuItem(3) # a bookmark
        discard scene.draw(config, "")
        snap("highlight-bookmark")
        var marks = scene.json("marks")
        if not marks.isNil and marks.hasKey(keys[1]):
          for m in marks[keys[1]]["list"]:
            if m["k"].getStr() == "h": m["n"] = %"Austen's narrator, at her driest: the whole plot in one line."
          scene.state["marks"] = marks
        snap("highlight-note")
        menuItem(0)
        discard scene.draw(config, "")
        snap("menu-back")
        scene.press("AI")
        discard scene.draw(config, "")
        snap("menu")
        setSpot(%*{"view": "contents", "tab": "toc", "lists": nil})
        snap("contents")
        setSpot(%*{"view": "contents", "tab": "marks", "lists": nil})
        snap("marks")
        scene.press("AI")
        snap("mark")
        setSpot(%*{"view": "book", "sheet": "type"})
        snap("text-and-layout")
        setSpot(%*{"prefs": {"size": 4, "spacing": 2, "margin": 2, "justify": true, "theme": "sepia", "status": "full", "columns": 0}, "sheet": nil, "pg": nil})
        snap("sepia-justified")
        setSpot(%*{"prefs": {"size": 6, "spacing": 1, "margin": 1, "justify": false, "theme": "dark", "status": "bar", "columns": 0}, "pg": nil})
        snap("dark")
        setSpot(%*{"prefs": {"size": 5, "spacing": 1, "margin": 1, "justify": false, "theme": "light", "status": "full", "columns": 0}, "pg": nil, "sheet": "goto", "gotoF": 0.62})
        snap("go-to")
        setSpot(%*{"sheet": nil, "view": "find", "lists": nil, "find": nil})
        discard scene.draw(config, "")
        if fields().len > 0:
          scene.tap(fields()[0])
          scene.typeIn("Darcy")
          discard scene.draw(config, "")
        setSpot(%*{"cmd": "find"})
        for i in 0 ..< 10:
          discard scene.draw(config, "")
        snap("find")
        setSpot(%*{"view": "stats", "notice": nil})
        snap("stats")
        setSpot(%*{"view": "catalog", "lists": nil})
        snap("catalogs")
        setSpot(%*{"view": "feed", "cat": {"kind": "pg", "topic": "", "title": "Most popular", "page": 1, "stack": []}, "lists": nil})
        snap("gutenberg")
        setSpot(%*{"view": "feed", "cat": {"kind": "atom", "url": "https://standardebooks.org/feeds/atom/new-releases", "title": "Standard Ebooks", "stack": []}, "lists": nil})
        snap("standard-ebooks")
        scene.press("AI")
        snap("entry")
        setSpot(%*{"view": "book", "book": keys[^1], "at": nil, "pg": nil, "sheet": "end"})
        snap("finished")
        if problems.len > 0: echo name, ": ", problems

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
        discard scene.draw(config, file.extractFilename & "-open")
        echo "  ", file.extractFilename, ": opened in ", int((epochTime() - started) * 1000), " ms"
        check scene.view == "book"
        var slowest = 0.0
        var turns = 0
        var chapters = 0
        var last = -1
        started = epochTime()
        while turns < 2000:
          let before = scene.at
          let t0 = epochTime()
          scene.press("DOWN")
          discard scene.draw(config, if turns < 30: file.extractFilename & "-page" else: "")
          slowest = max(slowest, epochTime() - t0)
          inc turns
          if scene.at[0] != last:
            inc chapters
            last = scene.at[0]
          if scene.at == before: break
        echo "  ", file.extractFilename, ": ", turns, " pages, ", chapters, " chapters, ",
          int((epochTime() - started) * 1000 / max(1, turns).float), " ms a page, slowest ",
          int(slowest * 1000), " ms"
        scene.send("keyDown", %*{"key": "Escape"})
        discard scene.draw(config, file.extractFilename & "-library")
        noProblems()

removeDir(assets)
