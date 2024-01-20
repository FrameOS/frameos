{.passl: "-llgpio".}
##
## This is free and unencumbered software released into the public domain.
##
## Anyone is free to copy, modify, publish, use, compile, sell, or
## distribute this software, either in source code form or as a compiled
## binary, for any purpose, commercial or non-commercial, and by any
## means.
##
## In jurisdictions that recognize copyright laws, the author or authors
## of this software dedicate any and all copyright interest in the
## software to the public domain. We make this dedication for the benefit
## of the public at large and to the detriment of our heirs and
## successors. We intend this dedication to be an overt act of
## relinquishment in perpetuity of all present and future rights to this
## software under copyright law.
##
## THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
## EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
## MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
## IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
## OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
## ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
## OTHER DEALINGS IN THE SOFTWARE.
##
## For more information, please refer to <http://unlicense.org/>
##

const
  LGPIO_VERSION* = 0x00020200
  LG_CD* = "LG_CD"
  LG_WD* = "LG_WD"

## TEXT
##
## lgpio is a C library for Linux Single Board Computers which
## allows control of the General Purpose Input Output pins.
##
## Features*
##
## o reading and writing GPIO singly and in groups
## o software timed PWM and waves
## o GPIO callbacks
## o pipe notification of GPIO alerts
## o I2C wrapper
## o SPI wrapper
## o serial link wrapper
## o a simple interface to start and stop new threads
##
## Usage*
##
## Include <lgpio.h> in your source files.
##
## Assuming your source is in a single file called prog.c use the following
## command to build and run the executable.
##
## . .
## gcc -Wall -o prog prog.c -llgpio
## ./prog
## . .
##
## For examples of usage see the C programs within the lg archive file.
##
## Notes*
##
## All the functions which return an int return < 0 on error.
##
## TEXT
## OVERVIEW
##
## GPIO
##
## lgGpiochipOpen               Opens a gpiochip device
## lgGpiochipClose              Closes a gpiochip device
##
## lgGpioGetChipInfo            Gets gpiochip information
## lgGpioGetLineInfo            Gets gpiochip line information
## lgGpioGetMode                Gets the mode of a GPIO
##
## lgGpioSetUser                Notifies Linux of the GPIO user
##
## lgGpioClaimInput             Claims a GPIO for input
## lgGpioClaimOutput            Claims a GPIO for output
## lgGpioClaimAlert             Claims a GPIO for alerts
## lgGpioFree                   Frees a GPIO
##
## lgGroupClaimInput            Claims a group of GPIO for inputs
## lgGroupClaimOutput           Claims a group of GPIO for outputs
## lgGroupFree                  Frees a group of GPIO
##
## lgGpioRead                   Reads a GPIO
## lgGpioWrite                  Writes a GPIO
##
## lgGroupRead                  Reads a group of GPIO
## lgGroupWrite                 Writes a group of GPIO
##
## lgTxPulse                    Starts pulses on a GPIO
## lgTxPwm                      Starts PWM pulses on a GPIO
## lgTxServo                    Starts Servo pulses on a GPIO
## lgTxWave                     Starts a wave on a group of GPIO
## lgTxBusy                     See if tx is active on a GPIO or group
## lgTxRoom                     See if more room for tx on a GPIO or group
##
## lgGpioSetDebounce            Sets the debounce time for a GPIO
## lgGpioSetWatchdog            Sets the watchdog time for a GPIO
##
## lgGpioSetAlertsFunc          Starts a GPIO callback
## lgGpioSetSamplesFunc         Starts a GPIO callback for all GPIO
##
## I2C
##
## lgI2cOpen                    Opens an I2C device
## lgI2cClose                   Closes an I2C device
##
## lgI2cWriteQuick              SMBus write quick
##
## lgI2cReadByte                SMBus read byte
## lgI2cWriteByte               SMBus write byte
##
## lgI2cReadByteData            SMBus read byte data
## lgI2cWriteByteData           SMBus write byte data
##
## lgI2cReadWordData            SMBus read word data
## lgI2cWriteWordData           SMBus write word data
##
## lgI2cReadBlockData           SMBus read block data
## lgI2cWriteBlockData          SMBus write block data
##
## lgI2cReadI2CBlockData        SMBus read I2C block data
## lgI2cWriteI2CBlockData       SMBus write I2C block data
##
## lgI2cReadDevice              Reads the raw I2C device
## lgI2cWriteDevice             Writes the raw I2C device
##
## lgI2cProcessCall             SMBus process call
## lgI2cBlockProcessCall        SMBus block process call
##
## lgI2cSegments                Performs multiple I2C transactions
## lgI2cZip                     Performs multiple I2C transactions
##
## NOTIFICATIONS
##
## lgNotifyOpen                 Request a notification
## lgNotifyClose                Close a notification
## lgNotifyPause                Pause notifications
## lgNotifyResume               Start notifications
##
## SERIAL
##
## lgSerialOpen                 Opens a serial device
## lgSerialClose                Closes a serial device
##
## lgSerialReadByte             Reads a byte from a serial device
## lgSerialWriteByte            Writes a byte to a serial device
##
## lgSerialRead                 Reads bytes from a serial device
## lgSerialWrite                Writes bytes to a serial device
##
## lgSerialDataAvailable        Returns number of bytes ready to be read
##
## SPI
##
## lgSpiOpen                    Opens a SPI device
## lgSpiClose                   Closes a SPI device
##
## lgSpiRead                    Reads bytes from a SPI device
## lgSpiWrite                   Writes bytes to a SPI device
##
## lgSpiXfer                    Transfers bytes with a SPI device
##
## THREADS
##
## lgThreadStart                Start a new thread
## lgThreadStop                 Stop a previously started thread
##
## UTILITIES
##
## lguVersion                   Gets the library version
## lguSbcName                   Gets the host name of the SBC
##
## lguGetInternal               Get an internal configuration value
## lguSetInternal               Set an internal configuration value
##
## lguSleep                     Sleeps for a given time
##
## lguTimestamp                 Gets the current timestamp
## lguTime                      Gets the current time
##
## lguErrorText                 Gets a text description of an error code
##
## lguSetWorkDir                Set the working directory
## lguGetWorkDir                Get the working directory
##
## OVERVIEW

# when __BIG_ENDIAN__:
#   template htonll*(x: untyped): untyped =
#     (x)

#   template ntohll*(x: untyped): untyped =
#     (x)

# else:
#   template htonll*(x: untyped): untyped =
#     ((cast[culonglong](htonl((x) and 0xffffffff)) shl 32) or htonl((x) shr 32))

#   template ntohll*(x: untyped): untyped =
#     ((cast[culonglong](ntohl((x) and 0xffffffff)) shl 32) or ntohl((x) shr 32))

const
  LG_CFG_ID_DEBUG_LEVEL* = 0
  LG_CFG_ID_MIN_DELAY* = 1
  LG_MAX_PATH* = 1024
  LG_THREAD_NONE* = 0
  LG_THREAD_STARTED* = 1
  LG_THREAD_RUNNING* = 2
  LG_NOTIFY_CLOSED* = 0
  LG_NOTIFY_CLOSING* = 1
  LG_NOTIFY_RUNNING* = 2
  LG_NOTIFY_PAUSED* = 3
  MAX_REPORT* = 250
  MAX_SAMPLE* = 4000
  # MAX_EMITS* = (PIPE_BUF div sizeof((lgGpioReport_t)))
  STACK_SIZE* = (256 * 1024)
  LG_USER_LEN* = 16
  LG_SALT_LEN* = 16

##  File constants
##

const
  LG_FILE_NONE* = 0
  LG_FILE_MIN* = 1
  LG_FILE_READ* = 1
  LG_FILE_WRITE* = 2
  LG_FILE_RW* = 3
  LG_FILE_APPEND* = 4
  LG_FILE_CREATE* = 8
  LG_FILE_TRUNC* = 16
  LG_FILE_MAX* = 31
  LG_FROM_START* = 0
  LG_FROM_CURRENT* = 1
  LG_FROM_END* = 2

##  GPIO constants
##

const
  LG_GPIO_LABEL_LEN* = 32
  LG_GPIO_NAME_LEN* = 32
  LG_GPIO_USER_LEN* = 32

##  used to report line status

const
  LG_GPIO_IS_KERNEL* = 1
  LG_GPIO_IS_OUTPUT* = 2
  LG_GPIO_IS_ACTIVE_LOW* = 4
  LG_GPIO_IS_OPEN_DRAIN* = 8
  LG_GPIO_IS_OPEN_SOURCE* = 16
  LG_GPIO_IS_PULL_UP* = 32
  LG_GPIO_IS_PULL_DOWN* = 64
  LG_GPIO_IS_PULL_NONE* = 128
  LG_GPIO_IS_INPUT* = 65536
  LG_GPIO_IS_RISING_EDGE* = 131072
  LG_GPIO_IS_FALLING_EDGE* = 262144
  LG_GPIO_IS_REALTIME_CLOCK* = 524288

##  use to set event flags

const
  LG_RISING_EDGE* = 1
  LG_FALLING_EDGE* = 2
  LG_BOTH_EDGES* = 3

##  use to set line flags

const
  LG_SET_ACTIVE_LOW* = 4
  LG_SET_OPEN_DRAIN* = 8
  LG_SET_OPEN_SOURCE* = 16
  LG_SET_PULL_UP* = 32
  LG_SET_PULL_DOWN* = 64
  LG_SET_PULL_NONE* = 128

##  used internally

const
  LG_SET_REALTIME_CLOCK* = 256
  LG_SET_INPUT* = 512
  LG_SET_OUTPUT* = 1024

##  reported GPIO levels

const
  LG_LOW* = 0
  LG_HIGH* = 1
  LG_TIMEOUT* = 2
  LG_TX_PWM* = 0
  LG_TX_WAVE* = 1
  LG_MAX_MICS_DEBOUNCE* = 5000000
  LG_MAX_MICS_WATCHDOG* = 300000000

##  Script constants
##

const
  LG_MAX_MICS_DELAY* = 5e6
  LG_MAX_MILS_DELAY* = 300e6

##  script status
##

const
  LG_SCRIPT_INITING* = 0
  LG_SCRIPT_READY* = 1
  LG_SCRIPT_RUNNING* = 2
  LG_SCRIPT_WAITING* = 3
  LG_SCRIPT_EXITED* = 4
  LG_SCRIPT_ENDED* = 5
  LG_SCRIPT_HALTED* = 6
  LG_SCRIPT_FAILED* = 7

##  SPI constants
##

const
  LG_MAX_SPI_DEVICE_COUNT* = (1 shl 16)

##  I2C constants
##
##  max lgI2cMsg_t per transaction

