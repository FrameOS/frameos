## The scene store on the frame's own screen (docs/scene-store-on-frame.md):
## two pages of the scene switcher (system/sceneSwitcher/scene.nim). The
## store page, behind the switcher's last tile, lists the cloud store's
## scenes a page at a time with a search field and the shelves, each with
## Preview and Install (Show or Update once installed). The scene's page, a
## long press on a tile, says where the scene came from and offers Show,
## Update and Delete (Install and Discard for a preview).
##
## The page has the words; the host has the facts and does the work, off the
## render task (`sceneStoreRead` / `sceneStoreAction`: the Pi's
## frameos/scene_store_linux.nim, the ESP32's main/fos_store.c through
## embedded_runtime.nim). A frame with a control plane asks it (the cloud's
## and the backend's `/api/frames/{id}/panel/scenes`), so the scene lands in
## the list the plane holds and a push brings it; a frame with none installs
## it itself. The host answers nil when there is no store on this frame: none
## offered (the preview), or the owner turned the settings on the screen
## off.
##
## Flash is the budget on an ESP32 (AGENTS.md): one handler for everything
## (numbered), classes appended in place, JSON arrays read through `elems`
## once their kind is known, and no Nim checks in this module.

import std/[json, tables]
import pixie/fileformats/svg
import frameos/ui/tree

{.push overflowChecks: off, rangeChecks: off, boundChecks: off, fieldChecks: off, stackTrace: off,
  lineTrace: off.}

type
  SceneStoreRead* = proc (): JsonNode {.nimcall, gcsafe, raises: [].}
    ## nil: no store on this frame. Else what the host knows now:
    ## {busy, error, done: an action's name or "" (`error` a code: the
    ## words are here), query, category, page, listing: the store's page
    ## ({page, more, scenes: [{id, name, category, version, by}],
    ## categories: [{slug, title}]}) or null, installed: [{id, store, v}] (every scene
    ## on the frame that came from the store: its runtime id, store scene id
    ## and version), preview: {store, id, name} or null, info: {id, store,
    ## scene: the store's answer for it or null}, removeAny: a scene not
    ## from the store may be removed too (a frame with no control plane)}.
  SceneStoreAction* = proc (action: string, args: JsonNode) {.nimcall, gcsafe, raises: [].}
    ## open, browse {q, category, page}, info {id, store}, preview {store,
    ## name, from}, install {store, name}, update {id, store}, remove {id,
    ## store}, discard. The host asks for a render when what it knows
    ## changed.

  StoreLook* = object
    ## What every element on the two pages shares: e-paper or an LCD, the
    ## text size and the room around things.
    paper*: bool
    size*, small*, pad*, gap*, line*: int

  StoreMove* = enum
    smNone ## nothing for the switcher to do but render
    smTiles ## back to the tiles
    smShow ## show the scene `id`

var
  sceneStoreRead*: SceneStoreRead
  sceneStoreAction*: SceneStoreAction

const
  HBack* = 10_000
  HSearch* = 10_001 ## the search button, and Enter in the field
  HQuery* = 10_002 ## the field's text, as it is typed
  HCategory* = 10_003
  HPrevPage* = 10_004
  HNextPage* = 10_005
  HPreview* = 11_000 ## + the row
  HInstall* = 12_000
  HShow* = 13_000
  HUpdate* = 14_000
  HInfoShow* = 15_000
  HInfoUpdate* = 15_001
  HInfoRemove* = 15_002
  HInfoInstall* = 15_003
  HInfoDiscard* = 15_004
  Ellipsis = "\xe2\x80\xa6"
  Busy = ["browse", "Loading", "install", "Installing", "preview", "Opening the preview",
    "update", "Updating", "remove", "Deleting", "discard", "Discarding"]
  Done = ["install", "Installed. The frame shows it in a moment.",
    "preview", "The frame shows the preview in a moment.",
    "update", "Updated. The frame shows the new version in a moment.",
    "uptodate", "This is the newest version.",
    "remove", "Deleted.", "discard", "Discarded."]
  Errors = ["offline", "The frame is not online.",
    "store_unavailable", "The scene store did not answer. Try again later.",
    "too_many_scenes", "The frame holds as many scenes as it can. Delete one first.",
    "last_scene", "A frame keeps one scene at least.",
    "panel_locked", "Changes on the frame's screen are turned off for this frame.",
    "frame_update_required", "This scene needs a newer FrameOS. Update the frame first.",
    "no_room", "There is no room on the frame for this scene.",
    "scene_not_allowed", "This scene cannot be installed on a frame.",
    "rate_limited", "Too many changes at once. Try again in a few minutes.",
    "invalid_scene", "The store no longer offers this scene."]

