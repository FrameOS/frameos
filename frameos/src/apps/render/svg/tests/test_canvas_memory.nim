import std/[json, options, strutils]
import pixie

import ../app
import frameos/types
import frameos/utils/memory

# The E1004 (8 MB PSRAM, 1200x1600) aborted out of memory on a clock scene
# whose code node fed this app a full-canvas SVG (2026-10-20): the app
# rasterized it into a second 1200x1600 image — 7.7 MB with 2.5 MB free —
# before drawing it. It now paints the canvas it is given, so the heap grows
# by the paint strips pixie sizes to the budget, never by a canvas.
#
# Its own binary: getMaxMem is the process's peak, and an earlier test's
# bigger allocation would hide this one's.

const Width = 1200
const Height = 1600

proc clockSvg(): string =
  result = """<svg viewBox="0 0 1200 1600" width="1200" height="1600">
    <defs>
      <linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="1600">
        <stop offset="0" stop-color="#efe7d7"/><stop offset="1" stop-color="#d9c7ad"/>
      </linearGradient>
      <radialGradient id="face" gradientUnits="userSpaceOnUse" cx="600" cy="800" r="640">
        <stop offset="0" stop-color="#fffaf0"/><stop offset="1" stop-color="#eadcc5"/>
      </radialGradient>
    </defs>
    <rect width="1200" height="1600" fill="url(#bg)"/>
    <rect x="48" y="248" width="1104" height="1104" rx="77" fill="url(#face)" stroke="#6d5238" stroke-width="12"/>
    <circle cx="600" cy="800" r="510" fill="none" stroke="#8c704c" stroke-width="5"/>"""
  for i in 0 ..< 12:
    result.add("<line x1=\"600\" y1=\"300\" x2=\"600\" y2=\"340\" stroke=\"#55402b\" stroke-width=\"10\" " &
      "transform=\"rotate(" & $(i * 30) & " 600 800)\"/>")
  result.add("""<text x="600" y="1100" text-anchor="middle" font-size="40" fill="#44301f">Tuesday, 20 Oct</text>
  </svg>""")

let errors = new seq[string]
let config = FrameConfig(width: Width, height: Height, rotate: 0)
let svgApp = App(
  frameConfig: config,
  scene: FrameScene(
    frameConfig: config,
    logger: Logger(log: proc(payload: JsonNode) =
      if payload{"event"}.getStr().contains("error") or payload.hasKey("error"):
        errors[].add($payload))
  ),
  appConfig: AppConfig(inputImage: none(Image), svg: clockSvg(), placement: "stretch",
    offsetX: 0, offsetY: 0, blendMode: "normal")
)

# What the E1004 had free when it aborted, give or take.
availableRenderBytesOverride = 2 * 1024 * 1024
let context = ExecutionContext(image: newImage(Width, Height), hasImage: true)
let canvasBytes = Width * Height * 4
let before = getMaxMem()
svgApp.run(context)
let grown = getMaxMem() - before
availableRenderBytesOverride = 0

doAssert errors[].len == 0, "render/svg logged: " & errors[].join("; ")
# The background gradient reached the canvas: its bottom row is the end stop.
let corner = context.image[5, Height - 3]
doAssert abs(corner.r.int - 0xd9) <= 3 and abs(corner.b.int - 0xad) <= 3, "bottom-left is " & $corner
doAssert grown < canvasBytes div 2,
  "drawing a " & $Width & "x" & $Height & " SVG grew the heap by " & $grown &
  " bytes; the canvas is " & $canvasBytes

echo "test_canvas_memory: heap grew ", grown, " bytes for a ", canvasBytes, "-byte canvas"
