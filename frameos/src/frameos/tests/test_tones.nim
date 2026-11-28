import std/unittest

import frameos/tones

# A scene's tones (docs/tones.md): the notes frameos.tone() hands a host, as
# the runtime writes them. The firmware reads the same text with the same
# bounds (embedded/esp32/main/tests/test_fos_tone.c).

var played: seq[string]

proc recordingSink(notes: string): bool {.nimcall, gcsafe.} =
  {.cast(gcsafe).}:
    if notes.len > 0:
      played.add notes
  true

suite "tones":
  test "no notes is the chime":
    check normalizeTones("") == ChimeNotes
    check normalizeTones(ChimeNotes) == ChimeNotes

  test "notes are written one way":
    check normalizeTones("880:200") == "880:200"
    check normalizeTones(" 440.4 : 99.6 ,0:50, 660:100") == "440:100,0:50,660:100"

  test "pitches and lengths are held to what a buzzer plays":
    check normalizeTones("20:1,99999:9999") == "100:10,10000:5000"
    check normalizeTones("0.4:100,880:100") == "0:100,880:100" # under 1 Hz: a rest

  test "what is no note is left out, and rests alone are nothing":
    check normalizeTones("x:5,440:abc,:3,440,550:100") == "550:100"
    check normalizeTones("0:500,0:100") == ""
    check normalizeTones("loud") == ""
    check normalizeTones("NaN:100") == ""

  test "sixteen notes and ten seconds in all at most":
    var many = ""
    for i in 0 ..< 20:
      if i > 0: many.add ','
      many.add $(1000 + i) & ":100"
    var count = 1
    for c in normalizeTones(many):
      if c == ',': inc count
    check count == MaxToneNotes
    check normalizeTones("440:4000,550:4000,660:4000,770:4000") == "440:4000,550:4000,660:2000"

  test "playing goes to the host, and nothing plays where there is none":
    toneSink = nil
    check not playTones("")
    check not canPlayTones()
    played = @[]
    toneSink = recordingSink
    check canPlayTones()
    check played.len == 0 # asking is not playing
    check playTones("")
    check playTones("880:200")
    check not playTones("0:100") # only rests: nothing handed on
    check played == @[ChimeNotes, "880:200"]
    toneSink = nil
