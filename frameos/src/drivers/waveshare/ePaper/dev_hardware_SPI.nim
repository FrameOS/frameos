## ***************************************************************************
##  | File        :   dev_hardware_SPI.h
##  | Author      :   Waveshare team
##  | Function    :   Read and write /dev/SPI,  hardware SPI
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2019-06-26
##  | Info        :   Basic version
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
  DEV_HARDWARE_SPI_DEBUG* = 0

const
  SPI_CPHA* = 0x01
  SPI_CPOL* = 0x02
  SPI_MODE_0* = (0 or 0)
  SPI_MODE_1* = (0 or SPI_CPHA)
  SPI_MODE_2* = (SPI_CPOL or 0)
  SPI_MODE_3* = (SPI_CPOL or SPI_CPHA)

type
  SPIMode* = enum
    SPI_MODE0 = SPI_MODE_0, ##   CPOL = 0, CPHA = 0
    SPI_MODE1 = SPI_MODE_1, ##   CPOL = 0, CPHA = 1
    SPI_MODE2 = SPI_MODE_2, ##   CPOL = 1, CPHA = 0
    SPI_MODE3 = SPI_MODE_3  ##   CPOL = 1, CPHA = 1
  SPICSEN* = enum
    DISABLE = 0, ENABLE = 1
  SPIChipSelect* = enum
    SPI_CS_Mode_LOW = 0,  ##     Chip Select 0
    SPI_CS_Mode_HIGH = 1, ##     Chip Select 1
    SPI_CS_Mode_NONE = 3  ##   No CS, control it yourself
  SPIBitOrder* = enum
    SPI_BIT_ORDER_LSBFIRST = 0, ##  LSB First
    SPI_BIT_ORDER_MSBFIRST = 1  ##  MSB First
  BusMode* = enum
    SPI_3WIRE_Mode = 0, SPI_4WIRE_Mode = 1






##
##  Define SPI attribute
##

type
  HARDWARE_SPI* {.bycopy.} = object
    ## GPIO
    SCLK_PIN*: uint16_t
    MOSI_PIN*: uint16_t
    MISO_PIN*: uint16_t
    CS0_PIN*: uint16_t
    CS1_PIN*: uint16_t
    speed*: uint32_t
    mode*: uint16_t
    delay*: uint16_t
    fd*: cint


proc DEV_HARDWARE_SPI_begin*(SPI_device: cstring) {.
    importc: "DEV_HARDWARE_SPI_begin".}
proc DEV_HARDWARE_SPI_beginSet*(SPI_device: cstring; mode: SPIMode;
    speed: uint32_t) {.
    importc: "DEV_HARDWARE_SPI_beginSet".}
proc DEV_HARDWARE_SPI_end*() {.importc: "DEV_HARDWARE_SPI_end".}
proc DEV_HARDWARE_SPI_setSpeed*(speed: uint32_t): cint {.
    importc: "DEV_HARDWARE_SPI_setSpeed".}
proc DEV_HARDWARE_SPI_TransferByte*(buf: uint8_t): uint8_t {.
    importc: "DEV_HARDWARE_SPI_TransferByte".}
proc DEV_HARDWARE_SPI_Transfer*(buf: ptr uint8_t; len: uint32_t): cint {.
    importc: "DEV_HARDWARE_SPI_Transfer".}
proc DEV_HARDWARE_SPI_SetDataInterval*(us: uint16_t) {.
    importc: "DEV_HARDWARE_SPI_SetDataInterval".}
proc DEV_HARDWARE_SPI_SetBusMode*(mode: BusMode): cint {.
    importc: "DEV_HARDWARE_SPI_SetBusMode".}
proc DEV_HARDWARE_SPI_SetBitOrder*(Order: SPIBitOrder): cint {.
    importc: "DEV_HARDWARE_SPI_SetBitOrder".}
proc DEV_HARDWARE_SPI_ChipSelect*(CS_Mode: SPIChipSelect): cint {.
    importc: "DEV_HARDWARE_SPI_ChipSelect".}
proc DEV_HARDWARE_SPI_CSEN*(EN: SPICSEN): cint {.importc: "DEV_HARDWARE_SPI_CSEN".}
proc DEV_HARDWARE_SPI_Mode*(mode: SPIMode): cint {.importc: "DEV_HARDWARE_SPI_Mode".}
