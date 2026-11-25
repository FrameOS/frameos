// Frame bench: video (framebench/video.py). The file the scene's `file`
// field names (a bench clip copied to the frame's assets) on a loop,
// contained, as the Video player shows one: on a display plane where the
// frame has them. How its frames go is the runtime's `video:playback` log
// line, which the suite reads; an empty `file` lets the video go, so its
// last line is logged.
let shown = null

export function get(app) {
  const file = String(app.state.file || '')
  if (!file) {
    if (shown) {
      frameos.releaseVideo(shown)
      shown = null
    }
    return <div className="w-full h-full bg-black" />
  }
  shown = frameos.video('bench', { src: file, loop: true, fit: 'contain' })
  return (
    <div className="w-full h-full bg-black">
      <img className="w-full h-full object-contain" src={shown} />
    </div>
  )
}
