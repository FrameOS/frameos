import std/[locks, monotimes, os, osproc, posix, streams, strutils, times]

const
  DefaultProcessTerminateTimeoutMs* = 1500
  DefaultProcessKillTimeoutMs* = 500
  DefaultProcessPollMs = 100
  ProcessExitPollMs = 20
  ProcessPipeChunkSize = 8192

type
  ExternalProcessResult* = object
    exitCode*: int
    timedOut*: bool

  PipedProcessResult* = object
    output*: string
    errorOutput*: string
    exitCode*: int
    timedOut*: bool
    outputExceeded*: bool

  ProcessOutputReader* = object
    handle: FileHandle
    buffer: string
    eof*: bool

# Writing to a pipe whose reader died must surface as EPIPE, not kill the
# whole process with SIGPIPE.
posix.signal(SIGPIPE, SIG_IGN)

# osproc creates its pipes without O_CLOEXEC and (on Linux) spawns with a
# plain fork(). Two concurrent spawns from different threads therefore leak
# each other's pipe ends into the children: the children keep them open for
# their whole lifetime, EOFs never arrive, and startProcess itself can block
# forever reading its internal error pipe. Serializing all spawns behind one
# lock closes that window. Nothing else may call startProcess/execCmd*
# directly.
var spawnLock: Lock
initLock(spawnLock)

proc startProcessSerialized*(command: string;
                             args: seq[string] = @[];
                             workingDir = "";
                             options: set[ProcessOption] = {poUsePath}): Process =
  withLock spawnLock:
    result = startProcess(command, workingDir = workingDir, args = args, options = options)

proc pollExit(p: Process; timeoutMs: int): int =
  ## Waits up to timeoutMs for the process to exit, polling with waitpid(WNOHANG).
  ## Returns -1 if it is still running. Unlike waitForExit(timeout), this never
  ## sends signals and never blocks past the deadline, even for a child stuck
  ## in uninterruptible sleep.
  result = p.peekExitCode()
  if result != -1 or timeoutMs <= 0:
    return
  let deadline = getMonoTime() + initDuration(milliseconds = timeoutMs)
  while true:
    result = p.peekExitCode()
    if result != -1:
      return
    if getMonoTime() >= deadline:
      return -1
    sleep(ProcessExitPollMs)

proc stopProcess*(p: Process;
                  terminateTimeoutMs = DefaultProcessTerminateTimeoutMs;
                  killTimeoutMs = DefaultProcessKillTimeoutMs) =
  if p == nil:
    return
  try:
    if not p.running():
      return
    p.terminate()
    if p.pollExit(terminateTimeoutMs) == -1 and p.running():
      p.kill()
      discard p.pollExit(killTimeoutMs)
  except CatchableError:
    discard

proc waitBounded(p: Process; timeoutMs: int): ExternalProcessResult =
  if timeoutMs < 0:
    return ExternalProcessResult(exitCode: p.waitForExit(), timedOut: false)
  let exitCode = p.pollExit(timeoutMs)
  if exitCode == -1 and p.running():
    p.stopProcess()
    return ExternalProcessResult(exitCode: -1, timedOut: true)
  ExternalProcessResult(exitCode: exitCode, timedOut: false)

proc runProcessWithParentStreams*(command: string;
                                  args: seq[string] = @[];
                                  timeoutMs = -1): ExternalProcessResult =
  ## Use this for child processes whose output is not consumed by FrameOS.
  ## It avoids deadlocks from full stdout/stderr pipes.
  var p = startProcessSerialized(command, args = args, options = {poUsePath, poParentStreams})
  try:
    result = p.waitBounded(timeoutMs)
  finally:
    p.close()

proc runShellWithParentStreams*(command: string; timeoutMs = -1): ExternalProcessResult =
  ## Bounded replacement for osproc.execCmd/execShellCmd: runs `command`
  ## through /bin/sh -c with the parent's stdout/stderr, kills it after
  ## timeoutMs and gives up waiting if it cannot be killed.
  var p = startProcessSerialized("/bin/sh", args = @["-c", command], options = {poParentStreams})
  try:
    result = p.waitBounded(timeoutMs)
  finally:
    p.close()

proc setNonBlocking(handle: FileHandle) =
  let fd = cint(handle)
  let flags = fcntl(fd, F_GETFL, 0)
  if flags != -1:
    discard fcntl(fd, F_SETFL, flags or O_NONBLOCK)

proc closeInput(p: Process, inputClosed: var bool) =
  if inputClosed:
    return
  try:
    p.inputStream().close()
  except CatchableError:
    discard
  inputClosed = true

