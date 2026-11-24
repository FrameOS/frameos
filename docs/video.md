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
  `-i <src> -vf fps=F,scale=…,pad|crop=W:H,setsar=1 -f rawvideo -pix_fmt X pipe:1`.
  Every frame comes out exactly `W` x `H` (the `<img>`'s box in panel pixels),
  so the draw is a copy; `contain` pads with black, `cover` crops. `X` is the
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
frame (`runner.nim`, as for a scene under a second).

## Hardware

What decodes a source is chosen for its codec (ffprobe's), in this order
(`pickDecode` in `video/args.nim`):

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
hardware launch that fails (no frame, or a non-zero exit in the middle) is
started again with ffmpeg's own from where it got to, and once ffmpeg's own
plays it, no player of that runtime tries the codec's hardware again
(`hardwareFailed`). A source that was not there at all (a camera off) is no
hardware's fault: its next try has the hardware again.

**A decoder that is behind.** A launch whose frames take more than 1.2 frame
times to make over its first 12 is started again where it was with a slow
decoder's shortcuts: no loop filter (`-skip_loop_filter all -flags2 fast`)
and the scaler's `fast_bilinear`. A machine of one core (a Pi Zero, a Pi 1)
starts with them, a relaunch costing it seconds. Measured on a Pi Zero W,
720p H.264 into its 720x720 RGB565 box (2026-11-24): 2.5 frames a second
plain at 700 MHz, 3.3 with the shortcuts; 3.2 and 4.0 at 1 GHz. A Pi left in
the `powersave` governor (an image from before the kernel's
`cpufreq.default_governor=ondemand`) decodes a fifth slower. `-skip_frame
nonref` made no frame at all of an x264 clip: not used.

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

Not yet run on a Pi with the codec (the bench's Pi Zero W has an image from
before it): the fallback is tested against a real ffmpeg given a decoder with
no device (`test_video_player.nim`).

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
  ("Hardware"). It plays, slowly (the clock follows the decoder); its
  VideoCore's H.264 decoder is the way to real time there.
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
  again; a tap shows the controls (back, pause, next, the list, the bar to
  seek); where it was is kept on disk.
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
  Today the app's `get()` and the layout run every frame.
- **More hardware**: the scale and the colour conversion on the VideoCore's
  ISP (`bcm2835-isp`, a V4L2 mem2mem device upstream ffmpeg has no filter
  for), half a Pi Zero's frame; a Pi 5's HEVC once ffmpeg drives
  v4l2-request; then zero copies: the frames in the panel's buffer, or a DRM
  plane.
- **Audio**: frames have no speakers; ALSA is not in the image.
- **The preview**: the browser could play the video itself.
- **On the device**: these numbers are FFmpeg's alone. The runtime's playback
  on a Pi (render, driver push, frames dropped) is to be measured with a
  build of this branch on Cloud-5.
