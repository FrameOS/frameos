// A random image from a FrameOS gallery, scaled on the gallery server to the
// size it will be drawn at: the frame then downloads and decodes only the
// pixels it shows (an 800x480 JPEG is ~125 KB where the original PNG is 1.5 to
// 4.7 MB), which on a battery-powered ESP32 is most of what a render costs.
//
// `hold` keeps a picture for that many seconds (the scene's interval): a render
// in between draws the same one again, whatever asked for it and at whatever
// size it is drawn at by then: a window moved, resized or uncovered on a
// desktop, another window changing. A tap, a key that turns a page, a frame's
// button or a finger's swipe asks for the next one at once. The gallery picks at
// random every time, so a picture is kept here, never asked for again. 0
// (the default) is a new picture every render, as before 1.2.0. Not on an
// ESP32: a picture kept is one more the size of the panel beside its canvas
// (a 13.3" e-paper's would not fit), and one that sleeps starts afresh at
// every wake anyway. There each render decodes its picture straight into
// where it is drawn, as before, and the keys and taps still turn it.

type Held = { key: string; image: FrameOSImageRef; at: number; asks: number }

// The pictures held, by node (a scene may show two galleries), and how many
// times the next one was asked for: every gallery in the scene turns.
const held = new Map<number, Held>()
let asks = 0

// A render this close to the hold's end is the scene's own interval come
// round: the next picture.
const SLACK_MS = 2000

// The keys that turn a page. One with Alt, Ctrl or Cmd is the desktop's
// (Alt+Tab), and a held key repeats nothing.
const NEXT_KEYS = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'N']
const NEXT_CODES = ['ArrowRight', 'ArrowDown', 'PageDown', 'Space', 'Enter', 'NumpadEnter', 'KeyN']

export function onEvent(app: FrameOSApp, context: FrameOSContext): boolean {
  const payload = (context.payload || {}) as Record<string, any>
  if (context.event === 'keyDown') {
    if (payload.alt || payload.ctrl || payload.meta || payload.repeat) return false
    if (!NEXT_KEYS.includes(payload.key) && !NEXT_CODES.includes(payload.code)) return false
  } else if (context.event === 'button') {
    // A long press is the frame's own (its event map: the scene switcher, voice).
    if (payload.action && payload.action !== 'press' && payload.action !== 'doublePress') return false
  } else if (context.event === 'swipe') {
    // A finger's swipe turns the page; a mouse dragged over a window's picture
    // on a desktop is no ask for another.
    if (payload.pointerType === 'mouse') return false
  } else if (!['tap', 'forward', 'back'].includes(context.event)) {
    return false
  }
  asks += 1
  return true
}

export function get(app: FrameOSApp, context: FrameOSContext) {
  const { category, categoryOther, format, fit } = app.config
  const name = category === 'other' ? categoryOther.trim() : category
  if (!name) throw new Error('Please enter the name of a gallery under "Category (if other)".')
  const hold = app.frame.embedded === true ? 0 : Math.max(0, Number(app.config.hold) || 0)
  const key = `${name}|${format}|${fit}`
  const kept = held.get(app.nodeId)
  if (hold > 0 && kept && kept.key === key && kept.asks === asks && Date.now() - kept.at < hold * 1000 - SLACK_MS) {
    return kept.image
  }
  let url = `https://gallery.frameos.net/image?category=${encodeURIComponent(name)}`
  if (format !== 'original') {
    // The size the image will be drawn at: the target the interpreter
    // addressed to this node (an image node's box, a split cell), else the
    // canvas this run draws on. Both are in scene pixels, already turned with
    // the frame; the app never looks at the panel itself.
    let width = context.targetWidth || context.imageWidth || 0
    let height = context.targetHeight || context.imageHeight || 0
    if (width > 0 && height > 0) {
      // A picture held in a desktop's window may be drawn bigger before the
      // next one: asked for as big as the desktop's longer side, its window's
      // shape kept, so a window made bigger shows it sharp.
      const desktop = Math.max(app.frame.width || 0, app.frame.height || 0)
      const longer = Math.max(width, height)
      if (hold > 0 && Array.isArray(app.frame.scenes) && desktop > longer) {
        width = Math.round((width * desktop) / longer)
        height = Math.round((height * desktop) / longer)
      }
      // "auto" follows the consumer's placement: only contain keeps the
      // whole picture; cover, stretch, center and the rest want it filled.
      const placement = fit === 'auto' || !fit ? context.targetFit : fit
      const encoding = format === 'png' ? 'png' : 'jpg'
      url += `&width=${width}&height=${height}&fit=${placement === 'contain' ? 'contain' : 'cover'}&format=${encoding}`
    }
  }
  frameos.log(`FrameOS Gallery category: ${name}`)
  // Held, the picture is kept for later renders; otherwise each render's own.
  const photo = hold > 0 ? frameos.fetchImage(url, { keep: true }) : frameos.fetchImage(url)
  if (!photo.image) {
    const error = `An error occurred while downloading the gallery image. ${photo.error ?? 'unknown error'}`
    // The picture held stays up, and the next render asks again.
    if (hold > 0 && kept) {
      frameos.log(error)
      return kept.image
    }
    throw new Error(error)
  }
  if (kept && typeof frameos.releaseImage === 'function') frameos.releaseImage(kept.image)
  if (hold > 0) held.set(app.nodeId, { key, image: photo.image, at: Date.now(), asks })
  else held.delete(app.nodeId)
  return photo.image
}
