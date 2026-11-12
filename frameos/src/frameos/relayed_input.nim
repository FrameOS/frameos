## Input a thin client saw, relayed by its control plane with the render
## pull it asked for (docs/events.md, "Thin clients";
## docs/server-rendering.md, "Keys, touch and the schedule").
##
## A board that renders nothing itself (the Pico, an ESP32-C3, an ESP32-S3
## set to render on the server) has no dispatcher: the plane runs its scene
## in the wasm runtime, a fresh process per pull. So the board keeps what its
## scene would have heard since its last pull, stamped on its own clock, and
## sends it along. The Pico sends its button edges (`edges`); an ESP32 sends
## whatever its producers handed `fos_events_dispatch` (`events`: `gpio` and
## pointer events from its driver, its schedule's entries, its own HTTP
## API's), each with the origin it came from. Here every `atMs` moves onto
## this runtime's monotonic clock, and input_state times the presses
## (`press`, `doublePress`, `longPress`) and the gestures from them exactly as
## it would have on the board.

import std/json
import ./events_gen

const
  MaxRelayedEdges* = 32
    ## Edges and events together: a few per press, and a board that was
    ## mashed is still a handful.
  MaxRelayedEventName* = 64
  RelayedOrigins* = {eoDriver, eoSchedule, eoHttpWrite, eoHttpAdmin}
    ## The producers a board has besides its control plane: what the plane
    ## sent it is the plane's already, and the console (`system`) and the
    ## scene (`scene`) stay on the board.

type
  RelayedEvent* = object
    origin*: EventOrigin
    name*: string
    payload*: JsonNode

proc isJsonInt(node: JsonNode): bool =
  not node.isNil and node.kind == JInt

proc relayedButtonEdges*(input: JsonNode, hostNowMs: int64): seq[JsonNode] =
  ## The `gpio` payloads of a relayed input, oldest first:
  ## `{"nowMs": <board clock>, "edges": [{"label", "action": "down"|"up",
  ## "atMs", "pin"?, "wake"?}]}`. Each `atMs` lands as far before `hostNowMs`
  ## as it was before the board's `nowMs`. An edge that names no label, no
  ## edge or no time is skipped; past MaxRelayedEdges the rest are.
  if input.isNil or input.kind != JObject:
    return
  let edges = input{"edges"}
  let boardNow = input{"nowMs"}
  if edges.isNil or edges.kind != JArray or not boardNow.isJsonInt:
    return
  let offset = hostNowMs - boardNow.getBiggestInt()
  for edge in edges:
    if result.len >= MaxRelayedEdges:
      break
    if edge.kind != JObject:
      continue
    let label = edge{"label"}
    let action = edge{"action"}
    let atMs = edge{"atMs"}
    if label.isNil or label.kind != JString or label.getStr().len == 0:
      continue
    if action.isNil or action.kind != JString or action.getStr() notin ["down", "up"]:
      continue
    if not atMs.isJsonInt:
      continue
    let pin = edge{"pin"}
    let payload = %*{
      "pin": (if pin.isJsonInt: pin.getInt() else: -1),
      "label": label.getStr(),
      "action": action.getStr(),
      "level": (if action.getStr() == "down": 0 else: 1),
      "atMs": atMs.getBiggestInt() + offset,
    }
    let wake = edge{"wake"}
    if not wake.isNil and wake.kind == JBool and wake.getBool():
      payload["wake"] = %true
    # A voice hold took this press on the board (docs/voice-chat.md): the
    # dispatcher makes no `button` of it here either.
    let claimed = edge{"claimed"}
    if not claimed.isNil and claimed.kind == JBool and claimed.getBool():
      payload["claimed"] = %true
    result.add(payload)

proc relayedOrigin(node: JsonNode, origin: var EventOrigin): bool =
  if node.isNil or node.kind != JString:
    return false
  for candidate in RelayedOrigins:
    if $candidate == node.getStr():
      origin = candidate
      return true
  false

proc relayedEvents*(input: JsonNode, hostNowMs: int64): seq[RelayedEvent] =
  ## Everything a relayed input delivers, oldest first: the Pico's `edges`,
  ## each as its driver's `gpio`, then an ESP32's `events`
  ## (`[{origin, name, payload}]`), each from its own origin. An event from
  ## any origin but RelayedOrigins, with no name, a name past
  ## MaxRelayedEventName or a payload that is not an object is skipped. A
  ## payload's integer `atMs` lands as far before `hostNowMs` as it was
  ## before the board's `nowMs`; without a board clock nothing is delivered.
  ## Past MaxRelayedEdges, edges and events together, the rest are dropped.
  if input.isNil or input.kind != JObject:
    return
  let boardNow = input{"nowMs"}
  if not boardNow.isJsonInt:
    return
  for payload in relayedButtonEdges(input, hostNowMs):
    result.add RelayedEvent(origin: eoDriver, name: "gpio", payload: payload)
  let events = input{"events"}
  if events.isNil or events.kind != JArray:
    return
  let offset = hostNowMs - boardNow.getBiggestInt()
  for event in events:
    if result.len >= MaxRelayedEdges:
      break
    if event.kind != JObject:
      continue
    var origin: EventOrigin
    if not relayedOrigin(event{"origin"}, origin):
      continue
    let name = event{"name"}
    if name.isNil or name.kind != JString or name.getStr().len == 0 or
        name.getStr().len > MaxRelayedEventName:
      continue
    let given = event{"payload"}
    if not given.isNil and given.kind != JObject:
      continue
    let payload = if given.isNil: newJObject() else: copy(given)
    let atMs = payload{"atMs"}
    if atMs.isJsonInt:
      payload["atMs"] = %(atMs.getBiggestInt() + offset)
    result.add RelayedEvent(origin: origin, name: name.getStr(), payload: payload)
