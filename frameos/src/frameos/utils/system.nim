import std/os

when defined(posix) and not defined(frameosEmbedded) and not defined(frameosWasm):
  import std/posix

  proc secureTempFile(prefix: string): tuple[path: string, handle: File] =
    ## std/posix_utils prefers Linux's mkostemp when Nim merely declares it;
    ## that declaration is also visible on macOS even though libc does not
    ## provide the symbol. Use portable POSIX mkstemp directly.
    var pattern = prefix & "XXXXXX"
    let fd = posix.mkstemp(pattern.cstring)
    if fd < 0:
      raiseOSError(OSErrorCode(errno))
    if not open(result.handle, fd, fmReadWrite):
      discard posix.close(fd)
      raiseOSError(OSErrorCode(errno))
    result.path = pattern

proc writeFileAtomically*(path: string, content: string, private = false,
                          groupReadableOnly = false) =
  ## Replace a regular file without following the destination if it is a
  ## symlink. The temporary file is created with mkstemp in the destination
  ## directory, so its name cannot be pre-planted by an untrusted process and
  ## the final rename is atomic. This matters when a root helper writes into a
  ## sticky directory shared with the unprivileged runtime.
  when defined(posix) and not defined(frameosEmbedded) and not defined(frameosWasm):
    let parent = parentDir(path)
    let prefix = parent / ("." & lastPathPart(path) & ".tmp.")
    let (tempPath, handle) = secureTempFile(prefix)
    var openHandle = handle
    var isOpen = true
    try:
      setFilePermissions(tempPath,
        if private: {fpUserRead, fpUserWrite}
        elif groupReadableOnly: {fpUserRead, fpUserWrite, fpGroupRead}
        else: {fpUserRead, fpUserWrite, fpGroupRead, fpOthersRead})
      openHandle.write(content)
      flushFile(openHandle)
      close(openHandle)
      isOpen = false
      moveFile(tempPath, path)
    except:
      if isOpen:
        try:
          close(openHandle)
        except CatchableError:
          discard
      if fileExists(tempPath) or symlinkExists(tempPath):
        try:
          removeFile(tempPath)
        except CatchableError:
          discard
      raise
  else:
    # Embedded/WASM and Windows do not run the root door. Keep their small
    # VFS-compatible implementation while still applying the final mode.
    writeFile(path, content)
    setFilePermissions(path,
      if private: {fpUserRead, fpUserWrite}
      elif groupReadableOnly: {fpUserRead, fpUserWrite, fpGroupRead}
      else: {fpUserRead, fpUserWrite, fpGroupRead, fpOthersRead})

proc writePrivateFile*(path: string, content: string) =
  ## Atomic, symlink-safe replacement whose temporary inode is 0600 before
  ## any secret bytes are written.
  writeFileAtomically(path, content, private = true)

proc blocksToBytes*(blocks, blockSize: int64): int64 =
  ## Block counts times a block size, in 64-bit arithmetic, always.
  ##
  ## Nim types `statvfs`'s `f_blocks`/`f_bavail`/`f_frsize` as plain `int` on
  ## every non-amd64 Linux (lib/posix/posix_other.nim), so on a 32-bit frame
  ## `stats.f_bavail * stats.f_frsize` multiplies two 32-bit signed ints and
  ## raises OverflowDefect for anything past 2 GiB — every SD card in the
  ## field. Converting after the multiply is too late; the operands have to be
  ## widened first, which is what this exists to make impossible to forget.
  if blocks <= 0 or blockSize <= 0:
    return 0
  blocks * blockSize

when defined(frameosEmbedded) or defined(frameosWasm) or not defined(posix):
  proc getAvailableDiskSpace*(path: string): int64 =
    ## No statvfs on the embedded VFS; callers treat -1 as "unknown".
    -1
else:
  proc getAvailableDiskSpace*(path: string): int64 =
    let fd = open(path.cstring, O_RDONLY)
    if fd >= 0:
      try:
        var statvfs: StatVfs
        if fstatvfs(fd, statvfs) == 0:
          return blocksToBytes(statvfs.f_bavail.int64, statvfs.f_frsize.int64)
      finally:
        discard close(fd)
    return -1
