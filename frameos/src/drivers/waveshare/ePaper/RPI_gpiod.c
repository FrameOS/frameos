/*****************************************************************************
* | File        :   RPI_GPIOD.c
* | Author      :   Waveshare team
* | Function    :   Drive GPIO
* | Info        :   Read and write gpio
*----------------
* |	This version:   V1.0
* | Date        :   2023-11-15
* | Info        :   Basic version
*
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documnetation files (the "Software"), to deal
# GPIOD_IN the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to  whom the Software is
# furished to do so, subject to the folGPIOD_LOWing conditions:
#
# The above copyright notice and this permission notice shall be included GPIOD_IN
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS OR A PARTICULAR PURPOSE AND NONINFRINGEMENT. GPIOD_IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY WHETHER GPIOD_IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# GPIOD_OUT OF OR GPIOD_IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS GPIOD_IN
# THE SOFTWARE.
#
******************************************************************************/
#include "RPI_gpiod.h"
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <gpiod.h>

/* Read /proc/cpuinfo directly instead of popen()-ing a shell: popen() forks
 * the whole process, which the main ePaper HAL removed for a documented
 * deadlock (the runtime is multi-threaded by the time a driver initialises).
 * A missing file reads as "not a Pi 5", the same as the shell path did. */
static int DEV_File_Contains_N(const char *path, const char *needle, size_t cap)
{
    FILE *fp = fopen(path, "r");
    if (fp == NULL) {
        return 0;
    }
    char *buffer = (char *)malloc(cap);
    if (buffer == NULL) {
        fclose(fp);
        return 0;
    }
    size_t total = 0;
    while (total < cap - 1) {
        size_t got = fread(buffer + total, 1, cap - 1 - total, fp);
        if (got == 0) break;
        total += got;
    }
    fclose(fp);
    buffer[total] = '\0';
    int found = strstr(buffer, needle) != NULL;
    free(buffer);
    return found;
}

struct gpiod_chip *gpiochip;
struct gpiod_line *gpioline;
int ret;

int GPIOD_Export()
{
    if (DEV_File_Contains_N("/proc/cpuinfo", "Raspberry Pi 5", 64 * 1024))
    {
        gpiochip = gpiod_chip_open("/dev/gpiochip4");
        if (gpiochip == NULL)
        {
            GPIOD_Debug( "gpiochip4 Export Failed\n");
            return -1;
        }
    }
    else
    {
        gpiochip = gpiod_chip_open("/dev/gpiochip0");
        if (gpiochip == NULL)
        {
            GPIOD_Debug( "gpiochip0 Export Failed\n");
            return -1;
        }
    }

        
    return 0;
}

int GPIOD_Unexport(int Pin)
{
    gpioline = gpiod_chip_get_line(gpiochip, Pin);
    if (gpioline == NULL)
    {
        GPIOD_Debug( "Export Failed: Pin%d\n", Pin);
        return -1;
    }

    gpiod_line_release(gpioline);
    
    GPIOD_Debug( "Unexport: Pin%d\r\n", Pin);
    
    return 0;
}

int GPIOD_Unexport_GPIO(void)
{
    gpiod_line_release(gpioline);
    gpiod_chip_close(gpiochip);

    return 0;
}

int GPIOD_Direction(int Pin, int Dir)
{
    gpioline = gpiod_chip_get_line(gpiochip, Pin);
    if (gpioline == NULL)
    {
        GPIOD_Debug( "Export Failed: Pin%d\n", Pin);
        return -1;
    }

    if(Dir == GPIOD_IN)
    {
        ret = gpiod_line_request_input(gpioline, "gpio");
        if (ret != 0)
        {
            GPIOD_Debug( "Export Failed: Pin%d\n", Pin);
            return -1;
        }        
        GPIOD_Debug("Pin%d:intput\r\n", Pin);
    }
    else
    {
        ret = gpiod_line_request_output(gpioline, "gpio", 0);
        if (ret != 0)
        {
            GPIOD_Debug( "Export Failed: Pin%d\n", Pin);
            return -1;
        }        
        GPIOD_Debug("Pin%d:Output\r\n", Pin);
    }
    return 0;
}

int GPIOD_Read(int Pin)
{
    gpioline = gpiod_chip_get_line(gpiochip, Pin);
    if (gpioline == NULL)
    {
        GPIOD_Debug( "Export Failed: Pin%d\n", Pin);
        return -1;
    }

    ret = gpiod_line_get_value(gpioline);
    if (ret < 0)
    {
        GPIOD_Debug( "failed to read value!\n");
        return -1;
    }

    return(ret);
}

int GPIOD_Write(int Pin, int value)
{
    gpioline = gpiod_chip_get_line(gpiochip, Pin);
    if (gpioline == NULL)
    {
        GPIOD_Debug( "Export Failed: Pin%d\n", Pin);
        return -1;
    }     

    ret = gpiod_line_set_value(gpioline, value);
    if (ret != 0)
    {
        GPIOD_Debug( "failed to write value! : Pin%d\n", Pin);
        return -1;
    }
    return 0;
}
