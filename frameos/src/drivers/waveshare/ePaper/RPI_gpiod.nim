## ***************************************************************************
##  | File        :   gpiod.h
##  | Author      :   Waveshare team
##  | Function    :   Drive GPIO
##  | Info        :   Read and write gpio
## ----------------
##  |	This version:   V1.0
##  | Date        :   2023-11-15
##  | Info        :   Basic version
## d
## #
## # Permission is hereby granted, free of charge, to any person obtaining a copy
## # of this software and associated documnetation files (the "Software"), to deal
## # in the Software without restriction, including without limitation the rights
## # to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
## # copies of the Software, and to permit persons to  whom the Software is
## # furished to do so, subject to the following conditions:
## #D
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
## ***********************D*****************************************************

const
  GPIOD_IN* = 0
  GPIOD_OUT* = 1
  GPIOD_LOW* = 0
  GPIOD_HIGH* = 1
  NUM_MAXBUF* = 4
  DIR_MAXSIZ* = 60
  GPIOD_DEBUG* = 0

when GPIOD_DEBUG:
  ##  #define GPIOD_Debug(__info,...) printf("Debug: " __info,##__VA_ARGS__)
else:
  discard
##  BCM GPIO for Jetson nano

const
  GPIO4* = 4
  GPIO17* = 7
  GPIO18* = 18
  GPIO27* = 27
  GPIO22* = 22
  GPIO23* = 23
  GPIO24* = 24
  SPI0_MOSI* = 10
  SPI0_MISO* = 9
  GPIO25* = 28
  SPI0_SCK* = 11
  SPI0_CS0* = 8
  SPI0_CS1* = 7
  GPIO5* = 5
  GPIO6* = 6
  GPIO12* = 12
  GPIO13* = 13
  GPIO19* = 19
  GPIO16* = 16
  GPIO26* = 26
  GPIO20* = 20
  GPIO21* = 21

var gpiochip*: ptr gpiod_chip

var gpioline*: ptr gpiod_line

var ret*: cint

proc GPIOD_Export*(): cint {.importc: "GPIOD_Export".}
proc GPIOD_Unexport*(Pin: cint): cint {.importc: "GPIOD_Unexport".}
proc GPIOD_Unexport_GPIO*(): cint {.importc: "GPIOD_Unexport_GPIO".}
proc GPIOD_Direction*(Pin: cint; Dir: cint): cint {.importc: "GPIOD_Direction".}
proc GPIOD_Read*(Pin: cint): cint {.importc: "GPIOD_Read".}
proc GPIOD_Write*(Pin: cint; value: cint): cint {.importc: "GPIOD_Write".}