## The run's wall-clock deadline: arming, renewal by advancing native work,
## and the hard ceiling no renewal passes.

import std/[os, unittest]

import frameos/js_runtime/run_budget

suite "renderDeadline renewal":
  test "advancing work pushes the deadline out, within the hard ceiling":
    check armRenderDeadline(100, hardCeilingMs = 400)
    defer: disarmRenderDeadline()
    check renderDeadlineRemainingMs() <= 100
    check renewRenderDeadline(10_000)
    # Asked for ten seconds; the ceiling set at arming is what it got.
    check renderDeadlineRemainingMs() > 100
    check renderDeadlineRemainingMs() <= 400
    check renderDeadlineHardRemainingMs() <= 400

  test "a renewal never moves the deadline earlier":
    check armRenderDeadline(1_000, hardCeilingMs = 5_000)
    defer: disarmRenderDeadline()
    check renewRenderDeadline(10)
    check renderDeadlineRemainingMs() > 900

  test "a budget above the ceiling is its own ceiling":
    check armRenderDeadline(2_000, hardCeilingMs = 500)
    defer: disarmRenderDeadline()
    check renderDeadlineHardRemainingMs() > 1_500
    check renewRenderDeadline(10_000)
    check renderDeadlineRemainingMs() > 1_500

  test "a deadline that has passed is not brought back":
    check armRenderDeadline(1, hardCeilingMs = 10_000)
    defer: disarmRenderDeadline()
    sleep(5)
    check renderDeadlinePassed()
    check not renewRenderDeadline(10_000)
    check renderDeadlinePassed()

  test "nothing armed, nothing renewed":
    check not renewRenderDeadline(1_000)
    check renderDeadlineHardRemainingMs() == -1