proc readPipe(handle: FileHandle;
              output: var string;
              eof: var bool;
              maxBytes: int;
              hardLimit: bool): bool =
  var buffer: array[ProcessPipeChunkSize, char]
  while true:
    let bytesRead = posix.read(cint(handle), addr buffer[0], buffer.len)
    if bytesRead > 0:
      let count = bytesRead.int
      if maxBytes <= 0 or output.len + count <= maxBytes:
        let oldLen = output.len
        output.setLen(oldLen + count)
        copyMem(addr output[oldLen], addr buffer[0], count)
      elif hardLimit:
        return false
      else:
        let copyLen = max(0, maxBytes - output.len)
        if copyLen > 0:
          let oldLen = output.len
          output.setLen(oldLen + copyLen)
          copyMem(addr output[oldLen], addr buffer[0], copyLen)
    elif bytesRead == 0:
      eof = true
      return true
    else:
      let err = osLastError().int32
      if err == EAGAIN or err == EWOULDBLOCK or err == EINTR:
        return true
      return false

proc writePipeBytes(handle: FileHandle; input: openArray[uint8]; offset: var int): bool =
  while offset < input.len:
    let count = min(ProcessPipeChunkSize, input.len - offset)
    let bytesWritten = posix.write(cint(handle), unsafeAddr input[offset], count)
    if bytesWritten > 0:
      offset += bytesWritten.int
    else:
      let err = osLastError().int32
      if err == EAGAIN or err == EWOULDBLOCK or err == EINTR:
        return true
      return false
  true

proc writePipe(handle: FileHandle; input: string; offset: var int): bool =
  if input.len == 0:
    return true
  writePipeBytes(handle, input.toOpenArrayByte(0, input.high), offset)

proc waitForPipedExit(p: Process): int =
  result = p.pollExit(DefaultProcessPollMs)
  if result == -1 and p.running():
    p.stopProcess()
    result = -1

proc runProcessPiped*(command: string;
                      args: seq[string] = @[];
                      input = "";
                      timeoutMs = -1;
                      maxOutputBytes = 0;
                      maxErrorBytes = 4096): PipedProcessResult =
  ## Runs a child process without blocking on stdin/stdout/stderr pipe ordering.
  ## stdout is captured and bounded; stderr is drained and lightly captured.
  var p = startProcessSerialized(command, args = args, options = {poUsePath})
  var inputClosed = false
  try:
    p.inputHandle().setNonBlocking()
    p.outputHandle().setNonBlocking()
    p.errorHandle().setNonBlocking()

    var inputOffset = 0
    var stdoutEof = false
    var stderrEof = false
    let startedAt = epochTime()

    if input.len == 0:
      p.closeInput(inputClosed)

    while true:
      if timeoutMs >= 0 and epochTime() > startedAt + (timeoutMs.float / 1000.0):
        p.stopProcess()
        result.timedOut = true
        result.exitCode = -1
        return

      if stdoutEof and stderrEof and inputClosed:
        break

      var readfds: TFdSet = default(TFdSet)
      var writefds: TFdSet = default(TFdSet)
      FD_ZERO(readfds)
      FD_ZERO(writefds)

      var maxFd = 0
      if not stdoutEof:
        let fd = cint(p.outputHandle())
        FD_SET(fd, readfds)
        maxFd = max(maxFd, fd.int)
      if not stderrEof:
        let fd = cint(p.errorHandle())
        FD_SET(fd, readfds)
        maxFd = max(maxFd, fd.int)
      if not inputClosed:
        let fd = cint(p.inputHandle())
        FD_SET(fd, writefds)
        maxFd = max(maxFd, fd.int)

      var tv = Timeval(tv_sec: posix.Time(0), tv_usec: Suseconds(DefaultProcessPollMs * 1000))
      let ready = posix.select(cint(maxFd + 1), addr readfds, addr writefds, nil, addr tv)
      if ready < 0:
        let err = osLastError().int32
        if err == EINTR:
          continue
        p.stopProcess()
        result.exitCode = -1
        return

      if not inputClosed and FD_ISSET(cint(p.inputHandle()), writefds) != 0:
        if not writePipe(p.inputHandle(), input, inputOffset):
          p.closeInput(inputClosed)
        elif inputOffset >= input.len:
          p.closeInput(inputClosed)

      if not stdoutEof and FD_ISSET(cint(p.outputHandle()), readfds) != 0:
        if not readPipe(p.outputHandle(), result.output, stdoutEof, maxOutputBytes, true):
          p.stopProcess()
          result.outputExceeded = true
          result.exitCode = -1
          return

      if not stderrEof and FD_ISSET(cint(p.errorHandle()), readfds) != 0:
        if not readPipe(p.errorHandle(), result.errorOutput, stderrEof, maxErrorBytes, false):
          stderrEof = true

      if p.peekExitCode() != -1:
        if not readPipe(p.outputHandle(), result.output, stdoutEof, maxOutputBytes, true):
          result.outputExceeded = true
          result.exitCode = -1
          return
        discard readPipe(p.errorHandle(), result.errorOutput, stderrEof, maxErrorBytes, false)

    result.exitCode = p.waitForPipedExit()
  finally:
    if p != nil:
      p.closeInput(inputClosed)
      p.close()

