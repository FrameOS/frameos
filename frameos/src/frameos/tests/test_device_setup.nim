import std/[os, strutils, times, unittest]

import ../device_setup
import ../types

proc tempPath(prefix: string): string =
  getTempDir() / (prefix & "-" & $epochTime().int64)

proc nonEmptyLines(path: string): seq[string] =
  for line in readFile(path).splitLines():
    if line.len == 0:
      continue
    result.add(line)

suite "device setup":
  teardown:
    setupExecHook = nil
    driverSetupSpecLoaderHook = nil
    builtinDriverSetupSpecLoaderHook = nil

  test "buildSetupPlan merges driver-provided setup specs":
    driverSetupSpecLoaderHook = proc(
      frameConfig: FrameConfig,
      driversDir: string,
    ): seq[tuple[id: string, spec: DriverSetupSpec]] {.nimcall.} =
      check frameConfig.device == "pimoroni.inky_impression_13"
      check driversDir == "/tmp/frameos-drivers"
      @[
        (
          "inkyPython",
          DriverSetupSpec(
            ensureBootConfigLines: @["dtoverlay=spi0-0cs"],
            ensureAptPackages: @["python3-pip", "python3-venv"],
            pythonVendorFolders: @["inkyPython"],
            spiMode: dsmEnable,
            enableI2c: true,
          ),
        ),
        (
          "gpioButton",
          DriverSetupSpec(
            ensureBootConfigLines: @["dtoverlay=spi0-0cs"],
            spiMode: dsmUnchanged,
          ),
        ),
      ]

    let plan = buildSetupPlan(
      FrameConfig(
        device: "pimoroni.inky_impression_13",
        gpioButtons: @[],
      ),
      driversDir = "/tmp/frameos-drivers",
    )

    check plan.drivers == @["inkyPython", "gpioButton"]
    check plan.spiMode == dsmEnable
    check plan.enableI2c
    check plan.ensureBootConfigLines == @["dtoverlay=spi0-0cs"]
    check plan.ensureAptPackages == @["python3-pip", "python3-venv"]
    check plan.pythonVendorFolders == @["inkyPython"]

  test "buildSetupPlan merges built-in driver setup specs":
    builtinDriverSetupSpecLoaderHook = proc(
      frameConfig: FrameConfig,
    ): seq[tuple[id: string, spec: DriverSetupSpec]] {.nimcall.} =
      check frameConfig.device == "pimoroni.hyperpixel2r"
      @[
        (
          "inkyHyperPixel2r",
          DriverSetupSpec(
            ensureAptPackages: @["python3-pip"],
            pythonVendorFolders: @["inkyHyperPixel2r"],
          ),
        ),
      ]

    let plan = buildSetupPlan(
      FrameConfig(
        device: "pimoroni.hyperpixel2r",
        gpioButtons: @[],
      ),
    )

    check plan.drivers == @["inkyHyperPixel2r"]
    check plan.ensureAptPackages == @["python3-pip"]
    check plan.pythonVendorFolders == @["inkyHyperPixel2r"]

  test "buildSetupPlan rejects conflicting driver SPI requirements":
    driverSetupSpecLoaderHook = proc(
      frameConfig: FrameConfig,
      driversDir: string,
    ): seq[tuple[id: string, spec: DriverSetupSpec]] {.nimcall.} =
      @[
        ("driverA", DriverSetupSpec(spiMode: dsmEnable)),
        ("driverB", DriverSetupSpec(spiMode: dsmDisable)),
      ]

    expect ValueError:
      discard buildSetupPlan(FrameConfig(device: "test-device"))

  test "applySetupPlan updates boot config and raspi-config state":
    let bootConfigPath = tempPath("frameos-setup-config")
    defer:
      if fileExists(bootConfigPath):
        removeFile(bootConfigPath)

    writeFile(bootConfigPath, "# boot\n")

    var commands: seq[string] = @[]
    setupExecHook = proc(command: string): tuple[output: string, exitCode: int] {.nimcall.} =
      commands.add(command)
      case command
      of "command -v raspi-config >/dev/null 2>&1":
        ("", 0)
      of "raspi-config nonint get_i2c":
        ("1\n", 0)
      of "raspi-config nonint do_i2c 0":
        ("", 0)
      of "raspi-config nonint get_spi":
        ("1\n", 0)
      of "raspi-config nonint do_spi 0":
        ("", 0)
      else:
        ("", 0)

    let result = applySetupPlan(
      SetupPlan(
        device: "test-device",
        drivers: @["inkyPython"],
        ensureBootConfigLines: @["dtoverlay=spi0-0cs"],
        spiMode: dsmEnable,
        enableI2c: true,
      ),
      bootConfigPath = bootConfigPath,
    )

    check result.bootConfigPath == bootConfigPath
    check result.rebootRequired
    check nonEmptyLines(bootConfigPath) == @[
      "# boot",
      "dtparam=i2c_vc=on",
      "dtparam=spi=on",
      "dtoverlay=spi0-0cs",
    ]
    check commands == @[
      "command -v raspi-config >/dev/null 2>&1",
      "raspi-config nonint get_i2c",
      "raspi-config nonint do_i2c 0",
      "command -v raspi-config >/dev/null 2>&1",
      "raspi-config nonint get_spi",
      "raspi-config nonint do_spi 0",
    ]

  test "applySetupPlan prepares python vendor runtime when required":
    let vendorRoot = tempPath("frameos-setup-vendor")
    let vendorPath = vendorRoot / "inkyHyperPixel2r"
    createDir(vendorRoot)
    createDir(vendorPath)
    defer:
      if dirExists(vendorRoot):
        removeDir(vendorRoot)

    writeFile(vendorPath / "requirements.txt", "rpi-gpio==0.7.1\n")

    var commands: seq[string] = @[]
    setupExecHook = proc(command: string): tuple[output: string, exitCode: int] {.nimcall.} =
      commands.add(command)
      case command
      of "dpkg -s 'python3-dev' >/dev/null 2>&1":
        ("", 1)
      of "dpkg -s 'python3-pip' >/dev/null 2>&1":
        ("", 1)
      of "dpkg -s 'python3-venv' >/dev/null 2>&1":
        ("", 0)
      else:
        ("", 0)

    let result = applySetupPlan(
      SetupPlan(
        device: "pimoroni.hyperpixel2r",
        drivers: @["inkyHyperPixel2r"],
        ensureAptPackages: @["python3-dev", "python3-pip", "python3-venv"],
        pythonVendorFolders: @["inkyHyperPixel2r"],
      ),
      vendorRoot = vendorRoot,
    )

    check not result.rebootRequired
    check commands[0 .. 3] == @[
      "dpkg -s 'python3-dev' >/dev/null 2>&1",
      "apt-get install -y 'python3-dev'",
      "dpkg -s 'python3-pip' >/dev/null 2>&1",
      "apt-get install -y 'python3-pip'",
    ]
    check commands[4] == "dpkg -s 'python3-venv' >/dev/null 2>&1"
    check commands[5].startsWith("cd '" & vendorPath)
    check result.actions == @[
      "Installed apt package: python3-dev",
      "Installed apt package: python3-pip",
      "Verified Python runtime for driver: inkyHyperPixel2r",
    ]
