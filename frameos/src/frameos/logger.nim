import zippy, json, os, times, strutils, net, httpclient

import frameos/channels
import frameos/types

type
  LoggerThread = ref object
    frameConfig: FrameConfig
    url: string
    logs: seq[(float, JsonNode)]
    nextSendAt: float
    consecutiveSendFailures: int
    lastSendError: string
    lastSendErrorAt: float

const LOG_FLUSH_SECONDS = 1.0
const MAX_LOG_BATCH_SIZE = 1000
const MAX_PENDING_LOGS = 5000
const MAX_LOG_RETRY_SECONDS = 30.0
const SEND_ERROR_LOG_INTERVAL_SECONDS = 30.0

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

proc nextRetryDelaySeconds*(consecutiveFailures: int, baseDelay = LOG_FLUSH_SECONDS,
                            maxDelay = MAX_LOG_RETRY_SECONDS): float =
  result = baseDelay
  if consecutiveFailures <= 1:
    return result
  for _ in 2 .. consecutiveFailures:
    result *= 2
    if result >= maxDelay:
      return maxDelay

proc trimPendingEntries*[T](items: var seq[T], maxItems: int): int =
  if maxItems <= 0 or items.len <= maxItems:
    return 0

  result = items.len - maxItems
  items = items[result .. ^1]

proc shouldReportSendError*(lastError, newError: string, lastErrorAt, nowAt: float,
                            quietPeriod = SEND_ERROR_LOG_INTERVAL_SECONDS): bool =
  lastError.len == 0 or newError != lastError or lastErrorAt + quietPeriod <= nowAt

proc handleSendFailure(self: LoggerThread, message: string) =
  self.consecutiveSendFailures += 1
  let nowAt = epochTime()
  let retryDelay = nextRetryDelaySeconds(self.consecutiveSendFailures)
  if shouldReportSendError(self.lastSendError, message, self.lastSendErrorAt, nowAt):
    echo "Error sending logs: " & message & "; retrying in " &
      formatFloat(retryDelay, ffDecimal, 1) & "s"
    self.lastSendError = message
    self.lastSendErrorAt = nowAt
  self.nextSendAt = nowAt + retryDelay

proc scheduleFlush(self: LoggerThread, nowAt: float) =
  if self.logs.len == 0:
    self.nextSendAt = 0
  elif self.logs.len >= MAX_LOG_BATCH_SIZE:
    self.nextSendAt = nowAt
  elif self.nextSendAt <= 0 or self.nextSendAt < nowAt:
    self.nextSendAt = nowAt + LOG_FLUSH_SECONDS

proc queueLog(self: LoggerThread, payload: (float, JsonNode)) =
  let nowAt = epochTime()
  self.logs.add(payload)
  discard trimPendingEntries(self.logs, MAX_PENDING_LOGS)
  self.scheduleFlush(nowAt)

proc clearSentLogs(self: LoggerThread, sentCount: int) =
  if sentCount <= 0:
    return
  if sentCount >= self.logs.len:
    self.logs = @[]
  else:
    self.logs = self.logs[sentCount .. ^1]

proc processQueue(self: LoggerThread): int =
  if self.logs.len == 0:
    self.nextSendAt = 0
    return 0

  if not self.frameConfig.serverSendLogs:
    result = self.logs.len
    self.logs = @[]
    self.nextSendAt = 0
    self.consecutiveSendFailures = 0
    self.lastSendError = ""
    self.lastSendErrorAt = 0
    return result

  let nowAt = epochTime()
  if self.nextSendAt > nowAt:
    return 0

  let sendCount = min(self.logs.len, MAX_LOG_BATCH_SIZE)
  let batch = self.logs[0 ..< sendCount]

  var client = newHttpClient(timeout = 1000)
  try:
    client.headers = newHttpHeaders([
        ("Authorization", "Bearer " & self.frameConfig.serverApiKey),
        ("Content-Type", "application/json"),
        ("Content-Encoding", "gzip")
    ])
    let body = %*{"logs": batch}
    let response = client.request(self.url, httpMethod = HttpPost, body = compress($body))
    if response.code != Http200:
      self.handleSendFailure("HTTP " & $response.status)
      return 0

    self.clearSentLogs(sendCount)
    self.consecutiveSendFailures = 0
    self.lastSendError = ""
    self.lastSendErrorAt = 0
    self.scheduleFlush(epochTime())
    return sendCount
  except CatchableError as e:
    self.handleSendFailure(e.msg)
    return 0
  finally:
    client.close()


proc run(self: LoggerThread) =
  var run = 2
  while true:
    var receivedLog = false
    while true:
      let (success, payload) = logChannel.tryRecv()
      if not success:
        break
      self.queueLog(payload)
      logToFile(self.frameConfig.logToFile, payload[1])
      receivedLog = true

    let processedLogs = self.processQueue()
    if receivedLog or processedLogs > 0:
      run = 2
    else:
      sleep(run)
      if run < 250:
        run += 2

proc createThreadRunner(frameConfig: FrameConfig) {.thread.} =
  let protocol = if frameConfig.serverPort mod 1000 == 443: "https" else: "http"
  let url = protocol & "://" & frameConfig.serverHost & ":" & $frameConfig.serverPort & "/api/log"
  var loggerThread = LoggerThread(
    frameConfig: frameConfig,
    url: url,
    logs: @[],
    nextSendAt: 0.0,
    consecutiveSendFailures: 0,
    lastSendError: "",
    lastSendErrorAt: 0.0,
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
      log(payload)
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false

  result = logger
