## A scene that asks its layout for the whole panel (docs/scene-layouts.md
## "Full screen").
##
## A layout draws chrome around the scene it wraps: a bar, a dock, a window. A
## reader, a photo or a clock face may want none of it, and the person at the
## frame decides that in the scene's own settings:
##
## - a field with `role: "fullScreen"` whose state is true or false (so the
##   scene settings on the frame, a control panel or frameos.setState change
##   it), else
## - the scene's `settings.fullScreen`, else false.
##
## The layout hears it as `app.frame.fullScreen` and gives the scene the panel
## by returning a bare `<yield />`, as it does for the built-in scenes. It is a
## request: a layout that has no chrome to take away, or a desktop of windows,
## may ignore it. The same rule lives in `frontend/src/utils/fullScreen.ts`.

import std/json
import frameos/types

const FullScreenRole* = "fullScreen"

proc fullScreenFieldKey*(fields: seq[StateField]): string =
  ## The state key of the scene's first field with role fullScreen, "" when
  ## it declares none.
  for field in fields:
    if not field.isNil and field.role == FullScreenRole:
      return field.name
  ""

proc sceneWantsFullScreen*(scene: FrameScene): bool =
  ## The scene's own answer: its role field's state, else its setting. A
  ## field's state comes as a boolean or as its text ("true", "false");
  ## anything else is not set.
  if scene.isNil:
    return false
  if scene.fullScreenKey.len > 0:
    let value = scene.state{scene.fullScreenKey}
    if not value.isNil:
      case value.kind
      of JBool: return value.getBool()
      of JString:
        case value.getStr()
        of "true": return true
        of "false": return false
        else: discard
      else: discard
  scene.fullScreenSetting
