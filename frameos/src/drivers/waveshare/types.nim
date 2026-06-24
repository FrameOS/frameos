import options, json, hashes, pixie
import frameos/driver_context
import drivers/waveshare/color
export color

type Driver* = ref object of FrameOSDriver
  logger*: DriverLogger
  width*: int
  height*: int
  lastImageHash*: Hash
  lastImageBytes*: int
  lastRenderAt*: float
  lastBlackSourceImage*: seq[ColorRGBX]
  lastPackedBlackImage*: seq[uint8]
  lastPackedRedImage*: seq[uint8]
  partialEnabled*: bool
  partialsSinceFull*: int
  partialMaxAreaPercent*: float
  partialMaxRefreshesBeforeFull*: int
  palette*: Option[seq[(int, int, int)]]
  vcom*: float # used for the 10.3" display

var driverDebugLogger*: DriverLogger
var driverDebugEnabled*: bool

proc setDriverDebugLogger*(logger: DriverLogger) =
  driverDebugLogger = logger
  driverDebugEnabled = logger != nil and logger.debug

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
