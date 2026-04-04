import std/[algorithm, dynlib, json, os, osproc, strutils]
import drivers/drivers as compiledDrivers
import frameos/config
import frameos/driver_setup
import frameos/types
when not defined(windows):
  import posix

type
  SetupPlan* = object
    device*: string
    drivers*: seq[string]
    ensureBootConfigLines*: seq[string]
    removeBootConfigLines*: seq[string]
    ensureAptPackages*: seq[string]
    pythonVendorFolders*: seq[string]
    spiMode*: DriverSetupSpiMode
    enableI2c*: bool

  SetupResult* = object
    device*: string
    drivers*: seq[string]
    bootConfigPath*: string
    actions*: seq[string]
    rebootRequired*: bool

  SetupExecHook* = proc(command: string): tuple[output: string, exitCode: int] {.nimcall.}
  DriverSetupSpecLoaderHook* = proc(
    frameConfig: FrameConfig,
    driversDir: string,
  ): seq[tuple[id: string, spec: DriverSetupSpec]] {.nimcall.}
  BuiltinDriverSetupSpecLoaderHook* = proc(
    frameConfig: FrameConfig,
  ): seq[tuple[id: string, spec: DriverSetupSpec]] {.nimcall.}
  CompiledDriverPluginFactory = proc(): CompiledDriverPlugin {.cdecl.}

var setupExecHook*: SetupExecHook
var driverSetupSpecLoaderHook*: DriverSetupSpecLoaderHook
var builtinDriverSetupSpecLoaderHook*: BuiltinDriverSetupSpecLoaderHook
var compiledDriverSetupLoadCounter = 0

const COMPILED_DRIVER_PLUGIN_SYMBOL = "getCompiledDriverPlugin"
const NIM_PLUGIN_MAIN_SYMBOL = "NimMain"

type
  NimPluginMain = proc() {.cdecl.}

proc shQuote(value: string): string =
  "'" & value.replace("'", "'\"'\"'") & "'"

