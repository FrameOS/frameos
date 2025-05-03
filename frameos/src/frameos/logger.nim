import zippy, json, os, times, strutils, net, httpclient

import frameos/channels
import frameos/types

type
  LoggerThread = ref object
    frameConfig: FrameConfig
    client: HttpClient
    url: string
    logs: seq[(float, JsonNode)]
    lastSendAt: float

const LOG_FLUSH_SECONDS = 1.0

var threadInitDone = false
var thread: Thread[FrameConfig]
var logFile: File

proc logToFile(filename: string, logJson: JsonNode) =
  try:
    if filename.len > 0:
      let file = if "{date}" in filename:
        filename.replace("{date}", now().format("yyyyMMdd"))
      else:
        filename
      logFile = open(file, fmAppend)
      logFile.write(now().format("[yyyy-MM-dd'T'HH:mm:ss]") & " " & $logJson & "\n")
      logFile.close()
  except Exception as e:
    echo "Error writing to log file: " & $e.msg

proc `%`*(payload: (float, JsonNode)): JsonNode =
  let (timestamp, log) = payload
  result = %*[timestamp, log]

proc processQueue(self: LoggerThread): int =
  let logCount = self.logs.len
  if logCount > 1000 or (logCount > 0 and self.lastSendAt + LOG_FLUSH_SECONDS < epochTime()):
    # make a copy, just in case some thread from somewhere adds new entries
    var newLogs = self.logs
    self.logs = @[]

    if newLogs.len == 0:
      return 0

    if newLogs.len > 1000:
      newLogs = newLogs[(newLogs.len - 1000) .. (newLogs.len - 1)]

    var client = newHttpClient(timeout = 1000)
    try:
      client.headers = newHttpHeaders([
          ("Authorization", "Bearer " & self.frameConfig.serverApiKey),
          ("Content-Type", "application/json"),
          ("Content-Encoding", "gzip")
      ])
      let body = %*{"logs": newLogs}
      let response = client.request(self.url, httpMethod = HttpPost, body = compress($body))
      self.lastSendAt = epochTime()
      if response.code != Http200:
        echo "Error sending logs: HTTP " & $response.status
    except CatchableError as e:
      echo "Error sending logs: " & $e.msg
    finally:
      client.close()

    return newLogs.len


proc run(self: LoggerThread) =
  while true:
    let processedLogs = self.processQueue()
    if processedLogs == 0:
      sleep(250)
    let (success, payload) = logChannel.tryRecv()
    if success:
      if self.frameConfig.debug:
        echo payload
      self.logs.add(payload)
      logToFile(self.frameConfig.logToFile, payload[1])
    else:
      sleep(100)

proc createThreadRunner(frameConfig: FrameConfig) {.thread.} =
  let protocol = if frameConfig.serverPort mod 1000 == 443: "https" else: "http"
  let url = protocol & "://" & frameConfig.serverHost & ":" & $frameConfig.serverPort & "/api/log"
  var loggerThread = LoggerThread(
    frameConfig: frameConfig,
    url: url,
    logs: @[],
    lastSendAt: 0.0,
  )
  while true:
    try:
      run(loggerThread)
    except Exception as e:
      echo "Error in logger thread: " & $e.msg
      logToFile(frameConfig.logToFile, %*{"error": "Error in logger thread", "message": $e.msg})
      sleep(1000)

proc newLogger*(frameConfig: FrameConfig): Logger =
  if not threadInitDone:
    createThread(thread, createThreadRunner, frameConfig)
    threadInitDone = true
  var logger = Logger(
    frameConfig: frameConfig,
    channel: logChannel,
    enabled: true,
  )
  logger.log = proc(payload: JsonNode) =
    if logger.enabled:
      logChannel.send((epochTime(), payload))
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false

  result = logger
