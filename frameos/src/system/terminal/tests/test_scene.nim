import std/[json, options, os, strutils]
import pixie
import frameos/channels
import frameos/types
import frameos/events_gen
import frameos/ui/events
import frameos/ui/layout
import system/sceneSwitcher/scene as switcher
import system/sceneSettings/scene as settings
import system/terminal/scene as terminal
import system/terminal/commands

# The terminal (docs/terminal.md): the ESP32 serial console's commands
# answered from the frame page's facts, refused where the frame's control plane
# turned settings on the screen off, and the scene that types them: the line
# with the keyboard, Enter, the commands typed before, and going back.
# FRAMEOS_TERMINAL_PREVIEWS=<dir> also writes the pictures.

var
  sent: seq[(string, JsonNode)]
  panelSent: seq[string] # device commands, origin `panel`
localEventSink = proc (scene: Option[SceneId], event: string, payload: JsonNode, origin: EventOrigin) {.gcsafe.} =
  {.cast(gcsafe).}:
    if origin == eoPanel:
      doAssert event in [evRender, evRestart, evReboot], "the panel sends what the frame page's buttons send"
      panelSent.add event
    else:
      doAssert origin == eoScene, "the terminal speaks as a scene otherwise"
      sent.add((event, payload))

sceneSwitcherListing = proc (): seq[SwitcherEntry] {.nimcall, gcsafe.} =
  @[SwitcherEntry(id: "scenes/weather", name: "Weather"), SwitcherEntry(id: "scenes/clock", name: "Clock")]

var
  facts: JsonNode = %*{"rotate": 0, "renderScale": 1.0, "version": "2026.11.8", "actions": ["restart"],
    "managedBy": "FrameOS backend",
    "wifi": {"state": "connected", "ssid": "Home", "ip": "10.0.0.5", "scanning": false, "networks": ["Home", "Cafe"]}}
  applied: seq[JsonNode]
  actions: seq[string]
proc readFacts(): JsonNode {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}: facts
settings.frameSettingsRead = readFacts
settings.frameSettingsApply = proc (changes: JsonNode) {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}: applied.add changes
settings.frameSettingsAction = proc (action: string) {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}: actions.add action

var logger = Logger(enabled: true)
logger.log = proc(payload: JsonNode) = discard

let frameConfig = FrameConfig(width: 800, height: 480, device: "framebuffer", scalingMode: "cover",
  timeZone: "Europe/Tallinn", frameHost: "kitchen.local", serverHost: "10.0.0.2", serverPort: 8989,
  serverScheme: "http", saveAssets: %*false)

proc said(line: string): seq[string] = run(line, frameConfig, "scenes/weather").lines

block words_split_as_the_console_splits_them:
  doAssert words("set wifi_ssid \"My Net\"") == @["set", "wifi_ssid", "My Net"]
  doAssert words("  wifi  Home\\ Net  pass ") == @["wifi", "Home Net", "pass"]
  doAssert words("") == newSeq[string]()

block help_and_status:
  let help = said("help")
  doAssert help[0].startsWith("help ")
  doAssert "status      Show device status" in help
  doAssert help[^1].startsWith("not on this frame: heapinfo, buttons")
  let status = said("status")
  doAssert "hostname:    kitchen.local" in status
  doAssert "wifi:        ssid=\"Home\" state=connected ip=10.0.0.5" in status
  doAssert "backend:     http://10.0.0.2:8989" in status
  doAssert "rotate:      0" in status
  doAssert "render_scale: 0 (automatic)" in status
  doAssert "frame_page:  offered" in status
  doAssert "time_zone:   Europe/Tallinn" in status
  doAssert "version:     2026.11.8" in status
  doAssert "scene:       scenes/weather" in status

block set_and_wifi_go_through_the_frame_pages_hooks:
  applied.setLen(0)
  doAssert said("set rotate 90") == @["ok: rotate set (some settings need `restart`)"]
  doAssert applied[^1] == %*{"rotate": 90}
  doAssert said("set rotate 45") == @["bad rotate value, want 0, 90, 180 or 270"]
  doAssert said("set render_scale 1.5")[0].startsWith("ok:")
  doAssert applied[^1] == %*{"renderScale": 1.5}
  doAssert said("set render_scale 9") == @["render_scale: 0 (automatic) to 4"]
  doAssert said("set wifi_pass hunter2")[0].startsWith("ok:")
  doAssert applied[^1] == %*{"wifiPassword": "hunter2"}
  doAssert said("wifi \"Cafe Net\" latte") == @["wifi credentials saved, joining Cafe Net (see status)"]
  doAssert applied[^1] == %*{"wifiSsid": "Cafe Net", "wifiPassword": "latte"}
  doAssert applied.len == 4, "nothing applied for what was refused"
  doAssert said("set debug 1") == @["set debug: not from this frame's screen; its control plane sets it here"]
  doAssert said("set nonsense 1") == @["unknown key \"nonsense\""]
  doAssert said("set rotate")[0].startsWith("usage: set")

