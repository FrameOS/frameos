// Immich photos: JSON over frameos.httpRequest, the photo through frameos.fetchImage (decoded natively).
const EXIF = ['make', 'model', 'fNumber', 'exposureTime', 'iso', 'focalLength', 'dateTimeOriginal']
const NO_IMAGES = 'Immich returned no image assets.'

function request(key, url, method = 'GET', body = '') {
  const headers = { 'x-api-key': key, Accept: 'application/json', 'Content-Type': 'application/json' }
  return frameos.httpRequest(url, { method, headers, body, timeoutMs: 30000 })
}

function parse(body) {
  try {
    return JSON.parse(body ?? '')
  } catch {
    return null
  }
}

function httpError(r) {
  if (r.status === 0) return r.error ? `request failed: ${r.error}` : 'request failed'
  const body = r.body ?? ''
  let message = `HTTP ${r.status}`
  try {
    const json = JSON.parse(body)
    const d = json?.message
    if (typeof d === 'string' && d) message += `: ${d}`
    else if (Array.isArray(d) && d.length) message += `: ${typeof d[0] === 'string' ? d[0] : JSON.stringify(d[0])}`
    else if (typeof json?.error === 'string' && json.error) message += `: ${json.error}`
  } catch {
    if (body.length > 0 && body.length < 300) message += `: ${body}`
  }
  return message
}

function images(list) {
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && typeof a === 'object' && a.type === 'IMAGE')
    .map((a) => {
      const exif = {}
      for (const k of EXIF) if (a.exifInfo?.[k] != null) exif[k] = a.exifInfo[k]
      const people = (Array.isArray(a.people) ? a.people : []).map((p) => p?.name ?? '').filter((n) => n !== '')
      const name = a.originalFileName ? String(a.originalFileName) : ''
      return { id: String(a.id ?? ''), name, favorite: !!a.isFavorite, exif, people }
    })
}

const pick = (assets) => (assets.length ? assets[Math.floor(Math.random() * assets.length)] : null)

function random(server, key, empty, albumId = '', personId = '', favorite = false) {
  const search = { size: 1, type: 'IMAGE', withExif: true, withPeople: true }
  if (albumId) search.albumIds = [albumId]
  if (personId) search.personIds = [personId]
  if (favorite) search.isFavorite = true
  let r = request(key, `${server}/api/search/random`, 'POST', JSON.stringify(search))
  const legacy = r.status === 404
  if (legacy) {
    frameos.log(
      'This Immich server lacks POST /api/search/random; falling back to /api/assets/random where album/person/favorite filters cannot be applied.'
    )
    r = request(key, `${server}/api/assets/random?count=20`)
  }
  if (r.status !== 200) throw new Error(`Error fetching a random image from Immich: ${httpError(r)}`)
  let assets = images(parse(r.body))
  if (legacy && favorite) assets = assets.filter((a) => a.favorite)
  const scope = albumId
    ? `album ${albumId}`
    : personId
    ? `person ${personId}`
    : favorite
    ? 'favorites'
    : 'whole library'
  frameos.log(`Immich random search (${scope}): HTTP ${r.status}, ${assets.length} image candidate(s)`)
  if (!assets.length) {
    throw new Error(legacy ? 'This Immich server returned no matching images from /api/assets/random.' : empty)
  }
  return pick(assets)
}

export function get(app) {
  const c = app.config
  const server = String(frameos.getSetting('immich', 'url') ?? '')
    .trim()
    .replace(/\/+$/, '')
  if (!server) throw new Error('Please provide an Immich server URL in the settings.')
  const key = String(frameos.getSetting('immich', 'apiKey') ?? '')
  if (!key) throw new Error('Please provide an Immich API key in the settings.')
  const albumId = c.albumId.trim()
  if (c.mode === 'album' && !albumId) {
    throw new Error("Please provide an album ID. It's the UUID visible in the album's URL.")
  }

  let asset
  if (c.mode === 'album') {
    const empty = "This album contains no images. Double-check the album ID. It's the UUID in the album's URL."
    asset = random(server, key, empty, albumId)
  } else if (c.mode === 'favorites') {
    asset = random(server, key, 'No favorite images found in Immich.', '', '', true)
  } else if (c.mode === 'memories') {
    const now = new Date()
    const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, '0')).join('-')
    const r = request(key, `${server}/api/memories?for=${date}`)
    if (r.status === 200) {
      const memories = parse(r.body)
      const assets = Array.isArray(memories)
        ? memories.flatMap((m) => (m && typeof m === 'object' ? images(m.assets) : []))
        : []
      frameos.log(`Immich memories for ${date}: HTTP 200, ${assets.length} image candidate(s)`)
      asset = pick(assets)
    } else frameos.log(`No Immich memories for today (${httpError(r)}), showing a random image instead.`)
    asset ??= random(server, key, NO_IMAGES)
  } else {
    asset = random(server, key, NO_IMAGES, '', c.personId.trim())
  }
  if (!asset.id) throw new Error('Immich returned an asset without an ID.')

  const full = c.previewSize === 'fullsize'
  frameos.log(`Showing Immich asset ${asset.id} (${asset.name || 'unnamed'}, ${full ? 'fullsize' : 'preview'})`)
  const id = encodeURIComponent(asset.id)
  const ext = full && /^.+\.([a-z0-9]{1,5})$/i.exec(asset.name)
  const saveAsset =
    c.saveAssets === 'auto' || c.saveAssets === 'always'
      ? {
          name: asset.name.replace(/\.[^.]*$/, '') || asset.id,
          extension: ext ? `.${ext[1].toLowerCase()}` : '.jpg',
          mode: c.saveAssets,
        }
      : undefined
  const url = full ? `${server}/api/assets/${id}/original` : `${server}/api/assets/${id}/thumbnail?size=preview`
  const photo = frameos.fetchImage(url, { headers: { 'x-api-key': key }, saveAsset })
  if (!photo.image) throw new Error(`Error fetching image from Immich: ${photo.error ?? 'no image'}`)
  const stateKey = c.metadataStateKey.trim()
  if (stateKey) {
    const people = asset.people.length ? { people: asset.people } : {}
    frameos.setState(stateKey, {
      source: 'immich',
      id: asset.id,
      originalFileName: asset.name,
      ...asset.exif,
      ...people,
    })
  }
  return photo.image
}
