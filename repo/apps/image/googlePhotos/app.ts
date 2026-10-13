// Google Photos has no API for shared albums: this scrapes the public share page for photo paths.
const HOST = 'https://lh3.googleusercontent.com/'
const PATH = /[\w\-\/=.\\]*/y

// The page as one string, or the snippets httpRequest's `find` returns.
export function extractPhotoPaths(texts) {
  const paths = new Set()
  for (const text of [].concat(texts)) {
    for (let i = text.indexOf(HOST); i >= 0; i = text.indexOf(HOST, i)) {
      PATH.lastIndex = i += HOST.length
      const raw = PATH.exec(text)[0]
      i += raw.length
      const path = raw
        .replace(/\\+$/, '')
        .replace(/\\u003d/g, '=')
        .replace(/\\u0026/g, '&')
        .replace(/\\\//g, '/')
        .split('=')[0]
      if (path.length > 60 && (path.startsWith('pw/') || path.includes('AF1Qip'))) paths.add(path)
    }
  }
  return [...paths]
}

export const sizedPhotoUrl = (base, width, height, fitMode) =>
  `${base}=w${width}-h${height}-${fitMode === 'contain' ? 'no' : 'c'}`

export const wrapIndex = (counter, count) => (count > 0 ? ((counter % count) + count) % count : 0)

function albumPaths(url, debug) {
  if (debug) frameos.log(`Fetching shared album: ${url}`)
  const r = frameos.httpRequest(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Accept: 'text/html',
    },
    timeoutMs: 60000,
    // Just the text at each photo link: a 1.2 MB page does not fit an ESP32's JS heap.
    find: HOST,
    findLength: 400,
  })
  if (r.status !== 200) throw new Error(r.status ? `Error ${r.status} while fetching the shared album page.` : r.error)
  const paths = extractPhotoPaths(r.found)
  if (!paths.length) {
    throw new Error(
      'No photos found on the shared album page. Make sure the link is a public share link and the album is not empty.'
    )
  }
  if (debug) frameos.log(`Found ${paths.length} photos in the shared album`)
  return paths
}

export function get(app, context) {
  const c = app.config
  const f = app.frame
  const url = c.shareUrl.trim()
  const counterKey = c.counterStateKey.trim()
  const metaKey = c.metadataStateKey.trim()
  const width = context.imageWidth || (f.rotate % 180 ? f.height : f.width)
  const height = context.imageHeight || (f.rotate % 180 ? f.width : f.height)
  if (!url) throw new Error('Please provide a Google Photos shared album link.')
  if (!/^https?:\/\//.test(url)) throw new Error(`Invalid shared album link: ${url}`)

  let album = frameos.recall('album')
  if (album?.url !== url || Date.now() / 1000 - album.at >= (c.cacheAlbumSeconds > 0 ? c.cacheAlbumSeconds : 3600)) {
    try {
      album = { url, paths: albumPaths(url, f.debug), at: Date.now() / 1000 }
      const mark = `${url} ${album.paths.length}`
      if (frameos.recall('unkept') !== mark) {
        if (frameos.remember('album', album)) frameos.remember('unkept', null)
        else {
          frameos.remember('album', null)
          frameos.remember('unkept', mark)
          frameos.log(`The album's ${album.paths.length} photos are too many to keep: it is fetched on every render.`)
        }
      }
    } catch (e) {
      if (album?.url !== url) throw new Error(`Error loading the shared album: ${e.message}`)
      frameos.error(`Error refreshing the shared album, reusing the cached photo list: ${e.message}`)
    }
  }

  const count = album.paths.length
  let index
  if (c.mode === 'sequential') {
    const saved = frameos.recall('counter') ?? app.state[counterKey]
    index = wrapIndex(Number.isInteger(saved) ? saved : 0, count)
    const next = wrapIndex(index + 1, count)
    frameos.remember('counter', next)
    if (counterKey) frameos.setState(counterKey, next)
  } else index = Math.floor(Math.random() * count)

  const imageUrl = sizedPhotoUrl(HOST + album.paths[index], width, height, c.fitMode)
  if (f.debug) frameos.log(`Downloading image: ${imageUrl}`)
  const name = `google-photos ${index} ${width}x${height}`
  const photo = frameos.fetchImage(imageUrl, { saveAsset: { name, extension: 'jpg', mode: c.saveAssets } })
  if (!photo.image) throw new Error(`Error fetching image from Google Photos: ${photo.error}`)
  if (metaKey) frameos.setState(metaKey, { source: 'googlePhotos', index, count, imageUrl })
  return photo.image
}
