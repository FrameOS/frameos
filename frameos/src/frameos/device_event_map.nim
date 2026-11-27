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
## A HyperPixel is a touch screen with no keys: in from its left edge is
## `back` and in from its right `forward` (the scene's own: the photo or the
## page before or after, never another scene), up from the bottom the scene
## switcher (docs/scene-switcher.md) and down from the top the scene's
## settings (docs/scene-settings.md), as on the SenseCAP Indicator
## (`edgeSwipe`: the scene hears none of that touch). An Inky Impression has
## A to D down its side (docs/buttons.md): A held is the scene list, B and C
## held the previous and the next scene, D pressed is `back` and held the
## scene list. The maps are generated with every board's
## (device_event_map_gen.nim, frameos/tools/generate_board_keys.py), as is
## the SPA's `deviceEventMap` (frontend/src/utils/frameEventMap.ts).

import std/[json, strutils]
import ./device_event_map_gen

proc deviceEventMap*(device: string): JsonNode =
  ## A fresh copy of the device's own map; nil when it comes with none.
  if device.startsWith("pimoroni.hyperpixel"):
    return parseJson(HyperPixelEventMap)
  if device in InkyImpressionDevices:
    return parseJson(InkyImpressionEventMap)
  nil
