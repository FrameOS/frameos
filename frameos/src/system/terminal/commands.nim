## The terminal's commands (docs/terminal.md): the language of an ESP32's
## serial console (embedded/esp32/main/fos_console.c) typed on the frame's own
## screen, answered from what this host knows. The same command names,
## arguments and answer lines where the host has the fact; a command it cannot
## do says so in plain words.
##
## What it knows comes from where the frame page's does (system/sceneSettings:
## `frameSettingsRead` / `Apply` / `Action`, each host's own), the scene list
## (`sceneSwitcherListing`) and the frame's config. What changes the frame goes
## where the frame page's buttons go: a setting through `frameSettingsApply`, a
## device command through the one dispatcher from the origin `panel`. When the
## frame's control plane has turned settings on the screen off, the host reads
## no facts and those are refused, as the page is not offered.
##
## No scene reaches any of this: the terminal is a built-in scene, and nothing
## here is offered to an app.

import std/[json, strutils]
import frameos/types
import frameos/channels
import frameos/events
import frameos/events_gen
import frameos/render_scale
from frameos/interpreter import hostSceneFor
import system/sceneSwitcher/scene as switcher
import system/sceneSettings/scene as settings

type
  Outcome* = object
    ## What a command line did: the lines it answered, and what the terminal
    ## does next.
    lines*: seq[string]
    picked*: bool   ## a scene was picked: the terminal goes back, as the switcher does
    scanning*: bool ## a Wi-Fi scan started: its networks come in later

const
  Prompt* = "frameos>"
  ## The help of every command this host runs, the ESP32's words where it
  ## has the command (its `register_frameos_console_commands`).
  Here = [
    ("help", "Print the list of registered commands"),
    ("status", "Show device status"),
    ("set", "set <key> <value>: persist a config value (rotate, render_scale, wifi_ssid, wifi_pass)"),
    ("wifi", "wifi <ssid> [pass]: set Wi-Fi and join it"),
    ("wifi-scan", "Scan visible Wi-Fi networks"),
    ("render", "Render now"),
    ("event", "event <name> [json]: send an event by hand (render, restart, reboot)"),
    ("scenes", "Show the frame's scenes"),
    ("scene_state", "Show the scene's public state JSON"),
    ("scene", "scene <id>: select a scene and render"),
    ("restart", "Restart FrameOS"),
    ("reboot", "Reboot the device"),
  ]
  ## The ESP32's commands about its own chips, buses and flash: nothing to ask
  ## of a Pi or a browser.
  EspOnly = ["heapinfo", "buttons", "beep", "led", "i2c", "touch", "lcd", "mic", "display_test", "sd",
    "usb_api", "factory-reset", "ota"]
  ## The keys the ESP32's `set` takes (fos_console.c cmd_set) that are not one
  ## of the four here: the frame's control plane sets those on this frame.
  EspKeys = ["backend", "api_key", "cloud_url", "claim_token", "frame_id", "hostname", "cloud_wsurl",
    "hardware", "panel", "render_mode", "scaling_mode", "frame_settings_on_screen", "settings_unlock",
    "time_zone", "interval", "max_http_response_bytes", "spill_force", "debug", "fusion",
    "server_send_logs", "allow_local_network", "admin_auth", "admin_user", "admin_pass", "tls_enable",
    "tls_port", "assets_path", "assets_sd", "assets_sd_pins", "assets_sd_freq", "assets_sd_autoformat",
    "deep_sleep", "deep_sleep_on_battery", "wake_check", "awake_input", "wake_schedule", "battery_pin",
    "battery_divider", "battery_enable_pin", "buzzer_pin", "buzzer_tone_hz", "touch_beep", "mic_pins",
    "voice_chat", "cpu_mode", "led_pin", "led_type", "i2c_buses", "touch_pins", "codec_pins", "pins",
    "gpio_buttons", "ap_psk"]
  NoPage = "this frame has no settings to change from its screen"
  Locked = "refused: the frame's control plane has turned settings on its screen off"

