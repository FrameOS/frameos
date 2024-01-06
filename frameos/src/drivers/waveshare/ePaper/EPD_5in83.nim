{.compile: "EPD_5in83.c".}
## ***************************************************************************
##  | File      	:   EPD_5in83.h
##  | Author      :   Waveshare team
##  | Function    :   5.83inch e-paper
##  | Info        :
## ----------------
##  |	This version:   V3.0
##  | Date        :   2019-06-13
##  | Info        :
##  -----------------------------------------------------------------------------
##  V3.0(2019-06-13):
##  1.Change:
##     EPD_Reset() => EPD_5IN83_Reset()
##     EPD_SendCommand() => EPD_5IN83_SendCommand()
##     EPD_SendData() => EPD_5IN83_SendData()
##     EPD_WaitUntilIdle() => EPD_5IN83_ReadBusy()
##     EPD_SetFullReg() => EPD_5IN83_SetFullReg()
##     EPD_SetPartReg() => EPD_5IN83_SetPartReg()
##     EPD_TurnOnDisplay() => EPD_5IN83_TurnOnDisplay()
##     EPD_Init() => EPD_5IN83_Init()
##     EPD_Clear() => EPD_5IN83_Clear()
##     EPD_Display() => EPD_5IN83_Display()
##     EPD_Sleep() => EPD_5IN83_Sleep()
##  2.remove commands define:
##     #define PANEL_SETTING                               0x00
##     #define POWER_SETTING                               0x01
##     #define POWER_OFF                                   0x02
##     #define POWER_OFF_SEQUENCE_SETTING                  0x03
##     #define POWER_ON                                    0x04
##     #define POWER_ON_MEASURE                            0x05
##     #define BOOSTER_SOFT_START                          0x06
##     #define DEEP_SLEEP                                  0x07
##     #define DATA_START_TRANSMISSION_1                   0x10
##     #define DATA_STOP                                   0x11
##     #define DISPLAY_REFRESH                             0x12
##     #define DATA_START_TRANSMISSION_2                   0x13
##     #define VCOM_LUT                                    0x20
##     #define W2W_LUT                                     0x21
##     #define B2W_LUT                                     0x22
##     #define W2B_LUT                                     0x23
##     #define B2B_LUT                                     0x24
##     #define PLL_CONTROL                                 0x30
##     #define TEMPERATURE_SENSOR_CALIBRATION              0x40
##     #define TEMPERATURE_SENSOR_SELECTION                0x41
##     #define TEMPERATURE_SENSOR_WRITE                    0x42
##     #define TEMPERATURE_SENSOR_READ                     0x43
##     #define VCOM_AND_DATA_INTERVAL_SETTING              0x50
##     #define LOW_POWER_DETECTION                         0x51
##     #define TCON_SETTING                                0x60
##     #define RESOLUTION_SETTING                          0x61
##     #define GET_STATUS                                  0x71
##     #define AUTO_MEASURE_VCOM                           0x80
##     #define READ_VCOM_VALUE                             0x81
##     #define VCM_DC_SETTING                              0x82
##     #define PARTIAL_WINDOW                              0x90
##     #define PARTIAL_IN                                  0x91
##     #define PARTIAL_OUT                                 0x92
##     #define PROGRAM_MODE                                0xA0
##     #define ACTIVE_PROGRAM                              0xA1
##     #define READ_OTP_DATA                               0xA2
##     #define POWER_SAVING                                0xE3
##  -----------------------------------------------------------------------------
##  V2.0(2018-11-09):
##  1.Remove:ImageBuff[EPD_HEIGHT * EPD_WIDTH / 8]
##  2.Change:EPD_Display(UBYTE *Image)
##    Need to pass parameters: pointer to cached data
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

import
  DEV_Config

const
  EPD_5IN83_WIDTH* = 600
  EPD_5IN83_HEIGHT* = 448

proc EPD_5IN83_Init*() {.importc: "EPD_5IN83_Init".}
proc EPD_5IN83_Clear*() {.importc: "EPD_5IN83_Clear".}
proc EPD_5IN83_Display*(Image: ptr UBYTE) {.importc: "EPD_5IN83_Display".}
proc EPD_5IN83_Sleep*() {.importc: "EPD_5IN83_Sleep".}