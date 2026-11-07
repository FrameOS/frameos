## Per-phase timers of one render, for a device's log line.
##
## Where a frame's time goes on an ESP32 was known from one session's probe
## that never landed in the tree (docs/realtime-rendering.md "Measuring"):
## every number in docs/perf-todo.md descends from it. This is that probe,
## kept: the JS `get()`, the JSX walk, the UI layout, its emit, pixie's parse
## of the nodes, the damage, the raster, each accumulated over a render while
## `probeOn` is set (the frame's `debug` setting on the ESP32: `set debug 1`),
## and printed on the render line (embedded_main.nim). Off, each probe is one
## boolean test; the clock is read only when it is on.

import std/[monotimes, times, strutils]

type RenderPhase* = enum
  phRuntime = "runtime" ## a QuickJS runtime and context made (a cold start)
  phPrelude = "prelude" ## the prelude evaluated into it (bytecode or source)
  phCompile = "compile" ## the app's module compiled and run
  phApp = "app"        ## a JS app node's get, all of it (the phases below inside it)
  phInit = "init"      ## the runtime's init and readiness checks before get()
  phDraw = "draw"      ## the UI's way into the target: parse, damage, raster and what is around them
  phRegions = "regions" ## the UI's pointer regions kept for the next event
  phGet = "get"        ## the app's get() in QuickJS
  phWalk = "walk"      ## the JSX tree read into nodes (js_runtime/jsx.nim)
  phLayout = "layout"  ## ui/layout.nim: build and layout
  phBuild = "build"    ## of which the build: classes read, text arranged
  phText = "text"      ## of which text set in type (arrange, typeset)
  phEmit = "emit"      ## ui/layout.nim: the nodes that draw the UI
  phParse = "parse"    ## pixie's parse of the nodes (utils/svg_frames.nim)
  phDamage = "damage"  ## the boxes that changed
  phRaster = "raster"  ## pixie's render into the panel

var probeOn* = false

var
  accNs: array[RenderPhase, int64]
  counts: array[RenderPhase, int]

proc probeReset*() =
  for phase in RenderPhase:
    accNs[phase] = 0
    counts[phase] = 0

proc probeAdd*(phase: RenderPhase, ns: int64) {.inline.} =
  accNs[phase] += ns
  inc counts[phase]

template probe*(phase: RenderPhase, body: untyped) =
  ## `body`, timed into `phase` when the probe is on.
  if probeOn:
    let probeStart = getMonoTime()
    body
    probeAdd(phase, (getMonoTime() - probeStart).inNanoseconds)
  else:
    body

proc probeSummary*(): string =
  ## "get 15.2 walk 3.1 layout 12.0 ..." in ms, the phases that ran; "" when
  ## none did (or the probe is off).
  var parts: seq[string]
  for phase in RenderPhase:
    if counts[phase] > 0:
      parts.add($phase & " " & formatFloat(accNs[phase].float / 1_000_000, ffDecimal, 1))
  parts.join(" ")

proc probeNs*(phase: RenderPhase): int64 =
  ## What `phase` took this render, in nanoseconds (a host benchmark's unit).
  accNs[phase]