const
  LG_I2C_RDRW_IOCTL_MAX_MSGS* = 42
  LG_MAX_I2C_DEVICE_COUNT* = (1 shl 16)
  LG_MAX_I2C_ADDR* = 0x7F

##  i2cZip commands

const
  LG_I2C_END* = 0
  LG_I2C_ESC* = 1
  LG_I2C_ADDR* = 2
  LG_I2C_FLAGS* = 3
  LG_I2C_READ* = 4
  LG_I2C_WRITE* = 5

##  types
##

type
  lgChipInfo_t* {.bycopy.} = object
    lines*: cuint
    name*: array[LG_GPIO_NAME_LEN, char]
    ##  Linux name
    label*: array[LG_GPIO_LABEL_LEN, char]
    ##  functional name

  lgChipInfo_p* = ptr lgChipInfo_t
  lgNotify_t* {.bycopy.} = object
    state*: cushort
    fd*: cint
    pipe_number*: cint
    max_emits*: cint

  callbk_t* = proc ()
  lgGpioReport_t* {.bycopy.} = object
    timestamp*: culonglong
    ##  alert time in nanoseconds
    chip*: cchar
    ##  gpiochip device number
    gpio*: cchar
    ##  offset into gpio device
    level*: cchar
    ##  0=low, 1=high, 2=watchdog
    flags*: cchar
    ##  none defined, ignore report if non-zero

  lgGpioAlert_t* {.bycopy.} = object
    report*: lgGpioReport_t
    nfyHandle*: cint

  lgGpioAlert_p* = ptr lgGpioAlert_t
  lgLineInfo_t* {.bycopy.} = object
    offset*: cuint
    ##  GPIO number
    lFlags*: cuint
    name*: array[LG_GPIO_NAME_LEN, char]
    ##  GPIO name
    user*: array[LG_GPIO_USER_LEN, char]
    ##  user

  lgLineInfo_p* = ptr lgLineInfo_t
  lgPulse_t* {.bycopy.} = object
    bits*: culonglong
    mask*: culonglong
    delay*: clonglong

  lgPulse_p* = ptr lgPulse_t
  lgI2cMsg_t* {.bycopy.} = object
    `addr`*: cushort
    ##  slave address
    flags*: cushort
    len*: cushort
    ##  msg length
    buf*: ptr cchar
    ##  pointer to msg data

  lgGpioAlertsFunc_t* = proc (num_alerts: cint; alerts: lgGpioAlert_p;
                           userdata: pointer) {.cdecl.}
  # lgThreadFunc_t* = proc (a1: pointer): pointer {.cdecl.}

##  semi-private prototypes
##

proc lguGetConfigDir*(): cstring {.importc: "lguGetConfigDir".}
proc lguSetConfigDir*(dirPath: cstring) {.importc: "lguSetConfigDir".}
proc lgGpioSetBannedState*(handle: cint; gpio: cint; banned: cint): cint {.
    importc: "lgGpioSetBannedState".}
##  GPIO chip API
##
## F

proc lgGpiochipOpen*(gpioDev: cint): cint {.importc: "lgGpiochipOpen".}
## D
## This returns a handle to a gpiochip device.
##
## . .
## gpioDev: >= 0
## . .
##
## If OK returns a handle (>= 0).
##
## On failure returns a negative error code.
##
## ...
## h = lgGpiochipOpen(0); // open /dev/gpiochip0
##
## if (h >= 0)
## {
##    // open ok
## }
## else
## {
##    // open error
## }
## ...
## D
## F

proc lgGpiochipClose*(handle: cint): cint {.importc: "lgGpiochipClose".}
## D
## This closes an opened gpiochip device.
##
## . .
## handle: >= 0 (as returned by [*lgGpiochipOpen*])
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## ...
## status = lgGpiochipClose(h); // close gpiochip
##
## if (status < 0)
## {
##    // close failed
## }
## ...
## D
## F

proc lgGpioGetChipInfo*(handle: cint; chipInfo: lgChipInfo_p): cint {.
    importc: "lgGpioGetChipInfo".}
## D
## This returns information about a gpiochip.
##
## . .
##   handle: >= 0 (as returned by [*lgGpiochipOpen*])
## chipInfo: A pointer to space for a lgChipInfo_t object
## . .
##
## If OK returns 0 and updates chipInfo.
##
## On failure returns a negative error code.
##
## This command gets the number of GPIO on the gpiochip,
## its name, and its usage.
##
## ...
## lgChipInfo_t cInfo;
##
## status = lgGpioGetChipInfo(h, &cInfo);
##
## if (status == LG_OKAY)
## {
##    printf("lines=%d name=%s label=%s\n",
##       cInfo.lines, cInfo.name, cInfo.label))
## }
## ...
## D
## F

proc lgGpioGetLineInfo*(handle: cint; gpio: cint; lineInfo: lgLineInfo_p): cint {.
    importc: "lgGpioGetLineInfo".}
## D
## Returns information about a GPIO.
##
## . .
##   handle: >= 0 (as returned by [*lgGpiochipOpen*])
##     gpio: >= 0, as legal for the gpiochip
## lineInfo: A pointer to space for a lgLineInfo_t object
## . .
##
## If OK returns 0 and updates lineInfo.
##
## On failure returns a negative error code.
##
## This command gets information for a GPIO of a gpiochip.  In particular
## it gets the GPIO number, flags, its user, and its purpose.
##
## The meaning of the flags bits are as given for the mode by [*lgGpioGetMode*].
##
## The user and purpose fields are filled in by the software which has
## claimed the GPIO and may be blank.
##
## ...
## lgLineInfo_t lInfo;
##
## status = lgGpioGetLineInfo(h, gpio, &lInfo);
##
## if (status == LG_OKAY)
## {
##    printf("lFlags=%d name=%s user=%s\n",
##       lInfo.lFlags, lInfo.name, lInfo.user))
## }
## ...
## D
## F

proc lgGpioGetMode*(handle: cint; gpio: cint): cint {.importc: "lgGpioGetMode".}
## D
## Returns the GPIO mode.
##
## . .
##   handle: >= 0 (as returned by [*lgGpiochipOpen*])
##     gpio: >= 0, as legal for the gpiochip
## . .
##
## If OK returns the GPIO mode.
##
## On failure returns a negative error code.
##
## Bit @ Value @ Meaning
## 0   @  1    @ Kernel: In use by the kernel
## 1   @  2    @ Kernel: Output
## 2   @  4    @ Kernel: Active low
## 3   @  8    @ Kernel: Open drain
## 4   @ 16    @ Kernel: Open source
## 5   @ 32    @ Kernel: Pull up set
## 6   @ 64    @ Kernel: Pull down set
## 7   @ 128   @ Kernel: Pulls off set
## 8   @ 256   @ LG: Input
## 9   @ 512   @ LG: Output
## 10  @ 1024  @ LG: Alert
## 11  @ 2048  @ LG: Group
## 12  @ 4096  @ LG: ---
## 13  @ 8192  @ LG: ---
## 14  @ 16384 @ LG: ---
## 15  @ 32768 @ LG: ---
## 16  @ 65536 @ Kernel: Input
## 17  @ 1<<17 @ Kernel: Rising edge alert
## 18  @ 1<<18 @ Kernel: Falling edge alert
## 19  @ 1<<19 @ Kernel: Realtime clock alert
##
## The LG bits are only set if the query was made by the process that
## owns the GPIO.
## D
## F

proc lgGpioSetUser*(handle: cint; gpiouser: cstring): cint {.importc: "lgGpioSetUser".}
## D
## This sets the user string to be associated with each claimed GPIO.
##
## . .
##   handle: >= 0 (as returned by [*lgGpiochipOpen*])
## gpiouser: a string up to 32 characters long
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## ...
## status = lgGpioSetUser(h, "my_title");
## ...
## D
## F

proc lgGpioClaimInput*(handle: cint; lFlags: cint; gpio: cint): cint {.
    importc: "lgGpioClaimInput".}
## D
## This claims a GPIO for input.
##
## . .
## handle: >= 0 (as returned by [*lgGpiochipOpen*])
## lFlags: line flags for the GPIO
##   gpio: the GPIO to be claimed
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## The line flags may be used to set the GPIO
## as active low, open drain, or open source.
##
## ...
## // open GPIO 23 for input
## status = lgGpioClaimInput(h, 0, 23);
## ...
## D
## F

proc lgGpioClaimOutput*(handle: cint; lFlags: cint; gpio: cint; level: cint): cint {.
    importc: "lgGpioClaimOutput".}
## D
## This claims a GPIO for output.
## . .
## handle: >= 0 (as returned by [*lgGpiochipOpen*])
## lFlags: line flags for the GPIO
##   gpio: the GPIO to be claimed
##  level: the initial level to set for the GPIO
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## The line flags may be used to set the GPIO
## as active low, open drain, or open source.
##
## If level is zero the GPIO will be initialised low.  If any other
## value is used the GPIO will be initialised high.
##
## ...
## // open GPIO 31 for high output
## status = lgGpioClaimOutput(h, 0, 31, 1);
## ...
## D
## F

proc lgGpioClaimAlert*(handle: cint; lFlags: cint; eFlags: cint; gpio: cint;
                      nfyHandle: cint): cint {.importc: "lgGpioClaimAlert".}
## D
## This claims a GPIO for alerts on level changes.
##
## . .
##    handle: >= 0 (as returned by [*lgGpiochipOpen*])
##    lFlags: line flags for the GPIO
##    eFlags: event flags for the GPIO
##      gpio: >= 0, as legal for the gpiochip
## nfyHandle: >= 0 (as returned by [*lgNotifyOpen*])
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## The line flags may be used to set the GPIO
## as active low, open drain, or open source.
##
## The event flags are used to specify alerts for a rising edge,
## falling edge, or both edges.
##
## The alerts will be sent to a previously opened notification. If
## you don't want them sent to a notification set nfyHandle to -1.
##
## The alerts will also be sent to any callback registered for the
## GPIO by [*lgGpioSetAlertsFunc*].
##
## All GPIO alerts are also sent to a callback registered by
## [*lgGpioSetSamplesFunc*].
##
## ...
## status = lgGpioClaimAlert(h, 0, LG_BOTH_EDGES, 16, -1);
## ...
## D
## F

proc lgGpioFree*(handle: cint; gpio: cint): cint {.importc: "lgGpioFree".}
## D
## This frees a GPIO.
##
## . .
## handle: >= 0 (as returned by [*lgGpiochipOpen*])
##   gpio: the GPIO to be freed
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## The GPIO may now be claimed by another user or for a different purpose.
##
## ...
## status = lgGpioFree(h, 16);
## ...
## D
## F

