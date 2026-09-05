import std/[json, os, sequtils, sets, strutils, times]
import frameos/privileged
import frameos/utils/process
import frameos/utils/system

when not defined(windows):
  import posix

type
  SetupCommandResult* = tuple[output: string, exitCode: int]
  SetupCommandRunner* = proc(command: string): SetupCommandResult
  SetupResult* = object
    rebootRequired*: bool

# Setup commands can legitimately take minutes (apt, raspi-config, pip)
const setupCommandTimeoutMs = 15 * 60 * 1000

var commandRunner: SetupCommandRunner = proc(command: string): SetupCommandResult =
  runShellCapture(command, timeoutMs = setupCommandTimeoutMs)

proc setupLog*(message: string) =
  echo message
  flushFile(stdout)

proc setSetupCommandRunnerForTest*(runner: SetupCommandRunner) =
  commandRunner = runner

proc resetSetupCommandRunnerForTest*() =
  commandRunner = proc(command: string): SetupCommandResult =
    runShellCapture(command, timeoutMs = setupCommandTimeoutMs)

proc setupOk*(): SetupResult =
  SetupResult(rebootRequired: false)

proc setupNeedsReboot*(): SetupResult =
  SetupResult(rebootRequired: true)

proc addSetupResult*(target: var SetupResult, source: SetupResult) =
  target.rebootRequired = target.rebootRequired or source.rebootRequired

proc shellQuote*(value: string): string =
  "'" & value.replace("'", "'\"'\"'") & "'"

proc sudoPrefix(): string =
  when defined(windows):
    ""
  else:
    if geteuid() == 0:
      ""
    else:
      "sudo -n "

proc runSetupCommand*(command: string, raiseOnError = true): SetupCommandResult =
  setupLog("> " & command)
  result = commandRunner(command)
  let output = result.output.strip()
  if output.len > 0:
    setupLog(output)
  if raiseOnError and result.exitCode != 0:
    raise newException(OSError, "Command failed with exit code " & $result.exitCode & ": " & command)

proc runSetupCommandDetached*(command: string) =
  ## For a command that backgrounds a long-lived child (`nohup … &`). The
  ## captured runner cannot be used for that: the child inherits the write
  ## end of the runner's stdout pipe, so runSetupCommand waits for an EOF
  ## that only comes when the child exits — the cloud session thread on a
  ## door frame sat inside scheduleFrameOSUpgrade for the whole upgrade,
  ## acking nothing and answering no heartbeat until the restart killed it
  ## (uus2w and Cloud-5, 2026-09-05; `systemd-run` on root frames never
  ## had the problem because a transient unit inherits nothing). Parent
  ## streams instead: nothing to inherit, and the shell returns the moment
  ## it has backgrounded the child.
  setupLog("> " & command)
  discard runShellWithParentStreams("sh -c " & shellQuote(command), timeoutMs = setupCommandTimeoutMs)

proc runSetupCommandRetrying*(command: string, attempts = 3, pauseMs = 2000): SetupCommandResult =
  ## For idempotent commands that talk to a daemon which may still be coming
  ## up — `systemctl` on a first boot runs while systemd is busy starting the
  ## rest of the system, and one failed round trip there took a whole card's
  ## setup down with it. Retried on any non-zero exit (-1 is our own
  ## timeout/spawn failure, not the command's), raising like runSetupCommand
  ## only after the last attempt, so a systemd that is really broken still
  ## fails loudly.
  for attempt in 1 .. attempts:
    result = runSetupCommand(command, raiseOnError = false)
    if result.exitCode == 0:
      return
    if attempt < attempts:
      setupLog("FrameOS setup: attempt " & $attempt & " of " & $attempts & " failed with exit code " &
        $result.exitCode & "; retrying in " & $pauseMs & " ms: " & command)
      sleep(pauseMs)
  raise newException(OSError, "Command failed with exit code " & $result.exitCode & " after " &
    $attempts & " attempts: " & command)

proc commandSucceeds*(command: string): bool =
  commandRunner(command).exitCode == 0

proc commandExists*(command: string): bool =
  commandSucceeds("command -v " & shellQuote(command) & " >/dev/null 2>&1")

proc privilegedShell(command: string): string =
  sudoPrefix() & "sh -c " & shellQuote(command)

proc privilegedCommand*(command: string): string =
  sudoPrefix() & command

proc privilegedAptCommand(command: string): string =
  sudoPrefix() & "env DEBIAN_FRONTEND=noninteractive " & command