block device_commands_speak_as_the_panel:
  panelSent.setLen(0)
  sent.setLen(0)
  doAssert said("render") == @["render triggered"]
  doAssert said("restart") == @["restarting FrameOS..."]
  doAssert said("reboot") == @["rebooting..."]
  doAssert panelSent == @[evRender, evRestart, evReboot]
  doAssert said("event render {}") == @["sent render {}"]
  doAssert said("event setCurrentScene {\"sceneId\": \"scenes/clock\"}") ==
    @["event refused: not one the console may send"]
  doAssert said("event nextPage") == @["event refused: not one the console may send"]
  doAssert said("event render [1]") == @["event: the payload is not a JSON object"]
  doAssert panelSent.len == 4
  doAssert sent.len == 0

block scenes_and_switching:
  sent.setLen(0)
  let scenes = said("scenes")
  doAssert scenes == @["scenes: 2 loaded", "* scenes/weather  Weather", "  scenes/clock  Clock"]
  let picked = run("scene scenes/clock", frameConfig, "scenes/weather")
  doAssert picked.lines == @["scene queued: scenes/clock"]
  doAssert picked.picked
  doAssert sent == @[(evSetCurrentScene, %*{"sceneId": "scenes/clock"})]
  doAssert said("scene scenes/nope") == @["scene select failed: no scene scenes/nope on this frame"]
  doAssert said("scene")[0] == "usage: scene <scene-id>"

block what_a_host_cannot_do_says_so:
  doAssert said("heapinfo") == @["heapinfo: not on this frame (an ESP32's serial console has it)"]
  doAssert said("factory-reset") == @["factory-reset: not on this frame (an ESP32's serial console has it)"]
  doAssert said("frobnicate now") == @["unknown command: frobnicate now"]

block wifi_scan_reports_when_done:
  actions.setLen(0)
  let scan = run("wifi-scan", frameConfig, "")
  doAssert scan.scanning and scan.lines == @["scanning..."]
  doAssert actions == @["scan"]
  doAssert scanDone()
  doAssert scanLines() == @["2 networks:", "  Home", "  Cafe"]

block a_locked_frame_refuses_what_changes_it:
  let kept = facts
  facts = nil # the control plane turned settings on the screen off
  applied.setLen(0)
  panelSent.setLen(0)
  sent.setLen(0)
  const locked = "refused: the frame's control plane has turned settings on its screen off"
  for line in ["set rotate 90", "wifi Home pass", "wifi-scan", "restart", "reboot", "event render"]:
    doAssert said(line) == @[locked], line
  doAssert applied.len == 0 and panelSent.len == 0
  # What changes nothing of the frame's settings stays: a render (a scene's,
  # not the panel's), the scene list, a switch, the status.
  doAssert said("render") == @["render triggered"]
  doAssert sent[^1][0] == evRender and panelSent.len == 0
  doAssert "frame_page:  off" in said("status")
  doAssert said("scenes")[0] == "scenes: 2 loaded"
  # A host with no frame page at all.
  settings.frameSettingsRead = nil
  doAssert said("set rotate 90") == @["this frame has no settings to change from its screen"]
  settings.frameSettingsRead = readFacts
  facts = kept

# ------------------------------------------------------------------ the scene

proc send(scene: FrameScene, event: string, payload: JsonNode) =
  terminal.exportedScene.runEvent(scene, ExecutionContext(scene: scene, event: event, payload: payload))

proc draw(scene: FrameScene): Image =
  terminal.exportedScene.render(scene, ExecutionContext(scene: scene, event: "render", payload: %*{},
    image: newImage(800, 480), hasImage: true))

proc key(name: string): JsonNode =
  %*{"key": name, "code": name, "repeat": false, "shift": false, "ctrl": false, "alt": false, "meta": false}

let previews = getEnv("FRAMEOS_TERMINAL_PREVIEWS")

