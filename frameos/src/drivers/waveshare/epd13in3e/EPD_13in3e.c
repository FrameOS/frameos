/*****************************************************************************
* | File        :   EPD_12in48.c
* | Author      :   Waveshare team
* | Function    :   Electronic paper driver
* | Info     :
*----------------
* | This version:   V1.0
* | Date     :   2018-11-29
* | Info     :
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documnetation files(the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to  whom the Software is
# furished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS OR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
# THE SOFTWARE.
#
******************************************************************************/
#include "EPD_13in3e.h"
#include "Debug.h"

#ifndef EPD_BUSY_TIMEOUT_MS
#define EPD_BUSY_TIMEOUT_MS 120000
#endif


// const UBYTE spiCsPin[2] = {
// 		SPI_CS0, SPI_CS1
// };
const UBYTE PSR_V[2] = {
	0xDF, 0x69
};
const UBYTE PWR_V[6] = {
	0x0F, 0x00, 0x28, 0x2C, 0x28, 0x38
};
const UBYTE POF_V[1] = {
	0x00
};
const UBYTE DRF_V[1] = {
	0x00
};
const UBYTE CDI_V[1] = {
	0xF7
};
const UBYTE TCON_V[2] = {
	0x03, 0x03
};
const UBYTE TRES_V[4] = {
	0x04, 0xB0, 0x03, 0x20
};
const UBYTE CMD66_V[6] = {
	0x49, 0x55, 0x13, 0x5D, 0x05, 0x10
};
const UBYTE EN_BUF_V[1] = {
	0x07
};
const UBYTE CCSET_V[1] = {
	0x01
};
const UBYTE PWS_V[1] = {
	0x22
};
const UBYTE AN_TM_V[9] = {
	0xC0, 0x1C, 0x1C, 0xCC, 0xCC, 0xCC, 0x15, 0x15, 0x55
};


const UBYTE AGID_V[1] = {
	0x10
};

const UBYTE BTST_P_V[2] = {
	0xE8, 0x28
};
const UBYTE BOOST_VDDP_EN_V[1] = {
	0x01
};
const UBYTE BTST_N_V[2] = {
	0xE8, 0x28
};
const UBYTE BUCK_BOOST_VDDN_V[1] = {
	0x01
};
const UBYTE TFT_VCOM_POWER_V[1] = {
	0x02
};

/* T133A01 (Seeed reTerminal E1004) tuning, from the vendor's Arduino driver
 * (T133A01_Defines.h, EPD_INIT) as mirrored by ESPHome's epaper_spi T133A01
 * model. Same register map and dual-CS routing as above; only these values
 * and the two structural differences in EPD_13IN3E_Init change. */
const UBYTE AN_TM_V_T133A01[9] = {
	0x00, 0x0C, 0x0C, 0xD9, 0xDD, 0xDD, 0x15, 0x15, 0x55
};
const UBYTE CDI_V_T133A01[1] = {
	0x37
};
const UBYTE BTST_P_V_T133A01[2] = {
	0xE0, 0x20
};
const UBYTE BTST_N_V_T133A01[2] = {
	0xE0, 0x20
};
#define DCDC_T133A01 0xA5
const UBYTE DCDC_V_T133A01[3] = {
	0x44, 0x54, 0x00
};
/* The T133A01 vendor sequence (Seeed_GFX EPD_UPDATE, mirrored by ESPHome's
 * epaper_spi_t133a01 and Seeed's GxEPD2 port) refreshes with DRF 0x01, not
 * the Waveshare 0x00, and programs the cascade setting (CCSET 0x01, both
 * chips) right before every pixel-data transfer instead of once at init.
 * Without CCSET the refresh never completes: BUSY stays low until the
 * 120 s timeout and the second controller's half shows garbage. */
const UBYTE DRF_V_T133A01[1] = {
	0x01
};

static int s_variant = EPD_13IN3E_VARIANT_WAVESHARE;

void EPD_13IN3E_SetVariant(int variant)
{
    s_variant = (variant == EPD_13IN3E_VARIANT_T133A01) ? EPD_13IN3E_VARIANT_T133A01
                                                         : EPD_13IN3E_VARIANT_WAVESHARE;
}

int EPD_13IN3E_GetVariant(void)
{
    return s_variant;
}


