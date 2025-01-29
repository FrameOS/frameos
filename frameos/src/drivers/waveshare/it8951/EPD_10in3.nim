# Providing a familiar interface for the EPD 10in3 driver
import
  DEV_Config,
  IT8951,
  std/bitops

const
  EPD_10IN3_WIDTH* = 1872
  EPD_10IN3_HEIGHT* = 1404

var initDone = false
var Dev_Info: IT8951_Dev_Info
var Init_Target_Memory_Addr: UWORD
# var A2_Mode = 6

proc EPD_10IN3_Init*(): UBYTE =
  echo "Initializing?"
  if DEV_Module_Init() != 0:
    return -1.UBYTE
  echo "Initializing!"

  # let temp = -1.48
  # let vcom = (temp * 1000.float64).UWORD
  let vcom = 1480.UWORD

  # echo "Temp: ", temp
  echo "VCOM: ", vcom
  Dev_Info = EPD_IT8951_Init(vcom)

  echo Dev_Info

  if (Dev_Info.Panel_W != EPD_10IN3_WIDTH) or (Dev_Info.Panel_H != EPD_10IN3_HEIGHT):
    echo "Panel size mismatch, expected ", EPD_10IN3_WIDTH, "x", EPD_10IN3_HEIGHT, " but got ", Dev_Info.Panel_W, "x",
        Dev_Info.Panel_H
    return -1.UBYTE

  Init_Target_Memory_Addr = bitor(Dev_Info.Memory_Addr_L, (Dev_Info.Memory_Addr_H shl 16))

  echo "Memory Addr: ", Init_Target_Memory_Addr

  # TODO: support the other modes
  # char* LUT_Version = (char*)Dev_Info.LUT_Version;
  # if( strcmp(LUT_Version, "M641") == 0 ){
  #     # //6inch e-Paper HAT(800,600), 6inch HD e-Paper HAT(1448,1072), 6inch HD touch e-Paper HAT(1448,1072)
  #     A2_Mode = 4;
  #     Four_Byte_Align = true;
  # }else if( strcmp(LUT_Version, "M841_TFAB512") == 0 ){
  #     # //Another firmware version for 6inch HD e-Paper HAT(1448,1072), 6inch HD touch e-Paper HAT(1448,1072)
  #     A2_Mode = 6;
  #     Four_Byte_Align = true;
  # }else if( strcmp(LUT_Version, "M841") == 0 ){
  #     # //9.7inch e-Paper HAT(1200,825)
  #     A2_Mode = 6;
  # }else if( strcmp(LUT_Version, "M841_TFA2812") == 0 ){
  #     # //7.8inch e-Paper HAT(1872,1404)
  #     A2_Mode = 6;
  # }else if( strcmp(LUT_Version, "M841_TFA5210") == 0 ){
  #     # //10.3inch e-Paper HAT(1872,1404)
  #     A2_Mode = 6;
  # }else{
  #     # //default set to 6 as A2 Mode
  #     A2_Mode = 6;
  # }

  initDone = true
  echo "Init done"

proc EPD_10IN3_Clear*() =
  echo "Clearing?"
  if initDone:
    echo "Clearing!"
    EPD_IT8951_Clear_Refresh(Dev_Info, Init_Target_Memory_Addr, INIT_Mode)

proc EPD_10IN3_16Gray_Display*(Image: ptr UBYTE) =
  echo "Displaying?"
  if initDone:
    echo "Displaying!"
    EPD_IT8951_4bp_Refresh(Image, 0, 0, EPD_10IN3_WIDTH, EPD_10IN3_HEIGHT, false, Init_Target_Memory_Addr, false)

proc EPD_10IN3_Sleep*() =
  echo "Sleeping?"
  if initDone:
    echo "Sleeping!"
    EPD_IT8951_Sleep()
