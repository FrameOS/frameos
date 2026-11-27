## The render scale: what a scene is laid out and sized for.
##
## At scale 2 a .tsx or .jsx app is told its canvas is half the panel's width
## and height (context.imageWidth / targetWidth, app.frame.width / height), a
## UI it returns is laid out at that size, and the SVG either one makes is
## drawn at the panel's full size by pixie, which stretches the root to the
## target as vectors. A scene made for an 800x480 screen then fills a 1600x960
## one with the same layout, sharp, instead of sitting small in whitespace;
## and an app that fetches for its size (a map's lines) fetches a quarter of
## the data. The built-in scenes (the switcher, the settings) are laid out the
## same way, and the text app's sizes (render/text: its font, padding, border
## and offsets), a split's gaps and margins and a QR code's pixels are
## multiplied by it, so the one setting makes every scene larger or smaller.
## Plain .js/.ts apps keep the panel's size: an app that fetches a photo for
## its size wants every pixel. Every app reads the scale in effect as
## app.frame.scale.
##
## The scale in effect is the scene's own, else the frame's:
##
## - a field with `role: "renderScale"` whose state holds a usable number
##   (so a control panel or frameos.setState can change it), else
## - the scene's `settings.renderScale`, else
## - the frame's (frame.json `renderScale`, the control planes'
##   `render_scale`), where 0 is automatic: by the panel's density, so a
##   scene's letters come out about the size they have on the 7" to 7.5"
##   800x480 panels scenes are made on (`ReferencePpi`): the pixels per inch
##   over 130 to the nearest whole number, never below 1 and never leaving a
##   layout under 576 px on the shorter edge (`MinLayoutEdge`: a smaller
##   screen is seen closer, and a scene has to fit). Whole numbers only: at
##   2 a line one pixel wide is two, every box edge lands on a pixel and
##   pixie fills it in solid spans; at 1.75 every edge is antialiased and a
##   hairline comes out one pixel and a grey (dithered on e-paper). A
##   fraction stays the owner's to set. The panel's size comes from its name
##   (`EPD_10in3`) or `NamedPanelInches`; one of unknown size is 1. HDMI, a
##   screen of unknown size seen from across a room, is the largest whole
##   number that leaves 1080 px (a 4K screen is 2), and no panel (`web_only`)
##   is 1. A panel of 12" or more (`PosterInches`) hangs like a poster and is
##   read from across a room: at least 2 where its layout keeps its 576 px
##   (a 13.3" 1200x1600 e-paper, 150 ppi, lays out at 600x800: at 1 the
##   scenes and pages made for 480 px drew small on it; the UX bench,
##   2026-11-27). The reTerminal E1003 (10.3", 1872x1404, 227 ppi) and the
##   E1004 (13.3") are 2, a 7.3" 800x480 one 1.
##
## docs/jsx-ui.md "Scale" is the spec. The same automatic rule lives in
## `frontend/src/utils/renderScale.ts`; keep the two in step.

import std/[json, math]
import frameos/types
import frameos/refresh_interval

const
  RenderScaleRole* = "renderScale"
  HdmiDevice = "framebuffer"
  NoPanel = "web_only" ## a frame that draws for nobody: no panel to fit
  ## The density a scene's pixels are drawn at as made: the 7" to 7.5" 800x480
  ## panels most scenes are made on (124 to 133 ppi).
  ReferencePpi = 130.0
  ## The shortest edge a layout is left: 480, the edge scenes are made for,
  ## and a fifth more, so a small screen (seen closer) scales less: a 7"
  ## 720x1280 one stays at 1, not its density's 2.
  MinLayoutEdge = 576
  ## HDMI: the layout's shorter edge the automatic scale leaves at least.
  HdmiRoom = 1080
  ## A panel this big or bigger (a 13.3" e-paper) hangs like a poster and is
  ## read from across a room: at least 2 where its layout keeps its 576 px.
  PosterInches = 12.0
  ## Panels whose name does not say their size: only those with a shorter edge
  ## of 720 px or more, as no other can scale (MinLayoutEdge). Keep in step
  ## with `NAMED_PANEL_INCHES` in frontend/src/utils/renderScale.ts
  ## (docs/render-scale-fixtures.json pins both).
  NamedPanelInches = [
    ("pimoroni.inky_impression_13", 13.3),
    ("pimoroni.hyperpixel4sq", 3.95),
    ("pimoroni.hyperpixel4sq_touch", 3.95),
  ]
  MaxRenderScale* = 4.0