static void EPD_13IN3E_CS_ALL(UBYTE Value)
{
    DEV_Digital_Write(EPD_CS_M_PIN, Value);
    DEV_Digital_Write(EPD_CS_S_PIN, Value);
}


static void EPD_13IN3E_SPI_Sand(UBYTE Cmd, const UBYTE *buf, UDOUBLE Len)
{
    DEV_SPI_WriteByte(Cmd);
    DEV_SPI_Write_nByte((UBYTE *)buf,Len);
}

/* The vendor T133A01 sequence leaves 10 ms between init commands. */
static void EPD_13IN3E_Settle(void)
{
    if (s_variant == EPD_13IN3E_VARIANT_T133A01) {
        DEV_Delay_ms(10);
    }
}

/* Vendor pacing between rows of pixel data. Waveshare's reference sleeps
 * 1 ms per row, which on FreeRTOS at 100 Hz rounds up to a full 10 ms tick:
 * 3200 half-rows = 32 s per refresh. The T133A01 references send the rows
 * back to back and only yield now and then, so do the same there. */
static void EPD_13IN3E_RowPace(UDOUBLE row)
{
    if (s_variant == EPD_13IN3E_VARIANT_T133A01) {
        if ((row & 0x3F) == 0) DEV_Delay_ms(1);
        return;
    }
    DEV_Delay_ms(1);
}

static int EPD_13IN3E_ReadBusyH(const char *stage);

/* Runs before every pixel-data transfer (DTM). T133A01 only: CCSET 0x01 to
 * both chips, then wait for BUSY — Seeed_GFX EPD_PUSH_NEW_COLORS. */
static void EPD_13IN3E_PrepareData(void)
{
    if (s_variant != EPD_13IN3E_VARIANT_T133A01) return;
    EPD_13IN3E_CS_ALL(0);
    EPD_13IN3E_SPI_Sand(CCSET, CCSET_V, sizeof(CCSET_V));
    EPD_13IN3E_CS_ALL(1);
    EPD_13IN3E_ReadBusyH("prepareData:ccset");
    DEV_Delay_ms(10);
}


/******************************************************************************
function :	Software reset
parameter:
******************************************************************************/
static void EPD_13IN3E_Reset(void)
{
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(30);
    DEV_Digital_Write(EPD_RST_PIN, 0);
    DEV_Delay_ms(30);
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(30);
    DEV_Digital_Write(EPD_RST_PIN, 0);
    DEV_Delay_ms(30);
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(30);
}

/******************************************************************************
function :	send command
parameter:
     Reg : Command register
******************************************************************************/

static void EPD_13IN3E_SendCommand(UBYTE Reg)
{
    DEV_SPI_WriteByte(Reg);
}

/******************************************************************************
function :	send data
parameter:
    Data : Write data
******************************************************************************/
static void EPD_13IN3E_SendData(UBYTE Reg)
{
    DEV_SPI_WriteByte(Reg);
}
static void EPD_13IN3E_SendData2(const UBYTE *buf, uint32_t Len)
{
    DEV_SPI_Write_nByte((UBYTE *)buf,Len);
}

/******************************************************************************
function :	Wait until the busy_pin goes HIGH
parameter:
******************************************************************************/
static int EPD_13IN3E_ReadBusyH(const char *stage)
{
    Debug("e-Paper busy\r\n");
    UDOUBLE busy_wait_ms = 0;
	while(!DEV_Digital_Read(EPD_BUSY_PIN)) {      //LOW: busy, HIGH: idle
        if (busy_wait_ms >= EPD_BUSY_TIMEOUT_MS) {
            Debug("e-Paper busy timeout\r\n");
            printf("EPD_13IN3E busy timeout during %s after %lu ms\r\n",
                stage ? stage : "wait",
                (unsigned long)busy_wait_ms);
            return 1;
        }
        DEV_Delay_ms(10);
        busy_wait_ms += 10;
    }
	DEV_Delay_ms(20);
    Debug("e-Paper busy release\r\n");
    return 0;
}


