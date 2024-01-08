import httpclient, zippy, json, sequtils, os, times, math

from frameos/types import FrameConfig, Logger

type
  LoggerThread = ref object
    frameConfig: FrameConfig
    client: HttpClient
    url: string
    logs: seq[JsonNode]
    erroredLogs: seq[JsonNode]
    lastSendAt: float

const LOG_FLUSH_SECONDS = 1.0

var
  thread: Thread[FrameConfig]
  logChannel*: Channel[JsonNode]

logChannel.open()

proc sendCollectedLogs*(self: LoggerThread): bool =
  var newLogs = self.erroredLogs.concat(self.logs)
  self.logs = @[]
  self.erroredLogs = @[]
  if newLogs.len == 0:
    return true
  if newLogs.len > 100:
    newLogs = newLogs[(newLogs.len - 100) .. (newLogs.len - 1)]
  try:
    let body = %*{"logs": newLogs}
    let response = self.client.request(self.url, httpMethod = HttpPost,
        body = compress($body))
    self.lastSendAt = epochTime()
    if response.code != Http200:
      echo "Error sending logs: HTTP " & $response.status
      if self.erroredLogs.len > 0 and self.erroredLogs[0]{"event"}.getStr() == "logger:error":
        self.erroredLogs = self.erroredLogs.concat(newLogs)
      else:
        let errorLog = %*{"event": "logger:error",
            "error": "Error sending logs, will retry: HTTP " &
            $response.status}
        self.erroredLogs = @[errorLog].concat(self.erroredLogs.concat(newLogs))
      return false
  except CatchableError as e:
    echo "Error sending logs: " & $e.msg
    if self.erroredLogs.len > 0 and self.erroredLogs[0]{"event"}.getStr() == "logger:error":
      self.erroredLogs = self.erroredLogs.concat(newLogs)
    else:
      let errorLog = %*{"event": "logger:error",
            "error": "Error sending logs, will retry: " & $e.msg}
      self.erroredLogs = @[errorLog].concat(self.erroredLogs.concat(newLogs))
    return false
  return true

proc start(self: LoggerThread) =
  var attempt = 0
  while true:
    let logCount = (self.logs.len + self.erroredLogs.len)
    if logCount > 10 or (logCount > 0 and self.lastSendAt + LOG_FLUSH_SECONDS <
        epochTime()):
      if self.sendCollectedLogs():
        attempt = 0
      else:
        attempt += 1
        let sleepDuration = min(100 * (2 ^ attempt), 7500)
        sleep(sleepDuration)

    let (success, payload) = logChannel.tryRecv()
    if success:
      if self.frameConfig.verbose:
        echo payload
      self.logs.add(payload)
    else:
      sleep(100)

proc createThreadRunner(frameConfig: FrameConfig) {.thread.} =
  var client = newHttpClient(timeout = 10000)
  client.headers = newHttpHeaders([
      ("Authorization", "Bearer " & frameConfig.serverApiKey),
      ("Content-Type", "application/json"),
      ("Content-Encoding", "gzip")
  ])
  let protocol = if frameConfig.serverPort mod 1000 ==
      443: "https" else: "http"
  let url = protocol & "://" & frameConfig.serverHost & ":" &
    $frameConfig.serverPort & "/api/log"

  var loggerThread = LoggerThread(
    frameConfig: frameConfig,
    client: client,
    url: url,
    logs: @[],
    erroredLogs: @[],
    lastSendAt: 0.0,
  )
  loggerThread.start()

proc newLogger*(frameConfig: FrameConfig): Logger =
  createThread(thread, createThreadRunner, frameConfig)
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
