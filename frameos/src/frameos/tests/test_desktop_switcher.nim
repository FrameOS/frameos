## Every desktop's "all scenes" window: the built-in scene switcher
## (system/sceneSwitcher, docs/scene-switcher.md "The tiles"), which each
## desktop of windows opens as its Programs, Launchpad or Scenes window, drawn
## in that desktop's theme. The tiles keep one size whatever the panel or the
## window, and a bigger one shows more of them; a Pi shows each scene's last
## snapshot, an ESP32 and the browser its icon. FRAMEOS_DESKTOP_SHOTS=<dir>
## writes each desktop's window there, small and large.

import std/[json, os, strutils, tables, unittest]
import pixie
import ../channels
import ../events
import ../interpreter
import ../scene_rhythm
import ../types
import ../js_runtime/app_runtime
import ../layout_choice
import system/sceneSwitcher/scene as switcher

const Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"

# (the sample, its id) for every desktop of windows: all of them open the
# switcher as their window of every scene.
const Desktops = [("Windows 98 layout", "layout-windows-98"), ("Tiling layout", "layout-tiling"),
  ("macOS layout", "layout-macos"), ("BeOS layout", "layout-beos"), ("Classic Mac layout", "layout-classic-mac"),
  ("NeXTSTEP layout", "layout-nextstep"), ("OS2 Warp layout", "layout-os2-warp"),
  ("Omarchy layout", "layout-omarchy"), ("Commander layout", "layout-commander")]

# Eighteen of the repo's samples, as the frame lists them: their names, icons
# and categories.
const Picked = ["Analog clock face", "Word clock", "Pomodoro", "Calendar", "Day agenda", "Weather",
  "Google Photos", "Unsplash image", "Gallery", "Cuteness Overload", "2048", "Solitaire", "Sudoku", "Snake",
  "To-do", "Sketchbook", "Chart", "Counter"]

proc picked(): seq[SwitcherEntry] =
  for name in Picked:
    let path = Samples / name / "scenes.json"
    if not fileExists(path): continue
    let scene = parseFile(path)[0]
    result.add SwitcherEntry(id: "tests/" & name, name: scene{"name"}.getStr(name),
      icon: scene{"settings", "icon"}.getStr(""), category: scene{"settings", "category"}.getStr(""))

var entries = picked()
sceneSwitcherListing = proc(): seq[SwitcherEntry] {.nimcall, gcsafe.} =
  {.cast(gcsafe).}:
    entries

proc samplePicture(frameConfig: FrameConfig, sceneId: string, width, height: int): Image {.nimcall, gcsafe.} =
  ## A Pi's last snapshot of the scene: the sample's own picture, at the size asked.
  {.cast(gcsafe).}:
    let path = Samples / sceneId.split('/', 1)[1] / "image.jpg"
    if not fileExists(path): return nil
    try:
      result = readImage(path).resize(width, height)
    except CatchableError:
      result = nil

proc panel(id, hex, layout: string): JsonNode =
  %*{"id": id, "name": id, "settings": {"execution": "interpreted", "refreshInterval": 600,
      "backgroundColor": "#000000"},
    "fields": [], "apps": {}, "layout": {"sceneId": layout},
    "nodes": [{"id": "1", "type": "event", "data": {"keyword": "render"}},
      {"id": "2", "type": "app", "data": {"keyword": "render/color", "config": {"color": hex}}}],
    "edges": [{"id": "1", "source": "1", "sourceHandle": "next", "target": "2", "targetHandle": "prev"}]}

var scenes = newJArray()
for (folder, id) in Desktops:
  scenes.add parseFile(Samples / folder / "scenes.json")[0]
  scenes.add panel("tests/red-" & id, "#ff0000", id)
# The listed scenes themselves, for a desktop that draws them (Commander's panels).
for i, entry in entries:
  var scene = panel(entry.id, ["#0ea5e9", "#f59e0b", "#22c55e", "#a855f7"][i mod 4], "")
  scene.delete("layout")
  scenes.add scene
