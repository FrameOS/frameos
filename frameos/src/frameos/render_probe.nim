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
import pixie/paths

type RenderPhase* = enum
  phRuntime = "runtime" ## a QuickJS runtime and context made (a cold start)
  phPrelude = "prelude" ## the prelude evaluated into it (bytecode or source)
  phCompile = "compile" ## the app's module compiled and run
  phScene = "scene"    ## the interpreter's render of the scene, all of it
  phSettle = "settle"  ## after it: the dispatch drain and the interpreters settled
  phPersist = "persist" ## the scene's state saved when it changed
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
  ## `body`, timed into `phase` when the probe is on. The body is compiled
  ## once (in `if true`, which scopes it as a branch did): an if/else with it
  ## in both branches was every probed phase's code twice in the firmware.
  let probeStart = if probeOn: getMonoTime() else: MonoTime()
  if true:
    body
  if probeOn:
    probeAdd(phase, (getMonoTime() - probeStart).inNanoseconds)

proc ms1(ns: int64): string =
  ## Nanoseconds as milliseconds with a tenth: "15.2".
  let tenths = (ns + 50_000) div 100_000
  $(tenths div 10) & "." & $(tenths mod 10)

proc probeSummary*(): string =
  ## "get 15.2 walk 3.1 layout 12.0 ..." in ms, the phases that ran; "" when
  ## none did (or the probe is off).
  for phase in RenderPhase:
    if counts[phase] > 0:
      if result.len > 0: result.add ' '
      result.add $phase & " " & ms1(accNs[phase])

proc probeBegin*(): (int, int) =
  ## A render's probe begins: everything zeroed, pixie's path probe on with
  ## it; the coverage cache's hit and miss counts so far, for probeLine.
  probeReset()
  pathProbeOn = probeOn
  for kind in PathProbeKind:
    pathProbeNs[kind] = 0
    pathProbeCount[kind] = 0
  for reason in CacheSkip:
    cacheSkips[reason] = 0
  (coverageCacheHits, coverageCacheMisses)

proc probeLine*(cacheAtStart: (int, int)): string =
  ## The render line's bracket: the phases, then pixie's coverage cache this
  ## render (hits/misses, what it holds), the fills and strokes by kind, and
  ## why fills skipped the cache. "" with the probe off.
  result = probeSummary()
  if not probeOn:
    return
  result.add " cache " & $(coverageCacheHits - cacheAtStart[0]) & "/" &
    $(coverageCacheMisses - cacheAtStart[1]) & " " & $(coverageCacheUsedBytes() div 1024) & "K |"
  for kind in PathProbeKind:
    if pathProbeCount[kind] > 0:
      result.add " " & $kind & " " & $pathProbeCount[kind] & "x" & ms1(pathProbeNs[kind])
  result.add " | skip"
  for reason in CacheSkip:
    if cacheSkips[reason] > 0:
      result.add " " & $reason & " " & $cacheSkips[reason]

proc probeNs*(phase: RenderPhase): int64 =
  ## What `phase` took this render, in nanoseconds (a host benchmark's unit).
  accNs[phase]
