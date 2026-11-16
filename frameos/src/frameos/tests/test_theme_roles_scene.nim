## The Theme roles sample (repo/scenes/samples/Theme roles): every role of a
## desktop's theme, in FrameOS's own look full screen and in each desktop
## sample's looks (docs/jsx-ui.md "Themes"), its controls live.
##
## FRAMEOS_THEME_SHOTS=<dir> writes one picture per theme there: the gallery
## in a window of the desktop that gives that theme, for the docs and a PR.
## The themes are the desktop samples' own (their `look` field), never a copy.

import std/[json, os, strutils, unittest]
import pixie
import ../interpreter
import ../scene_rhythm
import ../types
import ../ui/events
import ../ui/layout

const
  Samples = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / "repo" / "scenes" / "samples"
  Id = "theme-roles"
  Own = rgbx(0x09, 0x09, 0x0b, 255) # the page in FrameOS's look, bg-zinc-950

  # (file name, desktop sample, its id, its look field's value)
  Themes = [
    ("windows-standard", "Windows 98 layout", "layout-windows-98", "standard"),
    ("macos-light", "macOS layout", "layout-macos", "light"),
    ("macos-dark", "macOS layout", "layout-macos", "dark"),
    ("beos", "BeOS layout", "layout-beos", "beos"),
    ("classic-mac", "Classic Mac layout", "layout-classic-mac", "classic"),
    ("nextstep", "NeXTSTEP layout", "layout-nextstep", "nextstep"),
    ("commander", "Commander layout", "layout-commander", "commander"),
    ("high-contrast", "Windows 98 layout", "layout-windows-98", "contrast"),
    ("frameos", "Windows 98 layout", "layout-windows-98", "frameos"),
  ]

suite "the Theme roles scene":
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

  proc frame(width, height: int): FrameConfig =
    FrameConfig(name: "roles", mode: "rpios", device: "framebuffer", width: width, height: height, rotate: 0,
      scalingMode: "cover", debug: false, settings: %*{}, renderScale: 1.0, saveAssets: %*false,
      assetsPath: getTempDir())

  proc draw(scene: FrameScene, config: FrameConfig): Image =
    result = newImage(config.width, config.height)
    let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, image: result,
      hasImage: true, loopIndex: 0, loopKey: ".", nextSleep: -1)
    result = render(scene, context)
    rhythmClockOverride += 1.0

  proc send(scene: FrameScene, event: string, payload: JsonNode) =
    runEvent(scene, ExecutionContext(scene: scene, event: event, payload: payload, loopIndex: 0,
      loopKey: ".", nextSleep: -1))

  proc gallery(): JsonNode = parseFile(Samples / "Theme roles" / "scenes.json")[0]

  proc load(config: FrameConfig, scenes: JsonNode): FrameScene =
    setUploadedInterpretedScenes(parseInterpretedScenes($scenes))
    resetInterpretedScenes()
    logger.frameConfig = config
    init(Id.SceneId, config, logger, %*{})

  proc count(image: Image, color: ColorRGBX): int =
    for y in 0 ..< image.height:
      for x in 0 ..< image.width:
        if image[x, y] == color: inc result

  proc target(): UiTarget =
    for node in 0 .. 64:
      result = uiTarget(Id, node, create = false)
      if not result.isNil: return

  test "draws every role, in FrameOS's look full screen, and its controls answer":
    problems = @[]
    let config = frame(800, 600)
    let scene = load(config, %*[gallery()])
    let image = scene.draw(config)
    check count(image, Own) > 800 * 600 div 3
    # Every role's name is in the app's words.
    let source = gallery()["apps"]["themeRoles"]["sources"]["app.tsx"].getStr()
    for role in ["page", "bar", "button", "primary", "selected", "field", "option", "picked", "switch",
        "switchOn", "knob", "knobOn", "muted", "accent", "card", "tile", "tileLit", "keyboard", "key",
        "keyMod", "keyLit"]:
      check ("look=\"" & role & "\"") in source or ("'" & role & "'") in source
    # Tap everything that listens, in turn, and the gallery hears each.
    let ui = target()
    check not ui.isNil
    var taps: seq[(float32, float32)]
    var fieldAt = (-1'f32, -1'f32)
    for r in ui.regions:
      if r.field > 0: fieldAt = (r.x + r.w / 2 + ui.offsetX, r.y + r.h / 2 + ui.offsetY)
      elif r.handlers[ueClick] > 0: taps.add((r.x + r.w / 2 + ui.offsetX, r.y + r.h / 2 + ui.offsetY))
    check taps.len >= 12
    for (x, y) in taps:
      scene.send("tap", %*{"x": x, "y": y, "pointerId": 0, "pointerType": "touch"})
      discard scene.draw(config)
    let kept = scene.state{"gallery"}
    checkpoint $kept
    check kept{"presses"}.getInt() >= 1 and kept{"saves"}.getInt() >= 1
    check kept{"on"}.getBool()
    for key in ["day", "picked", "tile", "key"]:
      check kept{key}.getStr().len > 0
    # The field types.
    check fieldAt[0] >= 0
    scene.send("tap", %*{"x": fieldAt[0], "y": fieldAt[1], "pointerId": 0, "pointerType": "touch"})
    scene.send("textInput", %*{"text": "Hi"})
    check scene.state{"gallery"}{"text"}.getStr() == "Hi"
    check problems.len == 0
    if problems.len > 0: echo problems

  test "in each desktop it wears that desktop's theme":
    problems = @[]
    let config = frame(1024, 720)
    let shots = getEnv("FRAMEOS_THEME_SHOTS")
    if shots.len > 0: createDir(shots)
    var pictures: seq[Image]
    for (name, folder, id, look) in Themes:
      var scene = gallery()
      scene["layout"] = %*{"sceneId": id, "state": {"look": look}}
      let frameScene = load(config, %*[scene, parseFile(Samples / folder / "scenes.json")[0]])
      var image: Image
      for i in 0 ..< 3:
        image = frameScene.draw(config)
      checkpoint name
      if look == "frameos":
        check count(image, Own) > 1024 * 720 div 4 # the desktop's FrameOS look is the gallery's own
      else:
        check count(image, Own) < 1024 * 720 div 50
      for other in pictures:
        check other.data != image.data
      pictures.add image
      if shots.len > 0:
        image.writeFile(shots / (name & ".png"))
    if shots.len > 0:
      let alone = load(config, %*[gallery()]).draw(config)
      alone.writeFile(shots / "full-screen.png")
    check problems.len == 0
    if problems.len > 0: echo problems
