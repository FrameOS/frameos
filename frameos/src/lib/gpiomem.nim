## The BCM283x/BCM2711 GPIO block through /dev/gpiomem (Pi 0-4; the Pi 5's
## GPIO sits behind RP1 with another layout and is never driven from here).
##
## For the one thing gpiolib cannot do: borrow a pin the kernel holds for
## something else. The HyperPixels bit-bang their panel init over pins that
## double as the touch controller's interrupt (4.0: GPIO 27) or its whole I2C
## bus (2.1" Round: GPIO 10/11). With the kernel's touch driver bound, a
## gpiolib claim on those lines is refused, so the init drives them straight
## through the registers — as Pimoroni's own init programs do — and hands
## them back as inputs the moment a burst ends. An input is also what an
## open-drain bus and an interrupt line idle as.

import posix
import std/volatile

const
  GpioMemPath = "/dev/gpiomem"
  GpioMemBytes = 4096
  # Word offsets into the block.
  GpFsel0 = 0
  GpSet0 = 7
  GpClr0 = 10

type GpioMem* = ptr UncheckedArray[uint32]

proc openGpioMem*(): GpioMem =
  ## nil when the device is missing or not ours to open; callers fall back to
  ## an ordinary gpiolib claim, which works wherever nothing else holds the pin.
  let fd = posix.open(GpioMemPath, O_RDWR or O_SYNC)
  if fd < 0:
    return nil
  let mapped = mmap(nil, GpioMemBytes, PROT_READ or PROT_WRITE, MAP_SHARED, fd, 0)
  discard posix.close(fd)
  if mapped == MAP_FAILED:
    return nil
  cast[GpioMem](mapped)

proc setOutput*(mem: GpioMem; pin: int; output: bool) =
  ## Function select: output, or back to input. Pins 0..53.
  let register = GpFsel0 + pin div 10
  let shift = uint32((pin mod 10) * 3)
  var value = volatileLoad(addr mem[register]) and not (7'u32 shl shift)
  if output:
    value = value or (1'u32 shl shift)
  volatileStore(addr mem[register], value)

proc write*(mem: GpioMem; pin: int; high: bool) =
  ## Pins 0..31, which covers the whole header.
  volatileStore(addr mem[if high: GpSet0 else: GpClr0], 1'u32 shl pin)
