import json
import strformat
import strutils
import os
import checksums/md5
import frameos/types

proc renderWidth*(config: FrameConfig): int {.inline.} =
  if config.rotate in [90, 270]: config.height else: config.width

proc renderHeight*(config: FrameConfig): int {.inline.} =
  if config.rotate in [90, 270]: config.width else: config.height

proc appName(self: AppRoot): string =
  if self.nodeName == "": $self.nodeId else: $self.nodeId & ":" & self.nodeName

proc log*(self: AppRoot, message: string) =
  self.scene.logger.log(%*{
    "event": &"log:{appName(self)}",
    "message": message
  })

proc log*(self: AppRoot, message: JsonNode) =
  if message.kind == JObject:
    # Note: this modifies the original object!
    message["event"] = %*("log:" & appName(self) & (if message.hasKey("event"): ":" & message["event"].getStr() else: ""))
    self.scene.logger.log(message)
  else:
    self.log($message)

proc logError*(self: AppRoot, message: string) =
  self.scene.logger.log(%*{
    "event": &"error:{appName(self)}",
    "error": message
  })

proc cleanPosix*(self: string): string =
  var finalResult = ""
  var lastCharWasSpace = false

  for ch in self:
    if ch.isAlphaNumeric or ch == '-' or ch == '_':
      finalResult.add(ch)
      lastCharWasSpace = false
    elif ch == ' ':
      if not lastCharWasSpace:
        finalResult.add(' ')
        lastCharWasSpace = true

  return finalResult

proc saveAsset*(self: AppRoot, filename: string, contents: string): string =
  let assetsPath = if self.frameConfig.assetsPath == "": "/srv/assets" else: self.frameConfig.assetsPath
  let appName = if self.nodeName == "": "saved" else: self.nodeName.replace("data/", "").cleanPosix
  let basename = filename.splitFile.name.cleanPosix
  let md5hash = getMD5(contents)
  let extension = filename.splitFile.ext
  let cleanPath = &"{assetsPath}/{appName}"
  let cleanFilename = &"{cleanPath}/{basename}.{md5hash}{extension}"

  try:
    if not dirExists(cleanPath):
      createDir(cleanPath)
    if not fileExists(cleanFilename):
      writeFile(cleanFilename, contents)
      self.log(&"Saved as asset: {cleanFilename}")
    else:
      self.log(&"Asset already exists: {cleanFilename}")
  except Exception as e:
    self.logError(&"Error saving asset: {e.msg}")

  return cleanFilename
