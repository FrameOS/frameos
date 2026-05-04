import std/[os, osproc, sequtils, sets, strutils, times]

when not defined(windows):
  import posix

type
  SetupCommandResult* = tuple[output: string, exitCode: int]
  SetupCommandRunner* = proc(command: string): SetupCommandResult
  SetupResult* = object
    rebootRequired*: bool

var commandRunner: SetupCommandRunner = proc(command: string): SetupCommandResult =
  execCmdEx(command)

proc setSetupCommandRunnerForTest*(runner: SetupCommandRunner) =
  commandRunner = runner

proc resetSetupCommandRunnerForTest*() =
  commandRunner = proc(command: string): SetupCommandResult =
    execCmdEx(command)

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
  echo "> " & command
  result = commandRunner(command)
  let output = result.output.strip()
  if output.len > 0:
    echo output
  if raiseOnError and result.exitCode != 0:
    raise newException(OSError, "Command failed with exit code " & $result.exitCode & ": " & command)

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
    echo "FrameOS setup: no app apt packages required"
    return setupOk()

  if missingPackages.len == 0:
    echo "FrameOS setup: app apt packages already installed: " & normalizedPackages.join(", ")
    return setupOk()

  if not commandExists("apt-get"):
    raise newException(
      OSError,
      "apt-get not found; required to install app apt packages: " & missingPackages.join(", ")
    )

  echo "FrameOS setup: installing app apt packages: " & missingPackages.join(", ")
  let packageArgs = missingPackages.mapIt(shellQuote(it)).join(" ")
  let installCommand = privilegedAptCommand("apt-get install -y --no-install-recommends " & packageArgs)
  let installResult = runSetupCommand(installCommand, raiseOnError = false)
  if installResult.exitCode != 0:
    echo "FrameOS setup: apt install failed; updating apt and retrying"
    discard runSetupCommand(privilegedAptCommand("apt-get update"))
    discard runSetupCommand(installCommand)

  result = setupOk()

proc detectBootConfigPath*(): string =
  if fileExists("/boot/firmware/config.txt"):
    "/boot/firmware/config.txt"
  else:
    "/boot/config.txt"

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

proc writePrivilegedFile(path: string, content: string) =
  try:
    writeFile(path, content)
  except OSError:
    let tmpPath = getTempDir() / ("frameos-setup-" & $epochTime().int64 & "-" & lastPathPart(path))
    writeFile(tmpPath, content)
    try:
      discard runSetupCommand(
        privilegedShell("install -m 644 " & shellQuote(tmpPath) & " " & shellQuote(path))
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
    echo "Boot config already up to date: " & path
    return
  echo "Updating boot config: " & path
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
  echo "FrameOS setup: " & name
  result = action()
