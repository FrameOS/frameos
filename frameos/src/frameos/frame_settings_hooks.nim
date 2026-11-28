## The frame page's facts and powers as the host hands them over (the Pi's
## frameos/frame_settings_linux.nim, the ESP32's main/fos_frame_settings.c
## through embedded/embedded_runtime.nim, the browser's wasm_main.nim): read
## by the frame page (system/sceneSettings, docs/scene-settings.md) and by a
## JS app the owner let have them (`frameos.frame`, docs/terminal.md).

import std/json
import ./scene_code_hooks
import ./scene_store_hooks

type
  # The frame's own page (docs/scene-settings.md "The frame page"), behind
  # the gear: what the host knows of the frame, read on every render. The
  # host gives facts and the page has the words, so every host shows the
  # same page.
  FrameSettingsRead* = proc(): JsonNode {.nimcall, gcsafe, raises: [].}
    ## nil when the page is not offered (no host has one, or the frame's
    ## control plane turned it off). Else {wifi: {state, ssid, hotspot,
    ## rssi, ip, networks: [name…], scanning, password}, rotate,
    ## renderScale, brightness (only where the glass can dim), battery:
    ## {percent}, managedBy, version,
    ## actions: ["restart"…], note, about: {chip, soc, cores, mhz, board,
    ## system, display, psram, memory, flash, storage, card, uptime, mac,
    ## hostname, frameId, server, build}, bluetooth: {on, ready, pairing,
    ## devices: [{address, name, keyboard, mouse, connected}]}}: `bluetooth`
    ## absent on a host without it (only an ESP32 S3 has it); `battery`
    ## absent without one; `wifi`
    ## absent, no network to set here; `state` one of connected, connecting,
    ## notFound, auth, hotspot, unset, off; `password` a password is saved;
    ## `actions` the device commands this host runs besides render and
    ## reboot; `note` what the last Save could not do; `about` what the
    ## frame is, each fact absent where the host does not know it, bytes as
    ## bytes and [total, free] for what fills (docs/scene-settings.md "About").
  FrameSettingsApply* = proc(changes: JsonNode) {.nimcall, gcsafe, raises: [].}
    ## What Save changed: wifiSsid with wifiPassword (empty: the saved one
    ## for the same network, none for another), rotate, renderScale,
    ## bluetooth (on or off at once); and,
    ## with no Save, brightness as a finger moves it (`live`: set, not kept).
  FrameSettingsAction* = proc(action: string) {.nimcall, gcsafe, raises: [].}
    ## "open" when the page comes up, "close" when it goes, "scan" for the
    ## networks in range; "btPair" / "btStop" open and close a minute of
    ## Bluetooth pairing, "btForget <address>" forgets one device.

var
  frameSettingsRead*: FrameSettingsRead
  frameSettingsApply*: FrameSettingsApply
  frameSettingsAction*: FrameSettingsAction

# The HTTP write door (the frame access key, or `public` access: POST
# /event/<name>, origin `http:write`) is for a frame's scenes: whoever was
# handed the key off the frame's QR code picks a scene and sets its fields.
# It is not the frame's (server/auth.nim `hasControlAccess`). So while a scene
# runs on an event that came through that door, the frame offers no page, as
# when its control plane turned the page off: the three hooks are nil, and
# every reader of them (the frame page, `frameos.frame`) already knows what
# to do then. So are the two other powers that are the frame's rather than a
# scene's: the code host (`frameos.code`, scene_code_hooks.nim) and the
# store's actions (`frameos.storeAction`, scene_store_hooks.nim), which answer
# as on a frame with no host. The dispatcher (event_loop.nim `runOnScene`) is
# the one caller.
var
  framePageWithheld*: bool
    ## True for the length of such a run. The scene settings read it to take
    ## no input at all (system/sceneSettings).
  heldRead: FrameSettingsRead
  heldApply: FrameSettingsApply
  heldAction: FrameSettingsAction
  heldCode: SceneCode
  heldStoreAction: SceneStoreAction

proc withholdFramePage*() =
  if framePageWithheld:
    return
  framePageWithheld = true
  heldRead = frameSettingsRead
  heldApply = frameSettingsApply
  heldAction = frameSettingsAction
  heldCode = sceneCode
  heldStoreAction = sceneStoreAction
  frameSettingsRead = nil
  frameSettingsApply = nil
  frameSettingsAction = nil
  sceneCode = nil
  sceneStoreAction = nil

proc offerFramePage*() =
  ## The hooks back as they were. A no-op when nothing is withheld, so a host
  ## recovering from an aborted run (event_loop.nim `resetAfterAbort`) calls
  ## it without asking.
  if not framePageWithheld:
    return
  framePageWithheld = false
  frameSettingsRead = heldRead
  frameSettingsApply = heldApply
  frameSettingsAction = heldAction
  sceneCode = heldCode
  sceneStoreAction = heldStoreAction