proc runShellCapture*(command: string;
                      input = "";
                      timeoutMs = -1;
                      maxOutputBytes = 4 * 1024 * 1024): tuple[output: string, exitCode: int] =
  ## Bounded replacement for osproc.execCmdEx: runs `command` through
  ## /bin/sh -c and captures stdout with stderr appended after it.
  let res = runProcessPiped("/bin/sh", @["-c", command], input = input,
                            timeoutMs = timeoutMs, maxOutputBytes = maxOutputBytes,
                            maxErrorBytes = 65536)
  var output = res.output
  output.add(res.errorOutput)
  (output, res.exitCode)

proc initProcessOutputReader*(p: Process): ProcessOutputReader =
  ## Non-blocking line reader over a process's stdout. Combine with
  ## poStdErrToStdOut to also cover stderr; otherwise stderr must be drained
  ## separately.
  p.outputHandle().setNonBlocking()
  ProcessOutputReader(handle: p.outputHandle())

proc fill(reader: var ProcessOutputReader) =
  if reader.eof:
    return
  var eof = false
  if not readPipe(reader.handle, reader.buffer, eof, 0, false):
    eof = true
  if eof:
    reader.eof = true

proc readAvailableLines*(reader: var ProcessOutputReader): seq[string] =
  ## Returns the complete lines available right now without blocking.
  ## After EOF the unterminated tail (if any) is returned as a final line.
  reader.fill()
  var start = 0
  while true:
    let idx = reader.buffer.find('\n', start)
    if idx == -1:
      break
    var line = reader.buffer[start ..< idx]
    if line.len > 0 and line[^1] == '\r':
      line.setLen(line.len - 1)
    result.add(line)
    start = idx + 1
  if start > 0:
    reader.buffer = reader.buffer[start .. ^1]
  if reader.eof and reader.buffer.len > 0:
    result.add(reader.buffer)
    reader.buffer = ""

proc writeInputDrainingOutput*(p: Process;
                               input: openArray[uint8];
                               reader: var ProcessOutputReader;
                               timeoutMs = -1): tuple[timedOut: bool, inputWritten: bool] =
  ## Streams `input` into p's stdin while draining p's stdout into `reader`,
  ## so neither side can block forever on a full pipe. Closes stdin when the
  ## input has been written or the child stops accepting it. Intended for
  ## processes started with poStdErrToStdOut and a ProcessOutputReader.
  var inputClosed = false
  p.inputHandle().setNonBlocking()
  var inputOffset = 0
  let startedAt = epochTime()
  try:
    while inputOffset < input.len:
      if timeoutMs >= 0 and epochTime() > startedAt + (timeoutMs.float / 1000.0):
        result.timedOut = true
        return

      reader.fill()

      if p.peekExitCode() != -1:
        reader.fill()
        return

      var readfds: TFdSet = default(TFdSet)
      var writefds: TFdSet = default(TFdSet)
      FD_ZERO(readfds)
      FD_ZERO(writefds)
      var maxFd = 0
      if not reader.eof:
        let fd = cint(reader.handle)
        FD_SET(fd, readfds)
        maxFd = max(maxFd, fd.int)
      let inFd = cint(p.inputHandle())
      FD_SET(inFd, writefds)
      maxFd = max(maxFd, inFd.int)

      var tv = Timeval(tv_sec: posix.Time(0), tv_usec: Suseconds(DefaultProcessPollMs * 1000))
      let ready = posix.select(cint(maxFd + 1), addr readfds, addr writefds, nil, addr tv)
      if ready < 0:
        let err = osLastError().int32
        if err == EINTR:
          continue
        return

      if FD_ISSET(inFd, writefds) != 0:
        if not writePipeBytes(p.inputHandle(), input, inputOffset):
          return
    result.inputWritten = true
  finally:
    p.closeInput(inputClosed)
