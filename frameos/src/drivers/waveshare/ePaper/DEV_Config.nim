{.compile: "DEV_Config.c".}
{.passl: "-llgpio".}
## ***************************************************************************
##  | File      	:   DEV_Config.h
##  | Author      :   Waveshare team
##  | Function    :   Hardware underlying interface
##  | Info        :
##                 Used to shield the underlying layers of each master
##                 and enhance portability
## ----------------
##  |	This version:   V2.0
##  | Date        :   2018-10-30
##  | Info        :
##  1.add:
##    UBYTE\UWORD\UDOUBLE
##  2.Change:
##    EPD_RST -> EPD_RST_PIN
##    EPD_DC -> EPD_DC_PIN
##    EPD_CS -> EPD_CS_PIN
##    EPD_BUSY -> EPD_BUSY_PIN
##  3.Remote:
##    EPD_RST_1\EPD_RST_0
##    EPD_DC_1\EPD_DC_0
##    EPD_CS_1\EPD_CS_0
##    EPD_BUSY_1\EPD_BUSY_0
##  3.add:
##    #define DEV_Digital_Write(_pin, _value) bcm2835_GPIOI_write(_pin, _value)
##    #define DEV_Digital_Read(_pin) bcm2835_GPIOI_lev(_pin)
##    #define DEV_SPI_WriteByte(__value) bcm2835_spi_transfer(__value)
## #
## # Permission is hereby granted, free of charge, to any person obtaining a copy
## # of this software and associated documnetation files (the "Software"), to deal
## # in the Software without restriction, including without limitation the rights
## # to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
## # copies of the Software, and to permit persons to  whom the Software is
## # furished to do so, subject to the following conditions:
## #
## # The above copyright notice and this permission notice shall be included in
## # all copies or substantial portions of the Software.
## #
## # THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
## # IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
## # FITNESS OR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
## # AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
## # LIABILITY WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
## # OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
## # THE SOFTWARE.
## #
## ****************************************************************************

##
##  data
##

type
  UBYTE* = uint8
  UWORD* = uint16
  UDOUBLE* = uint32

##
##  GPIOI config
##

var EPD_RST_PIN*: cint
var EPD_DC_PIN*: cint
var EPD_CS_PIN*: cint
var EPD_BUSY_PIN*: cint
var EPD_PWR_PIN*: cint

var EPD_M1_CS_PIN*: UWORD;
var EPD_S1_CS_PIN*: UWORD;
var EPD_M2_CS_PIN*: UWORD;
var EPD_S2_CS_PIN*: UWORD;

var EPD_M1S1_DC_PIN*: UWORD;
var EPD_M2S2_DC_PIN*: UWORD;

var EPD_M1S1_RST_PIN*: UWORD;
var EPD_M2S2_RST_PIN*: UWORD;

var EPD_M1_BUSY_PIN*: UWORD;
var EPD_S1_BUSY_PIN*: UWORD;
var EPD_M2_BUSY_PIN*: UWORD;
var EPD_S2_BUSY_PIN*: UWORD;

## ------------------------------------------------------------------------------------------------------

proc DEV_Digital_Write*(Pin: UWORD; Value: UBYTE) {.importc: "DEV_Digital_Write".}
proc DEV_Digital_Read*(Pin: UWORD): UBYTE {.importc: "DEV_Digital_Read".}
proc DEV_SPI_WriteByte*(Value: UBYTE) {.importc: "DEV_SPI_WriteByte".}
proc DEV_SPI_Write_nByte*(pData: ptr uint8; Len: uint32) {.
    importc: "DEV_SPI_Write_nByte".}
proc DEV_Delay_ms*(xms: UDOUBLE) {.importc: "DEV_Delay_ms".}
proc DEV_Module_Init*(): UBYTE {.importc: "DEV_Module_Init".}
proc DEV_Module_Exit*() {.importc: "DEV_Module_Exit".}
