import frameos/types

proc addUnique*(values: var seq[string], value: string) =
  if value.len == 0 or value in values:
    return
  values.add(value)

proc addAllUnique*(values: var seq[string], extras: openArray[string]) =
  for value in extras:
    values.addUnique(value)

template assureAptPackages*(packages: untyped) =
  driverSetupSpecValue.ensureAptPackages.addAllUnique(packages)

template initPythonVendorFolder*(folder: string) =
  driverSetupSpecValue.pythonVendorFolders.addUnique(folder)

template ensureBootConfigLines*(lines: untyped) =
  driverSetupSpecValue.ensureBootConfigLines.addAllUnique(lines)

template removeBootConfigLines*(lines: untyped) =
  driverSetupSpecValue.removeBootConfigLines.addAllUnique(lines)

template enableSpi*() =
  driverSetupSpecValue.spiMode = dsmEnable

template disableSpi*() =
  driverSetupSpecValue.spiMode = dsmDisable

template enableI2c*() =
  driverSetupSpecValue.enableI2c = true

template driverSetupSpec*(body: untyped): DriverSetupSpec {.dirty.} =
  block:
    var driverSetupSpecValue {.inject.} = DriverSetupSpec(
      ensureBootConfigLines: @[],
      removeBootConfigLines: @[],
      ensureAptPackages: @[],
      pythonVendorFolders: @[],
      spiMode: dsmUnchanged,
    )
    body
    driverSetupSpecValue