/******************************************************************************
function :  Turn On Display
parameter:
******************************************************************************/
static void EPD_13IN3E_TurnOnDisplay(void)
{
    printf("Write PON \r\n");
    EPD_13IN3E_CS_ALL(0);
    EPD_13IN3E_SendCommand(0x04); // POWER_ON
    EPD_13IN3E_CS_ALL(1);
    if (EPD_13IN3E_ReadBusyH("turnOnDisplay:powerOn") != 0) {
        return;
    }

    printf("Write DRF \r\n");
    DEV_Delay_ms(50);
    EPD_13IN3E_CS_ALL(0);
    if (s_variant == EPD_13IN3E_VARIANT_T133A01) {
        EPD_13IN3E_SPI_Sand(DRF, DRF_V_T133A01, sizeof(DRF_V_T133A01));
    } else {
        EPD_13IN3E_SPI_Sand(DRF, DRF_V, sizeof(DRF_V));
    }
    EPD_13IN3E_CS_ALL(1);
    if (EPD_13IN3E_ReadBusyH("turnOnDisplay:refresh") != 0) {
        return;
    }

    printf("Write POF \r\n");
    EPD_13IN3E_Settle();
    EPD_13IN3E_CS_ALL(0);
    EPD_13IN3E_SPI_Sand(POF, POF_V, sizeof(POF_V));
    EPD_13IN3E_CS_ALL(1);
    if (s_variant == EPD_13IN3E_VARIANT_T133A01) {
        /* The vendor sequence waits for power-off to finish (5 s budget);
         * the Waveshare one does not. */
        EPD_13IN3E_ReadBusyH("turnOnDisplay:powerOff");
    }
    printf("Display Done!! \r\n");
}

