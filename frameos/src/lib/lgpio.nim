## Native FrameOS lgpio-compatible subset.
##
## Attribution:
## - This module ports the lgpio APIs used by FrameOS from Joan Aimer's
##   `joan2937/lg` project, pinned in this repository at upstream tag v0.2.2
##   (commit b959a17d723360e85648316757b02dbea9902feb).
## - The upstream v0.2.2 C implementation declares the Unlicense/public-domain
##   dedication in its source files. FrameOS itself is distributed under AGPL.
## - The public function names and constants intentionally match lgpio so the
##   remaining Waveshare C driver shims can link against these Nim exports
##   without liblgpio or librgpio.
##
## Scope:
## This is not a full lgpio clone. It implements the GPIO, SPI, sleep, and
## error-text surface currently used by FrameOS drivers:
## lgGpiochipOpen/Close, lgGpioClaimInput/Output/Alert, lgGpioRead/Write,
## lgGpioSetDebounce, lgGpioSetAlertsFunc, lgSpiOpen/Close/Read/Write,
## lguSleep, lguVersion, and lguErrorText.

import std/strformat

{.passL: "-pthread".}

const
  LGPIO_VERSION* = 0x00020200

  LG_GPIO_LABEL_LEN* = 32
  LG_GPIO_NAME_LEN* = 32
  LG_GPIO_USER_LEN* = 32

  LG_RISING_EDGE* = 1
  LG_FALLING_EDGE* = 2
  LG_BOTH_EDGES* = 3

  LG_SET_ACTIVE_LOW* = 4
  LG_SET_OPEN_DRAIN* = 8
  LG_SET_OPEN_SOURCE* = 16
  LG_SET_PULL_UP* = 32
  LG_SET_PULL_DOWN* = 64
  LG_SET_PULL_NONE* = 128
  LG_SET_REALTIME_CLOCK* = 256
  LG_SET_INPUT* = 512
  LG_SET_OUTPUT* = 1024

  LG_LOW* = 0
  LG_HIGH* = 1
  LG_TIMEOUT* = 2

  LG_MAX_MICS_DEBOUNCE* = 5_000_000
  LG_MAX_SPI_DEVICE_COUNT* = (1 shl 16)

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

  ChipModeUnknown = 0
  ChipBitInput = 1 shl 0
  ChipBitOutput = 1 shl 1
  ChipBitAlert = 1 shl 2

type
  lgChipInfo_t* {.bycopy.} = object
    lines*: cuint
    name*: array[LG_GPIO_NAME_LEN, char]
    label*: array[LG_GPIO_LABEL_LEN, char]

  lgChipInfo_p* = ptr lgChipInfo_t

  lgGpioReport_t* {.bycopy.} = object
    timestamp*: culonglong
    chip*: cchar
    gpio*: cchar
    level*: cchar
    flags*: cchar

  lgGpioAlert_t* {.bycopy.} = object
    report*: lgGpioReport_t
    nfyHandle*: cint

  lgGpioAlert_p* = ptr lgGpioAlert_t

  lgLineInfo_t* {.bycopy.} = object
    offset*: cuint
    lFlags*: cuint
    name*: array[LG_GPIO_NAME_LEN, char]
    user*: array[LG_GPIO_USER_LEN, char]

  lgLineInfo_p* = ptr lgLineInfo_t

  lgGpioAlertsFunc_t* = proc(
    num_alerts: cint;
    alerts: lgGpioAlert_p;
    userdata: pointer
  ) {.cdecl.}