block the_scene_types_a_line_and_answers:
  sent.setLen(0)
  let scene = TerminalScene(terminal.exportedScene.init(SceneTerminalId.SceneId, frameConfig, logger, %*{}))
  scene.send("setCurrentScene", %*{"sceneId": SceneTerminalId, "state": {
    "from": "scenes/weather", "values": {"city": "Oslo"}}})
  scene.send("open", %*{})
  discard scene.draw()
  let target = uiTarget(SceneTerminalId, 1, create = false)
  doAssert target.input.focus > 0, "the line has the keyboard from the start"
  doAssert not target.input.keyboard, "no keyboard on the screen until the line is tapped"
  scene.send("textInput", %*{"text": "scenes"})
  doAssert scene.typed == "scenes"
  scene.send("keyDown", key("Enter"))
  doAssert scene.typed == ""
  doAssert CommandMark & "scenes" in scene.lines
  doAssert "scenes: 2 loaded" in scene.lines
  doAssert target.input.focus > 0, "after Enter the next line is typed at once"
  # The scene's public values, as they were when it opened: no instance of
  # it beside the terminal on this host.
  scene.send("textInput", %*{"text": "scene_state"})
  scene.send("keyDown", key("Enter"))
  doAssert "  \"city\": \"Oslo\"" in scene.lines
  # The commands typed before, with ArrowUp, and a new line with ArrowDown.
  scene.send("keyDown", key("ArrowUp"))
  doAssert scene.typed == "scene_state"
  scene.send("keyDown", key("ArrowUp"))
  doAssert scene.typed == "scenes"
  scene.send("keyDown", key("ArrowDown"))
  scene.send("keyDown", key("ArrowDown"))
  doAssert scene.typed == ""
  # Escape lets the line go; the next key takes it again.
  scene.send("keyDown", key("Escape"))
  doAssert target.input.focus == 0
  scene.send("textInput", %*{"text": "h"})
  doAssert target.input.focus > 0 and scene.typed == "h"
  let image = scene.draw()
  if previews.len > 0:
    createDir(previews)
    image.writeFile(previews / "terminal.png")
  # A scene picked goes there and the terminal is done: opened again, afresh.
  scene.send("keyDown", key("Backspace"))
  doAssert scene.typed == ""
  scene.send("textInput", %*{"text": "scene scenes/clock"})
  sent.setLen(0)
  scene.send("keyDown", key("Enter"))
  doAssert sent.len > 0 and sent[0] == (evSetCurrentScene, %*{"sceneId": "scenes/clock"})
  builtInScenesStay = true
  scene.send("close", %*{})
  doAssert scene.lines.len == 1 and scene.history.len == 0, "went back by itself: it starts afresh"

block on_a_desktop_it_stays_open_while_another_window_has_the_focus:
  builtInScenesStay = true
  let scene = TerminalScene(terminal.exportedScene.init(SceneTerminalId.SceneId, frameConfig, logger, %*{}))
  scene.send("setCurrentScene", %*{"sceneId": SceneTerminalId, "state": {"from": "scenes/weather"}})
  scene.send("open", %*{})
  discard scene.draw()
  scene.send("textInput", %*{"text": "help"})
  scene.send("keyDown", key("Enter"))
  let said = scene.lines.len
  scene.send("close", %*{})
  doAssert scene.state{"away"}.getBool()
  doAssert scene.lines.len == said, "what it said stays"
  # Brought forward again by a switch that says nothing: as it was left.
  scene.send("setCurrentScene", %*{"sceneId": SceneTerminalId})
  scene.send("open", %*{})
  doAssert not scene.state.hasKey("away")
  doAssert scene.lines.len == said
  # The frame's back goes back where it was opened from.
  sent.setLen(0)
  scene.send("back", %*{})
  doAssert sent == @[(evTerminal, newJObject())]
  builtInScenesStay = false

block what_was_said_last_is_in_sight:
  let scene = TerminalScene(terminal.exportedScene.init(SceneTerminalId.SceneId, frameConfig, logger, %*{}))
  scene.send("setCurrentScene", %*{"sceneId": SceneTerminalId, "state": {"from": "scenes/weather"}})
  scene.send("open", %*{})
  discard scene.draw()
  for i in 0 ..< 3:
    scene.send("textInput", %*{"text": "help"})
    scene.send("keyDown", key("Enter"))
    discard scene.draw()
  # The box that scrolls is at its end, the line being typed in sight.
  let target = uiTarget(SceneTerminalId, 1, create = false)
  var atEnd = false
  for r in target.regions:
    if r.scrollY > 0:
      let (_, y) = target.input.scrolled(r.key)
      atEnd = y >= r.scrollY - 1
  doAssert atEnd, "the lines scroll to the last"
  doAssert target.input.focus > 0

block in_a_window_its_letters_keep_the_frames_size:
  # A window half the panel's size: the same letters (the line's field as tall),
  # and the lines a bigger window would show more of.
  let scene = TerminalScene(terminal.exportedScene.init(SceneTerminalId.SceneId, frameConfig, logger, %*{}))
  scene.send("setCurrentScene", %*{"sceneId": SceneTerminalId, "state": {"from": "scenes/weather"}})
  scene.send("open", %*{})
  proc lineHeight(width, height: int): float32 =
    discard terminal.exportedScene.render(scene, ExecutionContext(scene: scene, event: "render", payload: %*{},
      image: newImage(width, height), hasImage: true))
    for r in uiTarget(SceneTerminalId, 1, create = false).regions:
      if r.field == 1:
        return r.h
  let full = lineHeight(800, 480)
  doAssert full > 0
  doAssert lineHeight(400, 240) == full
  doAssert lineHeight(700, 300) == full

echo "terminal: ok"
