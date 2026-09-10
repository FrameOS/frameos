import zippy, json, os, times, strutils, net, algorithm, locks
import std/atomics

import frameos/channels
import frameos/types
import frameos/hal/files as halFiles
import frameos/hal/processes
from frameos/hal/net_client import setSocketSendRecvTimeouts

const GzipLogTimeoutMs = 10 * 60 * 1000

type
  LoggerSettings* = object
    ## Everything the logger thread needs from the frame config, as plain
    ## values. The thread never holds the FrameConfig ref: that object is
    ## rewritten in place by the runner on every reload (config.nim
    ## updateFrameConfigFrom) while four mummy workers read it, and a string
    ## field replaced under this thread would be a use-after-free (the
    ## auth-cache incident, server/auth.nim). A reload hands over a fresh
    ## copy through applyLoggerSettings instead.
    serverHost*: string
    serverPort*: int
    useTls*: bool
    serverApiKey*: string
    serverSendLogs*: bool
    logToFile*: string

  LogFileState* = object
    ## The log file currently being appended to and how big it is: tracked
    ## here so the size cap costs no stat per line.
    path*: string
    bytes*: int64

  LoggerThread = ref object
    settings: LoggerSettings
    settingsGeneration: int
    sslContext: SslContext
    logs: seq[SerializedLog]
    lastSendAt: float
    retryBackoff: float
    nextSendAllowedAt: float
    logFile: LogFileState

const LOG_FLUSH_SECONDS = 1.0
const MaxBufferedLogs = 1000
# Channel entries taken per pass of the logger loop. The channel holds 5000;
# taking one per wakeup (with a sleep between wakeups) could never catch up
# with a burst, so the channel overflowed and dropped while the drain idled.
const MaxDrainPerPass = MaxBufferedLogs
const LogSendConnectTimeoutMs = 5000
const LogSendIoTimeoutMs = 10_000
const LogSendMaxBackoffSeconds = 60.0

# A log path without `{date}` never rotates by date, so it rotates by size:
# at this many bytes the file is gzipped in place and a fresh one started,
# keeping the newest LogFileMaxArchives archives.
const LogFileMaxBytes* = 8 * 1024 * 1024
const LogFileMaxArchives* = 3

var threadInitDone = false
var thread: Thread[LoggerSettings]

# The settings the thread should be running with. Written by whichever
# thread saves the config (runner on reload, main at start), read by the
# logger thread; the generation counter lets the thread skip the lock on
# every pass where nothing changed.
var loggerSettingsLock: Lock
initLock(loggerSettingsLock)
var pendingLoggerSettings: LoggerSettings
var loggerSettingsGeneration: Atomic[int]

proc loggerSettingsFrom*(frameConfig: FrameConfig): LoggerSettings =
  if frameConfig == nil:
    return LoggerSettings()
  LoggerSettings(
    serverHost: frameConfig.serverHost,
    serverPort: frameConfig.serverPort,
    useTls: normalizeServerScheme(frameConfig.serverScheme, frameConfig.serverPort) == "https",
    serverApiKey: frameConfig.serverApiKey,
    serverSendLogs: frameConfig.serverSendLogs,
    logToFile: frameConfig.logToFile,
  )

proc applyLoggerSettings*(frameConfig: FrameConfig) {.gcsafe.} =
  ## Publish the current config to the logger thread. Called at start and
  ## after every config reload; the thread picks the copy up on its next pass.
  let settings = loggerSettingsFrom(frameConfig)
  {.gcsafe.}:
    withLock loggerSettingsLock:
      pendingLoggerSettings = settings
    atomicInc(loggerSettingsGeneration)

proc refreshSettings(self: LoggerThread) =
  let generation = loggerSettingsGeneration.load(moAcquire)
  if generation == self.settingsGeneration:
    return
  {.gcsafe.}:
    withLock loggerSettingsLock:
      self.settings = pendingLoggerSettings
  self.settingsGeneration = generation

proc gzipLogFile(path: string) =
  if path.len == 0 or path.endsWith(".gz") or not storedFileExists(path):
    return
  var target = path & ".gz"
  var suffix = 1
  while storedFileExists(target):
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
      removeStoredFile(path)
    except OSError as e:
      echo "Error removing compressed log file: " & e.msg

const LogRetentionDays* = 14

proc cleanupOldRotatedLogs*(filenameTemplate: string, today: DateTime) =
  ## Delete date-stamped log files older than LogRetentionDays so a
  ## `{date}`-templated log path cannot grow without bound (Buildroot frames
  ## log to SD-backed storage by default). Only files matching the template's
  ## prefix/suffix with an eight-digit date are considered.
  let parts = filenameTemplate.split("{date}")
  if parts.len != 2:
    return
  let namePrefix = lastPathPart(parts[0])
  let suffix = parts[1]
  let dir = parentDir(parts[0] & "00000000" & suffix)
  let cutoff = (today - initDuration(days = LogRetentionDays)).format("yyyyMMdd")
  try:
    for kind, path in walkDir(if dir.len > 0: dir else: "."):
      if kind != pcFile:
        continue
      let base = lastPathPart(path)
      if not base.startsWith(namePrefix) or base.len < namePrefix.len + 8:
        continue
      let dateStr = base[namePrefix.len ..< namePrefix.len + 8]
      var digits = true
      for c in dateStr:
        if c notin {'0' .. '9'}:
          digits = false
          break
      if not digits or not base[namePrefix.len + 8 .. ^1].startsWith(suffix):
        continue
      if dateStr < cutoff:
        removeStoredFile(path)
  except CatchableError as e:
    echo "Error cleaning up old log files: " & e.msg