type
  GpiochipInfo {.importc: "struct gpiochip_info", header: "<linux/gpio.h>", bycopy.} = object
    name: array[32, char]
    label: array[32, char]
    lines: uint32

  GpioV2LineValues {.importc: "struct gpio_v2_line_values", header: "<linux/gpio.h>", bycopy.} = object
    bits: uint64
    mask: uint64

  GpioV2LineAttribute {.importc: "struct gpio_v2_line_attribute", header: "<linux/gpio.h>", bycopy.} = object
    id: uint32
    padding: uint32
    values: uint64

  GpioV2LineConfigAttribute {.importc: "struct gpio_v2_line_config_attribute", header: "<linux/gpio.h>", bycopy.} = object
    attr: GpioV2LineAttribute
    mask: uint64

  GpioV2LineConfig {.importc: "struct gpio_v2_line_config", header: "<linux/gpio.h>", bycopy.} = object
    flags: uint64
    num_attrs: uint32
    padding: array[5, uint32]
    attrs: array[10, GpioV2LineConfigAttribute]

  GpioV2LineRequest {.importc: "struct gpio_v2_line_request", header: "<linux/gpio.h>", bycopy.} = object
    offsets: array[64, uint32]
    consumer: array[32, char]
    config: GpioV2LineConfig
    num_lines: uint32
    event_buffer_size: uint32
    padding: array[5, uint32]
    fd: int32

  GpioV2LineEvent {.importc: "struct gpio_v2_line_event", header: "<linux/gpio.h>", bycopy.} = object
    timestamp_ns: uint64
    id: uint32
    offset: uint32
    seqno: uint32
    line_seqno: uint32
    padding: array[6, uint32]

  SpiIocTransfer {.importc: "struct spi_ioc_transfer", header: "<linux/spi/spidev.h>", bycopy.} = object
    tx_buf: uint64
    rx_buf: uint64
    len: uint32
    speed_hz: uint32
    delay_usecs: uint16
    bits_per_word: uint8
    cs_change: uint8
    tx_nbits: uint8
    rx_nbits: uint8
    word_delay_usecs: uint8
    pad: uint8

  PollFd {.importc: "struct pollfd", header: "<poll.h>", bycopy.} = object
    fd: cint
    events: cshort
    revents: cshort

  Timespec {.importc: "struct timespec", header: "<time.h>", bycopy.} = object
    tv_sec: clong
    tv_nsec: clong

let
  O_RDWR {.importc: "O_RDWR", header: "<fcntl.h>".}: cint
  O_CLOEXEC {.importc: "O_CLOEXEC", header: "<fcntl.h>".}: cint
  EBUSY {.importc: "EBUSY", header: "<errno.h>".}: cint
  POLLIN {.importc: "POLLIN", header: "<poll.h>".}: cshort
  POLLPRI {.importc: "POLLPRI", header: "<poll.h>".}: cshort
  CLOCK_MONOTONIC {.importc: "CLOCK_MONOTONIC", header: "<time.h>".}: cint
  GPIO_GET_CHIPINFO_IOCTL {.importc: "GPIO_GET_CHIPINFO_IOCTL", header: "<linux/gpio.h>".}: culong
  GPIO_V2_GET_LINE_IOCTL {.importc: "GPIO_V2_GET_LINE_IOCTL", header: "<linux/gpio.h>".}: culong
  GPIO_V2_LINE_GET_VALUES_IOCTL {.importc: "GPIO_V2_LINE_GET_VALUES_IOCTL", header: "<linux/gpio.h>".}: culong
  GPIO_V2_LINE_SET_VALUES_IOCTL {.importc: "GPIO_V2_LINE_SET_VALUES_IOCTL", header: "<linux/gpio.h>".}: culong
  GPIO_V2_LINE_FLAG_INPUT {.importc: "GPIO_V2_LINE_FLAG_INPUT", header: "<linux/gpio.h>".}: uint64
  GPIO_V2_LINE_FLAG_OUTPUT {.importc: "GPIO_V2_LINE_FLAG_OUTPUT", header: "<linux/gpio.h>".}: uint64
  GPIO_V2_LINE_FLAG_EDGE_RISING {.importc: "GPIO_V2_LINE_FLAG_EDGE_RISING", header: "<linux/gpio.h>".}: uint64
  GPIO_V2_LINE_FLAG_EDGE_FALLING {.importc: "GPIO_V2_LINE_FLAG_EDGE_FALLING", header: "<linux/gpio.h>".}: uint64
  GPIO_V2_LINE_FLAG_ACTIVE_LOW {.importc: "GPIO_V2_LINE_FLAG_ACTIVE_LOW", header: "<linux/gpio.h>".}: uint64
  GPIO_V2_LINE_FLAG_OPEN_DRAIN {.importc: "GPIO_V2_LINE_FLAG_OPEN_DRAIN", header: "<linux/gpio.h>".}: uint64
  GPIO_V2_LINE_FLAG_OPEN_SOURCE {.importc: "GPIO_V2_LINE_FLAG_OPEN_SOURCE", header: "<linux/gpio.h>".}: uint64
  GPIO_V2_LINE_FLAG_BIAS_PULL_UP {.importc: "GPIO_V2_LINE_FLAG_BIAS_PULL_UP", header: "<linux/gpio.h>".}: uint64
  GPIO_V2_LINE_FLAG_BIAS_PULL_DOWN {.importc: "GPIO_V2_LINE_FLAG_BIAS_PULL_DOWN", header: "<linux/gpio.h>".}: uint64
  GPIO_V2_LINE_FLAG_BIAS_DISABLED {.importc: "GPIO_V2_LINE_FLAG_BIAS_DISABLED", header: "<linux/gpio.h>".}: uint64
  GPIO_V2_LINE_ATTR_ID_OUTPUT_VALUES {.importc: "GPIO_V2_LINE_ATTR_ID_OUTPUT_VALUES", header: "<linux/gpio.h>".}: uint32
  GPIO_V2_LINE_EVENT_RISING_EDGE {.importc: "GPIO_V2_LINE_EVENT_RISING_EDGE", header: "<linux/gpio.h>".}: uint32
  GPIO_V2_LINE_EVENT_FALLING_EDGE {.importc: "GPIO_V2_LINE_EVENT_FALLING_EDGE", header: "<linux/gpio.h>".}: uint32
  SPI_IOC_WR_MODE {.importc: "SPI_IOC_WR_MODE", header: "<linux/spi/spidev.h>".}: culong
  SPI_IOC_WR_BITS_PER_WORD {.importc: "SPI_IOC_WR_BITS_PER_WORD", header: "<linux/spi/spidev.h>".}: culong
  SPI_IOC_WR_MAX_SPEED_HZ {.importc: "SPI_IOC_WR_MAX_SPEED_HZ", header: "<linux/spi/spidev.h>".}: culong

