import zippy, json, os, osproc, times, strutils, net, httpclient

import frameos/channels
import frameos/types

type
  LoggerThread = ref object
    frameConfig: FrameConfig
    client: HttpClient
    url: string
    logs: seq[SerializedLog]
    lastSendAt: float
    lastLogFilePath: string

const LOG_FLUSH_SECONDS = 1.0

var threadInitDone = false
var thread: Thread[FrameConfig]
var logFile: File

proc gzipLogFile(path: string) =
  if path.len == 0 or path.endsWith(".gz") or not fileExists(path):
    return
  var target = path & ".gz"
  var suffix = 1
  while fileExists(target):
    target = path & "." & $suffix & ".gz"
    suffix += 1
  let status = if target == path & ".gz":
    execShellCmd("gzip -f " & quoteShell(path))
  else:
    execShellCmd("gzip -c " & quoteShell(path) & " > " & quoteShell(target))
  if status != 0:
    echo "Error gzipping log file: gzip exited with " & $status & " for " & path
  elif target != path & ".gz":
    try:
      removeFile(path)
    except OSError as e:
      echo "Error removing compressed log file: " & e.msg

proc logToFile(filename: string, logLine: string, lastLogFilePath: var string, timestamp: float) =
  try:
    if filename.len > 0:
      let loggedAt = fromUnix(timestamp.int64).local
      let file = if "{date}" in filename:
        filename.replace("{date}", loggedAt.format("yyyyMMdd"))
      else:
        filename
      if lastLogFilePath.len > 0 and lastLogFilePath != file:
        gzipLogFile(lastLogFilePath)
      lastLogFilePath = file
      logFile = open(file, fmAppend)
      logFile.write(loggedAt.format("[yyyy-MM-dd'T'HH:mm:ss]") & " " & logLine & "\n")
      logFile.close()
  except Exception as e:
    echo "Error writing to log file: " & $e.msg

proc addLogPayload(body: var string, payload: SerializedLog) =
  body.add("[")
  body.add($payload.timestamp)
  body.add(",")
  body.add(payload.line)
  body.add("]")

proc logsRequestBody*(logs: seq[SerializedLog]): string =
  result = "{\"logs\":["
  for index, logPayload in logs:
    if index > 0:
      result.add(",")
    result.addLogPayload(logPayload)
  result.add("]}")

proc processQueue(self: LoggerThread): int =
  let logCount = self.logs.len
  if logCount > 1000 or (logCount > 0 and self.lastSendAt + LOG_FLUSH_SECONDS < epochTime()):
    # make a copy, just in case some thread from somewhere adds new entries
    var newLogs = self.logs
    self.logs = @[]

    if newLogs.len == 0:
      return 0

    if not self.frameConfig.serverSendLogs:
      return newLogs.len

    if newLogs.len > 1000:
      newLogs = newLogs[(newLogs.len - 1000) .. (newLogs.len - 1)]

    var client = newHttpClient(timeout = 1000)
    try:
      client.headers = newHttpHeaders([
          ("Authorization", "Bearer " & self.frameConfig.serverApiKey),
          ("Content-Type", "application/json"),
          ("Content-Encoding", "gzip")
      ])
      let body = logsRequestBody(newLogs)
      let response = client.request(self.url, httpMethod = HttpPost, body = compress(body))
      self.lastSendAt = epochTime()
      if response.code != Http200:
        echo "Error sending logs: HTTP " & $response.status
    except CatchableError as e:
      echo "Error sending logs: " & $e.msg
    finally:
      client.close()

    return newLogs.len


proc run(self: LoggerThread) =
  var run = 2
  while true:
    let processedLogs = self.processQueue()
    if processedLogs == 0:
      sleep(run)
      if run < 250:
        run += 2
    let (success, payload) = logChannel.tryRecv()
    if success:
      echo "(" & $payload.timestamp & ", " & payload.line & ")" # print to stdout / journal
      self.logs.add(payload)
      logToFile(self.frameConfig.logToFile, payload.line, self.lastLogFilePath, payload.timestamp)
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
    lastSendAt: 0.0,
    lastLogFilePath: "",
  )
  var errorLogFilePath = ""
  while true:
    try:
      run(loggerThread)
    except Exception as e:
      echo "Error in logger thread: " & $e.msg
      logToFile(frameConfig.logToFile, $(%*{"error": "Error in logger thread", "message": $e.msg}), errorLogFilePath, epochTime())
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
