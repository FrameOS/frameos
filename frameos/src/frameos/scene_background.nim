## A scene's background: the color under everything it draws, owed at the
## start of a render and paid only where something does not cover the canvas
## (ExecutionContext.backgroundPending). A photo shown whole on a screen of
## another shape shows it as bars.
##
## The color in effect is:
##
## - a field with `role: "backgroundColor"` whose state holds a color (so a
##   control panel or frameos.setState can change it), else
## - the scene's `settings.backgroundColor`.
##
## No implicit field is added, unlike the refresh interval: a scene offers
## the control only where it means something (a slideshow's bars). Being the
## background itself, it costs nothing when the picture covers the canvas.
## The same rule lives in `frontend/src/utils/sceneBackground.ts`.

import std/[json, strutils]
import pixie
import frameos/types

const
  BackgroundColorRole* = "backgroundColor"

proc backgroundColorFieldKey*(fields: seq[StateField]): string =
  ## The state key of the scene's first field with role backgroundColor, ""
  ## when it declares none.
  for field in fields:
    if not field.isNil and field.role == BackgroundColorRole:
      return field.name
  ""

proc isHexColor(text: string): bool =
  ## "#rgb" or "#rrggbb", what a color field holds; anything else is not a
  ## background (a typo in a control form must not fail the render).
  if text.len != 4 and text.len != 7 or text[0] != '#':
    return false
  for i in 1 ..< text.len:
    if text[i] notin HexDigits:
      return false
  true

proc sceneBackgroundColor*(scene: FrameScene): Color =
  ## The background in effect: the role field's color, else the setting.
  if scene.isNil:
    return color(0, 0, 0)
  if scene.backgroundColorKey.len > 0:
    # `{}` is nil for a missing key and for a state that is not an object.
    let value = scene.state{scene.backgroundColorKey}
    if not value.isNil and value.kind == JString and isHexColor(value.str):
      return parseHtmlColor(value.str)
  scene.backgroundColor
