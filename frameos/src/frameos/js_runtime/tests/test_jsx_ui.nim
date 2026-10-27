import std/[json, strutils, unittest]
import pixie

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/values
import frameos/utils/font # the typeface resolver text uses

# JSX returned by a JS app: `<svg>` drawn without markup, and UI trees
# (`<div className="flex ...">`) laid out and drawn — docs/jsx-ui.md.

proc testConfig(w = 120, h = 80): FrameConfig =
  FrameConfig(width: w, height: h, rotate: 0, scalingMode: "cover", debug: true,
    saveAssets: %*false, assetsPath: "/tmp")

var logged: seq[JsonNode]

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logged.add payload
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false
  logger

proc render(source: string, w = 120, h = 80, cell: Image = nil): Image =
  let config = testConfig(w, h)
  let scene = FrameScene(id: "tests/jsx".SceneId, frameConfig: config, state: %*{},
    logger: testLogger(config))
  let owner = AppRoot(nodeId: 1.NodeId, nodeName: "jsx", scene: scene, frameConfig: config)
  let context = ExecutionContext(scene: scene, event: "render", payload: %*{},
    hasImage: false, loopIndex: 0, loopKey: ".", nextSleep: -1,
    decodeTargetImage: cell, decodeTargetNodeId: 1.NodeId)
  let runtime = newJsAppRuntime(category = "data", outputType = "image",
    source = source, sourceName = "app.tsx")
  let value = runtime.get(owner, %*{}, context)
  check value.kind == fkImage
  value.asImage()

proc same(a, b: Image): bool =
  if a.isNil or b.isNil or a.width != b.width or a.height != b.height:
    return false
  for y in 0 ..< a.height:
    for x in 0 ..< a.width:
      if a[x, y] != b[x, y]:
        return false
  true

const logo = """
const Mark = ({ fill }) => (
  <g fill={fill} fillRule="evenodd">
    <path d="M10 10C30 0 50 0 70 10L60 40H20Z" />
    <circle cx={40} cy={25} r={6} fill="none" stroke="#fff" strokeWidth={3} />
  </g>
)
"""

suite "jsx":
  test "an <svg> draws exactly what its markup draws":
    let markup = render("""
      export const get = () => frameos.svg('<svg width="120" height="80" viewBox="0 0 120 80">' +
        '<rect width="120" height="80" fill="#090b14"/>' +
        '<g transform="translate(12.5 8) scale(0.75)" opacity="0.32"><g fill="#000" fill-rule="evenodd">' +
        '<path d="M10 10C30 0 50 0 70 10L60 40H20Z"/><circle cx="40" cy="25" r="6" fill="none" stroke="#fff" stroke-width="3"/></g></g>' +
        '<g transform="translate(10 6) scale(0.75)"><g fill="#55dfff" fill-rule="evenodd">' +
        '<path d="M10 10C30 0 50 0 70 10L60 40H20Z"/><circle cx="40" cy="25" r="6" fill="none" stroke="#fff" stroke-width="3"/></g></g>' +
        '</svg>', { width: 120, height: 80 })
    """)
    let jsx = render(logo & """
      export const get = () => (
        <svg width={120} height={80} viewBox="0 0 120 80">
          <rect width={120} height={80} fill="#090b14" />
          <g transform={`translate(${12.5} 8) scale(0.75)`} opacity={0.32}><Mark fill="#000" /></g>
          <g transform="translate(10 6) scale(0.75)"><Mark fill="#55dfff" /></g>
        </svg>
      )
    """)
    check same(markup, jsx)

  test "an <svg> paints the offered cell itself":
    let cell = newImage(120, 80)
    let image = render("""
      export const get = () => <svg viewBox="0 0 12 8"><rect width={12} height={8} fill="#ff0000" /></svg>
    """, cell = cell)
    check image == cell
    check cell[60, 40] == rgbx(255, 0, 0, 255)

  test "a UI lays out and draws":
    let image = render("""
      const Swatch = ({ color }) => <div className={`w-8 h-8 rounded ${color}`} />
      export const get = () => (
        <div className="flex items-center justify-center gap-2 bg-slate-900">
          {['bg-red-500', 'bg-green-500', 'bg-blue-500'].map((c) => <Swatch color={c} />)}
          <></>
          {false}
          {null}
        </div>
      )
    """)
    check image[2, 2] == rgbx(0x0f, 0x17, 0x2a, 255)
    # three 32 px swatches with 8 px gaps, centered in 120: 4 .. 116
    check image[20, 40] == rgbx(0xef, 0x44, 0x44, 255)
    check image[60, 40] == rgbx(0x22, 0xc5, 0x5e, 255)
    check image[100, 40] == rgbx(0x3b, 0x82, 0xf6, 255)
    check image[40, 40] == rgbx(0x0f, 0x17, 0x2a, 255) # a gap

  test "text, with the values the app computed":
    let image = render("""
      export function get(app) {
        const n = 42
        return (
          <div className="bg-white text-black p-2">
            <div className="text-2xl font-bold">{n} items</div>
            <span className="text-red-600">and a note</span>
          </div>
        )
      }
    """, 200, 80)
    var dark, red = 0
    for y in 0 ..< 80:
      for x in 0 ..< 200:
        let p = image[x, y]
        if p.r < 80 and p.g < 80 and p.b < 80: inc dark
        if p.r > 180 and p.g < 80 and p.b < 80: inc red
    check dark > 100
    check red > 20

  test "a space next to a value is drawn, as in React":
    # quickts keeps white space that touches no line break (since quickts.2)
    proc inkRight(source: string): int =
      let image = render("""
        export function get(app) {
          const n = 42
          return <div className="bg-white text-black p-2">""" & source & """</div>
        }
      """, 200, 40)
      result = -1
      for x in countdown(image.width - 1, 0):
        for y in 0 ..< image.height:
          if image[x, y].r < 128:
            return x
    let spaced = inkRight("{n} items")
    checkpoint "ink ends at " & $spaced
    check abs(spaced - inkRight("{`${n} items`}")) <= 1
    check inkRight("{n}items") < spaced - 2

  test "an svg icon inside a UI takes the text colour":
    let image = render("""
      export const get = () => (
        <div className="flex bg-white text-blue-500">
          <svg className="w-10 h-10" viewBox="0 0 24 24"><rect width={24} height={24} fill="currentColor" /></svg>
        </div>
      )
    """)
    check image[20, 20] == rgbx(0x3b, 0x82, 0xf6, 255)
    check image[60, 20] == rgbx(255, 255, 255, 255)

  test "an <image> is still the plain canvas spec":
    let image = render("""export const get = () => <image width={4} height={2} color="#112233" />""")
    check image.width == 4
    check image[0, 0] == rgbx(0x11, 0x22, 0x33, 255)

  test "an element pixie does not draw is reported":
    logged.setLen(0)
    discard render("""export const get = () => <svg viewBox="0 0 4 4"><foreignObject /></svg>""")
    var reported = false
    for entry in logged:
      if ($entry).contains("Unsupported SVG tag: foreignObject"):
        reported = true
    check reported