proc put(node: JsonNode, key: string, value: JsonNode) {.inline.} =
  ## `node[key] = value` for an object node, without json's assert.
  node.fields[key] = value

proc storeFacts*(): JsonNode =
  ## What the host knows; nil when there is no store on this frame.
  if not sceneStoreRead.isNil:
    result = sceneStoreRead()
    if not result.isNil and result.kind != JObject:
      result = nil

let noItems = newJArray()

proc items(node: JsonNode): JsonNode =
  ## `node` when it is an array, else an empty one: read through `elems`.
  if not node.isNil and node.kind == JArray: node else: noItems

proc storeAct*(action: string, store = "", id = "", name = "", origin = "") =
  ## One shape for every action, its unused keys empty: the store scene, the
  ## scene on the frame (the host finds its store scene), the name a preview
  ## shows, the scene it covers.
  if not sceneStoreAction.isNil:
    let args = newJObject()
    args.put("store", newJString(store))
    args.put("id", newJString(id))
    args.put("name", newJString(name))
    args.put("from", newJString(origin))
    sceneStoreAction(action, args)

proc browse(key, value: string, page: int) =
  ## The store's page `page`, with `key` (q, category) set to `value`.
  if not sceneStoreAction.isNil:
    let args = newJObject()
    if key.len > 0:
      args.put(key, newJString(value))
    args.put("page", newJString($page))
    sceneStoreAction("browse", args)

proc found*(facts: JsonNode, key, value: string): JsonNode =
  ## The first `installed` row whose `key` (id, store) is `value`, or nil.
  let rows = items(facts{"installed"})
  for i in 0 ..< rows.elems.len:
    if rows.elems[i]{key}.getStr() == value:
      return rows.elems[i]

proc previewing*(facts: JsonNode, key, value: string): bool =
  ## Whether the frame's preview has `key` (store, id) `value`.
  let preview = facts{"preview"}
  not preview.isNil and preview.kind == JObject and preview{key}.getStr() == value

proc lookup(table: openArray[string], key: string): string =
  var i = 0
  while i + 1 < table.len:
    if table[i] == key:
      return table[i + 1]
    i += 2

proc note(facts: JsonNode): string =
  ## What the page says under the search: what is running, what went wrong,
  ## what just worked.
  let
    busy = facts{"busy"}.getStr()
    error = facts{"error"}.getStr()
  if busy.len > 0:
    if busy != "info":
      result = lookup(Busy, busy)
      result.add Ellipsis
  elif error.len > 0:
    result = lookup(Errors, error)
    if result.len == 0:
      result = "That did not work (" & error & ")."
  else:
    result = lookup(Done, facts{"done"}.getStr())

# --------------------------------------------------------------- the picture

proc txt(text: sink string): SvgNode = SvgNode(text: text)

proc on(node: sink SvgNode, attr: string, handler: int): SvgNode =
  node.attrs.add((attr, $handler))
  node

proc button(look: StoreLook, label: string, handler: int, primary: bool, focus: var seq[int],
    lit: int): SvgNode =
  ## A round button; ringed (inverted on e-paper) while the keys are on it.
  var c = "shrink-0 flex items-center rounded-full font-bold whitespace-nowrap"
  c.px("h", look.line * 4 div 5)
  c.px("px", look.size * 3 div 4)
  let keyed = focus.len == lit
  if look.paper:
    c.add(if keyed: " bg-black text-white" else: " border-2 border-black")
  else:
    if primary: c.add " bg-sky-600 active:bg-sky-500"
    else: c.add " bg-zinc-800 active:bg-zinc-600"
    if keyed: c.add " border-2 border-white"
  focus.add handler
  el("div", move c, txt(label)).on("on-click", handler)

