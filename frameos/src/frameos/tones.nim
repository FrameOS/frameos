## A scene's tones (docs/tones.md): `frameos.tone()` sounds the frame's
## buzzer, the speaker that stands in for one, or the status LED that follows
## the notes. The runtime only checks the notes and writes them one way,
## "hz:ms,hz:ms" (0 Hz a rest); what plays them is the host's (`toneSink`):
## the ESP32's buzzer (`fos_buzzer_scene_tone`), the browser preview's Web
## Audio and, on a board rendered on its control plane, the board itself
## through the render's `X-FrameOS-Tone` (the wasm runtime keeps the notes for
## both, `takeTones`). A Raspberry Pi has none: the call answers false.
##
## Pure, and on every ESP32 render path: no tables, no JSON.

import std/strutils

const
  MaxToneNotes* = 16
    ## As many notes as one call plays (the firmware's FOS_BUZZER_NOTES_MAX).
  MaxToneMs* = 10_000
    ## How long one call may sound in all: a reminder, not a ringtone.
  MinToneHz* = 100
  MaxToneHz* = 10_000
    ## The contract's buzzer pitch bounds (`buzzer_tone_hz`): a passive piezo
    ## is heard between them.
  MinNoteMs* = 10
  MaxNoteMs* = 5_000
  DefaultNoteMs* = 200
    ## `frameos.tone(880)`: one note this long.
  ChimeNotes* = "2093:120,0:40,2637:120,0:40,3136:240,0:420,2093:120,0:40,2637:120,0:40,3136:240"
    ## `frameos.tone()`: the frame's chime, a rising C major arpeggio twice
    ## (C7 E7 G7), near a piezo's resonance where it is loudest. 1.6 s.

var toneSink*: proc (notes: string): bool {.nimcall, gcsafe.}
  ## Plays notes as `normalizeTones` writes them and says whether something
  ## will (a buzzer, a speaker, an LED, a page or a board to hand them to).
  ## Called with "" it only answers whether something would (`app.frame.tone`).
  ## nil where nothing plays a tone (a Pi, a test).

proc canPlayTones*(): bool =
  let sink = toneSink
  not sink.isNil and sink("")

proc parseNumber(text: string, value: var float): bool =
  if text.len == 0 or text.len > 24:
    return false
  try:
    value = parseFloat(text)
  except ValueError:
    return false
  value == value and value > -1e9 and value < 1e9 # not NaN, nor out of reach

proc normalizeTones*(text: string): string =
  ## "" is the chime. Else "hz:ms" pairs by commas (what the app prelude makes
  ## of the call's arguments), written back checked: a pitch held to
  ## [MinToneHz, MaxToneHz] or 0 for a rest, a length to [MinNoteMs,
  ## MaxNoteMs], MaxToneNotes notes and MaxToneMs in all at most, a pair that
  ## is no pair left out. "" when nothing in it can be played.
  if text.len == 0:
    return ChimeNotes
  var notes = 0
  var total = 0
  var sounds = false
  for pair in text.split(','):
    if notes >= MaxToneNotes or total >= MaxToneMs:
      break
    let colon = pair.find(':')
    if colon <= 0:
      continue
    var hz, ms: float
    if not parseNumber(pair[0 ..< colon].strip(), hz) or not parseNumber(pair[colon + 1 .. ^1].strip(), ms):
      continue
    var pitch = int(hz + 0.5)
    if hz < 1:
      pitch = 0
    else:
      pitch = clamp(pitch, MinToneHz, MaxToneHz)
    var length = clamp(int(ms + 0.5), MinNoteMs, MaxNoteMs)
    length = min(length, MaxToneMs - total)
    if result.len > 0:
      result.add ','
    result.addInt pitch
    result.add ':'
    result.addInt length
    inc notes
    total += length
    if pitch > 0:
      sounds = true
  if not sounds:
    # Rests alone are silence: nothing to play.
    result = ""

proc playTones*(text: string): bool =
  ## `frameos.tone(...)`: true when the notes went to something that plays
  ## them. A call while notes sound replaces them, as on the board.
  let sink = toneSink
  if sink.isNil:
    return false
  let notes = normalizeTones(text)
  if notes.len == 0:
    return false
  sink(notes)