proc systemRebootCommand*(delaySeconds = 2): string =
  ## The one shell line every reboot path on the device runs: detached, so the
  ## caller's process can finish what it was doing, and `reboot` as the
  ## fallback for an init without systemd.
  privilegedShell("(sleep " & $delaySeconds & "; systemctl reboot || reboot) >/dev/null 2>&1 &")

proc rebootThroughPrivilegedDoor(delaySeconds: int): bool =
  ## On a Buildroot frame the runtime is not root and cannot reboot; the root
  ## worker does it (frameos/privileged.nim, verb `reboot`). Returns false
  ## when there is no door, so the caller falls back to its own command.
  if not privilegedDoorAvailable():
    return false
  let res = requestPrivileged(pvReboot, %*{"delaySeconds": delaySeconds}, timeoutMs = 15_000)
  if not res.ok:
    setupLog("FrameOS reboot: privileged door refused: " & res.error)
  res.ok

proc scheduleSystemReboot*(delaySeconds = 2) =
  ## Reboot the device shortly after the caller returns. The delay exists so the
  ## caller can finish writing its status file (and, over HTTP, flush a
  ## response) before init tears the process down. Logs through the setup log.
  if rebootThroughPrivilegedDoor(delaySeconds):
    return
  discard runSetupCommand(systemRebootCommand(delaySeconds), raiseOnError = false)

proc rebootSystemDetached*(delaySeconds = 2) =
  ## `scheduleSystemReboot` for the running frame — the cloud `reboot` verb
  ## and a scheduled `reboot` event — where the caller does its own logging.
  ## Goes through `commandRunner` so tests can intercept it instead of
  ## rebooting the developer's machine.
  if rebootThroughPrivilegedDoor(delaySeconds):
    return
  discard commandRunner(systemRebootCommand(delaySeconds))

# --- writing to a read-only root filesystem --------------------------------
#
# Buildroot frames run with `/` mounted read-only: the kernel command line asks
# for neither `ro` nor `rw` (so the kernel default, read-only, wins) and the
# generated /etc/fstab has no `/` entry for systemd-remount-fs to act on — only
# the first-boot scripts remount it, briefly. Every setup step that writes to
# the root filesystem therefore failed with EROFS on those frames, which is
# what aborted every Buildroot OTA upgrade in `frameos setup` after the release
# had been downloaded and its signature verified:
#
#   install: cannot remove '/etc/systemd/system/frameos.service': Read-only file system
#
# Leaving the rootfs writable is not the fix: a frame loses power at arbitrary
# moments and only /srv is expected to be dirty when it does. So setup remounts
# read-write around the writes and puts the mount back afterwards.

proc unescapeMountField(value: string): string =
  ## /proc/mounts octal-escapes the characters that would otherwise split a
  ## field. Only these four are escaped by the kernel.
  value.multiReplace(("\\040", " "), ("\\011", "\t"), ("\\012", "\n"), ("\\134", "\\"))

proc mountPointForPath*(mounts, path: string): tuple[mountPoint: string, readOnly: bool] =
  ## The /proc/mounts entry `path` lives on: the longest mount point that is a
  ## prefix of it, last entry winning among equals (that is what an overmount
  ## means). Pure, and `path` need not exist yet — the file we are about to
  ## write usually does not.
  result = ("", false)
  if not path.startsWith("/"):
    return
  for line in mounts.splitLines():
    let fields = line.splitWhitespace()
    if fields.len < 4:
      continue
    let mountPoint = unescapeMountField(fields[1])
    if not mountPoint.startsWith("/"):
      continue
    if not (mountPoint == "/" or path == mountPoint or path.startsWith(mountPoint & "/")):
      continue
    if mountPoint.len < result.mountPoint.len:
      continue
    result.mountPoint = mountPoint
    result.readOnly = "ro" in unescapeMountField(fields[3]).split(',')

proc procMountsPath(): string =
  ## FRAMEOS_PROC_MOUNTS is a test seam, mirroring FRAMEOS_BOOT_CONFIG.
  getEnv("FRAMEOS_PROC_MOUNTS", "/proc/mounts")

proc readOnlyMountPointFor*(path: string): string =
  ## The mount point `path` sits on, but only while that mount is read-only.
  ## "" when it is writable, or when /proc/mounts cannot be read at all (macOS,
  ## a container, a test) — there setup simply writes and reports whatever
  ## error it gets, exactly as it did before.
  try:
    let mountsPath = procMountsPath()
    if not fileExists(mountsPath):
      return ""
    let entry = mountPointForPath(readFile(mountsPath), path)
    if entry.readOnly:
      return entry.mountPoint
  except CatchableError:
    discard
  ""

