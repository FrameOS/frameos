import std/[json, options, strformat, unittest]
import pixie

import ../app
import frameos/types

proc newTestLogger(): Logger =
  Logger(log: proc(payload: JsonNode) = discard)

proc makeApp(config: AppConfig, state: JsonNode = %*{}): App =
  App(
    scene: FrameScene(state: state, logger: newTestLogger()),
    frameConfig: FrameConfig(width: 30, height: 20, rotate: 0),
    appConfig: config
  )

proc quadrantSource(width, height: int): Image =
  result = newImage(width, height)
  let
    red = rgbx(255, 0, 0, 255)
    green = rgbx(0, 255, 0, 255)
    blue = rgbx(0, 0, 255, 255)
    yellow = rgbx(255, 255, 0, 255)
  for y in 0 ..< height:
    for x in 0 ..< width:
      result.data[result.dataIndex(x, y)] =
        if y < height div 2:
          if x < width div 2: red else: green
        else:
          if x < width div 2: blue else: yellow

proc closeTo(value: uint8, expected: int, tolerance = 24): bool =
  abs(value.int - expected) <= tolerance

const eps = 1e-6

suite "render/zoomPan math":
  test "phase progresses and wraps":
    check abs(phase(0.0, 60.0)) < eps
    check abs(phase(30.0, 60.0) - 0.5) < eps
    check abs(phase(59.9, 60.0) - 59.9 / 60.0) < eps
    check abs(phase(60.0, 60.0)) < eps
    check abs(phase(90.0, 60.0) - 0.5) < eps
    check abs(phase(-15.0, 60.0) - 0.75) < eps
    check phase(123.0, 0.0) == 0.0
    check phase(123.0, -5.0) == 0.0

  test "cycleIndex counts full cycles":
    check cycleIndex(0.0, 60.0) == 0
    check cycleIndex(59.9, 60.0) == 0
    check cycleIndex(60.1, 60.0) == 1
    check cycleIndex(180.5, 60.0) == 3
    check cycleIndex(123.0, 0.0) == 0

  test "easing endpoints and monotonicity":
    for easing in ["linear", "easeInOut", "sine", "unknown"]:
      check abs(eased(0.0, easing)) < eps
      check abs(eased(1.0, easing) - 1.0) < eps
      var previous = 0.0
      for step in 0 .. 100:
        let value = eased(step.float / 100.0, easing)
        check value >= previous - eps
        previous = value

  test "pingPong folds the phase":
    check abs(pingPong(0.0)) < eps
    check abs(pingPong(0.25) - 0.5) < eps
    check abs(pingPong(0.5) - 1.0) < eps
    check abs(pingPong(0.75) - 0.5) < eps
    check abs(pingPong(1.0)) < eps

  test "zoomAt per motion":
    check abs(zoomAt("zoomIn", 1.0, 1.3, 0.0, "linear") - 1.0) < eps
    check abs(zoomAt("zoomIn", 1.0, 1.3, 1.0, "linear") - 1.3) < eps
    check abs(zoomAt("kenBurns", 1.0, 1.3, 0.5, "linear") - 1.15) < eps
    check abs(zoomAt("zoomInOut", 1.0, 1.3, 0.0, "linear") - 1.0) < eps
    check abs(zoomAt("zoomInOut", 1.0, 1.3, 0.5, "linear") - 1.3) < eps
    check abs(zoomAt("zoomInOut", 1.0, 1.3, 1.0, "linear") - 1.0) < eps
    for t in [0.0, 0.3, 0.9]:
      check abs(zoomAt("panLeftRight", 1.0, 1.3, t, "sine") - 1.3) < eps
      check abs(zoomAt("panTopBottom", 1.0, 1.3, t, "sine") - 1.3) < eps
    check abs(zoomAt("zoomIn", 0.0, 0.0, 1.0, "linear") - 1.0) < eps

  test "cropRect stays in bounds with the canvas aspect ratio":
    var violations: seq[string] = @[]
    for (iw, ih) in [(60, 40), (40, 60), (100, 100), (320, 180), (30, 200)]:
      for (cw, ch) in [(30, 20), (20, 30), (64, 64)]:
        for zoom in [0.5, 1.0, 1.3, 2.5, 4.0]:
          for motion in ["zoomInOut", "zoomIn", "panLeftRight", "panTopBottom", "kenBurns"]:
            for anchor in ["center", "top", "bottom", "left", "right", "random"]:
              for easing in ["linear", "sine"]:
                for seed in [0, 3]:
                  for step in 0 .. 8:
                    let t = step.float / 8.0
                    let (x, y, w, h) = cropRect(iw, ih, cw, ch, zoom, anchor, t, motion, easing, seed)
                    let details = &"iw={iw} ih={ih} cw={cw} ch={ch} zoom={zoom} " &
                      &"motion={motion} anchor={anchor} easing={easing} seed={seed} t={t}"
                    if x < -eps or y < -eps or x + w > iw.float + eps or y + h > ih.float + eps:
                      violations.add("out of bounds: " & details)
                    elif w <= 0 or h <= 0:
                      violations.add("empty rect: " & details)
                    elif abs(w / h - cw.float / ch.float) > 1e-4:
                      violations.add("aspect mismatch: " & details)
    checkpoint(if violations.len > 0: violations[0] else: "")
    check violations.len == 0

  test "zoom 1.0 equals the max centered cover-crop":
    for (iw, ih) in [(60, 40), (40, 60), (100, 100), (320, 180), (30, 200)]:
      for (cw, ch) in [(30, 20), (20, 30), (64, 64)]:
        let canvasAspect = cw.float / ch.float
        var expectedW = iw.float
        var expectedH = iw.float / canvasAspect
        if expectedH > ih.float:
          expectedH = ih.float
          expectedW = ih.float * canvasAspect
        for motion in ["zoomInOut", "zoomIn"]:
          for t in [0.0, 0.4, 1.0]:
            let (x, y, w, h) = cropRect(iw, ih, cw, ch, 1.0, "center", t, motion)
            check abs(w - expectedW) < eps
            check abs(h - expectedH) < eps
            check abs(x - (iw.float - expectedW) / 2.0) < eps
            check abs(y - (ih.float - expectedH) / 2.0) < eps
        for motion in ["panLeftRight", "panTopBottom", "kenBurns"]:
          let (_, _, w, h) = cropRect(iw, ih, cw, ch, 1.0, "center", 0.3, motion)
          check abs(w - expectedW) < eps
          check abs(h - expectedH) < eps

  test "zoom below 1.0 clamps to the cover-crop":
    check cropRect(60, 40, 30, 20, 0.5, "center", 0.0, "zoomIn") ==
      cropRect(60, 40, 30, 20, 1.0, "center", 0.0, "zoomIn")

  test "kenBurns focal drift is deterministic per cycle":
    let rect = cropRect(60, 40, 30, 20, 1.5, "center", 0.3, "kenBurns", "linear", 2)
    check rect == cropRect(60, 40, 30, 20, 1.5, "center", 0.3, "kenBurns", "linear", 2)
    var different = false
    for seed in 1 .. 8:
      if cropRect(60, 40, 30, 20, 1.5, "center", 0.3, "kenBurns", "linear", 2 + seed) != rect:
        different = true
    check different

  test "random anchor is deterministic per seed":
    let rect = cropRect(60, 40, 30, 20, 2.0, "random", 0.5, "zoomIn", "linear", 4)
    check rect == cropRect(60, 40, 30, 20, 2.0, "random", 0.5, "zoomIn", "linear", 4)
    var different = false
    for seed in 5 .. 12:
      if cropRect(60, 40, 30, 20, 2.0, "random", 0.5, "zoomIn", "linear", seed) != rect:
        different = true
    check different

