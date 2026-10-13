// A random Unsplash photo for a search; frameos.fetchImage decodes it natively.
const enc = (s) =>
  encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+')
const str = (v, d = '') => (typeof v === 'string' ? v : d)

export function get(app, context) {
  const { config: c, frame: f } = app
  const turned = f.rotate === 90 || f.rotate === 270
  const w = context.imageWidth || (turned ? f.height : f.width)
  const h = context.imageHeight || (turned ? f.width : f.height)
  const search = c.search.trim()
  const stateKey = c.metadataStateKey.trim()
  const fail = (m) => {
    throw new Error(`Error fetching image from Unsplash: ${m}`)
  }

  const key = str(frameos.getSetting('unsplash', 'accessKey'))
  if (!key) throw new Error('Please provide an Unsplash API key in the settings.')
  const o = c.orientation
  const orientation = o === 'auto' ? (h > w ? 'portrait' : w > h ? 'landscape' : 'squarish') : o === 'any' ? '' : o
  const url = `https://api.unsplash.com/photos/random/?orientation=${enc(orientation)}&query=${enc(search)}`
  if (f.debug) frameos.log(`API request: ${url}`)
  const r = frameos.httpRequest(url, {
    headers: { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1', 'Content-Type': 'application/json' },
    timeoutMs: 60000,
  })
  if (!r.status) fail(r.error)
  if (r.status !== 200) {
    let detail = r.body
    try {
      const j = JSON.parse(r.body)
      detail = str(j?.error?.message, str(j?.error, JSON.stringify(j)))
    } catch {}
    throw new Error(`Error making request ${r.status}: ${detail}`)
  }
  let j
  try {
    j = JSON.parse(r.body)
  } catch (e) {
    fail(e.message)
  }
  const raw = str(j?.urls?.raw)
  if (!raw) throw new Error('No image URL returned from Unsplash.')
  const imageUrl = `${raw}&w=${w}&h=${h}&fit=crop&crop=faces,edges`
  const description = str(j.description, str(j.alt_description))
  const meta = stateKey && {
    source: 'unsplash',
    search,
    orientation,
    imageUrl,
    id: str(j.id),
    title: str(j.slug, description),
    description,
    altDescription: str(j.alt_description),
    location: str(j.location?.name),
    createdAt: str(j.created_at),
    photoUrl: str(j.links?.html),
    author: str(j.user?.name),
    authorUsername: str(j.user?.username),
    authorUrl: str(j.user?.links?.html),
  }
  j = null

  if (f.debug) frameos.log(`Downloading image: ${imageUrl}`)
  const mode = c.saveAssets
  const photo = frameos.fetchImage(imageUrl, {
    saveAsset:
      mode === 'auto' || mode === 'always' ? { name: `${search} ${w}x${h}`, extension: '.jpg', mode } : undefined,
  })
  if (!photo.image) fail(photo.error)
  if (meta) frameos.setState(stateKey, meta)
  return photo.image
}
