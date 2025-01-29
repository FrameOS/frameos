{.compile: "IT8951.c".}
## ***************************************************************************
##  | File      	:   EPD_IT8951.h
##  | Author      :   Waveshare team
##  | Function    :   IT8951 Common driver
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2019-09-17
##  | Info        :
##  -----------------------------------------------------------------------------
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

var INIT_Mode*: UBYTE

var GC16_Mode*: UBYTE

var A2_Mode*: UBYTE

type
  IT8951_Load_Img_Info* {.bycopy.} = object
    Endian_Type*: UWORD
    Pixel_Format*: UWORD
    Rotate*: UWORD
    Source_Buffer_Addr*: ptr UBYTE
    Target_Memory_Addr*: UDOUBLE

  IT8951_Area_Img_Info* {.bycopy.} = object
    Area_X*: UWORD
    Area_Y*: UWORD
    Area_W*: UWORD
    Area_H*: UWORD

  IT8951_Dev_Info* {.bycopy.} = object
    Panel_W*: UWORD
    Panel_H*: UWORD
    Memory_Addr_L*: UWORD
    Memory_Addr_H*: UWORD
    FW_Version*: array[8, UWORD]
    LUT_Version*: array[8, UWORD]


## -----------------------------------------------------------------------
## IT8951 Command defines
## ------------------------------------------------------------------------

const
  IT8951_TCON_SYS_RUN* = 0x0001
  IT8951_TCON_STANDBY* = 0x0002
  IT8951_TCON_SLEEP* = 0x0003
  IT8951_TCON_REG_RD* = 0x0010
  IT8951_TCON_REG_WR* = 0x0011
  IT8951_TCON_MEM_BST_RD_T* = 0x0012
  IT8951_TCON_MEM_BST_RD_S* = 0x0013
  IT8951_TCON_MEM_BST_WR* = 0x0014
  IT8951_TCON_MEM_BST_END* = 0x0015
  IT8951_TCON_LD_IMG* = 0x0020
  IT8951_TCON_LD_IMG_AREA* = 0x0021
  IT8951_TCON_LD_IMG_END* = 0x0022
  USDEF_I80_CMD_DPY_AREA* = 0x0034
  USDEF_I80_CMD_GET_DEV_INFO* = 0x0302
  USDEF_I80_CMD_DPY_BUF_AREA* = 0x0037
  USDEF_I80_CMD_VCOM* = 0x0039

## -----------------------------------------------------------------------
##  IT8951 Mode defines
## ------------------------------------------------------------------------

const
  IT8951_ROTATE_0* = 0
  IT8951_ROTATE_90* = 1
  IT8951_ROTATE_180* = 2
  IT8951_ROTATE_270* = 3
  IT8951_2BPP* = 0
  IT8951_3BPP* = 1
  IT8951_4BPP* = 2
  IT8951_8BPP* = 3
  IT8951_LDIMG_L_ENDIAN* = 0
  IT8951_LDIMG_B_ENDIAN* = 1

## -----------------------------------------------------------------------
## IT8951 Registers defines
## ------------------------------------------------------------------------

const
  DISPLAY_REG_BASE* = 0x1000
  LUT0EWHR* = (DISPLAY_REG_BASE + 0x00)
  LUT0XYR* = (DISPLAY_REG_BASE + 0x40)
  LUT0BADDR* = (DISPLAY_REG_BASE + 0x80)
  LUT0MFN* = (DISPLAY_REG_BASE + 0xC0)
  LUT01AF* = (DISPLAY_REG_BASE + 0x114)
  UP0SR* = (DISPLAY_REG_BASE + 0x134)
  UP1SR* = (DISPLAY_REG_BASE + 0x138)
  LUT0ABFRV* = (DISPLAY_REG_BASE + 0x13C)
  UPBBADDR* = (DISPLAY_REG_BASE + 0x17C)
  LUT0IMXY* = (DISPLAY_REG_BASE + 0x180)
  LUTAFSR* = (DISPLAY_REG_BASE + 0x224)
  BGVR* = (DISPLAY_REG_BASE + 0x250)
  SYS_REG_BASE* = 0x0000
  I80CPCR* = (SYS_REG_BASE + 0x04)
  MCSR_BASE_ADDR* = 0x0200
  MCSR* = (MCSR_BASE_ADDR + 0x0000)
  LISAR* = (MCSR_BASE_ADDR + 0x0008)