/******************************************************************************
function :	Initialize the e-Paper register
parameter:
******************************************************************************/
void EPD_13IN3E_Init(void)
{
	EPD_13IN3E_Reset();
    if (EPD_13IN3E_ReadBusyH("init:reset") != 0) {
        return;
    }

    const int t133a01 = (s_variant == EPD_13IN3E_VARIANT_T133A01);

    DEV_Digital_Write(EPD_CS_M_PIN, 0);
    if (t133a01) {
        EPD_13IN3E_SPI_Sand(AN_TM, AN_TM_V_T133A01, sizeof(AN_TM_V_T133A01));
    } else {
        EPD_13IN3E_SPI_Sand(AN_TM, AN_TM_V, sizeof(AN_TM_V));
    }
    EPD_13IN3E_CS_ALL(1);
    EPD_13IN3E_Settle();

    EPD_13IN3E_CS_ALL(0);
	EPD_13IN3E_SPI_Sand(CMD66, CMD66_V, sizeof(CMD66_V));
    EPD_13IN3E_CS_ALL(1);
    EPD_13IN3E_Settle();

    EPD_13IN3E_CS_ALL(0);
	EPD_13IN3E_SPI_Sand(PSR, PSR_V, sizeof(PSR_V));
    EPD_13IN3E_CS_ALL(1);
    EPD_13IN3E_Settle();

    if (t133a01) {
        /* DC/DC setting, master only — the T133A01 sequence's one extra step. */
        DEV_Digital_Write(EPD_CS_M_PIN, 0);
        EPD_13IN3E_SPI_Sand(DCDC_T133A01, DCDC_V_T133A01, sizeof(DCDC_V_T133A01));
        EPD_13IN3E_CS_ALL(1);
        EPD_13IN3E_Settle();
    }

    EPD_13IN3E_CS_ALL(0);
    if (t133a01) {
        EPD_13IN3E_SPI_Sand(CDI, CDI_V_T133A01, sizeof(CDI_V_T133A01));
    } else {
        EPD_13IN3E_SPI_Sand(CDI, CDI_V, sizeof(CDI_V));
    }
    EPD_13IN3E_CS_ALL(1);
    EPD_13IN3E_Settle();

    EPD_13IN3E_CS_ALL(0);
	EPD_13IN3E_SPI_Sand(TCON, TCON_V, sizeof(TCON_V));
    EPD_13IN3E_CS_ALL(1);
    EPD_13IN3E_Settle();

    EPD_13IN3E_CS_ALL(0);
	EPD_13IN3E_SPI_Sand(AGID, AGID_V, sizeof(AGID_V));
    EPD_13IN3E_CS_ALL(1);
    EPD_13IN3E_Settle();

    EPD_13IN3E_CS_ALL(0);
	EPD_13IN3E_SPI_Sand(PWS, PWS_V, sizeof(PWS_V));
    EPD_13IN3E_CS_ALL(1);
    EPD_13IN3E_Settle();

    if (!t133a01) {
        /* The T133A01 vendor sequence programs CCSET right before each pixel
         * transfer instead (EPD_13IN3E_PrepareData), not here at init. */
        EPD_13IN3E_CS_ALL(0);
        EPD_13IN3E_SPI_Sand(CCSET, CCSET_V, sizeof(CCSET_V));
        EPD_13IN3E_CS_ALL(1);
    }

    EPD_13IN3E_CS_ALL(0);
	EPD_13IN3E_SPI_Sand(TRES, TRES_V, sizeof(TRES_V));
    EPD_13IN3E_CS_ALL(1);
    EPD_13IN3E_Settle();

    DEV_Digital_Write(EPD_CS_M_PIN, 0);
	EPD_13IN3E_SPI_Sand(PWR_epd, PWR_V, sizeof(PWR_V));
    EPD_13IN3E_CS_ALL(1);
    EPD_13IN3E_Settle();

    DEV_Digital_Write(EPD_CS_M_PIN, 0);
	EPD_13IN3E_SPI_Sand(EN_BUF, EN_BUF_V, sizeof(EN_BUF_V));
    EPD_13IN3E_CS_ALL(1);
    EPD_13IN3E_Settle();

    DEV_Digital_Write(EPD_CS_M_PIN, 0);
    if (t133a01) {
        EPD_13IN3E_SPI_Sand(BTST_P, BTST_P_V_T133A01, sizeof(BTST_P_V_T133A01));
    } else {
        EPD_13IN3E_SPI_Sand(BTST_P, BTST_P_V, sizeof(BTST_P_V));
    }
    EPD_13IN3E_CS_ALL(1);
    EPD_13IN3E_Settle();

    DEV_Digital_Write(EPD_CS_M_PIN, 0);
	EPD_13IN3E_SPI_Sand(BOOST_VDDP_EN, BOOST_VDDP_EN_V, sizeof(BOOST_VDDP_EN_V));
    EPD_13IN3E_CS_ALL(1);
    EPD_13IN3E_Settle();

    DEV_Digital_Write(EPD_CS_M_PIN, 0);
    if (t133a01) {
        EPD_13IN3E_SPI_Sand(BTST_N, BTST_N_V_T133A01, sizeof(BTST_N_V_T133A01));
    } else {
        EPD_13IN3E_SPI_Sand(BTST_N, BTST_N_V, sizeof(BTST_N_V));
    }
    EPD_13IN3E_CS_ALL(1);
    EPD_13IN3E_Settle();

    DEV_Digital_Write(EPD_CS_M_PIN, 0);
	EPD_13IN3E_SPI_Sand(BUCK_BOOST_VDDN, BUCK_BOOST_VDDN_V, sizeof(BUCK_BOOST_VDDN_V));
    EPD_13IN3E_CS_ALL(1);
    EPD_13IN3E_Settle();

    DEV_Digital_Write(EPD_CS_M_PIN, 0);
	EPD_13IN3E_SPI_Sand(TFT_VCOM_POWER, TFT_VCOM_POWER_V, sizeof(TFT_VCOM_POWER_V));
    EPD_13IN3E_CS_ALL(1);
    EPD_13IN3E_Settle();

}

/******************************************************************************
function :  Clear screen
parameter:
******************************************************************************/
void EPD_13IN3E_Clear(UBYTE color)
{
    UDOUBLE Width, Height;
    UBYTE Color;
    Width = (EPD_13IN3E_WIDTH % 2 == 0)? (EPD_13IN3E_WIDTH / 2 ): (EPD_13IN3E_WIDTH / 2 + 1);
    Height = EPD_13IN3E_HEIGHT;
    Color = (color<<4)|color;

    UBYTE buf[Width/2];

    for (UDOUBLE j = 0; j < Width/2; j++) {
        buf[j] = Color;
    }

    EPD_13IN3E_PrepareData();
    DEV_Digital_Write(EPD_CS_M_PIN, 0);
    EPD_13IN3E_SendCommand(0x10);
    for (UDOUBLE j = 0; j < EPD_13IN3E_HEIGHT; j++) {
        EPD_13IN3E_SendData2(buf, Width/2);
        EPD_13IN3E_RowPace(j);
    }
    EPD_13IN3E_CS_ALL(1);

    DEV_Digital_Write(EPD_CS_S_PIN, 0);
    EPD_13IN3E_SendCommand(0x10);
    for (UDOUBLE j = 0; j < EPD_13IN3E_HEIGHT; j++) {
        EPD_13IN3E_SendData2(buf, Width/2);
        EPD_13IN3E_RowPace(j);
    }
    EPD_13IN3E_CS_ALL(1);

    EPD_13IN3E_TurnOnDisplay();
}


