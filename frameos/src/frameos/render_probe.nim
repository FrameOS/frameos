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
from pixie/fontformats/filefont import fileFontPageReads, fileFontReadNs, fileFontOpens, fileFontClears

type RenderPhase* = enum
  phRuntime = "runtime" ## a QuickJS runtime and context made (a cold start)
  phPrelude = "prelude" ## the prelude evaluated into it (bytecode or source)
  phCompile = "compile" ## the app's module compiled and run
  phScene = "scene"    ## the interpreter's render of the scene, all of it
  phSettle = "settle"  ## after it: the dispatch drain and the interpreters settled
  phPersist = "persist" ## the scene's state saved when it changed
  phNative = "native"  ## the scene program's natives (interpreter.programOp) but an app's get:
                       ## fields, state, image hints, flows; with `scene` less `app` it says
                       ## whether a pass's own cost is the program's JS or the Nim it calls
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
  phFit = "fit"        ## the automatic fit of a drawn image into the panel's range (utils/asset_colors)

var cardAtStart: (int, int64, int, int)
  ## Fonts read from the card so far (filefont.nim): pages, their time, opens, clears.
var probeOn* = false
var
  inputNs*: int64 ## events dispatched since the last render line (single_scene_host.send)
  inputCount*: int

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

proc probeBegin*(): (int, int, int, int) =
  ## A render's probe begins: everything zeroed, pixie's path probe on with
  ## it; the coverage and glyph caches' hit and miss counts so far, for
  ## probeLine.
  probeReset()
  pathProbeOn = probeOn
  for kind in PathProbeKind:
    pathProbeNs[kind] = 0
    pathProbeCount[kind] = 0
  for reason in CacheSkip:
    cacheSkips[reason] = 0
  cardAtStart = (fileFontPageReads, fileFontReadNs, fileFontOpens, fileFontClears)
  (coverageCacheHits, coverageCacheMisses, glyphCacheHits, glyphCacheMisses)

proc probeLine*(cacheAtStart: (int, int, int, int)): string =
  ## The render line's bracket: the phases, then pixie's coverage cache this
  ## render (hits/misses, what it holds) and its glyph cache's, the fills and
  ## strokes by kind, and why fills skipped the cache. "" with the probe off.
  result = probeSummary()
  if not probeOn:
    return
  result.add " cache " & $(coverageCacheHits - cacheAtStart[0]) & "/" &
    $(coverageCacheMisses - cacheAtStart[1]) & " " & $(coverageCacheUsedBytes() div 1024) & "K" &
    " glyphs " & $(glyphCacheHits - cacheAtStart[2]) & "/" & $(glyphCacheMisses - cacheAtStart[3]) &
    " " & $(glyphCacheUsedBytes() div 1024) & "K |"
  let pages = fileFontPageReads - cardAtStart[0]
  if pages > 0 or fileFontClears > cardAtStart[3]:
    # Fonts read where they lie on the card (docs/esp32-fonts.md): pages
    # read and what they took, files opened, page caches let go.
    result.add " card " & $pages & "p" & ms1(fileFontReadNs - cardAtStart[1]) &
      " " & $(fileFontOpens - cardAtStart[2]) & "o " & $(fileFontClears - cardAtStart[3]) & "c |"
  for kind in PathProbeKind:
    if pathProbeCount[kind] > 0:
      result.add " " & $kind & " " & $pathProbeCount[kind] & "x" & ms1(pathProbeNs[kind])
  result.add " | skip"
  for reason in CacheSkip:
    if cacheSkips[reason] > 0:
      result.add " " & $reason & " " & $cacheSkips[reason]
  if inputCount > 0:
    # What the events since the last line took to dispatch, handlers
    # included: a tap's pointerDown, pointerUp and its handler come before
    # the render it asks for.
    result.add " | input " & ms1(inputNs) & "/" & $inputCount
    inputNs = 0
    inputCount = 0

var
  quietNs: array[RenderPhase, int64]
  quietPathNs: array[PathProbeKind, int64]
  quietFrames: int

proc probeKeepQuiet*() =
  ## A frame whose line nobody writes (an animation's quiet frames: nine
  ## seconds in ten): its phases join the average the next written line
  ## carries. The written frame builds its log lines, so its own split says
  ## little about the frames between (the SenseCAP Indicator's DVD Logo
  ## Bounce: 51 ms written, 39 quiet, 2026-11-18).
  if not probeOn:
    return
  for phase in RenderPhase:
    quietNs[phase] += accNs[phase]
  for kind in PathProbeKind:
    quietPathNs[kind] += pathProbeNs[kind]
  inc quietFrames

proc probeQuietLine*(): string =
  ## " | quiet 290: scene 37.9 native 1.2 ..." in ms a frame, the average of
  ## the quiet frames since the last line; "" when there were none.
  if quietFrames == 0:
    return
  result = " | quiet " & $quietFrames & ":"
  for phase in RenderPhase:
    if quietNs[phase] > 0:
      result.add " " & $phase & " " & ms1(quietNs[phase] div quietFrames)
    quietNs[phase] = 0
  for kind in PathProbeKind:
    if quietPathNs[kind] > 0:
      result.add " " & $kind & " " & ms1(quietPathNs[kind] div quietFrames)
    quietPathNs[kind] = 0
  quietFrames = 0

proc probeNs*(phase: RenderPhase): int64 =
  ## What `phase` took this render, in nanoseconds (a host benchmark's unit).
  accNs[phase]
