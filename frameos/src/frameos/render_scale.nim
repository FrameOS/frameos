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
##   `render_scale`), where 0 is automatic: the largest of 1, 1.25, 1.5, 2,
##   2.5, 3 and 4 that leaves a layout 640 px on the panel's shorter edge
##   (1080 on HDMI, a screen seen from across a room), 1 where there is no
##   panel. An 800x480 or 1024x600 panel stays at 1, the 1872x1404 of a
##   10.3" e-paper is 2, a 4K screen on HDMI 2.
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
  ## The layout's shorter edge the automatic scale leaves at least: a panel
  ## held or hung near (the 800x480 most scenes are made for, with room to
  ## spare), and HDMI, a screen seen from across a room (1080: a 4K one is 2).
  PanelRoom = 640
  HdmiRoom = 1080
  ## What the automatic scale picks from, the settings' steps from 1 up.
  AutoSteps = [1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0]
  MaxRenderScale* = 4.0

proc autoRenderScale*(width, height: int, device: string): float =
  ## The automatic scale: the largest step that leaves a layout `PanelRoom`
  ## px on the panel's shorter edge (`HdmiRoom` on HDMI); 1 without a panel.
  result = 1.0
  if device.len == 0 or device == NoPanel:
    return
  let room = if device == HdmiDevice: HdmiRoom else: PanelRoom
  let edge = min(width, height)
  for step in AutoSteps:
    if edge.float >= room.float * step:
      result = step

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

proc frameRenderScale*(config: FrameConfig): float {.inline.} =
  ## The frame's scale: its own setting, or the automatic one for its panel.
  if config.isNil:
    return 1.0
  let own = usableScale(config.renderScale)
  if own > 0.0: own else: autoRenderScale(config.width, config.height, config.device)

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
