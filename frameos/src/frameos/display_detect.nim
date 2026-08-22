## Display geometry a driver detected at runtime, written back to frame.json.
##
## The generic Buildroot image ships frame.json at 800x480 and the cloud
## deliberately sends no width/height for HDMI ("autodetected"). The
## framebuffer driver does detect the real mode — but only into the process's
## FrameConfig. Everything that reads the file (the hardware report sent to
## the cloud from a fresh process, backups, `frameos set-display`, the next
## boot's first render before the probe lands) kept saying 800x480, which is
## how a 1080p HDMI frame showed up in the cloud workspace at 800x480.
##
## `persistDetectedDisplaySize` writes the in-memory width/height into
## frame.json when they differ from what the file says. Called after driver
## init and after every render pass (cheap: two int compares until something
## changes). Scenes already follow FrameConfig live; this makes the file and
## the cloud follow too.

import std/[json, os, strutils]
import frameos/config
import frameos/types

var lastPersistedWidth = 0
var lastPersistedHeight = 0

proc resetDisplayDetectState*() =
  ## Tests only.
  lastPersistedWidth = 0
  lastPersistedHeight = 0

proc detectedDisplayChanged*(frameConfig: FrameConfig): bool =
  ## True when the live width/height differ from what was last persisted (or
  ## last seen) — the cheap pre-check the render loop runs every pass.
  if frameConfig.isNil or frameConfig.width <= 0 or frameConfig.height <= 0:
    return false
  frameConfig.width != lastPersistedWidth or frameConfig.height != lastPersistedHeight

proc persistDetectedDisplaySize*(frameConfig: FrameConfig, logger: Logger,
    configPath = ""): bool =
  ## Writes frameConfig.width/height into frame.json when the file disagrees.
  ## Returns true when the file was changed. Never raises: a read-only root
  ## or a missing file is logged and the in-memory value keeps winning.
  if not detectedDisplayChanged(frameConfig):
    return false
  lastPersistedWidth = frameConfig.width
  lastPersistedHeight = frameConfig.height
  let path = getConfigFilename(configPath)
  if path.len == 0 or not fileExists(path):
    return false
  try:
    let data = parseFile(path)
    if data.kind != JObject:
      return false
    let fileWidth = data{"width"}.getInt(0)
    let fileHeight = data{"height"}.getInt(0)
    if fileWidth == frameConfig.width and fileHeight == frameConfig.height:
      return false
    data["width"] = %frameConfig.width
    data["height"] = %frameConfig.height
    # Rename over the target: an interrupted write leaves the old file, not
    # half a file.
    let tempPath = path & ".tmp"
    writeFile(tempPath, pretty(data, indent = 4) & "\n")
    moveFile(tempPath, path)
    if not logger.isNil:
      logger.log(%*{"event": "display:detected", "device": frameConfig.device,
        "width": frameConfig.width, "height": frameConfig.height,
        "previousWidth": fileWidth, "previousHeight": fileHeight, "persisted": true})
    return true
  except CatchableError as e:
    if not logger.isNil:
      logger.log(%*{"event": "display:detected:error", "device": frameConfig.device,
        "width": frameConfig.width, "height": frameConfig.height, "error": e.msg})
    return false
