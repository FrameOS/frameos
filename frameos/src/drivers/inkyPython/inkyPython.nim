import osproc, os, streams, pixie, json, options

from frameos/types import FrameConfig, Logger

proc init*(logger: Logger) =
  # TODO: check for display
  discard

var lastImageData: seq[ColorRGBX]

proc safeLog(logger: Logger, message: string): JsonNode =
  try:
    result = parseJson(message)
    result["event"] = %*("driver:inky")
  except:
    result = %*{"event": "driver:inky", "log": message}
  logger.log(result)

proc render*(logger: Logger, image: Image) =
  if lastImageData == image.data:
    discard logger.safeLog("Skipping render. Identical to last render.")
    echo "Skipping render"
    return
  lastImageData = image.data
  let imageData = image.encodeImage(BmpFormat)

  let process = startProcess(workingDir = "./vendor/inky",
      command = "./env/bin/python3", args = ["run.py"], options = {poStdErrToStdOut})
  let pOut = process.outputStream()
  let pIn = process.inputStream()
  var line = ""
  discard logger.safeLog("Executing")

  var i = 0
  var error = false
  block toploop:
    while process.running:
      while pOut.readLine(line):
        let json = logger.safeLog(line)
        if json{"inky"}.getBool(false): # block until we get inky=true
          break toploop
        if json{"error"}.getStr() != "": # block until we get error
          error = true
          break toploop
      sleep(100)
      i += 1
      if i > 100:
        discard logger.safeLog("Looped for 10s! Breaking!")
        error = true
        break toploop

  if error:
    process.close()
    return

  discard logger.safeLog("Writing output")
  for x in imageData:
    pIn.write x
  discard logger.safeLog("Wrote output")

  pIn.flush
  pIn.close() # NOTE **Essential** - This prevents hanging/freezing when reading stdout below

  while process.running:
    while pOut.readLine(line):
      discard logger.safeLog(line)
    sleep(100)
  while pOut.readLine(line):
    discard logger.safeLog(line)

  process.close()
