## The layout chosen on the frame itself, in its settings page, and what its
## own settings were set to there (docs/scene-layouts.md "On the frame").
##
## A device cannot rewrite the scenes it was given, so the choice stands beside
## them: unset, every scene wears what the control plane said; set, every scene
## wears this one, or none. It is the frame's to keep and no plane is told, like
## its Wi-Fi network. Hosts keep it where they keep scene state.

import std/[algorithm, json, strutils]

type LayoutEntry* = object
  id*, name*: string
  desktop*: bool ## `settings.desktop`: it runs the frame's scenes in windows

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
  missing {.threadvar.}: seq[string]
  missingAt {.threadvar.}: int
  sceneSetGeneration: int
    ## Bumped by every new scene set, on whichever thread takes it; each
    ## thread's `missing` is good for one generation. A plain int: a racy read
    ## costs one more lookup, never a wrong layout.

proc layoutsInOrder*(layouts: seq[LayoutEntry]): seq[LayoutEntry] =
  ## The frame page's order: the desktops, then the layouts around one scene,
  ## each by name. A host lists them as it holds them (a table's order on a Pi).
  result = layouts
  result.sort(proc (a, b: LayoutEntry): int =
    result = cmp(b.desktop, a.desktop)
    if result == 0: result = cmpIgnoreCase(a.name, b.name)
    if result == 0: result = cmp(a.id, b.id))

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

proc layoutOnFrame(id: string): bool =
  ## Whether the frame holds this layout: a choice outlives the scenes it was
  ## made among, and a push can take its layout away.
  if layoutListing.isNil:
    return true
  for entry in layoutListing():
    if entry.id == id:
      return true
  false

proc layoutFor*(own: string): string =
  ## The layout a scene wears, `own` being the one it was given; "" for none.
  ## A chosen layout the frame no longer holds stands down for each scene's
  ## own: worn, it was looked up on every pass and every scene drew without
  ## any (an ESP32 logged `layout:missing` and read flash for it each render;
  ## the SenseCAP Indicator, the hardware bench, 2026-11-15). The choice is
  ## kept, so the layout coming back puts it on again.
  let active = chosenLayout()
  if active.len == 0: own
  elif active == NoLayout: ""
  elif not layoutOnFrame(active): own
  else: active

proc forgetMissingLayouts*() =
  ## A new scene set: a layout that was missing may be in it. Hosts call this
  ## where the set changes (a pushed or deployed set, an ESP32's catalog off
  ## flash), never on a switch between the scenes of one set.
  inc sceneSetGeneration

proc layoutMissing*(id: string): bool =
  ## Whether this layout was looked for since the scene set changed and was
  ## not there: not looked up again, and not logged again, by any scene that
  ## wears it. Per scene instance was not enough: an ESP32 starts its scene
  ## anew at every switch, and a set whose push it could not take left every
  ## scene reading flash for a layout that was gone and logging
  ## `layout:missing` at each start (the reTerminal E1004, the hardware bench,
  ## 2026-11-16).
  if missingAt != sceneSetGeneration:
    missingAt = sceneSetGeneration
    missing.setLen(0)
  id in missing

proc noteLayoutMissing*(id: string): bool =
  ## Remember that this layout is not on the frame; true the first time, when
  ## it is to be said.
  if layoutMissing(id):
    return false
  missing.add id
  true
