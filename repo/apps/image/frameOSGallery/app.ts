export function get(app: FrameOSApp) {
  const { category, categoryOther } = app.config
  const name = category === 'other' ? categoryOther.trim() : category
  if (!name) throw new Error('Please enter the name of a gallery under "Category (if other)".')
  frameos.log(`FrameOS Gallery category: ${name}`)
  const photo = frameos.fetchImage(`https://gallery.frameos.net/image?category=${encodeURIComponent(name)}`)
  if (!photo.image)
    throw new Error(`An error occurred while downloading the gallery image. ${photo.error ?? 'unknown error'}`)
  return photo.image
}