proc grey(look: StoreLook, c: var string) =
  if not look.paper: c.add " text-zinc-400"

proc header(look: StoreLook, title: string, focus: var seq[int], lit: int): SvgNode =
  ## Back, the page's name, and room for the page's arrows after it.
  var c = "shrink-0 flex items-center"
  c.px("h", look.line * 3 div 2)
  c.px("px", look.pad)
  c.px("gap", look.gap div 2)
  c.add(if look.paper: " border-b-2 border-black" else: " border-b border-zinc-800")
  result = el("div", move c)
  result.children.add look.button("Back", HBack, false, focus, lit)
  result.children.add el("span", "grow truncate text-center font-bold", txt(title))

proc frame(look: StoreLook): SvgNode =
  var c = "flex flex-col h-full"
  c.px("text", look.size)
  if not look.paper: c.add " bg-zinc-950 text-white"
  el("div", move c)

proc fieldBox(look: StoreLook): string =
  result = "rounded-lg"
  result.px("h", look.line)
  result.px("px", look.size * 2 div 3)
  if look.paper: result.add " border-2 border-black"
  else: result.add " bg-zinc-800 focus:bg-zinc-700 placeholder:text-zinc-500"

proc categories(facts: JsonNode): JsonNode =
  ## The shelves: the host's, else the ones the store's last answer carried.
  result = items(facts{"categories"})
  if result.elems.len == 0:
    result = items(facts{"listing", "categories"})

proc about(facts, scene: JsonNode): string =
  ## "Weather · by Ana": a store scene's shelf and publisher.
  let
    slug = scene{"category"}.getStr()
    shelves = facts.categories
    by = scene{"by"}.getStr()
  result = slug
  for i in 0 ..< shelves.elems.len:
    if shelves.elems[i]{"slug"}.getStr() == slug:
      result = shelves.elems[i]{"title"}.getStr()
  if by.len > 0:
    if result.len > 0: result.add " \xc2\xb7 "
    result.add "by "
    result.add by

proc categorySelect(look: StoreLook, facts: JsonNode): SvgNode =
  var c = fieldBox(look)
  c.add " w-full"
  result = el("select", move c).on("on-change", HCategory)
  result.attrs.add(("value", facts{"category"}.getStr()))
  let shelves = facts.categories
  for i in -1 ..< shelves.elems.len:
    let option = el("option", "rounded-lg",
      txt(if i < 0: "All scenes" else: shelves.elems[i]{"title"}.getStr()))
    option.attrs.add(("value", if i < 0: "" else: shelves.elems[i]{"slug"}.getStr()))
    result.children.add option

proc small(look: StoreLook, text: sink string): SvgNode =
  ## A quieter line in the page's small size.
  var c = "truncate"
  look.grey(c)
  c.px("text", look.small)
  el("span", move c, txt(text))

proc sceneRow(look: StoreLook, facts, scene: JsonNode, row: int, focus: var seq[int], lit: int): SvgNode =
  ## One store scene: its name, its shelf and publisher, and what can be
  ## done with it here.
  var c = "flex items-center"
  c.px("gap", look.gap div 2)
  c.px("py", look.gap div 3)
  c.add(if look.paper: " border-b border-black" else: " border-b border-zinc-800")
  result = el("div", move c)
  let
    store = scene{"id"}.getStr()
    installed = facts.found("store", store)
    previewed = facts.previewing("store", store)
    version = if installed.isNil: 0 else: installed{"v"}.getInt(0)
  var line = facts.about(scene)
  if not installed.isNil: line.add " \xc2\xb7 installed"
  elif previewed: line.add " \xc2\xb7 previewing"
  let text = el("div", "grow min-w-0 flex flex-col", el("span", "truncate font-bold", txt(scene{"name"}.getStr())))
  text.children.add look.small(line)
  result.children.add text
  if installed.isNil:
    if not previewed:
      result.children.add look.button("Preview", HPreview + row, false, focus, lit)
    result.children.add look.button("Install", HInstall + row, true, focus, lit)
  else:
    if version > 0 and scene{"version"}.getInt(0) > version:
      result.children.add look.button("Update", HUpdate + row, true, focus, lit)
    result.children.add look.button("Show", HShow + row, false, focus, lit)

