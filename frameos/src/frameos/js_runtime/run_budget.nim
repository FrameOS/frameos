## The budgets one scene run (a render or an event) spends against, shared by
## every host that drives the interpreter — the Pi runner, the ESP32 firmware
## and the browser preview — because they all arrive at interpreter.runEvent.
##
## Two ceilings live here; the third (the per-scene JS heap) is in burrito.nim
## next to the allocator that enforces it.
##
## * The wall-clock render deadline. The interpreter-time budget in
##   burrito.nim deliberately stops its clock while a Nim binding runs, so an
##   honest 30 s fetch is not mistaken for a runaway loop. The flip side was a
##   scene that never finished: `httpRequest` against a tarpit could hold the
##   render thread for its full 600 s ceiling, node after node, until the
##   900 s systemd watchdog shot the service (docs/security-todo.md). This
##   deadline counts everything — script, bindings, HTTP — and is read from
##   three places: the QuickJS interrupt handler (trips the script), the HTTP
##   client (caps every request's timeout to what is left), and the binding
##   wrapper (marks the trip as soon as a slow call returns).
## * The per-run dispatch budget. A dispatch node fires an event; an event
##   whose handler dispatches again is an unbounded chain — on the Pi it
##   floods the event queue and starves rendering, on the ESP32 it recurses
##   on the render task's stack. Past the budget a run's dispatches are
##   dropped, once with a log line naming the budget.
##
## Thread-local on purpose: the runner renders on its own thread and the
## budgets belong to the run in progress there; the embedded and wasm hosts
## have one task. Re-entrant: a nested run (a child scene's init event) rides
## on the outer run's budgets and does not re-arm them.

import std/monotimes
import std/times

const
  DefaultRenderDeadlineMs* = when defined(frameosEmbedded):
      90_000       # a few 30 s fetches; well under anything the firmware's own watchdogs allow to pile up
    elif defined(frameosWasm):
      60_000
    else:
      120_000      # under the 900 s systemd WatchdogSec with room for the driver's refresh
  DefaultDispatchBudget* = 64

var
  renderDeadlineArmed {.threadvar.}: bool
  renderDeadlineAt {.threadvar.}: MonoTime
  renderDeadlineBudget {.threadvar.}: int
  dispatchBudgetRemaining {.threadvar.}: int
  dispatchBudgetTotal {.threadvar.}: int
  dispatchBudgetExhaustedLogged {.threadvar.}: bool

proc armRenderDeadline*(budgetMs: int): bool =
  ## Start the wall clock for this run. Returns true when this call armed it
  ## (so the matching disarm belongs to this caller); false when a run is
  ## already in progress on this thread or the budget disables the ceiling.
  if renderDeadlineArmed or budgetMs <= 0:
    return false
  renderDeadlineArmed = true
  renderDeadlineBudget = budgetMs
  renderDeadlineAt = getMonoTime() + initDuration(milliseconds = budgetMs)
  true

proc disarmRenderDeadline*() =
  renderDeadlineArmed = false

proc renderDeadlineArmedNow*(): bool = renderDeadlineArmed

proc renderDeadlineBudgetMs*(): int =
  if renderDeadlineArmed: renderDeadlineBudget else: 0

proc renderDeadlinePassed*(): bool =
  ## Safe to call from the QuickJS interrupt handler: no allocation, no raise.
  renderDeadlineArmed and getMonoTime() >= renderDeadlineAt

proc renderDeadlineRemainingMs*(): int =
  ## -1 when no deadline is armed; 0 once it has passed; otherwise what is left.
  if not renderDeadlineArmed:
    return -1
  let remaining = (renderDeadlineAt - getMonoTime()).inMilliseconds
  if remaining <= 0: 0 else: int(remaining)

proc capToRenderDeadline*(timeoutMs: int): int =
  ## The timeout a blocking call may use: its own, or the remainder of the
  ## render deadline when that is shorter. Never below 1 ms so a call that
  ## starts right at the deadline fails fast instead of never.
  let remaining = renderDeadlineRemainingMs()
  if remaining < 0 or timeoutMs <= remaining:
    return timeoutMs
  max(1, remaining)

type
  DispatchVerdict* = enum
    dvAllowed        ## within budget
    dvRefusedFirst   ## the first dispatch over budget this run — log this one
    dvRefused        ## further dispatches over budget — drop silently

proc setDispatchBudget*(budget: int) =
  ## Called by whoever armed the render deadline; <= 0 leaves dispatch unbounded.
  dispatchBudgetTotal = budget
  dispatchBudgetRemaining = budget
  dispatchBudgetExhaustedLogged = false

proc dispatchBudgetTotalNow*(): int = dispatchBudgetTotal

proc takeDispatchBudget*(): DispatchVerdict =
  if dispatchBudgetTotal <= 0:
    return dvAllowed
  if dispatchBudgetRemaining > 0:
    dec dispatchBudgetRemaining
    return dvAllowed
  if not dispatchBudgetExhaustedLogged:
    dispatchBudgetExhaustedLogged = true
    return dvRefusedFirst
  dvRefused