proc beginWritableMount*(path: string): string =
  ## Remounts the filesystem `path` lives on read-write and returns the mount
  ## point to hand back to endWritableMount. Returns "" when nothing was
  ## remounted: already writable (including by an enclosing scope — /proc/mounts
  ## is the nesting counter), or the remount failed, in which case the write
  ## below fails with its own, more informative, error.
  let mountPoint = readOnlyMountPointFor(path)
  if mountPoint.len == 0:
    return ""
  setupLog("FrameOS setup: remounting " & mountPoint & " read-write")
  let remounted = runSetupCommand(
    privilegedCommand("mount -o remount,rw " & shellQuote(mountPoint)),
    raiseOnError = false,
  )
  if remounted.exitCode != 0:
    setupLog("FrameOS setup: could not remount " & mountPoint & " read-write")
    return ""
  mountPoint

proc endWritableMount*(mountPoint: string) =
  if mountPoint.len == 0:
    return
  setupLog("FrameOS setup: restoring " & mountPoint & " to read-only")
  # Flush first, exactly as the backend deploy path does before its own
  # remount: a remount,ro that races unwritten data is how a frame comes back
  # from an upgrade with a truncated unit file.
  discard runSetupCommand(privilegedCommand("sync"), raiseOnError = false)
  let restored = runSetupCommand(
    privilegedCommand("mount -o remount,ro " & shellQuote(mountPoint)),
    raiseOnError = false,
  )
  if restored.exitCode != 0:
    setupLog("FrameOS setup: could not restore " & mountPoint &
      " to read-only; it stays writable until the next boot")

template withWritableMount*(path: string, body: untyped) =
  ## Runs `body` with the filesystem behind `path` writable. Restores the mount
  ## even when `body` raises — a half-finished setup must not leave the rootfs
  ## writable for the rest of the device's uptime.
  let frameosWritableMountPoint = beginWritableMount(path)
  try:
    body
  finally:
    endWritableMount(frameosWritableMountPoint)

proc isValidAptPackageName*(name: string): bool =
  let normalized = name.strip()
  if normalized.len == 0:
    return false
  if not (normalized[0] in {'A'..'Z', 'a'..'z', '0'..'9'}):
    return false
  for ch in normalized:
    if ch notin {'A'..'Z', 'a'..'z', '0'..'9', '+', '.', '-'}:
      return false
  true

proc aptPackageInstalled*(name: string): bool =
  commandSucceeds(
    "dpkg-query -W -f='${Status}' " & shellQuote(name) &
    " 2>/dev/null | grep -q '^install ok installed$'"
  )

proc setupAptPackages*(packages: seq[string]): SetupResult =
  var seen = initHashSet[string]()
  var normalizedPackages: seq[string] = @[]
  var missingPackages: seq[string] = @[]

  for packageName in packages:
    let normalized = packageName.strip()
    if normalized.len == 0 or seen.contains(normalized):
      continue
    if not isValidAptPackageName(normalized):
      raise newException(ValueError, "Invalid apt package name: " & packageName)
    seen.incl(normalized)
    normalizedPackages.add(normalized)
    if not aptPackageInstalled(normalized):
      missingPackages.add(normalized)

  if normalizedPackages.len == 0:
    setupLog("FrameOS setup: app apt packages: none required")
    return setupOk()

  if missingPackages.len == 0:
    setupLog("FrameOS setup: app apt packages: already installed (" & normalizedPackages.join(", ") & ")")
    return setupOk()

  if not commandExists("apt-get"):
    raise newException(
      OSError,
      "apt-get not found; required to install app apt packages: " & missingPackages.join(", ")
    )

  setupLog("FrameOS setup: app apt packages: installing " & missingPackages.join(", "))
  let packageArgs = missingPackages.mapIt(shellQuote(it)).join(" ")
  let installCommand = privilegedAptCommand("apt-get install -y --no-install-recommends " & packageArgs)
  let installResult = runSetupCommand(installCommand, raiseOnError = false)
  if installResult.exitCode != 0:
    setupLog("FrameOS setup: app apt packages: install failed; updating apt and retrying")
    discard runSetupCommand(privilegedAptCommand("apt-get update"))
    discard runSetupCommand(installCommand)

  result = setupOk()

proc looksLikeBuildrootBootConfig*(content: string): bool =
  for line in content.splitLines():
    let normalized = line.strip()
    if normalized == "kernel=Image" or
        normalized.startsWith("start_file=") or
        normalized.startsWith("fixup_file="):
      return true
  false

proc readFileForBootConfigDetection(path: string): string =
  try:
    if fileExists(path):
      return readFile(path)
  except CatchableError:
    discard
  ""