proc lgGroupClaimInput*(handle: cint; lFlags: cint; count: cint; gpios: ptr cint): cint {.
    importc: "lgGroupClaimInput".}
## D
## This claims a group of GPIO for inputs.
##
## . .
## handle: >= 0 (as returned by [*lgGpiochipOpen*])
## lFlags: line flags for the GPIO group
##  count: the number of GPIO to claim
##  gpios: the group GPIO
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## The line flags may be used to set the group
## as active low, open drain, or open source.
##
## gpios is an array of one or more GPIO.  The first GPIO is
## called the group leader and is used to reference the group as a whole.
##
## ...
## int buttons[4] = {9, 7, 2, 6};
##
## status = lgGroupClaimInput(h, 0, 4, buttons);
##
## if (status == LG_OKAY)
## {
##    // OK
## }
## else
## {
##    // Error
## }
## ...
## D
## F

proc lgGroupClaimOutput*(handle: cint; lFlags: cint; count: cint; gpios: ptr cint;
                        levels: ptr cint): cint {.importc: "lgGroupClaimOutput".}
## D
## This claims a group of GPIO for outputs.
##
## . .
## handle: >= 0 (as returned by [*lgGpiochipOpen*])
## lFlags: line flags for the GPIO group
##  count: the number of GPIO to claim
##  gpios: the group GPIO
## levels: the initial level for each GPIO
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## The line flags may be used to set the group
## as active low, open drain, or open source.
##
## gpios is an array of one or more GPIO.  The first GPIO is
## called the group leader and is used to reference the group as a whole.
##
## levels is an array of initialisation values for the GPIO. If a value is
## zero the corresponding GPIO will be initialised low.  If any other
## value is used the corresponding GPIO will be initialised high.
##
## ...
## int leds[7] =   {15, 16, 17, 8, 12, 13, 14};
## int levels[7] = { 1,  0,  1, 1,  1,  0,  0};
##
## status = lgGroupClaimInput(h, 0, 7, leds, levels);
##
## if (status == LG_OKAY)
## {
##    // OK
## }
## else
## {
##    // Error
## }
## ...
## D
## F

proc lgGroupFree*(handle: cint; gpio: cint): cint {.importc: "lgGroupFree".}
## D
## This frees all the GPIO associated with a group.
##
## . .
## handle: >= 0 (as returned by [*lgGpiochipOpen*])
##   gpio: the group to be freed
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## The GPIO may now be claimed by another user or for a different purpose.
##
## ...
## status = lgGroupFree(9); // free buttons
## ...
## D
## F

proc lgGpioRead*(handle: cint; gpio: cint): cint {.importc: "lgGpioRead".}
## D
## This returns the level of a GPIO.
##
## . .
## handle: >= 0 (as returned by [*lgGpiochipOpen*])
##   gpio: the GPIO to be read
## . .
##
## If OK returns 0 (low) or 1 (high).
##
## On failure returns a negative error code.
##
## This command will work for any claimed GPIO (even if a member
## of a group).  For an output GPIO the value returned
## will be that last written to the GPIO.
##
## ...
## level = lgGpioRead(h, 15); // get level of GPIO 15
## ...
## D
## F

proc lgGpioWrite*(handle: cint; gpio: cint; level: cint): cint {.importc: "lgGpioWrite".}
## D
## This sets the level of an output GPIO.
##
## . .
## handle: >= 0 (as returned by [*lgGpiochipOpen*])
##   gpio: the GPIO to be written
##  level: the level to set
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## This command will work for any GPIO claimed as an output
## (even if a member of a group).
##
## If level is zero the GPIO will be set low (0).
## If any other value is used the GPIO will be set high (1).
##
## ...
## status = lgGpioWrite(h, 23, 1); // set GPIO 23 high
## ...
## D
## F

proc lgGroupRead*(handle: cint; gpio: cint; groupBits: ptr culonglong): cint {.
    importc: "lgGroupRead".}
## D
## This returns the levels read from a group.
##
## . .
##    handle: >= 0 (as returned by [*lgGpiochipOpen*])
##      gpio: the group to be read
## groupBits: a pointer to a 64-bit memory area for the returned levels
## . .
##
## If OK returns the group size and updates groupBits.
##
## On failure returns a negative error code.
##
## This command will work for an output group as well as an input
## group.  For an output group the value returned
## will be that last written to the group GPIO.
##
## Note that this command will also work on an individual GPIO claimed
## as an input or output as that is treated as a group with one member.
##
## After a successful read groupBits is set as follows.
##
## Bit 0 is the level of the group leader.
## Bit 1 is the level of the second GPIO in the group.
## Bit x is the level of GPIO x+1 of the group.
##
## ...
## // assuming a read group of 4 buttons: 9, 7, 2, 6.
## culonglong bits;
##
## size = lgGroupRead(h, 9, &bits); // 9 is buttons group leader
##
## if (size >= 0) // size of group is returned so size will be 4
## {
##    level_9 = (bits >> 0) & 1;
##    level_7 = (bits >> 1) & 1;
##    level_2 = (bits >> 2) & 1;
##    level_6 = (bits >> 3) & 1;
## }
## else
## {
##    // error
## }
## ...
##
## D
## F

proc lgGroupWrite*(handle: cint; gpio: cint; groupBits: culonglong; groupMask: culonglong): cint {.
    importc: "lgGroupWrite".}
## D
## This sets the levels of an output group.
##
## . .
##    handle: >= 0 (as returned by [*lgGpiochipOpen*])
##      gpio: the group to be written
## groupBits: the level to set if the corresponding bit in groupMask is set
## groupMask: a mask indicating the group GPIO to be updated
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## The values of each GPIO of the group are set according to the bits
## of groupBits.
##
## Bit 0 sets the level of the group leader.
## Bit 1 sets the level of the second GPIO in the group.
## Bit x sets the level of GPIO x+1 in the group.
##
## However this may be modified by the groupMask.  A GPIO is only
## updated if the corresponding bit in the mask is 1.
##
## ...
## // assuming an output group of 7 LEDs: 15, 16, 17, 8, 12, 13, 14.
##
## // switch on all LEDs
## status = lgGroupWrite(h, 15, 0x7f, 0x7f);
##
## // switch off all LEDs
## status = lgGroupWrite(h, 15, 0x00, 0x7f);
##
## // switch on first 4 LEDs, leave others unaltered
## status = lgGroupWrite(h, 15, 0x0f, 0x0f);
##
## // switch on LED attached to GPIO 13, leave others unaltered
## status = lgGroupWrite(h, 15, 32, 32);
## ...
## D
## F

proc lgTxPulse*(handle: cint; gpio: cint; pulseOn: cint; pulseOff: cint;
               pulseOffset: cint; pulseCycles: cint): cint {.importc: "lgTxPulse".}
## D
## This starts software timed pulses on an output GPIO.
##
## . .
##      handle: >= 0 (as returned by [*lgGpiochipOpen*])
##        gpio: the GPIO to be written
##     pulseOn: pulse high time in microseconds
##    pulseOff: pulse low time in microseconds
## pulseOffset: offset from nominal pulse start position
## pulseCycles: the number of pulses to be sent, 0 for infinite
## . .
##
## If OK returns the number of entries left in the PWM queue for the GPIO.
##
## On failure returns a negative error code.
##
## If both pulseOn and pulseOff are zero pulses will be switched off
## for that GPIO.  The active pulse, if any, will be stopped and any
## queued pulses will be deleted.
##
## Each successful call to this function consumes one PWM queue entry.
##
## pulseCycles cycles are transmitted (0 means infinite).  Each cycle
## consists of pulseOn microseconds of GPIO high followed by pulseOff
## microseconds of GPIO low.
##
## PWM is characterised by two values, its frequency (number of cycles
## per second) and its duty cycle (percentage of high time per cycle).
##
## The set frequency will be 1000000 / (pulseOn + pulseOff) Hz.
##
## The set duty cycle will be pulseOn / (pulseOn + pulseOff) * 100 %.
##
## E.g. if pulseOn is 50 and pulseOff is 100 the frequency will be 6666.67 Hz
## and the duty cycle will be 33.33 %.
##
## pulseOffset is a microsecond offset from the natural start of the PWM cycle.
##
## For instance if the PWM frequency is 10 Hz the natural start of each cycle
## is at seconds 0, then 0.1, 0.2, 0.3 etc.  In this case if the offset is
## 20000 microseconds the cycle will start at seconds 0.02, 0.12, 0.22, 0.32 etc.
##
## Another pulse command may be issued to the GPIO before the last has finished.
##
## If the last pulse had infinite cycles then it will be replaced by
## the new settings at the end of the current cycle. Otherwise it will
## be replaced by the new settings when all its cycles are compete.
##
## Multiple pulse settings may be queued in this way.
##
## ...
## slots_left = lgTxPulse(h,  8, 100000, 100000, 0, 0); // flash LED at 5 Hz
##
## slots_left = lgTxPulse(h, 30, 1500, 18500, 0, 0); // move servo to centre
##
## slots_left = lgTxPulse(h, 30, 2000, 18000, 0, 0); // move servo clockwise
## ...
## D
## F

proc lgTxPwm*(handle: cint; gpio: cint; pwmFrequency: cfloat; pwmDutyCycle: cfloat;
             pwmOffset: cint; pwmCycles: cint): cint {.importc: "lgTxPwm".}
## D
## This starts software timed PWM on an output GPIO.
##
## . .
##       handle: >= 0 (as returned by [*lgGpiochipOpen*])
##         gpio: the GPIO to be pulsed
## pwmFrequency: PWM frequency in Hz (0=off, 0.1-10000)
## pwmDutyCycle: PWM duty cycle in % (0-100)
##    pwmOffset: offset from nominal pulse start position
##    pwmCycles: the number of pulses to be sent, 0 for infinite
## . .
##
## If OK returns the number of entries left in the PWM queue for the GPIO.
##
## On failure returns a negative error code.
##
## Each successful call to this function consumes one PWM queue entry.
##
## PWM is characterised by two values, its frequency (number of cycles
## per second) and its duty cycle (percentage of high time per cycle).
##
## Another PWM command may be issued to the GPIO before the last has finished.
##
## If the last pulse had infinite cycles then it will be replaced by
## the new settings at the end of the current cycle. Otherwise it will
## be replaced by the new settings when all its cycles are complete.
##
## Multiple PWM settings may be queued in this way.
## D
## F

proc lgTxServo*(handle: cint; gpio: cint; pulseWidth: cint; servoFrequency: cint;
               servoOffset: cint; servoCycles: cint): cint {.importc: "lgTxServo".}