suite "render/zoomPan render":
  test "two moments in time render different crops":
    let source = quadrantSource(60, 40)
    let app = makeApp(AppConfig(
      image: source,
      motion: "zoomIn",
      zoomStart: 1.0,
      zoomEnd: 2.0,
      durationSeconds: 60.0,
      easing: "linear",
      anchor: "left",
    ))
    let context = ExecutionContext(hasImage: false)

    let canvasStart = newImage(30, 20)
    app.renderAt(context, canvasStart, 0.0)
    check closeTo(canvasStart.data[canvasStart.dataIndex(2, 2)].r, 255)
    check closeTo(canvasStart.data[canvasStart.dataIndex(2, 2)].g, 0)
    check closeTo(canvasStart.data[canvasStart.dataIndex(27, 2)].g, 255)
    check closeTo(canvasStart.data[canvasStart.dataIndex(27, 2)].r, 0)
    check closeTo(canvasStart.data[canvasStart.dataIndex(2, 17)].b, 255)
    check closeTo(canvasStart.data[canvasStart.dataIndex(27, 17)].r, 255)
    check closeTo(canvasStart.data[canvasStart.dataIndex(27, 17)].g, 255)

    let canvasLater = newImage(30, 20)
    app.renderAt(context, canvasLater, 30.0)
    # At t=0.5 the left-anchored crop is (0, 6.67, 40, 26.67): canvas x=16
    # samples source x~21 (red half) instead of x=32 (green half) at t=0.
    check closeTo(canvasStart.data[canvasStart.dataIndex(16, 2)].g, 255)
    check closeTo(canvasLater.data[canvasLater.dataIndex(16, 2)].r, 255)
    check canvasStart.data != canvasLater.data

  test "phase state key restores and persists the animation phase":
    let source = quadrantSource(60, 40)
    let app = makeApp(AppConfig(
      image: source,
      motion: "zoomInOut",
      zoomStart: 1.0,
      zoomEnd: 1.3,
      durationSeconds: 60.0,
      easing: "linear",
      anchor: "center",
      phaseStateKey: "zoomPanPhase",
    ), state = %*{"zoomPanPhase": 2.5})
    let context = ExecutionContext(hasImage: false)

    app.renderAt(context, newImage(30, 20), 1234.0)
    check abs(app.scene.state["zoomPanPhase"].getFloat() - 2.5) < eps
    app.renderAt(context, newImage(30, 20), 1240.0)
    check abs(app.scene.state["zoomPanPhase"].getFloat() - 2.6) < eps

  test "phase state key is written on a fresh start":
    let app = makeApp(AppConfig(
      image: quadrantSource(60, 40),
      motion: "zoomIn",
      zoomStart: 1.0,
      zoomEnd: 1.3,
      durationSeconds: 60.0,
      easing: "linear",
      anchor: "center",
      phaseStateKey: "zoomPanPhase",
    ))
    app.renderAt(ExecutionContext(hasImage: false), newImage(30, 20), 90.0)
    check abs(app.scene.state["zoomPanPhase"].getFloat() - 1.5) < eps

  test "missing image renders an error image of the expected size":
    let app = makeApp(AppConfig(motion: "kenBurns", easing: "linear", anchor: "center"))
    let fromConfig = app.get(ExecutionContext(hasImage: false))
    check fromConfig.width == 30
    check fromConfig.height == 20
    let fromContext = app.get(ExecutionContext(hasImage: true, image: newImage(16, 12)))
    check fromContext.width == 16
    check fromContext.height == 12

  test "run and get clear transient image inputs":
    let app = makeApp(AppConfig(
      image: quadrantSource(60, 40),
      motion: "zoomIn",
      zoomStart: 1.0,
      zoomEnd: 1.3,
      durationSeconds: 60.0,
      easing: "linear",
      anchor: "center",
    ))
    app.run(ExecutionContext(hasImage: true, image: newImage(30, 20)))
    check app.appConfig.image.isNil
    check app.appConfig.inputImage.isNone
