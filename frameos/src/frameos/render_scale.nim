## The render scale: what JSX from a .tsx or .jsx app is laid out for.
##
## At scale 2 such an app is told its canvas is half the panel's width and
## height (context.imageWidth / targetWidth, app.frame.width / height), a UI
## it returns is laid out at that size, and the SVG either one makes is drawn
## at the panel's full size by pixie, which stretches the root to the target
## as vectors. A scene made for an 800x480 screen then fills a 1600x960 one
## with the same layout, sharp, instead of sitting small in whitespace; and
## an app that fetches for its size (a map's lines) fetches a quarter of the
## data. Plain .js/.ts apps keep the panel's size: an app that fetches a photo
## for its size wants every pixel. Every app reads the scale in effect as
## app.frame.scale.
##
## The scale in effect is the scene's own, else the frame's:
##
## - a field with `role: "renderScale"` whose state holds a usable number
##   (so a control panel or frameos.setState can change it), else
## - the scene's `settings.renderScale`, else
## - the frame's (frame.json `renderScale`, the control planes'
##   `render_scale`), where 0 is automatic: the panel's shorter edge over
##   600 px, rounded down to a quarter, never below 1 (800x480 and 720x720
##   are 1, 1200x1600 is 2). Rounded down, so a scaled layout always has at
##   least 600 px on its shorter edge.
##
## docs/jsx-ui.md "Scale" is the spec. The same automatic rule lives in
## `frontend/src/utils/renderScale.ts`; keep the two in step.

import std/[json, math, strutils]
import frameos/types

const
  RenderScaleRole* = "renderScale"
  ## The shorter edge that automatic scaling treats as 1x.
  AutoRenderScaleEdge* = 600.0
  MaxRenderScale* = 4.0

proc autoRenderScale*(width, height: int): float =
  ## The automatic scale for a panel: its shorter edge over 600 px, rounded
  ## down to a quarter, at least 1.
  let edge = min(width, height)
  if edge <= 0:
    return 1.0
  max(1.0, floor(edge.float / AutoRenderScaleEdge * 4.0) / 4.0)

proc parseRenderScale*(value: JsonNode): float =
  ## Lenient like the refresh interval: control forms deliver numbers as
  ## strings. 0 for anything that is not a scale (0 itself means "not set").
  if value.isNil:
    return 0.0
  var scale = 0.0
  case value.kind
  of JInt: scale = value.getInt().float
  of JFloat: scale = value.getFloat()
  of JString:
    try:
      scale = parseFloat(value.getStr().strip())
    except ValueError:
      return 0.0
  else:
    return 0.0
  if scale > 0.0 and scale <= MaxRenderScale: scale else: 0.0

proc renderScaleFieldKey*(fields: seq[StateField]): string =
  ## The state key of the scene's first field with role renderScale, "" when
  ## it declares none. (No implicit field is added: most scenes never need
  ## the control, unlike the refresh interval.)
  for field in fields:
    if not field.isNil and field.role == RenderScaleRole:
      return field.name
  ""

proc frameRenderScale*(config: FrameConfig): float =
  ## The frame's scale: its own setting, or the automatic one for its panel.
  if config.isNil:
    return 1.0
  if config.renderScale > 0.0 and config.renderScale <= MaxRenderScale:
    return config.renderScale
  autoRenderScale(config.width, config.height)

proc sceneRenderScale*(scene: FrameScene): float =
  ## The scene's own override: its role field's state, else its setting. 0 =
  ## none, the frame's applies.
  if scene.isNil:
    return 0.0
  if scene.renderScaleKey.len > 0 and not scene.state.isNil and
      scene.state.kind == JObject and scene.state.hasKey(scene.renderScaleKey):
    let fromState = parseRenderScale(scene.state[scene.renderScaleKey])
    if fromState > 0.0:
      return fromState
  if scene.renderScaleSetting > 0.0 and scene.renderScaleSetting <= MaxRenderScale:
    return scene.renderScaleSetting
  0.0

proc effectiveRenderScale*(scene: FrameScene, config: FrameConfig): float =
  let own = sceneRenderScale(scene)
  if own > 0.0: own else: frameRenderScale(config)

proc scaledLength*(length: int, scale: float): int =
  ## A panel length as a scaled app sees it: never below 1.
  if scale <= 0.0 or scale == 1.0:
    return length
  max(1, int(round(length.float / scale)))
