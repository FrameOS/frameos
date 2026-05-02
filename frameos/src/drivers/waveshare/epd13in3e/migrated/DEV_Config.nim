{.compile: "DEV_Config.c".}
{.passl: "-llgpio".}
## ***************************************************************************
##  | File        :   DEV_Config.h
##  | Author      :   Waveshare team
##  | Function    :   Hardware underlying interface
##  | Info        :
##                 Used to shield the underlying layers of each master
##                 and enhance portability
## ----------------
##  | This version:   V2.0
##  | Date        :   2018-10-30
##  | Info        :
## ****************************************************************************

const
  LFLAGS* = 0
  NUM_MAXBUF* = 4

type
  UBYTE* = uint8
  UWORD* = uint16
  UDOUBLE* = uint32

var EPD_RST_PIN*: cint
var EPD_DC_PIN*: cint
var EPD_CS_PIN*: cint
var EPD_CS_M_PIN*: cint
var EPD_CS_S_PIN*: cint
var EPD_BUSY_PIN*: cint
var EPD_PWR_PIN*: cint
var EPD_MOSI_PIN*: cint
var EPD_SCLK_PIN*: cint

proc DEV_Digital_Write*(Pin: UWORD; Value: UBYTE) {.importc: "DEV_Digital_Write".}
proc DEV_Digital_Read*(Pin: UWORD): UBYTE {.importc: "DEV_Digital_Read".}
proc DEV_SPI_WriteByte*(Value: UBYTE) {.importc: "DEV_SPI_WriteByte".}
proc DEV_SPI_Write_nByte*(pData: ptr uint8; Len: uint32) {.importc: "DEV_SPI_Write_nByte".}
proc DEV_Delay_ms*(xms: UDOUBLE) {.importc: "DEV_Delay_ms".}
proc DEV_SPI_SendData*(Reg: UBYTE) {.importc: "DEV_SPI_SendData".}
proc DEV_SPI_SendData_nByte*(pData: ptr UBYTE; Len: UDOUBLE) {.
    importc: "DEV_SPI_SendData_nByte".}
proc DEV_SPI_SendnData*(Reg: ptr UBYTE) {.importc: "DEV_SPI_SendnData".}
proc DEV_SPI_ReadData*(): UBYTE {.importc: "DEV_SPI_ReadData".}
proc DEV_Module_Init*(): UBYTE {.importc: "DEV_Module_Init".}
proc DEV_Module_Exit*() {.importc: "DEV_Module_Exit".}
