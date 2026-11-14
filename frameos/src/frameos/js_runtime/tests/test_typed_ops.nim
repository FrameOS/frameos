## `frameos.ops` (typed_ops.nim): whole typed arrays at a time, each element
## read and stored with JS's own conversions for its array's kind. Run through
## the JS app runtime, each case compared with what the same loop in JS gives.

import std/[json, unittest]

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/values

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) = discard
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

proc floats(node: JsonNode): seq[float] =
  for item in node: result.add item.getFloat()

proc run(source: string): JsonNode =
  ## The app's get() returns a JSON string of what it found.
  let config = FrameConfig(width: 10, height: 10, rotate: 0, scalingMode: "cover", saveAssets: %*false,
    assetsPath: "/tmp")
  let scene = FrameScene(id: "tests/typed-ops".SceneId, frameConfig: config, state: %*{}, logger: testLogger(config))
  let owner = AppRoot(nodeId: 1.NodeId, nodeName: "ops", scene: scene, frameConfig: config)
  let runtime = newJsAppRuntime(category = "data", outputType = "string", source = source, sourceName = "app.ts")
  let context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false, loopIndex: 0,
    loopKey: ".", nextSleep: -1)
  parseJson(runtime.get(owner, %*{}, context).asString())

suite "frameos.ops":
  test "map: a byte table over bytes, and any table into any array":
    let r = run("""
export function get() {
  const src = new Uint8Array([0, 1, 2, 3, 250])
  const fade = new Uint8Array(256); for (let i = 0; i < 256; i++) fade[i] = i > 1 ? i - 2 : 0
  const bytes = new Uint8Array(5); frameos.ops.map(bytes, src, fade)
  const short = new Uint8Array([7, 7, 7, 7, 7]); frameos.ops.map(short, src, new Uint8Array([9, 8]), 1, 4)
  const floats = new Float32Array(5); frameos.ops.map(floats, src, new Float32Array([0.5, 1.5, 2.5, 3.5]))
  const inPlace = new Uint8ClampedArray([10, 20, 30]); frameos.ops.map(inPlace, inPlace, fade)
  return JSON.stringify({ bytes: [...bytes], short: [...short], floats: [...floats], inPlace: [...inPlace] })
}
""")
    check r["bytes"] == %*[0, 0, 0, 1, 248]
    check r["short"] == %*[7, 8, 7, 7, 7] # 1..3 only; 2 and 3 are past the table
    check floats(r["floats"]) == @[0.5, 1.5, 2.5, 3.5, 0.0]
    check r["inPlace"] == %*[8, 18, 28]

  test "add, sub and mul store as the destination's kind does":
    let r = run("""
export function get() {
  const a = new Uint8ClampedArray([10, 200, 250]); frameos.ops.add(a, a, 10)
  const w = new Uint8Array([10, 200, 250]); frameos.ops.add(w, w, 10)
  const s = new Int16Array([5, -5, 32767]); frameos.ops.sub(s, s, new Int16Array([10, 10, -1]))
  const f = new Float32Array([1, 2, 3]); frameos.ops.mul(f, f, 0.5)
  const damped = new Int16Array([320, -320]); frameos.ops.mul(damped, damped, 0.96875)
  const x = new Float32Array([1, 2]); const vx = new Float32Array([0.25, -0.5]); frameos.ops.add(x, x, vx)
  return JSON.stringify({ a: [...a], w: [...w], s: [...s], f: [...f], damped: [...damped], x: [...x] })
}
""")
    check r["a"] == %*[20, 210, 255] # clamped
    check r["w"] == %*[20, 210, 4] # wraps
    check r["s"] == %*[-5, -15, -32768] # 32767 - -1 wraps
    check floats(r["f"]) == @[0.5, 1.0, 1.5]
    check r["damped"] == %*[310, -310]
    check floats(r["x"]) == @[1.25, 1.5]

  test "convolve: a 3x3 kernel over every cell but the edges, with a shift":
    let r = run("""
export function get() {
  const w = 4, h = 4
  const src = new Int16Array(w * h); src[5] = 16
  const blur = new Int16Array(w * h).fill(-1)
  frameos.ops.convolve(blur, src, w, [1, 2, 1, 2, 4, 2, 1, 2, 1], 4)
  const sum = new Int16Array(w * h)
  frameos.ops.convolve(sum, src, w, [0, 1, 0, 1, 0, 1, 0, 1, 0], 1)
  return JSON.stringify({ blur: [...blur], sum: [...sum] })
}
""")
    check r["blur"] == %*[-1, -1, -1, -1, -1, 4, 2, -1, -1, 2, 1, -1, -1, -1, -1, -1]
    check r["sum"][6].getInt() == 8 and r["sum"][9].getInt() == 8 and r["sum"][5].getInt() == 0

  test "a subarray's own elements, and what it cannot take refused":
    let r = run("""
export function get() {
  const big = new Uint8Array([1, 2, 3, 4, 5, 6])
  const part = big.subarray(2, 5)
  frameos.ops.add(part, part, 100)
  const wide = frameos.ops.add(new Float64Array(2), new Float64Array(2), 1)
  const past = frameos.ops.add(new Uint8Array(2), new Uint8Array(2), new Uint8Array(4), 0, 4)
  return JSON.stringify({ big: [...big], wide, past })
}
""")
    check r["big"] == %*[1, 2, 103, 104, 105, 6]
    check r["wide"].getBool() == false
    check r["past"].getBool() == false

  test "arguments that are not numbers are defaults, never a crash":
    let r = run("""
export function get() {
  const a = new Uint8Array([1, 2, 3])
  const added = frameos.ops.add(a, a, 1, NaN, Infinity)
  const noWidth = frameos.ops.convolve(new Int16Array(9), new Int16Array(9), undefined, [1, 1, 1, 1, 1, 1, 1, 1, 1])
  const odd = new Int16Array(9); odd[4] = 8
  const strange = frameos.ops.convolve(odd, odd, 3, [NaN, 'x', null, 0, 1e12, 0, 0, 0, 0], NaN)
  return JSON.stringify({ a: [...a], added, noWidth, strange, odd: [...odd] })
}
""")
    check r["a"] == %*[2, 3, 4] # NaN start is 0, an Infinity end the whole array
    check r["added"].getBool()
    check r["noWidth"].getBool() == false
    check r["strange"].getBool()
    check r["odd"][4].getInt() == 0 # 8 * 65536, the largest weight, wraps to 0 in an Int16
