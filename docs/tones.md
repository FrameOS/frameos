# Tones: a scene's sound

`frameos.tone()` lets a scene sound the frame's buzzer: a reminder that has
come, a timer that ran out. Until it, the buzzer was the firmware's alone
(press clicks, the voice chat's cues, the loading chirp).

```js
frameos.tone()                                   // the frame's chime: C7 E7 G7, twice (1.6 s)
frameos.tone(880, 300)                           // one note: 880 Hz for 300 ms (200 ms when left out)
frameos.tone([[2093, 120], [0, 60], [3136, 240]]) // up to 16 notes, 0 Hz a rest
```

It returns at once and answers whether something plays it; `app.frame.tone`
says so without sounding anything. It does not exist before FrameOS
2026.11.17: a scene checks `typeof frameos.tone === 'function'`.

## The notes

The runtime writes every call one way, `hz:ms` pairs by commas with 0 Hz a
rest (`frameos/src/frameos/tones.nim`, `normalizeTones`), held to what a
passive piezo plays: a pitch of 100 to 10000 Hz (the contract's
`buzzer_tone_hz` bounds), a note of 10 to 5000 ms, 16 notes and 10 s in all.
What is no note is left out, and rests alone are nothing. No arguments is the
chime (`ChimeNotes`), near a piezo's resonance, where it is loudest. A call
while notes sound replaces them, as every sound on the board does.

That text is what a host gets (`toneSink`), and the firmware reads it again
with the same bounds (`embedded/esp32/main/fos_tone.c`, host-tested by
`tests/test_fos_tone.c`), whoever wrote it: the runtime, or a plane.

## Who plays it

| host | plays it on | `app.frame.tone` |
|---|---|---|
| ESP32 with its own runtime | the buzzer, the codec's speaker (PhotoPainter), and the status LED lights with the notes (`fos_buzzer_scene_tone`) | true when it has any of them |
| ESP32 or Pico rendered on its control plane | the board, from the render's `X-FrameOS-Tone` | true (the plane cannot tell) |
| the browser preview | Web Audio, a soft triangle wave at the same pitches (`frameos/wasm/src/tones.ts`); a page may take them itself (`onTone`) | true |
| Raspberry Pi | nothing | undefined |

- **A scene's tone is the scene's.** It is not behind the frame's Tap and click
  sounds (`click_sounds`), which mute the press sounds only, as the voice
  chat's cues are not. A scene that sounds offers its own switch (To-do's
  Reminder sound).
- **A deep sleep waits for it.** The sleep path waits until the notes are over
  (`fos_buzzer_wait_quiet`, 10 s at most) before it powers the codec down and
  sleeps: a reminder a frame woke for plays to its end.
- **A board rendered on its plane** (docs/server-rendering.md) gets the notes
  of the render the plane ran for it as `X-FrameOS-Tone`, on a 200 or a 304,
  and plays them as the answer comes. The wasm runtime keeps them
  (`frameos_wasm_tones`, read once after each render), the render tool
  reports them (`tones`), and the planes check them (`tones_of`,
  `tonesOf`). They go out once: with the render that asked, or with the
  picture drawn ahead of a sleeping board's wake (`tones` in the backend's
  kept pre-render, `prerender_tones` on the cloud); never with a kept picture
  served again.
- **The browser preview** plays them when the page has been clicked once (the
  browser's autoplay rule); the worker posts `{type: 'tone', notes}` after a
  render or an event.

## A reminder

A reminder is a time the scene wakes for and a sound in the render that finds
it due (`docs/scene-guide.md` "Sounds and reminders"; the To-do sample is the
worked example):

1. Work out the next due time and `frameos.setNextSleep(seconds until it)`, no
   more than the scene's own interval.
2. In the render that finds it due, sound once and remember that it rang
   (`frameos.setState`): a scene renders again on every tap.
3. Ring a little early (To-do takes 30 s): a frame's clock and its sleep
   timer are not to the second. And say nothing for one missed by hours (the
   frame was off): show it as due instead.

A tap on a JSX scene often runs only the components its signals dirtied, and
no `get()`. Such a render keeps counting down the sleep the last whole `get()`
asked for (`keepOwnSleep` in `app_runtime.nim`), and once that time is past,
the render after a tap is a whole `get()`: a tap at 16:30 does not push a
17:00 reminder back to the scene's interval.

## Voice

"Add milk at 5" to the frame's microphone is a to-do with a reminder once the
voice key acts on the screen (#935): it types "Milk at 5" into To-do's new
to-do and presses Enter, and To-do reads the time out of the words
(`parseWhen` in its `when.ts`). The same words typed on the keyboard do the
same.
