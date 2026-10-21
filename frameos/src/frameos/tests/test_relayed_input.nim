## Button edges a thin client relays with its render pull
## (frameos/relayed_input.nim): moved onto this runtime's clock, they make the
## same presses here that input_state would have made on the board.

import std/[json, monotimes, times]
import ../relayed_input
import ../input_state
import ../events
import ../types

let t0 = getMonoTime()
proc at(ms: int): MonoTime = t0 + initDuration(milliseconds = ms)
proc ms(time: MonoTime): int64 = time.ticks div 1_000_000

proc config(): FrameConfig =
  FrameConfig(width: 800, height: 480, rotate: 0, flip: "",
    inputSettings: InputSettingsConfig(keyboardLayout: "us", grabKeyboard: true), gpioButtons: @[])

proc kinds(output: seq[InputDelivery]): seq[string] =
  for d in output:
    result.add(d.name & ":" & d.payload["action"].getStr())

proc deliver(input: JsonNode, now: MonoTime): seq[InputDelivery] =
  ## What the wasm runtime does with a relayed input: each edge as the
  ## driver's `gpio`, then time passing to now.
  var state = initInputState(config())
  for payload in relayedButtonEdges(input, now.ms):
    discard state.applyNamedInput(evGpio, payload, eoDriver, now, result)
  state.tick(now, result)

proc edge(label, action: string, atMs: int, wake = false): JsonNode =
  result = %*{"label": label, "action": action, "atMs": atMs}
  if wake:
    result["wake"] = %true

block test_the_edges_keep_their_distance_from_now:
  # The board saw the down 500 ms before it sent; this runtime started 20 ms
  # ago, so the down lands 480 ms before its clock began.
  let now = at(20)
  let edges = relayedButtonEdges(%*{"nowMs": 61_500, "edges": [edge("B", "down", 61_000), edge("B", "up", 61_080)]},
    now.ms)
  doAssert edges.len == 2
  doAssert edges[0]["atMs"].getBiggestInt() == now.ms - 500
  doAssert edges[1]["atMs"].getBiggestInt() == now.ms - 420
  doAssert edges[0]["pin"].getInt() == -1 and edges[0]["level"].getInt() == 0
  doAssert edges[1]["level"].getInt() == 1

block test_a_tap_on_the_board_is_a_press:
  let output = deliver(%*{"nowMs": 1_500, "edges": [edge("B", "down", 1_000), edge("B", "up", 1_080)]}, at(5))
  doAssert output.kinds == @["gpio:down", "gpio:up", "button:press"]
  doAssert output[1].payload["durationMs"].getInt() == 80
  doAssert output[2].payload["label"].getStr() == "B" and output[2].payload["role"].getStr() == "next"
  doAssert output[2].origin == eoDriver

block test_two_quick_taps_are_a_double_press:
  let output = deliver(%*{"nowMs": 1_800, "edges": [
    edge("A", "down", 1_000), edge("A", "up", 1_060), edge("A", "down", 1_200), edge("A", "up", 1_260)]}, at(5))
  doAssert output.kinds == @["gpio:down", "gpio:up", "gpio:down", "button:doublePress", "gpio:up"]

block test_a_hold_is_a_long_press_with_its_length:
  let output = deliver(%*{"nowMs": 2_700, "edges": [edge("C", "down", 1_000), edge("C", "up", 2_300)]}, at(5))
  doAssert output.kinds == @["gpio:down", "gpio:up", "button:longPress"]
  doAssert output[2].payload["durationMs"].getInt() == 1_300

block test_taps_on_two_buttons_are_two_presses:
  let output = deliver(%*{"nowMs": 1_800, "edges": [
    edge("A", "down", 1_000), edge("A", "up", 1_050), edge("B", "down", 1_100), edge("B", "up", 1_150)]}, at(5))
  doAssert output.kinds == @["gpio:down", "gpio:up", "gpio:down", "gpio:up", "button:press", "button:press"]

block test_the_press_that_woke_the_board_says_so:
  let output = deliver(%*{"nowMs": 900, "edges": [edge("D", "down", 0, wake = true), edge("D", "up", 140)]}, at(5))
  doAssert output.kinds == @["gpio:down", "gpio:up", "button:press"]
  doAssert output[0].payload["wake"].getBool() and output[2].payload["wake"].getBool()

block test_what_says_nothing_is_skipped:
  doAssert relayedButtonEdges(%*{"edges": [edge("A", "down", 1)]}, 100).len == 0 # no board clock
  doAssert relayedButtonEdges(%*{"nowMs": 10, "edges": "A"}, 100).len == 0
  doAssert relayedButtonEdges(newJNull(), 100).len == 0
  let kept = relayedButtonEdges(%*{"nowMs": 10, "edges": [
    %*{"action": "down", "atMs": 1}, %*{"label": "", "action": "down", "atMs": 1},
    %*{"label": "A", "action": "press", "atMs": 1}, %*{"label": "A", "action": "down"},
    %*{"label": "A", "action": "down", "atMs": "1"}, %"A",
    %*{"label": "A", "action": "down", "atMs": 2, "pin": 7}]}, 100)
  doAssert kept.len == 1 and kept[0]["pin"].getInt() == 7 and kept[0]["atMs"].getBiggestInt() == 92

block test_a_flood_is_capped:
  var edges = newJArray()
  for i in 0 ..< 40:
    edges.add(edge("A", if i mod 2 == 0: "down" else: "up", i * 10))
  doAssert relayedButtonEdges(%*{"nowMs": 1_000, "edges": edges}, 5_000).len == MaxRelayedEdges
