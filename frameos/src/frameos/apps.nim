import json
import strformat
import strutils
import math
import os
import checksums/md5
import frameos/types
import frameos/utils/memory
import frameos/utils/system

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

const
  MinSpoolThresholdBytes = 256 * 1024
    ## Below this a body is never worth a file: the syscalls and the flash wear
    ## cost more than the memory does.
  MaxSpoolThresholdBytes = 8 * 1024 * 1024
    ## And above it, a host with gigabytes free should still not sit on an
    ## unbounded body just because it can.

proc spoolThreshold*(): int =
  ## How large a body may get before it goes to storage instead of memory.
  ## Policy of the spool tier, not of any one app — every byte producer that
  ## spools (docs/value-pipeline.md, phase 2) shares this number, next to
  ## `spoolDir` below which says where the file goes.
  ##
  ## Derived from live memory rather than fixed, because the same number is
  ## wrong at both ends: a quarter of what a device can still allocate is
  ## generous on a host and appropriately mean on an ESP32 whose PSRAM is
  ## already carrying a canvas. `availableRenderBytes` returns 0 when it does
  ## not know, which means "no spooling" — the same behaviour as before.
  let available = availableRenderBytes()
  if available <= 0:
    return 0
  clamp(available div 4, MinSpoolThresholdBytes, MaxSpoolThresholdBytes)

proc spoolDir*(frameConfig: FrameConfig): string =
  ## Where a value too large to hold in memory should spill.
  ##
  ## The assets directory first — on an embedded frame that is the SD card
  ## when one is mounted, which is both roomier and kinder to the internal
  ## flash than the filesystem the firmware lives on. `.cache` marks it as
  ## disposable, matching the sweep the firmware already does for spilled
  ## downloads. Empty means "no preference", and the spool falls back to the
  ## platform temp dir.
  if frameConfig.isNil:
    return ""
  let assets = frameConfig.assetsPath
  if assets.len == 0:
    return ""
  assets & "/.cache"

proc spoolDir*(self: AppRoot): string =
  ## The app-side view of the same policy.
  if self.isNil:
    return ""
  self.frameConfig.spoolDir()

when defined(frameosEmbedded):
  const EmbeddedMinImageResponseBytes* = 6 * 1024 * 1024

proc maxImageResponseBytes*(config: FrameConfig): int {.inline.} =
  let configured = config.maxHttpResponseBytes()
  when defined(frameosEmbedded):
    max(configured, EmbeddedMinImageResponseBytes)
  else:
    configured

proc maxImageResponseBytes*(self: AppRoot): int {.inline.} =
  if self != nil:
    self.frameConfig.maxImageResponseBytes()
  else:
    when defined(frameosEmbedded):
      max(DefaultMaxHttpResponseBytes, EmbeddedMinImageResponseBytes)
    else:
      DefaultMaxHttpResponseBytes

## Service settings on embedded frames arrive ONE way: the firmware's ETag'd
## settings poll (embedded/esp32/main/fos_settings.c) hands the payload to
## `applyServiceSettings` below, for backend and cloud sources alike. There is
## deliberately no Nim-side fetch — apps read `config.settings` and never go
## looking for keys themselves.

const CloudServiceSettingsGroups* = [
  "frameOS", "github", "homeAssistant", "immich", "openAI", "unsplash",
]
  ## The settings groups a cloud provider owns on a cloud-managed frame
  ## (docs/cloud-frames.md, "Service settings"). Everything else in
  ## `config.settings` stays under local control and is never touched here.
  ## The Linux runtime keeps the same list in server/api.nim
  ## (`frameCloudServiceSettingsGroups`, pinned to the admin-editable fields
  ## by a static block); this copy exists because that module — and the whole
  ## frame.json persistence layer under it — is not part of the embedded
  ## build, where settings live in RAM and are re-pulled every boot.

const CloudServiceSettingsFields* = [
  ("frameOS", "apiKey"),
  ("openAI", "apiKey"),
  ("homeAssistant", "url"),
  ("homeAssistant", "accessToken"),
  ("github", "api_key"),
  ("immich", "url"),
  ("immich", "apiKey"),
  ("unsplash", "accessKey"),
]
  ## Every field a provider may deliver, per group. Mirrors
  ## `frameAdminEditableSettingsFields` in server/api.nim and the field list in
  ## docs/cloud-frames.md; anything else in a delivered group is dropped.

proc cloudServiceSettingsGroup(group: string, payload: JsonNode): JsonNode =
  ## One group as the device will store it: only the fields this frame knows
  ## for that group, only non-empty strings. nil when nothing usable is left —
  ## the caller then deletes the group, exactly as it treats an absent one (the
  ## provider omits empty values for the same reason).
  if payload == nil or payload.kind != JObject:
    return nil
  var fields = newJObject()
  for (section, field) in CloudServiceSettingsFields:
    if section != group:
      continue
    let value = payload{field}
    if value != nil and value.kind == JString and value.getStr("").len > 0:
      fields[field] = %value.getStr("")
  if fields.len == 0: nil else: fields

proc applyServiceSettings*(config: FrameConfig, settings: JsonNode): bool {.discardable.} =
  ## Applies one cloud service-settings pull (docs/cloud-frames.md) to the live
  ## config, and reports whether anything changed.
  ##
  ## `settings` is the pull's `settings` object (group → field → value). The six
  ## groups above are cloud-owned: each one present is REPLACED wholesale and
  ## each one absent is DELETED — revoking a key in the provider account, or
  ## dropping the last scene that used it, has to take the key off the device.
  ## `nil` or an empty object clears all six, which is what the provider's
  ## `403 insufficient_scope` means. No other settings key is read or written.
  ##
  ## The Linux counterpart is `persistCloudServiceSettingsUpdate` in
  ## server/api.nim, which does the same thing to frame.json. On embedded there
  ## is no frame.json: `config.settings` IS the copy, rebuilt from scratch on
  ## every boot, so a device that never pulls again simply has no keys.
  if config == nil:
    return false
  if config.settings == nil or config.settings.kind != JObject:
    config.settings = %*{}
  let incoming = if settings != nil and settings.kind == JObject: settings else: nil
  for group in CloudServiceSettingsGroups:
    let desired =
      if incoming == nil: nil
      else: cloudServiceSettingsGroup(group, incoming{group})
    let existing = config.settings{group}
    if desired == nil:
      if existing != nil:
        config.settings.delete(group)
        result = true
    elif existing == nil or existing.kind != JObject or existing != desired:
      config.settings[group] = desired
      result = true

proc applyServiceSettings*(config: FrameConfig, json: string): bool {.discardable.} =
  ## String entrypoint for the firmware (embedded_main.fos_nim_apply_service_settings_impl).
  ## An unparseable payload changes nothing — only a well-formed `{}` clears the
  ## groups, so a truncated read can never look like a revocation.
  var parsed: JsonNode = nil
  try:
    parsed = parseJson(if json.len == 0: "null" else: json)
  except CatchableError:
    return false
  if parsed == nil or parsed.kind != JObject:
    return false
  config.applyServiceSettings(parsed)

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
