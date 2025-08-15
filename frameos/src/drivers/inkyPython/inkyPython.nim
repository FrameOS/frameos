import osproc, os, streams, pixie, json, options, strutils, strformat, locks
import frameos/types
import frameos/utils/dither
import frameos/utils/image

type ScreenInfo* = object
  width*: int
  height*: int
  color*: string

type Driver* = ref object of FrameOSDriver
  screenInfo: ScreenInfo
  mode*: string
  device*: string
  palette*: PaletteConfig
  logger: Logger
  lastImageData: seq[ColorRGBX]
  debug: bool

var
  lastPixelsLock: Lock
  lastPixels: seq[uint8] = @[]
  lastWidth: int
  lastHeight: int

proc setLastPixels*(image: seq[uint8], width: int, height: int) =
  withLock lastPixelsLock:
    lastPixels = image
    lastWidth = width
    lastHeight = height

proc getLastPixels*(): seq[uint8] =
  withLock lastPixelsLock:
    result = lastPixels

proc notifyImageAvailable*(self: Driver) =
  self.logger.log(%*{"event": "render:dither", "info": "Dithered image available"})

proc safeLog(logger: Logger, message: string): JsonNode =
  try:
    result = parseJson(message)
    result["event"] = %*("driver:inky")
  except:
    result = %*{"event": "driver:inky", "log": message}
  logger.log(result)

proc safeStartProcess*(cmd: string; args: seq[string] = @[];
                       wdir: string; logger: Logger): Option[Process] =
  try:
    result = some startProcess(
      workingDir = wdir,
      command = cmd,
      args = args,
      options = {poStdErrToStdOut}
    )
  except OSError as e:
    let errorMsg = fmt"Error starting process '{cmd}': {e.msg}"
    discard logger.safeLog(errorMsg)
    result = none(Process)

proc deviceArgs(dev: string): seq[string] =
  if dev.len > 0: @["--device", dev] else: @[]

proc init*(frameOS: FrameOS): Driver =
  discard frameOS.logger.safeLog("Initializing Inky driver")

  result = Driver(
    name: "inkyPython",
    screenInfo: ScreenInfo(
      width: 0,
      height: 0,
      color: ""
    ),
    device: frameOS.frameConfig.device,
    mode: frameOS.frameConfig.mode,
    logger: frameOS.logger,
    debug: frameOS.frameConfig.debug,
    palette: frameOS.frameConfig.palette,
  )

  let pOpt =
    if result.mode == "nixos":
      safeStartProcess("/nix/var/nix/profiles/system/sw/bin/inkyPython-check",
                       deviceArgs(result.device),
                       "/srv/frameos/vendor/inkyPython", result.logger)
    else:
      safeStartProcess("./env/bin/python3",
                       @["check.py"] & deviceArgs(result.device),
                       "/srv/frameos/vendor/inkyPython", result.logger)

  if pOpt.isNone:
    discard result.logger.safeLog("Inky command not found - driver disabled.")
    return # leave screenInfo width/height = 0 ➜ renderer will noop

  let process = pOpt.get()
  let pOut = process.outputStream()
  var line = ""
  var i = 0
  block toploop:
    while process.running:
      while pOut.readLine(line):
        let json = frameOS.logger.safeLog(line)
        if json{"inky"}.getBool(false):
          if json{"width"}.getInt(-1) > 0 and json{"height"}.getInt(-1) > 0:
            result.screenInfo.width = json{"width"}.getInt(-1)
            result.screenInfo.height = json{"height"}.getInt(-1)
            result.screenInfo.color = json{"color"}.getStr("")
            frameOS.frameConfig.width = result.screenInfo.width
            frameOS.frameConfig.height = result.screenInfo.height
          break toploop
        if json{"error"}.getStr() != "": # block until we get error
          # TODO: abort driver init
          break toploop
      sleep(100)
      i += 1
      if i > 100:
        discard frameOS.logger.safeLog("Looped for 10s! Breaking!")
          # TODO: abort driver init
        break toploop

  process.close()