# ------------------------------------------------------------------ reading

proc words*(line: string): seq[string] =
  ## The line split as esp_console splits it: at spaces, a "quoted part" one
  ## word, a backslash taking the next character as it is.
  var
    word = ""
    quoted, started, escaped = false
  for c in line:
    if escaped:
      word.add c
      escaped = false
    elif c == '\\':
      escaped = true
      started = true
    elif c == '"':
      quoted = not quoted
      started = true
    elif c in Whitespace and not quoted:
      if started:
        result.add word
        word = ""
        started = false
    else:
      word.add c
      started = true
  if started:
    result.add word

proc facts(): JsonNode =
  ## The frame page's facts (sceneSettings' `frameSettingsRead`); nil when the
  ## host has none or the frame's control plane turned the page off.
  if not settings.frameSettingsRead.isNil:
    result = settings.frameSettingsRead()
    if not result.isNil and result.kind != JObject:
      result = nil

proc refusal(info: JsonNode): string =
  ## Why nothing may change from here; "" when it may.
  if settings.frameSettingsRead.isNil or settings.frameSettingsApply.isNil: NoPage
  elif info.isNil: Locked
  else: ""

proc number(value: float): string =
  ## A number as C's %g prints one: 1, 1.5.
  if value == value.int.float: $value.int else: $value

proc label(key: string): string =
  ## `key:` padded as fos_console.c's status lines are.
  result = key & ":"
  while result.len < 13:
    result.add ' '
  if result[^1] != ' ':
    result.add ' '

proc arrayOf(node: JsonNode): seq[JsonNode] =
  if not node.isNil and node.kind == JArray: node.elems else: @[]

proc wifiFacts(info: JsonNode): JsonNode =
  result = if info.isNil: nil else: info{"wifi"}
  if not result.isNil and result.kind != JObject:
    result = nil

proc networkLines*(info: JsonNode): seq[string] =
  ## What the last scan saw, one network a line.
  let networks = arrayOf(info.wifiFacts(){"networks"})
  if networks.len == 0:
    return @["no networks found"]
  result.add $networks.len & " networks:"
  for network in networks:
    result.add "  " & network.getStr()

proc scanDone*(): bool =
  ## The scan a `wifi-scan` started has come back (or the page went away).
  let wifi = facts().wifiFacts()
  wifi.isNil or not wifi{"scanning"}.getBool()

proc scanLines*(): seq[string] =
  networkLines(facts())

# ------------------------------------------------------------------ the commands

proc helpLines(): seq[string] =
  for (name, help) in Here:
    var line = name
    while line.len < 12:
      line.add ' '
    result.add line & help
  result.add "not on this frame: " & EspOnly.join(", ")

proc statusLines(config: FrameConfig, opener: string): seq[string] =
  let info = facts()
  if not config.isNil and config.frameHost.len > 0:
    result.add label("hostname") & config.frameHost
  let wifi = info.wifiFacts()
  if not wifi.isNil:
    var line = label("wifi") & "ssid=\"" & wifi{"ssid"}.getStr() & "\" state=" & wifi{"state"}.getStr()
    if wifi{"ip"}.getStr().len > 0:
      line.add " ip=" & wifi{"ip"}.getStr()
    let rssi = wifi{"rssi"}
    if not rssi.isNil and rssi.kind == JInt:
      line.add " rssi=" & $rssi.getInt()
    result.add line
  if not config.isNil:
    result.add label("backend") & (if config.serverHost.len == 0: "(unset)"
      else: config.serverScheme & "://" & config.serverHost & ":" & $config.serverPort)
  let manager = if info.isNil: "" else: info{"managedBy"}.getStr()
  if manager.len > 0:
    result.add label("managed_by") & manager
  if not config.isNil:
    result.add label("panel") & config.device & " (" & $config.width & "x" & $config.height & ")"
    result.add label("rotate") & $config.rotate
    result.add label("scaling_mode") & config.scalingMode
    result.add label("render_scale") & number(config.renderScale) &
      (if config.renderScale == 0: " (automatic)" else: "")
  result.add label("frame_page") & (if info.isNil: "off" else: "offered")
  if not config.isNil:
    result.add label("time_zone") & (if config.timeZone.len > 0: config.timeZone else: "(UTC)")
    result.add label("debug") & (if config.debug: "1" else: "0")
  let battery = if info.isNil: nil else: info{"battery", "percent"}
  result.add label("battery") & (if not battery.isNil and battery.kind == JInt: $battery.getInt() & "%"
    else: "not configured")
  var scenes = 0
  if not switcher.sceneSwitcherListing.isNil:
    try: scenes = switcher.sceneSwitcherListing().len except Exception: discard
  if not config.isNil:
    result.add label("nim") & "nim " & NimVersion & " + pixie + quickjs, " & $config.width & "x" &
      $config.height & ", scenes=" & $scenes
  if not info.isNil and info{"version"}.getStr().len > 0:
    result.add label("version") & info{"version"}.getStr()
  if opener.len > 0:
    result.add label("scene") & opener
  if not info.isNil and info{"note"}.getStr().len > 0:
    result.add label("note") & info{"note"}.getStr()

