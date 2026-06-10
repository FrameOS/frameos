import zippy, json, os, times, strutils, net, posix
import std/atomics

import frameos/channels
import frameos/types
import frameos/utils/process

const GzipLogTimeoutMs = 10 * 60 * 1000

type
  LoggerThread = ref object
    frameConfig: FrameConfig
    host: string
    port: int
    useTls: bool
    sslContext: SslContext
    logs: seq[SerializedLog]
    lastSendAt: float
    retryBackoff: float
    nextSendAllowedAt: float
    lastLogFilePath: string

const LOG_FLUSH_SECONDS = 1.0
const MaxBufferedLogs = 1000
const LogSendConnectTimeoutMs = 5000
const LogSendIoTimeoutMs = 10_000
const LogSendMaxBackoffSeconds = 60.0

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
  let command = if target == path & ".gz":
    "gzip -f " & quoteShell(path)
  else:
    "gzip -c " & quoteShell(path) & " > " & quoteShell(target)
  let gzipResult = runShellWithParentStreams(command, timeoutMs = GzipLogTimeoutMs)
  if gzipResult.exitCode != 0:
    echo "Error gzipping log file: gzip exited with " & $gzipResult.exitCode & " for " & path
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

proc setSendRecvTimeouts(socket: Socket, ms: int) =
  ## Bounds everything HttpClient's `timeout` does not: the TLS handshake and
  ## blocking sends, which otherwise ride TCP retransmission for many minutes
  ## when the network goes flaky mid-connection.
  var tv = Timeval(tv_sec: posix.Time(ms div 1000), tv_usec: Suseconds((ms mod 1000) * 1000))
  discard setsockopt(socket.getFd(), SOL_SOCKET, SO_RCVTIMEO, addr tv, SockLen(sizeof(tv)))
  discard setsockopt(socket.getFd(), SOL_SOCKET, SO_SNDTIMEO, addr tv, SockLen(sizeof(tv)))

proc getSslContext(self: LoggerThread): SslContext =
  if self.sslContext == nil:
    self.sslContext = newContext()
  self.sslContext

proc postLogs(self: LoggerThread, body: string): int =
  ## Minimal HTTP POST with hard time bounds on connect, TLS handshake, send
  ## and the status read. Nim's HttpClient only applies its timeout to
  ## response reads; its connect/TLS/send phases block without limit, which
  ## let a flaky network park this thread while the log channel filled up.
  ## (DNS resolution inside connect() remains bounded only by the resolver.)
  var socket = newSocket()
  try:
    socket.connect(self.host, Port(self.port), timeout = LogSendConnectTimeoutMs)
    socket.setSendRecvTimeouts(LogSendIoTimeoutMs)
    if self.useTls:
      self.getSslContext().wrapConnectedSocket(socket, handshakeAsClient, self.host)
    let request = "POST /api/log HTTP/1.1\r\n" &
      "Host: " & self.host & ":" & $self.port & "\r\n" &
      "Authorization: Bearer " & self.frameConfig.serverApiKey & "\r\n" &
      "Content-Type: application/json\r\n" &
      "Content-Encoding: gzip\r\n" &
      "Content-Length: " & $body.len & "\r\n" &
      "Connection: close\r\n\r\n"
    socket.send(request & body)
    let statusLine = socket.recvLine(timeout = LogSendIoTimeoutMs)
    let parts = statusLine.splitWhitespace()
    if parts.len >= 2:
      result = parseInt(parts[1])
  finally:
    socket.close()

proc registerSendFailure(self: LoggerThread) =
  self.retryBackoff = clamp(self.retryBackoff * 2, 2.0, LogSendMaxBackoffSeconds)
  self.nextSendAllowedAt = epochTime() + self.retryBackoff

proc processQueue(self: LoggerThread): int =
  # Keep the local buffer bounded even while sends are gated by backoff.
  if self.logs.len > MaxBufferedLogs:
    atomicInc(logsDroppedCounter, self.logs.len - MaxBufferedLogs)
    self.logs = self.logs[(self.logs.len - MaxBufferedLogs) .. ^1]

  let now = epochTime()
  let logCount = self.logs.len
  if logCount == 0 or now < self.nextSendAllowedAt:
    return 0
  if logCount < MaxBufferedLogs and self.lastSendAt + LOG_FLUSH_SECONDS >= now:
    return 0

  # make a copy, just in case some thread from somewhere adds new entries
  var newLogs = self.logs
  self.logs = @[]

  if not self.frameConfig.serverSendLogs:
    return newLogs.len

  let dropped = logsDroppedCounter.exchange(0)
  if dropped > 0:
    let droppedLine = $(%*{"event": "logger:dropped", "count": dropped})
    echo droppedLine
    newLogs.add(SerializedLog(timestamp: now, event: "logger:dropped", line: droppedLine))

  self.lastSendAt = now
  try:
    let response = self.postLogs(compress(logsRequestBody(newLogs)))
    if response == 200:
      self.retryBackoff = 0.0
      self.nextSendAllowedAt = 0.0
    else:
      echo "Error sending logs: HTTP " & $response
      self.registerSendFailure()
  except CatchableError as e:
    echo "Error sending logs: " & $e.msg
    self.registerSendFailure()

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
  var loggerThread = LoggerThread(
    frameConfig: frameConfig,
    host: frameConfig.serverHost,
    port: frameConfig.serverPort,
    useTls: frameConfig.serverPort mod 1000 == 443,
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