proc pruneLogArchives*(path: string, keep = LogFileMaxArchives) =
  ## Keep only the newest `keep` gzip archives of a size-rotated log file
  ## (`path.gz`, `path.1.gz`, `path.2.gz`, ... as gzipLogFile names them).
  let dir = parentDir(path)
  let base = lastPathPart(path)
  var archives: seq[(float, string)] = @[]
  try:
    for kind, candidate in walkDir(if dir.len > 0: dir else: "."):
      if kind != pcFile:
        continue
      let name = lastPathPart(candidate)
      if not (name.startsWith(base & ".") and name.endsWith(".gz")):
        continue
      # What follows "<base>." is either "gz" or "<digits>.gz".
      let rest = name[base.len + 1 .. ^1]
      if rest != "gz":
        let digits = rest[0 ..< rest.len - 3]
        if digits.len == 0 or not allCharsInSet(digits, {'0' .. '9'}):
          continue
      archives.add((getLastModificationTime(candidate).toUnixFloat(), candidate))
    if archives.len <= keep:
      return
    archives.sort(proc(a, b: (float, string)): int = cmp(b[0], a[0]))
    for index in keep ..< archives.len:
      removeStoredFile(archives[index][1])
  except CatchableError as e:
    echo "Error pruning log archives: " & e.msg

proc logToFile*(filename: string, logLine: string, state: var LogFileState, timestamp: float,
                maxBytes = LogFileMaxBytes) =
  ## Append one line to the configured log file. `{date}` paths rotate by
  ## day (and expire after LogRetentionDays); a path without `{date}` rotates
  ## by size instead, so neither can grow without bound on SD-backed storage.
  try:
    if filename.len > 0:
      let loggedAt = fromUnix(timestamp.int64).local
      let dated = "{date}" in filename
      let file = if dated:
        filename.replace("{date}", loggedAt.format("yyyyMMdd"))
      else:
        filename
      if state.path.len > 0 and state.path != file:
        gzipLogFile(state.path)
      if state.path != file:
        ensureParentDir(file)
        if dated:
          cleanupOldRotatedLogs(filename, loggedAt)
        state.path = file
        state.bytes = storedFileSize(file)
      let line = loggedAt.format("[yyyy-MM-dd'T'HH:mm:ss]") & " " & logLine
      if not dated and state.bytes > 0 and state.bytes + line.len + 1 > maxBytes:
        gzipLogFile(file)
        pruneLogArchives(file)
        state.bytes = 0
      appendTextLine(file, line)
      state.bytes += line.len + 1
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
    socket.connect(self.settings.serverHost, Port(self.settings.serverPort), timeout = LogSendConnectTimeoutMs)
    socket.setSocketSendRecvTimeouts(LogSendIoTimeoutMs)
    if self.settings.useTls:
      self.getSslContext().wrapConnectedSocket(socket, handshakeAsClient, self.settings.serverHost)
    let request = "POST /api/log HTTP/1.1\r\n" &
      "Host: " & self.settings.serverHost & ":" & $self.settings.serverPort & "\r\n" &
      "Authorization: Bearer " & self.settings.serverApiKey & "\r\n" &
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

  var newLogs = move(self.logs)
  self.logs = @[]

  # Report and reset the drop counter whether or not logs leave the device:
  # with remote logging off the counter used to grow forever, and the one
  # place the drops were visible (the journal, the log file) never heard.
  let dropped = logsDroppedCounter.exchange(0)
  if dropped > 0:
    let droppedLine = $(%*{"event": "logger:dropped", "count": dropped})
    echo droppedLine
    logToFile(self.settings.logToFile, droppedLine, self.logFile, now)
    newLogs.add(SerializedLog(timestamp: now, event: "logger:dropped", line: droppedLine))

  if not self.settings.serverSendLogs:
    return newLogs.len

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


proc drainChannel(self: LoggerThread): int =
  ## Take everything queued (up to MaxDrainPerPass) in one go: print it,
  ## file it, and buffer it for the next send.
  while result < MaxDrainPerPass:
    let (success, payload) = logChannel.tryRecv()
    if not success:
      break
    inc result
    echo "(" & $payload.timestamp & ", " & payload.line & ")" # print to stdout / journal
    self.logs.add(payload)
    logToFile(self.settings.logToFile, payload.line, self.logFile, payload.timestamp)

proc run(self: LoggerThread) =
  var idleSleepMs = 2
  while true:
    self.refreshSettings()
    let received = self.drainChannel()
    let processedLogs = self.processQueue()
    if received == 0 and processedLogs == 0:
      sleep(idleSleepMs)
      if idleSleepMs < 250:
        idleSleepMs += 2
    else:
      idleSleepMs = 2

proc createThreadRunner(settings: LoggerSettings) {.thread.} =
  var loggerThread = LoggerThread(
    settings: settings,
    logs: @[],
    lastSendAt: 0.0,
  )
  var errorLogFile = LogFileState()
  while true:
    try:
      run(loggerThread)
    except Exception as e:
      echo "Error in logger thread: " & $e.msg
      logToFile(loggerThread.settings.logToFile, $(%*{"error": "Error in logger thread", "message": $e.msg}),
                errorLogFile, epochTime())
      sleep(1000)

proc newLogger*(frameConfig: FrameConfig): Logger =
  applyLoggerSettings(frameConfig)
  if not threadInitDone:
    createThread(thread, createThreadRunner, loggerSettingsFrom(frameConfig))
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
