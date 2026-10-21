## Button edges a thin client saw, relayed by its control plane with the
## render pull they asked for (docs/events.md, "Thin clients").
##
## A board that renders nothing itself (the Pico, an ESP32-C3) has no
## dispatcher: the backend runs its scene in the wasm runtime, a fresh process
## per pull. So the board keeps the `gpio` edges since its last pull, stamped
## on its own clock, and sends them along; here they become its driver's
## edges, with `atMs` moved onto this runtime's monotonic clock, and
## input_state times the presses (`press`, `doublePress`, `longPress`) from
## them exactly as it would have on the board.

import std/json

const MaxRelayedEdges* = 32

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
    result.add(payload)
