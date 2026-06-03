import std/[os, osproc, posix, streams, times]

const
  DefaultProcessTerminateTimeoutMs* = 1500
  DefaultProcessKillTimeoutMs* = 500
  DefaultProcessPollMs = 100
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

proc stopProcess*(p: Process;
                  terminateTimeoutMs = DefaultProcessTerminateTimeoutMs;
                  killTimeoutMs = DefaultProcessKillTimeoutMs) =
  if p == nil:
    return
  try:
    if not p.running():
      return
    p.terminate()
    discard p.waitForExit(terminateTimeoutMs)
    if p.running():
      p.kill()
      discard p.waitForExit(killTimeoutMs)
  except CatchableError:
    discard

proc runProcessWithParentStreams*(command: string;
                                  args: seq[string] = @[];
                                  timeoutMs = -1): ExternalProcessResult =
  ## Use this for child processes whose output is not consumed by FrameOS.
  ## It avoids deadlocks from full stdout/stderr pipes.
  var p = startProcess(command, args = args, options = {poUsePath, poParentStreams})
  try:
    let exitCode = p.waitForExit(timeoutMs)
    if exitCode == -1 and p.running():
      p.stopProcess()
      return ExternalProcessResult(exitCode: -1, timedOut: true)
    return ExternalProcessResult(exitCode: exitCode, timedOut: false)
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

proc writePipe(handle: FileHandle; input: string; offset: var int): bool =
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

proc waitForPipedExit(p: Process): int =
  result = p.peekExitCode()
  if result != -1:
    return
  result = p.waitForExit(DefaultProcessPollMs)
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
  var p = startProcess(command, args = args, options = {poUsePath})
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
