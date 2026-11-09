## The layout chosen on the frame itself, in its settings page, and what its
## own settings were set to there (docs/scene-layouts.md "On the frame").
##
## A device cannot rewrite the scenes it was given, so the choice stands beside
## them: unset, every scene wears what the control plane said; set, every scene
## wears this one, or none. It is the frame's to keep and no plane is told, like
## its Wi-Fi network. Hosts keep it where they keep scene state.

import std/json

type LayoutEntry* = object
  id*, name*: string

const
  NoLayout* = "none" ## the choice that takes every layout away
  ChoiceStateId = "frame-layout"

var
  layoutListing*: proc(): seq[LayoutEntry] {.nimcall, gcsafe.}
    ## The layouts on the frame: the interpreter's, or an ESP32's list off flash.
  layoutStateRead*: proc(id: string): JsonNode {.nimcall, gcsafe.}
  layoutStateWrite*: proc(id: string, state: JsonNode) {.nimcall, gcsafe.}
  saved {.threadvar.}: JsonNode
  chosen {.threadvar.}: string
  chosenRead {.threadvar.}: bool

proc savedLayoutState*(id: string): JsonNode =
  ## What was set on the frame for this layout; nil for nothing.
  if not saved.isNil:
    result = saved{id}
  if result.isNil and not layoutStateRead.isNil:
    result = layoutStateRead(id)

proc saveLayoutState*(id: string, state: JsonNode) =
  if saved.isNil:
    saved = newJObject()
  saved[id] = state
  if not layoutStateWrite.isNil:
    layoutStateWrite(id, state)

proc chosenLayout*(): string =
  ## "" for each scene's own, `NoLayout`, or a layout's id.
  if not chosenRead:
    chosenRead = true
    chosen = savedLayoutState(ChoiceStateId){"active"}.getStr()
  chosen

proc chooseLayout*(layoutId: string) =
  chosenRead = true
  chosen = layoutId
  let state = newJObject()
  state["active"] = newJString(layoutId)
  saveLayoutState(ChoiceStateId, state)

proc layoutFor*(own: string): string =
  ## The layout a scene wears, `own` being the one it was given; "" for none.
  let active = chosenLayout()
  if active.len == 0: own
  elif active == NoLayout: ""
  else: active