proc runCommand(command: string): tuple[output: string, exitCode: int] =
  if not setupExecHook.isNil:
    return setupExecHook(command)
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
  inc compiledDriverSetupLoadCounter
  let targetPath = getTempDir() / (
    "frameos-setup-" & $compiledDriverSetupLoadCounter & "-" & extractFilename(sourcePath)
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

proc initializeNimPluginRuntime(handle: LibHandle) =
  let nimMain = cast[NimPluginMain](symAddr(handle, NIM_PLUGIN_MAIN_SYMBOL))
  if nimMain.isNil:
    return
  nimMain()

proc loadDriverSetupSpec(
  path: string,
  frameConfig: FrameConfig,
): tuple[id: string, spec: DriverSetupSpec] =
  var copiedPath = ""
  try:
    copiedPath = copyCompiledDriverLibrary(path)
    let handle = loadLib(copiedPath)
    if handle.isNil:
      raise newException(IOError, "Failed to load compiled driver plugin: " & path)
    initializeNimPluginRuntime(handle)

    let factory = cast[CompiledDriverPluginFactory](symAddr(handle, COMPILED_DRIVER_PLUGIN_SYMBOL))
    if factory.isNil:
      raise newException(IOError, "Missing compiled driver plugin symbol in: " & path)

    let plugin = factory()
    if plugin.isNil or plugin.driver.isNil:
      raise newException(IOError, "Compiled driver plugin returned no driver: " & path)
    if plugin.abiVersion != COMPILED_PLUGIN_ABI_VERSION:
      raise newException(
        IOError,
        "Compiled driver plugin ABI mismatch in " & path & ": expected " & $COMPILED_PLUGIN_ABI_VERSION & ", got " & $plugin.abiVersion,
      )

    result.id =
      if plugin.id.len > 0:
        plugin.id
      else:
        extractFilename(path)
    if plugin.driver.setup.isNil:
      return
    result.spec = plugin.driver.setup(frameConfig)
  except CatchableError as e:
    raise newException(IOError, "Failed to load setup spec from " & path & ": " & e.msg)
  finally:
    removeCopiedCompiledDriverLibrary(copiedPath)

proc defaultCompiledDriversDir*(): string =
  parentDir(getAppFilename()) / "drivers"

proc loadDriverSetupSpecs(
  frameConfig: FrameConfig,
  driversDir: string,
): seq[tuple[id: string, spec: DriverSetupSpec]] =
  if not driverSetupSpecLoaderHook.isNil:
    return driverSetupSpecLoaderHook(frameConfig, driversDir)

  if not dirExists(driversDir):
    return @[]

  var driverPaths: seq[string] = @[]
  for path in walkFiles(driversDir / "*.so"):
    driverPaths.add(path)
  driverPaths.sort(system.cmp[string])

  for path in driverPaths:
    let loaded = loadDriverSetupSpec(path, frameConfig)
    if loaded.spec.isNil:
      continue
    result.add(loaded)

proc loadBuiltinDriverSetupSpecs(
  frameConfig: FrameConfig,
): seq[tuple[id: string, spec: DriverSetupSpec]] =
  if not builtinDriverSetupSpecLoaderHook.isNil:
    return builtinDriverSetupSpecLoaderHook(frameConfig)

  try:
    return compiledDrivers.builtinDriverSetupSpecs(frameConfig)
  except CatchableError as e:
    raise newException(IOError, "Failed to load built-in driver setup specs: " & e.msg)

proc mergeSpiMode(plan: var SetupPlan, nextMode: DriverSetupSpiMode, driverId: string) =
  case nextMode
  of dsmUnchanged:
    discard
  of dsmEnable:
    if plan.spiMode == dsmDisable:
      raise newException(ValueError, "Conflicting SPI setup requirements for driver: " & driverId)
    plan.spiMode = dsmEnable
  of dsmDisable:
    if plan.spiMode == dsmEnable:
      raise newException(ValueError, "Conflicting SPI setup requirements for driver: " & driverId)
    plan.spiMode = dsmDisable

proc mergeDriverSetupSpec(plan: var SetupPlan, driverId: string, spec: DriverSetupSpec) =
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

proc buildSetupPlan*(
  frameConfig: FrameConfig,
  driversDir = "",
): SetupPlan =
  result.device =
    if frameConfig.isNil:
      ""
    else:
      frameConfig.device
  result.spiMode = dsmUnchanged

  let resolvedDriversDir =
    if driversDir.len > 0:
      driversDir
    else:
      defaultCompiledDriversDir()

  for loaded in loadDriverSetupSpecs(frameConfig, resolvedDriversDir):
    result.mergeDriverSetupSpec(loaded.id, loaded.spec)
  for loaded in loadBuiltinDriverSetupSpecs(frameConfig):
    result.mergeDriverSetupSpec(loaded.id, loaded.spec)

proc bootConfigRequired(plan: SetupPlan): bool =
  plan.enableI2c or
    plan.spiMode != dsmUnchanged or
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

proc ensureBootConfigLine(path: string, line: string, result: var SetupResult) =
  var lines = readBootConfigLines(path)
  for existing in lines:
    if existing.strip() == line:
      return

  lines.add(line)
  writeBootConfigLines(path, lines)
  result.actions.add("Added boot config line: " & line)
  result.rebootRequired = true

proc removeBootConfigLine(path: string, line: string, result: var SetupResult) =
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

proc ensureRaspiConfigState(feature: string, enable: bool, result: var SetupResult) =
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

proc ensureAptPackageInstalled(packageName: string, result: var SetupResult) =
  if runCommand("dpkg -s " & shQuote(packageName) & " >/dev/null 2>&1").exitCode == 0:
    return

  let installCommand = "apt-get install -y " & shQuote(packageName)
  if runCommand(installCommand).exitCode != 0:
    discard runChecked("apt-get update && " & installCommand)
  result.actions.add("Installed apt package: " & packageName)

proc ensurePythonVendorRuntime(
  vendorRoot: string,
  vendorFolder: string,
  result: var SetupResult,
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

proc applySetupPlan*(
  plan: SetupPlan,
  bootConfigPath = "",
  vendorRoot = "/srv/frameos/vendor",
): SetupResult =
  result = SetupResult(
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
      plan.spiMode == dsmEnable and "dtparam=spi=on" notin plan.removeBootConfigLines
    if shouldEnsureSpiBootLine:
      ensureBootConfigLine(result.bootConfigPath, "dtparam=spi=on", result)

    if plan.spiMode == dsmEnable:
      ensureRaspiConfigState("spi", true, result)
    elif plan.spiMode == dsmDisable:
      removeBootConfigLine(result.bootConfigPath, "dtparam=spi=on", result)
      ensureRaspiConfigState("spi", false, result)

    for line in plan.ensureBootConfigLines:
      ensureBootConfigLine(result.bootConfigPath, line, result)

    for line in plan.removeBootConfigLines:
      removeBootConfigLine(result.bootConfigPath, line, result)

proc setupResultJson*(setupResult: SetupResult): JsonNode =
  %*{
    "device": setupResult.device,
    "drivers": setupResult.drivers,
    "bootConfigPath": setupResult.bootConfigPath,
    "actions": setupResult.actions,
    "rebootRequired": setupResult.rebootRequired,
  }

proc setupCurrentFrameOS*(
  configPath = "",
  bootConfigPath = "",
  vendorRoot = "/srv/frameos/vendor",
  driversDir = "",
): SetupResult =
  let hadConfigEnv = existsEnv("FRAMEOS_CONFIG")
  let previousConfig = if hadConfigEnv: getEnv("FRAMEOS_CONFIG") else: ""

  if configPath.len > 0:
    putEnv("FRAMEOS_CONFIG", configPath)

  try:
    let frameConfig = loadConfig()
    let plan = buildSetupPlan(frameConfig, driversDir = driversDir)
    applySetupPlan(plan, bootConfigPath = bootConfigPath, vendorRoot = vendorRoot)
  finally:
    if configPath.len > 0:
      if hadConfigEnv:
        putEnv("FRAMEOS_CONFIG", previousConfig)
      else:
        delEnv("FRAMEOS_CONFIG")

proc setupUsage*(): string =
  "Usage: frameos setup [--config PATH] [--json]"

proc runSetupCommand*(args: seq[string]) =
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
      echo setupUsage()
      return
    else:
      raise newException(ValueError, "Unknown setup option: " & args[index])
    inc index

  when not defined(windows):
    if geteuid() != 0:
      raise newException(IOError, "frameos setup must be run as root")

  let result = setupCurrentFrameOS(configPath = configPath)
  if jsonOutput:
    echo setupResultJson(result).pretty()
    return

  echo "FrameOS setup: " & (if result.device.len > 0: result.device else: "no device configured")
  if result.drivers.len > 0:
    echo "Drivers: " & result.drivers.join(", ")
  if result.actions.len == 0:
    echo "No setup changes required."
  else:
    for action in result.actions:
      echo "- " & action
  echo "Reboot required: " & (if result.rebootRequired: "yes" else: "no")
