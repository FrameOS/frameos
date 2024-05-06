{.compile: "DEV_Config.c".}
{.passl: "-llgpio".}
## ***************************************************************************
##  | File      	:   DEV_Config.h
##  | Author      :   Waveshare team
##  | Function    :   Hardware underlying interface
##  | Info        :
##                 Used to shield the underlying layers of each master
##                 and enhance portability,software spi.
## ----------------
##  |	This version:   V1.0
##  | Date        :   2018-11-29
##  | Info        :
##
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

const
  LFLAGS* = 0
  NUM_MAXBUF* = 4

##
##  data
##

type
  UBYTE* = uint8
  UWORD* = uint16
  UDOUBLE* = uint32

##
##  GPIO config
##

const
  EPD_SCK_PIN* = 11
  EPD_MOSI_PIN* = 10
  EPD_M1_CS_PIN* = 8
  EPD_S1_CS_PIN* = 7
  EPD_M2_CS_PIN* = 17
  EPD_S2_CS_PIN* = 18
  EPD_M1S1_DC_PIN* = 13
  EPD_M2S2_DC_PIN* = 22
  EPD_M1S1_RST_PIN* = 6
  EPD_M2S2_RST_PIN* = 23
  EPD_M1_BUSY_PIN* = 5
  EPD_S1_BUSY_PIN* = 19
  EPD_M2_BUSY_PIN* = 27
  EPD_S2_BUSY_PIN* = 24

##
##  SPI communication mode
##

type
  SPIMode* = enum
    Mode0,                    ##  Clock Polarity is 0 and Clock Phase is 0
    Mode1,                    ##  Clock Polarity is 0 and Clock Phase is 1
    Mode2,                    ##  Clock Polarity is 1 and Clock Phase is 0
    Mode3                     ##  Clock Polarity is 1 and Clock Phase is 1


##
##  Define SPI type
##

type
  SPIType* = enum
    Master, Slave


##
##  Define SPI attribute
##

type
  SOFTWARE_SPI* {.bycopy.} = object
    SCLK_PIN*: UWORD
    MOSI_PIN*: UWORD
    MISO_PIN*: UWORD
    CS_PIN*: UWORD
    Mode*: SPIMode
    Type*: SPIType
    Clock*: UWORD


## ------------------------------------------------------------------------------------------------------

proc DEV_Digital_Write*(Pin: UWORD; Value: UBYTE) {.importc: "DEV_Digital_Write".}
proc DEV_Digital_Read*(Pin: UWORD): UBYTE {.importc: "DEV_Digital_Read".}
proc DEV_Delay_us*(xus: UWORD) {.importc: "DEV_Delay_us".}
proc DEV_Delay_ms*(xms: UDOUBLE) {.importc: "DEV_Delay_ms".}
proc DEV_SPI_WriteByte*(value: UBYTE) {.importc: "DEV_SPI_WriteByte".}
proc DEV_SPI_ReadByte*(Reg: UBYTE): UBYTE {.importc: "DEV_SPI_ReadByte".}
proc DEV_ModuleInit*(): UBYTE {.importc: "DEV_ModuleInit".}
proc DEV_ModuleExit*() {.importc: "DEV_ModuleExit".}