{.emit: """
#include <linux/spi/spidev.h>
static unsigned long frameos_lgpio_spi_ioc_message_1(void) {
  return SPI_IOC_MESSAGE(1);
}
""".}

proc spiIocMessage1(): culong {.importc: "frameos_lgpio_spi_ioc_message_1", cdecl.}

proc cOpen(path: cstring; flags: cint): cint {.importc: "open", header: "<fcntl.h>", varargs.}
proc cClose(fd: cint): cint {.importc: "close", header: "<unistd.h>".}
proc cRead(fd: cint; buf: pointer; count: csize_t): clong {.importc: "read", header: "<unistd.h>".}
proc ioctl(fd: cint; request: culong): cint {.importc: "ioctl", header: "<sys/ioctl.h>", varargs.}
proc poll(fds: ptr PollFd; nfds: culong; timeout: cint): cint {.importc: "poll", header: "<poll.h>".}
proc usleep(usec: cuint): cint {.importc: "usleep", header: "<unistd.h>".}
proc clockGettime(clkId: cint; tp: ptr Timespec): cint {.importc: "clock_gettime", header: "<time.h>".}
proc errnoLocation(): ptr cint {.importc: "__errno_location", header: "<errno.h>".}

{.emit: """
#include <pthread.h>
static pthread_mutex_t frameos_lgpio_alert_mutex = PTHREAD_MUTEX_INITIALIZER;
static void frameos_lgpio_alert_lock(void) {
  pthread_mutex_lock(&frameos_lgpio_alert_mutex);
}
static void frameos_lgpio_alert_unlock(void) {
  pthread_mutex_unlock(&frameos_lgpio_alert_mutex);
}
""".}

proc alertLock() {.importc: "frameos_lgpio_alert_lock", cdecl.}
proc alertUnlock() {.importc: "frameos_lgpio_alert_unlock", cdecl.}

