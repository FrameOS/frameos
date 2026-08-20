## `frameos set-display`: patch the display fields of a frame.json in place.
##
## Used by the first-boot script on SD images to apply the display the user
## picked in the cloud SD builder (`device=` in /boot/frameos-cloud.txt).
## Buildroot images ship neither python3 nor jq, so the binary has to do the
## JSON edit itself — it already loads the same file at startup.
##
## Only the keys given are touched; everything else in frame.json survives
## byte-for-byte at the JSON level. Invalid numbers fail before anything is
## written, so a bad value can never leave a half-patched file behind.

import std/[json, os, strutils]

type
  DisplayPatch* = object
    frameJsonPath*: string
    device*: string
    width*: string
    height*: string
    rotate*: string
    vcom*: string
    uploadUrl*: string

const setDisplayUsage* = "FrameOS set-display --device=<key> [--frame-json=PATH] " &
  "[--width=N] [--height=N] [--rotate=0|90|180|270] [--vcom=F] [--upload-url=URL]"

proc parseSetDisplayArgs*(args: seq[string]): DisplayPatch =
  result.frameJsonPath = "frame.json"
  for arg in args:
    let eq = arg.find('=')
    if not arg.startsWith("--") or eq < 0:
      raise newException(ValueError, "FrameOS set-display: unexpected argument '" & arg & "'\n" & setDisplayUsage)
    let key = arg[2 ..< eq]
    let value = arg[eq + 1 .. ^1]
    case key
    of "frame-json": result.frameJsonPath = value
    of "device": result.device = value
    of "width": result.width = value
    of "height": result.height = value
    of "rotate": result.rotate = value
    of "vcom": result.vcom = value
    of "upload-url": result.uploadUrl = value
    else:
      raise newException(ValueError, "FrameOS set-display: unknown option '--" & key & "'\n" & setDisplayUsage)
  if result.device.len == 0:
    raise newException(ValueError, "FrameOS set-display: --device is required\n" & setDisplayUsage)

proc parseIntOr(raw, name: string): int =
  try:
    result = parseInt(raw.strip())
  except ValueError:
    raise newException(ValueError, "FrameOS set-display: invalid " & name & ": " & raw)

proc applyDisplayPatch*(data: JsonNode, patch: DisplayPatch) =
  ## Mutates `data` (a parsed frame.json). Validates every value first so a
  ## bad one raises before any key is changed.
  var width, height, rotate = -1
  var vcom = 0.0
  if patch.width.len > 0:
    width = parseIntOr(patch.width, "width")
    if width <= 0: raise newException(ValueError, "FrameOS set-display: invalid width: " & patch.width)
  if patch.height.len > 0:
    height = parseIntOr(patch.height, "height")
    if height <= 0: raise newException(ValueError, "FrameOS set-display: invalid height: " & patch.height)
  if patch.rotate.len > 0:
    rotate = parseIntOr(patch.rotate, "rotate")
    if rotate notin [0, 90, 180, 270]:
      raise newException(ValueError, "FrameOS set-display: invalid rotate: " & patch.rotate)
  if patch.vcom.len > 0:
    try:
      vcom = parseFloat(patch.vcom.strip())
    except ValueError:
      raise newException(ValueError, "FrameOS set-display: invalid vcom: " & patch.vcom)

  data["device"] = %patch.device
  if width > 0: data["width"] = %width
  if height > 0: data["height"] = %height
  if rotate >= 0: data["rotate"] = %rotate
  var config = data{"deviceConfig"}
  if config == nil or config.kind != JObject:
    config = newJObject()
  if patch.vcom.len > 0: config["vcom"] = %vcom
  # config.nim renames uploadUrl → httpUploadUrl on load; write the canonical
  # name so the file matches what the runtime logs at bootup.
  if patch.uploadUrl.len > 0: config["httpUploadUrl"] = %patch.uploadUrl
  data["deviceConfig"] = config

proc runSetDisplay*(args: seq[string]): int =
  ## Entry point for the CLI. Returns the process exit code; errors go to
  ## stderr so the first-boot log shows why a patch was refused.
  let patch = parseSetDisplayArgs(args)
  if not fileExists(patch.frameJsonPath):
    stderr.writeLine("FrameOS set-display: " & patch.frameJsonPath & " not found")
    return 1
  let data = parseJson(readFile(patch.frameJsonPath))
  if data.kind != JObject:
    stderr.writeLine("FrameOS set-display: " & patch.frameJsonPath & " is not a JSON object")
    return 1
  applyDisplayPatch(data, patch)
  let tmp = patch.frameJsonPath & ".set-display-tmp"
  writeFile(tmp, data.pretty() & "\n")
  moveFile(tmp, patch.frameJsonPath)
  echo "FrameOS set-display: applied device '" & patch.device & "' to " & patch.frameJsonPath
  return 0
