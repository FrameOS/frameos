import std/[algorithm, dynlib, json, os, osproc, strutils]
import frameos/config
import frameos/types
when not defined(windows):
  import posix

type
  InitPlan* = object
    device*: string
    drivers*: seq[string]
    ensureBootConfigLines*: seq[string]
    removeBootConfigLines*: seq[string]
    ensureAptPackages*: seq[string]
    pythonVendorFolders*: seq[string]
    spiMode*: DriverInitSpiMode
    enableI2c*: bool

  InitResult* = object
    device*: string
    drivers*: seq[string]
    bootConfigPath*: string
    actions*: seq[string]
    rebootRequired*: bool

  InitExecHook* = proc(command: string): tuple[output: string, exitCode: int] {.nimcall.}
  DriverInitSpecLoaderHook* = proc(
    frameConfig: FrameConfig,
    driversDir: string,
  ): seq[tuple[id: string, spec: DriverInitSpec]] {.nimcall.}
  CompiledDriverPluginFactory = proc(): CompiledDriverPlugin {.cdecl.}

var initExecHook*: InitExecHook
var driverInitSpecLoaderHook*: DriverInitSpecLoaderHook
var compiledDriverInitLoadCounter = 0

const COMPILED_DRIVER_PLUGIN_SYMBOL = "getCompiledDriverPlugin"

proc shQuote(value: string): string =
  "'" & value.replace("'", "'\"'\"'") & "'"

proc addUnique(values: var seq[string], value: string) =
  if value.len == 0 or value in values:
    return
  values.add(value)

proc runCommand(command: string): tuple[output: string, exitCode: int] =
  if not initExecHook.isNil:
    return initExecHook(command)
  execCmdEx(command)

proc runChecked(command: string): string =
  let (output, exitCode) = runCommand(command)
  if exitCode != 0:
    let detail =
      if output.strip().len > 0:
        ": " & output.strip()
      else:
        ""
    raise newException(IOError, "Command failed (" & $exitCode & "): " & command & detail)
  output

proc copyCompiledDriverLibrary(sourcePath: string): string =
  inc compiledDriverInitLoadCounter
  let targetPath = getTempDir() / (
    "frameos-init-" & $compiledDriverInitLoadCounter & "-" & extractFilename(sourcePath)
  )
  copyFile(sourcePath, targetPath)
  targetPath

proc removeCopiedCompiledDriverLibrary(path: string) =
  if path.len == 0:
    return
  try:
    if fileExists(path):
      removeFile(path)
  except OSError:
    discard

proc loadDriverInitSpec(
  path: string,
  frameConfig: FrameConfig,
): tuple[id: string, spec: DriverInitSpec] =
  var copiedPath = ""
  try:
    copiedPath = copyCompiledDriverLibrary(path)
    let handle = loadLib(copiedPath)
    if handle.isNil:
      raise newException(IOError, "Failed to load compiled driver plugin: " & path)

    let factory = cast[CompiledDriverPluginFactory](symAddr(handle, COMPILED_DRIVER_PLUGIN_SYMBOL))
    if factory.isNil:
      raise newException(IOError, "Missing compiled driver plugin symbol in: " & path)

    let plugin = factory()
    if plugin.isNil or plugin.driver.isNil:
      raise newException(IOError, "Compiled driver plugin returned no driver: " & path)

    result.id =
      if plugin.id.len > 0:
        plugin.id
      else:
        extractFilename(path)
    if plugin.driver.deviceInit.isNil:
      return
    result.spec = plugin.driver.deviceInit(frameConfig)
  except CatchableError as e:
    raise newException(IOError, "Failed to load init spec from " & path & ": " & e.msg)
  finally:
    removeCopiedCompiledDriverLibrary(copiedPath)

proc defaultCompiledDriversDir*(): string =
  parentDir(getAppFilename()) / "drivers"

proc loadDriverInitSpecs(
  frameConfig: FrameConfig,
  driversDir: string,
): seq[tuple[id: string, spec: DriverInitSpec]] =
  if not driverInitSpecLoaderHook.isNil:
    return driverInitSpecLoaderHook(frameConfig, driversDir)

  if not dirExists(driversDir):
    return @[]

  var driverPaths: seq[string] = @[]
  for path in walkFiles(driversDir / "*.so"):
    driverPaths.add(path)
  driverPaths.sort(system.cmp[string])

  for path in driverPaths:
    let loaded = loadDriverInitSpec(path, frameConfig)
    if loaded.spec.isNil:
      continue
    result.add(loaded)