proc apply(changes: JsonNode) =
  if not settings.frameSettingsApply.isNil:
    settings.frameSettingsApply(changes)

proc setLines(args: seq[string]): seq[string] =
  if args.len < 3:
    return @["usage: set <rotate|render_scale|wifi_ssid|wifi_pass> <value...>"]
  let
    key = args[1]
    value = args[2 .. ^1].join(" ")
  if key notin ["rotate", "render_scale", "wifi_ssid", "wifi_pass"]:
    if key in EspKeys:
      return @["set " & key & ": not from this frame's screen; its control plane sets it here"]
    return @["unknown key \"" & key & "\""]
  let info = facts()
  let why = refusal(info)
  if why.len > 0:
    return @[why]
  case key
  of "rotate":
    var rotate = -1
    try: rotate = parseInt(value) except ValueError: discard
    if rotate notin [0, 90, 180, 270]:
      return @["bad rotate value, want 0, 90, 180 or 270"]
    apply(%*{"rotate": rotate})
  of "render_scale":
    var scale = -1.0
    try: scale = parseFloat(value) except ValueError: discard
    if scale < 0 or scale > MaxRenderScale:
      return @["render_scale: 0 (automatic) to 4"]
    apply(%*{"renderScale": scale})
  else:
    if info.wifiFacts().isNil:
      return @["set " & key & ": this frame has no Wi-Fi to set here"]
    apply(if key == "wifi_ssid": %*{"wifiSsid": value} else: %*{"wifiPassword": value})
  @["ok: " & key & " set (some settings need `restart`)"]

proc wifiLines(args: seq[string]): seq[string] =
  if args.len < 2:
    return @["usage: wifi <ssid> [password]"]
  let info = facts()
  let why = refusal(info)
  if why.len > 0:
    return @[why]
  if info.wifiFacts().isNil:
    return @["wifi: this frame has no Wi-Fi to set here"]
  apply(%*{"wifiSsid": args[1], "wifiPassword": if args.len > 2: args[2] else: ""})
  @["wifi credentials saved, joining " & args[1] & " (see status)"]

proc sceneLines(opener: string): seq[string] =
  var entries: seq[SwitcherEntry]
  if not switcher.sceneSwitcherListing.isNil:
    try: entries = switcher.sceneSwitcherListing() except Exception: discard
  result.add "scenes: " & $entries.len & " loaded"
  for entry in entries:
    result.add (if entry.id == opener: "* " else: "  ") & entry.id & "  " & entry.name

