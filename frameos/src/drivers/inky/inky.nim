import osproc, os, streams, pixie, json

from frameos/types import FrameOS, FrameConfig, Logger
from frameos/logger import log

proc init*(frameOS: FrameOS) =
  discard

proc safeLog(logger: Logger, message: string) =
  try:
    let parsed = parseJson(message)
    parsed["event"] = %*("driver:inky")
    logger.log(parsed)
  except:
    logger.log(%*{"event": "driver:inky", "log": message})

proc render*(frameOS: FrameOS, image: Image) =
  let imageData = image.encodeImage(BmpFormat)
  let process = startProcess(workingDir = "./vendor/inky",
      command = "./env/bin/python3", args = ["run.py"], options = {poStdErrToStdOut})
  let pOut = process.outputStream()
  let pIn = process.inputStream()
  var line = ""
  frameOS.logger.safeLog("Logging")

  while pOut.readLine(line):
    frameOS.logger.safeLog(line)

  for x in imageData:
    pIn.write x

  pIn.flush
  pIn.close() # NOTE **Essential** - This prevents hanging/freezing when reading stdout below

  while process.running:
    while pOut.readLine(line):
      frameOS.logger.safeLog(line)
    sleep(100)
  while pOut.readLine(line):
    frameOS.logger.safeLog(line)
  process.close()
