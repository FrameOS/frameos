/*****************************************************************************
* | File      	:	Debug.h
* | Author      :   Waveshare team
* | Function    :	debug with printf
* | Info        :
*   Image scanning
*      Please use progressive scanning to generate images or fonts
*----------------
* |	This version:   V2.0
* | Date        :   2018-10-30
* | Info        :   
*   1.USE_DEBUG -> DEBUG, If you need to see the debug information, 
*    clear the execution: make DEBUG=-DDEBUG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documnetation files (the "Software"), to deal
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
#ifndef __DEBUG_H
#define __DEBUG_H

#include <stdio.h>

/* FrameOS: every vendor driver reports a busy-pin timeout the same way —
 *   Debug("e-Paper busy timeout\r\n"); break;
 * — and then carries on as if the panel had answered, so a wedged panel
 * logged "render: complete" and the cloud showed a healthy frame with a
 * blank screen (72 drivers; the FrameOS forks use DEV_Busy_Wait instead).
 * Rather than patch 72 files that a vendor resync would overwrite, the Debug
 * macro they all already call routes through DEV_Debug_Vendor(), which
 * recognises that one message and parks a DEV_Error() for the render to
 * raise (raiseIfDriverError on the Pi, the error log on the ESP32). The
 * printing half keeps its old DEBUG gate. */
void DEV_Debug_Vendor(const char *fmt, ...);
#define DEV_DEBUG_BUSY_TIMEOUT_MSG "e-Paper busy timeout\r\n"
#define Debug(__info,...) DEV_Debug_Vendor(__info,##__VA_ARGS__)

#endif

