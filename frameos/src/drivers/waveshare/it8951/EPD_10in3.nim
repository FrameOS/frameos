# Providing a familiar interface for the EPD 10in3 driver
import
  DEV_Config,
  IT8951,
  drivers/waveshare/types

const
  EPD_10IN3_WIDTH* = 1872
  EPD_10IN3_HEIGHT* = 1404

var initDone = false
var Dev_Info: IT8951_Dev_Info
var Init_Target_Memory_Addr: UDOUBLE

proc EPD_10IN3_Init*(self: Driver): UBYTE =
  if initDone:
    echo "EPD 10in3 already initialized"
    return 0.UBYTE

  let vcom = (abs(if self.vcom == 0: -1.5 else: self.vcom) * 1000.float64).UWORD
  echo "Initializing EPD 10in3 with VCOM: ", vcom

  Dev_Info = EPD_IT8951_Init(vcom)

  if (Dev_Info.Panel_W != EPD_10IN3_WIDTH) or (Dev_Info.Panel_H != EPD_10IN3_HEIGHT):
    echo "Panel size mismatch, expected ", EPD_10IN3_WIDTH, "x", EPD_10IN3_HEIGHT, " but got ", Dev_Info.Panel_W, "x",
        Dev_Info.Panel_H
    return -1.UBYTE

  Init_Target_Memory_Addr =
    Dev_Info.Memory_Addr_L.UDouble or (Dev_Info.Memory_Addr_H.UDouble shl 16)

  initDone = true

proc EPD_10IN3_Clear*() =
  if initDone:
    EPD_IT8951_Clear_Refresh(Dev_Info, Init_Target_Memory_Addr, INIT_Mode)

proc EPD_10IN3_16Gray_Display*(Image: ptr UBYTE) =
  if initDone:
    EPD_IT8951_4bp_Refresh(Image, 0, 0, EPD_10IN3_WIDTH, EPD_10IN3_HEIGHT, false, Init_Target_Memory_Addr, false)

proc EPD_10IN3_Sleep*() =
  if initDone:
    EPD_IT8951_Sleep()
