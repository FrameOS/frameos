## The Book highlights sample (repo/scenes/samples/Book highlights): the
## ePub reader's highlights (Books/Notes/Highlights.json) as full-screen
## quotes. The newest first, then one at a time when its time is up or a tap,
## a swipe, a key or a button asks; a highlight made since comes next; a long
## press opens the book at it in the scene that opens .epub files; a Kindle's
## My Clippings.txt beside them; e-paper, a tall panel; and what it says with
## none. FRAMEOS_HIGHLIGHT_SHOTS=<dir> writes each picture there.

import std/[json, os, strutils, times, unittest]
import pixie
import ../interpreter
import ../js_runtime/app_runtime
import ../scene_rhythm
import ../types
import ../channels

const Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"

let assets = getTempDir() / "frameos-book-highlights-" & $epochTime().int
let notes = assets / "Books" / "Notes"
createDir(notes)

const Day = 86400000
const T0 = 1795000000000

proc highlight(id, title, text: string, at: int64, note = "", author = "A. Writer", chapter = "One"): JsonNode =
  %*{"id": id, "book": "assets:Books/" & title & ".epub", "title": title, "author": author, "chapter": chapter,
    "text": text, "note": note, "at": at, "f": 0.5}

proc keep(highlights: seq[JsonNode]) =
  writeFile(notes / "Highlights.json", $(%*{"format": "frameos-highlights", "version": 1,
    "updated": "2026-11-28T12:00:00.000Z", "highlights": highlights}))

let three = @[
  highlight("walden", "Walden", "I went to the woods because I wished to live deliberately.", T0 + 3 * Day,
    note = "The reason for all of it.", author = "Henry David Thoreau"),
  highlight("emma", "Emma", "Silly things do cease to be silly if they are done by sensible people in an impudent way.",
    T0 + 2 * Day, author = "Jane Austen"),
  highlight("moby", "Moby-Dick", ("Whenever I find myself growing grim about the mouth; whenever it is a damp, " &
    "drizzly November in my soul; then, I account it high time to get to sea as soon as I can.\n" &
    "This is my substitute for pistol and ball."), T0 + Day, author = "Herman Melville"),
]