##
## void EPD_IT8951_SystemRun();
## void EPD_IT8951_Standby();
## void EPD_IT8951_Sleep();
##
## UWORD EPD_IT8951_ReadReg(UWORD Reg_Address);
## void EPD_IT8951_WriteReg(UWORD Reg_Address,UWORD Reg_Value);
## UWORD EPD_IT8951_GetVCOM(void);
## void EPD_IT8951_SetVCOM(UWORD VCOM);
##
## void EPD_IT8951_LoadImgStart( IT8951_Load_Img_Info* Load_Img_Info );
## void EPD_IT8951_LoadImgAreaStart( IT8951_Load_Img_Info* Load_Img_Info, IT8951_Area_Img_Info* Area_Img_Info );
## void EPD_IT8951_LoadImgEnd(void);
##
## void EPD_IT8951_GetSystemInfo(void* Buf);
## void EPD_IT8951_SetTargetMemoryAddr(UDOUBLE Target_Memory_Addr);
## void EPD_IT8951_WaitForDisplayReady(void);
##
##
## void EPD_IT8951_HostAreaPackedPixelWrite_8bp(IT8951_Load_Img_Info*Load_Img_Info,IT8951_Area_Img_Info*Area_Img_Info);
##
## void EPD_IT8951_HostAreaPackedPixelWrite_1bp(IT8951_Load_Img_Info*Load_Img_Info,IT8951_Area_Img_Info*Area_Img_Info, bool Packed_Write);
##
## void EPD_IT8951_HostAreaPackedPixelWrite_2bp(IT8951_Load_Img_Info*Load_Img_Info,IT8951_Area_Img_Info*Area_Img_Info, bool Packed_Write);
##
## void EPD_IT8951_Display_Area(UWORD X,UWORD Y,UWORD W,UWORD H,UWORD Mode);
## void EPD_IT8951_Display_AreaBuf(UWORD X,UWORD Y,UWORD W,UWORD H,UWORD Mode, UDOUBLE Target_Memory_Addr);
##
## void EPD_IT8951_Display_1bp(UWORD X, UWORD Y, UWORD W, UWORD H, UWORD Mode,UDOUBLE Target_Memory_Addr, UBYTE Front_Gray_Val, UBYTE Back_Gray_Val);
##

proc Enhance_Driving_Capability*() {.importc: "Enhance_Driving_Capability".}
proc EPD_IT8951_SystemRun*() {.importc: "EPD_IT8951_SystemRun".}
proc EPD_IT8951_Standby*() {.importc: "EPD_IT8951_Standby".}
proc EPD_IT8951_Sleep*() {.importc: "EPD_IT8951_Sleep".}
proc EPD_IT8951_Init*(VCOM: UWORD): IT8951_Dev_Info {.importc: "EPD_IT8951_Init".}
proc EPD_IT8951_Clear_Refresh*(Dev_Info: IT8951_Dev_Info;
                              Target_Memory_Addr: UDOUBLE; Mode: UWORD) {.
    importc: "EPD_IT8951_Clear_Refresh".}
proc EPD_IT8951_1bp_Refresh*(Frame_Buf: ptr UBYTE; X: UWORD; Y: UWORD; W: UWORD; H: UWORD;
                            Mode: UBYTE; Target_Memory_Addr: UDOUBLE;
                            Packed_Write: bool) {.
    importc: "EPD_IT8951_1bp_Refresh".}
proc EPD_IT8951_1bp_Multi_Frame_Write*(Frame_Buf: ptr UBYTE; X: UWORD; Y: UWORD;
                                      W: UWORD; H: UWORD;
                                      Target_Memory_Addr: UDOUBLE;
                                      Packed_Write: bool) {.
    importc: "EPD_IT8951_1bp_Multi_Frame_Write".}
proc EPD_IT8951_1bp_Multi_Frame_Refresh*(X: UWORD; Y: UWORD; W: UWORD; H: UWORD;
                                        Target_Memory_Addr: UDOUBLE) {.
    importc: "EPD_IT8951_1bp_Multi_Frame_Refresh".}
proc EPD_IT8951_2bp_Refresh*(Frame_Buf: ptr UBYTE; X: UWORD; Y: UWORD; W: UWORD; H: UWORD;
                            Hold: bool; Target_Memory_Addr: UDOUBLE;
                            Packed_Write: bool) {.
    importc: "EPD_IT8951_2bp_Refresh".}
proc EPD_IT8951_4bp_Refresh*(Frame_Buf: ptr UBYTE; X: UWORD; Y: UWORD; W: UWORD; H: UWORD;
                            Hold: bool; Target_Memory_Addr: UDOUBLE;
                            Packed_Write: bool) {.
    importc: "EPD_IT8951_4bp_Refresh".}
proc EPD_IT8951_8bp_Refresh*(Frame_Buf: ptr UBYTE; X: UWORD; Y: UWORD; W: UWORD; H: UWORD;
                            Hold: bool; Target_Memory_Addr: UDOUBLE) {.
    importc: "EPD_IT8951_8bp_Refresh".}