proc stateLines(opener: string, captured: JsonNode): seq[string] =
  ## The public state of the scene the terminal was opened from: the host's
  ## instance where it keeps one beside the terminal, else its values as the
  ## terminal opened. Public alone: what the frame's own API shows.
  if opener.len == 0:
    return @["no scene is showing"]
  var state = newJObject()
  var scene: FrameScene
  if not hostSceneFor.isNil:
    try: scene = hostSceneFor(SceneId(opener)) except Exception: scene = nil
  if scene of InterpretedFrameScene:
    for field in InterpretedFrameScene(scene).publicStateFields:
      let value = scene.state{field.name}
      if not value.isNil:
        state[field.name] = copy(value)
  elif not captured.isNil and captured.kind == JObject:
    state = captured
  pretty(state).splitLines()

proc deviceLines(args: seq[string], name: string): seq[string] =
  ## `restart` and `reboot`: the device commands the frame page's buttons send.
  let info = facts()
  let why = refusal(info)
  if why.len > 0:
    return @[why]
  if name == "restart" and %"restart" in arrayOf(info{"actions"}):
    sendEvent(evRestart, newJObject(), eoPanel)
    return @["restarting FrameOS..."]
  sendEvent(evReboot, newJObject(), eoPanel)
  @["rebooting..."]

proc eventLines(line: string, args: seq[string]): seq[string] =
  if args.len < 2:
    return @["usage: event <name> [json payload]",
      "  e.g. event render {}"]
  let why = refusal(facts())
  if why.len > 0:
    return @[why]
  let name = args[1]
  # The payload is the rest of the line as typed: JSON keeps its quotes.
  let at = line.find(name) + name.len
  let text = if at < line.len: line[at .. ^1].strip() else: ""
  var payload = newJObject()
  if text.len > 0:
    try:
      payload = parseJson(text)
    except CatchableError:
      return @["event: the payload is not JSON"]
    if payload.kind != JObject:
      return @["event: the payload is not a JSON object"]
  if not originMayEmit(eoPanel, name):
    return @["event refused: not one the console may send"]
  sendEvent(name, payload, eoPanel)
  @["sent " & name & " " & $payload]

proc run*(line: string, config: FrameConfig, opener: string, captured: JsonNode = nil): Outcome =
  ## One command line, as fos_console.c's run_console_line runs one.
  let args = words(line)
  if args.len == 0:
    return
  let name = args[0]
  case name
  of "help":
    result.lines = helpLines()
  of "status":
    result.lines = statusLines(config, opener)
  of "set":
    result.lines = setLines(args)
  of "wifi":
    result.lines = wifiLines(args)
  of "wifi-scan":
    let info = facts()
    let why = refusal(info)
    if why.len > 0:
      result.lines = @[why]
    elif info.wifiFacts().isNil:
      result.lines = @["wifi-scan: this frame has no Wi-Fi to scan with here"]
    else:
      if not settings.frameSettingsAction.isNil:
        settings.frameSettingsAction("scan")
      result.lines = @["scanning..."]
      result.scanning = true
  of "render":
    # A person asking, as the page's Render again: every panel drawn anew.
    # The origin `panel` only while the page is on; a plain render without.
    sendEvent(evRender, newJObject(), if refusal(facts()).len == 0: eoPanel else: eoScene)
    result.lines = @["render triggered"]
  of "event":
    result.lines = eventLines(line, args)
  of "scenes":
    result.lines = sceneLines(opener)
  of "scene_state":
    result.lines = stateLines(opener, captured)
  of "scene":
    if args.len < 2:
      result.lines = @["usage: scene <scene-id>"] & sceneLines(opener)
    else:
      var known = false
      if not switcher.sceneSwitcherListing.isNil:
        try:
          for entry in switcher.sceneSwitcherListing():
            known = known or entry.id == args[1]
        except Exception:
          discard
      if not known:
        result.lines = @["scene select failed: no scene " & args[1] & " on this frame"]
      else:
        sendEvent(evSetCurrentScene, %*{"sceneId": args[1]}, eoScene)
        result.lines = @["scene queued: " & args[1]]
        result.picked = true
  of "restart", "reboot":
    result.lines = deviceLines(args, name)
  else:
    if name in EspOnly:
      result.lines = @[name & ": not on this frame (an ESP32's serial console has it)"]
    else:
      result.lines = @["unknown command: " & line.strip()]
