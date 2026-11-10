## The reTerminal Sticky's SSD1677 driver (ePaper/EPD_3in97.c) on a fake bus
## and clock (epd_3in97_shim.c). A partial update starts its waveform and
## returns: the render task handles taps and draws the next frame meanwhile,
## instead of sitting out the controller's ~0.5 s after every update
## (2026-11-10). The controller takes no command while BUSY is high, so every
## entry point waits for an update still running before it talks to the panel.
## The fake records any byte sent, or reset pulled, while it is busy.

import std/[os, unittest]

const fakeHalDir = currentSourcePath().parentDir / "fake_hal"
{.passC: "-I" & fakeHalDir.}
{.compile: "../ePaper/DEV_Debug.c".}
{.compile: "../ePaper/EPD_3in97.c".}
{.compile: "epd_3in97_shim.c".}

type UDOUBLE = uint32

proc EPD_3in97_Init() {.importc, cdecl.}
proc EPD_3in97_Clear() {.importc, cdecl.}
proc EPD_3in97_Display(image: ptr uint8) {.importc, cdecl.}
proc EPD_3in97_Init_Partial() {.importc, cdecl.}
proc EPD_3in97_Display_Partial(image, previous: ptr uint8) {.importc, cdecl.}
proc EPD_3in97_Rest() {.importc, cdecl.}
proc EPD_3in97_Sleep() {.importc, cdecl.}

proc fake_reset() {.importc, cdecl.}
proc fake_now_ms(): UDOUBLE {.importc, cdecl.}
proc fake_advance_ms(ms: UDOUBLE) {.importc, cdecl.}
proc fake_busy(): cint {.importc, cdecl.}
proc fake_set_busy_for(ms: UDOUBLE) {.importc, cdecl.}
proc fake_violations(): cint {.importc, cdecl.}
proc fake_first_violation(): cstring {.importc, cdecl.}
proc fake_partial_activations(): cint {.importc, cdecl.}
proc fake_full_activations(): cint {.importc, cdecl.}
proc fake_last_error(): cstring {.importc, cdecl.}
proc fake_full_ms(): UDOUBLE {.importc, cdecl.}
proc fake_partial_ms(): UDOUBLE {.importc, cdecl.}

const PlaneBytes = 800 * 480 div 8

var
  image = newSeq[uint8](PlaneBytes)
  previous = newSeq[uint8](PlaneBytes)

proc show() = EPD_3in97_Display(addr image[0])
proc showPartial() = EPD_3in97_Display_Partial(addr image[0], addr previous[0])

proc violations(): string =
  if fake_violations() == 0: "" else: $fake_violations() & ": " & $fake_first_violation()

proc fromColdPartial() =
  ## A panel set up for partial updates, nothing owed: the clock and the
  ## counters start here.
  fake_reset()
  EPD_3in97_Init()
  EPD_3in97_Init_Partial()
  fake_reset()

suite "EPD_3in97: a partial update is waited for at the next use":
  test "a partial update starts its waveform and returns":
    fromColdPartial()
    showPartial()
    check fake_partial_activations() == 1
    check fake_now_ms() == 0              # nothing of the 500 ms waveform waited out
    check fake_busy() == 1                # still running on the glass
    check violations() == ""

  test "the next partial update waits for the one still running first":
    fromColdPartial()
    showPartial()
    showPartial()
    check fake_partial_activations() == 2
    check fake_now_ms() >= fake_partial_ms()
    check violations() == ""

  test "time spent elsewhere meanwhile is not waited again":
    fromColdPartial()
    showPartial()
    fake_advance_ms(fake_partial_ms() + 200)   # the render task drew the next frame
    let before = fake_now_ms()
    showPartial()
    check fake_now_ms() - before <= 20         # the busy check's own settle delay at most
    check violations() == ""

  test "rest and sleep wait for a running update before turning the supply off":
    fromColdPartial()
    showPartial()
    EPD_3in97_Rest()
    check fake_busy() == 0
    check violations() == ""
    showPartial()
    EPD_3in97_Sleep()
    check fake_busy() == 0
    check violations() == ""

  test "every entry point waits: nothing goes to a busy controller":
    fake_reset()
    EPD_3in97_Init()
    show()
    EPD_3in97_Init_Partial()
    for _ in 1 .. 3:
      showPartial()
    EPD_3in97_Rest()
    showPartial()
    EPD_3in97_Init()                # a full refresh straight after a partial one
    show()
    EPD_3in97_Init_Partial()
    showPartial()
    EPD_3in97_Clear()               # a clear straight after a partial one
    EPD_3in97_Init_Partial()
    showPartial()
    EPD_3in97_Init_Partial()        # a re-init straight after a partial one
    showPartial()
    showPartial()
    show()                          # a full picture straight after a partial one
    showPartial()
    EPD_3in97_Sleep()
    check violations() == ""
    check fake_full_activations() == 4
    check fake_partial_activations() == 9
    check $fake_last_error() == ""

  test "a full refresh still waits for its own waveform":
    fake_reset()
    EPD_3in97_Init()
    let before = fake_now_ms()
    show()
    check fake_full_activations() == 1
    check fake_busy() == 0
    check fake_now_ms() - before >= fake_full_ms()
    check violations() == ""

  test "the fake catches a byte sent to a busy controller":
    ## What the checks above stand on: BUSY high with no update the driver
    ## knows of, as when a wait is lost.
    fromColdPartial()
    fake_set_busy_for(100)
    showPartial()
    check fake_violations() > 0
