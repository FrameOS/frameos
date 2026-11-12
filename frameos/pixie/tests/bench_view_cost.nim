## Raster hot paths, timed identically before and after the image-view change.
##
## The view lets a sub-region borrow its parent's pixels instead of copying
## them, which costs an indirection on the way to every pixel. This exists so
## that cost is a number rather than a hope — run it on the same machine before
## and after, and on the ESP32 where an in-order core feels it most.
##
##   nim c -r -d:release --path:src tests/bench_view_cost.nim
import std/[monotimes, strformat, times]
import pixie

proc bench(name: string, iterations: int, body: proc ()) =
  body() # warm up
  var best = float.high
  for _ in 0 ..< 5:
    let start = getMonoTime()
    for _ in 0 ..< iterations:
      body()
    let elapsed = (getMonoTime() - start).inNanoseconds.float / 1e6
    if elapsed < best:
      best = elapsed
  echo &"{name:<34}{best / iterations.float:>10.3f} ms"

const W = 800
const H = 480

let canvas = newImage(W, H)
let sprite = newImage(W div 2, H div 2)
sprite.fill(rgba(200, 40, 90, 200))

bench("fill", 200, proc () =
  canvas.fill(rgba(63, 127, 191, 255))
)

bench("draw opaque over canvas", 200, proc () =
  canvas.draw(sprite, translate(vec2(10, 10)), OverwriteBlend)
)

bench("draw alpha over canvas", 200, proc () =
  canvas.draw(sprite, translate(vec2(10, 10)), NormalBlend)
)

bench("draw scaled 2x", 100, proc () =
  canvas.draw(sprite, translate(vec2(0, 0)) * scale(vec2(2, 2)), NormalBlend)
)

bench("per-pixel read+write", 20, proc () =
  for y in 0 ..< H:
    for x in 0 ..< W:
      let c = canvas.unsafe[x, y]
      canvas.unsafe[x, y] = rgbx(c.g, c.b, c.r, c.a)
)

let path = newPath()
path.roundedRect(40, 40, W.float32 - 80, H.float32 - 80, 24, 24, 24, 24)
bench("fillPath rounded rect", 100, proc () =
  canvas.fillPath(path, rgba(20, 160, 120, 255))
)

bench("subImage copy (quarter)", 200, proc () =
  discard canvas.subImage(0, 0, W div 2, H div 2)
)

bench("newImage quarter", 200, proc () =
  discard newImage(W div 2, H div 2)
)

# The reason any of this exists: handing a caller a sub-region used to mean
# allocating and copying it. Only meaningful on the view build.
when compiles(canvas.view(0, 0, 1, 1)):
  bench("view (quarter)", 200, proc () =
    discard canvas.view(0, 0, W div 2, H div 2)
  )

  let cell = canvas.view(0, 0, W div 2, H div 2)
  bench("fill through a view", 200, proc () =
    cell.fill(rgba(10, 20, 30, 255))
  )

  bench("draw alpha into a view", 200, proc () =
    cell.draw(sprite, translate(vec2(0, 0)), NormalBlend)
  )
