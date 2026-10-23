// A random image from a FrameOS gallery, scaled on the gallery server to this
// frame's panel: the frame then downloads and decodes only the pixels it
// shows (an 800x480 JPEG is ~125 KB where the original PNG is 1.5 to 4.7 MB),
// which on a battery-powered ESP32 is most of what a render costs.
export function get(app: FrameOSApp, context: FrameOSContext) {
  const { category, categoryOther, format, fit } = app.config
  const name = category === 'other' ? categoryOther.trim() : category
  if (!name) throw new Error('Please enter the name of a gallery under "Category (if other)".')
  let url = `https://gallery.frameos.net/image?category=${encodeURIComponent(name)}`
  if (format !== 'original') {
    // The size the image will be drawn at: the target the interpreter
    // addressed to this node (a split cell is smaller than the frame), else
    // the panel as the scene sees it (a turned frame swaps its sides).
    const f = app.frame
    const turned = f.rotate === 90 || f.rotate === 270
    const width = context?.targetWidth || (turned ? f.height : f.width)
    const height = context?.targetHeight || (turned ? f.width : f.height)
    if (width > 0 && height > 0) {
      // "auto" follows the consumer's placement: only contain keeps the
      // whole picture; cover, stretch, center and the rest want it filled.
      const placement = fit === 'auto' || !fit ? context?.targetFit : fit
      const encoding = format === 'png' ? 'png' : 'jpg'
      url += `&width=${width}&height=${height}&fit=${placement === 'contain' ? 'contain' : 'cover'}&format=${encoding}`
    }
  }
  frameos.log(`FrameOS Gallery category: ${name}`)
  const photo = frameos.fetchImage(url)
  if (!photo.image)
    throw new Error(`An error occurred while downloading the gallery image. ${photo.error ?? 'unknown error'}`)
  return photo.image
}