proc mergeSpiMode(plan: var InitPlan, nextMode: DriverInitSpiMode, driverId: string) =
  case nextMode
  of dismUnchanged:
    discard
  of dismEnable:
    if plan.spiMode == dismDisable:
      raise newException(ValueError, "Conflicting SPI init requirements for driver: " & driverId)
    plan.spiMode = dismEnable
  of dismDisable:
    if plan.spiMode == dismEnable:
      raise newException(ValueError, "Conflicting SPI init requirements for driver: " & driverId)
    plan.spiMode = dismDisable

proc mergeDriverInitSpec(plan: var InitPlan, driverId: string, spec: DriverInitSpec) =
  if spec.isNil:
    return

  plan.drivers.addUnique(driverId)
  mergeSpiMode(plan, spec.spiMode, driverId)
  if spec.enableI2c:
    plan.enableI2c = true

  for line in spec.ensureBootConfigLines:
    plan.ensureBootConfigLines.addUnique(line)
  for line in spec.removeBootConfigLines:
    plan.removeBootConfigLines.addUnique(line)
  for packageName in spec.ensureAptPackages:
    plan.ensureAptPackages.addUnique(packageName)
  for vendorFolder in spec.pythonVendorFolders:
    plan.pythonVendorFolders.addUnique(vendorFolder)

proc buildInitPlan*(
  frameConfig: FrameConfig,
  driversDir = "",
): InitPlan =
  result.device =
    if frameConfig.isNil:
      ""
    else:
      frameConfig.device
  result.spiMode = dismUnchanged

  let resolvedDriversDir =
    if driversDir.len > 0:
      driversDir
    else:
      defaultCompiledDriversDir()

  for loaded in loadDriverInitSpecs(frameConfig, resolvedDriversDir):
    result.mergeDriverInitSpec(loaded.id, loaded.spec)

proc bootConfigRequired(plan: InitPlan): bool =
  plan.enableI2c or
    plan.spiMode != dismUnchanged or
    plan.ensureBootConfigLines.len > 0 or
    plan.removeBootConfigLines.len > 0

proc defaultBootConfigPath*(): string =
  if fileExists("/boot/firmware/config.txt"):
    return "/boot/firmware/config.txt"
  "/boot/config.txt"

proc readBootConfigLines(path: string): seq[string] =
  if not fileExists(path):
    raise newException(IOError, "Boot config file not found: " & path)
  for line in readFile(path).splitLines():
    if line.len == 0:
      continue
    result.add(line)

proc writeBootConfigLines(path: string, lines: seq[string]) =
  let contents =
    if lines.len == 0:
      ""
    else:
      lines.join("\n") & "\n"
  writeFile(path, contents)

proc ensureBootConfigLine(path: string, line: string, result: var InitResult) =
  var lines = readBootConfigLines(path)
  for existing in lines:
    if existing.strip() == line:
      return

  lines.add(line)
  writeBootConfigLines(path, lines)
  result.actions.add("Added boot config line: " & line)
  result.rebootRequired = true

proc removeBootConfigLine(path: string, line: string, result: var InitResult) =
  let lines = readBootConfigLines(path)
  var filtered: seq[string] = @[]
  var removed = false

  for existing in lines:
    if existing.strip() == line:
      removed = true
      continue
    filtered.add(existing)

  if not removed:
    return

  writeBootConfigLines(path, filtered)
  result.actions.add("Removed boot config line: " & line)
  result.rebootRequired = true

proc commandExists(commandName: string): bool =
  runCommand("command -v " & commandName & " >/dev/null 2>&1").exitCode == 0

proc getRaspiConfigState(feature: string): int =
  let (output, exitCode) = runCommand("raspi-config nonint get_" & feature)
  if exitCode != 0:
    return -1
  try:
    parseInt(output.strip())
  except ValueError:
    -1

proc ensureRaspiConfigState(feature: string, enable: bool, result: var InitResult) =
  if not commandExists("raspi-config"):
    return

  let desiredState = if enable: 0 else: 1
  let currentState = getRaspiConfigState(feature)
  if currentState == desiredState:
    return

  let action = if enable: "0" else: "1"
  discard runChecked("raspi-config nonint do_" & feature & " " & action)
  result.actions.add(
    (if enable: "Enabled " else: "Disabled ") &
      feature.toUpperAscii() &
      " via raspi-config"
  )
  result.rebootRequired = true

proc ensureAptPackageInstalled(packageName: string, result: var InitResult) =
  if runCommand("dpkg -s " & shQuote(packageName) & " >/dev/null 2>&1").exitCode == 0:
    return

  let installCommand = "apt-get install -y " & shQuote(packageName)
  if runCommand(installCommand).exitCode != 0:
    discard runChecked("apt-get update && " & installCommand)
  result.actions.add("Installed apt package: " & packageName)

