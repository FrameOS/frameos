## Is the frame page of the settings on the frame's own screen offered
## (docs/scene-settings.md "The frame page")? The control plane's
## `frame_settings_on_screen` (frame.json `frameSettingsOnScreen`) says so,
## and the device's own unlock wins over it being off: a file named
## `frameos-settings-unlock` on the boot partition (`/boot` on Buildroot and
## older Raspberry Pi OS, `/boot/firmware` from Bookworm on). The file is the
## way back in for a frame whose page was turned off and whose Wi-Fi then
## broke, where no plane can reach it to turn the page on again; it works for
## as long as it is there. An ESP32's equivalent is its console's
## `set settings_unlock 1` (fos_config_frame_page_offered).

import std/os
import frameos/types

const DefaultSettingsUnlockPaths* = ["/boot/frameos-settings-unlock", "/boot/firmware/frameos-settings-unlock"]

var unlockPathsOverride: seq[string]
var unlockPathsOverridden: bool

proc setSettingsUnlockPathsForTest*(paths: seq[string]) =
  ## Tests point the check at their own files; an empty list checks none.
  unlockPathsOverride = paths
  unlockPathsOverridden = true

proc settingsUnlocked*(): bool {.gcsafe.} =
  ## The unlock file is on the boot partition.
  {.cast(gcsafe).}:
    if unlockPathsOverridden:
      for path in unlockPathsOverride:
        if fileExists(path):
          return true
      return false
  for path in DefaultSettingsUnlockPaths:
    if fileExists(path):
      return true

proc framePageOffered*(config: FrameConfig): bool {.gcsafe.} =
  ## The plane leaves the page on, or the device unlocked it.
  (not config.isNil and config.frameSettingsOnScreen) or settingsUnlocked()
