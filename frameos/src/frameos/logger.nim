import httpclient, zippy, json, sequtils, os, times, math

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

var thread: Thread[FrameConfig]

proc run(self: LoggerThread) =
  var attempt = 0
  while true:
    let logCount = (self.logs.len + self.erroredLogs.len)
    if logCount > 10 or (logCount > 0 and self.lastSendAt + LOG_FLUSH_SECONDS < epochTime()):
      # make a copy, just in case some thread from somewhere adds new entries
      var newLogs = self.erroredLogs.concat(self.logs)
      self.logs = @[]
      self.erroredLogs = @[]

      if newLogs.len == 0:
        # how did we even get here?
        sleep(100)
        continue

      if newLogs.len > 100:
        newLogs = newLogs[(newLogs.len - 100) .. (newLogs.len - 1)]

      var client = newHttpClient(timeout = 10000)
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
          self.erroredLogs = newLogs
      except CatchableError as e:
        echo "Error sending logs: " & $e.msg
        self.erroredLogs = newLogs
      finally:
        client.close()

      if self.erroredLogs.len > 0:
        attempt += 1
        let sleepDuration = min(100 * (2 ^ attempt), 7500)
        echo "Sleeping for " & $sleepDuration & "ms, attempt " & $attempt & ". Logs queued: " & $self.erroredLogs.len
        sleep(sleepDuration)
      else:
        attempt = 0

    let (success, payload) = logChannel.tryRecv()
    if success:
      if self.frameConfig.verbose:
        echo payload
      self.logs.add(payload)
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
      sleep(1000)

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
