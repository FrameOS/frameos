import chroma, pixie, vmath, xrays

const heartShape = """
    M 10,30
    A 20,20 0,0,1 50,30
    A 20,20 0,0,1 90,30
    Q 90,60 50,90
    Q 10,60 10,30 z
  """

block:
  let image = newImage(100, 100)
  image.fillPath(
    heartShape,
    rgba(255, 0, 0, 255)
  )
  image.xray("tests/paths/paintSolid.png")

block:
  let paint = newPaint(ImagePaint)
  paint.image = readImage("tests/fileformats/png/mandrill.png")
  paint.imageMat = scale(vec2(0.2, 0.2))

  let image = newImage(100, 100)
  image.fillPath(heartShape, paint)
  image.xray("tests/paths/paintImage.png")

block:
  let paint = newPaint(ImagePaint)
  paint.image = readImage("tests/fileformats/png/mandrill.png")
  paint.imageMat = scale(vec2(0.2, 0.2))
  paint.opacity = 0.5

  let image = newImage(100, 100)
  image.fillPath(heartShape, paint)
  image.xray("tests/paths/paintImageOpacity.png")

block:
  let paint = newPaint(TiledImagePaint)
  paint.image = readImage("tests/fileformats/png/mandrill.png")
  paint.imageMat = scale(vec2(0.02, 0.02))

  let image = newImage(100, 100)
  image.fillPath(heartShape, paint)
  image.xray("tests/paths/paintImageTiled.png")

block:
  let paint = newPaint(TiledImagePaint)
  paint.image = readImage("tests/fileformats/png/mandrill.png")
  paint.imageMat = scale(vec2(0.02, 0.02))
  paint.opacity = 0.5

  let image = newImage(100, 100)
  image.fillPath(heartShape, paint)
  image.xray("tests/paths/paintImageTiledOpacity.png")

block:
  let paint = newPaint(LinearGradientPaint)
  paint.gradientHandlePositions = @[
    vec2(0, 50),
    vec2(100, 50),
  ]
  paint.gradientStops = @[
    ColorStop(color: color(1, 0, 0, 1), position: 0),
    ColorStop(color: color(1, 0, 0, 0.15625), position: 1.0),
  ]

  let image = newImage(100, 100)
  image.fillPath(heartShape, paint)
  image.xray("tests/paths/gradientLinear.png")

block:
  let paint = newPaint(LinearGradientPaint)
  paint.gradientHandlePositions = @[
    vec2(50, 0),
    vec2(50, 100),
  ]
  paint.gradientStops = @[
    ColorStop(color: color(1, 0, 0, 1), position: 0),
    ColorStop(color: color(1, 0, 0, 0.15625), position: 1.0),
  ]

  let image = newImage(100, 100)
  image.fillPath(heartShape, paint)
  image.xray("tests/paths/gradientLinear2.png")

block:
  let paint = newPaint(RadialGradientPaint)
  paint.gradientHandlePositions = @[
    vec2(50, 50),
    vec2(100, 50),
    vec2(50, 100)
  ]
  paint.gradientStops = @[
    ColorStop(color: color(1, 0, 0, 1), position: 0),
    ColorStop(color: color(1, 0, 0, 0.15625), position: 1.0),
  ]

  let image = newImage(100, 100)
  image.fillPath(heartShape, paint)
  image.xray("tests/paths/gradientRadial.png")

block:
  let paint = newPaint(AngularGradientPaint)
  paint.gradientHandlePositions = @[
    vec2(50, 50),
    vec2(100, 50),
    vec2(50, 100)
  ]
  paint.gradientStops = @[
    ColorStop(color: color(1, 0, 0, 1), position: 0),
    ColorStop(color: color(1, 0, 0, 0.15625), position: 1.0),
  ]

  let image = newImage(100, 100)
  image.fillPath(heartShape, paint)
  image.xray("tests/paths/gradientAngular.png")

block:
  let paint = newPaint(AngularGradientPaint)
  paint.gradientHandlePositions = @[
    vec2(50, 50),
    vec2(100, 50),
    vec2(50, 100)
  ]
  paint.gradientStops = @[
    ColorStop(color: color(1, 0, 0, 1), position: 0),
    ColorStop(color: color(1, 0, 0, 0.15625), position: 1.0),
  ]
  paint.opacity = 0.5

  let image = newImage(100, 100)
  image.fillPath(heartShape, paint)
  image.xray("tests/paths/gradientAngularOpacity.png")

