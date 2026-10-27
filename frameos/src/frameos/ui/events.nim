## The pointer over JSX UIs (docs/jsx-ui.md "Events"): where the last render
## of each one put the elements the pointer can do something to, and what a
## tap, a press or a move over them does.
##
## One target per app node that draws a UI. The interpreter hands it the
## pointer events of its scene (runEventInner, every host) and renders again
## when one changed something: a handler ran, or the elements the pointer is
## over or pressing are not the ones the last render drew. The next layout
## reads those (`input`) for its hover:, active: and group-hover: classes.
##
## A press is captured, as a browser captures a touch: the innermost element
## with an onPointerDown or onPointerMove under it gets that pointer's moves
## and its release until it lifts, wherever they land (`captures`), with
## localX / localY still from its corner, so a slider follows a finger that
## slides off its end. A move with no press goes to the element under it.

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
    memo*: UiMemo               ## the last layout's type, for the next one
    inputOnly*: bool            ## the pointer changed what it is over or
                                ## pressing, and no handler ran: the next
                                ## render needs no new tree (app_runtime.get)
    captures*: seq[(int, int)]  ## (pointerId, region key) of each press held
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
    result = UiTarget(sceneId: sceneId, nodeId: nodeId, memo: UiMemo())
    targets.add result

proc forgetUiTarget*(sceneId: string, nodeId: int) =
  ## The app node's scene is torn down: its regions, what the pointer was
  ## doing over them and its way into the app go with it. A target kept
  ## called the app the scene had before, which was gone.
  for i in countdown(targets.high, 0):
    if targets[i].sceneId == sceneId and targets[i].nodeId == nodeId:
      targets.delete(i)

proc uiSceneEvent*(sceneId: string) =
  ## Anything but the pointer happened to the scene (a state change, a
  ## button, a scheduled event): its UIs' next render runs get() again.
  for target in targets:
    if target.sceneId == sceneId:
      target.inputOnly = false

proc handlerKind(event: string): int =
  ## The UiEvent a pointer event runs handlers for, or -1.
  case event
  of "tap": ord(ueClick)
  of "doubleTap": ord(ueDoubleClick)
  of "longPress": ord(ueLongPress)
  of "pointerDown": ord(uePointerDown)
  of "pointerUp": ord(uePointerUp)
  of "pointerMove": ord(uePointerMove)
  of "swipe": ord(ueSwipe)
  else: -1

proc wants(r: UiRegion, event: string): bool =
  case event
  of "pointerMove": r.hover or r.group or r.handlers[uePointerMove] > 0
  of "pointerDown", "pointerUp", "pointerCancel":
    r.active or r.hover or r.group or r.handlers[uePointerDown] > 0 or
      r.handlers[uePointerUp] > 0 or r.handlers[uePointerMove] > 0
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

proc captureOf(target: UiTarget, pointer: int): int =
  ## The key of the element holding the pointer's press, -1 for none.
  for (held, key) in target.captures:
    if held == pointer:
      return key
  -1

proc release(target: UiTarget, pointer: int) =
  for i in countdown(target.captures.high, 0):
    if target.captures[i][0] == pointer:
      target.captures.delete(i)

proc dispatchUiEvent*(sceneId, event: string, payload: JsonNode): bool =
  ## Hands a pointer event to the scene's UIs. True when the frame should
  ## render again: a handler ran (whatever it changed, the picture is the
  ## UI's), or what the pointer is over or pressing changed.
  let
    released = event in ["pointerUp", "pointerCancel"]
    placed = not payload.isNil and payload.kind == JObject and payload.hasKey("x") and payload.hasKey("y")
    # A swipe belongs to where it began: a card swiped is the card the finger
    # went down on, wherever it lifted.
    starts = placed and event == "swipe" and payload.hasKey("startX") and payload.hasKey("startY")
    x = if starts: payload["startX"].getFloat() elif placed: payload["x"].getFloat() else: 0
    y = if starts: payload["startY"].getFloat() elif placed: payload["y"].getFloat() else: 0
    touch = placed and payload{"pointerType"}.getStr() == "touch"
    kind = handlerKind(event)
    pointer = if payload.isNil or payload.kind != JObject: 0 else: payload{"pointerId"}.getInt(0)
    follows = event in ["pointerMove", "pointerUp", "pointerCancel"]
  var
    handled = false
    capturing: UiTarget # the UI holding this pointer's press, if one does
  if follows:
    for target in targets:
      if target.sceneId == sceneId and target.captureOf(pointer) >= 0:
        capturing = target
        break
  for target in targets:
    if target.sceneId != sceneId:
      continue
    var moved = false
    let captured = if follows: target.captureOf(pointer) else: -1
    if released:
      target.release(pointer)
      if target.input.pressed.len > 0:
        target.input.pressed.setLen(0)
        moved = true
      # A finger that lifts is not over anything any more.
      if touch and target.input.hovered.len > 0:
        target.input.hovered.setLen(0)
        moved = true
    let
      lx = x - target.offsetX
      ly = y - target.offsetY
    if placed and event in ["pointerMove", "pointerDown"]:
      let hovered = target.keysOver(lx, ly, false)
      if hovered != target.input.hovered:
        target.input.hovered = hovered
        moved = true
      if event == "pointerDown":
        let pressed = target.keysOver(lx, ly, true)
        if pressed != target.input.pressed:
          target.input.pressed = pressed
          moved = true
        # The innermost element that takes a press holds the pointer.
        target.release(pointer)
        for i in countdown(target.regions.high, 0):
          let r = target.regions[i]
          if (r.handlers[uePointerDown] > 0 or r.handlers[uePointerMove] > 0) and
              lx >= r.x and ly >= r.y and lx < r.x + r.w and ly < r.y + r.h:
            target.captures.add((pointer, r.key))
            break
    if moved:
      target.inputOnly = true
      result = true
    if not placed or handled or kind < 0 or target.call.isNil:
      continue
    if not capturing.isNil:
      # A held press: its moves and its release go to the element that took
      # it, inside its box or not, and to nothing else.
      if captured >= 0:
        for r in target.regions:
          if r.key == captured:
            let handler = r.handlers[UiEvent(kind)]
            if handler > 0:
              target.call(handler - 1, event, payload, lx - r.x, ly - r.y)
              target.inputOnly = false # whatever the handler changed, get() shows it
              handled = true
              result = true
            break
      continue
    # The innermost element with a handler for it: the last one painted.
    for i in countdown(target.regions.high, 0):
      let r = target.regions[i]
      let handler = r.handlers[UiEvent(kind)]
      if handler > 0 and lx >= r.x and ly >= r.y and lx < r.x + r.w and ly < r.y + r.h:
        target.call(handler - 1, event, payload, lx - r.x, ly - r.y)
        target.inputOnly = false # whatever the handler changed, get() shows it
        handled = true
        result = true
        break
