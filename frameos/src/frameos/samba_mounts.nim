import std/[os, sets, strutils]
import frameos/device_setup
import frameos/types

const
  frameosFstabBegin* = "# BEGIN FrameOS Samba mounts"
  frameosFstabEnd* = "# END FrameOS Samba mounts"
  sambaCredentialsDir* = "/etc/frameos/samba"

proc containsLineBreak(value: string): bool =
  value.contains("\n") or value.contains("\r")

proc fstabEscape*(value: string): string =
  result = ""
  for ch in value:
    case ch
    of ' ':
      result.add("\\040")
    of '\t':
      result.add("\\011")
    of '\n', '\r':
      discard
    of '\\':
      result.add("\\134")
    else:
      result.add(ch)

proc octalValue(ch: char): int =
  ord(ch) - ord('0')

proc fstabUnescape*(value: string): string =
  result = ""
  var index = 0
  while index < value.len:
    if (
      value[index] == '\\' and
      index + 3 < value.len and
      value[index + 1] in {'0'..'7'} and
      value[index + 2] in {'0'..'7'} and
      value[index + 3] in {'0'..'7'}
    ):
      let decoded =
        octalValue(value[index + 1]) * 64 +
        octalValue(value[index + 2]) * 8 +
        octalValue(value[index + 3])
      result.add(char(decoded))
      index += 4
    else:
      result.add(value[index])
      index += 1

proc enabledMountpoints*(mountpoints: MountpointsConfig): seq[MountpointConfig] =
  result = @[]
  if mountpoints == nil or not mountpoints.enabled:
    return
  for mountpoint in mountpoints.items:
    if mountpoint != nil and mountpoint.enabled:
      result.add(mountpoint)

proc mountpointNeedsCredentials*(mountpoint: MountpointConfig): bool =
  mountpoint.username.len > 0 or mountpoint.password.len > 0 or mountpoint.domain.len > 0

proc credentialFilePath*(credentialsDir: string, index: int): string =
  credentialsDir / ("mount-" & $(index + 1) & ".credentials")

proc validateMountpoint(mountpoint: MountpointConfig, index: int) =
  let label = "mountpoint #" & $(index + 1)
  let source = mountpoint.source.strip()
  let target = mountpoint.target.strip()
  if source.len == 0:
    raise newException(ValueError, "Samba " & label & " is missing a source")
  if not source.startsWith("//"):
    raise newException(ValueError, "Samba " & label & " source must start with //")
  if target.len == 0:
    raise newException(ValueError, "Samba " & label & " is missing a mount path")
  if not target.startsWith("/"):
    raise newException(ValueError, "Samba " & label & " mount path must be absolute")
  if containsLineBreak(source) or containsLineBreak(target):
    raise newException(ValueError, "Samba " & label & " source and mount path cannot contain line breaks")
  if containsLineBreak(mountpoint.username) or containsLineBreak(mountpoint.password) or containsLineBreak(mountpoint.domain):
    raise newException(ValueError, "Samba " & label & " credentials cannot contain line breaks")

proc addMountOption(options: var seq[string], seen: var HashSet[string], option: string) =
  let normalized = option.strip()
  if normalized.len == 0 or seen.contains(normalized):
    return
  for ch in normalized:
    if ch in Whitespace or ch == '#':
      return
  seen.incl(normalized)
  options.add(normalized)

proc mountOptions(mountpoint: MountpointConfig, index: int, credentialsDir: string): seq[string] =
  var seen = initHashSet[string]()
  result = @[]
  if mountpointNeedsCredentials(mountpoint):
    result.addMountOption(seen, "credentials=" & fstabEscape(credentialFilePath(credentialsDir, index)))
  else:
    result.addMountOption(seen, "guest")
  for option in ["iocharset=utf8", "_netdev", "nofail", "x-systemd.automount", "x-systemd.device-timeout=10s", "vers=3.0"]:
    result.addMountOption(seen, option)
  for option in mountpoint.options.split(","):
    result.addMountOption(seen, option)

proc sambaFstabEntry*(mountpoint: MountpointConfig, index: int, credentialsDir = sambaCredentialsDir): string =
  validateMountpoint(mountpoint, index)
  fstabEscape(mountpoint.source.strip()) & " " &
    fstabEscape(mountpoint.target.strip()) & " cifs " &
    mountOptions(mountpoint, index, credentialsDir).join(",") &
    " 0 0"

proc frameosFstabBlock*(mountpoints: MountpointsConfig, credentialsDir = sambaCredentialsDir): string =
  let items = enabledMountpoints(mountpoints)
  if items.len == 0:
    return ""
  var lines = @[frameosFstabBegin]
  for index, mountpoint in items:
    lines.add(sambaFstabEntry(mountpoint, index, credentialsDir))
  lines.add(frameosFstabEnd)
  result = lines.join("\n") & "\n"

