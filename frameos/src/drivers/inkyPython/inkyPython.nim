import osproc, os, streams, pixie, json, options, strutils, strformat
import frameos/types
import frameos/utils/dither

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

proc paletteArgs(p: PaletteConfig, device: string): seq[string] =
  if p != nil and p.colors.len > 0:
    let arr = newJArray()
    for (r, g, b) in p.colors:
      arr.add( %* [r, g, b])
    @["--palette", $arr]
  elif device == "pimoroni.inky_impression_7" or device == "pimoroni.inky_impression_13":
    let arr = newJArray()
    for (r, g, b) in spectra6ColorPalette:
      if r < 256 and b < 256 and g < 256:
        arr.add( %* [r, g, b])
    @["--palette", $arr]
  else:
    @[]

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
  let imageData = image.encodeImage(BmpFormat)

  let pOpt =
    if self.mode == "nixos":
      safeStartProcess("/nix/var/nix/profiles/system/sw/bin/inkyPython-run",
                       deviceArgs(self.device) & paletteArgs(self.palette, self.device),
                       "/srv/frameos/vendor/inkyPython", self.logger)
    else:
      safeStartProcess("./env/bin/python3",
                       @["run.py"] & deviceArgs(self.device) & paletteArgs(self.palette, self.device),
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
