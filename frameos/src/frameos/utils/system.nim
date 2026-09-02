import std/os

proc writePrivateFile*(path: string, content: string) =
  ## `writeFile` for a file nobody but the service user may read: created
  ## (or truncated) and chmod'd 0600 BEFORE the content is written, so there
  ## is no window where the bytes sit at whatever the umask allowed. The
  ## order matters — the previous `writeFile` then `chmod` left the secret
  ## world-readable in between, and a file that already existed keeps its
  ## old mode across a plain overwrite. Same pattern as cloud/link_state.nim.
  let handle = open(path, fmWrite)
  try:
    setFilePermissions(path, {fpUserRead, fpUserWrite})
    handle.write(content)
  finally:
    handle.close()

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

when defined(frameosEmbedded) or defined(frameosWasm):
  proc getAvailableDiskSpace*(path: string): int64 =
    ## No statvfs on the embedded VFS; callers treat -1 as "unknown".
    -1
else:
  import posix

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
