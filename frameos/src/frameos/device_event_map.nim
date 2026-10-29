## The event map a device comes with (docs/events.md "Event map"): what a
## frame does with its keys and its glass before anyone has written its own.
##
## frame.json's `eventMap` always wins, an empty list included: that is
## somebody's decision about this frame. Only a frame that was never given
## one (no key, or `null`) takes this, the way an ESP32 with nothing stored
## takes its board's (embedded/esp32/main/fos_board.c `fos_board_event_map`).
## Because it is applied as the config loads, the frame also reports it as
## its map (cloud/enrollment.nim), and the Settings panel shows it.
##
## A HyperPixel is a touch screen with no keys: in from its right edge is the
## next scene, in from its left the previous, up from the bottom the scene
## switcher (docs/scene-switcher.md) and down from the top the scene's
## settings (docs/scene-settings.md), as on the SenseCAP Indicator
## (`edgeSwipe`: the scene hears none of that touch). Keep in step with
## `deviceEventMap` in frontend/src/utils/frameEventMap.ts.

import std/[json, strutils]

const hyperPixelEventMap = """[
  {"event": "edgeSwipe", "match": {"edge": "right"}, "emit": "setCurrentScene",
   "as": {"direction": "next"}},
  {"event": "edgeSwipe", "match": {"edge": "left"}, "emit": "setCurrentScene",
   "as": {"direction": "prev"}},
  {"event": "edgeSwipe", "match": {"edge": "bottom"}, "emit": "sceneSwitcher", "as": {}},
  {"event": "edgeSwipe", "match": {"edge": "top"}, "emit": "sceneSettings", "as": {}}
]"""

proc deviceEventMap*(device: string): JsonNode =
  ## A fresh copy of the device's own map; nil when it comes with none.
  if device.startsWith("pimoroni.hyperpixel"):
    return parseJson(hyperPixelEventMap)
  nil