type
  AlertRecord = ref object
    chip: ChipState
    gpio: int
    nfyHandle: cint
    active: bool
    debounceNs: uint64
    pending: bool
    pendingTs: uint64
    pendingLevel: int
    lastReportLevel: int
    eFlags: int

  LineState = ref object
    fd: cint
    mode: int
    valueBits: uint64
    debounceUs: int
    alertFunc: lgGpioAlertsFunc_t
    userdata: pointer
    alert: AlertRecord

  ChipState = ref object
    gpiochip: cint
    fd: cint
    lines: int
    userLabel: string
    line: seq[LineState]

  SpiState = ref object
    fd: cint
    speed: cint
    flags: cint

  HandleKind = enum
    hkGpio, hkSpi

  HandleState = ref object
    kind: HandleKind
    chip: ChipState
    spi: SpiState

var
  handles: seq[HandleState] = @[]
  alerts: seq[AlertRecord] = @[]
  alertThreadStarted = false

proc lastErrno(): cint =
  errnoLocation()[]

proc safeClose(fd: var cint) =
  if fd >= 0:
    discard cClose(fd)
    fd = -1

proc setConsumer(consumer: var array[32, char]; value: string) =
  let n = min(value.len, consumer.len - 1)
  for i in 0 ..< consumer.len:
    consumer[i] = '\0'
  for i in 0 ..< n:
    consumer[i] = value[i]

proc monotonicNs(): uint64 =
  var ts: Timespec
  if clockGettime(CLOCK_MONOTONIC, addr ts) == 0:
    return uint64(ts.tv_sec) * 1_000_000_000'u64 + uint64(ts.tv_nsec)
  0

proc makeFlags(flags: cint): uint64 =
  if (flags and LG_RISING_EDGE) != 0: result = result or GPIO_V2_LINE_FLAG_EDGE_RISING
  if (flags and LG_FALLING_EDGE) != 0: result = result or GPIO_V2_LINE_FLAG_EDGE_FALLING
  if (flags and LG_SET_ACTIVE_LOW) != 0: result = result or GPIO_V2_LINE_FLAG_ACTIVE_LOW
  if (flags and LG_SET_OPEN_DRAIN) != 0: result = result or GPIO_V2_LINE_FLAG_OPEN_DRAIN
  if (flags and LG_SET_OPEN_SOURCE) != 0: result = result or GPIO_V2_LINE_FLAG_OPEN_SOURCE
  if (flags and LG_SET_PULL_UP) != 0: result = result or GPIO_V2_LINE_FLAG_BIAS_PULL_UP
  if (flags and LG_SET_PULL_DOWN) != 0: result = result or GPIO_V2_LINE_FLAG_BIAS_PULL_DOWN
  if (flags and LG_SET_PULL_NONE) != 0: result = result or GPIO_V2_LINE_FLAG_BIAS_DISABLED
  if (flags and LG_SET_INPUT) != 0: result = result or GPIO_V2_LINE_FLAG_INPUT
  if (flags and LG_SET_OUTPUT) != 0: result = result or GPIO_V2_LINE_FLAG_OUTPUT

proc allocHandle(state: HandleState): cint =
  for i, handle in handles.mpairs:
    if handle.isNil:
      handle = state
      return cint(i)
  handles.add(state)
  cint(handles.high)

proc getHandle(handle: cint; kind: HandleKind; status: var cint): HandleState =
  if handle < 0 or handle.int >= handles.len or handles[handle.int].isNil:
    status = LG_BAD_HANDLE
    return nil
  result = handles[handle.int]
  if result.kind != kind:
    status = LG_BAD_HANDLE
    return nil
  status = LG_OKAY

proc getChip(handle: cint; status: var cint): ChipState =
  let h = getHandle(handle, hkGpio, status)
  if status == LG_OKAY:
    result = h.chip

proc getSpi(handle: cint; status: var cint): SpiState =
  let h = getHandle(handle, hkSpi, status)
  if status == LG_OKAY:
    result = h.spi

proc freeLine(line: LineState) =
  if line.isNil:
    return
  if not line.alert.isNil:
    alertLock()
    line.alert.active = false
    alertUnlock()
  safeClose(line.fd)
  line.mode = ChipModeUnknown
  line.valueBits = 0

