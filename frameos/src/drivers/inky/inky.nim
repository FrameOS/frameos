import osproc, os, streams, pixie, json

from frameos/types import FrameOS, FrameConfig, Logger
from frameos/logger import log

proc init*(frameOS: FrameOS) =
  discard

proc safeLog(logger: Logger, message: string): JsonNode =
  try:
    result = parseJson(message)
    result["event"] = %*("driver:inky")
  except:
    result = %*{"event": "driver:inky", "log": message}
  logger.log(result)

proc render*(frameOS: FrameOS, image: Image) =
  let imageData = image.encodeImage(BmpFormat)
  let process = startProcess(workingDir = "./vendor/inky",
      command = "./env/bin/python3", args = ["run.py"], options = {poStdErrToStdOut})
  let pOut = process.outputStream()
  let pIn = process.inputStream()
  var line = ""
  discard frameOS.logger.safeLog("Logging")

  var i = 0
  block toploop:
    while process.running:
      while pOut.readLine(line):
        let json = frameOS.logger.safeLog(line)
        if json{"inky"}.getBool(false): # block until we get inky=true
          break toploop
      sleep(100)
      i += 1
      if i > 100:
        discard frameOS.logger.safeLog("Looped for 10s! Breaking!")
        break toploop

  discard frameOS.logger.safeLog("Writing output")
  for x in imageData:
    pIn.write x
  discard frameOS.logger.safeLog("Wrote output")

  pIn.flush
  pIn.close() # NOTE **Essential** - This prevents hanging/freezing when reading stdout below

  while process.running:
    while pOut.readLine(line):
      discard frameOS.logger.safeLog(line)
    sleep(100)
  while pOut.readLine(line):
    discard frameOS.logger.safeLog(line)
  process.close()
