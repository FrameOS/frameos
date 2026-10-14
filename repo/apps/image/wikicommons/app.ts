// Wikimedia Commons pictures of the day or random files; frameos.fetchImage decodes them natively.
const UA = 'FrameOS Wikimedia Commons app (https://github.com/FrameOS/frameos)'
const str = (v, d = '') => (typeof v === 'string' ? v : d)
const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1))
const pad = (n) => String(n).padStart(2, '0')
const days = (y, m) =>
  m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31
const text = (v) =>
  str(v)
    .replace(/<[^>]*>?|>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()

function find(query, width) {
  const r = frameos.httpRequest(
    `https://commons.wikimedia.org/w/api.php?format=json&formatversion=2&action=query&${query}&prop=imageinfo` +
      `&iiprop=url%7Cmime%7Cextmetadata&iiextmetadatafilter=ImageDescription%7CObjectName%7CArtist%7CLicenseShortName&iiurlwidth=${width}`,
    { headers: { Accept: 'application/json', 'User-Agent': UA }, timeoutMs: 60000 }
  )
  if (!r.status) throw new Error(r.error)
  if (r.status >= 400) throw new Error(`Wikimedia Commons API HTTP ${r.status}`)
  const j = JSON.parse(r.body)
  if (j?.error !== undefined) {
    throw new Error(`Wikimedia Commons API error: ${str(j.error?.info, JSON.stringify(j.error))}`)
  }
  for (const page of j?.query?.pages ?? []) {
    const i = page.imageinfo?.[0]
    const mime = str(i?.mime)
    const imageUrl = str(i?.thumburl, str(i?.url))
    if (!mime.startsWith('image/') || !imageUrl) continue
    const md = (key) => text(i.extmetadata?.[key]?.value)
    return {
      title: str(page.title),
      description: md('ImageDescription') || md('ObjectName'),
      author: md('Artist'),
      license: md('LicenseShortName'),
      pageUrl: str(i.descriptionurl),
      imageUrl,
      mime,
    }
  }
  throw new Error('No supported image returned from Wikimedia Commons.')
}

function retry(what, attempt) {
  let last = ''
  for (let i = 0; i < 10; i++) {
    try {
      return attempt()
    } catch (e) {
      last = e.message
    }
  }
  throw new Error(`Could not find a random Wikimedia Commons ${what}: ${last}`)
}

export function get(app, context) {
  const { config: c, frame: f } = app
  const turned = f.rotate === 90 || f.rotate === 270
  const w = context.imageWidth || (turned ? f.height : f.width)
  const h = context.imageHeight || (turned ? f.width : f.height)
  const mode = c.mode.trim()
  const sub = (c.submode ?? '').trim()
  const stateKey = c.metadataStateKey.trim()
  const save = c.saveAssets
  const norm = ['', 'potd', 'pictureOfTheDay'].includes(mode)
    ? ['', 'day'].includes(sub)
      ? 'pictureOfTheDay'
      : ['onthisday', 'onThisDay'].includes(sub)
      ? 'onThisDay'
      : ['month', 'random', 'randomPotd', 'randomPictureOfTheDay'].includes(sub)
      ? 'randomPictureOfTheDay'
      : mode
    : mode === 'random'
    ? 'randomImage'
    : mode
  const width = Math.max(w, h, 1)
  const now = new Date()
  const [Y, M, D] = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
  const potd = (y, m, d) =>
    find(`generator=images&titles=Template%3APotd%2F${y}-${pad(m)}-${pad(d)}&gimlimit=20`, width)

  let img
  try {
    if (norm === 'pictureOfTheDay') img = potd(Y, M, D)
    else if (norm === 'onThisDay') {
      let y = 0
      for (let i = 0; i < 100 && !y; i++) {
        const t = rand(2008, Math.max(2008, Y - 1))
        if (D <= days(t, M)) y = t
      }
      if (!y) throw new Error('No previous Wikimedia Commons picture of the day exists for this date.')
      img = potd(y, M, D)
    } else if (norm === 'randomPictureOfTheDay') {
      img = retry('picture of the day', () => {
        const y = rand(2008, Y)
        const m = rand(1, y === Y ? M : 12)
        return potd(y, m, rand(1, y === Y && m === M ? Math.min(days(y, m), D) : days(y, m)))
      })
    } else if (norm === 'randomImage') {
      img = retry('image', () => find('generator=random&grnnamespace=6&grnlimit=20', width))
    } else throw new Error(`Invalid Wikimedia Commons mode: ${mode}`)
  } catch (e) {
    throw new Error(`Error fetching image from Wikimedia Commons: ${e.message}`)
  }

  if (f.debug) frameos.log(`Downloading Wikimedia Commons image: ${img.imageUrl}`)
  const path = img.imageUrl.split('?')[0].toLowerCase()
  const extension =
    /\.(jpe?g|png|gif|webp|svg)$/.exec(path)?.[1].replace('jpeg', 'jpg') ??
    { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', 'svg+xml': 'svg' }[img.mime.slice(6)] ??
    'img'
  const photo = frameos.fetchImage(img.imageUrl, {
    headers: { 'User-Agent': UA },
    saveAsset:
      save === 'auto' || save === 'always'
        ? { name: img.title.replace(/File:/g, ''), extension, mode: save }
        : undefined,
  })
  if (!photo.image) throw new Error(`Error fetching image from Wikimedia Commons: ${photo.error}`)
  if (stateKey) frameos.setState(stateKey, { source: 'wikimedia-commons', mode: norm, ...img })
  return photo.image
}
