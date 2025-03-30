import osproc, os, streams, pixie, json, options, strutils
import frameos/types

type ScreenInfo* = object
  width*: int
  height*: int
  color*: string

type Driver* = ref object of FrameOSDriver
  screenInfo: ScreenInfo
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

proc init*(frameOS: FrameOS): Driver =
  discard frameOS.logger.safeLog("Initializing Inky driver")

  result = Driver(
    name: "inkyPython",
    screenInfo: ScreenInfo(
      width: 0,
      height: 0,
      color: ""
    ),
    logger: frameOS.logger,
    debug: frameOS.frameConfig.debug
  )

  let process = startProcess(workingDir = "/srv/frameos/vendor/inkyPython",
      command = "./env/bin/python3", args = ["check.py"], options = {poStdErrToStdOut})
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

  let process = startProcess(workingDir = "/srv/frameos/vendor/inkyPython",
      command = "./env/bin/python3", args = ["run.py"], options = {poStdErrToStdOut})
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
