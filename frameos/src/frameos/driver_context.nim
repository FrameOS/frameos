import std/json

type
  HttpHeaderPair* = object
    name*: string
    value*: string

  GPIOButton* = ref object
    pin*: int
    label*: string

  PinOverrides* = ref object
    ## GPIO remap for SPI panel drivers; -1 = keep the driver's default pin.
    rst*, dc*, cs*, busy*, sclk*, mosi*, pwr*: int

  DeviceConfig* = ref object
    vcom*: float
    partial*: bool
    partialMaxAreaPercent*: float
    partialMaxRefreshesBeforeFull*: int
    httpUploadUrl*: string
    httpUploadHeaders*: seq[HttpHeaderPair]
    pins*: PinOverrides

  PaletteConfig* = ref object
    colors*: seq[(int, int, int)]

  DriverFrameConfig* = ref object
    mode*: string
    device*: string
    debug*: bool
    width*: int
    height*: int
    deviceConfig*: DeviceConfig
    gpioButtons*: seq[GPIOButton]
    palette*: PaletteConfig

  DriverLogger* = ref object
    log*: proc(payload: JsonNode)
    enabled*: bool
    debug*: bool

  DriverContext* = ref object
    frameConfig*: DriverFrameConfig
    logger*: DriverLogger

  FrameOSDriver* = ref object of RootObj
    name*: string
