## The screen digest the voice key sends its control plane before what was
## said (docs/voice-chat.md "Voice actions"): what a person could do on the
## frame right now, which only the frame knows — the elements of the scene's
## UIs a tap, a field or a scroll can reach (ui/events.uiScreen), whether the
## keyboard is up, the windows open beside it, the scene's public state. The
## plane has the scene itself (its custom events, its fields, the other
## scenes) and sends back the events that do what was asked: `uiAction` for
## an element, by the `id` listed here.
##
## One builder for every host that has a voice key: the ESP32
## (embedded_runtime.nim) and the browser preview (wasm_main.nim), both
## through single_scene_host.

import std/json
import ./types
import ./ui/events as ui_events

const
  VoiceScreenVersion* = 1
  MaxVoiceScreenState = 2048
    ## The state goes along up to this many bytes; a bigger one the plane reads
    ## from its own copy.

proc voiceScreen*(scene: FrameScene, windows: openArray[string] = [], state = ""): string =
  ## `{"v":1,"scene":id,"kb":true,"open":[ids],"state":{...},"t":[targets]}`:
  ## `kb` while the on-screen keyboard is up, `open` the scenes in windows
  ## beside it (a desktop's), `t` the targets of the scene's UIs and of the
  ## layout it wears. `{"v":1}` with no scene.
  result = "{\"v\":"
  result.addInt VoiceScreenVersion
  if scene.isNil:
    result.add '}'
    return
  var ids = @[scene.id.string]
  if not scene.wornLayout.isNil:
    ids.add scene.wornLayout.id.string
  var
    targets = "["
    keyboard = false
  uiScreen(ids, targets, keyboard)
  targets.add ']'
  result.add ",\"scene\":"
  result.add escapeJson(scene.id.string)
  if keyboard:
    result.add ",\"kb\":true"
  if windows.len > 0:
    result.add ",\"open\":["
    for i, id in windows:
      if i > 0: result.add ','
      result.add escapeJson(id)
    result.add ']'
  if state.len > 2 and state.len <= MaxVoiceScreenState and state[0] == '{':
    result.add ",\"state\":"
    result.add state
  result.add ",\"t\":"
  result.add targets
  result.add '}'