## D
## This starts software timed servo pulses on an output GPIO.
##
## I would only use software timed servo pulses for testing purposes.  The
## timing jitter will cause the servo to fidget.  This may cause it to
## overheat and wear out prematurely.
##
## . .
##         handle: >= 0 (as returned by [*lgGpiochipOpen*])
##           gpio: the GPIO to be pulsed
##     pulseWidth: pulse high time in microseconds (0=off, 500-2500)
## servoFrequency: the number of pulses per second (40-500).
##    servoOffset: offset from nominal pulse start position
##    servoCycles: the number of pulses to be sent, 0 for infinite
## . .
##
## If OK returns the number of entries left in the PWM queue for the GPIO.
##
## On failure returns a negative error code.
##
## Each successful call to this function consumes one PWM queue entry.
##
## Another servo command may be issued to the GPIO before the last
## has finished.
##
## If the last pulse had infinite cycles then it will be replaced by
## the new settings at the end of the current cycle. Otherwise it will
## be replaced by the new settings when all its cycles are compete.
##
## Multiple servo settings may be queued in this way.
## D
## F

proc lgTxWave*(handle: cint; gpio: cint; count: cint; pulses: lgPulse_p): cint {.
    importc: "lgTxWave".}
## D
## This starts a wave on an output group of GPIO.
##
## . .
## handle: >= 0 (as returned by [*lgGpiochipOpen*])
##   gpio: the group leader
##  count: the number of pulses in the wave
## pulses: the pulses
## . .
##
## If OK returns the number of entries left in the wave queue for the group.
##
## On failure returns a negative error code.
##
## Each successful call to this function consumes one queue entry.
##
## This command starts a wave of pulses.
##
## pulses is an array of pulses to be transmitted on the group.
##
## Each pulse is defined by the following triplet:
##
## bits:  the levels to set for the selected GPIO
## mask:  the GPIO to select
## delay: the delay in microseconds before the next pulse
##
## Another wave command may be issued to the group before the
## last has finished transmission. The new wave will start when
## the previous wave has competed.
##
## Multiple waves may be queued in this way.
##
## ...
## #include <stdio.h>
##
## #include <lgpio.h>
##
## #define PULSES 2000
##
## int main(int argc, char *argv[])
## {
##    int GPIO[] =   {16, 17, 18, 19, 20, 21};
##    int levels[] = { 1,  1,  1,  1,  1,  1};
##    int h;
##    int e;
##    int mask;
##    int delay;
##    int p;
##    lgPulse_t pulses[PULSES];
##
##    h = lgGpiochipOpen(0); // open /dev/gpiochip0
##
##    if (h < 0) { printf("ERROR: %s (%d)\n", lguErrorText(h), h); return 1; }
##
##    e =  lgGroupClaimOutput(h, 0, 6, GPIO, levels);
##
##    if (e < 0) { printf("ERROR: %s (%d)\n", lguErrorText(e), e); return 1; }
##
##    mask = 0;
##    p = 0;
##
##    for (p=0; p<PULSES; p++)
##    {
##       pulses[p].bits = (p+1)>>2;  // see what sort of pattern we get
##       pulses[p].mask = mask;      // with bits and mask changing
##       pulses[p].delay = (PULSES + 500) - p;
##
##       if (++mask > 0x3f) mask = 0;
##    }
##
##    lgTxWave(h, GPIO[0], p, pulses);
##
##    while (lgTxBusy(h, GPIO[0], LG_TX_WAVE)) lguSleep(0.1);
##
##    lgGpiochipClose(h);
## }
## ...
## D
## F

proc lgTxBusy*(handle: cint; gpio: cint; kind: cint): cint {.importc: "lgTxBusy".}
## D
## This returns true if transmissions of the specified kind
## are active on the GPIO or group.
##
## . .
## handle: >= 0 (as returned by [*lgGpiochipOpen*])
##   gpio: the gpio or group to be checked
##   kind: LG_TX_PWM or LG_TX_WAVE
## . .
##
## If OK returns 1 for busy and 0 for not busy.
##
## On failure returns a negative error code.
##
## ...
## while (lgTxBusy(h, 15, LG_TX_PWM)) // wait for PWM to finish on GPIO 15
##    lguSleep(0.1);
## ...
## D
## F

proc lgTxRoom*(handle: cint; gpio: cint; kind: cint): cint {.importc: "lgTxRoom".}
## D
## This returns the number of entries available for queueing
## transmissions of the specified kind on the GPIO or group.
##
## . .
## handle: >= 0 (as returned by [*lgGpiochipOpen*])
##   gpio: the gpio or group to be checked
##   kind: LG_TX_PWM or LG_TX_WAVE
## . .
##
## If OK returns the number of free entries (0 if none).
##
## On failure returns a negative error code.
##
## ...
## while (lgTxRoom(h, 17, LG_TX_WAVE) > 0))
## {
##    // queue another wave
## }
## ...
## D
## F

proc lgGpioSetDebounce*(handle: cint; gpio: cint; debounce_us: cint): cint {.
    importc: "lgGpioSetDebounce".}
## D
## This sets the debounce time for a GPIO.
##
## . .
##      handle: >= 0 (as returned by [*lgGpiochipOpen*])
##        gpio: the GPIO to be configured
## debounce_us: the debounce time in microseconds
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## This only affects alerts.
##
## An alert will only be issued if the edge has been stable for at least
## debounce microseconds.
##
## Generally this is used to debounce mechanical switches (e.g. contact
## bounce).
##
## Suppose that a square wave at 5 Hz is being generated on a GPIO.  Each
## edge will last 100000 microseconds.  If a debounce time of 100001
## is set no alerts will be generated,  If a debounce time of 99999
## is set 10 alerts will be generated per second.
##
## Note that level changes will be timestamped debounce microseconds
## after the actual level change.
##
## ...
## lgSetDebounceTime(h, 16, 1000); // set a millisecond of debounce
## ...
## D
## F

proc lgGpioSetWatchdog*(handle: cint; gpio: cint; watchdog_us: cint): cint {.
    importc: "lgGpioSetWatchdog".}
## D
## This sets the watchdog time for a GPIO.
##
## . .
##      handle: >= 0 (as returned by [*lgGpiochipOpen*])
##        gpio: the GPIO to be configured
## watchdog_us: the watchdog time in microseconds
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## This only affects alerts.
##
## A watchdog alert will be sent if no edge alert has been issued
## for that GPIO in the previous watchdog microseconds.
##
## Note that only one watchdog alert will be sent per stream of
## edge alerts.  The watchdog is reset by the sending of a new
## edge alert.
##
## The level is set to LG_TIMEOUT (2) for a watchdog alert.
##
## ...
## lgSetWatchdogTime(h, 17, 200000); // alert if nothing for 0.2 seconds
## ...
## D
## F

proc lgGpioSetAlertsFunc*(handle: cint; gpio: cint; cbf: lgGpioAlertsFunc_t;
                         userdata: pointer): cint {.importc: "lgGpioSetAlertsFunc".}
## D
## This sets up a callback to be called when an alert
## GPIO changes state.
##
## . .
##   handle: >= 0 (as returned by [*lgGpiochipOpen*])
##     gpio: the GPIO to be monitored
##      cbf: the callback function
## userdata: a pointer to arbitrary user data
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## ...
## #include <stdio.h>
## #include <inttypes.h>
##
## #include <lgpio.h>
##
## void afunc(int e, lgGpioAlert_p evt, void *data)
## {
##    int i;
##    int userdata = *(int*)data;
##
##    for (i=0; i<e; i++)
##    {
##       printf("u=%d t=%"PRIu64" c=%d g=%d l=%d f=%d (%d of %d)\n",
##          userdata, evt[i].report.timestamp, evt[i].report.chip,
##          evt[i].report.gpio, evt[i].report.level,
##          evt[i].report.flags, i+1, e);
##    }
## }
##
## int main(int argc, char *argv[])
## {
##    int h;
##    int e;
##    static int userdata=123;
##
##    h = lgGpiochipOpen(0);
##
##    if (h < 0) { printf("ERROR: %s (%d)\n", lguErrorText(h), h); return 1; }
##
##    lgGpioSetAlertsFunc(h, GPIO, afunc, &userdata);
##
##    e = lgGpioClaimAlert(h, 0, LG_BOTH_EDGES, 23, -1);
##
##    if (e < 0) { printf("ERROR: %s (%d)\n", lguErrorText(e), e); return 1; }
##
##    lguSleep(10);
##
##    lgGpiochipClose(h);
## }
## ...
##
## Assuming square wave at 800 Hz is being received at GPIO 23.
##
## . .
## u=123 ts=1602089980691229623 c=0 g=23 l=1 f=0 (1 of 1)
## u=123 ts=1602089980691854934 c=0 g=23 l=0 f=0 (1 of 1)
## u=123 ts=1602089980692479308 c=0 g=23 l=1 f=0 (1 of 1)
## u=123 ts=1602089980693114566 c=0 g=23 l=0 f=0 (1 of 1)
## u=123 ts=1602089980693728784 c=0 g=23 l=1 f=0 (1 of 1)
## u=123 ts=1602089980694354355 c=0 g=23 l=0 f=0 (1 of 1)
## u=123 ts=1602089980694978468 c=0 g=23 l=1 f=0 (1 of 1)
## . .
## D
## F

proc lgGpioSetSamplesFunc*(cbf: lgGpioAlertsFunc_t; userdata: pointer) {.
    importc: "lgGpioSetSamplesFunc".}
