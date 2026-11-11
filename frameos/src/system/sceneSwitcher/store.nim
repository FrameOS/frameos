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

proc storeAct*(action: string, args: JsonNode = nil) =
  if not sceneStoreAction.isNil:
    sceneStoreAction(action, if args.isNil: newJObject() else: args)

proc arrayOf(node: JsonNode): seq[JsonNode] =
  if not node.isNil and node.kind == JArray: node.elems else: @[]

proc args(pairs: openArray[(string, string)]): JsonNode =
  result = newJObject()
  for (key, value) in pairs:
    result.put(key, newJString(value))

proc installedAs*(facts: JsonNode, sceneId: string): JsonNode =
  ## The `installed` row of the scene with runtime id `sceneId`, or nil.
  for row in arrayOf(facts{"installed"}):
    if row{"id"}.getStr() == sceneId:
      return row

proc installedFrom(facts: JsonNode, store: string): JsonNode =
  ## The first scene on the frame from store scene `store`, or nil.
  for row in arrayOf(facts{"installed"}):
    if row{"store"}.getStr() == store:
      return row

proc previewing*(facts: JsonNode, store = "", sceneId = ""): bool =
  ## Whether the frame previews this store scene, or the scene `sceneId`.
  let preview = facts{"preview"}
  if preview.isNil or preview.kind != JObject:
    return false
  (store.len > 0 and preview{"store"}.getStr() == store) or
    (sceneId.len > 0 and preview{"id"}.getStr() == sceneId)

proc lookup(table: openArray[string], key: string): string =
  var i = 0
  while i + 1 < table.len:
    if table[i] == key:
      return table[i + 1]
    i += 2

proc note(facts: JsonNode): string =
  ## What the page says under the search: what is running, what went wrong,
  ## what just worked.
  let busy = facts{"busy"}.getStr()
  if busy.len > 0 and busy != "info":
    result = lookup(Busy, busy)
    if result.len > 0:
      result.add Ellipsis
    return
  let error = facts{"error"}.getStr()
  if error.len > 0:
    result = lookup(Errors, error)
    if result.len == 0:
      result = "That did not work (" & error & ")."
    return
  lookup(Done, facts{"done"}.getStr())

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

proc categories(facts: JsonNode): seq[JsonNode] =
  ## The shelves: the host's, else the ones the store's last answer carried.
  result = arrayOf(facts{"categories"})
  if result.len == 0:
    result = arrayOf(facts{"listing", "categories"})

proc categoryTitle(facts: JsonNode, slug: string): string =
  for category in facts.categories:
    if category{"slug"}.getStr() == slug:
      return category{"title"}.getStr()
  slug

proc categorySelect(look: StoreLook, facts: JsonNode): SvgNode =
  var c = fieldBox(look)
  c.add " w-full"
  result = el("select", move c)
  result.attrs.add(("value", facts{"category"}.getStr()))
  discard result.on("on-change", HCategory)
  var all = el("option", "rounded-lg", txt("All scenes"))
  all.attrs.add(("value", ""))
  result.children.add all
  for category in facts.categories:
    let option = el("option", "rounded-lg", txt(category{"title"}.getStr()))
    option.attrs.add(("value", category{"slug"}.getStr()))
    result.children.add option

proc pageArrows(look: StoreLook, header: SvgNode, page: int, more: bool, focus: var seq[int], lit: int) =
  ## "Previous" and "More" for the store's pages, by the title.
  if page > 1:
    header.children.add look.button("Previous", HPrevPage, false, focus, lit)
  if more:
    header.children.add look.button("More", HNextPage, false, focus, lit)

proc sceneRow(look: StoreLook, facts, scene: JsonNode, row: int, focus: var seq[int], lit: int): SvgNode =
  ## One store scene: its name, its shelf and publisher, and what can be
  ## done with it here.
  var c = "flex items-center"
  c.px("gap", look.gap div 2)
  c.px("py", look.gap div 3)
  if look.paper: c.add " border-b border-black"
  else: c.add " border-b border-zinc-800"
  result = el("div", move c)
  let
    store = scene{"id"}.getStr()
    installed = facts.installedFrom(store)
    latest = scene{"version"}.getInt(0)
  var about = categoryTitle(facts, scene{"category"}.getStr())
  let by = scene{"by"}.getStr()
  if by.len > 0:
    if about.len > 0: about.add " \xc2\xb7 "
    about.add "by "
    about.add by
  if not installed.isNil:
    about.add " \xc2\xb7 installed"
  elif facts.previewing(store = store):
    about.add " \xc2\xb7 previewing"
  let text = el("div", "grow min-w-0 flex flex-col")
  text.children.add el("span", "truncate font-bold", txt(scene{"name"}.getStr()))
  c = "truncate"
  look.grey(c)
  c.px("text", look.small)
  text.children.add el("span", move c, txt(about))
  result.children.add text
  if not installed.isNil:
    if latest > installed{"v"}.getInt(0) and installed{"v"}.getInt(0) > 0:
      result.children.add look.button("Update", HUpdate + row, true, focus, lit)
    result.children.add look.button("Show", HShow + row, false, focus, lit)
  else:
    if not facts.previewing(store = store):
      result.children.add look.button("Preview", HPreview + row, false, focus, lit)
    result.children.add look.button("Install", HInstall + row, true, focus, lit)

