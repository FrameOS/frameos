import std/json

## The context the host hands a driver, and the only Nim graph that still
## crosses the driver `.so` boundary as a live ref (see frameos/driver_abi).
##
## Every ref here is `{.acyclic.}`, and that is load-bearing rather than
## decorative: ORC cannot prove it on its own, because `DriverLogger.log` is a
## closure and a closure environment is opaque to the cycle analysis. Left
## unproven, ORC treats the whole graph as cyclic, and a cyclic ref that one
## runtime allocated and another decrefs takes the process down inside
## `unregisterCycle`. The graph really is a DAG — nothing below reaches back up
## to `DriverContext` — so the annotation costs nothing; were it ever wrong the
## penalty would be a leak, not a crash.

type
  HttpHeaderPair* = object
    name*: string
    value*: string

  GPIOButton* {.acyclic.} = ref object
    pin*: int
    label*: string

  PinOverrides* {.acyclic.} = ref object
    ## GPIO remap for SPI panel drivers; -1 = keep the driver's default pin.
    rst*, dc*, cs*, busy*, sclk*, mosi*, pwr*: int

  DeviceConfig* {.acyclic.} = ref object
    vcom*: float
    partial*: bool
    partialMaxAreaPercent*: float
    partialMaxRefreshesBeforeFull*: int
    httpUploadUrl*: string
    httpUploadHeaders*: seq[HttpHeaderPair]
    pins*: PinOverrides

  PaletteConfig* {.acyclic.} = ref object
    colors*: seq[(int, int, int)]

  DriverFrameConfig* {.acyclic.} = ref object
    mode*: string
    device*: string
    debug*: bool
    width*: int
    height*: int
    deviceConfig*: DeviceConfig
    gpioButtons*: seq[GPIOButton]
    palette*: PaletteConfig

  DriverLogger* {.acyclic.} = ref object
    log*: proc(payload: JsonNode)
    enabled*: bool
    debug*: bool

  DriverContext* {.acyclic.} = ref object
    frameConfig*: DriverFrameConfig
    logger*: DriverLogger

  FrameOSDriver* = ref object of RootObj
    name*: string
