import json
import strformat
import strutils
import math
import os
import checksums/md5
import frameos/types
import frameos/utils/system

when defined(frameosEmbedded):
  import frameos/utils/http_client

proc renderWidth*(config: FrameConfig): int {.inline.} =
  if config.rotate in [90, 270]: config.height else: config.width

proc renderHeight*(config: FrameConfig): int {.inline.} =
  if config.rotate in [90, 270]: config.width else: config.height

proc maxHttpResponseBytes*(config: FrameConfig): int {.inline.} =
  if config != nil and config.maxHttpResponseBytes > 0:
    config.maxHttpResponseBytes
  else:
    DefaultMaxHttpResponseBytes

proc maxHttpResponseBytes*(self: AppRoot): int {.inline.} =
  if self != nil:
    self.frameConfig.maxHttpResponseBytes()
  else:
    DefaultMaxHttpResponseBytes

proc embeddedMediaProxyBaseUrl*(config: FrameConfig): string {.inline.} =
  when defined(frameosEmbedded):
    if config != nil and config.settings != nil:
      return config.settings{"embedded"}{"mediaProxyBaseUrl"}.getStr()
  ""

proc embeddedMediaProxyBaseUrl*(self: AppRoot): string {.inline.} =
  if self != nil:
    self.frameConfig.embeddedMediaProxyBaseUrl()
  else:
    ""

proc ensureEmbeddedServiceSettings*(config: FrameConfig) =
  when defined(frameosEmbedded):
    if config == nil:
      return
    if config.settings == nil or config.settings.kind != JObject:
      config.settings = %*{}
    if config.settings{"embedded"} == nil or config.settings{"embedded"}.kind != JObject:
      config.settings["embedded"] = %*{}
    let embedded = config.settings["embedded"]
    if embedded{"settingsLoaded"}.getBool(false):
      return
    let url = embedded{"settingsUrl"}.getStr()
    if url.len == 0:
      return
    let body = boundedGetContent(url, timeoutMs = 10000, maxBytes = 16 * 1024,
                                 maxSeconds = 12)
    let fetched = parseJson(body)
    if fetched.kind == JObject:
      for key, value in fetched.pairs:
        if key != "embedded":
          config.settings[key] = value
    embedded["settingsLoaded"] = %true
  else:
    discard

proc ensureEmbeddedServiceSettings*(self: AppRoot) =
  if self != nil:
    self.frameConfig.ensureEmbeddedServiceSettings()

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