## D
## This sets up a callback to be called when any alert
## GPIO changes state.
##
## . .
##      cbf: the callback function
## userdata: a pointer to arbitrary user data
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## Note that no handle or gpio is specified.  The callback function will
## receive alerts for all gpiochips and gpio.
##
## ...
## #include <stdio.h>
## #include <inttypes.h>
##
## #include <lgpio.h>
##
## void afunc(int e, lgGpioAlert_p evt, void *data)
## {
##    int i;
##    int userdata = *(int*)data;
##
##    for (i=0; i<e; i++)
##    {
##       printf("u=%d t=%"PRIu64" c=%d g=%d l=%d f=%d (%d of %d)\n",
##          userdata, evt[i].report.timestamp, evt[i].report.chip,
##          evt[i].report.gpio, evt[i].report.level,
##          evt[i].report.flags, i+1, e);
##    }
## }
##
## int main(int argc, char *argv[])
## {
##    int h;
##    static int userdata=456;
##
##    h = lgGpiochipOpen(0);
##
##    if (h < 0) { printf("ERROR: %s (%d)\n", lguErrorText(h), h); return 1; }
##
##    lgGpioSetSamplesFunc(afunc, &userdata);
##
##    lgGpioClaimAlert(h, 0, LG_BOTH_EDGES, 23, -1);
##    lgGpioClaimAlert(h, 0, LG_BOTH_EDGES, 24, -1);
##    lgGpioClaimAlert(h, 0, LG_BOTH_EDGES, 25, -1);
##
##    lguSleep(10);
##
##    lgGpiochipClose(h);
## }
## ...
##
## Assuming square wave at 800 Hz is being received at GPIO 23, 24, 25.
##
## . .
## u=456 ts=1602090898869011679 c=0 g=24 l=1 f=0 (1 of 3)
## u=456 ts=1602090898869016627 c=0 g=25 l=1 f=0 (2 of 3)
## u=456 ts=1602090898869627667 c=0 g=23 l=0 f=0 (3 of 3)
## u=456 ts=1602090898869636522 c=0 g=24 l=0 f=0 (1 of 3)
## u=456 ts=1602090898869641157 c=0 g=25 l=0 f=0 (2 of 3)
## u=456 ts=1602090898870252614 c=0 g=23 l=1 f=0 (3 of 3)
## u=456 ts=1602090898870261155 c=0 g=24 l=1 f=0 (1 of 3)
## u=456 ts=1602090898870266208 c=0 g=25 l=1 f=0 (2 of 3)
## u=456 ts=1602090898870879800 c=0 g=23 l=0 f=0 (3 of 3)
## u=456 ts=1602090898870890477 c=0 g=24 l=0 f=0 (1 of 3)
## u=456 ts=1602090898870895529 c=0 g=25 l=0 f=0 (2 of 3)
## u=456 ts=1602090898871503652 c=0 g=23 l=1 f=0 (3 of 3)
## . .
## D
##  Notifications API
##

proc lgNotifyCloseOrphans*(slot: cint; fd: cint) {.importc: "lgNotifyCloseOrphans".}
proc lgNotifyOpenWithSize*(pipeSize: cint): cint {.importc: "lgNotifyOpenWithSize".}
proc lgNotifyOpenInBand*(fd: cint): cint {.importc: "lgNotifyOpenInBand".}
## F

proc lgNotifyOpen*(): cint {.importc: "lgNotifyOpen".}
## D
## This function requests a free notification.
##
## If OK returns a handle (>= 0).
##
## On failure returns a negative error code.
##
## A notification is a method for being notified of GPIO state changes
## via a pipe or socket.
##
## The notification pipes are created in the library working directory
## (see [*lguGetWorkDir*]).
##
## Pipe notifications for handle x will be available at the pipe
## named .lgd-nfy* (where * is the handle number).  E.g. if the
## function returns 15 then the notifications must be read
## from .lgd-nfy15.
##
## Socket notifications are returned to the socket which requested the
## handle.
##
## ...
## h = lgNotifyOpen();
##
## if (h >= 0)
## {
##    sprintf(str, ".lgd-nfy%d", h);
##
##    fd = open(str, O_RDONLY);
##
##    if (fd >= 0)
##    {
##       // Okay.
##    }
##    else
##    {
##       // Error.
##    }
## }
## else
## {
##    // Error.
## }
## ...
## D
## F

proc lgNotifyResume*(handle: cint): cint {.importc: "lgNotifyResume".}
## D
## This function restarts notifications on a paused notification.
##
## . .
## handle: >= 0 (as returned by [*lgNotifyOpen*])
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## The notification gets state changes for each associated GPIO.
##
## Each notification occupies 16 bytes in the fifo and has the
## following structure.
##
## . .
## typedef struct
## {
##    culonglong timestamp; // alert time in nanoseconds
##    cchar chip;       // gpiochip device number
##    cchar gpio;       // offset into gpio device
##    cchar level;      // 0=low, 1=high, 2=timeout
##    cchar flags;      // none currently defined
## } lgGpioReport_t;
## . .
##
## timestamp: the number of nanoseconds since a kernel dependent origin.
##
## Early kernels used to provide a timestamp as the number of nanoseconds
## since the Epoch (start of 1970).  Later kernels use the number of
## nanoseconds since boot.  It's probably best not to make any assumption
## as to the timestamp origin.
##
## level: indicates the level of the GPIO.
##
## flags: no flags are currently defined.
##
## For future proofing it is probably best to ignore any notification
## with non-zero flags.
##
## ...
## // Start notifications for associated GPIO.
## lgNotifyResume(h);
## ...
## D
## F

proc lgNotifyPause*(handle: cint): cint {.importc: "lgNotifyPause".}
## D
## This function pauses notifications.
##
## . .
## handle: >= 0 (as returned by [*lgNotifyOpen*])
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## Notifications are suspended until [*lgNotifyResume*] is called.
##
## ...
## lgNotifyPause(h);
## ...
## D
## F

proc lgNotifyClose*(handle: cint): cint {.importc: "lgNotifyClose".}
## D
## This function stops notifications and frees the handle for reuse.
##
## . .
## handle: >= 0 (as returned by [*lgNotifyOpen*])
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## ...
## lgNotifyClose(h);
## ...
## D
##  I2C API
##
## F

proc lgI2cOpen*(i2cDev: cint; i2cAddr: cint; i2cFlags: cint): cint {.
    importc: "lgI2cOpen".}
## D
## This returns a handle for the device at the address on the I2C bus.
##
## . .
##   i2cDev: >= 0
##  i2cAddr: 0-0x7F
## i2cFlags: 0
## . .
##
## If OK returns a handle (>= 0).
##
## On failure returns a negative error code.
##
## No flags are currently defined.  This parameter should be set to zero.
##
## For the SMBus commands the low level transactions are shown at the end
## of the function description.  The following abbreviations are used.
##
## . .
## S      (1 bit) : Start bit
## P      (1 bit) : Stop bit
## Rd/Wr  (1 bit) : Read/Write bit. Rd equals 1, Wr equals 0
## A, NA  (1 bit) : Accept and not accept bit
## Addr   (7 bits): I2C 7 bit address
## i2cReg (8 bits): Command byte, a byte which often selects a register
## Data   (8 bits): A data byte
## Count  (8 bits): A byte defining the length of a block operation
##
## [..]: Data sent by the device
## . .
## D
## F

proc lgI2cClose*(handle: cint): cint {.importc: "lgI2cClose".}
## D
## This closes the I2C device.
##
## . .
## handle: >= 0 (as returned by [*lgI2cOpen*])
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
## D
## F

proc lgI2cWriteQuick*(handle: cint; bitVal: cint): cint {.importc: "lgI2cWriteQuick".}
## D
## This sends a single bit (in the Rd/Wr bit) to the device.
##
## . .
## handle: >= 0 (as returned by [*lgI2cOpen*])
## bitVal: 0-1, the value to write
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## Quick command. SMBus 2.0 5.5.1
## . .
## S Addr bit [A] P
## . .
## D
## F

proc lgI2cWriteByte*(handle: cint; byteVal: cint): cint {.importc: "lgI2cWriteByte".}
## D
## This sends a single byte to the device.
##
## . .
##  handle: >= 0 (as returned by [*lgI2cOpen*])
## byteVal: 0-0xFF, the value to write
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## Send byte. SMBus 2.0 5.5.2
## . .
## S Addr Wr [A] bVal [A] P
## . .
## D
## F

proc lgI2cReadByte*(handle: cint): cint {.importc: "lgI2cReadByte".}
## D
## This reads a single byte from the device.
##
## . .
## handle: >= 0 (as returned by [*lgI2cOpen*])
## . .
##
## If OK returns the byte read (0-255).
##
## On failure returns a negative error code.
##
## Receive byte. SMBus 2.0 5.5.3
## . .
## S Addr Rd [A] [Data] NA P
## . .
## D
## F

proc lgI2cWriteByteData*(handle: cint; i2cReg: cint; byteVal: cint): cint {.
    importc: "lgI2cWriteByteData".}
## D
## This writes a single byte to the specified register of the device.
##
## . .
##  handle: >= 0 (as returned by [*lgI2cOpen*])
##  i2cReg: 0-255, the register to write
## byteVal: 0-0xFF, the value to write
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## Write byte. SMBus 2.0 5.5.4
## . .
## S Addr Wr [A] i2cReg [A] bVal [A] P
## . .
## D
## F

proc lgI2cWriteWordData*(handle: cint; i2cReg: cint; wordVal: cint): cint {.
    importc: "lgI2cWriteWordData".}
## D
## This writes a single 16 bit word to the specified register of the device.
##
## . .
##  handle: >= 0 (as returned by [*lgI2cOpen*])
##  i2cReg: 0-255, the register to write
## wordVal: 0-0xFFFF, the value to write
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## Write word. SMBus 2.0 5.5.4
## . .
## S Addr Wr [A] i2cReg [A] wValLow [A] wValHigh [A] P
## . .
## D
## F

proc lgI2cReadByteData*(handle: cint; i2cReg: cint): cint {.
    importc: "lgI2cReadByteData".}
## D
## This reads a single byte from the specified register of the device.
##
## . .
## handle: >= 0 (as returned by [*lgI2cOpen*])
## i2cReg: 0-255, the register to read
## . .
##
## If OK returns the byte read (0-255).
##
## On failure returns a negative error code.
##
## Read byte. SMBus 2.0 5.5.5
## . .
## S Addr Wr [A] i2cReg [A] S Addr Rd [A] [Data] NA P
## . .
## D
## F

proc lgI2cReadWordData*(handle: cint; i2cReg: cint): cint {.
    importc: "lgI2cReadWordData".}
## D
## This reads a single 16 bit word from the specified register of the device.
##
## . .
## handle: >= 0 (as returned by [*lgI2cOpen*])
## i2cReg: 0-255, the register to read
## . .
##
## If OK returns the word read (0-65535).
##
## On failure returns a negative error code.
##
## Read word. SMBus 2.0 5.5.5
## . .
## S Addr Wr [A] i2cReg [A] S Addr Rd [A] [DataLow] A [DataHigh] NA P
## . .
## D
## F

proc lgI2cProcessCall*(handle: cint; i2cReg: cint; wordVal: cint): cint {.
    importc: "lgI2cProcessCall".}
## D
## This writes 16 bits of data to the specified register of the device
## and reads 16 bits of data in return.
##
## . .
##  handle: >= 0 (as returned by [*lgI2cOpen*])
##  i2cReg: 0-255, the register to write/read
## wordVal: 0-0xFFFF, the value to write
## . .
##
## If OK returns the word read (0-65535).
##
## On failure returns a negative error code.
##
## Process call. SMBus 2.0 5.5.6
## . .
## S Addr Wr [A] i2cReg [A] wValLow [A] wValHigh [A]
##    S Addr Rd [A] [DataLow] A [DataHigh] NA P
## . .
## D
## F

