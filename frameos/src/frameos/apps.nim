import json
import strformat
import strutils
import math
import os
import checksums/md5
import frameos/types
import frameos/utils/system

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

proc cleanFilename*(self: string): string =
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

proc saveAsset*(self: AppRoot, filename: string, extension: string, contents: string, isAuto: bool): string =
  if isAuto:
    if self.frameConfig.saveAssets.kind == JBool:
      if not self.frameConfig.saveAssets.getBool():
        return ""
    elif self.frameConfig.saveAssets.kind == JObject:
      if not self.frameConfig.saveAssets{self.nodeName}.getBool():
        return ""
    else:
      return ""

  let assetsPath = if self.frameConfig.assetsPath == "": "/srv/assets" else: self.frameConfig.assetsPath
  let appName = if self.nodeName == "": "saved" else: self.nodeName.replace("data/", "").cleanFilename()
  let basename = (if filename.len > 100: filename[0..100] else: filename).cleanFilename()
  let md5hash = getMD5(contents)
  let cleanPath = &"{assetsPath}/{appName}"
  let cleanFilename = &"{cleanPath}/{basename}.{md5hash}{extension}"

  try:
    if not dirExists(cleanPath):
      createDir(cleanPath)

    let freeDiskSpace = getAvailableDiskSpace(cleanPath)
    if freeDiskSpace != -1:
      if freeDiskSpace < 100 * 1024 * 1024:
        self.logError(&"Low disk space: {(freeDiskSpace.float / 1024 / 1024).round(2)} MB. Asset not saved!")
        return ""
      else:
        self.log(&"Disk space available: {(freeDiskSpace.float / 1024 / 1024).round(2)} MB")

    if not fileExists(cleanFilename):
      writeFile(cleanFilename, contents)
      self.log(&"Saved as asset: {cleanFilename}")
    else:
      self.log(&"Asset already exists: {cleanFilename}")
  except Exception as e:
    self.logError(&"Error saving asset: {e.msg}")

  return cleanFilename