proc storeTree*(state, facts: JsonNode, look: StoreLook, width: int, focus: var seq[int]): SvgNode =
  ## The store page: Back and the pages' arrows, the search and the shelves,
  ## what is running or went wrong, and a page of scenes that scrolls.
  ## `focus` gets the buttons in order, for the keys; the one at
  ## `state.focus` is lit.
  let
    lit = state{"focus"}.getInt(-1)
    listing = facts{"listing"}
    page = facts{"page"}.getInt(1)
    header = look.header("Scene store", focus, lit)
    draft = state{"draft"}
  result = look.frame()
  if page > 1:
    header.children.add look.button("Previous", HPrevPage, false, focus, lit)
  if listing{"more"}.getBool():
    header.children.add look.button("More", HNextPage, false, focus, lit)
  result.children.add header
  var c = "shrink-0 flex flex-col"
  c.px("px", look.pad)
  c.px("pt", look.gap div 2)
  c.px("gap", look.gap div 2)
  let tools = el("div", move c)
  var field = fieldBox(look)
  field.add " flex-1 min-w-0"
  let input = el("input", move field).on("on-change", HQuery).on("on-key-down", HSearch)
  input.attrs.add(("value", if draft.isNil: facts{"query"}.getStr() else: draft.getStr()))
  input.attrs.add(("placeholder", "Search scenes"))
  c = "flex items-center"
  c.px("gap", look.gap div 2)
  let search = el("div", move c, input)
  search.children.add look.button("Search", HSearch, true, focus, lit)
  tools.children.add search
  if facts.categories.elems.len > 0:
    tools.children.add look.categorySelect(facts)
  let note = facts.note()
  if note.len > 0:
    tools.children.add look.small(note)
  result.children.add tools
  c = "flex flex-col"
  c.px("px", look.pad)
  c.px("pb", look.pad)
  let list = el("div", move c)
  let scenes = items(listing{"scenes"})
  for i in 0 ..< scenes.elems.len:
    list.children.add look.sceneRow(facts, scenes.elems[i], i, focus, lit)
  if scenes.elems.len == 0 and facts{"busy"}.getStr().len == 0:
    list.children.add look.small(if listing.isNil or listing.kind != JObject:
      "The store's scenes show here once the frame is online." else: "No scenes found.")
  result.children.add el("div", "flex-1 overflow-y-auto", list)

proc infoTree*(state, facts: JsonNode, look: StoreLook, sceneId, name: string, showing: bool,
    focus: var seq[int]): SvgNode =
  ## A scene's page: where it came from and what can be done with it.
  let
    lit = state{"focus"}.getInt(-1)
    asking = state{"confirm"}.getInt(-1)
    installed = facts.found("id", sceneId)
    preview = facts.previewing("id", sceneId)
    known = facts{"info", "id"}.getStr() == sceneId
    scene = if known: facts{"info", "scene"} else: nil
    told = not scene.isNil and scene.kind == JObject
    version = if installed.isNil: 0 else: installed{"v"}.getInt(0)
    latest = if told: scene{"version"}.getInt(0) else: 0
    error = facts{"error"}.getStr()
    busy = facts{"busy"}.getStr()
  result = look.frame()
  result.children.add look.header(if name.len > 0: name else: sceneId, focus, lit)
  var c = "flex flex-col"
  c.px("p", look.pad)
  c.px("gap", look.gap div 2)
  let body = el("div", move c)
  # Where it came from, and what the store says of it now.
  var text = if preview: "A preview, not in the frame's scene list until it is installed. "
    elif installed.isNil: "Not from the scene store."
    else: ""
  if not installed.isNil:
    text.add "From the scene store, version "
    text.addInt version
    text.add '.'
  # `move`: Nim 2.2.4 hands a plain string to a sink without clearing it, and
  # the assignment below would free what the node holds.
  body.children.add el("div", "font-bold", txt(move text))
  if not installed.isNil:
    if told:
      body.children.add look.small(facts.about(scene))
      body.children.add el("div", if look.paper: "" else: "text-zinc-400", txt(scene{"description"}.getStr()))
      if latest > version and version > 0:
        text = "Version "
        text.addInt latest
        text.add " is available."
        body.children.add el("div", "", txt(move text))
    elif busy == "info":
      body.children.add look.small("Asking the store about it" & Ellipsis)
    elif known and error == "invalid_scene":
      body.children.add look.small("Not in the public store.")
  # What runs, went wrong or just worked; not the store's answer about the
  # scene, which is above.
  if busy != "info" and not (known and error == "invalid_scene"):
    let note = facts.note()
    if note.len > 0:
      body.children.add look.small(note)
  c = "flex flex-wrap"
  c.px("gap", look.gap div 2)
  c.px("pt", look.gap div 2)
  let buttons = el("div", move c)
  if not showing:
    buttons.children.add look.button("Show", HInfoShow, false, focus, lit)
  if preview:
    buttons.children.add look.button("Install", HInfoInstall, true, focus, lit)
  elif latest > version and version > 0:
    buttons.children.add look.button("Update", HInfoUpdate, true, focus, lit)
  if preview or not installed.isNil or facts{"removeAny"}.getBool():
    let handler = if preview: HInfoDiscard else: HInfoRemove
    let button = look.button(if asking == handler: "Tap again" elif preview: "Discard" else: "Delete",
      handler, false, focus, lit)
    if asking == handler and not look.paper:
      button.attrs[0][1].add " bg-red-600 active:bg-red-500"
    buttons.children.add button
  body.children.add buttons
  result.children.add el("div", "flex-1 overflow-y-auto", body)

