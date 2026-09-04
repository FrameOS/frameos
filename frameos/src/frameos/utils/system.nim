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

when defined(posix) and not defined(frameosEmbedded) and not defined(frameosWasm):
  # std/posix declares neither of these open(2) flags; both are POSIX.1-2008.
  var O_NOFOLLOW* {.importc: "O_NOFOLLOW", header: "<fcntl.h>".}: cint
  var O_DIRECTORY* {.importc: "O_DIRECTORY", header: "<fcntl.h>".}: cint

  proc openRegularFileNoFollow(path: string, maxBytes: int): cint =
    ## Opens `path` with O_NOFOLLOW and insists on a regular file with a
    ## single link no larger than `maxBytes` (< 0: unlimited). Raises
    ## IOError for a symlink, a non-regular file, extra links or size, and
    ## OSError when the open itself fails. The caller closes the descriptor.
    let fd = posix.open(path.cstring, O_RDONLY or O_NOFOLLOW or O_NONBLOCK or O_CLOEXEC)
    if fd < 0:
      if errno == ELOOP:
        raise newException(IOError, "refusing to follow the symlink at " & path)
      raiseOSError(OSErrorCode(errno), path)
    var st: Stat
    if fstat(fd, st) != 0:
      let err = errno
      discard posix.close(fd)
      raiseOSError(OSErrorCode(err), path)
    var problem = ""
    if not S_ISREG(st.st_mode):
      problem = "not a regular file: " & path
    elif int(st.st_nlink) != 1:
      problem = "refusing a file with " & $st.st_nlink & " links: " & path
    elif maxBytes >= 0 and int64(st.st_size) > int64(maxBytes):
      problem = "file is larger than " & $maxBytes & " bytes: " & path
    if problem.len > 0:
      discard posix.close(fd)
      raise newException(IOError, problem)
    fd

  iterator chunksNoFollow(path: string, maxBytes: int): string =
    ## The contents of `path` (see openRegularFileNoFollow), 64 KiB at a time.
    let fd = openRegularFileNoFollow(path, maxBytes)
    defer: discard posix.close(fd)
    var buffer = newString(64 * 1024)
    var total = 0
    while true:
      let got = posix.read(fd, addr buffer[0], buffer.len)
      if got < 0:
        if errno == EINTR:
          continue
        raiseOSError(OSErrorCode(errno), path)
      if got == 0:
        break
      total += got
      if maxBytes >= 0 and total > maxBytes:
        raise newException(IOError, "file grew past " & $maxBytes & " bytes while reading: " & path)
      yield buffer[0 ..< got]

proc readFileNoFollow*(path: string, maxBytes = -1): string =
  ## `readFile` for a file an untrusted user may have replaced: the path is
  ## opened with O_NOFOLLOW and must be a regular file with a single link, so
  ## a symlink (or a hard link to somebody else's file) planted where a root
  ## helper expects the runtime's own data is refused instead of read. Raises
  ## IOError (symlink, not a regular file, more than one link, too large) or
  ## OSError (cannot open). `maxBytes` < 0 means no size limit.
  when defined(posix) and not defined(frameosEmbedded) and not defined(frameosWasm):
    for chunk in chunksNoFollow(path, maxBytes):
      result.add(chunk)
  else:
    if symlinkExists(path):
      raise newException(IOError, "refusing to follow the symlink at " & path)
    result = readFile(path)
    if maxBytes >= 0 and result.len > maxBytes:
      raise newException(IOError, "file is larger than " & $maxBytes & " bytes: " & path)

proc copyFileNoFollow*(source, destination: string, maxBytes = -1) =
  ## `copyFile` whose source is read like readFileNoFollow (no symlinks, no
  ## extra links, bounded size) and streamed rather than held in memory —
  ## for a root helper copying a large runtime-owned file such as a staged
  ## release archive. The destination is created or truncated as a plain
  ## file; it is expected to live in a directory only the caller can write.
  when defined(posix) and not defined(frameosEmbedded) and not defined(frameosWasm):
    var output = open(destination, fmWrite)
    try:
      for chunk in chunksNoFollow(source, maxBytes):
        output.write(chunk)
      flushFile(output)
    finally:
      close(output)
  else:
    writeFile(destination, readFileNoFollow(source, maxBytes))

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

when defined(frameosEmbedded):
  proc fos_vfs_free_bytes(path: cstring): int64 {.importc, cdecl.}
  proc getAvailableDiskSpace*(path: string): int64 =
    ## No statvfs on the ESP-IDF VFS; the firmware answers for the filesystems
    ## it mounts (the SPIFFS state partition, the SD card at the assets root —
    ## frameos_nim_glue.c) and -1 for anything else. Callers treat -1 as
    ## "unknown".
    fos_vfs_free_bytes(path.cstring)
elif defined(frameosWasm) or not defined(posix):
  proc getAvailableDiskSpace*(path: string): int64 =
    ## No filesystem to ask; callers treat -1 as "unknown".
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


# ---------------------------------------------------------------------------
# The name the system carries. First boot writes /etc/hostname from the SD
# card's frame name (cloud cards) or the backend's hostname file, so it is
# the one identity a card has before anything else is configured.
import std/strutils as system_strutils

var systemHostnameOverride = ""

proc setSystemHostnameForTest*(name: string) =
  systemHostnameOverride = name

proc systemHostname*(): string =
  ## /etc/hostname, or "" when it is missing, empty, dotted, or an image
  ## default (`frame`, `localhost`) that identifies nothing.
  if systemHostnameOverride.len > 0:
    return systemHostnameOverride
  when defined(frameosWasm) or defined(frameosEmbedded):
    ""
  else:
    try:
      if fileExists("/etc/hostname"):
        let name = readFile("/etc/hostname").strip()
        if name.len > 0 and name notin ["frame", "localhost"] and '.' notin name:
          return name
    except CatchableError:
      discard
    ""