proc claimLine(chip: ChipState; gpio: cint; flags: cint; outputValue: ptr cint): cint =
  if chip.isNil:
    return LG_BAD_HANDLE
  if gpio < 0 or gpio.int >= chip.lines:
    return LG_BAD_GPIO_NUMBER

  let line = chip.line[gpio.int]
  freeLine(line)

  var req: GpioV2LineRequest
  req.num_lines = 1
  req.offsets[0] = uint32(gpio)
  setConsumer(req.consumer, chip.userLabel)

  var requestFlags = flags
  if outputValue.isNil:
    requestFlags = (requestFlags and not LG_SET_OUTPUT) or LG_SET_INPUT
    req.config.flags = makeFlags(requestFlags)
  else:
    requestFlags = (requestFlags and not LG_SET_INPUT) or LG_SET_OUTPUT
    req.config.flags = makeFlags(requestFlags)
    req.config.num_attrs = 1
    req.config.attrs[0].attr.id = GPIO_V2_LINE_ATTR_ID_OUTPUT_VALUES
    req.config.attrs[0].mask = 1
    req.config.attrs[0].attr.values = if outputValue[] == 0: 0'u64 else: 1'u64

  if ioctl(chip.fd, GPIO_V2_GET_LINE_IOCTL, addr req) != 0:
    if lastErrno() == EBUSY:
      return LG_GPIO_BUSY
    return LG_UNEGPECTED_ERROR

  line.fd = cint(req.fd)
  line.mode = if outputValue.isNil: ChipBitInput else: ChipBitOutput
  line.valueBits = if outputValue.isNil or outputValue[] == 0: 0'u64 else: 1'u64
  LG_OKAY

proc emitAlert(rec: AlertRecord; level: int; timestamp: uint64) =
  if rec.isNil or not rec.active:
    return
  let line = rec.chip.line[rec.gpio]
  if line.alertFunc.isNil:
    return

  var alert: lgGpioAlert_t
  alert.report.timestamp = culonglong(timestamp)
  alert.report.chip = cchar(rec.chip.gpiochip)
  alert.report.gpio = cchar(rec.gpio)
  alert.report.level = cchar(level)
  alert.report.flags = cchar(0)
  alert.nfyHandle = rec.nfyHandle
  line.alertFunc(1, addr alert, line.userdata)
  rec.lastReportLevel = level

proc processDebounce(rec: AlertRecord; now: uint64) =
  if rec.isNil or not rec.active or not rec.pending:
    return
  if now < rec.pendingTs + rec.debounceNs:
    return
  if rec.eFlags != LG_BOTH_EDGES or rec.lastReportLevel != rec.pendingLevel:
    emitAlert(rec, rec.pendingLevel, rec.pendingTs + rec.debounceNs)
  rec.pending = false

proc handleEvent(rec: AlertRecord; event: GpioV2LineEvent) =
  let level =
    if event.id == GPIO_V2_LINE_EVENT_RISING_EDGE: LG_HIGH
    elif event.id == GPIO_V2_LINE_EVENT_FALLING_EDGE: LG_LOW
    else: return

  if rec.debounceNs == 0:
    emitAlert(rec, level, event.timestamp_ns)
  else:
    rec.pending = true
    rec.pendingTs = event.timestamp_ns
    rec.pendingLevel = level

proc alertThreadMain(_: pointer): pointer {.cdecl.} =
  var fds: array[64, PollFd]
  var recs: array[64, AlertRecord]
  var events: array[128, GpioV2LineEvent]

  while true:
    var count = 0
    alertLock()
    try:
      for rec in alerts:
        if rec.active and rec.chip.line[rec.gpio].fd >= 0 and count < fds.len:
          fds[count].fd = rec.chip.line[rec.gpio].fd
          fds[count].events = POLLIN or POLLPRI
          fds[count].revents = 0
          recs[count] = rec
          inc count
    finally:
      alertUnlock()

    if count == 0:
      discard usleep(10_000)
      continue

    let ready = poll(addr fds[0], culong(count), 10)
    if ready > 0:
      for i in 0 ..< count:
        if fds[i].revents != 0:
          let bytes = cRead(fds[i].fd, addr events[0], csize_t(sizeof(events)))
          if bytes > 0:
            let eventCount = int(bytes div clong(sizeof(GpioV2LineEvent)))
            for e in 0 ..< min(eventCount, events.len):
              handleEvent(recs[i], events[e])

    let now = monotonicNs()
    for i in 0 ..< count:
      processDebounce(recs[i], now)

  nil

