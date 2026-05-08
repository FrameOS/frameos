import std/[json, options, tables, unittest]
import pixie
import ../../../frameos/types
import ../../../frameos/channels
import ../scene as wifi_scene

proc clearEventChannel() =
  while true:
    let (ok, _) = eventChannel.tryRecv()
    if not ok:
      break

proc testConfig(): FrameConfig =
  FrameConfig(
    width: 800,
    height: 480,
    rotate: 0,
    scalingMode: "contain",
    debug: true,
    saveAssets: %*false,
    network: NetworkConfig(
      wifiHotspotSsid: "FrameOS-Setup",
      wifiHotspotPassword: "frameos123",
      wifiHotspotTimeoutSeconds: 120.0
    ),
    httpsProxy: HttpsProxyConfig(enable: false, port: 0, exposeOnlyPort: false)
  )

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    discard payload
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false
  logger

proc makeScene(): wifi_scene.Scene =
  let config = testConfig()
  wifi_scene.Scene(wifi_scene.init("system/wifiHotspot".SceneId, config, testLogger(config), %*{}))

proc renderContext(scene: FrameScene): ExecutionContext =
  ExecutionContext(
    scene: scene,
    event: "render",
    payload: %*{},
    image: newImage(scene.frameConfig.width, scene.frameConfig.height),
    hasImage: true,
    loopIndex: 0,
    loopKey: ".",
    nextSleep: -1
  )

suite "system/wifiHotspot scene":
  test "render path works with minimal scene context":
    let scene = makeScene()
    var ctx = renderContext(scene.FrameScene)
    let image = wifi_scene.render(scene.FrameScene, ctx)

    check image.width == 800
    check image.height == 480

  test "setSceneState with render=true queues render event":
    clearEventChannel()
    let scene = makeScene()
    let context = ExecutionContext(
      scene: scene.FrameScene,
      event: "setSceneState",
      payload: %*{"state": {"ignored": 1}, "render": true},
      hasImage: false,
      loopIndex: 0,
      loopKey: ".",
      nextSleep: -1
    )

    wifi_scene.runEvent(scene, context)

    let (ok, item) = eventChannel.tryRecv()
    check ok
    check item[1] == "render"

  test "setCurrentScene ignores incoming state payload safely":
    let scene = makeScene()
    let before = $scene.state
    let context = ExecutionContext(
      scene: scene.FrameScene,
      event: "setCurrentScene",
      payload: %*{"state": {"foo": "bar"}},
      hasImage: false,
      loopIndex: 0,
      loopKey: ".",
      nextSleep: -1
    )

    wifi_scene.runEvent(scene, context)

    check $scene.state == before
