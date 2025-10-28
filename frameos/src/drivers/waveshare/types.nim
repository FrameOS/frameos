import pixie, options, json
import frameos/types

type ColorOption* = enum
  Black = "Black"
  BlackWhiteRed = "BlackWhiteRed"
  BlackWhiteYellow = "BlackWhiteYellow"
  BlackWhiteYellowRed = "BlackWhiteYellowRed"
  FourGray = "FourGray"
  SixteenGray = "SixteenGray"
  SevenColor = "SevenColor"
  SpectraSixColor = "SpectraSixColor"

type Driver* = ref object of FrameOSDriver
  logger*: Logger
  width*: int
  height*: int
  lastImageData*: seq[ColorRGBX]
  lastRenderAt*: float
  palette*: Option[seq[(int, int, int)]]
  vcom*: float # used for the 10.3" display

var driverDebugLogger*: Logger
var driverDebugEnabled*: bool

proc setDriverDebugLogger*(logger: Logger) =
  driverDebugLogger = logger
  driverDebugEnabled = logger != nil and logger.frameConfig != nil and logger.frameConfig.debug

proc clearDriverDebugLogger*() =
  driverDebugLogger = nil
  driverDebugEnabled = false

proc driverDebugLogsEnabled*(): bool =
  result = driverDebugEnabled

proc logDriverDebug*(payload: JsonNode) =
  if not driverDebugEnabled or driverDebugLogger == nil:
    return

  var message = payload
  if message.isNil:
    message = %*{"event": "driver:waveshare:debug", "message": "(nil payload)"}
  elif message.kind != JObject:
    message = %*{"event": "driver:waveshare:debug", "message": $payload}
  elif not message.hasKey("event"):
    message["event"] = %*"driver:waveshare:debug"

  driverDebugLogger.log(message)
