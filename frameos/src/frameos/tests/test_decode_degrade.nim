# The decode-budget plan check must never surface as an error frame when a
# degraded decode would fit: decodeIntoTargetWithDegrade retries a refused
# into-target decode at reduced resolution and upscales. These tests drive
# the ladder with a scripted decode proc so the mechanics are pinned without
# depending on a real decoder's plan arithmetic.
import std/[strutils, unittest]
import pixie
import ../utils/image

proc budgetRefusal(): ref PixieError =
  newException(PixieError,
    "JPEG decode of 2048x3072 needs 1869K of decode buffers, over the " &
    "1807K memory budget")

suite "decodeIntoTargetWithDegrade":
  test "a decode that fits runs once, straight into the target":
    let target = newImage(120, 160)
    var calls: seq[(int, int)] = @[]
    let got = decodeIntoTargetWithDegrade(target, fitCover,
      proc(dst: Image) =
        calls.add((dst.width, dst.height))
        dst.fill(rgbx(10, 20, 30, 255)))
    check got == target
    check calls == @[(120, 160)]
    check target[0, 0] == rgbx(10, 20, 30, 255)

  test "a budget refusal retries at half resolution and upscales":
    let target = newImage(120, 160)
    var calls: seq[(int, int)] = @[]
    let got = decodeIntoTargetWithDegrade(target, fitCover,
      proc(dst: Image) =
        calls.add((dst.width, dst.height))
        if dst.width == target.width:
          raise budgetRefusal()
        dst.fill(rgbx(200, 100, 50, 255)))
    check got == target
    check calls == @[(120, 160), (60, 80)]
    # The degraded decode's pixels were stretched over the full target.
    check target[0, 0] == rgbx(200, 100, 50, 255)
    check target[119, 159] == rgbx(200, 100, 50, 255)

  test "keeps halving while the plan still refuses":
    let target = newImage(120, 160)
    var calls: seq[(int, int)] = @[]
    discard decodeIntoTargetWithDegrade(target, fitCover,
      proc(dst: Image) =
        calls.add((dst.width, dst.height))
        if dst.width > 30:
          raise budgetRefusal()
        dst.fill(rgbx(1, 2, 3, 255)))
    check calls == @[(120, 160), (60, 80), (30, 40)]
    check target[64, 64] == rgbx(1, 2, 3, 255)

  test "re-raises the original refusal when every rung is refused":
    let target = newImage(120, 160)
    var calls = 0
    expect PixieError:
      discard decodeIntoTargetWithDegrade(target, fitCover,
        proc(dst: Image) =
          inc calls
          raise budgetRefusal())
    check calls == 3

  test "non-budget errors pass through without any retry":
    let target = newImage(120, 160)
    var calls = 0
    try:
      discard decodeIntoTargetWithDegrade(target, fitCover,
        proc(dst: Image) =
          inc calls
          raise newException(PixieError, "progressive JPEGs cannot stream"))
      check false
    except PixieError as e:
      check "progressive" in e.msg
    check calls == 1
