import std/[os, sequtils, strutils, times]
import ../device_setup
import ../../drivers/inkyPython/inkyPython as inkyPythonDriver
import ../../drivers/noSpi/noSpi as noSpiDriver
import ../../drivers/spi/spi as spiDriver

block test_boot_config_adds_and_removes_lines:
  let applied = applyBootConfigLines(
    "dtparam=spi=on\nkeep=1\n",
    @["dtoverlay=spi0-0cs", "#dtparam=spi=on"],
  )
  doAssert applied.changed
  doAssert applied.content.contains("keep=1\n")
  doAssert applied.content.contains("dtoverlay=spi0-0cs\n")
  doAssert not applied.content.contains("dtparam=spi=on")

block test_boot_config_is_idempotent:
  let applied = applyBootConfigLines("dtoverlay=spi0-0cs\n", @["dtoverlay=spi0-0cs"])
  doAssert not applied.changed
  doAssert applied.content == "dtoverlay=spi0-0cs\n"

block test_setup_boot_config_writes_local_file:
  let path = getTempDir() / ("frameos-test-boot-config-" & $epochTime().int64 & ".txt")
  writeFile(path, "existing=1\n")
  try:
    let setupResult = setupBootConfig(@["dtoverlay=spi0-0cs"], path)
    let content = readFile(path)
    doAssert setupResult.rebootRequired
    doAssert content.contains("existing=1\n")
    doAssert content.contains("dtoverlay=spi0-0cs\n")
  finally:
    if fileExists(path):
      removeFile(path)

block test_setup_spi_enables_when_raspi_config_reports_disabled:
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    if command.contains("command -v"):
      return ("", 0)
    if command.contains("get_spi"):
      return ("", 0)
    return ("", 0)
  )
  try:
    let setupResult = spiDriver.setup()
    doAssert setupResult.rebootRequired
    doAssert commands.anyIt(it.contains("raspi-config nonint get_spi"))
    doAssert commands.anyIt(it.contains("raspi-config nonint do_spi 0"))
  finally:
    resetSetupCommandRunnerForTest()

block test_setup_nospi_disables_when_raspi_config_reports_enabled:
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    if command.contains("command -v"):
      return ("", 0)
    if command.contains("get_spi"):
      return ("", 0)
    return ("", 0)
  )
  try:
    let setupResult = noSpiDriver.setup()
    doAssert setupResult.rebootRequired
    doAssert commands.anyIt(it.contains("raspi-config nonint get_spi"))
    doAssert commands.anyIt(it.contains("raspi-config nonint do_spi 1"))
  finally:
    resetSetupCommandRunnerForTest()

block test_setup_spi_uses_boot_config_fallback_when_raspi_config_missing:
  let path = getTempDir() / ("frameos-test-spi-boot-config-" & $epochTime().int64 & ".txt")
  let previousBootConfig = getEnv("FRAMEOS_BOOT_CONFIG")
  putEnv("FRAMEOS_BOOT_CONFIG", path)
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    if command.contains("command -v"):
      return ("", 1)
    return ("", 0)
  )
  try:
    let setupResult = spiDriver.setup()
    let content = if fileExists(path): readFile(path) else: ""
    doAssert setupResult.rebootRequired
    doAssert content.contains("dtparam=spi=on\n")
    doAssert commands.anyIt(it.contains("command -v"))
    doAssert not commands.anyIt(it.contains("raspi-config nonint do_spi"))
  finally:
    resetSetupCommandRunnerForTest()
    if previousBootConfig.len > 0:
      putEnv("FRAMEOS_BOOT_CONFIG", previousBootConfig)
    else:
      delEnv("FRAMEOS_BOOT_CONFIG")
    if fileExists(path):
      removeFile(path)

block test_setup_nospi_uses_boot_config_fallback_when_raspi_config_missing:
  let path = getTempDir() / ("frameos-test-nospi-boot-config-" & $epochTime().int64 & ".txt")
  let previousBootConfig = getEnv("FRAMEOS_BOOT_CONFIG")
  putEnv("FRAMEOS_BOOT_CONFIG", path)
  writeFile(path, "dtparam=spi=on\nkeep=1\n")
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    if command.contains("command -v"):
      return ("", 1)
    return ("", 0)
  )
  try:
    let setupResult = noSpiDriver.setup()
    let content = readFile(path)
    doAssert setupResult.rebootRequired
    doAssert not content.contains("dtparam=spi=on")
    doAssert content.contains("keep=1\n")
    doAssert commands.anyIt(it.contains("command -v"))
    doAssert not commands.anyIt(it.contains("raspi-config nonint do_spi"))
  finally:
    resetSetupCommandRunnerForTest()
    if previousBootConfig.len > 0:
      putEnv("FRAMEOS_BOOT_CONFIG", previousBootConfig)
    else:
      delEnv("FRAMEOS_BOOT_CONFIG")
    if fileExists(path):
      removeFile(path)

block test_setup_inky_python_vendor_driver:
  var commands: seq[string] = @[]
  setSetupCommandRunnerForTest(proc(command: string): SetupCommandResult =
    commands.add(command)
    return ("", 0)
  )
  try:
    let setupResult = inkyPythonDriver.setup()
    doAssert not setupResult.rebootRequired
    doAssert commands.len == 1
    doAssert commands[0].contains("cd '/srv/frameos/vendor/inkyPython'")
    doAssert commands[0].contains("python3 -m venv env")
    doAssert commands[0].contains("env/bin/pip3 install -r requirements.txt")
    doAssert commands[0].contains("requirements unchanged; reusing env")
  finally:
    resetSetupCommandRunnerForTest()