proc lgI2cWriteBlockData*(handle: cint; i2cReg: cint; txBuf: cstring; count: cint): cint {.
    importc: "lgI2cWriteBlockData".}
## D
## This writes up to 32 bytes to the specified register of the device.
##
## . .
## handle: >= 0 (as returned by [*lgI2cOpen*])
## i2cReg: 0-255, the register to write
##  txBuf: an array with the data to send
##  count: 1-32, the number of bytes to write
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## Block write. SMBus 2.0 5.5.7
## . .
## S Addr Wr [A] i2cReg [A] count [A]
##    txBuf0 [A] txBuf1 [A] ... [A] txBufn [A] P
## . .
## D
## F

proc lgI2cReadBlockData*(handle: cint; i2cReg: cint; rxBuf: cstring): cint {.
    importc: "lgI2cReadBlockData".}
## D
## This reads a block of up to 32 bytes from the specified register of
## the device.
##
## . .
## handle: >= 0 (as returned by [*lgI2cOpen*])
## i2cReg: 0-255, the register to read
##  rxBuf: an array to receive the read data
## . .
##
## The amount of returned data is set by the device.
##
## If OK returns the count of bytes read (0-32) and updates rxBuf.
##
## On failure returns a negative error code.
##
## Block read. SMBus 2.0 5.5.7
## . .
## S Addr Wr [A] i2cReg [A]
##    S Addr Rd [A] [Count] A [rxBuf0] A [rxBuf1] A ... A [rxBufn] NA P
## . .
## D
## F

proc lgI2cBlockProcessCall*(handle: cint; i2cReg: cint; ioBuf: cstring; count: cint): cint {.
    importc: "lgI2cBlockProcessCall".}
## D
## This writes data bytes to the specified register of the device
## and reads a device specified number of bytes of data in return.
##
## . .
## handle: >= 0 (as returned by [*lgI2cOpen*])
## i2cReg: 0-255, the register to write/read
##  ioBuf: an array with the data to send and to receive the read data
##  count: 1-32, the number of bytes to write
## . .
##
## If OK returns the count of bytes read (0-32) and updates ioBuf.
##
## On failure returns a negative error code.
##
## The SMBus 2.0 documentation states that a minimum of 1 byte may be
## sent and a minimum of 1 byte may be received.  The total number of
## bytes sent/received must be 32 or less.
##
## Block write-block read. SMBus 2.0 5.5.8
## . .
## S Addr Wr [A] i2cReg [A] count [A] ioBuf0 [A] ... ioBufn [A]
##    S Addr Rd [A] [Count] A [ioBuf0] A ... [ioBufn] A P
## . .
## D
## F

proc lgI2cReadI2CBlockData*(handle: cint; i2cReg: cint; rxBuf: cstring; count: cint): cint {.
    importc: "lgI2cReadI2CBlockData".}
## D
## This reads count bytes from the specified register of the device.
## The count may be 1-32.
##
## . .
## handle: >= 0 (as returned by [*lgI2cOpen*])
## i2cReg: 0-255, the register to read
##  rxBuf: an array to receive the read data
##  count: 1-32, the number of bytes to read
## . .
##
## If OK returns the count of bytes read (0-32) and updates rxBuf.
##
## On failure returns a negative error code.
##
## . .
## S Addr Wr [A] i2cReg [A]
##    S Addr Rd [A] [rxBuf0] A [rxBuf1] A ... A [rxBufn] NA P
## . .
## D
## F

proc lgI2cWriteI2CBlockData*(handle: cint; i2cReg: cint; txBuf: cstring; count: cint): cint {.
    importc: "lgI2cWriteI2CBlockData".}
## D
## This writes 1 to 32 bytes to the specified register of the device.
##
## . .
## handle: >= 0 (as returned by [*lgI2cOpen*])
## i2cReg: 0-255, the register to write
##  txBuf: the data to write
##  count: 1-32, the number of bytes to write
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## . .
## S Addr Wr [A] i2cReg [A] txBuf0 [A] txBuf1 [A] ... [A] txBufn [A] P
## . .
## D
## F

proc lgI2cReadDevice*(handle: cint; rxBuf: cstring; count: cint): cint {.
    importc: "lgI2cReadDevice".}
## D
## This reads count bytes from the raw device into rxBuf.
##
## . .
## handle: >= 0 (as returned by [*lgI2cOpen*])
##  rxBuf: an array to receive the read data bytes
##  count: >0, the number of bytes to read
## . .
##
## If OK returns count (>0) and updates rxBuf.
##
## On failure returns a negative error code.
##
## . .
## S Addr Rd [A] [rxBuf0] A [rxBuf1] A ... A [rxBufn] NA P
## . .
## D
## F

proc lgI2cWriteDevice*(handle: cint; txBuf: cstring; count: cint): cint {.
    importc: "lgI2cWriteDevice".}
## D
## This writes count bytes from txBuf to the raw device.
##
## . .
## handle: >= 0 (as returned by [*lgI2cOpen*])
##  txBuf: an array containing the data bytes to write
##  count: >0, the number of bytes to write
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
##
## . .
## S Addr Wr [A] txBuf0 [A] txBuf1 [A] ... [A] txBufn [A] P
## . .
## D
## F

proc lgI2cSegments*(handle: cint; segs: ptr lgI2cMsg_t; count: cint): cint {.
    importc: "lgI2cSegments".}
## D
## This function executes multiple I2C segments in one transaction by
## calling the I2C_RDWR ioctl.
##
## . .
## handle: >= 0 (as returned by [*lgI2cOpen*])
##   segs: an array of I2C segments
##  count: >0, the number of I2C segments
## . .
##
## If OK returns the number of segments executed.
##
## On failure returns a negative error code.
## D
## F

proc lgI2cZip*(handle: cint; txBuf: cstring; txCount: cint; rxBuf: cstring; rxCount: cint): cint {.
    importc: "lgI2cZip".}
## D
## This function executes a sequence of I2C operations.  The
## operations to be performed are specified by the contents of txBuf
## which contains the concatenated command codes and associated data.
##
## . .
##   handle: >= 0 (as returned by [*lgI2cOpen*])
##    txBuf: pointer to the concatenated I2C commands, see below
##  txCount: size of command buffer
##    rxBuf: pointer to buffer to hold returned data
##  rxCount: size of receive buffer
## . .
##
## If OK returns the count of bytes read (which may be 0) and updates rxBuf.
##
## On failure returns a negative error code.
##
## The following command codes are supported:
##
## Name    @ Cmd & Data @ Meaning
## End     @ 0          @ No more commands
## Escape  @ 1          @ Next P is two bytes
## Address @ 2 P        @ Set I2C address to P
## Flags   @ 3 lsb msb  @ Set I2C flags to lsb + (msb << 8)
## Read    @ 4 P        @ Read P bytes of data
## Write   @ 5 P ...    @ Write P bytes of data
##
## The address, read, and write commands take a parameter P.
## Normally P is one byte (0-255).  If the command is preceded by
## the Escape command then P is two bytes (0-65535, least significant
## byte first).
##
## The address defaults to that associated with the handle.
## The flags default to 0.  The address and flags maintain their
## previous value until updated.
##
## The returned I2C data is stored in consecutive locations of rxBuf.
##
## ...
## Set address 0x53, write 0x32, read 6 bytes
## Set address 0x1E, write 0x03, read 6 bytes
## Set address 0x68, write 0x1B, read 8 bytes
## End
##
## 2 0x53  5 1 0x32  4 6
## 2 0x1E  5 1 0x03  4 6
## 2 0x68  5 1 0x1B  4 8
## 0
## ...
## D
##  Serial API
##
## F

proc lgSerialOpen*(serDev: cstring; serBaud: cint; serFlags: cint): cint {.
    importc: "lgSerialOpen".}
## D
## This function opens a serial device at a specified baud rate
## and with specified flags.
##
## . .
##   serDev: the serial device to open
##  serBaud: the baud rate in bits per second, see below
## serFlags: 0
## . .
##
## If OK returns a handle (>= 0).
##
## On failure returns a negative error code.
##
## The baud rate must be one of 50, 75, 110, 134, 150,
## 200, 300, 600, 1200, 1800, 2400, 4800, 9600, 19200,
## 38400, 57600, 115200, or 230400.
##
## No flags are currently defined.  This parameter should be set to zero.
## D
## F

proc lgSerialClose*(handle: cint): cint {.importc: "lgSerialClose".}
## D
## This function closes the serial device.
##
## . .
## handle: >= 0 (as returned by [*lgSerialOpen*])
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
## D
## F

proc lgSerialWriteByte*(handle: cint; byteVal: cint): cint {.
    importc: "lgSerialWriteByte".}
## D
## This function writes the byte to the serial device.
##
## . .
##  handle: >= 0 (as returned by [*lgSerialOpen*])
## byteVal: the byte to write.
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
## D
## F

proc lgSerialReadByte*(handle: cint): cint {.importc: "lgSerialReadByte".}
## D
## This function reads a byte from the serial device.
##
## . .
## handle: >= 0 (as returned by [*lgSerialOpen*])
## . .
##
## If OK returns the byte read (0-255).
##
## On failure returns a negative error code.
## D
## F

proc lgSerialWrite*(handle: cint; txBuf: cstring; count: cint): cint {.
    importc: "lgSerialWrite".}
## D
## This function writes count bytes from txBuf to the the serial device.
##
## . .
## handle: >= 0 (as returned by [*lgSerialOpen*])
##  txBuf: the array of bytes to write
##  count: the number of bytes to write
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
## D
## F

proc lgSerialRead*(handle: cint; rxBuf: cstring; count: cint): cint {.
    importc: "lgSerialRead".}
## D
## This function reads up count bytes from the the serial device
## and writes them to rxBuf.
##
## . .
## handle: >= 0 (as returned by [*lgSerialOpen*])
##  rxBuf: an array to receive the read data
##  count: the maximum number of bytes to read
## . .
##
## If OK returns the count of bytes read (>= 0) and updates rxBuf.
##
## On failure returns a negative error code.
##
## D
## F

proc lgSerialDataAvailable*(handle: cint): cint {.importc: "lgSerialDataAvailable".}
## D
## This function returns the count of bytes available
## to be read from the device.
##
## . .
## handle: >= 0 (as returned by [*lgSerialOpen*])
## . .
##
## If OK returns the count of bytes available(>= 0).
##
## On failure returns a negative error code.
## D
##  SPI API
##
## F

proc lgSpiOpen*(spiDev: cint; spiChan: cint; spiBaud: cint; spiFlags: cint): cint {.
    importc: "lgSpiOpen".}