# ------------------------------------------------------------------ actions

proc storeHandle*(state, facts: JsonNode, handler: int, text, key, opener: string,
    sceneId: var string): StoreMove =
  ## What a handler of the two pages does. `text` is a field's value, `key`
  ## the key a field heard; `opener` the scene the switcher was opened from
  ## (where a preview's Discard goes back to). `sceneId` gets the scene to
  ## show for `smShow`.
  let
    confirm = state{"confirm"}.getInt(-1)
    info = state{"info"}.getStr()
    scenes = items(facts{"listing", "scenes"})
    row = if handler >= HPreview and handler < HInfoShow: handler mod 1000 else: -1
    base = handler - max(row, 0)
  state.put("confirm", newJInt(-1))
  if row >= scenes.elems.len:
    return smNone
  let
    scene = if row >= 0: scenes.elems[row] else: nil
    store = if row >= 0: scene{"id"}.getStr() else: ""
    held = if row >= 0: facts.found("store", store) else: nil
  if handler == HBack:
    state.put("draft", newJNull())
    result = smTiles
  elif handler == HQuery:
    state.put("draft", newJString(text))
  elif handler == HSearch:
    if key.len == 0 or key == "Enter":
      let draft = state{"draft"}
      browse("q", if draft.isNil: facts{"query"}.getStr() else: draft.getStr(), 1)
  elif handler == HCategory:
    browse("category", text, 1)
  elif handler == HPrevPage or handler == HNextPage:
    browse("", "", max(1, facts{"page"}.getInt(1) + (if handler == HNextPage: 1 else: -1)))
  elif handler == HInfoShow or (base == HShow and not held.isNil):
    sceneId = if row >= 0: held{"id"}.getStr() else: info
    result = smShow
  elif handler == HInfoUpdate:
    storeAct("update", id = info)
  elif handler == HInfoInstall:
    let preview = facts{"preview"}
    storeAct("install", preview{"store"}.getStr(), name = preview{"name"}.getStr())
  elif handler == HInfoRemove or handler == HInfoDiscard:
    # Asked twice. The page stays until the scene is gone from the frame (the
    # switcher goes back to the tiles then), so a refusal shows here.
    if confirm != handler:
      state.put("confirm", newJInt(handler))
    else:
      storeAct(if handler == HInfoDiscard: "discard" else: "remove", id = info)
  elif base == HPreview or base == HInstall:
    storeAct(if base == HPreview: "preview" else: "install", store, name = scene{"name"}.getStr(), origin = opener)
  elif base == HUpdate:
    storeAct("update", store)

{.pop.}