proc storeTree*(state, facts: JsonNode, look: StoreLook, width: int, focus: var seq[int]): SvgNode =
  ## The store page: Back and the pages' arrows, the search and the shelves,
  ## what is running or went wrong, and a page of scenes that scrolls.
  ## `focus` gets the buttons in order, for the keys; the one at
  ## `state.focus` is lit.
  let lit = state{"focus"}.getInt(-1)
  result = look.frame()
  let
    listing = facts{"listing"}
    page = facts{"page"}.getInt(1)
    header = look.header("Scene store", focus, lit)
  look.pageArrows(header, page, listing{"more"}.getBool(), focus, lit)
  result.children.add header
  var c = "shrink-0 flex flex-col"
  c.px("px", look.pad)
  c.px("pt", look.gap div 2)
  c.px("gap", look.gap div 2)
  let tools = el("div", move c)
  c = "flex items-center"
  c.px("gap", look.gap div 2)
  let search = el("div", move c)
  var field = fieldBox(look)
  field.add " flex-1 min-w-0"
  let input = el("input", move field).on("on-change", HQuery).on("on-key-down", HSearch)
  var draft = state{"draft"}
  input.attrs.add(("value", if draft.isNil: facts{"query"}.getStr() else: draft.getStr()))
  input.attrs.add(("placeholder", "Search scenes"))
  search.children.add input
  search.children.add look.button("Search", HSearch, true, focus, lit)
  tools.children.add search
  if facts.categories.len > 0:
    tools.children.add look.categorySelect(facts)
  let note = facts.note()
  if note.len > 0:
    c = "truncate"
    look.grey(c)
    c.px("text", look.small)
    tools.children.add el("span", move c, txt(note))
  result.children.add tools
  c = "flex flex-col"
  c.px("px", look.pad)
  c.px("pb", look.pad)
  let list = el("div", move c)
  let scenes = arrayOf(listing{"scenes"})
  for i in 0 ..< scenes.len:
    list.children.add look.sceneRow(facts, scenes[i], i, focus, lit)
  if scenes.len == 0 and facts{"busy"}.getStr().len == 0:
    c = "text-center"
    look.grey(c)
    c.px("pt", look.gap)
    list.children.add el("div", move c, txt(
      if listing.isNil or listing.kind != JObject: "The store's scenes show here once the frame is online."
      else: "No scenes found."))
  result.children.add el("div", "flex-1 overflow-y-auto", list)

proc line(card: SvgNode, look: StoreLook, text: string, quiet = false) =
  if text.len > 0:
    var c = ""
    if quiet: look.grey(c)
    card.children.add el("div", move c, txt(text))

