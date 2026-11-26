import json
import strformat
import strutils
import math
import os
import checksums/md5
import frameos/types
import frameos/service_keys
import frameos/utils/memory
import frameos/utils/system

proc renderWidth*(config: FrameConfig): int {.inline.} =
  if config.rotate in [90, 270]: config.height else: config.width

proc renderHeight*(config: FrameConfig): int {.inline.} =
  if config.rotate in [90, 270]: config.width else: config.height

proc panelScale*(config: FrameConfig): float =
  ## How much bigger than a 7.5" 800x480 panel this display is, by its shorter
  ## edge: 1.0 up to that size, 2.0 at 1080p, 4.0 at 4K. The system scenes and
  ## the runner's overlays multiply their fixed pixel sizes by it so a 32px
  ## hint that reads fine on e-ink is not a speck on a TV.
  let shorter = min(config.width, config.height)
  if shorter <= 0:
    return 1.0
  max(1.0, shorter.float / 540.0)

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
## deliberately no Nim-side fetch — apps read their keys through
## service_keys.nim and never go looking for them themselves.

const LegacyPlaneServiceGroups* = [
  "frameOS", "github", "homeAssistant", "immich", "openAI", "unsplash",
]
  ## The groups every plane owned before service keys (docs/service-keys.md):
  ## a pull takes them away when it no longer sends them, whatever the frame
  ## kept of the last one. Any other group a plane sends is owned by name
  ## (`FrameConfig.serviceSettingsOwned`); no list of services otherwise.

proc deliveredServiceGroup*(payload: JsonNode): JsonNode =
  ## One group as the device keeps it: its string fields with a field's name,
  ## non-empty. nil when nothing usable is left — the caller then deletes the
  ## group, as it treats an absent one (the planes omit empty values too).
  if payload == nil or payload.kind != JObject:
    return nil
  var fields = newJObject()
  for field, value in payload.pairs:
    if isFieldName(field) and value.kind == JString and value.getStr("").len > 0:
      fields[field] = %value.getStr("")
  if fields.len == 0: nil else: fields

proc servicePull*(payload: JsonNode): tuple[settings, serviceKeys: JsonNode, owned: seq[string]] =
  ## A pull's parts: `{"settings", "serviceKeys", "groups"}` (what the
  ## firmware hands over since service keys, the cloud's body), or an older
  ## flat map of groups (an NVS cache from before). `owned`: the groups the
  ## plane says are its own, sent or listed.
  if payload == nil or payload.kind != JObject:
    return
  let wrapped = payload{"settings"}
  result.settings = if wrapped != nil and wrapped.kind == JObject: wrapped else: payload
  if wrapped != nil and wrapped.kind == JObject:
    let keys = payload{"serviceKeys"}
    if keys != nil and keys.kind == JObject:
      result.serviceKeys = keys
    let groups = payload{"groups"}
    if groups != nil and groups.kind == JArray:
      for group in groups.elems:
        if group.kind == JString and isServiceId(group.getStr()) and group.getStr() notin result.owned:
          result.owned.add group.getStr()
  for group, _ in result.settings.pairs:
    if isServiceId(group) and group notin result.owned:
      result.owned.add group

proc applyServiceSettings*(config: FrameConfig, payload: JsonNode): bool {.discardable.} =
  ## Applies one service-settings pull (docs/service-keys.md) to the live
  ## config, and reports whether anything changed.
  ##
  ## What the plane owns is REPLACED: each group it sends now replaces the
  ## frame's copy, and each it sent last time, or one of the legacy six, that
  ## it no longer sends is DELETED — revoking a key in the account, or
  ## dropping the last scene that used it, has to take the key off the
  ## device. `serviceKeys` is replaced whole, and goes when the pull has
  ## none. `nil` or an empty object clears it all, which is what the
  ## provider's `403 insufficient_scope` means. Other settings stay.
  ##
  ## The Linux counterpart is `persistCloudServiceSettingsUpdate` in
  ## server/api.nim, which does the same thing to frame.json. On embedded there
  ## is no frame.json: `config.settings` IS the copy, rebuilt from scratch on
  ## every boot, so a device that never pulls again simply has no keys.
  if config == nil:
    return false
  if config.settings == nil or config.settings.kind != JObject:
    config.settings = %*{}
  let pull = servicePull(payload)
  var owned: seq[string]
  for group in LegacyPlaneServiceGroups:
    owned.add group
  for group in config.serviceSettingsOwned & pull.owned:
    if group notin owned:
      owned.add group
  for group in owned:
    let desired = if pull.settings == nil: nil else: deliveredServiceGroup(pull.settings{group})
    let existing = config.settings{group}
    if desired == nil:
      if existing != nil:
        config.settings.delete(group)
        result = true
    elif existing == nil or existing.kind != JObject or existing != desired:
      config.settings[group] = desired
      result = true
  config.serviceSettingsOwned = pull.owned
  if config.serviceKeys != pull.serviceKeys:
    config.serviceKeys = if pull.serviceKeys == nil: nil else: copy(pull.serviceKeys)
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

proc savedAssetDir*(assetsPath, appKeyword, nodeName: string): string =
  ## Where an app's saved images go: `<assets>/saved/<app>`, so the assets
  ## panel groups them by the app that fetched them (saved/unsplash,
  ## saved/openaiImage, …). A node the owner named gets its own folder
  ## underneath — two Unsplash nodes with different searches stay apart, as
  ## they did when the node name alone chose the folder. Everything used to
  ## land in one flat `saved/` (unnamed nodes) or in a top-level folder per
  ## node name.
  let app = appKeyword.replace("data/", "").cleanFilename()
  let node =
    if nodeName == "" or nodeName == appKeyword: ""
    else: nodeName.replace("data/", "").cleanFilename()
  result = assetsPath & "/saved"
  if app != "":
    result.add("/" & app)
  if node != "" and node != app:
    result.add("/" & node)

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
  let basename = (if filename.len > 100: filename[0..100] else: filename).cleanFilename()
  let md5hash = getMD5(contents)
  let cleanPath = savedAssetDir(assetsPath, self.appKeyword, self.nodeName)
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
