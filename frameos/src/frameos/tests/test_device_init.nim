import std/[os, strutils, times, unittest]

import ../device_init
import ../types

proc tempPath(prefix: string): string =
  getTempDir() / (prefix & "-" & $epochTime().int64)

proc nonEmptyLines(path: string): seq[string] =
  for line in readFile(path).splitLines():
    if line.len == 0:
      continue
    result.add(line)

suite "device init":
  teardown:
    initExecHook = nil
    driverInitSpecLoaderHook = nil

  test "buildInitPlan merges driver-provided init specs":
    driverInitSpecLoaderHook = proc(
      frameConfig: FrameConfig,
      driversDir: string,
    ): seq[tuple[id: string, spec: DriverInitSpec]] {.nimcall.} =
      check frameConfig.device == "pimoroni.inky_impression_13"
      check driversDir == "/tmp/frameos-drivers"
      @[
        (
          "inkyPython",
          DriverInitSpec(
            ensureBootConfigLines: @["dtoverlay=spi0-0cs"],
            ensureAptPackages: @["python3-pip", "python3-venv"],
            pythonVendorFolders: @["inkyPython"],
            spiMode: dismEnable,
            enableI2c: true,
          ),
        ),
        (
          "gpioButton",
          DriverInitSpec(
            ensureBootConfigLines: @["dtoverlay=spi0-0cs"],
            spiMode: dismUnchanged,
          ),
        ),
      ]

    let plan = buildInitPlan(
      FrameConfig(
        device: "pimoroni.inky_impression_13",
        gpioButtons: @[],
      ),
      driversDir = "/tmp/frameos-drivers",
    )

    check plan.drivers == @["inkyPython", "gpioButton"]
    check plan.spiMode == dismEnable
    check plan.enableI2c
    check plan.ensureBootConfigLines == @["dtoverlay=spi0-0cs"]
    check plan.ensureAptPackages == @["python3-pip", "python3-venv"]
    check plan.pythonVendorFolders == @["inkyPython"]

  test "buildInitPlan rejects conflicting driver SPI requirements":
    driverInitSpecLoaderHook = proc(
      frameConfig: FrameConfig,
      driversDir: string,
    ): seq[tuple[id: string, spec: DriverInitSpec]] {.nimcall.} =
      @[
        ("driverA", DriverInitSpec(spiMode: dismEnable)),
        ("driverB", DriverInitSpec(spiMode: dismDisable)),
      ]

    expect ValueError:
      discard buildInitPlan(FrameConfig(device: "test-device"))

  test "applyInitPlan updates boot config and raspi-config state":
    let bootConfigPath = tempPath("frameos-init-config")
    defer:
      if fileExists(bootConfigPath):
        removeFile(bootConfigPath)

    writeFile(bootConfigPath, "# boot\n")

    var commands: seq[string] = @[]
    initExecHook = proc(command: string): tuple[output: string, exitCode: int] {.nimcall.} =
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

    let result = applyInitPlan(
      InitPlan(
        device: "test-device",
        drivers: @["inkyPython"],
        ensureBootConfigLines: @["dtoverlay=spi0-0cs"],
        spiMode: dismEnable,
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

  test "applyInitPlan prepares python vendor runtime when required":
    let vendorRoot = tempPath("frameos-init-vendor")
    let vendorPath = vendorRoot / "inkyHyperPixel2r"
    createDir(vendorRoot)
    createDir(vendorPath)
    defer:
      if dirExists(vendorRoot):
        removeDir(vendorRoot)

    writeFile(vendorPath / "requirements.txt", "rpi-gpio==0.7.1\n")

    var commands: seq[string] = @[]
    initExecHook = proc(command: string): tuple[output: string, exitCode: int] {.nimcall.} =
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

    let result = applyInitPlan(
      InitPlan(
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
