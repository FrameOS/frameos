## Video for JS apps (docs/video.md), included into app_runtime.nim:
## `frameos.video` and friends, and `fillVideos`, which gives each `<img>`
## of a video its frame once the layout said its size.
##
## A video is an image ref like a canvas: `frameos.video(key, {src})` is the
## app's video called `key`, the same picture every render, whose pixels the
## player changes (video/player.nim). An `<img src={video}>` draws the frame
## that is due, decoded by ffmpeg at the size the layout gave the `<img>`; the
## canvas log notes each new frame, so a frame repaints the video's box and
## nothing else, and the scene's next render is when the next frame is due.
##
## Only a Linux frame plays (a Raspberry Pi with ffmpeg, Buildroot's images
## have it). An ESP32 and the browser preview answer every call with
## `NoVideoHere` and draw nothing.

const
  MaxVideos = 4
    ## Videos an app may hold at once; a fifth key lets the oldest go.

when defined(frameosEmbedded):
  const NoVideoHere = "Video needs a Raspberry Pi frame: this one cannot play it"
elif defined(frameosWasm):
  const NoVideoHere = "Video plays on a Raspberry Pi frame, not here"
    ## The browser preview, and a board or virtual frame its plane renders.

when defined(frameosEmbedded) or defined(frameosWasm):
  proc jsVideo(ctx: ptr JSContext, op: JSValue, argJson: JSValue): JSValue {.nimcall.} =
    ## No ffmpeg here: every answer says so, and a video draws nothing.
    ## Constant text, no JSON built: bytes of an ESP32's image.
    let what = toNimString(ctx, op)
    nimStringToJS(ctx,
      if what == "seek" or what == "release": "false"
      elif what == "play": """{"__frameosType":"imageRef","id":0,"width":0,"height":0,"state":"error","error":"""" &
        NoVideoHere & """"}"""
      elif what == "frame": """{"image":null,"error":"""" & NoVideoHere & """"}"""
      else: """{"error":"""" & NoVideoHere & """"}""")

  proc closeVideos(runtime: JsAppRuntime) {.raises: [].} = discard

