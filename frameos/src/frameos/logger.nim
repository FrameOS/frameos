import zippy, json, sequtils, os, times, math, strutils, net
import lib/httpclient

import frameos/channels
import frameos/types

type
  LoggerThread = ref object
    frameConfig: FrameConfig
    client: HttpClient
    url: string
    logs: seq[JsonNode]
    erroredLogs: seq[JsonNode]
    lastSendAt: float

const LOG_FLUSH_SECONDS = 1.0

var threadInitDone = false
var thread: Thread[FrameConfig]
var logFile: File

proc logToFile(filename: string, logJson: JsonNode) =
  if filename.len > 0:
    try:
      let file = if "{date}" in filename:
        filename.replace("{date}", now().format("yyyyMMdd"))
      else:
        filename
      logFile = open(file, fmAppend)
      logFile.write(now().format("[yyyy-MM-dd'T'HH:mm:ss]") & " " & $logJson & "\n")
      logFile.close()
    except Exception as e:
      echo "Error writing to log file: " & $e.msg

proc processQueue(self: LoggerThread): int =
  let logCount = (self.logs.len + self.erroredLogs.len)
  if logCount > 1000 or (logCount > 0 and self.lastSendAt + LOG_FLUSH_SECONDS < epochTime()):
    # make a copy, just in case some thread from somewhere adds new entries
    var newLogs = self.erroredLogs.concat(self.logs)
    self.logs = @[]
    self.erroredLogs = @[]

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
      if response.code == Http200:
        if self.erroredLogs.len > 0:
          self.erroredLogs = @[]
      else:
        echo "Error sending logs: HTTP " & $response.status
        logToFile(self.frameConfig.logToFile, %*{"error": "Error sending logs", "status": response.status})
        self.erroredLogs = newLogs
    except CatchableError as e:
      echo "Error sending logs: " & $e.msg
      logToFile(self.frameConfig.logToFile, %*{"error": "Error sending logs", "message": e.msg})
      self.erroredLogs = newLogs
    finally:
      client.close()

    if self.erroredLogs.len > 0:
      return -self.erroredLogs.len
    else:
      return newLogs.len


proc run(self: LoggerThread) =
  var attempt = 0
  while true:
    let processedLogs = self.processQueue()
    if processedLogs == 0:
      sleep(100)
    elif processedLogs < 0:
      attempt += 1
      let sleepDuration = min(100 * (2 ^ attempt), 7500)
      echo "Sleeping for " & $sleepDuration & "ms, attempt " & $attempt & ". Logs queued: " & $self.erroredLogs.len
      logToFile(self.frameConfig.logToFile, %*{"sleep": "Error sending logs", "duration": sleepDuration,
          "attempt": attempt, "queued": self.erroredLogs.len})
      sleep(sleepDuration)
    else:
      attempt = 0

    let (success, payload) = logChannel.tryRecv()
    if success:
      if self.frameConfig.debug:
        echo payload
      self.logs.add(payload)
      logToFile(self.frameConfig.logToFile, payload)
    else:
      sleep(100)

proc createThreadRunner(frameConfig: FrameConfig) {.thread.} =
  let protocol = if frameConfig.serverPort mod 1000 == 443: "https" else: "http"
  let url = protocol & "://" & frameConfig.serverHost & ":" & $frameConfig.serverPort & "/api/log"
  var loggerThread = LoggerThread(
    frameConfig: frameConfig,
    url: url,
    logs: @[],
    erroredLogs: @[],
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
      logChannel.send(payload)
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false

  result = logger