void EPD_13IN3E_Display(const UBYTE *Image)
{
    UDOUBLE Width, Width1, Height;
    Width = (EPD_13IN3E_WIDTH % 2 == 0)? (EPD_13IN3E_WIDTH / 2 ): (EPD_13IN3E_WIDTH / 2 + 1);
    Width1 = (Width % 2 == 0)? (Width / 2 ): (Width / 2 + 1);
    Height = EPD_13IN3E_HEIGHT;

    EPD_13IN3E_PrepareData();
    DEV_Digital_Write(EPD_CS_M_PIN, 0);
    EPD_13IN3E_SendCommand(0x10);
    for(UDOUBLE i=0; i<Height; i++ )
    {
        EPD_13IN3E_SendData2(Image + i*Width,Width1);
        EPD_13IN3E_RowPace(i);
    }
    EPD_13IN3E_CS_ALL(1);

    DEV_Digital_Write(EPD_CS_S_PIN, 0);
    EPD_13IN3E_SendCommand(0x10);
    for(UDOUBLE i=0; i<Height; i++ )
    {
        EPD_13IN3E_SendData2(Image + i*Width + Width1,Width1);
        EPD_13IN3E_RowPace(i);
    }

    EPD_13IN3E_CS_ALL(1);

    EPD_13IN3E_TurnOnDisplay();
}


void EPD_13IN3E_DisplayPart(const UBYTE *Image, UWORD xstart, UWORD ystart, UWORD image_width, UWORD image_heigh)
{
    UDOUBLE Width, Width1, Height;
    Width = (EPD_13IN3E_WIDTH % 2 == 0)? (EPD_13IN3E_WIDTH / 2 ): (EPD_13IN3E_WIDTH / 2 + 1);
    Width1 = (Width % 2 == 0)? (Width / 2 ): (Width / 2 + 1);
    Height = EPD_13IN3E_HEIGHT;

    UWORD Xend = ((xstart + image_width)%2 == 0)?((xstart + image_width) / 2 - 1): ((xstart + image_width) / 2 );
    UWORD Yend = ystart + image_heigh-1;

    EPD_13IN3E_PrepareData();
    xstart = xstart / 2;

    if(xstart > 300 )
    {
        Xend = Xend - 300;
        xstart = xstart - 300;
        DEV_Digital_Write(EPD_CS_M_PIN, 0);
        EPD_13IN3E_SendCommand(0x10);
        for (UDOUBLE i = 0; i < Height; i++) {
            for (UDOUBLE j = 0; j < Width1; j++) {
                EPD_13IN3E_SendData(0x11);
            }
            EPD_13IN3E_RowPace(i);
        }
        EPD_13IN3E_CS_ALL(1);


        DEV_Digital_Write(EPD_CS_S_PIN, 0);
        EPD_13IN3E_SendCommand(0x10);
        for (UDOUBLE i = 0; i < Height; i++) {
            for (UDOUBLE j = 0; j < Width1; j++) {
                if((i<Yend) && (i>=ystart) && (j<Xend) && (j>=xstart)) {
                    EPD_13IN3E_SendData(Image[(j-xstart) + (image_width/2*(i-ystart))]);
                }
                else
                    EPD_13IN3E_SendData(0x11);
            }
            EPD_13IN3E_RowPace(i);
        }
        EPD_13IN3E_CS_ALL(1);
    }
    else if(Xend < 300 )
    {
        DEV_Digital_Write(EPD_CS_M_PIN, 0);
        EPD_13IN3E_SendCommand(0x10);
        for (UDOUBLE i = 0; i < Height; i++) {
            for (UDOUBLE j = 0; j < Width1; j++) {
                if((i<Yend) && (i>=ystart) && (j<Xend) && (j>=xstart)) {
                    EPD_13IN3E_SendData(Image[(j-xstart) + (image_width/2*(i-ystart))]);
                }
                else
                    EPD_13IN3E_SendData(0x11);
            }
            EPD_13IN3E_RowPace(i);
        }
        EPD_13IN3E_CS_ALL(1);


        DEV_Digital_Write(EPD_CS_S_PIN, 0);
        EPD_13IN3E_SendCommand(0x10);
        for (UDOUBLE i = 0; i < Height; i++) {
            for (UDOUBLE j = 0; j < Width1; j++) {
                EPD_13IN3E_SendData(0x11);
            }
            EPD_13IN3E_RowPace(i);
        }
        EPD_13IN3E_CS_ALL(1);
    }
    else
    {
        DEV_Digital_Write(EPD_CS_M_PIN, 0);
        EPD_13IN3E_SendCommand(0x10);
        for (UDOUBLE i = 0; i < Height; i++) {
            for (UDOUBLE j = 0; j < Width1; j++) {
                if((i<Yend) && (i>=ystart) && (j>=xstart)) {
                    EPD_13IN3E_SendData(Image[(j-xstart) + (image_width/2*(i-ystart))]);
                }
                else
                    EPD_13IN3E_SendData(0x11);
            }
            EPD_13IN3E_RowPace(i);
        }
        EPD_13IN3E_CS_ALL(1);


        DEV_Digital_Write(EPD_CS_S_PIN, 0);
        EPD_13IN3E_SendCommand(0x10);
        for (UDOUBLE i = 0; i < Height; i++) {
            for (UDOUBLE j = 0; j < Width1; j++) {
                if((i<Yend) && (i>=ystart) && (j<Xend-300)) {
                    EPD_13IN3E_SendData(Image[(j+300-xstart) + (image_width/2*(i-ystart))]);
                }
                else
                    EPD_13IN3E_SendData(0x11);
            }
            EPD_13IN3E_RowPace(i);
        }
        EPD_13IN3E_CS_ALL(1);
    }

    EPD_13IN3E_TurnOnDisplay();
}