proc pthreadCreate(
  thread: ptr culong;
  attr: pointer;
  startRoutine: proc(arg: pointer): pointer {.cdecl.};
  arg: pointer
): cint {.importc: "pthread_create", header: "<pthread.h>".}
proc pthreadDetach(thread: culong): cint {.importc: "pthread_detach", header: "<pthread.h>".}

proc ensureAlertThread() =
  if alertThreadStarted:
    return
  var thread: culong
  if pthreadCreate(addr thread, nil, alertThreadMain, nil) == 0:
    discard pthreadDetach(thread)
    alertThreadStarted = true

proc lgGpiochipOpen*(gpioDev: cint): cint {.exportc, cdecl.} =
  if gpioDev < 0:
    return LG_BAD_GPIOCHIP

  var info: GpiochipInfo
  let chipName = &"/dev/gpiochip{gpioDev}"
  var fd = cOpen(chipName.cstring, O_RDWR or O_CLOEXEC)
  if fd < 0:
    return LG_CANNOT_OPEN_CHIP

  if ioctl(fd, GPIO_GET_CHIPINFO_IOCTL, addr info) != 0:
    discard cClose(fd)
    return LG_NOT_A_GPIOCHIP

  var chip = ChipState(
    gpiochip: gpioDev,
    fd: fd,
    lines: int(info.lines),
    userLabel: "lg",
    line: newSeq[LineState](int(info.lines)),
  )
  for i in 0 ..< chip.lines:
    chip.line[i] = LineState(fd: -1, mode: ChipModeUnknown)

  allocHandle(HandleState(kind: hkGpio, chip: chip))

proc lgGpiochipClose*(handle: cint): cint {.exportc, cdecl.} =
  var status: cint
  let chip = getChip(handle, status)
  if status != LG_OKAY:
    return status

  for line in chip.line:
    freeLine(line)
  safeClose(chip.fd)
  handles[handle.int] = nil
  LG_OKAY

proc lgGpioClaimInput*(handle: cint; lFlags: cint; gpio: cint): cint {.exportc, cdecl.} =
  var status: cint
  let chip = getChip(handle, status)
  if status != LG_OKAY:
    return status
  claimLine(chip, gpio, lFlags, nil)

proc lgGpioClaimOutput*(handle: cint; lFlags: cint; gpio: cint; level: cint): cint {.exportc, cdecl.} =
  var status: cint
  let chip = getChip(handle, status)
  if status != LG_OKAY:
    return status
  var outputLevel = level
  claimLine(chip, gpio, lFlags, addr outputLevel)

proc lgGpioClaimAlert*(handle: cint; lFlags: cint; eFlags: cint; gpio: cint; nfyHandle: cint): cint {.exportc, cdecl.} =
  var status: cint
  let chip = getChip(handle, status)
  if status != LG_OKAY:
    return status
  if gpio < 0 or gpio.int >= chip.lines:
    return LG_BAD_GPIO_NUMBER

  let line = chip.line[gpio.int]
  freeLine(line)

  var req: GpioV2LineRequest
  req.num_lines = 1
  req.offsets[0] = uint32(gpio)
  req.config.flags = makeFlags(lFlags or eFlags or LG_SET_INPUT)
  req.event_buffer_size = 16
  setConsumer(req.consumer, chip.userLabel)

  if ioctl(chip.fd, GPIO_V2_GET_LINE_IOCTL, addr req) != 0:
    return LG_BAD_EVENT_REQUEST

  line.fd = cint(req.fd)
  line.mode = ChipBitAlert
  let rec = AlertRecord(
    chip: chip,
    gpio: gpio.int,
    nfyHandle: nfyHandle,
    active: true,
    debounceNs: uint64(max(0, line.debounceUs)) * 1000'u64,
    pending: false,
    lastReportLevel: -1,
    eFlags: eFlags.int,
  )
  line.alert = rec
  alertLock()
  alerts.add(rec)
  alertUnlock()
  ensureAlertThread()
  LG_OKAY

