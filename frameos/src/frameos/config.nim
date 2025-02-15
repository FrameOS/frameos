import json, pixie, os, strutils
import frameos/types
import lib/tz

proc setConfigDefaults*(config: var FrameConfig) =
  if config.serverPort == 0: config.serverPort = 8989
  if config.width == 0: config.width = 1920
  if config.height == 0: config.height = 1080
  if config.device == "": config.device = "web_only"
  if config.metricsInterval == 0: config.metricsInterval = 60
  if config.rotate == 0: config.rotate = 0
  if config.scalingMode == "": config.scalingMode = "cover"
  if config.framePort == 0: config.framePort = 8787
  if config.frameHost == "": config.frameHost = "localhost"
  if config.frameAccess == "": config.frameAccess = "private"
  if config.name == "": config.name = config.frameHost
  if config.timeZone == "": config.timeZone = findSystemTimeZone()

proc loadSchedule*(data: JsonNode): FrameSchedule =
  result = FrameSchedule(events: @[])
  if data == nil or data.kind != JObject or data["events"] == nil or data["events"].kind != JArray:
    return result
  for event in data["events"].items:
    result.events.add(ScheduledEvent(
      id: event{"id"}.getStr(),
      minute: event{"minute"}.getInt(),
      hour: event{"hour"}.getInt(),
      weekday: event{"weekday"}.getInt(),
      event: event{"event"}.getStr(),
      payload: event{"payload"}
    ))

proc loadConfig*(filename: string = "frame.json"): FrameConfig =
  let data = parseFile(filename)
  result = FrameConfig(
    name: data{"name"}.getStr(),
    serverHost: data{"serverHost"}.getStr(),
    serverPort: data{"serverPort"}.getInt(),
    serverApiKey: data{"serverApiKey"}.getStr(),
    frameHost: data{"frameHost"}.getStr(),
    framePort: data{"framePort"}.getInt(),
    frameAccess: data{"frameAccess"}.getStr(),
    frameAccessKey: data{"frameAccessKey"}.getStr(),
    width: data{"width"}.getInt(),
    height: data{"height"}.getInt(),
    device: data{"device"}.getStr(),
    metricsInterval: data{"metricsInterval"}.getFloat(),
    rotate: data{"rotate"}.getInt(),
    scalingMode: data{"scalingMode"}.getStr(),
    settings: data{"settings"},
    assetsPath: data{"assetsPath"}.getStr("/srv/assets"),
    saveAssets: if data{"saveAssets"} == nil: %*(false) else: data{"saveAssets"},
    logToFile: data{"logToFile"}.getStr(),
    debug: data{"debug"}.getBool() or commandLineParams().contains("--debug"),
    timeZone: data{"timeZone"}.getStr("UTC"),
    schedule: loadSchedule(data{"schedule"})
  )
  if result.assetsPath.endswith("/"):
    result.assetsPath = result.assetsPath.strip(leading = false, trailing = true, chars = {'/'})
  setConfigDefaults(result)
