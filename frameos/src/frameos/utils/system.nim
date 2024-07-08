import posix

proc getAvailableDiskSpace*(path: string): int64 =
  let fd = open(path.cstring, O_RDONLY)
  if fd >= 0:
    try:
      var statvfs: StatVfs
      if fstatvfs(fd, statvfs) == 0:
        return statvfs.f_bavail * statvfs.f_frsize
    finally:
      discard close(fd)
  return -1
