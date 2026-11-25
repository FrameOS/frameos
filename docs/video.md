# Video

*Written 2026-11-24, FrameOS 2026.11.15.*

A frame on a Raspberry Pi plays video: a folder of files left playing for
ever, a camera, a stream, Immich's videos, old films. FFmpeg decodes, in a
process of its own on the other cores, and scales each frame to the size of
the box it is drawn in; the runtime copies the frame that is due into the
canvas and repaints that box alone. An ESP32 and the browser preview do not
play video: every call says so and draws nothing.

## The API

A video is an image ref, like a canvas (`docs/jsx-ui.md` "Canvases"): the
app's video called `key`, the same picture every render, whose pixels the
player changes.

```tsx
export function get(app) {
  const video = frameos.video('main', { src: 'videos/beach.mp4', loop: true })
  return <img className="w-full h-full object-contain" src={video} />
}
```

- **`frameos.video(key, options)`**, called every render with the options as
  they are now. `src` is a file in the assets folder, as `readAsset` takes it
  (`storage` too, and the app's asset permission decides what it may read),
  or an `http(s)` or `rtsp(s)` URL. A new `src` under the key stops the old
  one and starts at `start` seconds; its last frame shows until the new one's
  first. `paused` holds the picture (the first frame shows when it starts
  paused). `loop` plays a file from its start again, opens a stream that
  ended again, and one that failed (a camera not on yet) every 10 s, its
  `error` showing meanwhile. `fps` is the most frames a second it is decoded at (30 by
  default, 60 at most): less is less work. `fit` (`contain`, `cover`, `fill`)
  wins over the `<img>`'s `object-*` class, which decides otherwise:
  `object-contain` (black bars), `object-cover` (cropped), `object-fill`.
  `headers` go with an http(s) request (an API key).
- What it returns: `{ __frameosType: "imageRef", id, width, height, video,
  src, state, time, duration, live, videoWidth, videoHeight, fps, decoder,
  fast, error }`. `decoder` says what decodes it (`software`, `h264_v4l2m2m`,
  `vaapi`) and `fast` whether with a slow decoder's shortcuts ("Hardware").
  `state` is `loading` until the first frame, `playing`, `paused`, `ended`
  (the last frame showed; never with `loop`) or `error`. `duration` is null
  for a live stream or a source that does not say. `id` is 0 when it cannot
  play at all (an ESP32, the preview, a file that is not there, a URL the
  network guard refuses): `error` says why and an `<img>` of it draws nothing.
- **`frameos.seekVideo(video, seconds)`**: from there. **`frameos.releaseVideo(video)`**:
  stops it now. It also stops when the interpreter goes, and an app holds 4
  at most (a fifth key stops the oldest).
- **`frameos.videoInfo(src, { storage, headers })`**: ffprobe's word on it,
  `{ width, height, duration, fps, codec }` or `{ error }`, without playing.
  Blocking: a file answers in tens of milliseconds, a URL may take seconds.
- **`frameos.videoFrame(src, { at, width, height, fit, keep, storage, headers })`**:
  one frame `at` seconds in (0 by default) as a picture `{ image, width,
  height }` or `{ image: null, error }`, decoded at that size (the canvas's
  by default, `cover` by default). `keep` holds it for later renders as
  `fetchImage`'s `keep` does (a thumbnail). Blocking, one ffmpeg per call.

A JSX UI draws a video; a root `<svg>`'s `<image href>` of one does not. The
`<img>` needs a size from its classes (`w-full h-full`, `flex-1`), as a URL's
does: the frames are decoded at it.

The scene guide's "Video" paragraph is what an author reads; the editor's
declarations are `frontend/src/utils/appTypeDeclarations.ts`.

## How it plays

Three parties, and no ref between them (`frameos/video/player.nim`):

- **ffmpeg**, a child process (`video/args.nim`):
  `-i <src> -vf fps=F,scale=…[,crop=W:H],setsar=1 -f rawvideo -pix_fmt X pipe:1`.
  Every frame comes out at the size it is drawn at, so the draw is a copy:
  `cover` crops to the `<img>`'s box `W` x `H` (in panel pixels), `fill`
  stretches to it, and `contain` comes at the picture's own size in it
  (`frameSize`), which the player puts in the middle of the box on black
  painted once (`take`): the bars are never scaled, piped or copied, and a
  frame repaints the picture, not them. A source ffprobe gave no size is
  padded to the box (`pad`), as a still (`videoFrame`) is. `X` is the
  canvas's own format: `rgb565le` for a 565 canvas (a HyperPixel), `gray` for
  a grey one, else `rgba` (pixie's RGBX). `F` is the source's rate, at most
  the app's `fps`, held constant by the fps filter, so frame `k` is at
  `k / F` seconds. Decoding runs `cores - 1` threads at nice 5: the render
  thread and the web server come first. A file that loops is one ffmpeg
  (`-stream_loop -1`, no gap).
- **The reader**, a thread of the player's own. It probes the source with
  ffprobe (duration, size, rate, rotation), starts ffmpeg, and reads its
  frames into a ring of 2 to 8 (32 MB at most: 8 frames of a 720p box, 3 of a
  1080p one). A full ring blocks it and ffmpeg with it, so a video nobody
  takes frames of costs no CPU; after 6 s of that (a paused video, a scene
  switched away) it stops ffmpeg and lets the ring go, and the next take
  starts it again where it was. It restarts ffmpeg on a seek, a new size, a
  new fps, and at the end of a URL that loops. Its stderr is kept for the
  error, the source named by its origin (`redacted_url.nim`): a camera's URL
  carries its password.
- **The render thread**, in `fillVideos` (`js_runtime/js_video.nim`) after the
  layout: for each `<img>` of a video, the size it got, the frame that is due
  copied into the player's image, and the scene's `nextSleep` set to when the
  next frame is due. The player's image is registered as a canvas
  (`utils/canvas_log.nim`), so a new frame repaints the video's box and
  nothing else of the UI (`utils/svg_frames.nim`).

The clock starts at the first frame shown. The newest frame whose time has
come is shown, the older ones dropped unseen. A render that comes more than a
second after the last one that drew the video (a list over it, another
scene) moves the clock on by the gap: the video waits, as for a pause, rather
than skipping. Frames more than 1.5 s behind the clock (a source the Pi
cannot decode in real time) move the clock to them, so the time shown stays
true. A live source (no duration) shows the newest frame there is. The wait
asked for is the next frame's time less how late renders have been coming
(an average), so frames land on time. A frame not decoded yet (a decoder
behind the clock) is waited for until the decoder's next one should be in
(its last one's arrival plus how long it takes to make one, an average the
reader keeps), a frame at least and a second at most, nothing taken off
(`renderWait`): a render sooner shows nothing new, and on one core it takes
the time the decoder needs. Before that rule a Pi Zero rendered back to back
every 2 ms and ffmpeg got a fifth of the core. After the last frame one more render is
asked for, so the app's `get()` sees `ended` and can move on.

A scene's `get()` runs every frame: keep a player's light (no `fetch` in it,
`useFetch` or `remember` for what it shows besides). On a desktop of windows
the desktop around a playing window does not run (`rhythmVisitChrome`). The
runner tells the web sockets about a new picture once a second, not every
frame (`runner.nim`, as for a scene under a second). A video on a display
plane ("Planes") is not drawn by renders at all, and its scene renders about
once a second.

## Planes

On a Raspberry Pi whose panel is a vc4 DPI output (a HyperPixel), a video
can be shown on one of the display's overlay planes (`video/planes.nim`): the
display's scaler (the HVS) scales the frame and turns its YUV into RGB as it
scans the panel out, so the CPU neither scales, converts, renders nor pushes
it. ffmpeg writes YUV420 at the source's own size (`decodeArgs` with `plane`:
no scaler, `-pix_fmt yuv420p`) straight into one of three of the plane's
buffers (DRM dumb buffers, the reader's, kept across a seek), and the reader
shows each when it is due by a clock of its own (pause, a resync when behind,
a live source at once), as the render thread does for the canvas.

The rule is that a plane is only ever where the picture is exactly right,
and the canvas plays the video everywhere else, as it always did:

- **The UI stays on `/dev/fb0`.** The frameBuffer driver, the loading mark and
  the cursor write it as before, and the kernel's fbdev emulation scans it out
  on the CRTC's primary plane. The runtime opens the DRM device behind it as
  its master (the fbdev emulation is none) and puts overlay planes on that
  CRTC. When the process ends the kernel restores the fbdev's picture and turns
  the planes off (lastclose), so a crash leaves no video on the glass. Another
  program that holds DRM master (a desktop) keeps the runtime off it.
- **Which frames.** A vc4 device behind `/dev/fb0` (`vc4drmfb`) whose CRTC
  drives a DPI encoder, the one output seen right on the glass; the panel's
  kept 565 canvas (`panel_canvas.nim`); a frame that neither turns (the HVS
  cannot turn by 90 or 270) nor mirrors it. HDMI (1080p, 4K, a Pi 4 or 5's
  desktop), a 32 bpp canvas, a turned panel, a Pi 5's RP1 DPI and anything
  that is not vc4 keep the canvas. So does a video once every plane is taken
  (four).
- **Where.** A video's `<img>` is a plane when it is a clean hole of a UI that
  is drawn whole at its size into the panel canvas or a view of it: the scene
  a layout wraps (`<yield />`), a `<Scene>` hole and a desktop's window are
  views (`interpreter.drawIntoHole`), placed on the panel by the view's corner
  (`onPanelCanvas`), and a layout gives a scene a view only while nothing of
  its own is painted over it (`seekHoles`): another window, a menu, a dialog,
  the taskbar over a window make it a picture of its own, and its video the
  canvas's. In the UI itself the same rule (`seekImageHoles`): nothing drawn
  over the `<img>`, opaque, not in a scroller, no popup. Render scale and a
  refitted desktop come in through the UI's scale and the view's corner
  (`holeOnPanel`); the plane is cut to the view it is drawn in (`clipped`).
  The plane goes where the picture would be drawn (`planeRect`: contain's own
  size in the box's middle, cover's middle of the frame, fill's whole frame).
- **What the frame draws over every scene** takes a video off its plane: the
  keyboard (`frameKeyboard`, docked or in its window), the mouse cursor (drawn
  into `/dev/fb0` by `cursor_panel.nim`: one that lands on a plane takes it off
  at once, and its video goes to the canvas at the render that asks for:
  `planesCursor`, `cursorOver`), the loading mark (`hidePlanes`), the presence
  code, the control QR and the link code, and a colour correction a plane
  would not get.
- **Moving.** A video whose box moved since the last render (a window dragged,
  a desktop refitted) stays in the canvas until it stays put: no plane follows
  a drag a render late.
- **Each pass.** A scene with a video on a plane runs in every pass, a
  window's on a desktop included (`markVideoPlaneScenesDue`), so every pass
  says where each plane goes or that it must go. The runner settles them
  around the push (`settlePlanesBefore`, `settlePlanesAfter`): before the
  frame goes up, a plane no video claimed in the pass, one that moved and all
  under what the frame draws over the scenes go off; after it, the rest may
  show. No frame of a plane is ever on the glass over what the new picture
  put there.
  Such a pass is the video's own clock, which nobody waits for: it puts no
  loading mark up (`videoOnPlane`), which would take every plane off (a Pi
  Zero's pass takes about the mark's 200 ms: a 360p video played 15.9 frames
  a second instead of 24 until 2026-11-25).
- **Back to the canvas.** A video under the UI again (the Video player's
  controls) relaunches in the canvas with the plane's frame copied into its
  image first, so the picture does not step back; the plane goes once that
  pass is on the panel. A plane the display would not show (a size its scaler
  refuses) or no room for its buffers keeps that player in the canvas.
- **What the canvas holds.** The plane's frame is copied into the player's
  image once a second and when it pauses or ends (`PlaneCopySeconds`,
  `yuvInto`): what `GET /image`, the scene snapshot and the web sockets show,
  and what is there the moment the plane goes. The scene renders that often
  for it; nothing else of the video is a render's.
- `FRAMEOS_VIDEO_PLANES=0` keeps every video in the canvas; the frame's log
  says once whether planes are on and why not (`video:planes`).

Measured on a Pi Zero W (Cloud-W, HyperPixel 4 Square, the VideoCore
decoding, 2026-11-24), frames a second into the 720x720 panel, plane against
canvas: 360p (24 a second) 24.0 against 8.4, real time with 60% of the core
idle; 720p (30) 23.5 against 6.9; 1080p 10.8 against 6.8. What is left of the
CPU is the two copies of each frame: ffmpeg's out of the decoder's uncached
buffer (63% of the core at 720p), and the reader's from the pipe into the
plane's (35%). The video on the plane through a seek with the controls over
it (the canvas, the plane back about 5 s later when they go), the next video
(a phone's tall one on a 405x720 plane), a scene switch (the plane off at
once) and back, and FrameOS stopping (the kernel's fbdev picture back, no
plane). Tests: `video/tests/test_video_planes.nim` (planes in memory: frames
shown when due, held, paused, back to the canvas, refused, buffers with
longer rows; the cut, a box on the panel through a view and render scale,
the settling around the push, the cursor; the ioctls against the kernel's
headers), `js_runtime/tests/test_video_js.nim` (a video nothing covers on a
plane, one under a box and one under the cursor in the canvas) and
`tests/test_video_scenes.nim` (the Video player in a desktop's window on a
plane, in the canvas while another window covers part of it and on the
plane again after; in a layout's yield on a plane where the yield is).

### Zero copy

Where the VideoCore decodes the video (H.264 up to 1920 a side, not turned:
`zeroCopyFits`), the plane shows the decoder's own frames, and no pixel of
them passes through the CPU: ffmpeg only demuxes (`demuxArgs`, as for the
ISP path), the reader feeds the decoder (`video/v4l2_decoder.nim`), and each
of its capture buffers, a dma-buf, is imported into the display once
(`importPlaneBuffer`: PRIME and AddFB2 with the decoder's format, strides and
offsets, `importLayout`). The decoder writes NV12 at the coded size (1920x1088
for 1080p); the framebuffer ends where the picture does, so no source
rectangle shows the padding, and a picture with a corner of its own is
reached by `atVisible`.

- **Who holds what.** The decoder keeps the frames it decodes into, and the
  reader holds at most two more (`PlaneHold`): the one on the glass and the
  one waiting for its time; a third lets the decoder write meanwhile
  (`ZeroCopyHeld`). A frame goes back to the decoder only once the plane has
  moved off it: SETPLANE returns at the vblank that put the next one up. Each
  is a frame of the coded size in CMA (3 MB at 1080p), which the display
  shares; such a launch makes no plane buffers of its own.
- **When.** The reader's clock, as for ffmpeg's frames (`planeStep`): a frame
  waits for its time; one a whole frame late goes back unseen when a newer
  one is decoded already, and is shown when none is; far behind, the clock
  comes to the frames.
- **A seek, a pause.** The frame on the glass when a launch ends stays there,
  the display's (its own handle on the dma-buf), until the next launch shows
  its first one or the plane goes.
- **The canvas's copy** once a second reads the frame through a mapping of
  its dma-buf, the CPU's caches synced around it (`readingFrame`).
- **Giving way.** Where the display will not import or show the decoder's
  frames, or the decoder fails, the plane plays ffmpeg's YUV from where it
  got to, as above (the `video:fallback` event, from `h264_v4l2m2m+plane`),
  then the canvas by the same rules. Failed where that then plays, no player
  of the runtime tries it again (`zeroCopyFailed`); a decoder that could not
  take the video now (`hardwareBusy`) is no fault of the launch's.
  `FRAMEOS_VIDEO_ZERO_COPY=0` plays ffmpeg's YUV on the plane instead
  (`FRAMEOS_VIDEO_ISP=0` leaves the VideoCore's devices alone, this too).

ZERO_COPY_MEASURED

## Hardware

What decodes a source is chosen for its codec (ffprobe's), in this order
(`pickDecode` in `video/args.nim`, then `ispFits`):

- **The VideoCore's decoder, driven by the player** (H.264 on a Pi 0 to 4):
  its frames straight onto a display plane ("Zero copy" in "Planes"), or in
  the canvas through its ISP ("The ISP path" below). ffmpeg only demuxes,
  and nothing of a frame is scaled or converted on the CPU. Which one a
  launch takes is `pickLaunch`.
- **A V4L2 mem2mem decoder** (`-c:v h264_v4l2m2m`): a Pi 0 to 4's VideoCore,
  through its `bcm2835-codec` (`/dev/video10`): H.264, and MPEG-2, MPEG-4 and
  VC-1 where the firmware has them. Used when the machine has a V4L2 decoder
  device and ffmpeg the decoder for the codec.
- **VA-API** (`-hwaccel vaapi`): an Intel or AMD GPU's decoder, the frames
  back in memory for the scaler. Used when there is a render node, a VA
  driver and ffmpeg's `vaapi` hwaccel, and ffmpeg can open the device: a
  driver on disk is not one for the GPU (Mesa's beside an NVIDIA card's).
- **ffmpeg's own**, on `cores - 1` threads.

What the machine has is read once a runtime (`decodeCaps` in
`video/player.nim`); `FRAMEOS_VIDEO_HARDWARE=0` leaves the hardware alone. A
hardware launch that fails (no frame, a non-zero exit in the middle, or no
frame in 20 s: a VideoCore decoder that got some of its buffers and not the
rest waited on its device for ever) is started again with ffmpeg's own from
where it got to, and once ffmpeg's own plays it, no player of that runtime
tries the codec's hardware again (`hardwareFailed`). Two failures are no
hardware's fault, and the next player tries it again: a source that was not
there at all (a camera off), and a decoder that could not take the video now
(`hardwareBusy`: `VIDIOC_REQBUFS failed`). That is no buffers ("Cannot
allocate memory": a VideoCore's are CMA, which every player and the display
share), or no decoder of its own ("Invalid argument", the kernel saying
"failed to create component ril.video_decode": a VideoCore decoding other
videos flat out did not make another in time). Each fallback is in the
frame's log once, as `video:fallback` with what gave way (`from`), what took
over (`to`), the reason and `hardwareKept`, also while the runner has paused
a fast scene's log.

**A V4L2 decoder's buffers.** ffmpeg asks for 16 coded and 20 decoded ones;
at 1080p a VideoCore's are 1.5 and 3 MB of CMA each, 85 MB a video, and on a
Pi Zero W (256 MB of CMA) the fourth 1080p decoder of four failed and another
hung. A decoder hung like that and then killed left the VideoCore unable to
make another until a reboot (every video after it played in software). FrameOS
asks for 6 and 10 (`V4l2OutputBuffers`, `V4l2CaptureBuffers`): 43 MB at
1080p, and the VideoCore decodes as fast (44 frames a second of 1080p,
2026-11-24). Four 1080p feeds at their pace into quarter boxes, a Camera
wall's, ran together with 65 MB of CMA left, and three rounds of starting
them and stopping them with SIGTERM left nothing behind. Fewer than 8 decoded
buffers had ffmpeg warn that all of them were in use.

**The ISP path** (`video/isp.nim`). Where ffmpeg's `h264_v4l2m2m` would
decode an H.264 source and the VideoCore's decoder (`bcm2835-codec-decode`)
and ISP (`bcm2835-codec-isp`) are both there (found by name, `codecDevices`,
never by number), the player drives them itself: ffmpeg only takes the
video out of its container (`demuxArgs`: `-c:v copy -bsf:v h264_mp4toannexb
-f h264`, the same input rules), the reader thread splits the stream into
access units (`video/annexb.nim`) and gives the decoder one a buffer
(`video/v4l2_decoder.nim`), each decoded frame goes into the ISP as the
decoder's own dma-buf, and the ISP's picture, at the frame's size in the
canvas's pixels (RGB565, RGBA, the luma of YUV420 for grey), is copied into
the ring: the CPU's one touch of a frame, and everything after the ring is
as above. `ispFits` leaves to ffmpeg a turned picture (the ISP does not
turn), a source past the decoder's 1920 a side and a frame under the ISP's
32. `FRAMEOS_VIDEO_ISP=0` leaves the path alone. What the VideoCore needs,
found on a Pi Zero W (2026-11-24):
- Both devices are multi-planar only (`video/v4l2.nim`).
- The decoder starts only once its capture queue streams: it is set up at
  once from the size it was told, and again on its source-change event (the
  real one: 1920x1088 frames, a 1920x1080 picture).
- Frames are NV12: the ISP rounds a YUV420 stride up (a 480 px wide video's
  frames would be too small for it) and takes NV12's as the decoder writes
  it. A stride they still disagree on leaves the video to ffmpeg.
- A new frame size needs a new ISP: its buffer sizes stay with the open
  device.
- The ISP's crop keeps a size and drops the corner: `cover` is the picture
  scaled to cover the box, its middle taken as it is copied (`ispSize`).
- A stream copy starts at the keyframe before a start: the frames up to it
  are decoded and dropped (`startSkip`; a slow decoder starts at the
  keyframe anyway); a source faster than the app's rate is thinned as the
  fps filter would (`keepFrame`).
A launch that fails gives way to ffmpeg's `h264_v4l2m2m` from where it got
to, and the rules above go on from there. If that decoder then plays it, no
player of the runtime tries the path again (`ispFailed`), unless the path was
busy (`hardwareBusy`) or would not do this video (`V4l2Unsupported`: a
stride, a size, a format the ISP changes).

Measured on a Pi Zero W (Cloud-W, 2026-11-24), the frames on its 720x720
RGB565 panel counted where the video's timecode changes: 720p 16.3 frames a
second through the ISP path against 6.2 through ffmpeg's decode and scale,
1080p 11.8 against 6.1, 360p 16.3 against 4.7. ffmpeg demuxing takes 4 to 6%
of the core and the reader thread 20 to 25% (the picture's copy out of the
ISP, 0.6 MB a frame the CPU reads uncached: about 8 ms); the render thread
has the rest, 66 to 77%, which is what is left ("Holes" in "Next"). The chain
alone, without the runtime, runs 1080p into 720x405 RGB565 at 37 to 42 frames
a second on 9 ms of CPU a frame, 720p at 54 and 270p at 65. Paused, the path
costs 2% of the core until the idle stop lets it go.

**A decoder that is behind.** A launch whose frames take more than 1.2 frame
times to make over its first 12 is started again where it was with a slow
decoder's shortcuts: no loop filter (`-skip_loop_filter all -flags2 fast`)
and the scaler's `fast_bilinear`, or its nearest pixel (`neighbor`) when it
makes the picture smaller (`scaleFlags`): it reads only the source's rows it
keeps, and reading a VideoCore's frames is what costs a Pi Zero most (157 ms
of ffmpeg a 1080p frame into 720x405 with the fast bilinear, 98 with the
nearest pixel; aliasing on fine detail is the price). A machine of one core (a Pi Zero, a Pi 1)
starts with them, a relaunch costing it seconds. Such a decoder also starts a
file at the keyframe before the time asked for (ffprobe's `-read_intervals
t%+#1`, `keyframeBefore`), the clock from there: an exact start decodes every
frame from that keyframe first (x264 puts them 8 s apart: two minutes of a
Pi Zero's 1080p, black meanwhile), and `-noaccurate_seek` does not help, the
fps filter dropping what it would show. A skip or a drag there lands up to a
keyframe early, as a phone's player does when it seeks fast. Measured on a Pi Zero W,
720p H.264 into its 720x720 RGB565 box (2026-11-24): 2.5 frames a second
plain at 700 MHz, 3.3 with the shortcuts; 3.2 and 4.0 at 1 GHz. A Pi left in
the `powersave` governor (an image from before the kernel's
`cpufreq.default_governor=ondemand`) decodes a fifth slower. `-skip_frame
nonref` made no frame at all of an x264 clip: not used.

What a decoder makes is scaled and turned into the panel's colours by the
CPU, unless the video is on a display plane, where the display does both as
it shows it ("Planes").

**Where.**
- **Buildroot images, Pi 0 to 4**: the kernel keeps the VideoCore's codec
  (`videocore_codec` in `backend/app/tasks/buildroot_platforms.py`: staging,
  V4L2, `bcm2835-codec`, which the shared fragment trims elsewhere) and the
  VideoCore gets 64 MB on a board of 512 MB or more (`gpu_mem_512=64`,
  `gpu_mem_1024=64`; a 256 MB Pi 1 A keeps 32), from the base image built
  after this. An image flashed before has no codec and decodes in software.
- **Raspberry Pi OS, Pi 0 to 4**: the codec is there already.
- **A Pi 5** has no H.264 block; its HEVC decoder is a stateless one
  (v4l2-request), which upstream ffmpeg 6.1 does not drive: ffmpeg's own,
  which it does well ("Where it plays").
- **Intel and AMD** Linux frames: VA-API.

**Measured on a Pi Zero W** (Cloud-W, the 2026.11.15 base image's kernel,
1 GHz, 2026-11-24). The VideoCore decodes 1080p H.264 at 37-44 frames a
second and 720p at 75, against 3.1 and 6.9 in software on its one core. What
FrameOS gets into a 720x720 RGB565 box is less, the core being full of the
rest (see "Next"): hardware against software, 4.9 against 3.0 frames a
second of 720p, 3.8 against 2.2 of 1080p, 6.2 against 4.4 of 360p. Twenty
video switches and seeks in the Video player all decoded in hardware and
left no buffer behind. Don't time `h264_v4l2m2m` with `-f null`: FFmpeg 6.1
aborts as it drains it at the end (`Assertion pkt failed at
fftools/ffmpeg_dec.c:597`, the null muxer holding every decoded buffer), and
a few of those, with runtime restarts, once left 200 MB of decoder buffers
held by no process until a reboot. FrameOS's pipe ends clean. The fallbacks
are tested against a real ffmpeg given a decoder with no device, one short
of memory and one that makes no frame (`test_video_player.nim`).

## Network

A URL goes through `spawn_guard.nim` before ffmpeg sees it, as the RTSP
snapshot app's does: http(s) or rtsp(s) with a host, the private-network
policy of the HTTP client (a cloud frame's Local network access,
`docs/lan-access.md`), and, while that policy holds the URL, ffmpeg is given
the address the check resolved (a pinned URL, the name in the `Host` header).
ffmpeg may open only the protocols of that scheme (`-protocol_whitelist`:
`file` for a file, nothing else), and while the policy holds the URL no
demuxer that reads a list of further URLs (`-format_whitelist` without hls,
dash, concat): ffmpeg would open those without the guard seeing them. Over
http(s) it reconnects a dropped stream and gives up after 15 s of silence;
RTSP goes over TCP.

A video, unlike the RTSP snapshot app, is no shell command: a cloud-managed
Pi plays one. Its scenes say `video` among their needs, never `linux`.

## Where it plays

- **Buildroot images**: FFmpeg 6.1 with ffprobe and swscale, GnuTLS for
  https, and the v4l2m2m decoders (`backend/app/tasks/buildroot_image.py`).
  Measured on a Pi 5 (Cloud-5, 2026-11-24), decoding H.264 and scaling to an
  800x480 box with three threads: a 1080p clip at 64-75 frames a second, a 720p
  one at 110-130 (`ffmpeg … -f rawvideo - > /dev/null`, about 290% CPU).
  A Pi Zero W (Cloud-W, one core at 700 MHz, the image's `powersave`
  governor) is no video player in software: into its 720x720 RGB565 box,
  ffmpeg alone made 6.9 frames a second of a 270p clip, 3.8 of a busy 360p
  one and 2.7 of 720p (2026-11-24), the scale and the colour conversion
  costing as much as the decode, 4.0 of 720p with the shortcuts at 1 GHz
  ("Hardware"). With its VideoCore decoding (a base image from 2026.11.15 on)
  ffmpeg makes 7.3 of 720p and 5.2 of 1080p there; what is left between
  that and real time is in "Next".
- **Raspberry Pi OS**: the backend's deploy installs the `ffmpeg` package when
  one of the frame's scenes plays video or uses the RTSP snapshot app
  (`_scenes_use_ffmpeg` in `frame_deploy_workflow.py`). A cloud-managed Pi OS
  frame needs `sudo apt install ffmpeg` by hand: the cloud installs no
  packages. Without it every call answers "ffmpeg is not installed on this
  frame". `FRAMEOS_FFMPEG` / `FRAMEOS_FFPROBE` name other binaries.
- **An ESP32** answers every call with "Video needs a Raspberry Pi frame",
  `frameos.video`'s `id` 0 and `state` `error` (a stub of a few hundred bytes
  of the image, and the prelude's five entries). The scene need `video`
  (`frontend/src/utils/sceneNeeds.ts`: a call to `frameos.video`,
  `videoFrame` or `videoInfo`) keeps a video scene out of an ESP32's store
  (`without=video`) and off its Install.
- **The wasm runtime** (the browser preview, a board or virtual frame its
  plane renders) answers "Video plays on a Raspberry Pi frame, not here".

## The samples

- **Video player**: the videos of a folder (`videos/` by default) one after
  another, for ever, by name or shuffled, the folder or one video again and
  again, played like a phone's player: a tap shows the controls (10 s back
  and on, pause, the video before and after, the list, a bar to drag or
  tap, which seeks when the finger lifts) and another hides them, as a few
  seconds of playing does; a double tap on the left or right third skips
  10 s, a swipe across the picture or in from the screen's edge (`back` /
  `forward`) changes the video. A gesture goes to the innermost element with
  a handler for it, so the bar and the buttons take the taps, double taps
  and swipes that start on them (a drag along the bar lifts as a swipe too),
  and the bar keeps 28 px from the screen's sides, where a press is held for
  the frame's edge swipe. The keys too (its `onEvent`: the arrows 10 s, space or K
  pause, N and P or Page Down and Up the video, Home its start, 0 to 9 a
  tenth of the way in, L the list). Where it was is kept on disk.
- **Files** plays the videos it lists: a frame of each as its thumbnail, the
  viewer playing one with a pause button and its time, the slideshow waiting
  for a video to end.
- **Immich videos**: random videos from the frame's Immich server (the
  library, an album, the favorites), Immich's own stream of each with the
  key, when and where at the start.
- **Camera wall**: up to four live feeds, a tap for one on the whole screen.
- **Video from URL**: one file, stream or camera on the whole screen, looped.
- **Archive films**: films from an Internet Archive collection, from its
  most watched, the title and year at the start.
- **Slow movie**: a still every few minutes, each a few seconds of film
  further on (`videoFrame`): made for e-paper.

`frameos/src/frameos/tests/test_video_scenes.nim` plays them over clips made
with lavfi (Video from URL over a local HTTP server); the player has its own
tests (`video/tests/test_video_player.nim`), and so does the bridge
(`js_runtime/tests/test_video_js.nim`, a frame repainting only the video's
box). All three skip without ffmpeg.

## Next

- **Holes**: a `<video>` drawn straight into the canvas as a `<Scene>` is,
  the UI around it not run per frame (`docs/scene-layouts.md`, `seekHoles`).
  Today the app's `get()` and the layout run every frame: with the ISP path
  that render is what holds a Pi Zero W at 12 to 16 frames a second (66 to
  77% of its core, 2026-11-24).
- **Real time on a Pi 0 to 4.** Where a 1080p frame goes on a Pi Zero W with
  the VideoCore decoding (ffmpeg's CPU a frame, `-benchmark`, 2026-11-24):
  - *Reading the decoder's frames.* Its buffers are uncached for the CPU:
    copying a 1080p frame out of one takes 42 ms, scaling it to 720x405 150
    (the same scale of a frame in RAM, after a software decode, 63). This is
    the most of it; neighbour scaling, which reads fewer of its rows, 98.
  - *Not the colour conversion*: to RGB565 and to RGBX cost the same, and 565
    is half the bytes after it (the panel is 565).
  - *The pad*: 34 ms to put the 720x405 picture in a black 720x720 frame,
    whose 1 MB then went through the pipe (9 ms), the ring and two copies.
    Gone: a contained picture comes at its own size ("How it plays").
  - *The runtime's own*: a render of 18 to 35 ms and a push to the panel of
    13 to 17 a frame (`get()` and the layout every frame: "Holes").

  30 frames a second is 33 ms a frame for all of it, so the pixels have to
  leave the CPU. Two ways, which meet in the end (the decoder's buffers
  straight onto a plane):
  1. *The ISP*: done ("The ISP path" in "Hardware"). The CPU reads 0.6 MB
     of RGB565 a frame out of the ISP instead of scaling a 1080p one: what
     is left is the runtime's own ("Holes"). Its decoder client
     (`video/v4l2_decoder.nim`) hands out the decoded frames as dma-bufs,
     which is what a plane takes.
  2. *DRM planes*: done for a video nothing covers ("Planes"), its frames
     still copied twice on the way (out of the decoder by ffmpeg, through
     the pipe into the plane's buffer: a 1080p frame is 3 MB). What is left:
     - *Zero copy*: the decoder's own buffers (dma-bufs, the ISP way's V4L2
       client) handed to the plane, for 1080p at 30 and four cameras at once.
     - *The UI over a video* (the Video player's controls) in a plane above
       it with alpha, rather than the canvas meanwhile; and a video's name
       over it while it loads keeps it in the canvas until it plays.
     - *Other panels*: an RGBA canvas (a 32 bpp HDMI screen, which is not
       the panel canvas), and a turned panel, which the HVS cannot turn by
       90 or 270 (the frames would be turned by ffmpeg, which costs what the
       plane saves). A Pi 5's DPI goes through the RP1, which has no such
       planes; its HDMI is vc4's, for a Pi 5's software decode with no
       scaler.
- **A Pi 5's HEVC** once ffmpeg drives v4l2-request.
- **Audio**: frames have no speakers; ALSA is not in the image.
- **The preview**: the browser could play the video itself.