else:
  proc videoArg(ctx: ptr JSContext, argJson: JSValue): JsonNode =
    try:
      result = parseJsonBounded(toNimString(ctx, argJson))
    except CatchableError:
      result = newJObject()
    if result.kind != JObject:
      result = newJObject()

  proc videoHeaders(arg: JsonNode): seq[(string, string)] =
    let headers = arg{"headers"}
    if not headers.isNil and headers.kind == JObject:
      for name, value in headers.pairs:
        if value.kind == JString:
          result.add((name, value.getStr()))
        elif value.kind in {JInt, JFloat, JBool}:
          result.add((name, $value))

  proc videoSourceFor(e: JsAppEvalEnv, arg: JsonNode, error: var string): VideoSource =
    ## Where `arg.src` is: a URL the private-network guard lets through and
    ## pins (spawn_guard.nim), or a file in the app's assets.
    let src = arg{"src"}.getStr().strip()
    if src.len == 0:
      error = "no src"
      return
    if src.contains("://"):
      let target = spawnTarget(src, ["http", "https", "rtsp", "rtsps"])
      if target.refusal.len > 0:
        error = target.refusal
        return
      result.input = target.pinnedUrl
      result.scheme = target.scheme
      result.denyActive = target.denyActive
      if target.address.len > 0 and target.scheme in ["http", "https"]:
        result.hostHeader = target.hostname
      result.headers = videoHeaders(arg)
    else:
      let full = resolveAssetPath(e, src, storage = arg{"storage"}.getStr())
      if full.len == 0:
        error = "not a file this app may read: " & src
        return
      if not fileExists(full):
        error = "no such file: " & src
        return
      result.input = full

  proc closeVideos(runtime: JsAppRuntime) {.raises: [].} =
    ## The interpreter goes: its videos stop.
    for video in runtime.videos:
      try:
        if not video.player.isNil:
          video.player.close()
      except CatchableError:
        discard
      runtime.images.del(video.id)
    runtime.videos.setLen(0)

  proc videoIndex(runtime: JsAppRuntime, id: int): int =
    for i in 0 ..< runtime.videos.len:
      if runtime.videos[i].id == id:
        return i
    -1

  proc videoJson(runtime: JsAppRuntime, video: JsVideo): JsonNode =
    let image = if video.player.isNil: nil else: video.player.shownImage()
    result = %*{"__frameosType": "imageRef", "id": video.id,
      "width": (if image.isNil: 0 else: image.width), "height": (if image.isNil: 0 else: image.height),
      "video": video.key, "src": video.src}
    if video.player.isNil:
      result["state"] = %"error"
      result["error"] = %video.error
      return
    let status = video.player.status()
    result["state"] = %status.state
    result["time"] = %(round(status.time * 1000) / 1000)
    result["duration"] = (if status.duration > 0: %(round(status.duration * 1000) / 1000) else: newJNull())
    result["live"] = %(status.probed and status.duration <= 0)
    if status.width > 0:
      result["videoWidth"] = %status.width
      result["videoHeight"] = %status.height
    if status.fps > 0:
      result["fps"] = %(round(status.fps * 100) / 100)
    if status.decoder.len > 0:
      result["decoder"] = %status.decoder
      result["fast"] = %status.fast
    if status.error.len > 0:
      result["error"] = %status.error

  proc playVideo(e: JsAppEvalEnv, arg: JsonNode): JsonNode =
    ## `frameos.video(key, options)`: the app's video called `key`, started
    ## the first time and again when its src changes; its options applied
    ## every call.
    let runtime = e.runtime
    let key = arg{"key"}.getStr("video")
    let src = arg{"src"}.getStr().strip()
    let storage = arg{"storage"}.getStr()
    let headers = if arg{"headers"}.isNil: "" else: $arg{"headers"}
    var at = -1
    var lastPicture: Image
    for i in 0 ..< runtime.videos.len:
      if runtime.videos[i].key == key:
        at = i
    if at >= 0 and (runtime.videos[at].src != src or runtime.videos[at].storage != storage or
        runtime.videos[at].headers != headers):
      # Another video under the same key: the old one stops, and its last
      # frame shows until the new one's first (no black between two files).
      if not runtime.videos[at].player.isNil:
        lastPicture = runtime.videos[at].player.image
        runtime.videos[at].player.close()
      runtime.images.del(runtime.videos[at].id)
      runtime.videos.delete(at)
      at = -1
    if at < 0:
      if runtime.videos.len >= MaxVideos:
        if not runtime.videos[0].player.isNil:
          runtime.videos[0].player.close()
        runtime.images.del(runtime.videos[0].id)
        runtime.videos.delete(0)
      inc runtime.nextImageId
      var video = JsVideo(key: key, src: src, storage: storage, headers: headers, id: runtime.nextImageId)
      var error = ""
      let source = videoSourceFor(e, arg, error)
      if error.len == 0 and not videoAvailable():
        error = "ffmpeg is not installed on this frame"
      if error.len > 0:
        video.error = error
        video.id = 0
        frameos_apps.logError(e.owner, "frameos.video: " & error)
      else:
        video.player = newVideoPlayer(source, shownName(src), arg{"loop"}.getBool(false),
          arg{"fps"}.getFloat(DefaultMaxFps), max(arg{"start"}.getFloat(0), 0))
        if not lastPicture.isNil:
          video.player.placeholder = lastPicture
        if e.owner.frameConfig != nil and e.owner.frameConfig.debug:
          frameos_apps.log(e.owner, %*{"event": "video:start", "src": shownName(src)})
      runtime.videos.add video
      at = runtime.videos.high
    template video: untyped = runtime.videos[at]
    if not video.player.isNil:
      video.player.setLoop(arg{"loop"}.getBool(false))
      video.player.setPaused(arg{"paused"}.getBool(false))
      video.player.setMaxFps(arg{"fps"}.getFloat(DefaultMaxFps))
      video.player.lastUse = nowSeconds()
      video.fit = arg{"fit"}.getStr()
      runtime.images[video.id] = video.player.shownImage()
    runtime.videoJson(video)

  proc videoStillJson(e: JsAppEvalEnv, arg: JsonNode): JsonNode =
    ## `frameos.videoFrame(src, {at, width, height, fit, keep})`: one frame as
    ## an image ref, `at` seconds in (the start by default).
    var error = ""
    let source = videoSourceFor(e, arg, error)
    if error.len > 0:
      return %*{"image": nil, "error": error}
    let
      context = e.context
      width = arg{"width"}.getInt(if context.hasImage and not context.image.isNil: context.image.width
        else: frameos_apps.renderWidth(e.owner.frameConfig))
      height = arg{"height"}.getInt(if context.hasImage and not context.image.isNil: context.image.height
        else: frameos_apps.renderHeight(e.owner.frameConfig))
      like = if arg{"keep"}.getBool(false): pictureFormatLike(context) else: nil
      image = videoStill(source, shownName(arg{"src"}.getStr()), max(arg{"at"}.getFloat(0), 0),
        width, height, parseFit(arg{"fit"}.getStr(), vfCover), like, error)
    if image.isNil:
      return %*{"image": nil, "error": error}
    let reference =
      if arg{"keep"}.getBool(false): e.runtime.storeKeptImageJson(e.owner, image)
      else: e.runtime.storeTransientImageJson(image)
    %*{"image": reference, "width": image.width, "height": image.height}

  proc videoInfoJson(e: JsAppEvalEnv, arg: JsonNode): JsonNode =
    ## `frameos.videoInfo(src)`: what ffprobe says of it.
    var error = ""
    let source = videoSourceFor(e, arg, error)
    if error.len > 0:
      return %*{"error": error}
    let probe = probeVideo(source, shownName(arg{"src"}.getStr()))
    if not probe.ok:
      return %*{"error": (if probe.error.len > 0: probe.error else: "not a video")}
    result = %*{"width": probe.width, "height": probe.height, "codec": probe.codec,
      "duration": (if probe.duration > 0: %(round(probe.duration * 1000) / 1000) else: newJNull())}
    if probe.fps > 0:
      result["fps"] = %(round(probe.fps * 100) / 100)

  proc jsVideo(ctx: ptr JSContext, op: JSValue, argJson: JSValue): JSValue {.nimcall.} =
    ## The prelude's one door for video: `op` and its options as JSON, JSON
    ## text back.
    let e = env(ctx)
    let what = toNimString(ctx, op)
    if e == nil:
      return nimStringToJS(ctx, if what in ["seek", "release"]: "false" else: "null")
    let arg = videoArg(ctx, argJson)
    try:
      case what
      of "play":
        return nimStringToJS(ctx, $playVideo(e, arg))
      of "seek", "release":
        let i = e.runtime.videoIndex(arg{"id"}.getInt(0))
        if i < 0 or e.runtime.videos[i].player.isNil:
          return nimStringToJS(ctx, "false")
        if what == "seek":
          e.runtime.videos[i].player.seek(arg{"at"}.getFloat(0))
        else:
          e.runtime.videos[i].player.close()
          e.runtime.images.del(e.runtime.videos[i].id)
          e.runtime.videos.delete(i)
        return nimStringToJS(ctx, "true")
      of "info":
        return nimStringToJS(ctx, $videoInfoJson(e, arg))
      of "frame":
        return nimStringToJS(ctx, $videoStillJson(e, arg))
      else:
        return nimStringToJS(ctx, $(%*{"error": "unknown video operation: " & what}))
    except CatchableError as err:
      frameos_apps.logError(e.owner, "frameos.video " & what & " failed: " & err.msg)
      return nimStringToJS(ctx, $(%*{"error": err.msg}))

  proc logSignal(owner: AppRoot, payload: JsonNode) =
    ## A line that goes out even while the runner has the scene's log off (a
    ## video renders fast: "render:pause"), as the runner's own signals do.
    if owner.isNil or owner.scene.isNil or owner.scene.logger.isNil:
      return
    let logger = owner.scene.logger
    let wasEnabled = logger.enabled
    if not wasEnabled:
      logger.enable()
    frameos_apps.log(owner, payload)
    if not wasEnabled:
      logger.disable()

  proc logFallback(owner: AppRoot, video: var JsVideo) =
    ## A hardware launch of `video` gave way (to ffmpeg's own decoder, or from
    ## the ISP path to ffmpeg's hardware one): said once, with the reason
    ## (docs/video.md "Hardware").
    let count = video.player.fallbacks()
    if count == video.toldFallbacks:
      return
    video.toldFallbacks = count
    let fallback = video.player.lastFallback()
    logSignal(owner, %*{"event": "video:fallback", "src": shownName(video.src),
      "from": fallback.decoder, "to": fallback.to, "reason": fallback.reason,
      "hardwareKept": fallback.busy})

  var planesTold: bool
    ## The runtime's log said once whether videos go on display planes here.
  var planeScenes {.threadvar.}: seq[FrameScene]
    ## The scenes whose videos are on display planes this pass: each runs in
    ## the next pass whatever its schedule (markVideoPlaneScenesDue), so every
    ## pass says whether its planes may stay and where.

  proc markVideoPlaneScenesDue*() =
    ## Before a render pass (runner.nim): the scenes with a video on a plane
    ## run in it, a window's on a desktop included, though nothing else of
    ## theirs is due. A pass that did not run one would leave its plane
    ## unclaimed (off for that pass) or, worse, standing over what changed.
    for scene in planeScenes:
      rhythmMarkDue(scene)
    planeScenes.setLen(0)

  proc videoSpots(runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext, target: UiTarget,
      requestedWidth, requestedHeight: int, regionScale: float32): seq[(Image, VideoPlaneSpot)] =
    ## The videos whose `<img>` can be a display plane (video/planes.nim,
    ## docs/video.md "Planes"), and where on the panel. Only where the plane is
    ## exactly right, else the canvas plays it:
    ## - a UI drawn whole at its size into the panel's own canvas or a view
    ##   of it (a layout's hole, a desktop's window: panel_canvas.onPanelCanvas),
    ##   which the layout only gives a scene nothing of it is painted over (its
    ##   `seekHoles`), on a panel the frame neither turns nor mirrors;
    ## - the `<img>` a clean hole of that UI (ui/layout.nim seekImageHoles:
    ##   nothing drawn over it, opaque, not scrolled, no popup);
    ## - nothing the frame draws over every scene on it: the keyboard docked
    ##   or in its window (`frameKeyboard`), the mouse cursor (planes.cursorOver);
    ## - where it was the last render: a window being dragged or the desktop
    ##   refitted keeps it in the canvas until it stays put.
    if owner.isNil or owner.frameConfig.isNil or target.isNil or not context.wholeFrame or
        not context.hasImage or context.image.isNil or context.decodeTargetImage != context.image or
        requestedWidth != context.image.width or requestedHeight != context.image.height:
      return
    let at = context.image.onPanelCanvas()
    if not at.ok:
      return
    let config = owner.frameConfig
    if ((config.rotate mod 360) + 360) mod 360 != 0 or config.flip in ["horizontal", "vertical", "both"]:
      return
    let panel = panelCanvasSize()
    let ready = panel.width > 0 and planesReady(panel.width, panel.height)
    if not planesTold:
      planesTold = true
      logSignal(owner, %*{"event": "video:planes", "on": ready, "why": planesWhyNot()})
    if not ready:
      return
    var images: seq[Image]
    for video in runtime.videos:
      if not video.player.isNil:
        images.add video.player.placeholder
        if not video.player.image.isNil:
          images.add video.player.image
    for hole in seekImageHoles(target.memo, target.input, images):
      var video = -1
      for i in 0 ..< runtime.videos.len:
        let player = runtime.videos[i].player
        if not player.isNil and (player.placeholder == hole.image or player.image == hole.image):
          video = i
      if video < 0:
        continue
      template v: untyped = runtime.videos[video]
      let r = holeOnPanel(hole.x, hole.y, hole.w, hole.h, regionScale, at.x, at.y, requestedWidth,
        requestedHeight)
      let was = v.spotAt
      v.spotAt = if r.ok: (r.x, r.y, r.w, r.h) else: (0, 0, 0, 0)
      if not hole.clean or not r.ok or (r.x, r.y, r.w, r.h) != was:
        continue
      if frameKeyboard.sceneId.len > 0 and overlaps(r.x, r.y, r.w, r.h, int(frameKeyboard.x),
          int(frameKeyboard.y), int(ceil(frameKeyboard.w)), int(ceil(frameKeyboard.h))):
        continue
      if cursorOver(r.x, r.y, r.w, r.h):
        continue
      result.add (hole.image, VideoPlaneSpot(ok: true, x: r.x, y: r.y, clipX: at.x, clipY: at.y,
        clipW: requestedWidth, clipH: requestedHeight))

  proc fillVideosIn(runtime: JsAppRuntime, owner: AppRoot, node: SvgNode, scale: float32, like: Image,
      spots: seq[(Image, VideoPlaneSpot)], wait: var float, taken: var seq[VideoPlayer]) =
    if node.tag == "image" and not node.image.isNil:
      for i in 0 ..< runtime.videos.len:
        let player = runtime.videos[i].player
        if player.isNil or (node.image != player.placeholder and node.image != player.image):
          continue
        if player in taken:
          # A second <img> of it: the first one's size is the decode's (two
          # sizes would start ffmpeg again every frame), this one scales it.
          if node.image != player.shownImage():
            node.image = player.shownImage()
            node.forgetParse()
          return
        taken.add player
        let
          width = max(1, round(attrFloat(node, "width") * scale).int)
          height = max(1, round(attrFloat(node, "height") * scale).int)
          fit =
            if runtime.videos[i].fit.len > 0: parseFit(runtime.videos[i].fit)
            else:
              case node.attr("preserveAspectRatio")
              of "none": vfFill
              of "xMidYMid slice": vfCover
              else: vfContain
        var spot: VideoPlaneSpot
        for (image, at) in spots:
          if image == node.image:
            spot = at
        discard player.take(width, height, fit, like, spot)
        if player.onPlane and not owner.scene.isNil and owner.scene notin planeScenes:
          planeScenes.add owner.scene
        logFallback(owner, runtime.videos[i])
        let shown = player.shownImage()
        if node.image != shown:
          node.image = shown
          node.forgetParse()
        runtime.images[runtime.videos[i].id] = shown
        let next = player.nextFrameIn()
        if next >= 0:
          wait = if wait < 0: next else: min(wait, next)
        return
      return
    for child in node.children:
      runtime.fillVideosIn(owner, child, scale, like, spots, wait, taken)

  proc fillVideos(runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext, svg: SvgNode,
      scale: float32, spots: seq[(Image, VideoPlaneSpot)] = @[]) =
    ## The layout's `<img>`s of this app's videos: each given the frame that
    ## is due at the size it was laid out at, in panel pixels. The scene
    ## renders again when the next frame is due.
    var wait = -1.0
    var taken: seq[VideoPlayer]
    runtime.fillVideosIn(owner, svg, scale, pictureFormatLike(context), spots, wait, taken)
    if wait >= 0:
      context.nextSleep = if context.nextSleep < 0: wait else: min(context.nextSleep, wait)
