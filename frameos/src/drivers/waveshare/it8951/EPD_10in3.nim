# Providing a familiar interface for the EPD 10in3 driver
import
  json,
  DEV_Config,
  IT8951,
  drivers/waveshare/types

const
  EPD_10IN3_WIDTH* = 1872
  EPD_10IN3_HEIGHT* = 1404

var initDone = false
var Dev_Info: IT8951_Dev_Info
var Init_Target_Memory_Addr: UDOUBLE
var activeDriver: Driver

proc it8951Status(): JsonNode =
  %*{
    "stage": $EPD_IT8951_GetLastStage(),
    "waitMs": EPD_IT8951_GetLastWaitMs().int,
    "waitLoops": EPD_IT8951_GetLastWaitLoops().int,
    "busyPin": EPD_IT8951_GetLastBusyPin().int,
    "lutafsr": EPD_IT8951_GetLastLUTAFSR().int
  }

proc logIt8951(stage: string, extra: JsonNode = nil) =
  if activeDriver == nil or activeDriver.logger == nil:
    return

  var payload = %*{"event": "driver:waveshare:it8951", "stage": stage}
  let status = it8951Status()
  for key, value in status.pairs:
    payload[key] = value
  if extra != nil and extra.kind == JObject:
    for key, value in extra.pairs:
      payload[key] = value
  activeDriver.logger.log(payload)

proc raiseIt8951Error(context: string) =
  let code = EPD_IT8951_GetLastErrorCode()
  if code == 0:
    return

  let message = $EPD_IT8951_GetLastErrorMessage()
  logIt8951(context & ":error", %*{"code": code, "message": message})
  raise newException(Exception, "IT8951 " & context & " failed: " & message)

proc EPD_10IN3_Init*(self: Driver): UBYTE =
  activeDriver = self
  if initDone:
    logIt8951("init:alreadyInitialized")
    return 0.UBYTE

  EPD_IT8951_ClearLastError()

  let vcom = (abs(if self.vcom == 0: -1.5 else: self.vcom) * 1000.float64).UWORD
  logIt8951("init:start", %*{"vcom": vcom.int})

  Dev_Info = EPD_IT8951_Init(vcom)
  raiseIt8951Error("init")

  if (Dev_Info.Panel_W != EPD_10IN3_WIDTH) or (Dev_Info.Panel_H != EPD_10IN3_HEIGHT):
    let message = "Panel size mismatch, expected " & $EPD_10IN3_WIDTH & "x" & $EPD_10IN3_HEIGHT &
      " but got " & $Dev_Info.Panel_W & "x" & $Dev_Info.Panel_H
    logIt8951("init:error", %*{
      "message": message,
      "panelWidth": Dev_Info.Panel_W.int,
      "panelHeight": Dev_Info.Panel_H.int
    })
    raise newException(Exception, message)

  Init_Target_Memory_Addr =
    Dev_Info.Memory_Addr_L.UDouble or (Dev_Info.Memory_Addr_H.UDouble shl 16)

  initDone = true
  logIt8951("init:done", %*{
    "panelWidth": Dev_Info.Panel_W.int,
    "panelHeight": Dev_Info.Panel_H.int,
    "targetMemoryAddr": Init_Target_Memory_Addr.int
  })
  return 0.UBYTE

proc EPD_10IN3_Clear*() =
  if initDone:
    EPD_IT8951_ClearLastError()
    logIt8951("clear:start")
    EPD_IT8951_Clear_Refresh(Dev_Info, Init_Target_Memory_Addr, INIT_Mode)
    raiseIt8951Error("clear")
    logIt8951("clear:done")

proc EPD_10IN3_16Gray_Display*(Image: ptr UBYTE) =
  if initDone:
    EPD_IT8951_ClearLastError()
    logIt8951("display:start", %*{
      "width": EPD_10IN3_WIDTH,
      "height": EPD_10IN3_HEIGHT
    })
    EPD_IT8951_4bp_Refresh(Image, 0, 0, EPD_10IN3_WIDTH, EPD_10IN3_HEIGHT, false, Init_Target_Memory_Addr, false)
    raiseIt8951Error("display")
    logIt8951("display:done")

proc EPD_10IN3_Sleep*() =
  if initDone:
    EPD_IT8951_ClearLastError()
    logIt8951("sleep:start")
    EPD_IT8951_Sleep()
    raiseIt8951Error("sleep")
    initDone = false
    logIt8951("sleep:done")
