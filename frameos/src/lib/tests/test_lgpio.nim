import std/unittest

when defined(linux) and defined(frameosRunNativeLgpioTests):
  import lib/lgpio

  suite "native lgpio compatibility subset":
    test "exports the pinned upstream version constant":
      check lguVersion() == LGPIO_VERSION
      check LGPIO_VERSION == 0x00020200

    test "returns lgpio-compatible error strings":
      check $lguErrorText(LG_OKAY) == "no error"
      check $lguErrorText(LG_BAD_HANDLE) == "unknown handle"
      check $lguErrorText(LG_CANNOT_OPEN_CHIP) == "can not open gpiochip"
      check $lguErrorText(-9999) == "unknown error"

    test "validates handles before touching devices":
      check lgGpiochipClose(-1) == LG_BAD_HANDLE
      check lgGpioClaimInput(-1, 0, 1) == LG_BAD_HANDLE
      check lgGpioClaimOutput(-1, 0, 1, LG_LOW) == LG_BAD_HANDLE
      check lgGpioRead(-1, 1) == LG_BAD_HANDLE
      check lgGpioWrite(-1, 1, LG_HIGH) == LG_BAD_HANDLE
      check lgGpioSetDebounce(-1, 1, 1000) == LG_BAD_HANDLE
      check lgGpioSetAlertsFunc(-1, 1, nil, nil) == LG_BAD_HANDLE
      check lgSpiClose(-1) == LG_BAD_HANDLE

    test "validates arguments without hardware":
      check lgGpiochipOpen(-1) == LG_BAD_GPIOCHIP
      check lgGpioSetDebounce(-1, 1, LG_MAX_MICS_DEBOUNCE + 1) == LG_BAD_DEBOUNCE_MICS
      check lgSpiRead(-1, nil, 0) == LG_BAD_SPI_COUNT
      check lgSpiWrite(-1, nil, LG_MAX_SPI_DEVICE_COUNT + 1) == LG_BAD_SPI_COUNT
else:
  suite "native lgpio compatibility subset":
    test "native Linux GPIO/SPI runtime checks are opt-in":
      check true