setUploadedInterpretedScenes(parseInterpretedScenes($scenes))
resetInterpretedScenes()

var problems: seq[string]
proc logger(config: FrameConfig): Logger =
  var l = Logger(frameConfig: config, enabled: true)
  l.log = proc(payload: JsonNode) =
    {.cast(gcsafe).}:
      if payload{"event"}.getStr().contains("error"):
        problems.add($payload)
  l.enable = proc() = l.enabled = true
  l.disable = proc() = l.enabled = false
  l

var
  config: FrameConfig
  hosted = initTable[string, FrameScene]()
  parked: FrameScene
  current: FrameScene
  clock = 1000.0

proc hostScene(id: string): FrameScene =
  result = hosted.getOrDefault(id, nil)
  if result.isNil:
    result =
      if id == SceneSwitcherId: switcher.exportedScene.init(id.SceneId, config, logger(config), %*{})
      else: init(id.SceneId, config, logger(config), %*{})
    hosted[id] = result

hostSceneFor = proc(sceneId: SceneId): FrameScene {.closure, gcsafe.} =
  {.cast(gcsafe).}:
    hostScene(sceneId.string)
takeParkedLayout = proc(layoutId: string): FrameScene {.nimcall.} =
  {.cast(gcsafe).}:
    if not parked.isNil and parked.id.string == layoutId:
      result = parked
      parked = nil

proc pass(): Image =
  clock += 0.01
  rhythmClockOverride = clock
  let context = ExecutionContext(scene: current, event: "render", payload: %*{},
    image: newImage(config.width, config.height), hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
  render(current, context)

proc switchTo(id: string) =
  ## A switch as the runner does it: the layout carried over to the next scene.
  parked = current.wornLayout
  current.wornLayout = nil
  current = hostScene(id)
  wearLayout(current)

proc settle() =
  ## The scene switches the desktop asks for (its windows' focus).
  while true:
    let (ok, message) = eventChannel.tryRecv()
    if not ok: break
    let next = message[2]{"sceneId"}.getStr()
    if message[1] == "setCurrentScene" and next.len > 0 and next != current.id.string:
      switchTo(next)

let shots = getEnv("FRAMEOS_DESKTOP_SHOTS")

suite "every desktop's window of every scene (the switcher)":
  test "opens in each desktop's look, its tiles one size, small and large":
    windowSceneListing = proc(): JsonNode {.closure, gcsafe.} =
      {.cast(gcsafe).}:
        result = newJArray()
        for entry in entries: result.add %*{"id": entry.id, "name": entry.name, "icon": entry.icon,
          "category": entry.category}
    for (width, height, pictures) in [(800, 480, false), (1280, 800, true)]:
      config = FrameConfig(name: "desktop", mode: "rpios", device: "framebuffer", width: width, height: height,
        rotate: 0, scalingMode: "cover", debug: false, settings: %*{}, saveAssets: %*false,
        assetsPath: getTempDir() / "frameos-desktop-switcher-test")
      sceneSwitcherThumbnail = if pictures: samplePicture else: nil
      for (folder, layoutId) in Desktops:
        checkpoint folder & " " & $width
        problems = @[]
        hosted.clear()
        parked = nil
        chooseLayout(layoutId)
        current = hostScene("tests/red-" & layoutId)
        wearLayout(current)
        discard pass()
        settle()
        # Opened as the desktops open it: the switcher, the frame's scene.
        switchTo(SceneSwitcherId)
        var image: Image
        for _ in 0 ..< 3:
          image = pass()
          settle()
        check current.id.string == SceneSwitcherId
        if shots.len > 0:
          createDir(shots)
          image.writeFile(shots / ("switcher-" & layoutId.replace("layout-", "") & "-" & $width & "x" & $height & ".png"))
        check problems.len == 0
        if problems.len > 0: echo problems
    chooseLayout("")
    sceneSwitcherThumbnail = nil