proc extractFrameosMountTargets*(content: string): seq[string] =
  result = @[]
  var inside = false
  for line in content.splitLines():
    let stripped = line.strip()
    if stripped == frameosFstabBegin:
      inside = true
      continue
    if stripped == frameosFstabEnd:
      inside = false
      continue
    if not inside or stripped.len == 0 or stripped.startsWith("#"):
      continue

    let fields = stripped.splitWhitespace()
    if fields.len >= 3 and fields[2] == "cifs":
      result.add(fstabUnescape(fields[1]))

proc removeFrameosFstabBlock(content: string): tuple[content: string, removed: bool] =
  var lines: seq[string] = @[]
  var inside = false
  var removed = false
  for line in content.splitLines():
    let stripped = line.strip()
    if stripped == frameosFstabBegin:
      inside = true
      removed = true
      continue
    if inside:
      if stripped == frameosFstabEnd:
        inside = false
      continue
    lines.add(line)
  result = (lines.join("\n"), removed)

proc applyFrameosFstabBlock*(content: string, fstabBlock: string): tuple[content: string, changed: bool] =
  let normalizedBlock = fstabBlock.strip(leading = false, trailing = true, chars = {'\n', '\r'})
  let removed = removeFrameosFstabBlock(content)
  if not removed.removed and normalizedBlock.len == 0:
    return (content, false)

  let base = removed.content.strip(leading = false, trailing = true, chars = {'\n', '\r'})
  var nextContent = base
  if normalizedBlock.len > 0:
    if nextContent.len > 0:
      nextContent &= "\n\n"
    nextContent &= normalizedBlock & "\n"
  elif nextContent.len > 0:
    nextContent &= "\n"

  result = (nextContent, removed.removed or nextContent != content)

proc mountpointCredentialsContent*(mountpoint: MountpointConfig): string =
  result = ""
  if mountpoint.username.len > 0:
    result &= "username=" & mountpoint.username & "\n"
  if mountpoint.password.len > 0:
    result &= "password=" & mountpoint.password & "\n"
  if mountpoint.domain.len > 0:
    result &= "domain=" & mountpoint.domain & "\n"

proc deleteCredentialFiles(credentialsDir: string) =
  discard runSetupCommand(
    privilegedCommand(
      "find " & shellQuote(credentialsDir) & " -maxdepth 1 -name " & shellQuote("mount-*.credentials") &
        " -delete 2>/dev/null || true"
    ),
    raiseOnError = false,
  )

proc mountSambaFstabEntries*(): bool =
  let mountResult = runSetupCommand(privilegedCommand("mount -a -t cifs"), raiseOnError = false)
  if mountResult.exitCode == 0:
    return true

  echo "FrameOS setup: samba mounts: warning: one or more Samba shares could not be mounted now; startup will continue"
  echo "FrameOS setup: samba mounts: warning: systemd will retry automounts when the mount paths are accessed"
  false

proc setupSambaMounts*(mountpoints: MountpointsConfig): SetupResult =
  let fstabPath = "/etc/fstab"
  let currentFstab = if fileExists(fstabPath): readFile(fstabPath) else: ""
  let previousTargets = extractFrameosMountTargets(currentFstab)
  let requestedItems = enabledMountpoints(mountpoints)

  if requestedItems.len == 0:
    let applied = applyFrameosFstabBlock(currentFstab, "")
    if applied.changed:
      echo "FrameOS setup: samba mounts: removing managed fstab entries"
      writePrivilegedFile(fstabPath, applied.content)
      discard runSetupCommand(privilegedCommand("systemctl daemon-reload"), raiseOnError = false)
    else:
      echo "FrameOS setup: samba mounts: disabled"
    for target in previousTargets:
      discard runSetupCommand(privilegedCommand("umount " & shellQuote(target)), raiseOnError = false)
    deleteCredentialFiles(sambaCredentialsDir)
    return setupOk()

  let fstabBlock = frameosFstabBlock(mountpoints)
  addSetupResult(result, setupAptPackages(@["cifs-utils"]))

  discard runSetupCommand(privilegedCommand("mkdir -p " & shellQuote(sambaCredentialsDir)))
  deleteCredentialFiles(sambaCredentialsDir)
  for index, mountpoint in requestedItems:
    discard runSetupCommand(privilegedCommand("mkdir -p " & shellQuote(mountpoint.target.strip())))
    if mountpointNeedsCredentials(mountpoint):
      let path = credentialFilePath(sambaCredentialsDir, index)
      writePrivilegedFile(path, mountpointCredentialsContent(mountpoint))
      discard runSetupCommand(privilegedCommand("chmod 600 " & shellQuote(path)))

  let applied = applyFrameosFstabBlock(currentFstab, fstabBlock)
  if applied.changed:
    echo "FrameOS setup: samba mounts: updating " & fstabPath
    writePrivilegedFile(fstabPath, applied.content)
  else:
    echo "FrameOS setup: samba mounts: fstab already up to date"

  discard runSetupCommand(privilegedCommand("systemctl daemon-reload"), raiseOnError = false)
  discard mountSambaFstabEntries()
