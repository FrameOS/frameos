import std/[os, strutils, times, unittest]
import ../frameBuffer

proc withBootConfig(path: string, body: proc()) =
  let previous = getEnv("FRAMEOS_BOOT_CONFIG")
  putEnv("FRAMEOS_BOOT_CONFIG", path)
  try:
    body()
  finally:
    if previous.len > 0:
      putEnv("FRAMEOS_BOOT_CONFIG", previous)
    else:
      delEnv("FRAMEOS_BOOT_CONFIG")
    if fileExists(path):
      removeFile(path)

suite "frameBuffer setup":
  test "a Pi's config.txt gains hdmi_blanking=1, so display off cuts the signal (#661)":
    let path = getTempDir() / ("frameos-test-fb-boot-config-" & $epochTime().int64 & ".txt")
    writeFile(path, "gpu_mem=32\n")
    withBootConfig(path, proc() =
      check frameBuffer.setup(nil).rebootRequired
      check readFile(path).startsWith("gpu_mem=32\n")
      check "hdmi_blanking=1" in readFile(path).splitLines()
      check not frameBuffer.setup(nil).rebootRequired
    )

  test "a host without config.txt is not given one":
    let path = getTempDir() / ("frameos-test-fb-no-boot-config-" & $epochTime().int64 & ".txt")
    withBootConfig(path, proc() =
      check not frameBuffer.setup(nil).rebootRequired
      check not fileExists(path)
    )
