## The frame page's facts and powers as the host hands them over (the Pi's
## frameos/frame_settings_linux.nim, the ESP32's main/fos_frame_settings.c
## through embedded/embedded_runtime.nim, the browser's wasm_main.nim): read
## by the frame page (system/sceneSettings, docs/scene-settings.md) and by a
## JS app the owner let have them (`frameos.frame`, docs/terminal.md).

import std/json

type
  # The frame's own page (docs/scene-settings.md "The frame page"), behind
  # the gear: what the host knows of the frame, read on every render. The
  # host gives facts and the page has the words, so every host shows the
  # same page.
  FrameSettingsRead* = proc(): JsonNode {.nimcall, gcsafe, raises: [].}
    ## nil when the page is not offered (no host has one, or the frame's
    ## control plane turned it off). Else {wifi: {state, ssid, hotspot,
    ## rssi, ip, networks: [name…], scanning, password}, rotate,
    ## renderScale, battery: {percent}, managedBy, version,
    ## actions: ["restart"…], note}: `battery` absent without one; `wifi`
    ## absent, no network to set here; `state` one of connected, connecting,
    ## notFound, auth, hotspot, unset, off; `password` a password is saved;
    ## `actions` the device commands this host runs besides render and
    ## reboot; `note` what the last Save could not do.
  FrameSettingsApply* = proc(changes: JsonNode) {.nimcall, gcsafe, raises: [].}
    ## What Save changed: wifiSsid with wifiPassword (empty: the saved one
    ## for the same network, none for another), rotate, renderScale.
  FrameSettingsAction* = proc(action: string) {.nimcall, gcsafe, raises: [].}
    ## "open" when the page comes up, "close" when it goes, "scan" for the
    ## networks in range.

var
  frameSettingsRead*: FrameSettingsRead
  frameSettingsApply*: FrameSettingsApply
  frameSettingsAction*: FrameSettingsAction