block:
  let paint = newPaint(ImagePaint)
  paint.image = readImage("tests/fileformats/png/mandrill.png")
  paint.imageMat = scale(vec2(0.2, 0.2))
  paint.opacity = 0.5

  let image = newImage(128, 128)
  image.fill(rgbx(0, 255, 0, 255))
  image.fill(paint)
  image.xray("tests/paths/fillImagePaint.png")

block:
  let paint = newPaint(TiledImagePaint)
  paint.image = readImage("tests/fileformats/png/mandrill.png")
  paint.imageMat = scale(vec2(0.1, 0.1))
  paint.opacity = 0.5

  let image = newImage(128, 128)
  image.fill(rgbx(0, 255, 0, 255))
  image.fill(paint)
  image.xray("tests/paths/fillTiledImagePaint.png")

block: # the colour table lands within a level of evaluating every pixel
  proc maxChannelDiff(a, b: Image): (int, int) =
    var worst, differing: int
    for y in 0 ..< a.height:
      for x in 0 ..< a.width:
        let
          p = a[x, y]
          q = b[x, y]
          d = max(max(abs(p.r.int - q.r.int), abs(p.g.int - q.g.int)),
                  max(abs(p.b.int - q.b.int), abs(p.a.int - q.a.int)))
        if d > 0:
          inc differing
          if d > worst: worst = d
    (worst, differing)

  proc check(name: string, paint: Paint, format = pfRgbx, maxWorst = 1) =
    let
      exact = if format == pfRgb565: newImage565(400, 300) else: newImage(400, 300)
      table = if format == pfRgb565: newImage565(400, 300) else: newImage(400, 300)
    exact.fillGradient(paint, exact = true)
    table.fillGradient(paint)
    let (worst, differing) = maxChannelDiff(exact, table)
    doAssert worst <= maxWorst, name & ": table differs by " & $worst
    doAssert differing * 5 <= 400 * 300,
      name & ": table differs in " & $differing & " px"
    echo "gradient table ", name, ": worst=", worst, " differing=", differing

  let radial = newPaint(RadialGradientPaint)
  radial.gradientHandlePositions = @[vec2(180, 140), vec2(390, 140), vec2(180, 260)]
  radial.gradientStops = @[
    ColorStop(color: color(1, 1, 1, 1), position: 0),
    ColorStop(color: color(1, 0.8, 0.2, 1), position: 0.35),
    ColorStop(color: color(0.07, 0.19, 0.35, 1), position: 1)
  ]
  check("radial", radial)
  # 5/6-bit channels: a one-level difference in 8 bits can cross a 565
  # bucket, which reads back as one bucket (8 or 9 levels) apart.
  check("radial 565", radial, pfRgb565, maxWorst = 9)

  let fading = newPaint(RadialGradientPaint)
  fading.gradientHandlePositions = radial.gradientHandlePositions
  fading.gradientStops = @[
    ColorStop(color: color(0.1, 0.2, 0.6, 1), position: 0),
    ColorStop(color: color(0.1, 0.2, 0.6, 0), position: 1)
  ]
  fading.opacity = 0.7
  # Where alpha ramps too, premultiplying rounds a second time: two levels.
  check("radial alpha", fading, maxWorst = 2)

  let diagonal = newPaint(LinearGradientPaint)
  diagonal.gradientHandlePositions = @[vec2(3.5, 2.25), vec2(392.5, 298.5)]
  diagonal.gradientStops = @[
    ColorStop(color: color(1, 0.8, 0.2, 1), position: 0),
    ColorStop(color: color(0.2, 0.4, 1, 0.6), position: 0.45),
    ColorStop(color: color(0.1, 0.9, 0.5, 1), position: 1)
  ]
  check("diagonal", diagonal, maxWorst = 2)

  let angular = newPaint(AngularGradientPaint)
  angular.gradientHandlePositions = @[vec2(200, 150), vec2(400, 150), vec2(200, 300)]
  angular.gradientStops = diagonal.gradientStops
  check("angular", angular, maxWorst = 2)

  # A collapsed gradient (edge on the centre) is NaN everywhere: the first
  # stop, from the table as from the ramp.
  let collapsed = newPaint(RadialGradientPaint)
  collapsed.gradientHandlePositions = @[vec2(200, 150), vec2(200, 150), vec2(200, 300)]
  collapsed.gradientStops = radial.gradientStops
  check("collapsed radial", collapsed, maxWorst = 0)
  let probe = newImage(400, 300)
  probe.fillGradient(collapsed)
  doAssert probe[0, 0] == rgbx(255, 255, 255, 255)