proc chooseBootConfigPath*(configuredPath, bootConfigPath, firmwareConfigPath: string): string =
  if configuredPath.len > 0:
    return configuredPath

  let bootConfig = readFileForBootConfigDetection(bootConfigPath)
  if bootConfig.len > 0 and looksLikeBuildrootBootConfig(bootConfig):
    return bootConfigPath

  if fileExists(firmwareConfigPath):
    return firmwareConfigPath

  bootConfigPath

proc detectBootConfigPath*(): string =
  chooseBootConfigPath(getEnv("FRAMEOS_BOOT_CONFIG"), "/boot/config.txt", "/boot/firmware/config.txt")

proc normalizeBootConfig(content: string): string =
  content.strip(leading = false, trailing = true, chars = {'\n', '\r'}) & "\n"

proc applyBootConfigLines*(content: string, requestedLines: seq[string]): tuple[content: string, changed: bool] =
  var lines = content.splitLines()
  var changed = false

  for requestedLine in requestedLines:
    if requestedLine.len == 0:
      continue
    if requestedLine.startsWith("#"):
      let lineToRemove = requestedLine[1..^1]
      let before = lines.len
      lines = lines.filterIt(it != lineToRemove)
      if lines.len != before:
        changed = true
    elif not lines.anyIt(it == requestedLine):
      lines.add(requestedLine)
      changed = true

  result = (normalizeBootConfig(lines.join("\n")), changed)

proc writePrivilegedFile*(path: string, content: string, private = false) =
  ## `private` files (credentials) are created 0600 on every path through
  ## here — the direct write, the temp copy handed to `install`, and the
  ## installed file itself — so the secret is never world-readable, not even
  ## for the moment between writing and a later chmod.
  if fileExists(path):
    try:
      if readFile(path) == content:
        return
    except CatchableError:
      discard

  withWritableMount(path):
    try:
      if private:
        writePrivateFile(path, content)
      else:
        writeFileAtomically(path, content)
    except CatchableError as writeError:
      let writeErrorMessage = writeError.msg
      let tmpPath = getTempDir() / ("frameos-setup-" & $epochTime().int64 & "-" & lastPathPart(path))
      if private:
        writePrivateFile(tmpPath, content)
      else:
        writeFile(tmpPath, content)
      let mode = if private: "0600" else: "644"
      try:
        discard runSetupCommand(privilegedShell("install -m " & mode & " " & shellQuote(tmpPath) & " " & shellQuote(path)))
      except CatchableError as installError:
        raise newException(
          OSError,
          "Cannot write " & path & ": " & writeErrorMessage & "; privileged install failed: " & installError.msg,
        )
      finally:
        if fileExists(tmpPath):
          removeFile(tmpPath)

proc setupBootConfig*(requestedLines: seq[string], bootConfigPath = ""): SetupResult =
  if requestedLines.len == 0:
    return
  let path = if bootConfigPath.len > 0: bootConfigPath else: detectBootConfigPath()
  let current = if fileExists(path): readFile(path) else: ""
  let applied = applyBootConfigLines(current, requestedLines)
  if not applied.changed:
    setupLog("FrameOS setup: boot config: already up to date (" & path & ")")
    return
  setupLog("FrameOS setup: boot config: updating " & path)
  writePrivilegedFile(path, applied.content)
  result.rebootRequired = true

proc setupPythonVendor*(vendorFolder: string) =
  let vendorPath = "/srv/frameos/vendor" / vendorFolder
  discard runSetupCommand(
    "cd " & shellQuote(vendorPath) & " && " &
    "if [ ! -x env/bin/pip3 ]; then " &
    "rm -rf env && python3 -m venv env && " &
    "echo '> env/bin/pip3 install -r requirements.txt' && " &
    "env/bin/pip3 install -r requirements.txt && " &
    "sha256sum requirements.txt > requirements.txt.sha256sum; " &
    "elif sha256sum -c requirements.txt.sha256sum 2>/dev/null; then " &
    "echo 'requirements unchanged; reusing env'; " &
    "else " &
    "echo '> env/bin/pip3 install -r requirements.txt' && " &
    "env/bin/pip3 install -r requirements.txt && " &
    "sha256sum requirements.txt > requirements.txt.sha256sum; " &
    "fi"
  )

proc runSetupStep*(name: string, action: proc(): SetupResult): SetupResult =
  setupLog("FrameOS setup: checking " & name)
  try:
    result = action()
    if result.rebootRequired:
      setupLog("FrameOS setup: " & name & ": complete (reboot required)")
    else:
      setupLog("FrameOS setup: " & name & ": complete")
  except CatchableError as e:
    setupLog("FrameOS setup: " & name & ": failed: " & e.msg)
    raise