proc panelInches*(device: string): float =
  ## The panel's diagonal in inches from its driver's name: the number around
  ## its `in` ("EPD_10in3" 10.3, "waveshare.EPD_2in13_V4" 2.13, "EPD_13in3e"
  ## 13.3), else `NamedPanelInches`; 0 when unknown.
  for (name, inches) in NamedPanelInches:
    if device == name:
      return inches
  for i in 1 .. device.len - 3:
    if device[i] == 'i' and device[i + 1] == 'n' and device[i - 1] in {'0' .. '9'} and
        device[i + 2] in {'0' .. '9'}:
      var whole = 0
      var at = i - 1
      var scale = 1
      while at >= 0 and device[at] in {'0' .. '9'}:
        whole += (ord(device[at]) - ord('0')) * scale
        scale *= 10
        dec at
      var fraction = 0.0
      var place = 0.1
      at = i + 2
      while at < device.len and device[at] in {'0' .. '9'}:
        fraction += (ord(device[at]) - ord('0')).float * place
        place /= 10.0
        inc at
      return whole.float + fraction
  0.0

proc autoRenderScale*(width, height: int, device: string, inches = 0.0): float =
  ## The automatic scale (the module's comment), a whole number: by the
  ## panel's density when its size is known (`inches`, else from `device`'s
  ## name), by the room it leaves on HDMI, else 1.
  result = 1.0
  let edge = min(width, height)
  if device.len == 0 or device == NoPanel or edge <= 0:
    return
  if device == HdmiDevice:
    return clamp(float(edge div HdmiRoom), 1.0, MaxRenderScale)
  let diagonal = if inches > 0.0: inches else: panelInches(device)
  if diagonal <= 0.0:
    return
  let ppi = sqrt(float(width * width + height * height)) / diagonal
  var dense = floor(ppi / ReferencePpi + 0.5)
  if diagonal >= PosterInches:
    dense = max(dense, 2.0)
  let fits = float(edge div MinLayoutEdge)
  result = clamp(min(dense, fits), 1.0, MaxRenderScale)

proc usableScale(scale: float): float {.inline.} =
  if scale > 0.0 and scale <= MaxRenderScale: scale else: 0.0

proc parseRenderScale*(value: JsonNode): float =
  ## Lenient like the refresh interval, with its parse (one copy of it in an
  ## ESP32's flash): control forms deliver numbers as strings. 0 for anything
  ## that is not a scale (0 itself means "not set").
  usableScale(parseRefreshSeconds(value))

proc renderScaleFieldKey*(fields: seq[StateField]): string =
  ## The state key of the scene's first field with role renderScale, "" when
  ## it declares none. (No implicit field is added: most scenes never need
  ## the control, unlike the refresh interval.)
  for field in fields:
    if not field.isNil and field.role == RenderScaleRole:
      return field.name
  ""

proc autoFrameRenderScale*(config: FrameConfig): float =
  ## The automatic scale for the frame's panel: its size the host's
  ## (`panelInches`: an ESP32's display, a plane's render for a board), else
  ## its device's name.
  if config.isNil: 1.0
  else: autoRenderScale(config.width, config.height, config.device, config.panelInches)

proc frameRenderScale*(config: FrameConfig): float {.inline.} =
  ## The frame's scale: its own setting, or the automatic one for its panel.
  if config.isNil:
    return 1.0
  let own = usableScale(config.renderScale)
  if own > 0.0: own else: autoFrameRenderScale(config)

proc sceneRenderScale*(scene: FrameScene): float {.inline.} =
  ## The scene's own override: its role field's state, else its setting. 0 =
  ## none, the frame's applies.
  if scene.isNil:
    return 0.0
  if scene.renderScaleKey.len > 0:
    # `{}` is nil for a missing key and for a state that is not an object.
    let fromState = parseRenderScale(scene.state{scene.renderScaleKey})
    if fromState > 0.0:
      return fromState
  usableScale(scene.renderScaleSetting)

proc effectiveRenderScale*(scene: FrameScene, config: FrameConfig): float =
  let own = sceneRenderScale(scene)
  if own > 0.0: own else: frameRenderScale(config)

proc nodeRenderScale*(scene: FrameScene, config: FrameConfig): float =
  ## What a Nim app's pixel sizes are multiplied by (render/text's, a
  ## render/split's gaps and margins, data/qr's pixels): its scene's scale,
  ## and 1 for one the runtime made without a scene (the runner's overlays,
  ## which size themselves by apps.panelScale).
  if scene.isNil: 1.0 else: effectiveRenderScale(scene, config)

proc scaledLength*(length: int, scale: float): int =
  ## A panel length as a scaled app sees it: never below 1.
  if scale <= 0.0 or scale == 1.0:
    return length
  max(1, int(round(length.float / scale)))
