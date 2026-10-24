# Voice chat: talk to a frame

Hold a frame's **LEFT** and **RIGHT** buttons together for half a second: the
buzzer plays a short rising sparkle, the microphone opens, and the frame
listens until either button is let go. What was said goes to the frame's
control plane (the self-hosted backend or FrameOS Cloud) **while it is being
said**, is transcribed there, and is answered by the AI chat with that frame in
its context, through a small set of tools that act on the frame: switch to a
scene by name, set a field of the scene it shows, redraw. The reply is spoken
nowhere (no board in the tree has a speaker FrameOS drives); it is **drawn on
the panel** as a notice across the bottom (what was heard, in quotes, and the
answer, or the error in plain words), it lands in the frame's chat in the
workspace and in the frame's log, and the buzzer sounds the outcome.

Boards: the Seeed reTerminal **E1001, E1002 and E1003**, which carry a PDM MEMS
microphone (MEMSensing MSM261DHP006: clock GPIO42, data GPIO41, power enable
GPIO38 through a TPS22916 load switch). The **E1004 has no microphone** (its
schematic has none; GPIO41/42 are the J2 header's UART there), but a PDM
microphone on J2 pins 41/42 works with the same driver once `mic_pins` names
it. Only the ESP32 runtime has this: a Pi frame has no button chord and no
microphone path (yet).

## On the frame (`embedded/esp32/main`)

- **The chord** (`fos_voice_chord.c`, pure, host-tested by
  `tests/test_fos_voice_chord.c` through
  `backend/app/tasks/tests/test_esp32_voice_chord.py`). The button task feeds
  it the two keys' levels every poll: both down for
  `FOS_VOICE_CHORD_HOLD_MS` (500) starts a session; either key up before that
  is nothing (two ordinary presses, as they always were); either key up after
  the start ends the session. The keys are the buttons labelled `LEFT` and
  `RIGHT` (`PREV` / `NEXT` count too, case-insensitive); a board with only one
  of them has no chord.
- **Claimed presses.** Once the chord starts, both keys belong to it: no hold
  sound counts their seconds, no click on their release, and the `gpio` `up`
  edge each produces carries `claimed: true` — the dispatcher
  (`frameos/input_state.nim`) delivers that edge as the line it is and makes
  **no** `button` out of the press (no `press`, no `longPress`). The two
  `down` edges were delivered when they happened, as every edge is. The
  contract is `docs/events-contract.json` (`gpio.payload.claimed`); the case is
  in `docs/event-fixtures.json` (`inputState`).
- **Sounds** (`fos_buzzer.c`, all relative to `buzzer_tone_hz`):
  listening = four rising notes and a held top (the "sparkle", about 300 ms);
  sent = two quick rising notes; then, every two seconds until the answer, a
  tiny tick an octave up (5 ms) while the rest of the recording uploads and
  a low bop an octave down (20 ms) while the plane transcribes and answers —
  so a long wait is audibly a wait, quietly (a piezo an octave below its
  pitch is far softer than one above), never while listening (the
  microphone would hear it);
  the chat did something (a tool ran) = three rising notes; the chat only
  answered = two notes; nothing heard = one low note; error = two low notes;
  busy (a chord while a session is in flight, or no microphone / no control
  plane) = the refused press's dull pair.
- **The notice** (`fos_client_show_notice`, drawn by the render task in
  `fos_panel_draw.c`'s notice box): the transcript in quotes and the reply,
  or the error in a sentence (`I didn't catch that…`, `Voice chat: no
  Wi-Fi.`, the plane's own `detail` for an OpenAI refusal), word-wrapped
  across the bottom of the panel in the 5x7 font (3 px per font pixel on a
  panel 600 px or wider, 2 below; curly quotes and dashes folded to ASCII).
  **The panel holds still from the chord until the answer**
  (`fos_client_hold_render` / `fos_client_release_render`): the chat's tools
  arrive one by one — `activate_scene`, then `set_scene_state` for the new
  scene — and each is applied to the scene as it comes (a pulled switch takes
  effect before the next command in the same pull), but no render starts;
  the release draws them all with ONE render that carries the notice, so
  one e-paper refresh shows the new scene, its text and the answer. Without
  the hold the switch started a 45 s render on the E1002 that the state then
  waited out, and the answer showed over the old text. An answer that
  changed nothing is drawn over a copy of the last image instead, without
  rendering the scene again (a photo scene keeps its photo). It stays 30 s
  (`NOTICE_SHOWN_MS`) or until the next render, whichever is sooner: the
  render task then repaints the snapshot without it — the next render used
  to be the scene's own interval, an hour for a photo, and the answer sat
  there all that time. Like the local-network-access code box, it
  is restored before the image is stored, so snapshots never carry it.
- **Capture** (`fos_mic.c`): I2S0 in PDM RX mode with the hardware
  PDM-to-PCM filter, **16 kHz, 16-bit, mono**, little-endian; the power pin
  high for the session and low after it. Driven on the HAL's register layer
  (`hal/i2s_ll.h`) plus the GDMA driver the panel's SPI already links, not
  ESP-IDF's I2S driver: that one is ~14 KB of flash for a chip whose image
  is 87% of its OTA slot, and the frame asks for exactly one clock
  (PLL 160 MHz / (19 + 17/32) = 8.192 MHz mclk, bclk div 8, DSR 8 →
  16 kHz). The S3 only: a C3 has no PDM-to-PCM filter and no board with a
  microphone.
- **The session** (`fos_voice.c`): two tasks live only while a session runs,
  both above the render task's priority — below it the answer sat unread
  while a render and its e-paper refresh ran, the progress bop going the
  whole time. A
  capture task reads the I2S DMA into a PSRAM buffer (`fos_big_malloc`,
  `FOS_VOICE_MAX_SECONDS` = 30 of audio, 960 KB; a smaller buffer when PSRAM
  is short). The relay task uploads what the capture task has written, a
  chunk at a time, while the user is still talking, and on the release sends
  the rest with `done=1` and waits for the answer. The first 300 ms after the
  sparkle starts are dropped, so the buzzer is not in the recording. Deep
  sleep is held off for the session (`fos_client_keep_awake_ms`). A chord on
  a frame that just woke records at once and uploads when Wi-Fi is up (20 s
  at most). After a reply the frame asks for a commands sync, so a scene
  switch the chat queued on the backend applies now; the cloud delivers its
  own over the socket.
- **Log lines** (`frameos_nim_log_hook`, so both planes' frame logs show
  them): `voice:listening`, `voice:sent {ms, bytes}`, `voice:reply
  {transcript, reply, tools}`, `voice:error {error}`.
- **Config:** `mic_pins` (`clk=42,data=41,pwr=38`; NVS `mic_pins`; no stored
  value → the board's own, `fos_board_mic_pins`, so an E1001/E1002 gets its
  microphone with the update) and `voice_chat` (bool, default on; the
  switch an owner turns off to keep the microphone shut). Console: `set
  mic_pins …`, `set voice_chat 0|1`, `mic [seconds]` records and prints the
  level (the bench check that the microphone is wired), `status` shows both.

## The upload (one HTTP contract, both planes)

```
POST {base}/voice/{sessionId}?seq={n}&done={0|1}
Authorization: Bearer <the frame's token>
Content-Type: audio/L16; rate=16000; channels=1
<raw PCM: signed 16-bit little-endian mono at 16 kHz; may be empty when done=1>
```

- `base` is `{backend_url}/api/frames/{frameId}/embedded` on the self-hosted
  backend (the frame's `server_api_key` as the bearer, as every `/embedded`
  route) and `{cloud_url}/api/frames/{frameId}` on the cloud (the enrollment
  access token, as the service-settings and firmware routes:
  `authenticateFrameDevice`).
- `sessionId` is 8–64 of `[A-Za-z0-9_-]`, minted by the frame. `seq` starts at
  0 and counts up by one; a gap is `409 seq_mismatch` and the frame gives the
  session up. One connection is kept open across the chunks (keep-alive).
- Every chunk but the last answers `202 {"ok":true,"bytes":<received so
  far>}`. The chunk with `done=1` answers when the turn is over:
  `200 {"ok":true,"transcript":"…","reply":"…","tools":["activate_scene"]}`,
  or `200 {"ok":false,"error":"nothing_heard"|"transcription_failed"|
  "chat_failed"|"ai_unavailable","detail":"…"}` for a problem the frame should
  sound as an error. `4xx` for an unknown or inactive frame, a body over the
  caps, too many sessions.
- Caps: a chunk is at most 64 KiB (2 s), a session at most 30 s of audio
  (960,000 bytes), 20 sessions per frame per 15 minutes, and a session
  nobody has written to for 60 s is forgotten. Sessions live in the
  process's memory on both planes (like the cloud's AI turns): a restart
  mid-sentence loses the sentence, which the frame reports as an error.
- Transcription: OpenAI `POST /v1/audio/transcriptions`, model
  `gpt-4o-mini-transcribe`, the PCM wrapped as a WAV, the frame's scene names
  as the `prompt` (so "the bird journal" is heard as the scene it is). The
  key is the one the plane's AI chat uses (backend: Settings → OpenAI
  `backendApiKey`; cloud: the account's key or the shared operator key
  through `resolveAiAccess`, surface `voice_chat`). The audio is not stored
  anywhere once the turn is over.

## The chat turn

The transcript is one user message in a chat about the frame — the same chat
the workspace shows under the frame (`docs/ai-chat.md`), one per frame for
voice (its id is derived from the frame's), so "no, the other one" has the
previous turn to refer to. The agent loop is the chat's
(`cloud/apps/auth-web/src/lib/ai/loop.ts`, `backend/app/utils/ai_chat_agent.py`)
with a **voice system prompt** instead of the editor's (short answers, act,
never ask for confirmation: the spoken request is the confirmation; the
transcript may carry recognition errors), the frame's context block, and
**only the frame-scoped voice tools**, run in-process by the plane:

| tool | does |
|---|---|
| `list_scenes` | the scenes on the frame, which one shows |
| `activate_scene {scene_id}` | queue `set_current_scene` (the cloud re-pushes the assigned set when the device does not hold the scene, as its event route does) |
| `set_scene_state {state}` | queue `setSceneState` (a `scene_event` with `render: true`) for the scene showing |
| `render_now` | queue `render` |
| `show_image {query, source?}` | build a one-picture scene (`render` → `render/image` fed by `unsplash` with `search` = query, or `openaiImage` with `prompt` = query; the app bundled in, `refreshInterval` an hour for a photo, a day for a generated one) and push it as the editor's "Preview on frame": the backend sends the frame's saved scenes plus it (`queue_embedded_scene_preview`, and its settings pull now carries what the previewed apps declare), the cloud a `set_scenes` of it alone (the next `activate_scene` re-pushes the assigned set, as its event route does). The workspace shows the preview for what it is: both planes report the newest scene push as `scene_preview` `{scene_id, name, source: editor|voice, at}` on the frame (backend `frame_commands.scene_preview_info`, cloud `scenePreviewsByFrame`; the push's `preview` metadata outlives its bundle) while a preview is the newest push, and the scene list draws a dashed "preview" row above the saved scenes — named, marked active when the device shows it, with an "Install" button that puts the previewed scene on the frame's saved list (`scenesLogic.installPreviewScene`: the scene JSON from `GET /api/frames/{id}/scene_preview` on the backend, `/scene-preview` on the cloud — the newest preview push keeps the shown scene, older ones lose it when a newer push is queued — added to the form with its id kept, saved and pushed; on the cloud the save mints the private store scene) and a "Push scenes" button that sends the saved list back (`scenesLogic.pushSavedScenes`: the backend's deploy, the cloud's assigned list re-pushed) and so takes the preview off. Nothing accumulates: the frame holds its saved scenes plus ONE picture scene (the next `show_image` replaces it, the next push of the saved list removes it), and the control plane keeps one scene bundle per frame — a newer `set_scenes` row empties the older previews' bundles on the backend (`spend_older_scene_pushes`), the cloud drops a `set_scenes` row's `scenes` the moment the device answers it (`spentCommandPayload`). `source` is `photo` or `generated`; omitted, the first the frame has. Only the sources the context lists work: the backend's are the project's keys, the cloud's the service-setting groups the owner already granted this frame's scenes — the voice turn grants nothing |
| `rotate_frame {degrees}` | the Settings panel's push for `rotate` (0/90/180/270, absolute; the context carries the current rotation so "another 90" adds up): the backend writes the frame row AND queues a pull-backed `set_settings` row — the device fetches its settings only when its commands pull says a deploy waits, and the row is acked by the new ETag (without the row the second spoken rotation never reached the E1002); the cloud validates, mirrors into `frames.settings` and queues `set_settings`. A rotation restarts the device (`fos_settings.c`), which waits for the session, the answer's render and its refresh first. The frame's render interval is deliberately no voice tool: a frame sets its own, scenes have theirs, and a model given the key invented `interval: 1` next to a rotation |

Not the MCP server's tools: a frame's own token is a frame's credential, not
the owner's, and must not drive the account's photos, settings or other
frames. The tools above do exactly what the frame's workspace rail can do to
that one frame. Both planes implement them against their own queue
(`enqueueFrameCommand` / `queue_embedded_command`); the voice prompt and the
tool definitions are kept the same on both
(`src/lib/ai/voice.ts`, `app/utils/voice_chat.py`).

The reply (and the transcript) are stored on the chat; the frame gets them
in the `done` response and logs them. On the cloud the turn is metered like
any chat turn (`meterAiUsageInBackground`, surface `voice_chat`, the
transcription's audio tokens as a second record on its own model).

## What is not here yet

- **Scenes written by voice.** `show_image` builds one fixed scene; "make me
  a scene with the weather and a quote" would run the scene AI
  (`ai_scene_chat` on the cloud, the chat's editor tools on the backend) as a
  sub-turn and preview the result. Half a minute of model time, and the
  render-in-the-frame's-memory check (`docs/ai-chat.md`) before the push.
- **Word-by-word transcription.** The audio streams up while the user talks,
  so the only wait after the release is the transcription and the turn
  itself; the transcription itself starts at the release. OpenAI's Realtime
  transcription sessions would give partial text while speaking.
- **A spoken or drawn reply.** The Waveshare PhotoPainter and 13.3E6 have a
  speaker behind an ES8311 codec (`embedded/esp32/README.md`); with an I2S
  playback path the reply could be read out. On a fast LCD the reply could be
  drawn as an overlay (the local-network-access code box is the pattern).
- **Pi frames.** No chord in the Linux gpioButton driver, no ALSA capture.
