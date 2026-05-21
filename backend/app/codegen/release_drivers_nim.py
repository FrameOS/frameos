from __future__ import annotations

import re
from dataclasses import replace
from pathlib import Path

from app.codegen.drivers_nim import (
    compiled_drivers,
    driver_context_helpers_nim,
    driver_library_filename,
    write_driver_library_nim,
)
from app.drivers.drivers import DRIVERS, Driver
from app.drivers.waveshare import get_variant_keys, write_waveshare_driver_nim


BASE_RELEASE_DRIVER_KEYS = (
    "frameBuffer",
    "evdev",
    "gpioButton",
    "httpUpload",
    "inkyHyperPixel2r",
    "inkyPython",
)

WAVESHARE_DRIVER_IMPORT = "import drivers/waveshare/driver as waveshareDriver"


def safe_nim_identifier(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_")
    if not safe:
        return "driver"
    if safe[0].isdigit():
        return f"driver_{safe}"
    return safe


def release_waveshare_driver_name(variant: str) -> str:
    return f"waveshare_{safe_nim_identifier(variant)}"


def release_driver_specs() -> dict[str, Driver]:
    """Return every compiled driver that can be shipped as a release artifact."""

    drivers: dict[str, Driver] = {}
    for key in BASE_RELEASE_DRIVER_KEYS:
        driver = replace(DRIVERS[key])
        if key == "inkyPython":
            # The same shared library must serve every Pimoroni Inky device.
            # Export PNG support so models with preview-capable palettes work.
            driver.can_png = True
        drivers[driver.name] = driver

    for variant in sorted(get_variant_keys()):
        driver = replace(DRIVERS["waveshare"])
        driver.name = release_waveshare_driver_name(variant)
        driver.variant = variant
        driver.import_path = f"waveshare/{driver.name}"
        driver.setup_import_path = driver.import_path
        drivers[driver.name] = driver

    return drivers


def write_release_shared_drivers_nim(drivers: dict[str, Driver]) -> str:
    specs: list[str] = []
    for driver in compiled_drivers(drivers):
        specs.append(
            "DriverSpec("
            f'name: "{driver.name}", '
            f'libraryName: "{driver_library_filename(driver)}", '
            f"canSetup: {str(bool(driver.setup_import_path)).lower()}, "
            f"canRender: {str(driver.can_render).lower()}, "
            f"canPng: {str(driver.can_png).lower()}, "
            f"canTurnOnOff: {str(driver.can_turn_on_off).lower()}"
            ")"
        )

    newline = "\n"
    spec_lines = ("," + newline + "  ").join(specs)
    if spec_lines:
        spec_lines = newline + "  " + spec_lines + newline

    return f"""
import std/[dynlib, json, options, os, strutils]
import pixie
import frameos/types
import frameos/driver_context as driverContext
import frameos/device_setup
import frameos/channels as hostChannels
import frameos/driver_abi

type
  DriverSpec = object
    name: string
    libraryName: string
    canSetup: bool
    canRender: bool
    canPng: bool
    canTurnOnOff: bool

  LoadedDriver = object
    spec: DriverSpec
    library: LibHandle
    instance: pointer
    render: DriverRenderProc
    toPng: DriverToPngProc
    turnOn: DriverActionProc
    turnOff: DriverActionProc

let availableDriverSpecs: seq[DriverSpec] = @[{spec_lines}]

var loadedDrivers: seq[LoadedDriver] = @[]
var setupLibraries: seq[LibHandle] = @[]
{driver_context_helpers_nim()}

proc hostLog(event: JsonNode) {{.cdecl, gcsafe.}} =
  hostChannels.log(event)

proc hostSendEvent(scene: Option[SceneId], event: string, payload: JsonNode) {{.cdecl, gcsafe.}} =
  hostChannels.sendEvent(scene, event, payload)

proc isInkyButtonDevice(device: string): bool =
  device in [
    "pimoroni.inky_impression",
    "pimoroni.inky_impression_7",
    "pimoroni.inky_impression_13",
  ]

proc isInkyDriverDevice(device: string): bool =
  isInkyButtonDevice(device) or device in [
    "pimoroni.inky_python",
  ]

proc evdevEnabledDevice(device: string): bool =
  not isInkyButtonDevice(device) and not device.startsWith("waveshare.") and device != "http.upload" and device != "web_only"

proc normalizedWaveshareVariant(device: string): string =
  const prefix = "waveshare."
  if not device.startsWith(prefix) or device.len <= prefix.len:
    return ""
  result = device[prefix.len .. ^1]
  # Backwards-compatible device names used by older generated configs.
  if result == "epd7in5_V2":
    result = "EPD_7in5_V2"
  elif result == "epd2in13_V3":
    result = "EPD_2in13_V3"

proc shouldLoadDriver(spec: DriverSpec, frameOS: FrameOS): bool =
  let device = frameOS.frameConfig.device
  if spec.name.startsWith("waveshare_"):
    return spec.name == ("waveshare_" & normalizedWaveshareVariant(device))
  case spec.name
  of "frameBuffer":
    return device == "framebuffer"
  of "evdev":
    return evdevEnabledDevice(device)
  of "gpioButton":
    return isInkyButtonDevice(device) or frameOS.frameConfig.gpioButtons.len > 0
  of "httpUpload":
    return device == "http.upload"
  of "inkyHyperPixel2r":
    return device == "pimoroni.hyperpixel2r"
  of "inkyPython":
    return isInkyDriverDevice(device)
  else:
    return false

proc driverSpecsFor(frameOS: FrameOS): seq[DriverSpec] =
  for spec in availableDriverSpecs:
    if shouldLoadDriver(spec, frameOS):
      result.add(spec)

proc driverLibraryPath(spec: DriverSpec): string =
  getAppDir() / "drivers" / spec.libraryName

proc loadRequiredSymbol[T](library: LibHandle, driverName: string, symbol: string): T =
  let address = symAddr(library, symbol)
  if address.isNil:
    hostChannels.log(%*{{"event": "driver:shared:error", "driver": driverName,
        "error": "Missing symbol", "symbol": symbol}})
    return nil
  cast[T](address)

proc setupSharedDriver(spec: DriverSpec, driverCtx: driverContext.DriverContext): SetupResult =
  let path = driverLibraryPath(spec)
  echo "FrameOS setup: shared driver " & spec.name & ": loading " & path
  let library = loadLib(path)
  if library.isNil:
    echo "FrameOS setup: shared driver " & spec.name & ": failed to load " & path
    raise newException(OSError, "Unable to load driver library: " & path)
  let setupProc = loadRequiredSymbol[DriverSetupProc](library, spec.name, "frameos_driver_setup")
  if setupProc.isNil:
    raise newException(OSError, "Missing setup symbol for driver: " & spec.name)
  echo "FrameOS setup: shared driver " & spec.name & ": running setup"
  result.rebootRequired = setupProc(cast[pointer](driverCtx))
  setupLibraries.add(library)
  echo "FrameOS setup: shared driver " & spec.name & ": setup complete"

proc setupSharedDrivers(frameOS: FrameOS): SetupResult =
  let driverCtx = buildDriverContext(frameOS)
  let specs = driverSpecsFor(frameOS)
  echo "FrameOS setup: shared driver registry: selected " & $specs.len & " driver(s)"
  for spec in specs:
    if spec.canSetup:
      let setupSpec = spec
      addSetupResult(result, runSetupStep(setupSpec.name, proc(): SetupResult = setupSharedDriver(setupSpec, driverCtx)))
      syncDriverContext(frameOS, driverCtx)

proc setupDriverNames*(): seq[string] =
  result = @[]

proc setup*(frameOS: FrameOS): SetupResult =
  addSetupResult(result, setupSharedDrivers(frameOS))

proc init*(frameOS: FrameOS) =
  loadedDrivers = @[]
  let driverCtx = buildDriverContext(frameOS)
  for spec in driverSpecsFor(frameOS):
    let path = driverLibraryPath(spec)
    let library = loadLib(path)
    if library.isNil:
      hostChannels.log(%*{{"event": "driver:shared:error", "driver": spec.name,
          "error": "Unable to load driver library", "path": path}})
      continue

    let initProc = loadRequiredSymbol[DriverInitProc](library, spec.name, "frameos_driver_init")
    if initProc.isNil:
      unloadLib(library)
      continue

    var loaded = LoadedDriver(
      spec: spec,
      library: library,
      instance: initProc(cast[pointer](driverCtx), hostLog, hostSendEvent),
    )
    if spec.canRender:
      loaded.render = loadRequiredSymbol[DriverRenderProc](library, spec.name, "frameos_driver_render")
    if spec.canPng:
      loaded.toPng = loadRequiredSymbol[DriverToPngProc](library, spec.name, "frameos_driver_to_png")
    if spec.canTurnOnOff:
      loaded.turnOn = loadRequiredSymbol[DriverActionProc](library, spec.name, "frameos_driver_turn_on")
      loaded.turnOff = loadRequiredSymbol[DriverActionProc](library, spec.name, "frameos_driver_turn_off")
    loadedDrivers.add(loaded)
    syncDriverContext(frameOS, driverCtx)
    hostChannels.log(%*{{"event": "driver:shared", "driver": spec.name, "path": path, "loaded": true}})

proc render*(image: Image) =
  for driver in loadedDrivers:
    if driver.spec.canRender and not driver.render.isNil:
      driver.render(driver.instance, cast[pointer](image))

proc toPng*(rotate: int, flip: string): string =
  for driver in loadedDrivers:
    if driver.spec.canPng and not driver.toPng.isNil:
      var length = 0
      let data = driver.toPng(driver.instance, rotate.cint, flip.cstring, addr length)
      if data.isNil or length <= 0:
        return ""
      result = newString(length)
      copyMem(addr result[0], data, length)
      return
  result = ""

proc turnOn*() =
  for driver in loadedDrivers:
    if driver.spec.canTurnOnOff and not driver.turnOn.isNil:
      driver.turnOn(driver.instance)

proc turnOff*() =
  for driver in loadedDrivers:
    if driver.spec.canTurnOnOff and not driver.turnOff.isNil:
      driver.turnOff(driver.instance)
"""


def write_release_waveshare_driver_modules(frameos_root: Path, drivers: dict[str, Driver]) -> None:
    """Generate per-variant Waveshare modules used by release driver libraries."""

    waveshare_root = frameos_root / "src" / "drivers" / "waveshare"
    base_waveshare = waveshare_root / "waveshare.nim"
    base_source = base_waveshare.read_text(encoding="utf-8")
    if WAVESHARE_DRIVER_IMPORT not in base_source:
        raise RuntimeError(f"Unable to locate Waveshare driver import in {base_waveshare}")

    for driver in compiled_drivers(drivers):
        if not driver.name.startswith("waveshare_") or not driver.variant:
            continue
        variant_driver = replace(DRIVERS["waveshare"])
        variant_driver.variant = driver.variant
        variant_module = f"driver_{safe_nim_identifier(driver.variant)}"
        (waveshare_root / f"{variant_module}.nim").write_text(
            write_waveshare_driver_nim({"waveshare": variant_driver}),
            encoding="utf-8",
        )
        wrapper_source = base_source.replace(
            WAVESHARE_DRIVER_IMPORT,
            f"import drivers/waveshare/{variant_module} as waveshareDriver",
        )
        (waveshare_root / f"{driver.name}.nim").write_text(wrapper_source, encoding="utf-8")


def write_release_driver_libraries(frameos_root: Path, drivers: dict[str, Driver]) -> None:
    shared_dir = frameos_root / "src" / "drivers" / "shared"
    shared_dir.mkdir(parents=True, exist_ok=True)
    for driver in compiled_drivers(drivers):
        (shared_dir / f"{driver.name}.nim").write_text(
            write_driver_library_nim(driver),
            encoding="utf-8",
        )