proc infoTree*(state, facts: JsonNode, look: StoreLook, sceneId, name: string, showing: bool,
    focus: var seq[int]): SvgNode =
  ## A scene's page: where it came from and what can be done with it.
  let lit = state{"focus"}.getInt(-1)
  result = look.frame()
  result.children.add look.header(if name.len > 0: name else: sceneId, focus, lit)
  var c = "flex flex-col"
  c.px("p", look.pad)
  c.px("gap", look.gap)
  let body = el("div", move c)
  let card = el("div", if look.paper: "flex flex-col gap-1 p-3 rounded-lg border-2 border-black"
    else: "flex flex-col gap-1 p-3 rounded-lg bg-zinc-900")
  let
    installed = facts.installedAs(sceneId)
    preview = facts.previewing(sceneId = sceneId)
    info = facts{"info"}
    known = not info.isNil and info{"id"}.getStr() == sceneId
    scene = if known: info{"scene"} else: nil
    version = if installed.isNil: 0 else: installed{"v"}.getInt(0)
    latest = if scene.isNil: 0 else: scene{"version"}.getInt(0)
  if preview:
    card.line(look, "A preview: not in the frame's scene list until it is installed.")
  if installed.isNil:
    card.line(look, "Not from the scene store.", quiet = true)
  else:
    var text = "From the scene store"
    if version > 0:
      text.add ", version "
      text.addInt version
    card.line(look, text)
    if not scene.isNil and scene.kind == JObject:
      var about = categoryTitle(facts, scene{"category"}.getStr())
      if scene{"by"}.getStr().len > 0:
        if about.len > 0: about.add " \xc2\xb7 "
        about.add "by "
        about.add scene{"by"}.getStr()
      card.line(look, about, quiet = true)
      card.line(look, scene{"description"}.getStr(), quiet = true)
      if latest > version and version > 0:
        var newer = "Version "
        newer.addInt latest
        newer.add " is available."
        card.line(look, newer)
      elif not preview:
        card.line(look, "This is the newest version.", quiet = true)
    elif facts{"busy"}.getStr() == "info":
      card.line(look, "Asking the store about it" & Ellipsis, quiet = true)
    elif known and facts{"error"}.getStr() == "invalid_scene":
      card.line(look, "Not in the public store.", quiet = true)
  body.children.add card
  # What runs, went wrong or just worked; not the store's "no such scene",
  # which the card says.
  let asked = facts{"busy"}.getStr() == "info" or (known and facts{"error"}.getStr() == "invalid_scene")
  let note = if asked: "" else: facts.note()
  if note.len > 0:
    c = ""
    look.grey(c)
    body.children.add el("div", move c, txt(note))
  c = "flex flex-wrap"
  c.px("gap", look.gap div 2)
  let buttons = el("div", move c)
  let asking = state{"confirm"}.getInt(-1)
  if not showing:
    buttons.children.add look.button("Show", HInfoShow, false, focus, lit)
  if preview:
    buttons.children.add look.button("Install", HInfoInstall, true, focus, lit)
    buttons.children.add look.button(if asking == HInfoDiscard: "Tap again to discard" else: "Discard",
      HInfoDiscard, false, focus, lit)
  else:
    if latest > version and version > 0:
      buttons.children.add look.button("Update", HInfoUpdate, true, focus, lit)
    if not installed.isNil or facts{"removeAny"}.getBool():
      let remove = look.button(if asking == HInfoRemove: "Tap again to delete" else: "Delete",
        HInfoRemove, false, focus, lit)
      if asking == HInfoRemove and not look.paper:
        remove.attrs[0][1].add " bg-red-600 active:bg-red-500"
      buttons.children.add remove
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
    scenes = arrayOf(facts{"listing", "scenes"})
    info = state{"info"}.getStr()
    installed = facts.installedAs(info)
  state.put("confirm", newJInt(-1))
  var row = -1
  if handler >= HPreview and handler < HInfoShow:
    row = handler mod 1000
    if row >= scenes.len:
      return smNone
  let store = if row >= 0: scenes[row]{"id"}.getStr() else: ""
  case handler
  of HBack:
    state.put("draft", newJNull())
    result = smTiles
  of HQuery:
    state.put("draft", newJString(text))
  of HSearch:
    if key.len == 0 or key == "Enter":
      let draft = state{"draft"}
      storeAct("browse", args({"q": if draft.isNil: facts{"query"}.getStr() else: draft.getStr(), "page": "1"}))
  of HCategory:
    storeAct("browse", args({"category": text, "page": "1"}))
  of HPrevPage, HNextPage:
    let page = max(1, facts{"page"}.getInt(1) + (if handler == HNextPage: 1 else: -1))
    storeAct("browse", args({"page": $page}))
  of HInfoShow:
    sceneId = info
    result = smShow
  of HInfoUpdate:
    if not installed.isNil:
      storeAct("update", args({"id": info, "store": installed{"store"}.getStr()}))
  of HInfoInstall:
    let preview = facts{"preview"}
    storeAct("install", args({"store": preview{"store"}.getStr(), "name": preview{"name"}.getStr()}))
  of HInfoRemove, HInfoDiscard:
    # Asked twice. The page stays until the scene is gone from the frame (the
    # switcher goes back to the tiles then), so a refusal shows here.
    if confirm != handler:
      state.put("confirm", newJInt(handler))
    elif handler == HInfoDiscard:
      storeAct("discard")
    else:
      storeAct("remove", args({"id": info, "store": if installed.isNil: "" else: installed{"store"}.getStr()}))
  else:
    if row >= 0:
      let base = handler - row
      if base == HPreview:
        storeAct("preview", args({"store": store, "name": scenes[row]{"name"}.getStr(), "from": opener}))
      elif base == HInstall:
        storeAct("install", args({"store": store, "name": scenes[row]{"name"}.getStr()}))
      else:
        let held = facts.installedFrom(store)
        if not held.isNil:
          if base == HShow:
            sceneId = held{"id"}.getStr()
            result = smShow
          elif base == HUpdate:
            storeAct("update", args({"id": held{"id"}.getStr(), "store": store}))

{.pop.}