proc ensurePythonVendorRuntime(
  vendorRoot: string,
  vendorFolder: string,
  result: var InitResult,
) =
  let vendorPath = vendorRoot / vendorFolder
  if not dirExists(vendorPath):
    raise newException(IOError, "Vendor directory not found: " & vendorPath)
  if not fileExists(vendorPath / "requirements.txt"):
    raise newException(IOError, "requirements.txt not found in vendor directory: " & vendorPath)

  discard runChecked(
    "cd " & shQuote(vendorPath) & " && " &
      "([ ! -d env ] && python3 -m venv env || true) && " &
      "(sha256sum -c requirements.txt.sha256sum >/dev/null 2>&1 || " &
      "(env/bin/pip3 install -r requirements.txt && sha256sum requirements.txt > requirements.txt.sha256sum))"
  )
  result.actions.add("Verified Python runtime for driver: " & vendorFolder)

proc applyInitPlan*(
  plan: InitPlan,
  bootConfigPath = "",
  vendorRoot = "/srv/frameos/vendor",
): InitResult =
  result = InitResult(
    device: plan.device,
    drivers: plan.drivers,
    actions: @[],
    rebootRequired: false,
  )

  for packageName in plan.ensureAptPackages:
    ensureAptPackageInstalled(packageName, result)

  for vendorFolder in plan.pythonVendorFolders:
    ensurePythonVendorRuntime(vendorRoot, vendorFolder, result)

  if bootConfigRequired(plan):
    result.bootConfigPath =
      if bootConfigPath.len > 0:
        bootConfigPath
      else:
        defaultBootConfigPath()

    if plan.enableI2c:
      ensureBootConfigLine(result.bootConfigPath, "dtparam=i2c_vc=on", result)
      ensureRaspiConfigState("i2c", true, result)

    let shouldEnsureSpiBootLine =
      plan.spiMode == dismEnable and "dtparam=spi=on" notin plan.removeBootConfigLines
    if shouldEnsureSpiBootLine:
      ensureBootConfigLine(result.bootConfigPath, "dtparam=spi=on", result)

    if plan.spiMode == dismEnable:
      ensureRaspiConfigState("spi", true, result)
    elif plan.spiMode == dismDisable:
      removeBootConfigLine(result.bootConfigPath, "dtparam=spi=on", result)
      ensureRaspiConfigState("spi", false, result)

    for line in plan.ensureBootConfigLines:
      ensureBootConfigLine(result.bootConfigPath, line, result)

    for line in plan.removeBootConfigLines:
      removeBootConfigLine(result.bootConfigPath, line, result)

proc initResultJson*(initResult: InitResult): JsonNode =
  %*{
    "device": initResult.device,
    "drivers": initResult.drivers,
    "bootConfigPath": initResult.bootConfigPath,
    "actions": initResult.actions,
    "rebootRequired": initResult.rebootRequired,
  }

proc initializeCurrentFrameOS*(
  configPath = "",
  bootConfigPath = "",
  vendorRoot = "/srv/frameos/vendor",
  driversDir = "",
): InitResult =
  let hadConfigEnv = existsEnv("FRAMEOS_CONFIG")
  let previousConfig = if hadConfigEnv: getEnv("FRAMEOS_CONFIG") else: ""

  if configPath.len > 0:
    putEnv("FRAMEOS_CONFIG", configPath)

  try:
    let frameConfig = loadConfig()
    let plan = buildInitPlan(frameConfig, driversDir = driversDir)
    applyInitPlan(plan, bootConfigPath = bootConfigPath, vendorRoot = vendorRoot)
  finally:
    if configPath.len > 0:
      if hadConfigEnv:
        putEnv("FRAMEOS_CONFIG", previousConfig)
      else:
        delEnv("FRAMEOS_CONFIG")

proc initUsage*(): string =
  "Usage: frameos init [--config PATH] [--json]"

proc runInitCommand*(args: seq[string]) =
  var jsonOutput = false
  var configPath = ""

  var index = 0
  while index < args.len:
    case args[index]
    of "--json":
      jsonOutput = true
    of "--config":
      inc index
      if index >= args.len:
        raise newException(ValueError, "--config requires a file path")
      configPath = args[index]
    of "--help", "-h":
      echo initUsage()
      return
    else:
      raise newException(ValueError, "Unknown init option: " & args[index])
    inc index

  when not defined(windows):
    if geteuid() != 0:
      raise newException(IOError, "frameos init must be run as root")

  let result = initializeCurrentFrameOS(configPath = configPath)
  if jsonOutput:
    echo initResultJson(result).pretty()
    return

  echo "FrameOS init: " & (if result.device.len > 0: result.device else: "no device configured")
  if result.drivers.len > 0:
    echo "Drivers: " & result.drivers.join(", ")
  if result.actions.len == 0:
    echo "No init changes required."
  else:
    for action in result.actions:
      echo "- " & action
  echo "Reboot required: " & (if result.rebootRequired: "yes" else: "no")
