
import pixie
import frameos/types
import frameos/driver_context as driverContext
import frameos/device_setup



proc buildDriverContext(frameOS: FrameOS): driverContext.DriverContext =
  let sourceConfig = frameOS.frameConfig
  let sourceDeviceConfig = sourceConfig.deviceConfig
  var deviceConfig = driverContext.DeviceConfig(
    vcom: 0.0,
    partial: false,
    partialMaxAreaPercent: 0.0,
    partialMaxRefreshesBeforeFull: 0,
    httpUploadUrl: "",
    httpUploadHeaders: @[],
    pins: driverContext.PinOverrides(rst: -1, dc: -1, cs: -1, busy: -1, sclk: -1, mosi: -1, pwr: -1),
  )
  if not sourceDeviceConfig.isNil:
    deviceConfig.vcom = sourceDeviceConfig.vcom
    deviceConfig.partial = sourceDeviceConfig.partial
    deviceConfig.partialMaxAreaPercent = sourceDeviceConfig.partialMaxAreaPercent
    deviceConfig.partialMaxRefreshesBeforeFull = sourceDeviceConfig.partialMaxRefreshesBeforeFull
    deviceConfig.httpUploadUrl = sourceDeviceConfig.httpUploadUrl
    if not sourceDeviceConfig.pins.isNil:
      deviceConfig.pins = driverContext.PinOverrides(
        rst: sourceDeviceConfig.pins.rst,
        dc: sourceDeviceConfig.pins.dc,
        cs: sourceDeviceConfig.pins.cs,
        busy: sourceDeviceConfig.pins.busy,
        sclk: sourceDeviceConfig.pins.sclk,
        mosi: sourceDeviceConfig.pins.mosi,
        pwr: sourceDeviceConfig.pins.pwr,
      )
    for header in sourceDeviceConfig.httpUploadHeaders:
      deviceConfig.httpUploadHeaders.add(driverContext.HttpHeaderPair(
        name: header.name,
        value: header.value,
      ))

  var palette = driverContext.PaletteConfig(colors: @[])
  if not sourceConfig.palette.isNil:
    palette.colors = sourceConfig.palette.colors

  var config = driverContext.DriverFrameConfig(
    mode: sourceConfig.mode,
    device: sourceConfig.device,
    debug: sourceConfig.debug,
    width: sourceConfig.width,
    height: sourceConfig.height,
    deviceConfig: deviceConfig,
    gpioButtons: @[],
    palette: palette,
  )
  for button in sourceConfig.gpioButtons:
    config.gpioButtons.add(driverContext.GPIOButton(pin: button.pin, label: button.label))

  result = driverContext.DriverContext(
    frameConfig: config,
    logger: driverContext.DriverLogger(
      log: frameOS.logger.log,
      enabled: frameOS.logger.enabled,
      debug: sourceConfig.debug,
    ),
  )

proc syncDriverContext(frameOS: FrameOS, context: driverContext.DriverContext) =
  if context.isNil or context.frameConfig.isNil:
    return
  frameOS.frameConfig.width = context.frameConfig.width
  frameOS.frameConfig.height = context.frameConfig.height


proc init*(frameOS: FrameOS) =
  let driverCtx = buildDriverContext(frameOS)
  discard
  syncDriverContext(frameOS, driverCtx)

proc render*(image: Image) =
  discard

proc toPng*(rotate: int, flip: string): string =
  result = ""

proc turnOn*() =
  discard

proc turnOff*() =
  discard

proc setupDriverNames*(): seq[string] =
  result = @[]

proc availableDriverNames*(): seq[string] =
  result = @[]

proc setup*(frameOS: FrameOS): SetupResult =
  discard frameOS
  result = setupOk()