suite "the Book highlights scene":
  setup:
    rhythmClockOverride = 1000.0
    rhythmCanvasGeneration = proc(canvas: Image): int64 {.nimcall, raises: [].} = 0
    keep(three)

  var problems: seq[string]
  var logger = Logger(frameConfig: nil, enabled: true)
  logger.log = proc(payload: JsonNode) =
    if payload{"event"}.getStr().contains("error") or payload{"level"}.getStr() == "error":
      problems.add($payload)
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false

  proc frame(width, height: int, device = "framebuffer"): FrameConfig =
    FrameConfig(name: "highlights", mode: "rpios", device: device, width: width, height: height, rotate: 0,
      scalingMode: "cover", debug: false, settings: %*{}, renderScale: 1.0, saveAssets: %*false,
      assetsPath: assets)

  var shot = 0
  proc draw(scene: FrameScene, config: FrameConfig, name: string): Image =
    result = newImage(config.width, config.height)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: result,
      hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    result = render(scene, context)
    inc shot
    let dir = getEnv("FRAMEOS_HIGHLIGHT_SHOTS")
    if dir.len > 0 and name.len > 0:
      createDir(dir)
      result.writeFile(dir / ($shot & "-" & name & ".png"))
    rhythmClockOverride += 1.0

  proc send(scene: FrameScene, event: string, payload: JsonNode) =
    runEvent(scene, ExecutionContext(scene: scene, event: event, payload: payload, loopIndex: 0,
      loopKey: ".", nextSleep: -1))

  proc load(config: FrameConfig, state = %*{}): FrameScene =
    setUploadedInterpretedScenes(parseInterpretedScenes($(%*[parseFile(Samples / "Book highlights" /
      "scenes.json")[0]])))
    resetInterpretedScenes()
    logger.frameConfig = config
    init("book-highlights".SceneId, config, logger, state)

  proc spot(scene: FrameScene): JsonNode =
    let s = scene.state{"spot"}
    if s != nil and s.kind == JString: parseJson(s.getStr()) else: s

  proc showing(scene: FrameScene): string = scene.spot{"id"}.getStr()

  # Makes the quote showing an hour old: its time is up.
  proc age(scene: FrameScene) =
    var s = scene.spot
    s["t"] = %((epochTime() - 3601) * 1000)
    scene.state["spot"] = s

  proc inked(image: Image, x0, x1, y0, y1: int, dark: bool): int =
    for y in countup(y0, y1 - 1, 2):
      for x in countup(x0, x1 - 1, 2):
        let p = image[x, y]
        let luma = (p.r.int * 3 + p.g.int * 6 + p.b.int) div 10
        if (dark and luma < 90) or (not dark and luma > 200): inc result

  proc noProblems() =
    check problems.len == 0
    if problems.len > 0: echo problems

  test "is the Book highlights scene, a sample with an icon and a category, that only reads files":
    let scene = parseFile(Samples / "Book highlights" / "scenes.json")[0]
    check scene["id"].getStr() == "book-highlights"
    check scene["settings"]["icon"].getStr().len > 0
    check scene["settings"]["category"].getStr() == "Notes & tools"
    let meta = parseFile(Samples / "Book highlights" / "template.json")
    check meta["name"].getStr() == "Book highlights"
    check meta["imageWidth"].getInt() == 800 and meta["imageHeight"].getInt() == 600
    check fileExists(Samples / "Book highlights" / "image.jpg")
    let config = parseJson(scene["apps"]["highlights"]["sources"]["config.json"].getStr())
    check config["permissions"] == %*["assets"]
    var names: seq[string]
    var interval: JsonNode
    for field in scene["fields"]:
      names.add field["name"].getStr()
      if field{"role"}.getStr() == "refreshInterval": interval = field
    for name in ["folder", "order", "interval", "look", "typeface", "notes", "clippings", "fullScreen", "spot"]:
      check name in names
    check interval{"name"}.getStr() == "interval"

  test "shows the newest highlight first, as big as it fits, with its book":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    let image = scene.draw(config, "newest")
    check scene.showing == "walden"
    check scene.spot{"book"}.getStr() == "assets:Books/Walden.epub"
    check image[4, 4] == rgbx(0xf7, 0xf3, 0xea, 255)
    # A short quote set big: ink across most of the width, above the middle.
    check image.inked(0, 800, 0, 240, true) > 400
    check image.inked(0, 200, 60, 240, true) > 10
    check image.inked(600, 800, 60, 240, true) > 10
    noProblems()

  test "stays until its time is up, then goes on: a tap, a swipe, the keys and the buttons too, and back":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    discard scene.draw(config, "")
    let first = scene.showing
    discard scene.draw(config, "")
    check scene.showing == first
    scene.age()
    discard scene.draw(config, "due")
    let second = scene.showing
    check second != first
    var seen = @[first, second]
    scene.send("tap", %*{"x": 400, "y": 240, "pointerId": 0, "pointerType": "touch"})
    discard scene.draw(config, "tapped")
    check scene.showing notin seen
    seen.add scene.showing
    check seen.len == 3
    # Back, by the frame's back, a key, a swipe to the right: the way it came.
    scene.send("back", %*{})
    discard scene.draw(config, "")
    check scene.showing == seen[1]
    scene.send("keyDown", %*{"key": "ArrowLeft", "code": "ArrowLeft"})
    discard scene.draw(config, "")
    check scene.showing == seen[0]
    scene.send("button", %*{"pin": 5, "label": "DOWN", "role": "next", "action": "press"})
    discard scene.draw(config, "")
    check scene.showing == seen[1]
    scene.send("swipe", %*{"direction": "left", "x": 600, "y": 240, "startX": 700, "startY": 240,
      "pointerId": 0, "pointerType": "touch"})
    discard scene.draw(config, "")
    check scene.showing == seen[2]
    scene.send("swipe", %*{"direction": "right", "x": 700, "y": 240, "startX": 600, "startY": 240,
      "pointerId": 0, "pointerType": "touch"})
    discard scene.draw(config, "")
    check scene.showing == seen[1]
    noProblems()

  test "a highlight made since comes next, and one taken away gives way":
    problems = @[]
    let config = frame(800, 480)
    let scene = load(config)
    discard scene.draw(config, "")
    check scene.showing == "walden"
    keep(three & @[highlight("frank", "Frankenstein", "Beware; for I am fearless, and therefore powerful.", T0 + 4 * Day)])
    scene.age()
    discard scene.draw(config, "made-since")
    check scene.showing == "frank"
    keep(three)
    discard scene.draw(config, "taken-away")
    check scene.showing in ["walden", "emma", "moby"]
    noProblems()

  test "a long press opens the book at it in the scene that opens .epub files, or says to install one":
    problems = @[]
    proc sent(): seq[JsonNode] =
      while true:
        let (ok, message) = eventChannel.tryRecv()
        if not ok: break
        if message[1] == "setCurrentScene": result.add message[2]
    discard sent()
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      {.cast(gcsafe).}:
        result = %*[{"id": "book-highlights", "name": "Book highlights"},
          {"id": "my-reader", "name": "ePub reader", "opens": "epub"}]
    defer: windowSceneListing = nil
    let config = frame(800, 480)
    let scene = load(config)
    discard scene.draw(config, "")
    scene.send("longPress", %*{"x": 400, "y": 240, "durationMs": 600, "pointerId": 0, "pointerType": "touch"})
    var asked = sent()
    check asked.len == 1
    if asked.len == 1:
      check asked[0]{"sceneId"}.getStr() == "my-reader"
      check asked[0]{"state"}{"file"}.getStr() == "assets:Books/Walden.epub"
      check asked[0]{"state"}{"mark"}.getStr() == "walden"
    # The Action key too.
    scene.send("button", %*{"pin": 5, "label": "OK", "role": "primary", "action": "press"})
    check sent().len == 1
    # No reader on the frame: a line under the quote says so, once.
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      {.cast(gcsafe).}:
        result = %*[{"id": "book-highlights", "name": "Book highlights"}]
    scene.send("longPress", %*{"x": 400, "y": 240, "durationMs": 600, "pointerId": 0, "pointerType": "touch"})
    check sent().len == 0
    check scene.spot{"notice"}.getStr().contains("ePub reader")
    discard scene.draw(config, "no-reader")
    check scene.spot{"notice"}.isNil
    check scene.showing == "walden"
    noProblems()

  test "a Kindle's My Clippings.txt beside them, the passage both have once":
    problems = @[]
    writeFile(assets / "Books" / "My Clippings.txt", ("﻿Walden (Henry David Thoreau)\r\n" &
      "- Your Highlight on page 4 | Location 88-90 | Added on Tuesday, March 3, 2020 7:02:00 AM\r\n\r\n" &
      "I went to the woods because I wished to live deliberately.\r\n==========\r\n" &
      "The Odyssey (Homer)\r\n" &
      "- Your Highlight on page 12 | Location 140-141 | Added on Wednesday, March 4, 2020 9:00:00 PM\r\n\r\n" &
      "Of all creatures that breathe and move upon the earth, nothing is bred that is weaker than man.\r\n" &
      "==========\r\n"))
    let config = frame(800, 480)
    let scene = load(config, %*{"clippings": "Books/My Clippings.txt", "order": "book"})
    var titles: seq[string]
    discard scene.draw(config, "")
    for i in 0 ..< 5:
      titles.add scene.showing
      scene.send("forward", %*{})
      discard scene.draw(config, "clippings")
    check "walden" in titles and "emma" in titles and "moby" in titles
    var kindle = 0
    for id in titles:
      if id.startsWith("k"): inc kindle
    check kindle >= 1
    # Four in all: Walden is the reader's, once.
    check titles[4] == titles[0]
    removeFile(assets / "Books" / "My Clippings.txt")
    noProblems()

  test "e-paper is black on white, the dark look white on black, a tall panel, a long passage":
    problems = @[]
    let paper = frame(800, 480, "waveshare.EPD_7in5_V2")
    var scene = load(paper)
    let light = scene.draw(paper, "paper")
    check light[4, 4] == rgbx(255, 255, 255, 255)
    check light.inked(0, 800, 0, 480, true) > 300
    scene = load(paper, %*{"look": "dark"})
    let dark = scene.draw(paper, "paper-dark")
    check dark[4, 4] == rgbx(0, 0, 0, 255)
    check dark.inked(0, 800, 0, 480, false) > 300
    let tall = frame(480, 800)
    scene = load(tall, %*{"order": "newest"})
    discard scene.draw(tall, "")
    scene.send("tap", %*{"x": 240, "y": 400, "pointerId": 0, "pointerType": "touch"})
    scene.send("tap", %*{"x": 240, "y": 400, "pointerId": 0, "pointerType": "touch"})
    let long = scene.draw(tall, "tall-long")
    check scene.showing == "moby"
    check long.inked(0, 480, 0, 400, true) > 200
    noProblems()

  test "with none, says how to make one, and where it looks":
    problems = @[]
    removeFile(notes / "Highlights.json")
    let config = frame(800, 480)
    let scene = load(config)
    let image = scene.draw(config, "none")
    check scene.spot{"id"}.isNil
    check image.inked(0, 800, 0, 480, true) > 100
    noProblems()