## D
## This function returns a handle for the SPI device on the channel.
##
## . .
##   spiDev: >= 0
##  spiChan: >= 0
##  spiBaud: the SPI speed to set in bits per second
## spiFlags: see below
## . .
##
## If OK returns a handle (>= 0).
##
## On failure returns a negative error code.
##
## The flags may be used to modify the default behaviour.
##
## spiFlags consists of the least significant 2 bits.
##
## . .
## 1  0
## m  m
## . .
##
## mm defines the SPI mode.
##
## . .
## Mode POL PHA
##  0    0   0
##  1    0   1
##  2    1   0
##  3    1   1
## . .
##
## The other bits in flags should be set to zero.
## D
## F

proc lgSpiClose*(handle: cint): cint {.importc: "lgSpiClose".}
## D
## This functions closes the SPI device.
##
## . .
## handle: >= 0 (as returned by [*lgSpiOpen*])
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
## D
## F

proc lgSpiRead*(handle: cint; rxBuf: cstring; count: cint): cint {.importc: "lgSpiRead".}
## D
## This function reads count bytes of data from the SPI
## device.
##
## . .
## handle: >= 0 (as returned by [*lgSpiOpen*])
##  rxBuf: an array to receive the read data bytes
##  count: the number of bytes to read
## . .
##
## If OK returns the count of bytes read and updates rxBuf.
##
## On failure returns a negative error code.
## D
## F

proc lgSpiWrite*(handle: cint; txBuf: cstring; count: cint): cint {.
    importc: "lgSpiWrite".}
## D
## This function writes count bytes of data from txBuf to the SPI
## device.
##
## . .
## handle: >= 0 (as returned by [*lgSpiOpen*])
##  txBuf: the data bytes to write
##  count: the number of bytes to write
## . .
##
## If OK returns the count of bytes written.
##
## On failure returns a negative error code.
## D
## F

proc lgSpiXfer*(handle: cint; txBuf: cstring; rxBuf: cstring; count: cint): cint {.
    importc: "lgSpiXfer".}
## D
## This function transfers count bytes of data from txBuf to the SPI
## device.  Simultaneously count bytes of
## data are read from the device and placed in rxBuf.
##
## . .
## handle: >= 0 (as returned by [*lgSpiOpen*])
##  txBuf: the data bytes to write
##  rxBuf: the received data bytes
##  count: the number of bytes to transfer
## . .
##
## If OK returns the count of bytes transferred and updates rxBuf.
##
## On failure returns a negative error code.
## D
##  Threads API
##
## F

# proc lgThreadStart*(f: lgThreadFunc_t; userdata: pointer): ptr pthread_t {.
#      importc: "lgThreadStart".}
## D
## Starts a new thread of execution with f as the main routine.
##
## . .
##        f: the main function for the new thread
## userdata: a pointer to arbitrary user data
## . .
##
## If OK returns a pointer to a pthread_t.
##
## On failure returns NULL.
##
## The function is passed the single argument arg.
##
## The thread can be cancelled by passing the pointer to pthread_t to
## [*lgThreadStop*].
##
## ...
## #include <stdio.h>
## #include <unistd.h>
## #include <lgpio.h>
##
## void *myfunc(void *arg)
## {
##    while (1)
##    {
##       printf("%s\n", (char *)arg);
##       sleep(1);
##    }
## }
##
## int main(int argc, char *argv[])
## {
##    pthread_t *p1, *p2, *p3;
##
##    p1 = lgThreadStart(myfunc, "thread 1"); sleep(3);
##
##    p2 = lgThreadStart(myfunc, "thread 2"); sleep(3);
##
##    p3 = lgThreadStart(myfunc, "thread 3"); sleep(3);
##
##    lgThreadStop(p3); sleep(3);
##
##    lgThreadStop(p2); sleep(3);
##
##    lgThreadStop(p1); sleep(3);
## }
## ...
## D
## F

# proc lgThreadStop*(pth: ptr pthread_t) {.importc: "lgThreadStop".}
## D
## Cancels the thread pointed at by pth.
##
## . .
## pth: a thread pointer (as returned by [*lgThreadStart*])
## . .
##
## No value is returned.
##
## The thread to be stopped should have been started with [*lgThreadStart*].
## D
## F

proc lguTimestamp*(): culonglong {.importc: "lguTimestamp".}
## D
## Returns the current timestamp.
##
## The timestamp is the number of nanoseconds since the Epoch (start
## of 1970).
## D
## F

proc lguTime*(): cdouble {.importc: "lguTime".}
## D
## Returns the current time.
##
## The time is the number of seconds since the Epoch (start
## of 1970).
## D
## F

proc lguSleep*(sleepSecs: cdouble) {.importc: "lguSleep".}
## D
## Sleeps for the specified number of seconds.
##
## . .
## sleepSecs: how long to sleep in seconds
## . .
## D
## F

proc lguSbcName*(rxBuf: cstring; count: cint): cint {.importc: "lguSbcName".}
## D
## Copies the host name of the machine running the lgpio library
## to the supplied buffer.  Up to count characters are copied.
##
## . .
## rxBuf: a buffer to receive the host name
## count: the size of the rxBuf
## . .
##
## If OK returns the count of bytes copied and updates rxBuf.
##
## On failure returns a negative error code.
## D
## F

proc lguVersion*(): cint {.importc: "lguVersion".}
## D
## Returns the lgpiolibrary version number.
## D
## F

proc lguGetInternal*(cfgId: cint; cfgVal: ptr culonglong): cint {.
    importc: "lguGetInternal".}
## D
## Get an internal configuration value.
##
## . .
##  cfgId: the item.
## cfgVal: a variable to receive the returned value
## . .
##
## If OK returns 0 and updates cfgVal.
##
## On failure returns a negative error code.
## D
## F

proc lguSetInternal*(cfgId: cint; cfgVal: culonglong): cint {.importc: "lguSetInternal".}
## D
## Set an internal configuration value.
##
## . .
##  cfgId: the item
## cfgVal: the value to set
## . .
##
## If OK returns 0.
##
## On failure returns a negative error code.
## D
## F

proc lguErrorText*(error: cint): cstring {.importc: "lguErrorText".}
## D
## Returns the error text for an error code.
##
## . .
## error: the error code
## . .
## D
## F

proc lguSetWorkDir*(dirPath: cstring) {.importc: "lguSetWorkDir".}
## D
## Sets the library working directory.
##
## This function has no affect if the working directory has already
## been set.
##
## . .
## dirPath: the directory to set as the working directory
## . .
##
## If dirPath does not start with a / the directory is relative to
## the library launch directory.
## D
## F

proc lguGetWorkDir*(): cstring {.importc: "lguGetWorkDir".}
## D
## Returns the library working directory.
## D

