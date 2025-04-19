{.compile: "DEV_Config.c".}
{.passl: "-llgpio -lm -lrt".}
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

## !!!Ignored construct:  # _DEV_CONFIG_H_ [NewLine] # _DEV_CONFIG_H_ [NewLine] # < stdint . h > [NewLine] # < stdlib . h > [NewLine] # < stdio . h > [NewLine] # < unistd . h > [NewLine] # < errno . h > [NewLine] # < stdio . h > [NewLine] # < string . h > [NewLine] # < lgpio . h > [NewLine] # Debug ( fmt , ... ) printf ( fmt , ## __VA_ARGS__ ) [NewLine] # LFLAGS 0 [NewLine] # NUM_MAXBUF 4 [NewLine] # HIGH 0x1 [NewLine] # LOW 0x0 [NewLine]
##  GPIO
##  # EPD_RST_PIN 17 [NewLine] # EPD_CS_PIN 8 [NewLine] # EPD_BUSY_PIN 24 [NewLine]
##  data
##  # UBYTE uint8_t [NewLine] # UWORD uint16_t [NewLine] # UDOUBLE uint32_t [NewLine] ------------------------------------------------------------------------------------------------------ void DEV_Digital_Write ( UWORD Pin , UBYTE Value ) ;
## Error: did not expect ##!!!
type
  UBYTE* = uint8
  UWORD* = uint16
  UDOUBLE* = uint32

proc DEV_Digital_Read*(Pin: UWORD): UBYTE {.importc: "DEV_Digital_Read".}
proc DEV_SPI_WriteByte*(Value: UBYTE) {.importc: "DEV_SPI_WriteByte".}
proc DEV_SPI_ReadByte*(): UBYTE {.importc: "DEV_SPI_ReadByte".}
proc DEV_Delay_ms*(xms: UDOUBLE) {.importc: "DEV_Delay_ms".}
proc DEV_Delay_us*(xus: UDOUBLE) {.importc: "DEV_Delay_us".}
proc DEV_Module_Init*(): UBYTE {.importc: "DEV_Module_Init".}
proc DEV_Module_Exit*() {.importc: "DEV_Module_Exit".}
