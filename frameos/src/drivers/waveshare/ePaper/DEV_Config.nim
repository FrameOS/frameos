import lib/lgpio

{.passC: "-Isrc/lib".}
{.compile: "DEV_Config.c".}
{.compile: "DEV_Debug.c".}

## Nim binding for the Waveshare hardware layer (DEV_Config.c, lgpio backed).
## The panel drivers (EPD_*.c) are compiled through their own {.compile.}
## wrappers and only ever talk to the DEV_* functions declared here.

import json
from drivers/waveshare/types import logDriverDebug, driverDebugLogsEnabled

type
  UBYTE* = uint8
  UWORD* = uint16
  UDOUBLE* = uint32

var EPD_RST_PIN* {.importc: "EPD_RST_PIN".}: cint

var EPD_DC_PIN* {.importc: "EPD_DC_PIN".}: cint

var EPD_CS_PIN* {.importc: "EPD_CS_PIN".}: cint

var EPD_CS_M_PIN* {.importc: "EPD_CS_M_PIN".}: cint

var EPD_CS_S_PIN* {.importc: "EPD_CS_S_PIN".}: cint

var EPD_BUSY_PIN* {.importc: "EPD_BUSY_PIN".}: cint

var EPD_PWR_PIN* {.importc: "EPD_PWR_PIN".}: cint

var EPD_MOSI_PIN* {.importc: "EPD_MOSI_PIN".}: cint

var EPD_SCLK_PIN* {.importc: "EPD_SCLK_PIN".}: cint


proc DEV_Digital_Write*(Pin: UWORD; Value: UBYTE) {.importc: "DEV_Digital_Write".}
proc DEV_Digital_Read*(Pin: UWORD): UBYTE {.importc: "DEV_Digital_Read".}
proc DEV_SPI_WriteByte*(Value: UBYTE) {.importc: "DEV_SPI_WriteByte".}
proc DEV_SPI_Write_nByte*(pData: ptr uint8; Len: uint32) {.
    importc: "DEV_SPI_Write_nByte".}
proc DEV_Delay_ms*(xms: UDOUBLE) {.importc: "DEV_Delay_ms".}
proc DEV_SetPinConfig*(rst: cint; dc: cint; cs: cint; cs2: cint; busy: cint;
    sclk: cint; mosi: cint; pwr: cint) {.importc: "DEV_SetPinConfig".}
proc DEV_Module_Init*(): UBYTE {.importc: "DEV_Module_Init".}
proc DEV_Module_Exit*() {.importc: "DEV_Module_Exit".}

type
  DEV_DebugLogFn = proc (action: cstring; extraJson: cstring) {.cdecl.}

proc DEV_SetDebugLog(fn: DEV_DebugLogFn) {.importc: "DEV_SetDebugLog".}

proc driverDebugLogBridge(action: cstring; extraJson: cstring) {.cdecl.} =
  ## Turns a C-side DEV_Debug_Log call into one JSON driver debug event.
  if not driverDebugLogsEnabled():
    return
  var payload = %*{"event": "driver:waveshare:debug", "action": $action}
  if not extraJson.isNil and extraJson.len > 0:
    try:
      let extra = parseJson("{" & $extraJson & "}")
      if extra.kind == JObject:
        for key, value in extra.pairs:
          payload[key] = value
    except CatchableError:
      payload["extra"] = %*($extraJson)
  logDriverDebug(payload)

proc installDriverDebugLog*() =
  ## Point the C drivers' DEV_Debug_Log at the frame's driver debug log when
  ## debug logging is on; leave the hook empty (cheap no-op) otherwise.
  if driverDebugLogsEnabled():
    DEV_SetDebugLog(driverDebugLogBridge)
  else:
    DEV_SetDebugLog(nil)

proc DEV_TakeError(buf: cstring; len: csize_t): cint {.importc: "DEV_TakeError".}

proc raiseIfDriverError*() =
  ## The C drivers cannot unwind; they park fatal problems (busy timeouts)
  ## in DEV_Error. Raise them here so the render is recorded as failed.
  var buf = newString(256)
  if DEV_TakeError(cstring(buf), csize_t(buf.len)) != 0:
    buf.setLen(buf.cstring.len)
    raise newException(Exception, "Waveshare driver: " & buf)