proc lgGpioFree*(handle: cint; gpio: cint): cint {.exportc, cdecl.} =
  var status: cint
  let chip = getChip(handle, status)
  if status != LG_OKAY:
    return status
  if gpio < 0 or gpio.int >= chip.lines:
    return LG_BAD_GPIO_NUMBER
  freeLine(chip.line[gpio.int])
  LG_OKAY

proc lgGpioRead*(handle: cint; gpio: cint): cint {.exportc, cdecl.} =
  var status: cint
  let chip = getChip(handle, status)
  if status != LG_OKAY:
    return status
  if gpio < 0 or gpio.int >= chip.lines:
    return LG_BAD_GPIO_NUMBER

  let line = chip.line[gpio.int]
  if line.mode == ChipModeUnknown:
    status = claimLine(chip, gpio, 0, nil)
    if status != LG_OKAY:
      return status

  if line.fd < 0:
    return LG_GPIO_NOT_ALLOCATED

  var values: GpioV2LineValues
  values.mask = 1
  if ioctl(line.fd, GPIO_V2_LINE_GET_VALUES_IOCTL, addr values) != 0:
    return LG_BAD_READ
  if (values.bits and 1'u64) == 0: LG_LOW else: LG_HIGH

proc lgGpioWrite*(handle: cint; gpio: cint; level: cint): cint {.exportc, cdecl.} =
  var status: cint
  let chip = getChip(handle, status)
  if status != LG_OKAY:
    return status
  if gpio < 0 or gpio.int >= chip.lines:
    return LG_BAD_GPIO_NUMBER

  let line = chip.line[gpio.int]
  if (line.mode and ChipBitOutput) == 0:
    return LG_GPIO_NOT_AN_OUTPUT

  if level == 0:
    line.valueBits = line.valueBits and not 1'u64
  else:
    line.valueBits = line.valueBits or 1'u64

  var values: GpioV2LineValues
  values.mask = 1
  values.bits = line.valueBits
  if ioctl(line.fd, GPIO_V2_LINE_SET_VALUES_IOCTL, addr values) != 0:
    return LG_BAD_WRITE
  LG_OKAY

proc lgGpioSetDebounce*(handle: cint; gpio: cint; debounceUs: cint): cint {.exportc, cdecl.} =
  if debounceUs < 0 or debounceUs > LG_MAX_MICS_DEBOUNCE:
    return LG_BAD_DEBOUNCE_MICS

  var status: cint
  let chip = getChip(handle, status)
  if status != LG_OKAY:
    return status
  if gpio < 0 or gpio.int >= chip.lines:
    return LG_BAD_GPIO_NUMBER

  let line = chip.line[gpio.int]
  line.debounceUs = debounceUs.int
  if not line.alert.isNil:
    line.alert.debounceNs = uint64(debounceUs) * 1000'u64
  LG_OKAY

proc lgGpioSetAlertsFunc*(
  handle: cint;
  gpio: cint;
  cbf: lgGpioAlertsFunc_t;
  userdata: pointer
): cint {.exportc, cdecl.} =
  var status: cint
  let chip = getChip(handle, status)
  if status != LG_OKAY:
    return status
  if gpio < 0 or gpio.int >= chip.lines:
    return LG_BAD_GPIO_NUMBER
  chip.line[gpio.int].alertFunc = cbf
  chip.line[gpio.int].userdata = userdata
  LG_OKAY

proc lgSpiOpen*(spiDev: cint; spiChan: cint; spiBaud: cint; spiFlags: cint): cint {.exportc, cdecl.} =
  let dev = &"/dev/spidev{spiDev}.{spiChan}"
  var fd = cOpen(dev.cstring, O_RDWR)
  if fd < 0:
    return LG_SPI_OPEN_FAILED

  var mode = uint8(spiFlags and 3)
  var bits = uint8(8)
  var speed = uint32(spiBaud)
  if ioctl(fd, SPI_IOC_WR_MODE, addr mode) < 0:
    discard cClose(fd)
    return LG_SPI_IOCTL_FAILED
  if ioctl(fd, SPI_IOC_WR_BITS_PER_WORD, addr bits) < 0:
    discard cClose(fd)
    return LG_SPI_IOCTL_FAILED
  if ioctl(fd, SPI_IOC_WR_MAX_SPEED_HZ, addr speed) < 0:
    discard cClose(fd)
    return LG_SPI_IOCTL_FAILED

  let spi = SpiState(fd: fd, speed: spiBaud, flags: spiFlags)
  allocHandle(HandleState(kind: hkSpi, spi: spi))

proc lgSpiClose*(handle: cint): cint {.exportc, cdecl.} =
  var status: cint
  let spi = getSpi(handle, status)
  if status != LG_OKAY:
    return status
  safeClose(spi.fd)
  handles[handle.int] = nil
  LG_OKAY

proc spiXfer(spi: SpiState; txBuf: cstring; rxBuf: cstring; count: cint): cint =
  var transfer: SpiIocTransfer
  transfer.tx_buf = uint64(cast[uint](txBuf))
  transfer.rx_buf = uint64(cast[uint](rxBuf))
  transfer.len = uint32(count)
  transfer.speed_hz = uint32(spi.speed)
  transfer.bits_per_word = 8
  if ioctl(spi.fd, spiIocMessage1(), addr transfer) >= 0:
    count
  else:
    LG_SPI_XFER_FAILED

proc lgSpiRead*(handle: cint; rxBuf: cstring; count: cint): cint {.exportc, cdecl.} =
  if count <= 0 or count > LG_MAX_SPI_DEVICE_COUNT:
    return LG_BAD_SPI_COUNT
  var status: cint
  let spi = getSpi(handle, status)
  if status != LG_OKAY:
    return status
  spiXfer(spi, nil, rxBuf, count)

proc lgSpiWrite*(handle: cint; txBuf: cstring; count: cint): cint {.exportc, cdecl.} =
  if count <= 0 or count > LG_MAX_SPI_DEVICE_COUNT:
    return LG_BAD_SPI_COUNT
  var status: cint
  let spi = getSpi(handle, status)
  if status != LG_OKAY:
    return status
  spiXfer(spi, txBuf, nil, count)

proc lguSleep*(sleepSecs: cdouble) {.exportc, cdecl.} =
  if sleepSecs <= 0:
    return
  var remaining = int64(sleepSecs * 1_000_000.0)
  while remaining > 0:
    let chunk = min(remaining, 1_000_000'i64)
    discard usleep(cuint(chunk))
    remaining -= chunk

proc lguVersion*(): cint {.exportc, cdecl.} =
  LGPIO_VERSION

proc lguErrorText*(error: cint): cstring {.exportc, cdecl.} =
  case error
  of LG_OKAY: "no error"
  of LG_BAD_HANDLE: "unknown handle"
  of LG_NOT_PERMITTED: "GPIO operation not permitted"
  of LG_SPI_OPEN_FAILED: "can not open SPI device"
  of LG_BAD_SPI_COUNT: "bad SPI count"
  of LG_SPI_XFER_FAILED: "spi xfer/read/write failed"
  of LG_BAD_EVENT_REQUEST: "bad event request"
  of LG_BAD_GPIO_NUMBER: "bad GPIO number"
  of LG_BAD_READ: "bad GPIO read"
  of LG_BAD_WRITE: "bad GPIO write"
  of LG_CANNOT_OPEN_CHIP: "can not open gpiochip"
  of LG_GPIO_BUSY: "GPIO busy"
  of LG_GPIO_NOT_ALLOCATED: "GPIO not allocated"
  of LG_NOT_A_GPIOCHIP: "not a gpiochip"
  of LG_NOT_ENOUGH_MEMORY: "not enough memory"
  of LG_UNEGPECTED_ERROR: "unexpected error"
  of LG_SPI_IOCTL_FAILED: "SPI ioctl failed"
  of LG_BAD_GPIOCHIP: "bad gpiochip"
  of LG_BAD_DEBOUNCE_MICS: "bad debounce microseconds"
  of LG_GPIO_NOT_AN_OUTPUT: "GPIO not set as an output"
  of LG_INVALID_GROUP_ALERT: "can not set a group to alert"
  else: "unknown error"