proc render*(self: Driver, image: Image) =
  if self.lastImageData == image.data:
    discard self.logger.safeLog("Skipping render. Identical to last render.")
    return
  self.lastImageData = image.data

  var imageData: seq[uint8]
  var extraArgs: seq[string] = @[]
  if self.device == "pimoroni.inky_impression_7" or self.device == "pimoroni.inky_impression_13":
    var palette: seq[(int, int, int)]
    if self.palette != nil and self.palette.colors.len > 0:
      let c = self.palette.colors
      palette = @[
        (c[0][0], c[0][1], c[0][2]),
        (c[1][0], c[1][1], c[1][2]),
        (c[2][0], c[2][1], c[2][2]),
        (c[3][0], c[3][1], c[3][2]),
        (999, 999, 999),
        (c[4][0], c[4][1], c[4][2]),
        (c[5][0], c[5][1], c[5][2]),
      ]
    else:
      palette = spectra6ColorPalette
    imageData = ditherPaletteIndexed(image, palette)
    setLastPixels(imageData, image.width, image.height)
    self.notifyImageAvailable()
    extraArgs.add "--raw"
  else:
    imageData = cast[seq[uint8]](image.encodeImage(BmpFormat))

  let pOpt =
    if self.mode == "nixos":
      safeStartProcess("/nix/var/nix/profiles/system/sw/bin/inkyPython-run",
                       deviceArgs(self.device) & extraArgs,
                       "/srv/frameos/vendor/inkyPython", self.logger)
    else:
      safeStartProcess("./env/bin/python3",
                       @["run.py"] & deviceArgs(self.device) & extraArgs,
                       "/srv/frameos/vendor/inkyPython", self.logger)

  if pOpt.isNone:
    discard self.logger.safeLog("Render skipped - command missing.")
    return

  let process = pOpt.get()
  let pOut = process.outputStream()
  let pIn = process.inputStream()
  var line = ""
  if self.debug:
    discard self.logger.safeLog("Executing")

  var i = 0
  var error = false
  block toploop:
    while process.running:
      while pOut.readLine(line):
        let json = self.logger.safeLog(line)
        if json{"inky"}.getBool(false): # block until we get inky=true
          break toploop
        if json{"error"}.getStr() != "": # block until we get error
          error = true
          break toploop
      sleep(100)
      i += 1
      if i > 100:
        discard self.logger.safeLog("Looped for 10s! Breaking!")
        error = true
        break toploop

  if error:
    process.close()
    return

  if self.debug:
    discard self.logger.safeLog("Writing output")
  for x in imageData:
    pIn.write x
  if self.debug:
    discard self.logger.safeLog("Wrote output")

  pIn.flush
  pIn.close() # NOTE **Essential** - This prevents hanging/freezing when reading stdout below

  let skipped_warning = "Busy Wait: Held high. Waiting for "

  while process.running:
    while pOut.readLine(line):
      if self.debug or not (skipped_warning in line):
        discard self.logger.safeLog(line)
    sleep(100)
  while pOut.readLine(line):
    discard self.logger.safeLog(line)

  process.close()

# Convert the rendered pixels to a PNG image. For accurate colors on the web.
proc toPng*(rotate: int = 0): string =
  let width = lastWidth
  let height = lastHeight
  var outputImage = newImage(width, height)

  let pixels = getLastPixels()
  if pixels.len == 0:
    raise newException(Exception, "No render yet")
  for y in 0 ..< height:
    for x in 0 ..< width:
      let index = y * width + x
      let pixelIndex = index div 2
      let pixelShift = (1 - (index mod 2)) * 4
      let pixel = (pixels[pixelIndex] shr pixelShift) and 0x07
      outputImage.data[index].r = spectra6ColorPalette[pixel][0].uint8
      outputImage.data[index].g = spectra6ColorPalette[pixel][1].uint8
      outputImage.data[index].b = spectra6ColorPalette[pixel][2].uint8
      outputImage.data[index].a = 255

  if rotate != 0:
    return outputImage.rotateDegrees(rotate).encodeImage(PngFormat)

  return outputImage.encodeImage(PngFormat)