## PARAMS
##
## bitVal::
## A value of 0 or 1.
##
## byteVal:: 0-255
## An 8-bit byte value.
##
## cbf::
## An alerts callback function.
##
## cfgId::
## A number identifying a configuration item.
##
## . .
## LG_CFG_ID_DEBUG_LEVEL 0
## LG_CFG_ID_MIN_DELAY   1
## . .
##
## cfgVal::
## The value of a configuration item.
##
## cfgVal::
## The value of a configuration item.
##
## char::
## A single character, an 8 bit quantity able to store 0-255.
##
## chipInfo::
## A pointer to a lgChipInfo_t object.
##
## count::
## The number of items.
##
## debounce_us::
## The debounce time in microseconds.
##
## dirPath::
## A directory path which.
##
## double::
## A floating point number.
##
## eFlags::
##
## The type of GPIO edge to generate an alert.  See [*lgGpioClaimAlert*].
##
## . .
## LG_RISING_EDGE
## LG_FALLING_EDGE
## LG_BOTH_EDGES
## . .
##
## error::
## An error code.  All error codes are negative.
##
## f::
## A function.
##
## float::
## A floating point number
##
## gpio::
## A GPIO number, the offset of the GPIO from the base of the gpiochip.
## Offsets start at 0.
##
## gpioDev :: >= 0
## The device number of a gpiochip.
##
## gpios::
## An array of GPIO numbers.
##
## gpiouser::
## A string of up to 32 characters denoting the user of a GPIO.
##
## groupBits::
## A 64-bit value used to set the levels of a group.
##
## Set bit x to set GPIO x of the group high.
##
## Clear bit x to set GPIO x of the group low.
##
## groupBits::
## A 64-bit value denoting the levels of a group.
##
## If bit x is set then GPIO x of the group is high.
##
## groupMask::
## A 64-bit value used to determine which members of a group
## should be updated.
##
## Set bit x to update GPIO x of the group.
##
## Clear bit x to leave GPIO x of the group unaltered.
##
## handle:: >= 0
##
## A number referencing an object opened by one of
##
## [*lgGpiochipOpen*]
## [*lgI2cOpen*]
## [*lgNotifyOpen*]
## [*lgSerialOpen*]
## [*lgSpiOpen*]
##
## i2cAddr:: 0-0x7F
## The address of a device on the I2C bus.
##
## i2cDev::>= 0
## An I2C device number.
##
## i2cFlags::0
## Flags which modify an I2C open command.  None are currently defined.
##
## i2cReg:: 0-255
## A register of an I2C device.
##
## int::
## A whole number, negative or positive.
##
## ioBuf::
## A pointer to a buffer used to hold data to send and the data received.
##
## kind:: LG_TX_PWM or LG_TX_WAVE
## A type of transmission: PWM or wave.
##
## level::
## A GPIO level (0 or 1).
##
## levels::
## An array of GPIO levels.
##
## lFlags::
##
## line flags for the GPIO.
##
## The following values may be or'd to form the value.
##
## . .
## LG_SET_ACTIVE_LOW
## LG_SET_OPEN_DRAIN
## LG_SET_OPEN_SOURCE
## LG_SET_PULL_UP
## LG_SET_PULL_DOWN
## LG_SET_PULL_NONE
## . .
##
## lgChipInfo_p::
## A pointer to a lgChipInfo_t object.
##
## . .
## typedef struct lgChipInfo_s
## {
##    cuint lines;                // number of GPIO
##    char name[LG_GPIO_NAME_LEN];   // Linux name
##    char label[LG_GPIO_LABEL_LEN]; // functional name
## } lgChipInfo_t, *lgChipInfo_p;
## . .
##
## lgGpioAlert_t::
##
## . .
## typedef struct lgGpioAlert_s
## {
##    lgGpioReport_t report;
##    int nfyHandle;
## } lgGpioAlert_t, *lgGpioAlert_p;
## . .
##
## See [*lgGpioReport_t*].
##
##
## lgGpioAlertsFunc_t::
##
## . .
## typedef void (*lgGpioAlertsFunc_t)
##    (int num_alerts, lgGpioAlert_p alerts, void *userdata);
## . .
##
## See [*lgGpioAlert_t*].
##
## lgGpioReport_t::
##
## . .
## typedef struct
## {
##    culonglong timestamp; // alert time in nanoseconds
##    cchar chip;       // gpiochip device number
##    cchar gpio;       // offset into gpio device
##    cchar level;      // 0=low, 1=high, 2=watchdog
##    cchar flags;      // none defined, ignore report if non-zero
## } lgGpioReport_t;
## . .
##
## Early kernels used to provide a timestamp as the number of nanoseconds
## since the Epoch (start of 1970).  Later kernels use the number of
## nanoseconds since boot.  It's probably best not to make any assumption
## as to the timestamp origin.
##
## lgI2cMsg_t::
## . .
## typedef struct
## {
##    cushort addr;  // slave address
##    cushort flags;
##    cushort len;   // msg length
##    cchar  *buf;  // pointer to msg data
## } lgI2cMsg_t;
## . .
##
## lgLineInfo_p::
## A pointer to a lgLineInfo_t object.
##
## . .
## typedef struct lgLine_s
## {
##    cuint offset;               // GPIO number
##    cuint lFlags;
##    char name[LG_GPIO_NAME_LEN];   // GPIO name
##    char user[LG_GPIO_USER_LEN];   // user
## } lgLineInfo_t, *lgLineInfo_p;
## . .
##
## lgPulse_p::
## A pointer to a lgPulse_t object.
##
## . .
## typedef struct lgPulse_s
## {
##    culonglong bits;
##    culonglong mask;
##    clonglong delay;
## } lgPulse_t, *lgPulse_p;
## . .
##
# lgThreadFunc_t::
## . .
# typedef void *(lgThreadFunc_t) (void *);
## . .
##
## lineInfo::
## A pointer to a lgLineInfo_t object.
##
## nfyHandle:: >= 0
## This associates a notification with a GPIO alert.
##
## pth::
## A thread identifier, returned by [*lgGpioStartThread*].
##
## pthread_t::
## A thread identifier.
##
## pulseCycles:: >= 0
## The number of PWM pulses to generate.  A value of 0 means infinite.
##
## pulseOff:: >= 0
## The off period for a PWM pulse in microseconds.
##
## pulseOffset:: >= 0
## The offset in microseconds from the nominal PWM pulse start.
##
## pulseOn:: >= 0
## The on period for a PWM pulse in microseconds.
##
## pulses::
## An pointer to an array of lgPulse_t objects.
##
## pulseWidth:: 0, 500-2500 microseconds
## Servo pulse width
##
## pwmCycles:: >= 0
## The number of PWM pulses to generate.  A value of 0 means infinite.
##
## pwmDutyCycle:: 0-100 %
## PWM duty cycle %
##
## pwmFrequency:: 0.1-10000 Hz
## PWM frequency
##
## pwmOffset:: >= 0
## The offset in microseconds from the nominal PWM pulse start.
##
## rxBuf::
## A pointer to a buffer used to receive data.
##
## rxCount::
## The size of an input buffer.
##
## segs::
## An array of segments which make up a combined I2C transaction.
##
## serBaud::
## The speed of serial communication in bits per second.
##
## serDev::
## The name of a serial tty device, e.g. /dev/ttyAMA0, /dev/ttyUSB0, /dev/tty1.
##
## serFlags::
## Flags which modify a serial open command.  None are currently defined.
##
## servoCycles:: >= 0
## The number of servo pulses to generate.  A value of 0 means infinite.
##
## servoFrequency:: 40-500 Hz
## Servo pulse frequency
##
## servoOffset:: >= 0
## The offset in microseconds from the nominal servo pulse start.
##
## sleepSecs:: >= 0.0
## The number of seconds to sleep (may be fractional).
##
## spiBaud::
## The speed of serial communication in bits per second.
##
## spiChan::
## A SPI channel, >= 0.
##
## spiDev::
## A SPI device, >= 0.
##
## spiFlags::
## See [*lgSpiOpen*].
##
## txBuf::
## An pointer to a buffer of data to transmit.
##
## txCount::
## The size of an output buffer.
##
## culonglong::
## A 64-bit unsigned value.
##
## userdata::
## A pointer to arbitrary user data.  This may be used to identify the instance.
##
## You must ensure that the pointer is in scope at the time it is processed.  If
## it is a pointer to a global this is automatic.  Do not pass the address of a
## local variable.  If you want to pass a transient object then use the
## following technique.
##
## In the calling function:
##
## . .
## user_type *userdata;
## user_type my_userdata;
##
## userdata = malloc(sizeof(user_type));
## userdata = my_userdata;
## . .
##
## In the receiving function:
##
## . .
## user_type my_userdata = *(user_type*)userdata;
##
## free(userdata);
## . .
##
## void::
## Denoting no parameter is required.
##
## watchdog_us::
## The watchdog time in microseconds.
##
## wordVal:: 0-65535
## A 16-bit value.
##
## PARAMS
## DEF_S Error Codes

const
  LG_OKAY* = 0
  LG_INIT_FAILED* = -1
  LG_BAD_MICROS* = -2
  LG_BAD_PATHNAME* = -3
  LG_NO_HANDLE* = -4
  LG_BAD_HANDLE* = -5
  LG_BAD_SOCKET_PORT* = -6
  LG_NOT_PERMITTED* = -7
  LG_SOME_PERMITTED* = -8
  LG_BAD_SCRIPT* = -9
  LG_BAD_TX_TYPE* = -10
  LG_GPIO_IN_USE* = -11
  LG_BAD_PARAM_NUM* = -12
  LG_DUP_TAG* = -13
  LG_TOO_MANY_TAGS* = -14
  LG_BAD_SCRIPT_CMD* = -15
  LG_BAD_VAR_NUM* = -16
  LG_NO_SCRIPT_ROOM* = -17
  LG_NO_MEMORY* = -18
  LG_SOCK_READ_FAILED* = -19
  LG_SOCK_WRIT_FAILED* = -20
  LG_TOO_MANY_PARAM* = -21
  LG_SCRIPT_NOT_READY* = -22
  LG_BAD_TAG* = -23
  LG_BAD_MICS_DELAY* = -24
  LG_BAD_MILS_DELAY* = -25
  LG_I2C_OPEN_FAILED* = -26
  LG_SERIAL_OPEN_FAILED* = -27
  LG_SPI_OPEN_FAILED* = -28
  LG_BAD_I2C_BUS* = -29
  LG_BAD_I2C_ADDR* = -30
  LG_BAD_SPI_CHANNEL* = -31
  LG_BAD_I2C_FLAGS* = -32
  LG_BAD_SPI_FLAGS* = -33
  LG_BAD_SERIAL_FLAGS* = -34
  LG_BAD_SPI_SPEED* = -35
  LG_BAD_SERIAL_DEVICE* = -36
  LG_BAD_SERIAL_SPEED* = -37
  LG_BAD_FILE_PARAM* = -38
  LG_BAD_I2C_PARAM* = -39
  LG_BAD_SERIAL_PARAM* = -40
  LG_I2C_WRITE_FAILED* = -41
  LG_I2C_READ_FAILED* = -42
  LG_BAD_SPI_COUNT* = -43
  LG_SERIAL_WRITE_FAILED* = -44
  LG_SERIAL_READ_FAILED* = -45
  LG_SERIAL_READ_NO_DATA* = -46
  LG_UNKNOWN_COMMAND* = -47
  LG_SPI_XFER_FAILED* = -48
  LG_BAD_POINTER* = -49
  LG_MSG_TOOBIG* = -50
  LG_BAD_MALLOC_MODE* = -51
  LG_TOO_MANY_SEGS* = -52
  LG_BAD_I2C_SEG* = -53
  LG_BAD_SMBUS_CMD* = -54
  LG_BAD_I2C_WLEN* = -55
  LG_BAD_I2C_RLEN* = -56
  LG_BAD_I2C_CMD* = -57
  LG_FILE_OPEN_FAILED* = -58
  LG_BAD_FILE_MODE* = -59
  LG_BAD_FILE_FLAG* = -60
  LG_BAD_FILE_READ* = -61
  LG_BAD_FILE_WRITE* = -62
  LG_FILE_NOT_ROPEN* = -63
  LG_FILE_NOT_WOPEN* = -64
  LG_BAD_FILE_SEEK* = -65
  LG_NO_FILE_MATCH* = -66
  LG_NO_FILE_ACCESS* = -67
  LG_FILE_IS_A_DIR* = -68
  LG_BAD_SHELL_STATUS* = -69
  LG_BAD_SCRIPT_NAME* = -70
  LG_CMD_INTERRUPTED* = -71
  LG_BAD_EVENT_REQUEST* = -72
  LG_BAD_GPIO_NUMBER* = -73
  LG_BAD_GROUP_SIZE* = -74
  LG_BAD_LINEINFO_IOCTL* = -75
  LG_BAD_READ* = -76
  LG_BAD_WRITE* = -77
  LG_CANNOT_OPEN_CHIP* = -78
  LG_GPIO_BUSY* = -79
  LG_GPIO_NOT_ALLOCATED* = -80
  LG_NOT_A_GPIOCHIP* = -81
  LG_NOT_ENOUGH_MEMORY* = -82
  LG_POLL_FAILED* = -83
  LG_TOO_MANY_GPIOS* = -84
  LG_UNEGPECTED_ERROR* = -85
  LG_BAD_PWM_MICROS* = -86
  LG_NOT_GROUP_LEADER* = -87
  LG_SPI_IOCTL_FAILED* = -88
  LG_BAD_GPIOCHIP* = -89
  LG_BAD_CHIPINFO_IOCTL* = -90
  LG_BAD_CONFIG_FILE* = -91
  LG_BAD_CONFIG_VALUE* = -92
  LG_NO_PERMISSIONS* = -93
  LG_BAD_USERNAME* = -94
  LG_BAD_SECRET* = -95
  LG_TX_QUEUE_FULL* = -96
  LG_BAD_CONFIG_ID* = -97
  LG_BAD_DEBOUNCE_MICS* = -98
  LG_BAD_WATCHDOG_MICS* = -99
  LG_BAD_SERVO_FREQ* = -100
  LG_BAD_SERVO_WIDTH* = -101
  LG_BAD_PWM_FREQ* = -102
  LG_BAD_PWM_DUTY* = -103
  LG_GPIO_NOT_AN_OUTPUT* = -104
  LG_INVALID_GROUP_ALERT* = -105

## DEF_E
