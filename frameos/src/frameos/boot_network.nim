## How a Linux frame's boot treats the network (docs/scene-settings.md
## "Booting without the network"). The ESP32's twin is `fos_wake_wifi_plan`
## (embedded/esp32/main/fos_wake.c).
##
## A frame with a touch screen is set up on that screen: the settings panel's
## frame page has the Wi-Fi (frame_settings_linux.nim). Its first picture
## never waits for the network: the check (`networkCheck`) runs beside it and
## the scene renders again when the network answers, and while the frame page
## is offered a check that fails raises no boot hotspot. Every other frame
## waits for the check, as before, and so does a touch screen whose frame
## says `networkCheckOnTouch`.

import std/strutils

type
  BootNetworkPlan* = object
    waits*: bool
      ## The first render waits for the check (frameos.nim's boot screen).
    behind*: bool
      ## The check runs on a thread of its own once the scene is up.
    hotspot*: bool
      ## A check that fails raises the boot hotspot (`wifiHotspot: bootOnly`).

proc setsUpOnScreen*(device: string): bool =
  ## A frame whose own screen takes touch: the HyperPixels (the devices
  ## whose event map has the edge swipes, device_event_map.nim). A plain
  ## HDMI screen may have no input at all, so it keeps its hotspot.
  device.startsWith("pimoroni.hyperpixel")

proc bootNetworkPlan*(device: string, networkCheck, networkCheckOnTouch: bool,
                      wifiHotspot: string, framePageOffered: bool): BootNetworkPlan =
  let bootHotspot = wifiHotspot == "bootOnly"
  # The boot hotspot needs the check to decide, with "wait for network" off too.
  if not networkCheck and not bootHotspot:
    return
  if not setsUpOnScreen(device) or networkCheckOnTouch:
    return BootNetworkPlan(waits: true, hotspot: bootHotspot)
  # A frame page turned off by the plane leaves the hotspot as the only way to
  # set the network at the frame.
  BootNetworkPlan(behind: true, hotspot: bootHotspot and not framePageOffered)
