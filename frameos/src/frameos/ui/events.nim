## The pointer over JSX UIs (docs/jsx-ui.md "Events"): where the last render
## of each one put the elements the pointer can do something to, and what a
## tap, a press or a move over them does.
##
## One target per app node that draws a UI. The interpreter hands it the
## pointer events of its scene (runEventInner, every host) and renders again
## when one changed something: a handler ran, or the elements the pointer is
## over or pressing are not the ones the last render drew. The next layout
## reads those (`input`) for its hover:, active: and group-hover: classes.

import std/json
import frameos/ui/layout

type
  UiHandlerCall* = proc(handler: int, name: string, event: JsonNode, localX, localY: float32) {.closure, raises: [].}
    ## Runs handler number `handler` of the UI's last render, in its app,
    ## with the event and where in the element it landed.

  UiTarget* = ref object
    sceneId*: string
    nodeId*: int
    offsetX*, offsetY*: float32 ## the UI's corner in the scene's canvas
    regions*: seq[UiRegion]     ## the last render's, in paint order
    input*: UiInput             ## what the pointer is doing, for the next one
    call*: UiHandlerCall

const MaxTargets = 16

var targets {.threadvar.}: seq[UiTarget]

proc uiTarget*(sceneId: string, nodeId: int, create = true): UiTarget =
  ## The target of an app node's UI; nil when it has none and `create` is off.
  for target in targets:
    if target.sceneId == sceneId and target.nodeId == nodeId:
      return target
  if create:
    if targets.len >= MaxTargets:
      targets.delete(0)
    result = UiTarget(sceneId: sceneId, nodeId: nodeId)
    targets.add result

proc handlerKind(event: string): int =
  ## The UiEvent a pointer event runs handlers for, or -1.
  case event
  of "tap": ord(ueClick)
  of "doubleTap": ord(ueDoubleClick)
  of "longPress": ord(ueLongPress)
  of "pointerDown": ord(uePointerDown)
  of "pointerUp": ord(uePointerUp)
  else: -1

proc wants(r: UiRegion, event: string): bool =
  case event
  of "pointerMove": r.hover or r.group
  of "pointerDown", "pointerUp", "pointerCancel":
    r.active or r.hover or r.group or r.handlers[uePointerDown] > 0 or r.handlers[uePointerUp] > 0
  else:
    let kind = handlerKind(event)
    kind >= 0 and r.handlers[UiEvent(kind)] > 0

proc uiListens*(sceneId, event: string): bool =
  ## Whether a UI in the scene wants `event`: the dispatcher builds a pointer
  ## event only for a scene that listens (event_loop.nim).
  for target in targets:
    if target.sceneId == sceneId:
      for r in target.regions:
        if r.wants(event):
          return true

proc keysOver(target: UiTarget, lx, ly: float32, active: bool): seq[int] =
  ## The elements under the point: hover ones (and groups), or active ones.
  for r in target.regions:
    if (if active: r.active else: r.hover or r.group) and
        lx >= r.x and ly >= r.y and lx < r.x + r.w and ly < r.y + r.h:
      result.add r.key

proc dispatchUiEvent*(sceneId, event: string, payload: JsonNode): bool =
  ## Hands a pointer event to the scene's UIs. True when the frame should
  ## render again: a handler ran (whatever it changed, the picture is the
  ## UI's), or what the pointer is over or pressing changed.
  let
    released = event in ["pointerUp", "pointerCancel"]
    placed = not payload.isNil and payload.kind == JObject and payload.hasKey("x") and payload.hasKey("y")
    x = if placed: payload["x"].getFloat() else: 0
    y = if placed: payload["y"].getFloat() else: 0
    touch = placed and payload{"pointerType"}.getStr() == "touch"
    kind = handlerKind(event)
  var handled = false
  for target in targets:
    if target.sceneId != sceneId:
      continue
    if released:
      if target.input.pressed.len > 0:
        target.input.pressed.setLen(0)
        result = true
      # A finger that lifts is not over anything any more.
      if touch and target.input.hovered.len > 0:
        target.input.hovered.setLen(0)
        result = true
    if not placed:
      continue
    let
      lx = x - target.offsetX
      ly = y - target.offsetY
    if event in ["pointerMove", "pointerDown"]:
      let hovered = target.keysOver(lx, ly, false)
      if hovered != target.input.hovered:
        target.input.hovered = hovered
        result = true
      if event == "pointerDown":
        let pressed = target.keysOver(lx, ly, true)
        if pressed != target.input.pressed:
          target.input.pressed = pressed
          result = true
    if handled or kind < 0 or target.call.isNil:
      continue
    # The innermost element with a handler for it: the last one painted.
    for i in countdown(target.regions.high, 0):
      let r = target.regions[i]
      let handler = r.handlers[UiEvent(kind)]
      if handler > 0 and lx >= r.x and ly >= r.y and lx < r.x + r.w and ly < r.y + r.h:
        target.call(handler - 1, event, payload, lx - r.x, ly - r.y)
        handled = true
        result = true
        break
