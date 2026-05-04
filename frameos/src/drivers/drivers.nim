
import pixie
import frameos/types
import frameos/driver_context as driverContext
import waveshare/waveshare as waveshareDriver
var waveshareDriverInstance: waveshareDriver.Driver

proc buildDriverContext(frameOS: FrameOS): driverContext.DriverContext =
  let sourceConfig = frameOS.frameConfig
  let sourceDeviceConfig = sourceConfig.deviceConfig
  var deviceConfig = driverContext.DeviceConfig(
    vcom: 0.0,
    httpUploadUrl: "",
    httpUploadHeaders: @[],
  )
  if not sourceDeviceConfig.isNil:
    deviceConfig.vcom = sourceDeviceConfig.vcom
    deviceConfig.httpUploadUrl = sourceDeviceConfig.httpUploadUrl
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
  waveshareDriverInstance = waveshareDriver.init(driverCtx)
  syncDriverContext(frameOS, driverCtx)

proc render*(image: Image) =
  waveshareDriverInstance.render(image)

proc toPng*(rotate: int, flip: string): string =
  return waveshareDriver.toPng(rotate, flip)

proc turnOn*() =
  discard

proc turnOff*() =
  discard
    