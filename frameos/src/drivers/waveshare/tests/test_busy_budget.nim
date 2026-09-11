## The per-render busy-wait budget in ePaper/DEV_Debug.c, on a fake clock
## (busy_budget_shim.c). Each busy wait is capped at 120 s; once a render
## arms the budget, all of its waits together stop at 300 s, so a wedged
## panel cannot hold the render thread past systemd's 900 s WatchdogSec.

import std/[os, strutils, unittest]

const fakeHalDir = currentSourcePath().parentDir / "fake_hal"
{.passC: "-I" & fakeHalDir.}
{.compile: "busy_budget_shim.c".}

type UDOUBLE = uint32

proc DEV_Busy_Wait(stage: cstring; busyLevel: cint; pollMs: UDOUBLE): cint {.importc, cdecl.}
proc DEV_Busy_Budget_Begin() {.importc, cdecl.}
proc DEV_Busy_Budget_End() {.importc, cdecl.}
proc DEV_Busy_Budget_Exhausted(): cint {.importc, cdecl.}
proc DEV_Busy_Timeout_Ms(): UDOUBLE {.importc, cdecl.}
proc fake_reset() {.importc, cdecl.}
proc fake_set_busy_forever(on: cint) {.importc, cdecl.}
proc fake_set_busy_for(ms: UDOUBLE) {.importc, cdecl.}
proc fake_now_ms(): UDOUBLE {.importc, cdecl.}
proc fake_last_error(): cstring {.importc, cdecl.}
proc fake_clear_error() {.importc, cdecl.}
proc fake_vendor_wait(): cint {.importc, cdecl.}

const
  WaitCapMs = 120_000'u32
  RenderBudgetMs = 300_000'u32

proc lastError(): string = $fake_last_error()

suite "waveshare busy-wait budget":
  setup:
    fake_reset()

  test "unarmed, each wait is capped at 120 s and there is no total":
    fake_set_busy_forever(1)
    check DEV_Busy_Wait("refresh", 1, 10) == -1
    check fake_now_ms() == WaitCapMs
    check "after 120000 ms" in lastError()
    check "budget" notin lastError()
    for _ in 1 .. 3:
      check DEV_Busy_Wait("refresh", 1, 10) == -1
    check fake_now_ms() == 4 * WaitCapMs

  test "armed, all waits of one render share 300 s":
    fake_set_busy_forever(1)
    DEV_Busy_Budget_Begin()
    check DEV_Busy_Wait("power on", 1, 10) == -1   # 120 s
    check DEV_Busy_Wait("refresh", 1, 10) == -1    # 240 s
    check DEV_Busy_Budget_Exhausted() == 0
    check DEV_Busy_Wait("power off", 1, 10) == -1  # stops at 300 s, 60 s into this wait
    check fake_now_ms() == RenderBudgetMs
    check DEV_Busy_Budget_Exhausted() == 1
    check "busy budget is spent" in lastError()
    check DEV_Busy_Wait("sleep", 1, 10) == -1      # no time left: fails at once
    check fake_now_ms() == RenderBudgetMs

  test "a healthy render is untouched by the budget":
    DEV_Busy_Budget_Begin()
    for _ in 1 .. 4:
      fake_set_busy_for(30_000)
      check DEV_Busy_Wait("refresh", 1, 10) == 1
    check lastError() == ""
    check DEV_Busy_Budget_Exhausted() == 0
    check DEV_Busy_Timeout_Ms() == WaitCapMs

  test "vendor wait loops see the budget through EPD_BUSY_TIMEOUT_MS":
    fake_set_busy_forever(1)
    DEV_Busy_Budget_Begin()
    check fake_vendor_wait() == -1
    check fake_now_ms() == WaitCapMs
    check "after 120000 ms (vendor driver)" in lastError()
    fake_clear_error()
    check fake_vendor_wait() == -1
    check fake_vendor_wait() == -1
    check fake_now_ms() == RenderBudgetMs
    check "busy budget is spent (vendor driver)" in lastError()
    check fake_vendor_wait() == -1
    check fake_now_ms() == RenderBudgetMs

  test "ending the render restores the per-wait cap":
    fake_set_busy_forever(1)
    DEV_Busy_Budget_Begin()
    for _ in 1 .. 3:
      discard DEV_Busy_Wait("refresh", 1, 10)
    check DEV_Busy_Timeout_Ms() == 0
    DEV_Busy_Budget_End()
    check DEV_Busy_Budget_Exhausted() == 0
    check DEV_Busy_Timeout_Ms() == WaitCapMs
    let before = fake_now_ms()
    check DEV_Busy_Wait("next render's clear", 1, 10) == -1
    check fake_now_ms() - before == WaitCapMs

  test "arming again starts a fresh budget":
    fake_set_busy_forever(1)
    DEV_Busy_Budget_Begin()
    for _ in 1 .. 3:
      discard DEV_Busy_Wait("refresh", 1, 10)
    check DEV_Busy_Budget_Exhausted() == 1
    DEV_Busy_Budget_Begin()
    check DEV_Busy_Budget_Exhausted() == 0
    let before = fake_now_ms()
    check DEV_Busy_Wait("refresh", 1, 10) == -1
    check fake_now_ms() - before == WaitCapMs