void EPD_13IN3E_Show6Block(void)
{
    unsigned long i, j, k;
    UWORD Width, Height;
    Width = (EPD_13IN3E_WIDTH % 2 == 0)? (EPD_13IN3E_WIDTH / 2 ): (EPD_13IN3E_WIDTH / 2 + 1);
    Height = EPD_13IN3E_HEIGHT;
    unsigned char const Color_seven[6] =
    {EPD_13IN3E_BLACK, EPD_13IN3E_BLUE, EPD_13IN3E_GREEN,
    EPD_13IN3E_RED, EPD_13IN3E_YELLOW, EPD_13IN3E_WHITE};

    EPD_13IN3E_PrepareData();
    DEV_Digital_Write(EPD_CS_M_PIN, 0);
    EPD_13IN3E_SendCommand(0x10);
    for (k = 0; k < 6; k++) {
        for (j = 0; j < Height/6; j++) {
            for (i = 0; i < Width/2; i++) {
                EPD_13IN3E_SendData(Color_seven[k]|(Color_seven[k]<<4));
            }
        }
        EPD_13IN3E_RowPace(j);
    }
    EPD_13IN3E_CS_ALL(1);

    DEV_Digital_Write(EPD_CS_S_PIN, 0);
    EPD_13IN3E_SendCommand(0x10);
    for (k = 0; k < 6; k++) {
        for (j = 0; j < Height/6; j++) {
            for (i = 0; i < Width/2; i++) {
                EPD_13IN3E_SendData(Color_seven[k]|(Color_seven[k]<<4));
            }
        }
        EPD_13IN3E_RowPace(j);
    }
    EPD_13IN3E_CS_ALL(1);

    EPD_13IN3E_TurnOnDisplay();
}


/******************************************************************************
function :  Enter sleep mode
parameter:
******************************************************************************/
void EPD_13IN3E_Sleep(void)
{
    EPD_13IN3E_CS_ALL(0);
    EPD_13IN3E_SendCommand(0x07); // DEEP_SLEEP
    EPD_13IN3E_SendData(0XA5);
    EPD_13IN3E_CS_ALL(1);
}
